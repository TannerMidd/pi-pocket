import { toHex } from "./color.ts";
import { isObject, weightOf } from "./scan-import-convert.ts";
import { shadowValue } from "./scan-scales.ts";
import { type Obj, slug } from "./scan-colors.ts";
import { RESERVED } from "./tokens-base.ts";

export interface Collection {
    id: string;
    key: string;
    /** In the file's order: the first is the default. */
    modes: { id: string; name: string }[];
}

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
    collection: string;
    values: Map<string, FigValue>;
}

type Measure = "length" | "number" | "duration";

const asObj = (value: unknown): Obj | undefined => (isObject(value) ? value : undefined);
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asText = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

function guidOf(value: unknown): string {
    const guid = asObj(value);
    const session = asNumber(guid?.sessionID);
    const local = asNumber(guid?.localID);

    return session === undefined || local === undefined ? "" : `${session}:${local}`;
}

function colorOf(value: unknown): string | undefined {
    const color = asObj(value);
    const [r, g, b] = [asNumber(color?.r), asNumber(color?.g), asNumber(color?.b)];

    return r === undefined || g === undefined || b === undefined
        ? undefined
        : toHex({ r, g, b, a: asNumber(color?.a) ?? 1 });
}

// A guid, or the published key that a file from a library uses instead.
const refOf = (ref: Obj | undefined): string =>
    ref === undefined ? "" : guidOf(ref.guid) || asText(asObj(ref.assetRef)?.key);

export function collectionsOf(nodes: Obj[]): Map<string, Collection> {
    const found = new Map<string, Collection>();

    for (const node of nodes) {
        const id = guidOf(node.guid);

        if (node.type !== "VARIABLE_SET" || id === "") {
            continue;
        }

        const modes = asList(node.variableSetModes).flatMap((mode) => {
            const modeId = guidOf(asObj(mode)?.id);

            return modeId === "" ? [] : [{ id: modeId, name: asText(asObj(mode)?.name) }];
        });

        found.set(id, { id, key: asText(node.key), modes });
    }

    return found;
}

function valuesOf(node: Obj): Map<string, FigValue> {
    const values = new Map<string, FigValue>();

    for (const item of asList(asObj(node.variableDataValues)?.entries).slice(0, 400)) {
        const entry = asObj(item);
        const mode = guidOf(entry?.modeID);
        const data = asObj(asObj(entry?.variableData)?.value);

        if (mode === "" || data === undefined) {
            continue;
        }

        const color = colorOf(data.colorValue);
        const number = asNumber(data.floatValue);
        const target = refOf(asObj(data.alias));

        if (color !== undefined) {
            values.set(mode, { kind: "color", value: color });
        } else if (number !== undefined) {
            values.set(mode, { kind: "number", value: number });
        } else if (typeof data.textValue === "string") {
            values.set(mode, { kind: "text", value: data.textValue });
        } else if (target !== "") {
            values.set(mode, { kind: "alias", target });
        }
    }

    return values;
}

/** `byKey` maps a published key, which an alias may name, to the variable's id. */
export function variablesOf(nodes: Obj[]): { list: FigVariable[]; byKey: Map<string, string> } {
    const list: FigVariable[] = [];
    const byKey = new Map<string, string>();

    for (const node of nodes) {
        const id = guidOf(node.guid);

        if (node.type !== "VARIABLE" || id === "") {
            continue;
        }

        list.push({
            id,
            name: asText(node.name),
            resolved: asText(node.variableResolvedType).toUpperCase() || "STRING",
            collection: refOf(asObj(node.variableSetID)),
            values: valuesOf(node),
        });

        if (asText(node.key) !== "") {
            byKey.set(asText(node.key), id);
        }
    }

    return { list, byKey };
}

// Words that name what a group holds, and are not part of a name: `Colors/Brand` is `color.brand`.
const GROUP_WORDS: Record<string, RegExp> = {
    color: /^(?:colou?rs?|palette|palettes|theme|themes|swatches)$/,
    type: /^(?:text-?styles?|typography|type-?styles?|types?)$/,
    shadow: /^(?:effects?|shadow-?styles?|shadows?|elevation|elevations?)$/,
    font: /^(?:fonts?|font-?families|families|typefaces?)$/,
};

// The group of a number, by the first word of its name, and what it measures.
const MEASURES: [RegExp, string, Measure][] = [
    [/^(?:font-?sizes?|text|type-?scales?|typescale|fs)$/, "text", "length"],
    [/^(?:font-?weights?|weights?|fw)$/, "weight", "number"],
    [/^(?:line-?heights?|leading|lh)$/, "leading", "number"],
    [/^(?:letter-?spacings?|tracking)$/, "tracking", "length"],
    [/^(?:spac(?:e|es|ing)|gaps?|gutters?|pad(?:ding)?|margins?|inset)$/, "space", "length"],
    [/^(?:radii|radius|corner|corners|rounded)$/, "radius", "length"],
    [/^(?:border-?widths?|borders?|strokes?|stroke-?widths?)$/, "border", "length"],
    [/^(?:sizes?|widths?|heights?|icons?|blurs?)$/, "size", "length"],
    [/^(?:opacity|opacities|alpha)$/, "opacity", "number"],
    [/^(?:durations?|times?|motion|speeds?|transitions?)$/, "duration", "duration"],
    [/^(?:breakpoints?|screens?|bps?)$/, "breakpoint", "length"],
    [/^(?:z|z-?index|layers?)$/, "z", "number"],
];

export interface Named {
    path: string[];
    measure: Measure;
}

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

    if (group !== undefined) {
        return { path: [kind, ...(group.test(first) ? parts.slice(1) : parts)], measure: "length" };
    }

    const found = MEASURES.find(([pattern]) => pattern.test(first));

    return found !== undefined
        ? { path: [found[1], ...parts.slice(1)], measure: found[2] }
        : { path: ["number", ...parts], measure: "number" };
}

export function safePath(named: Named): string[] {
    const path = named.path.map((part) => (RESERVED.has(part) ? `${part}-token` : part));
    const last = path.at(-1) ?? "";

    return last === "" ? [...path.slice(0, -1), "base"] : path;
}

// The next number of each base is kept, so a file of one repeated name costs one step a token.
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

    while (taken.has(`${base}-${index}`)) {
        index += 1;
    }

    next.set(base, index + 1);
    taken.add(`${base}-${index}`);

    return [...path.slice(0, -1), `${path.at(-1)}-${index}`];
}

export function numberValue(value: number, measure: Measure): unknown {
    const round = Math.round(value * 1000) / 1000;

    return measure === "duration" ? `${round}ms` : measure === "length" ? `${round}px` : round;
}

export function typeOf(variable: FigVariable, measure: Measure): string {
    if (variable.resolved === "COLOR") {
        return "color";
    }

    if (variable.resolved === "FLOAT") {
        return measure === "duration" ? "duration" : measure === "length" ? "dimension" : "number";
    }

    return "fontFamily";
}

// The token format holds no text but a font's name.
export const FONT_NAME = /(?:^|[/\s_-])(?:font|fonts|family|families|typeface)s?(?:[/\s_-]|$)/i;

export function familyOf(text: string): string | undefined {
    const clean = text
        .replace(/[^\w .-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 64);

    return clean === "" ? undefined : clean;
}

function measured(value: unknown): { value?: number; units: string } {
    const held = asObj(value);

    return { value: asNumber(held?.value), units: asText(held?.units).toUpperCase() };
}

function typographyOf(node: Obj): Obj | undefined {
    const font = asObj(node.fontName);
    const family = familyOf(asText(font?.family));
    const size = asNumber(node.fontSize);

    if (family === undefined || size === undefined) {
        return undefined;
    }

    const weight = weightOf(asText(font?.style));
    const value: Obj = { fontFamily: family, fontSize: numberValue(size, "length") };
    const leading = measured(node.lineHeight);
    const tracking = measured(node.letterSpacing);
    const ratio = (each: number) => Math.round((each / 100) * 1000) / 1000;

    if (typeof weight === "number") {
        value.fontWeight = weight;
    }

    if (leading.value !== undefined && leading.units === "PERCENT") {
        value.lineHeight = ratio(leading.value);
    } else if (leading.value !== undefined && leading.units === "PIXELS") {
        value.lineHeight = numberValue(leading.value, "length");
    }

    if (tracking.value && tracking.units === "PERCENT") {
        value.letterSpacing = `${ratio(tracking.value)}em`;
    } else if (tracking.value && tracking.units === "PIXELS") {
        value.letterSpacing = numberValue(tracking.value, "length");
    }

    return { $value: value, $type: "typography" };
}

function shadowOf(node: Obj): Obj | undefined {
    const layers: string[] = [];

    for (const item of asList(node.effects).slice(0, 8)) {
        const effect = asObj(item);
        const color = colorOf(effect?.color);
        const x = asNumber(asObj(effect?.offset)?.x);
        const y = asNumber(asObj(effect?.offset)?.y);
        const kind = asText(effect?.type).toUpperCase();

        if (
            color === undefined ||
            x === undefined ||
            y === undefined ||
            effect?.visible === false ||
            (kind !== "DROP_SHADOW" && kind !== "INNER_SHADOW")
        ) {
            continue;
        }

        const blur = asNumber(effect?.radius) ?? 0;
        const spread = asNumber(effect?.spread) ?? 0;

        layers.push(
            `${kind === "INNER_SHADOW" ? "inset " : ""}${x}px ${y}px ${blur}px ${spread}px ${color}`,
        );
    }

    return layers.length === 0
        ? undefined
        : { $value: shadowValue(layers.join(", ")), $type: "shadow" };
}

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

export interface FigStyle {
    kind: "TEXT" | "EFFECT" | "FILL";
    path: Named;
    token: Obj;
}

const STYLES = {
    TEXT: [typographyOf, "type"],
    EFFECT: [shadowOf, "shadow"],
    FILL: [paintOf, "color"],
} as const;

/** `left` counts the styles that make no token. */
export function stylesOf(nodes: Obj[]): { styles: FigStyle[]; left: number } {
    const styles: FigStyle[] = [];
    let left = 0;

    for (const node of nodes) {
        const kind = asText(node.styleType).toUpperCase();
        const style = Object.hasOwn(STYLES, kind) ? STYLES[kind as FigStyle["kind"]] : undefined;

        // Figma writes a style as the layer it edits, with a `styleType`; an older export as a `STYLE`.
        if (node.type !== "STYLE" && style === undefined) {
            continue;
        }

        const token = style?.[0](node);

        if (style === undefined || token === undefined) {
            left += 1;

            continue;
        }

        styles.push({
            kind: kind as FigStyle["kind"],
            path: nameFor(style[1], asText(node.name)),
            token,
        });
    }

    return { styles, left };
}
