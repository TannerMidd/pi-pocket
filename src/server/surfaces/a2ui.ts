/**
 * The A2UI adapter (docs/design/surfaces.md section 8; docs/extensions/surfaces.md). It reads A2UI wire messages of one
 * surface (`createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface`) and gives a plan that the `ui` tool
 * runs as a normal `show`, `patch`, or `close`: everything it builds goes through the same validator. Borrowed from
 * A2UI: flat components with ids, a `root`, bindings (`path`), events with context, catalogs. Not borrowed: state
 * held by the client. Anything it cannot map is refused with a reason, and nothing is changed.
 *
 * A message is `{ createSurface: {...} }` and so on, as one object, or with a `version` beside it. A component is
 * `{ id, component: "Text", ...props }`; `type` is read for `component` too.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { FUNCTIONS } from "../../../web/surfaces-expr.js";
import { type Acted, type Component, type JsonObject, LIMITS } from "./types.ts";
import { cleanString, isObject } from "./validate.ts";

/** A change to the data model, in order. */
export type DataStep =
    | { kind: "replace"; value: JsonObject }
    | { kind: "set"; path: string; value: JsonValue }
    | { kind: "remove"; path: string };

/** What a batch of messages for one surface asks for. */
export type A2uiPlan = {
    /** A2UI's own id for the surface. */
    surface: string;
    /** A `createSurface` came: a new card. */
    create: boolean;
    remove: boolean;
    /** Components by id, upserted; each has its `id`. */
    components: Record<string, Component & { id: string }>;
    data: DataStep[];
    /** The A2UI components as sent, earlier ones included: an update by id needs the ones it does not repeat. */
    raws: Record<string, Record<string, unknown>>;
};

export type A2uiResult = { plan?: A2uiPlan; refused: string[] };

const REFUSED: Record<string, string> = {
    Video: "remote media is blocked by the app's content security policy",
    AudioPlayer: "remote media is blocked by the app's content security policy",
    Modal: "not in this version (a card is one frame)",
    Tabs: "not in this version",
    DateTimeInput: "not in this version",
    Slider: "not in this version",
    Icon: "icons come from a remote catalog: use Text or Status",
};

const KNOWN = new Set([
    "Row",
    "Column",
    "Card",
    "Text",
    "Image",
    "Divider",
    "Button",
    "TextField",
    "CheckBox",
    "ChoicePicker",
    "List",
]);

/** A value as ours: `{ path }` is `@path`, `{ call, args }` is `@call`; everything else is a literal. Refusals go in `why`. */
function value(input: unknown, where: string, why: string[], depth = 0): JsonValue {
    if (depth > 6) {
        why.push(`${where}: nests too deep`);

        return null;
    }

    if (Array.isArray(input)) {
        return input.map((each) => value(each, where, why, depth + 1));
    }

    if (!isObject(input)) {
        return (input ?? null) as JsonValue;
    }

    if (typeof input.path === "string" && Object.keys(input).length === 1) {
        return { "@path": input.path };
    }

    const call = isObject(input.functionCall) ? input.functionCall : input;

    if (typeof call.call === "string") {
        if (call.call === "openUrl") {
            why.push(`${where}: openUrl is only an action of a button`);

            return null;
        }

        if (!FUNCTIONS.includes(call.call)) {
            why.push(
                `${where}: the function ${JSON.stringify(call.call)} is not one of ${FUNCTIONS.join(", ")}`,
            );

            return null;
        }

        const args = isObject(call.args) ? call.args : {};

        return {
            "@call": call.call,
            args: Object.fromEntries(
                Object.entries(args).map(([name, each]) => [
                    name,
                    value(each, where, why, depth + 1),
                ]),
            ),
        };
    }

    if ("@path" in input || "@call" in input) {
        return JSON.parse(JSON.stringify(input)) as JsonValue;
    }

    return JSON.parse(JSON.stringify(input)) as JsonValue;
}

const literalText = (input: unknown): string | undefined =>
    typeof input === "string" ? input : undefined;

/** One A2UI component as ours, and the ids of components it consumed (a button's label, a list's template). */
function convert(
    raw: Record<string, unknown>,
    all: Record<string, Record<string, unknown>>,
    why: string[],
    consumed: Set<string>,
): (Component & { id: string }) | undefined {
    const id = String(raw.id);
    const kind = String(raw.component ?? raw.type);
    const where = `component ${id} (${kind})`;

    if (Object.hasOwn(REFUSED, kind)) {
        why.push(`${where} is refused: ${REFUSED[kind]}`);

        return undefined;
    }

    if (!KNOWN.has(kind)) {
        why.push(`${where} is refused: not in the basic catalog this adapter reads`);

        return undefined;
    }

    const ids = (input: unknown): string[] | undefined => {
        if (Array.isArray(input) && input.every((each) => typeof each === "string")) {
            return input as string[];
        }

        if (input !== undefined) {
            why.push(
                `${where}: children must be a list of ids (templates are refused except in a List)`,
            );
        }

        return undefined;
    };

    const out: Component & { id: string } = { id, type: kind };

    switch (kind) {
        case "Row":

        case "Column": {
            out.children = ids(raw.children) ?? [];

            return out;
        }

        case "Card": {
            out.children = typeof raw.child === "string" ? [raw.child] : (ids(raw.children) ?? []);

            return out;
        }

        case "Text": {
            out.text = value(raw.text, where, why);
            out.style = ["h1", "h2", "h3", "h4", "h5"].includes(
                String(raw.variant ?? raw.usageHint),
            )
                ? "title"
                : String(raw.variant ?? raw.usageHint) === "caption"
                  ? "caption"
                  : "body";

            return out;
        }

        case "Image": {
            const url = literalText(raw.url);

            if (url === undefined) {
                why.push(`${where}: url must be a literal address`);

                return undefined;
            }

            out.url = url;

            if (typeof (raw.alt ?? raw.description) === "string") {
                out.alt = String(raw.alt ?? raw.description);
            }

            return out;
        }

        case "Divider": {
            return out;
        }

        case "Button": {
            const child = typeof raw.child === "string" ? all[raw.child] : undefined;
            const label =
                literalText(raw.label) ??
                (child === undefined ? undefined : literalText(child.text));

            if (label === undefined) {
                why.push(`${where}: its label must be literal text (a child Text, or label)`);

                return undefined;
            }

            if (typeof raw.child === "string") {
                consumed.add(raw.child);
            }

            out.label = label;

            if (raw.variant === "primary" || raw.primary === true) {
                out.style = "primary";
            }

            const action = isObject(raw.action) ? raw.action : {};
            const functionCall = isObject(action.functionCall) ? action.functionCall : undefined;

            if (functionCall !== undefined) {
                const args = isObject(functionCall.args) ? functionCall.args : {};

                if (functionCall.call !== "openUrl" || literalText(args.url) === undefined) {
                    why.push(
                        `${where}: only openUrl (with a literal url) is allowed as a function call`,
                    );

                    return undefined;
                }

                out.action = { open: { url: String(args.url) } };

                return out;
            }

            const event = isObject(action.event) ? action.event : undefined;

            if (event === undefined || typeof event.name !== "string") {
                why.push(`${where}: an action is { event: { name, context? } } or openUrl`);

                return undefined;
            }

            const context = isObject(event.context) ? event.context : {};

            out.action = {
                event: {
                    name: event.name,
                    ...(Object.keys(context).length === 0
                        ? {}
                        : {
                              context: Object.fromEntries(
                                  Object.entries(context).map(([name, each]) => [
                                      name,
                                      value(each, where, why),
                                  ]),
                              ),
                          }),
                },
            };

            return out;
        }

        case "TextField":
        case "CheckBox":

        case "ChoicePicker": {
            const bound =
                isObject(raw.value) && typeof raw.value.path === "string"
                    ? raw.value.path
                    : undefined;
            const label = literalText(raw.label);

            if (bound === undefined || label === undefined) {
                why.push(`${where}: needs a literal label and a value bound to a path`);

                return undefined;
            }

            out.label = label;
            out.bind = bound;

            if (kind === "TextField") {
                if (raw.variant === "longText") {
                    out.multiline = true;
                }

                if (typeof raw.validationRegexp === "string") {
                    out.pattern = raw.validationRegexp;
                }
            }

            if (kind === "ChoicePicker") {
                const options = Array.isArray(raw.options) ? raw.options : [];

                out.options = options.map((option) =>
                    isObject(option)
                        ? {
                              label: String(literalText(option.label) ?? option.value),
                              value: String(option.value),
                          }
                        : String(option),
                );

                if (raw.variant === "multipleSelection") {
                    out.multiple = true;
                }
            }

            return out;
        }

        default: {
            // List: a template of one Text becomes a Table of that field.
            const template = isObject(raw.children) ? raw.children : undefined;
            const part =
                typeof template?.componentId === "string" ? all[template.componentId] : undefined;
            const field =
                part !== undefined && isObject(part.text) && typeof part.text.path === "string"
                    ? part.text.path.replace(/^\//, "")
                    : undefined;

            if (
                template === undefined ||
                typeof template.path !== "string" ||
                part === undefined ||
                String(part.component ?? part.type) !== "Text" ||
                field === undefined
            ) {
                why.push(
                    `${where}: a List is read only with a template of one Text bound to a field of the item`,
                );

                return undefined;
            }

            consumed.add(String(template.componentId));
            out.type = "Table";
            out.rows = template.path;
            out.columns = [{ label: "", value: field }];

            return out;
        }
    }
}

/**
 * The plan for the messages of one surface, or the reasons it was refused. `earlier` gives the A2UI components kept
 * for a surface (by A2UI's id): an update that repeats only some of them is read with the rest.
 */
export function fromA2ui(
    messages: unknown,
    earlier?: (surface: string) => Record<string, Record<string, unknown>> | undefined,
): A2uiResult {
    const why: string[] = [];

    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 50) {
        return { refused: ["messages must be a list of 1 to 50 A2UI messages"] };
    }

    const sent: Record<string, Record<string, unknown>> = {};
    const plan: A2uiPlan = {
        surface: "",
        create: false,
        remove: false,
        components: {},
        data: [],
        raws: {},
    };

    const takeSurface = (message: Record<string, unknown>, body: Record<string, unknown>) => {
        const surface = typeof body.surfaceId === "string" ? body.surfaceId : undefined;

        if (surface === undefined) {
            why.push(
                `${Object.keys(message).find((key) => key !== "version")}: surfaceId is missing`,
            );

            return false;
        }

        if (plan.surface !== "" && plan.surface !== surface) {
            why.push(`one call shows one surface: ${plan.surface} and ${surface}`);

            return false;
        }

        plan.surface = surface;

        return true;
    };

    for (const message of messages) {
        if (!isObject(message)) {
            why.push("each message is an object, such as { createSurface: { surfaceId } }");
            continue;
        }

        const create = isObject(message.createSurface) ? message.createSurface : undefined;
        const update = isObject(message.updateComponents) ? message.updateComponents : undefined;
        const data = isObject(message.updateDataModel) ? message.updateDataModel : undefined;
        const del = isObject(message.deleteSurface) ? message.deleteSurface : undefined;
        const known = [create, update, data, del].filter((each) => each !== undefined).length;

        if (known !== 1) {
            why.push(
                `a message holds one of createSurface, updateComponents, updateDataModel, deleteSurface (got ${
                    Object.keys(message)
                        .filter((key) => key !== "version")
                        .join(", ") || "nothing"
                })`,
            );
            continue;
        }

        const body = (create ?? update ?? data ?? del)!;

        if (!takeSurface(message, body)) {
            continue;
        }

        if (create !== undefined) {
            plan.create = true;

            if (typeof create.catalogId === "string" && !/basic/i.test(create.catalogId)) {
                why.push(
                    `catalog ${JSON.stringify(create.catalogId)} is refused: only the basic catalog is read`,
                );
            }

            if (create.sendDataModel === true) {
                why.push("sendDataModel is refused: the state lives on the server");
            }

            if (Array.isArray(create.components)) {
                for (const each of create.components) {
                    if (isObject(each) && typeof each.id === "string") {
                        sent[each.id] = each;
                    }
                }
            }

            if (isObject(create.dataModel)) {
                plan.data.push({ kind: "replace", value: create.dataModel as JsonObject });
            }
        } else if (update !== undefined) {
            for (const each of Array.isArray(update.components) ? update.components : []) {
                if (isObject(each) && typeof each.id === "string") {
                    sent[each.id] = each;
                } else {
                    why.push("each component needs an id");
                }
            }
        } else if (data !== undefined) {
            const path = typeof data.path === "string" ? data.path : "/";

            if (path === "/" || path === "") {
                if (isObject(data.value)) {
                    plan.data.push({ kind: "replace", value: data.value as JsonObject });
                } else {
                    why.push("updateDataModel without a path needs an object as its value");
                }
            } else if (data.value === undefined) {
                plan.data.push({ kind: "remove", path });
            } else {
                plan.data.push({ kind: "set", path, value: data.value as JsonValue });
            }
        } else {
            plan.remove = true;
        }
    }

    const consumed = new Set<string>();
    const raws = {
        ...(plan.create || plan.surface === "" ? {} : earlier?.(plan.surface)),
        ...sent,
    };

    plan.raws = raws;

    for (const raw of Object.values(raws)) {
        const made = convert(raw, raws, why, consumed);

        if (made !== undefined) {
            plan.components[made.id] = made;
        }
    }

    for (const id of consumed) {
        delete plan.components[id];
    }

    if (plan.surface === "") {
        why.push("no surfaceId in the messages");
    }

    return why.length > 0 ? { refused: why } : { plan, refused: [] };
}

/** A2UI's own message for an action that was delivered: what a renderer of A2UI sends its agent. */
export function toA2uiAction(
    surface: string,
    acted: Acted,
): { action: { name: string; surfaceId: string; context: JsonValue; timestamp: string } } {
    return {
        action: {
            name: acted.name,
            surfaceId: surface,
            context: acted.values,
            timestamp: new Date(acted.at).toISOString(),
        },
    };
}

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** The data model after the steps: `set` makes the objects on its way, `remove` takes a key or an item away. */
export function dataFromSteps(base: JsonObject, steps: readonly DataStep[]): JsonObject {
    let data = JSON.parse(JSON.stringify(base)) as JsonObject;

    for (const step of steps) {
        if (step.kind === "replace") {
            data = JSON.parse(JSON.stringify(step.value)) as JsonObject;
            continue;
        }

        const parts = step.path
            .replace(/^\//, "")
            .split("/")
            .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));

        if (parts.some((part) => part === "" || FORBIDDEN.has(cleanString(part)))) {
            throw new Error(`data path ${JSON.stringify(step.path)} is not allowed`);
        }

        let at: JsonValue = data;

        for (const part of parts.slice(0, -1)) {
            const next: JsonValue | undefined = Array.isArray(at)
                ? at[Number(part)]
                : isObject(at)
                  ? (at as JsonObject)[part]
                  : undefined;

            if (typeof next === "object" && next !== null) {
                at = next;
            } else if (step.kind === "set" && isObject(at)) {
                const made: JsonObject = {};

                (at as JsonObject)[part] = made;
                at = made;
            } else {
                throw new Error(`nothing at ${step.path}`);
            }
        }

        const last = parts.at(-1)!;

        if (Array.isArray(at)) {
            if (!/^(0|[1-9]\d*)$/.test(last)) {
                throw new Error(`invalid array index ${JSON.stringify(last)} at ${step.path}`);
            }

            const index = Number(last);

            if (step.kind === "remove") {
                if (index >= at.length) {
                    throw new Error(`nothing at ${step.path}`);
                }

                at.splice(index, 1);
            } else {
                if (index > at.length || index >= LIMITS.items) {
                    throw new Error(`array index out of range at ${step.path}`);
                }

                at[index] = step.value;
            }
        } else if (step.kind === "remove") {
            delete (at as JsonObject)[last];
        } else {
            (at as JsonObject)[last] = step.value;
        }
    }

    return data;
}
