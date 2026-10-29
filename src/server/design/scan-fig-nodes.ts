/**
 * What a Figma `.fig` file's message says about a design system (design system scan): its variable collections and their
 * modes, its variables and their values in each mode, and its text, effect, and paint styles, each with a DTCG name.
 * Everything here is a read of untrusted data: a name is made safe for a token (`Colors/Brand/Primary` is
 * `color.brand.primary`), and a value that the token format cannot hold makes no token at all.
 */
import { toHex } from "./color.ts";
import { weightOf } from "./scan-import-convert.ts";
import { shadowValue } from "./scan-scales.ts";
import { type Obj, slug } from "./scan-util.ts";

/** A variable collection: its modes, in the file's order, so the first is the default. */
export interface Collection {
    id: string;
    /** The published key of the collection: a variable's `variableSetID` may name it instead of its guid. */
    key: string;
    modes: { id: string; name: string }[];
}

/** A variable's value in one of its modes: a literal, or an alias of another variable. */
export type FigValue =
    | { kind: "color"; value: string }
    | { kind: "number"; value: number }
    | { kind: "text"; value: string }
    | { kind: "alias"; target: string };

export interface FigVariable {
    id: string;
    name: string;
    /** COLOR, FLOAT, STRING, or BOOLEAN. */
    resolved: string;
    /** The collection it belongs to; empty when the file does not say. */
    collection: string;
    values: Map<string, FigValue>;
}

// --- Reading the message --------------------------------------------------------------------------------------------

const asObj = (value: unknown): Obj | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Obj)
        : undefined;

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asText = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A GUID as `session:local`, which is how one node of a file names another. */
function guidOf(value: unknown): string {
    const guid = asObj(value);

    if (guid === undefined) {
        return "";
    }

    const session = asNumber(guid.sessionID);
    const local = asNumber(guid.localID);

    return session === undefined || local === undefined ? "" : `${session}:${local}`;
}

/** A Figma color (`{ r, g, b, a }`, each 0 to 1) as `#rrggbb`, or `#rrggbbaa` when it has an alpha. */
function colorOf(value: unknown): string | undefined {
    const color = asObj(value);

    if (color === undefined) {
        return undefined;
    }

    const r = asNumber(color.r);
    const g = asNumber(color.g);
    const b = asNumber(color.b);

    if (r === undefined || g === undefined || b === undefined) {
        return undefined;
    }

    return toHex({ r, g, b, a: asNumber(color.a) ?? 1 });
}

/** The collections of a file, by the id of each, from its `VARIABLE_SET` nodes. */
export function collectionsOf(nodes: Obj[]): Map<string, Collection> {
    const found = new Map<string, Collection>();

    for (const node of nodes) {
        const id = guidOf(node.guid);

        if (node.type !== "VARIABLE_SET" || id === "") {
            continue;
        }

        const modes = asList(node.variableSetModes).flatMap((mode) => {
            const entry = asObj(mode);
            const modeId = entry === undefined ? "" : guidOf(entry.id);

            return modeId === "" ? [] : [{ id: modeId, name: asText(entry?.name) }];
        });

        found.set(id, { id, key: asText(node.key), modes });
    }

    return found;
}

/** A variable's values, by the id of the mode that each belongs to. */
function valuesOf(node: Obj): Map<string, FigValue> {
    const values = new Map<string, FigValue>();

    for (const item of asList(asObj(node.variableDataValues)?.entries).slice(0, 400)) {
        const entry = asObj(item);
        const mode = entry === undefined ? "" : guidOf(entry.modeID);
        const data = asObj(asObj(entry?.variableData)?.value);

        if (entry === undefined || mode === "" || data === undefined) {
            continue;
        }

        const color = colorOf(data.colorValue);
        const number = asNumber(data.floatValue);
        const text = typeof data.textValue === "string" ? data.textValue : undefined;
        const alias = asObj(data.alias);
        const target =
            alias === undefined ? "" : guidOf(alias.guid) || asText(asObj(alias.assetRef)?.key);

        if (color !== undefined) {
            values.set(mode, { kind: "color", value: color });
        } else if (number !== undefined) {
            values.set(mode, { kind: "number", value: number });
        } else if (text !== undefined) {
            values.set(mode, { kind: "text", value: text });
        } else if (target !== "") {
            values.set(mode, { kind: "alias", target });
        }
    }

    return values;
}

/** The variables of a file, and their ids by the published key that an alias may name instead. */
export function variablesOf(nodes: Obj[]): { list: FigVariable[]; byKey: Map<string, string> } {
    const list: FigVariable[] = [];
    const byKey = new Map<string, string>();

    for (const node of nodes) {
        const id = guidOf(node.guid);

        if (node.type !== "VARIABLE" || id === "") {
            continue;
        }

        const key = asText(node.key);
        const set = asObj(node.variableSetID);
        const collection =
            set === undefined ? "" : guidOf(set.guid) || asText(asObj(set.assetRef)?.key);

        list.push({
            id,
            name: asText(node.name),
            resolved: asText(node.variableResolvedType).toUpperCase() || "STRING",
            collection,
            values: valuesOf(node),
        });

        if (key !== "") {
            byKey.set(key, id);
        }
    }

    return { list, byKey };
}
// --- Names ----------------------------------------------------------------------------------------------------------

/** Names that the tokens engine refuses, and the keys of `Object` beside them: never a token's name, never a mode's. */
export const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

/** Words that name what a group holds, and so are not part of a name: `Colors/Brand` is `color.brand`. */
const GROUP_WORDS: Record<string, RegExp> = {
    color: /^(?:colou?rs?|palette|palettes|theme|themes|swatches)$/,
    type: /^(?:text-?styles?|typography|type-?styles?|types?)$/,
    shadow: /^(?:effects?|shadow-?styles?|shadows?|elevation|elevations?)$/,
    font: /^(?:fonts?|font-?families|families|typefaces?)$/,
};

/** A group of measurements, by the first word of its name, and what a number in it is. */
const MEASURES: [RegExp, string, "length" | "number" | "duration"][] = [
    [/^(?:font-?sizes?|text|type-?scales?|typescale|fs)$/, "text", "length"],
    [/^(?:font-?weights?|weights?|fw)$/, "weight", "number"],
    [/^(?:line-?heights?|leading|lh)$/, "leading", "number"],
    [/^(?:letter-?spacings?|tracking)$/, "tracking", "length"],
    [/^(?:spac(?:e|es|ing)|gaps?|gutters?|pad(?:ding)?|margins?|inset)$/, "space", "length"],
    [/^(?:radii|radius|corner|corners|rounded)$/, "radius", "length"],
    [/^(?:border-?widths?|borders?|strokes?|stroke-?widths?)$/, "border", "length"],
    [/^(?:sizes?|widths?|heights?|icons?)$/, "size", "length"],
    [/^blurs?$/, "size", "length"],
    [/^(?:opacity|opacities|alpha)$/, "opacity", "number"],
    [/^(?:durations?|times?|motion|speeds?|transitions?)$/, "duration", "duration"],
    [/^(?:breakpoints?|screens?|bps?)$/, "breakpoint", "length"],
    [/^(?:z|z-?index|layers?)$/, "z", "number"],
];

/** What a variable or a style becomes: its group, its name, and what its number measures. */
export interface Named {
    path: string[];
    measure: "length" | "number" | "duration";
}

/** The group and the name of a token, from the kind it holds and its Figma name. */
export function nameFor(
    kind: "color" | "font" | "type" | "shadow" | "number",
    name: string,
): Named {
    const parts = name
        .split(/[/\\>]+/)
        .map((part) => slug(part))
        .filter((part) => part !== "" && part !== "_" && part !== "__")
        .slice(0, 4);
    const first = parts[0] ?? "";
    const group = GROUP_WORDS[kind];
    const rest = group === undefined || !group.test(first) ? parts : parts.slice(1);

    if (group !== undefined) {
        return { path: [kind, ...rest], measure: "length" };
    }

    for (const [pattern, group, measure] of MEASURES) {
        if (pattern.test(first)) {
            return { path: [group, ...parts.slice(1)], measure };
        }
    }

    return kind === "number"
        ? { path: ["number", ...parts], measure: "number" }
        : { path: ["size", ...parts], measure: "length" };
}

/** A path in the tree: no name the engine refuses, and every part a safe slug. */
export function safePath(named: Named): string[] {
    const path = named.path.map((part) => (RESERVED.has(part) ? `${part}-token` : part));
    const last = path.at(-1) ?? "";

    return last === "" || RESERVED.has(last) ? [...path.slice(0, -1), "base"] : path;
}

/**
 * Makes a path unique among the tokens so far, by a number on its last part: `a`, `a-2`, `a-3`. The count of each base is
 * kept, so a file of one repeated name costs one step for each token, and the names never grow.
 */
export function uniquePath(
    path: string[],
    taken: Set<string>,
    next: Map<string, number>,
): string[] {
    const base = path.join(".");

    if (!taken.has(base)) {
        taken.add(base);

        return path;
    }

    let index = next.get(base) ?? 2;
    let name = `${base}-${index}`;

    while (taken.has(name)) {
        index += 1;
        name = `${base}-${index}`;
    }

    next.set(base, index + 1);
    taken.add(name);

    return [...path.slice(0, -1), `${path.at(-1)}-${index}`];
}

/** A number as a token value: a length in px, a plain number, or a duration in ms. */
export function numberValue(value: number, measure: "length" | "number" | "duration"): unknown {
    const round = Math.round(value * 1000) / 1000;

    if (measure === "duration") {
        return `${round}ms`;
    }

    return measure === "length" ? `${round}px` : round;
}

/** The DTCG type of a variable's token, from its Figma type and what its number measures. */
export function typeOf(variable: FigVariable, measure: "length" | "number" | "duration"): string {
    if (variable.resolved === "COLOR") {
        return "color";
    }

    if (variable.resolved === "FLOAT") {
        return measure === "duration" ? "duration" : measure === "length" ? "dimension" : "number";
    }

    return "fontFamily";
}

/** Whether a text variable names a font: the only text that the token format can hold. */
export const FONT_NAME = /(?:^|[/\s_-])(?:font|fonts|family|families|typeface)s?(?:[/\s_-]|$)/i;

/** A font family as a token value: the letters, digits, spaces, and hyphens of its name, and no more. */
export function familyOf(text: string): string | undefined {
    const clean = text
        .replace(/[^\w .-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 64);

    return clean === "" ? undefined : clean;
}
// --- Styles ---------------------------------------------------------------------------------------------------------

/** A text style as a `typography` token: its family, size, weight, line height, and letter spacing. */
function typographyOf(node: Obj): Obj | undefined {
    const font = asObj(node.fontName);
    const family = font === undefined ? undefined : familyOf(asText(font.family));
    const size = asNumber(node.fontSize);

    if (family === undefined || size === undefined) {
        return undefined;
    }

    const weight = weightOf(asText(font?.style));
    const value: Obj = { fontFamily: family, fontSize: numberValue(size, "length") };

    if (typeof weight === "number") {
        value.fontWeight = weight;
    }

    const leading = asObj(node.lineHeight);
    const leadingValue = leading === undefined ? undefined : asNumber(leading.value);
    const leadingUnits = leading === undefined ? "" : asText(leading.units).toUpperCase();

    if (leadingValue !== undefined && leadingUnits === "PERCENT") {
        value.lineHeight = Math.round((leadingValue / 100) * 1000) / 1000;
    } else if (leadingValue !== undefined && leadingUnits === "PIXELS") {
        value.lineHeight = numberValue(leadingValue, "length");
    }

    const tracking = asObj(node.letterSpacing);
    const trackingValue = tracking === undefined ? undefined : asNumber(tracking.value);
    const trackingUnits = tracking === undefined ? "" : asText(tracking.units).toUpperCase();

    if (trackingValue !== undefined && trackingValue !== 0 && trackingUnits === "PERCENT") {
        value.letterSpacing = `${Math.round((trackingValue / 100) * 1000) / 1000}em`;
    } else if (trackingValue !== undefined && trackingValue !== 0 && trackingUnits === "PIXELS") {
        value.letterSpacing = numberValue(trackingValue, "length");
    }

    return { $value: value, $type: "typography" };
}

/** An effect style as a `shadow` token: each visible drop or inner shadow, as CSS, read by the scan's own parser. */
function shadowOf(node: Obj): Obj | undefined {
    const layers: string[] = [];

    for (const item of asList(node.effects).slice(0, 8)) {
        const effect = asObj(item);
        const color = effect === undefined ? undefined : colorOf(effect.color);
        const offset = asObj(effect?.offset);
        const x = asNumber(offset?.x);
        const y = asNumber(offset?.y);
        const kind = asText(effect?.type).toUpperCase();

        if (
            effect === undefined ||
            color === undefined ||
            x === undefined ||
            y === undefined ||
            effect.visible === false ||
            (kind !== "DROP_SHADOW" && kind !== "INNER_SHADOW")
        ) {
            continue;
        }

        const blur = asNumber(effect.radius) ?? 0;
        const spread = asNumber(effect.spread) ?? 0;
        const inset = kind === "INNER_SHADOW" ? "inset " : "";

        layers.push(`${inset}${x}px ${y}px ${blur}px ${spread}px ${color}`);
    }

    return layers.length === 0
        ? undefined
        : { $value: shadowValue(layers.join(", ")), $type: "shadow" };
}

/** A paint style as a `color` token: its last solid, visible paint. */
function paintOf(node: Obj): Obj | undefined {
    let color: string | undefined;

    for (const item of asList(node.fillPaints).slice(0, 8)) {
        const paint = asObj(item);
        const solid =
            asText(paint?.type).toUpperCase() === "SOLID" ? colorOf(paint?.color) : undefined;

        if (solid !== undefined && paint?.visible !== false) {
            color = solid;
        }
    }

    return color === undefined ? undefined : { $value: color, $type: "color" };
}

/** A style of the file that makes a token, and the path its name gives. */
export interface FigStyle {
    /** TEXT, EFFECT, or FILL. */
    kind: string;
    path: Named;
    token: Obj;
}

/** The style kinds that a node's `styleType` gives, and that the token format holds. */
const STYLE_KINDS = new Set(["TEXT", "EFFECT", "FILL"]);

/** The styles of a file that the token format holds, and how many of each kind it cannot hold. */
export function stylesOf(nodes: Obj[]): { styles: FigStyle[]; left: Map<string, number> } {
    const styles: FigStyle[] = [];
    const left = new Map<string, number>();

    for (const node of nodes) {
        const kind = asText(node.styleType).toUpperCase();

        // A style is the node that holds one: Figma writes it as the layer kind it edits (`TEXT`, `RECTANGLE`) with a
        // `styleType`, and an older export names `STYLE` in `type`.
        if (node.type !== "STYLE" && !STYLE_KINDS.has(kind)) {
            continue;
        }

        const token =
            kind === "TEXT"
                ? typographyOf(node)
                : kind === "EFFECT"
                  ? shadowOf(node)
                  : kind === "FILL"
                    ? paintOf(node)
                    : undefined;

        if (token === undefined) {
            const key = kind.toLowerCase() || "other";

            left.set(key, (left.get(key) ?? 0) + 1);

            continue;
        }

        styles.push({
            kind,
            path: nameFor(
                kind === "TEXT" ? "type" : kind === "EFFECT" ? "shadow" : "color",
                asText(node.name),
            ),
            token,
        });
    }

    return { styles, left };
}
