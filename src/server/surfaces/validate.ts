/**
 * Checks what Pi sends for a surface, and what is stored: the layout (a flat map of components with ids, as A2UI keeps
 * it), the data, and the expressions. Nothing here runs code: every value is data, an unknown type or prop is refused,
 * and every limit of the design (`docs/design/surfaces.md`, section 2) is held. Pure functions; the tool, the patch
 * and the A2UI adapter all end here.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { checkExpr, isExpr, pointer } from "../../../web/surfaces-expr.js";
import { extensionComponent, propsOf } from "./components.ts";
import { type Component, type JsonObject, LIMITS, type Surface, WHO, type Who } from "./types.ts";

/** A problem in what Pi sent: its message goes back to Pi as it is, so it says where and what to change. */
export class SurfaceError extends Error {}

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const EVENT_NAME = /^[A-Za-z0-9_.-]{1,40}$/;
const KEY = /^[A-Za-z0-9_.-]{1,40}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Control characters (not line breaks or tabs), zero-width and bidi characters, the byte order mark. */
const UNSEEN =
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const RASTER = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const GAPS = ["s", "m", "l"];
const TEXT_STYLES = ["body", "title", "caption", "mono"];
const BUTTON_STYLES = ["default", "primary", "danger"];
const STATES = ["idle", "running", "ok", "warn", "error"];
const FORMATS = ["text", "bytes"];

/** The 12 component types and the props each takes. A prop that is not listed is refused. */
const PROPS: Record<string, readonly string[]> = {
    Column: ["children", "gap"],
    Row: ["children", "gap", "wrap"],
    Card: ["children", "title"],
    Text: ["text", "style"],
    Divider: [],
    Image: ["url", "alt"],
    Button: ["label", "style", "action", "disabled", "who"],
    TextField: ["label", "bind", "max", "pattern", "placeholder", "multiline", "disabled", "who"],
    CheckBox: ["label", "bind", "disabled", "who"],
    ChoicePicker: ["label", "bind", "options", "multiple", "disabled", "who"],
    Table: ["rows", "columns", "select", "who"],
    Status: ["label", "state", "detail", "progress"],
};

/** The types that hold children. */
const PARENTS = new Set(["Column", "Row", "Card"]);

/** The component types, for the tool's description. */
export const TYPES = Object.keys(PROPS);

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string without control, zero-width, and bidi characters. */
export function cleanString(text: string): string {
    return text.replace(UNSEEN, "");
}

/** Every string (and key) of a value cleaned; keys that would reach a prototype are refused. */
export function clean(value: unknown, where: string, depth = 0): JsonValue {
    if (depth > 12) {
        throw new SurfaceError(`${where} nests too deep`);
    }

    if (typeof value === "string") {
        return cleanString(value);
    }

    if (value === null || typeof value === "boolean") {
        return value;
    }

    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new SurfaceError(`${where} holds a number that is not finite`);
        }

        return value;
    }

    if (Array.isArray(value)) {
        if (value.length > LIMITS.items) {
            throw new SurfaceError(`${where} holds more than ${LIMITS.items} items`);
        }

        return value.map((each, at) => clean(each, `${where}[${at}]`, depth + 1));
    }

    if (isObject(value)) {
        const out: JsonObject = {};

        for (const [key, each] of Object.entries(value)) {
            if (FORBIDDEN_KEYS.has(cleanString(key))) {
                throw new SurfaceError(
                    `${where} has the key ${JSON.stringify(key)}, which is not allowed`,
                );
            }

            if (each !== undefined) {
                out[cleanString(key)] = clean(each, `${where}.${key}`, depth + 1);
            }
        }

        return out;
    }

    throw new SurfaceError(`${where} is not JSON`);
}

function fail(where: string, problem: string): never {
    throw new SurfaceError(`${where}: ${problem}`);
}

function str(value: unknown, where: string, max: number, min = 0): string {
    if (typeof value !== "string") {
        return fail(where, "must be a string");
    }

    if (value.length < min || value.length > max) {
        return fail(
            where,
            min > 0 ? `must be ${min} to ${max} characters` : `must be at most ${max} characters`,
        );
    }

    return value;
}

function oneOf(value: unknown, where: string, allowed: readonly string[]): string {
    if (typeof value !== "string" || !allowed.includes(value)) {
        return fail(where, `must be one of ${allowed.join(", ")}`);
    }

    return value;
}

function bool(value: unknown, where: string): boolean {
    if (typeof value !== "boolean") {
        return fail(where, "must be true or false");
    }

    return value;
}

/** A value that may be an expression: an expression is checked, a literal is checked by `literal`. */
function dyn(value: unknown, where: string, literal: (value: unknown) => void): void {
    if (isExpr(value)) {
        const problem = checkExpr(value);

        if (problem !== undefined) {
            fail(where, problem);
        }

        return;
    }

    literal(value);
}

/** A path into the data (RFC 6901), never into the computed values. */
function dataPath(value: unknown, where: string): string {
    const path = str(value, where, 200, 1);

    if (!path.startsWith("/") || path.startsWith("/$") || pointer(path) === undefined) {
        return fail(
            where,
            'must be a path into the data, such as "/rows" ("/$" is computed: read-only)',
        );
    }

    return path;
}

/** A field name inside a table row: a plain key, never a path. */
function fieldName(value: unknown, where: string): string {
    const name = str(value, where, 80, 1);

    if (!/^[A-Za-z0-9_-]{1,80}$/.test(name) || FORBIDDEN_KEYS.has(name)) {
        return fail(
            where,
            "must be a field name of a row, such as size (letters, digits, _ and -)",
        );
    }

    return name;
}

/** A link: `https:` only, no user info, at most 2,000 characters. */
export function checkUrl(value: unknown, where: string): string {
    const text = str(value, where, LIMITS.url, 1);
    let url: URL;

    try {
        url = new URL(text);
    } catch {
        return fail(where, "must be an https URL");
    }

    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
        return fail(where, "must be an https URL with no user name or password");
    }

    return text;
}

function checkWho(value: unknown, where: string): void {
    oneOf(value, where, WHO);
}

function checkOptions(value: unknown, where: string): void {
    if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
        return fail(where, "must be a list of 1 to 50 options");
    }

    for (const [at, option] of value.entries()) {
        if (typeof option === "string") {
            str(option, `${where}[${at}]`, 200, 1);
        } else if (isObject(option)) {
            str(option.label, `${where}[${at}].label`, 200, 1);
            str(option.value, `${where}[${at}].value`, 200);

            for (const key of Object.keys(option)) {
                if (key !== "label" && key !== "value") {
                    fail(`${where}[${at}]`, `has the prop ${key}, which is not allowed`);
                }
            }
        } else {
            fail(`${where}[${at}]`, "must be a string or { label, value }");
        }
    }
}

/** The values an option list allows. */
export function optionValues(options: unknown): string[] {
    return (Array.isArray(options) ? options : []).map((option) =>
        typeof option === "string" ? option : String((option as { value: string }).value),
    );
}

function checkAction(value: unknown, where: string, style: unknown): void {
    if (!isObject(value)) {
        return fail(where, "must be { event: {...} } or { open: { url } }");
    }

    const keys = Object.keys(value);

    if (keys.length !== 1 || (keys[0] !== "event" && keys[0] !== "open")) {
        return fail(where, "must hold exactly one of event or open");
    }

    if ("open" in value) {
        const open = value.open;

        if (!isObject(open) || Object.keys(open).some((key) => key !== "url")) {
            return fail(`${where}.open`, "must be { url }");
        }

        checkUrl(open.url, `${where}.open.url`);

        return;
    }

    const event = value.event;

    if (!isObject(event)) {
        return fail(`${where}.event`, "must be { name, context?, resolves?, confirm? }");
    }

    for (const key of Object.keys(event)) {
        if (!["name", "context", "resolves", "confirm"].includes(key)) {
            fail(`${where}.event`, `has the prop ${key}, which is not allowed`);
        }
    }

    if (typeof event.name !== "string" || !EVENT_NAME.test(event.name)) {
        fail(`${where}.event.name`, "must be 1 to 40 letters, digits, and . _ -");
    }

    if (event.resolves !== undefined) {
        bool(event.resolves, `${where}.event.resolves`);
    }

    if (event.confirm !== undefined) {
        str(event.confirm, `${where}.event.confirm`, 200, 1);
    }

    if (style === "danger" && event.confirm === undefined) {
        fail(
            where,
            "a danger button must carry confirm, the question the person answers before it acts",
        );
    }

    if (event.context !== undefined) {
        if (!isObject(event.context) || Object.keys(event.context).length > 20) {
            fail(`${where}.event.context`, "must be an object of at most 20 expressions");
        }

        for (const [key, expr] of Object.entries(event.context)) {
            if (!KEY.test(key)) {
                fail(
                    `${where}.event.context`,
                    `the name ${JSON.stringify(key)} must be 1 to 40 letters, digits, and . _ -`,
                );
            }

            const problem = checkExpr(expr);

            if (problem !== undefined) {
                fail(`${where}.event.context.${key}`, problem);
            }
        }
    }
}

function checkColumns(value: unknown, where: string): void {
    if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
        return fail(where, "must be a list of 1 to 8 columns");
    }

    for (const [at, column] of value.entries()) {
        const here = `${where}[${at}]`;

        if (!isObject(column)) {
            fail(here, "must be { label, value } or { label, bind, options? }");
        }

        for (const key of Object.keys(column)) {
            if (!["label", "value", "bind", "options", "format"].includes(key)) {
                fail(here, `has the prop ${key}, which is not allowed`);
            }
        }

        str(column.label, `${here}.label`, LIMITS.label);

        if ((column.value === undefined) === (column.bind === undefined)) {
            fail(here, "needs exactly one of value (a field to show) or bind (a field to edit)");
        }

        if (column.value !== undefined) {
            fieldName(column.value, `${here}.value`);
        }

        if (column.bind !== undefined) {
            fieldName(column.bind, `${here}.bind`);
        }

        if (column.options !== undefined) {
            checkOptions(column.options, `${here}.options`);

            if (column.bind === undefined) {
                fail(here, "options belong to a bind column");
            }
        }

        if (column.format !== undefined) {
            oneOf(column.format, `${here}.format`, FORMATS);
        }
    }
}

/**
 * A component an extension added (`web.surfaceComponent`): its props against the module's schema, its binding against
 * the schema it gave. One that a stored surface already used (`known`) stays valid while its module is off: the code
 * never drops a type that stored surfaces use, and the card shows its text.
 */
function checkExtension(where: string, component: Component, known: ReadonlySet<string>): void {
    const registered = extensionComponent(component.type);

    if (registered === undefined) {
        if (known.has(component.type) && component.type.startsWith("x.")) {
            return;
        }

        return fail(
            where,
            `has an unknown type. The types are ${TYPES.join(", ")}${component.type.startsWith("x.") ? "; the module for this one is not on" : ""}`,
        );
    }

    if (component.bind !== undefined) {
        if (registered.bind === undefined) {
            fail(where, "binds nothing: it has no bind");
        }

        dataPath(component.bind, `${where}.bind`);
    }

    if (component.who !== undefined) {
        checkWho(component.who, `${where}.who`);
    }

    const result = registered.props.validate(propsOf(component));

    if (!result.ok) {
        const first = result.errors[0];

        fail(where, `props do not fit: ${first?.message ?? "invalid"}`);
    }
}

/** Checks one component's props (not its children's ids): types, limits, and that no prop is unknown. */
function checkComponent(id: string, component: Component, known: ReadonlySet<string>): void {
    const where = `component ${id} (${component.type})`;
    const allowed = PROPS[component.type];

    if (allowed === undefined) {
        return checkExtension(where, component, known);
    }

    for (const key of Object.keys(component)) {
        if (key !== "type" && !allowed.includes(key)) {
            fail(
                where,
                `has the prop ${key}, which ${component.type} does not take (it takes ${allowed.join(", ") || "none"})`,
            );
        }
    }

    const prop = (name: string) => component[name];
    const at = (name: string) => `${where}.${name}`;

    const need = (name: string) => {
        if (prop(name) === undefined) {
            fail(where, `needs ${name}`);
        }
    };

    if (PARENTS.has(component.type)) {
        const children = prop("children");

        if (!Array.isArray(children) || children.some((child) => typeof child !== "string")) {
            fail(at("children"), "must be a list of components");
        }

        if (prop("gap") !== undefined) {
            oneOf(prop("gap"), at("gap"), GAPS);
        }

        if (prop("wrap") !== undefined) {
            bool(prop("wrap"), at("wrap"));
        }

        if (prop("title") !== undefined) {
            str(prop("title"), at("title"), LIMITS.fieldLabel);
        }
    }

    if (prop("who") !== undefined) {
        checkWho(prop("who"), at("who"));
    }

    if (prop("disabled") !== undefined) {
        dyn(prop("disabled"), at("disabled"), (literal) => bool(literal, at("disabled")));
    }

    switch (component.type) {
        case "Text": {
            need("text");
            dyn(prop("text"), at("text"), (literal) => str(literal, at("text"), LIMITS.text));

            if (prop("style") !== undefined) {
                oneOf(prop("style"), at("style"), TEXT_STYLES);
            }

            break;
        }

        case "Image": {
            need("url");
            // The limit follows the kind: a link is short, a small data image is up to 64 KB.
            const given = prop("url");
            const url = str(
                given,
                at("url"),
                typeof given === "string" && given.startsWith("data:") ? LIMITS.image : LIMITS.url,
                1,
            );

            if (url.startsWith("data:")) {
                if (!RASTER.test(url) || url.length > LIMITS.image) {
                    fail(
                        at("url"),
                        "a data: image must be png, jpeg, gif, or webp as base64, up to 64 KB",
                    );
                }
            } else {
                checkUrl(url, at("url"));
            }

            if (prop("alt") !== undefined) {
                str(prop("alt"), at("alt"), 200);
            }

            break;
        }

        case "Button": {
            need("label");
            str(prop("label"), at("label"), LIMITS.label, 1);
            need("action");
            checkAction(prop("action"), at("action"), prop("style"));

            if (prop("style") !== undefined) {
                oneOf(prop("style"), at("style"), BUTTON_STYLES);
            }

            break;
        }

        case "TextField": {
            need("label");
            str(prop("label"), at("label"), LIMITS.fieldLabel, 1);
            need("bind");
            dataPath(prop("bind"), at("bind"));

            if (prop("max") !== undefined) {
                const max = prop("max");

                if (
                    typeof max !== "number" ||
                    !Number.isInteger(max) ||
                    max < 1 ||
                    max > LIMITS.string
                ) {
                    fail(at("max"), `must be a whole number from 1 to ${LIMITS.string}`);
                }
            }

            if (prop("pattern") !== undefined) {
                const pattern = str(prop("pattern"), at("pattern"), 100, 1);

                // A nested quantifier, such as (a+)+, lets a short input take minutes to test.
                if (/[+*}]\)?[+*{]/.test(pattern.replace(/\\./g, ""))) {
                    fail(
                        at("pattern"),
                        "has a quantifier inside a quantifier; use a simpler pattern",
                    );
                }

                try {
                    new RegExp(pattern, "u");
                } catch {
                    fail(at("pattern"), "is not a valid regular expression");
                }
            }

            if (prop("placeholder") !== undefined) {
                str(prop("placeholder"), at("placeholder"), LIMITS.fieldLabel);
            }

            if (prop("multiline") !== undefined) {
                bool(prop("multiline"), at("multiline"));
            }

            break;
        }

        case "CheckBox": {
            need("label");
            str(prop("label"), at("label"), LIMITS.fieldLabel, 1);
            need("bind");
            dataPath(prop("bind"), at("bind"));
            break;
        }

        case "ChoicePicker": {
            need("label");
            str(prop("label"), at("label"), LIMITS.fieldLabel, 1);
            need("bind");
            dataPath(prop("bind"), at("bind"));
            need("options");
            checkOptions(prop("options"), at("options"));

            if (prop("multiple") !== undefined) {
                bool(prop("multiple"), at("multiple"));
            }

            break;
        }

        case "Table": {
            need("rows");
            dataPath(prop("rows"), at("rows"));
            need("columns");
            checkColumns(prop("columns"), at("columns"));

            if (prop("select") !== undefined) {
                fieldName(prop("select"), at("select"));
            }

            break;
        }

        case "Status": {
            need("label");
            str(prop("label"), at("label"), LIMITS.fieldLabel, 1);
            dyn(prop("state"), at("state"), (literal) => oneOf(literal, at("state"), STATES));

            if (prop("state") === undefined) {
                fail(where, "needs state");
            }

            if (prop("detail") !== undefined) {
                dyn(prop("detail"), at("detail"), (literal) =>
                    str(literal, at("detail"), LIMITS.string),
                );
            }

            if (prop("progress") !== undefined) {
                dyn(prop("progress"), at("progress"), (literal) => {
                    if (typeof literal !== "number" || literal < 0 || literal > 1) {
                        fail(at("progress"), "must be a number from 0 to 1");
                    }
                });
            }

            break;
        }

        default: {
            break;
        }
    }
}

/** What a surface is made of, before it has an id or a status. */
export type Parts = {
    root: string;
    components: Record<string, Component>;
    data: JsonObject;
    computed?: Record<string, JsonValue>;
};

/** The child ids a component holds. */
export function childrenOf(component: Component): string[] {
    return PARENTS.has(component.type) && Array.isArray(component.children)
        ? (component.children as string[])
        : [];
}

/**
 * Pi's layout as the store keeps it. Input: one component, or a list; an element may carry an `id`; a child is an id
 * string or a nested component with no id. The result is flat: `c1`, `c2`, … for what had no id. With several top
 * components and no `root`, an unreferenced one is the root, or a Column holds them all.
 */
export function flatten(
    input: unknown,
    options: { root?: unknown; taken?: ReadonlySet<string> } = {},
): { root: string; components: Record<string, Component> } {
    const list = Array.isArray(input) ? input : [input];
    const components: Record<string, Component> = {};
    const taken = options.taken ?? new Set<string>();
    const written = new Set<string>();
    const used = new Set<string>();
    let next = 0;
    const tops: string[] = [];

    const collect = (node: unknown) => {
        if (isObject(node)) {
            if (typeof node.id === "string") {
                written.add(node.id);
            }

            if (Array.isArray(node.children)) {
                node.children.forEach(collect);
            }
        }
    };

    const nameOf = (given: unknown, where: string): string => {
        if (given !== undefined) {
            if (typeof given !== "string" || !ID.test(given)) {
                return fail(where, "an id must be 1 to 40 letters, digits, _ and -");
            }

            if (used.has(given) || taken.has(given)) {
                return fail(where, `the id ${given} is used twice`);
            }

            used.add(given);

            return given;
        }

        do {
            next += 1;
        } while (written.has(`c${next}`) || used.has(`c${next}`) || taken.has(`c${next}`));

        used.add(`c${next}`);

        return `c${next}`;
    };

    const add = (node: unknown, where: string, depth: number): string => {
        if (!isObject(node) || typeof node.type !== "string") {
            return fail(where, "must be a component: { type, ...props }");
        }

        if (depth > LIMITS.depth) {
            return fail(where, `nests deeper than ${LIMITS.depth} levels`);
        }

        if (Object.keys(components).length >= LIMITS.components) {
            return fail(where, `a surface holds at most ${LIMITS.components} components`);
        }

        const id = nameOf(node.id, where);
        const { id: _id, ...rest } = node;
        const component = clean(rest, `component ${id}`) as Component;

        components[id] = component;

        if (PARENTS.has(component.type)) {
            if (component.children === undefined) {
                component.children = [];
            } else if (!Array.isArray(component.children)) {
                fail(`component ${id}.children`, "must be a list");
            }

            component.children = (component.children as unknown[]).map((child, at) =>
                typeof child === "string"
                    ? child
                    : add(child, `component ${id}.children[${at}]`, depth + 1),
            );
        }

        return id;
    };

    list.forEach(collect);
    list.forEach((node, at) => tops.push(add(node, `components[${at}]`, 1)));

    if (options.root !== undefined) {
        if (typeof options.root !== "string" || !Object.hasOwn(components, options.root)) {
            return fail("root", "must be the id of a component");
        }

        return { root: options.root, components };
    }

    if (tops.length === 1) {
        return { root: tops[0]!, components };
    }

    const referenced = new Set(Object.values(components).flatMap(childrenOf));
    const free = tops.filter((id) => !referenced.has(id));

    if (free.length === 1) {
        return { root: free[0]!, components };
    }

    const id = nameOf(undefined, "root");

    components[id] = { type: "Column", children: free };

    return { root: id, components };
}

/** The whole surface, checked as it is stored: the tree, every component, the data, the expressions, the size. */
export function checkSurface(
    parts: Parts,
    known: ReadonlySet<string> = new Set(),
    a2uiRaw?: Record<string, JsonObject>,
): void {
    const { root, components, data, computed } = parts;
    const ids = Object.keys(components);

    if (ids.length === 0 || ids.length > LIMITS.components) {
        fail("components", `a surface holds 1 to ${LIMITS.components} components`);
    }

    if (!Object.hasOwn(components, root)) {
        fail("root", `${root} is not a component`);
    }

    let actions = 0;

    for (const id of ids) {
        if (!ID.test(id) || FORBIDDEN_KEYS.has(id)) {
            fail(`component ${id}`, "an id must be 1 to 40 letters, digits, _ and -");
        }

        const component = components[id]!;

        checkComponent(id, component, known);

        if (component.type === "Button") {
            actions += 1;
        }
    }

    if (actions > LIMITS.actions) {
        fail("components", `a surface holds at most ${LIMITS.actions} buttons`);
    }

    // A tree: every component has at most one parent, none is its own ancestor, every one is reachable from the root.
    const parent = new Map<string, string>();

    for (const id of ids) {
        for (const child of childrenOf(components[id]!)) {
            if (!Object.hasOwn(components, child)) {
                fail(`component ${id}.children`, `${child} is not a component`);
            }

            if (parent.has(child) || child === root) {
                fail(`component ${id}.children`, `${child} is in the layout twice`);
            }

            parent.set(child, id);
        }
    }

    const seen = new Set<string>();

    const walk = (id: string, depth: number) => {
        if (depth > LIMITS.depth) {
            fail("components", `the layout nests deeper than ${LIMITS.depth} levels`);
        }

        if (seen.has(id)) {
            fail("components", `${id} is in a loop`);
        }

        seen.add(id);
        childrenOf(components[id]!).forEach((child) => walk(child, depth + 1));
    };

    walk(root, 1);

    const lost = ids.filter((id) => !seen.has(id));

    if (lost.length > 0) {
        fail(
            "components",
            `${lost.join(", ")} ${lost.length === 1 ? "is" : "are"} not reachable from the root`,
        );
    }

    if (!isObject(data)) {
        fail("data", "must be an object");
    }

    for (const [name, expr] of Object.entries(computed ?? {})) {
        if (!KEY.test(name)) {
            fail(
                "computed",
                `the name ${JSON.stringify(name)} must be 1 to 40 letters, digits, and . _ -`,
            );
        }

        const problem = checkExpr(expr);

        if (problem !== undefined) {
            fail(`computed.${name}`, problem);
        }
    }

    if (
        JSON.stringify({
            components,
            data,
            computed,
            ...(a2uiRaw === undefined ? {} : { a2uiRaw }),
        }).length > LIMITS.bytes
    ) {
        fail("surface", `is larger than ${LIMITS.bytes / 1024} KB`);
    }
}

/** The data Pi sent, checked: an object, clean strings, within the limits. */
export function checkData(value: unknown): JsonObject {
    if (value === undefined) {
        return {};
    }

    if (!isObject(value)) {
        return fail("data", "must be an object");
    }

    const data = clean(value, "data") as JsonObject;

    return data;
}

/** The computed map Pi sent, cleaned. */
export function checkComputed(value: unknown): Record<string, JsonValue> | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!isObject(value)) {
        return fail("computed", "must be an object of expressions");
    }

    return clean(value, "computed") as Record<string, JsonValue>;
}

/** A title, cleaned: one line, up to 80 characters. */
export function checkTitle(value: unknown): string {
    const title = cleanString(str(value, "title", 400, 1))
        .replace(/\s+/g, " ")
        .trim();

    if (title === "" || title.length > LIMITS.title) {
        fail("title", `must be 1 to ${LIMITS.title} characters`);
    }

    return title;
}

export function checkWhoInput(value: unknown): Who | undefined {
    if (value === undefined) {
        return undefined;
    }

    checkWho(value, "who");

    return value as Who;
}

export type { Surface };
