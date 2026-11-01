import { colorObjectCss, parseColor } from "./color.ts";
import type { TokenType } from "./system-types.ts";
import { LIMITS, clip, isObject, show, type Obj } from "./tokens-base.ts";

export const refName = (text: string) => text.trim().replace(/\.\$root$/, "");
export const WHOLE_REF = /^\s*\{([^{}]+)\}\s*$/;
export const wholeRef = (value: unknown): string | undefined =>
    typeof value === "string" ? WHOLE_REF.exec(value)?.[1] : undefined;

export interface Out {
    css: string;
    literal: string;
    value: unknown;
    parts?: Record<string, string>;
    alias?: string;
}

export interface Target extends Out {
    name: string;
    type: TokenType;
    cssVar: string;
}

export interface Ctx {
    ref(name: string, expect?: readonly TokenType[]): Target | undefined;
    error(message: string): undefined;
    warn(message: string): void;
}

const lit = (css: string, value: unknown = css): Out => ({ css, literal: css, value });

export const LENGTH =
    /^([+-]?(?:\d+\.?\d*|\.\d+))(px|rem|em|%|vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|ch|ex|cap|lh|rlh|pt|pc|cm|mm|in|q)?$/i;
const TIME = /^([+-]?(?:\d+\.?\d*|\.\d+))(ms|s)$/i;
const UNITS = new Set([
    "px",
    "rem",
    "em",
    "%",
    "vw",
    "vh",
    "vmin",
    "vmax",
    "ch",
    "ex",
    "pt",
    "pc",
    "cm",
    "mm",
    "in",
]);

const LOADS_OR_HIDES =
    /\/\*|\*\/|url\(|image-set\(|(?<![\w-])(?:image|src)\(|cross-fade\(|expression\(|@import|javascript:/i;

/** Why text is not safe as a CSS value, or undefined: it ends a rule, opens markup, hides a comment, or loads a URL. */
function cssProblem(text: string): string | undefined {
    if (text.length > LIMITS.valueChars) {
        return `is longer than ${LIMITS.valueChars} characters`;
    }

    if (/[;{}<>\\\u0000-\u001f\u007f]/.test(text)) {
        return "has a character that is not allowed in a token value (; { } < > \\ or a control character)";
    }

    if (LOADS_OR_HIDES.test(text)) {
        return "has a comment, url(), image-set(), or @import";
    }

    let depth = 0;

    for (const char of text) {
        depth += char === "(" ? 1 : char === ")" ? -1 : 0;

        if (depth < 0) {
            break;
        }
    }

    if (
        depth !== 0 ||
        (text.match(/"/g)?.length ?? 0) % 2 === 1 ||
        (text.match(/'/g)?.length ?? 0) % 2 === 1
    ) {
        return "has unbalanced parentheses or quotes";
    }

    return undefined;
}

/** The longest resolved text of a token. A chain that doubles at each step stops here, not at memory's end. */
const MAX_EXPANDED = 10_000;

function expand(text: string, ctx: Ctx): { css: string; literal: string } | undefined {
    let failed = false;
    let css = "";
    let literal = "";
    let last = 0;

    for (const match of text.matchAll(/\{([^{}]+)\}/g)) {
        const target = ctx.ref(match[1]!);

        css += text.slice(last, match.index);
        literal += text.slice(last, match.index);
        last = match.index + match[0].length;

        if (target === undefined) {
            failed = true;
        } else {
            css += `var(${target.cssVar})`;
            literal += target.literal;

            if (literal.length > MAX_EXPANDED) {
                return ctx.error(
                    `{${clip(match[1]!)}} expands past ${MAX_EXPANDED.toLocaleString("en-US")} characters.`,
                );
            }
        }
    }

    css += text.slice(last);
    literal += text.slice(last);

    return failed ? undefined : { css, literal };
}

function cssText(text: string, ctx: Ctx, what: string): Out | undefined {
    const problem = cssProblem(text.replace(/\{[^{}]+\}/g, "0"));

    if (problem !== undefined) {
        return ctx.error(`The ${what} "${clip(text)}" ${problem}.`);
    }

    const expanded = expand(text.trim().replace(/\s+/g, " "), ctx);

    return expanded === undefined ? undefined : { ...expanded, value: expanded.literal };
}

function alias(name: string, expect: readonly TokenType[], ctx: Ctx): Out | undefined {
    const target = ctx.ref(refName(name), expect);

    if (target === undefined) {
        return undefined;
    }

    const out: Out = {
        css: `var(${target.cssVar})`,
        literal: target.literal,
        value: target.value,
        alias: target.name,
    };

    if (target.parts !== undefined) {
        out.parts = Object.fromEntries(
            Object.keys(target.parts).map((key) => [key, `var(${target.cssVar}-${key})`]),
        );
    }

    return out;
}

function color(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["color"], ctx);
    }

    if (typeof raw === "string") {
        const text = raw.trim();

        if (text.toLowerCase() === "currentcolor") {
            return lit("currentColor");
        }

        if (parseColor(text) === undefined) {
            return ctx.error(
                `"${clip(text)}" is not a color. Write #rrggbb, rgb(), hsl(), oklch(), a color name, or a reference such as {color.gray.900}.`,
            );
        }

        return lit(
            text.startsWith("#") ? text.toLowerCase() : text.toLowerCase().replace(/\s+/g, " "),
        );
    }

    if (isObject(raw)) {
        const result = colorObjectCss(raw);

        return "error" in result ? ctx.error(`The color ${result.error}.`) : lit(result.css, raw);
    }

    return ctx.error(
        `A color is a string such as "#7aa2f7" or a { colorSpace, components } object, not ${show(raw)}.`,
    );
}

function dimension(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["dimension"], ctx);
    }

    if (typeof raw === "number" && Number.isFinite(raw)) {
        if (raw !== 0) {
            ctx.warn(`The dimension ${raw} has no unit; it is read as ${raw}px. Write "${raw}px".`);
        }

        return lit(raw === 0 ? "0" : `${raw}px`, raw === 0 ? "0" : `${raw}px`);
    }

    if (typeof raw === "string") {
        const text = raw.trim();
        const match = LENGTH.exec(text);

        if (match !== null) {
            if (match[2] === undefined) {
                if (Number(match[1]) !== 0) {
                    ctx.warn(
                        `The dimension "${text}" has no unit; it is read as ${text}px. Write "${text}px".`,
                    );
                }

                return lit(Number(match[1]) === 0 ? "0" : `${text}px`);
            }

            return lit(`${match[1]}${match[2].toLowerCase()}`);
        }

        if (/^(?:calc|clamp|min|max)\(/i.test(text)) {
            return cssText(text, ctx, "dimension");
        }

        return ctx.error(
            `"${clip(text)}" is not a dimension. Write a number with a unit, such as 16px or 1.5rem, or a reference such as {space.4}.`,
        );
    }

    if (isObject(raw)) {
        const { value, unit } = raw;

        if (
            typeof value === "number" &&
            Number.isFinite(value) &&
            typeof unit === "string" &&
            UNITS.has(unit)
        ) {
            return lit(`${value}${unit}`, raw);
        }

        return ctx.error(
            `A dimension object is { "value": 16, "unit": "px" } (units: ${[...UNITS].slice(0, 6).join(", ")}…).`,
        );
    }

    return ctx.error(
        `A dimension is a string such as "16px" or { value, unit }, not ${show(raw)}.`,
    );
}

function duration(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["duration"], ctx);
    }

    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
        ctx.warn(`The duration ${raw} has no unit; it is read as ${raw}ms. Write "${raw}ms".`);

        return lit(`${raw}ms`);
    }

    if (typeof raw === "string") {
        const match = TIME.exec(raw.trim());

        if (match !== null && Number(match[1]) >= 0) {
            return lit(`${match[1]}${match[2]!.toLowerCase()}`);
        }

        return ctx.error(`"${clip(raw)}" is not a duration. Write a time such as 200ms or 0.2s.`);
    }

    if (
        isObject(raw) &&
        typeof raw.value === "number" &&
        raw.value >= 0 &&
        (raw.unit === "ms" || raw.unit === "s")
    ) {
        return lit(`${raw.value}${raw.unit}`, raw);
    }

    return ctx.error(
        `A duration is a string such as "200ms" or { "value": 200, "unit": "ms" }, not ${show(raw)}.`,
    );
}

const EASINGS = new Set([
    "linear",
    "ease",
    "ease-in",
    "ease-out",
    "ease-in-out",
    "step-start",
    "step-end",
]);

function cubicBezier(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["cubicBezier"], ctx);
    }

    if (Array.isArray(raw)) {
        if (
            raw.length === 4 &&
            raw.every((each) => typeof each === "number" && Number.isFinite(each)) &&
            raw[0]! >= 0 &&
            raw[0]! <= 1 &&
            raw[2]! >= 0 &&
            raw[2]! <= 1
        ) {
            return lit(`cubic-bezier(${raw.join(", ")})`, raw);
        }

        return ctx.error(
            "A cubicBezier array is four numbers [x1, y1, x2, y2], with x1 and x2 from 0 to 1, such as [0.4, 0, 0.2, 1].",
        );
    }

    if (typeof raw === "string") {
        const text = raw.trim().toLowerCase();

        if (
            EASINGS.has(text) ||
            /^(?:cubic-bezier|steps|linear)\([\d\s.,%+-]*(?:,?\s*(?:start|end|jump-\w+))?\)$/.test(
                text,
            )
        ) {
            return lit(text.replace(/\s+/g, " "));
        }

        return ctx.error(
            `"${clip(raw)}" is not an easing. Write [0.4, 0, 0.2, 1], "ease-out", or "cubic-bezier(0.4, 0, 0.2, 1)".`,
        );
    }

    return ctx.error(`A cubicBezier is an array of four numbers, not ${show(raw)}.`);
}

const WEIGHTS: Record<string, number> = {
    thin: 100,
    hairline: 100,
    "extra-light": 200,
    "ultra-light": 200,
    light: 300,
    normal: 400,
    regular: 400,
    book: 400,
    medium: 500,
    "semi-bold": 600,
    "demi-bold": 600,
    bold: 700,
    "extra-bold": 800,
    "ultra-bold": 800,
    black: 900,
    heavy: 900,
    "extra-black": 950,
    "ultra-black": 950,
};

function fontWeight(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["fontWeight"], ctx);
    }

    const weight =
        typeof raw === "number"
            ? raw
            : typeof raw === "string"
              ? (WEIGHTS[raw.trim().toLowerCase()] ??
                (/^\d+$/.test(raw.trim()) ? Number(raw) : undefined))
              : undefined;

    if (weight === undefined || !Number.isFinite(weight) || weight < 1 || weight > 1000) {
        return ctx.error(
            `${show(raw)} is not a font weight. Write a number from 1 to 1000 (400, 700) or a name such as "bold".`,
        );
    }

    return lit(String(weight), weight);
}

const GENERIC_FAMILIES = new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "math",
    "emoji",
    "fangsong",
]);

function fontFamily(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["fontFamily"], ctx);
    }

    if (typeof raw === "string") {
        return cssText(raw, ctx, "font family");
    }

    if (
        Array.isArray(raw) &&
        raw.length > 0 &&
        raw.length <= 12 &&
        raw.every((each) => typeof each === "string")
    ) {
        const names: string[] = [];

        for (const each of raw as string[]) {
            const name = each.trim().replace(/^["']|["']$/g, "");

            if (
                name === "" ||
                /["'\\;{}<>]/.test(name) ||
                name.length > 80 ||
                /[\u0000-\u001f]/.test(name)
            ) {
                return ctx.error(
                    `The font name "${clip(each, 30)}" is empty, too long, or has a quote or symbol.`,
                );
            }

            names.push(
                GENERIC_FAMILIES.has(name) || /^[A-Za-z_-][\w-]*$/.test(name) ? name : `"${name}"`,
            );
        }

        return lit(names.join(", "), raw);
    }

    return ctx.error(
        'A fontFamily is a string ("Inter, sans-serif") or an array of names (["Inter", "sans-serif"]).',
    );
}

function number(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["number"], ctx);
    }

    const value =
        typeof raw === "number"
            ? raw
            : typeof raw === "string" && raw.trim() !== ""
              ? Number(raw)
              : NaN;

    if (!Number.isFinite(value)) {
        return ctx.error(`A number token is a number such as 1.5, not ${show(raw)}.`);
    }

    return lit(String(value), value);
}

function member(type: TokenType, raw: unknown, ctx: Ctx, what: string): Out | undefined {
    if (raw === undefined) {
        return ctx.error(`${what} is missing.`);
    }

    return convert(type, raw, ctx);
}

function shadow(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["shadow"], ctx);
    }

    if (typeof raw === "string") {
        return cssText(raw, ctx, "shadow");
    }

    const layers = Array.isArray(raw) ? raw : [raw];

    if (layers.length === 0 || layers.length > 8) {
        return ctx.error("A shadow is one layer or an array of 1 to 8 layers.");
    }

    const css: string[] = [];
    const literal: string[] = [];
    const value: unknown[] = [];
    const members: Record<string, string> = {};

    for (const [index, layer] of layers.entries()) {
        if (!isObject(layer)) {
            return ctx.error(
                'A shadow layer is { "color", "offsetX", "offsetY", "blur", "spread" }, or a CSS string such as "0 1px 2px rgb(0 0 0 / 0.2)".',
            );
        }

        const parts = [
            member("dimension", layer.offsetX, ctx, "offsetX"),
            member("dimension", layer.offsetY, ctx, "offsetY"),
            layer.blur === undefined ? lit("0") : member("dimension", layer.blur, ctx, "blur"),
            layer.spread === undefined
                ? undefined
                : member("dimension", layer.spread, ctx, "spread"),
            member("color", layer.color, ctx, "color"),
        ];

        if (
            parts.some(
                (part, at) => part === undefined && !(at === 3 && layer.spread === undefined),
            )
        ) {
            return undefined;
        }

        const used = parts.filter((part): part is Out => part !== undefined);
        const inset = layer.inset === true ? "inset " : "";
        const key = (name: string) => (layers.length === 1 ? name : `layer-${index + 1}-${name}`);

        members[key("offset-x")] = parts[0]!.css;
        members[key("offset-y")] = parts[1]!.css;
        members[key("blur")] = parts[2]!.css;

        if (parts[3] !== undefined) {
            members[key("spread")] = parts[3].css;
        }

        members[key("color")] = parts[4]!.css;

        if (layer.inset === true) {
            members[key("inset")] = "inset";
        }

        css.push(inset + used.map((part) => part.css).join(" "));
        literal.push(inset + used.map((part) => part.literal).join(" "));
        value.push({
            ...(layer.inset === true ? { inset: true } : {}),
            color: parts[4]!.value,
            offsetX: parts[0]!.value,
            offsetY: parts[1]!.value,
            blur: parts[2]!.value,
            ...(parts[3] === undefined ? {} : { spread: parts[3].value }),
        });
    }

    return {
        css: css.join(", "),
        literal: literal.join(", "),
        value: Array.isArray(raw) ? value : value[0],
        parts: members,
    };
}

const BORDER_STYLES = new Set([
    "solid",
    "dashed",
    "dotted",
    "double",
    "groove",
    "ridge",
    "outset",
    "inset",
    "none",
    "hidden",
]);

function strokeStyle(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["strokeStyle"], ctx);
    }

    if (typeof raw === "string" && BORDER_STYLES.has(raw.trim().toLowerCase())) {
        return lit(raw.trim().toLowerCase());
    }

    if (
        isObject(raw) &&
        Array.isArray(raw.dashArray) &&
        ["round", "butt", "square"].includes(String(raw.lineCap))
    ) {
        // CSS borders cannot take a dash pattern; "dashed" is the nearest.
        return lit("dashed", raw);
    }

    return ctx.error(
        `A strokeStyle is one of ${[...BORDER_STYLES].join(", ")}, or { "dashArray": […], "lineCap": "round" }.`,
    );
}

function border(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["border"], ctx);
    }

    if (!isObject(raw)) {
        return ctx.error('A border is { "color", "width", "style" }.');
    }

    const width = member("dimension", raw.width, ctx, "width");
    const style =
        raw.style === undefined ? lit("solid") : member("strokeStyle", raw.style, ctx, "style");
    const tone = member("color", raw.color, ctx, "color");

    if (width === undefined || style === undefined || tone === undefined) {
        return undefined;
    }

    return {
        css: `${width.css} ${style.css} ${tone.css}`,
        literal: `${width.literal} ${style.literal} ${tone.literal}`,
        value: { color: tone.value, width: width.value, style: style.value },
    };
}

function transition(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["transition"], ctx);
    }

    if (!isObject(raw)) {
        return ctx.error('A transition is { "duration", "timingFunction", "delay" }.');
    }

    const time = member("duration", raw.duration, ctx, "duration");
    const ease =
        raw.timingFunction === undefined
            ? lit("ease")
            : member("cubicBezier", raw.timingFunction, ctx, "timingFunction");
    const delay = raw.delay === undefined ? undefined : member("duration", raw.delay, ctx, "delay");

    if (
        time === undefined ||
        ease === undefined ||
        (raw.delay !== undefined && delay === undefined)
    ) {
        return undefined;
    }

    const used = [time, ease, ...(delay === undefined ? [] : [delay])];

    return {
        css: used.map((part) => part.css).join(" "),
        literal: used.map((part) => part.literal).join(" "),
        value: {
            duration: time.value,
            timingFunction: ease.value,
            ...(delay === undefined ? {} : { delay: delay.value }),
        },
    };
}

function gradient(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["gradient"], ctx);
    }

    if (typeof raw === "string") {
        if (!/^\s*(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(raw)) {
            return ctx.error(
                "A gradient string must start with linear-gradient(, radial-gradient(, or conic-gradient(.",
            );
        }

        return cssText(raw, ctx, "gradient");
    }

    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 12) {
        return ctx.error(
            'A gradient is an array of 2 to 12 stops: [{ "color": …, "position": 0 }, { "color": …, "position": 1 }].',
        );
    }

    const css: string[] = [];
    const literal: string[] = [];
    const value: unknown[] = [];

    for (const stop of raw) {
        if (!isObject(stop)) {
            return ctx.error('A gradient stop is { "color": …, "position": 0 to 1 }.');
        }

        const tone = member("color", stop.color, ctx, "A gradient stop's color");
        const position = stop.position;

        if (tone === undefined) {
            return undefined;
        }

        if (typeof position !== "number" || position < 0 || position > 1) {
            return ctx.error("A gradient stop's position is a number from 0 to 1.");
        }

        css.push(`${tone.css} ${Number((position * 100).toFixed(2))}%`);
        literal.push(`${tone.literal} ${Number((position * 100).toFixed(2))}%`);
        value.push({ color: tone.value, position });
    }

    return {
        css: `linear-gradient(to right, ${css.join(", ")})`,
        literal: `linear-gradient(to right, ${literal.join(", ")})`,
        value,
    };
}

function typography(raw: unknown, ctx: Ctx): Out | undefined {
    const whole = wholeRef(raw);

    if (whole !== undefined) {
        return alias(whole, ["typography"], ctx);
    }

    if (!isObject(raw)) {
        return ctx.error(
            'A typography token is { "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing" }.',
        );
    }

    const family = member("fontFamily", raw.fontFamily, ctx, "fontFamily");
    const size = member("dimension", raw.fontSize, ctx, "fontSize");
    const weight =
        raw.fontWeight === undefined
            ? undefined
            : member("fontWeight", raw.fontWeight, ctx, "fontWeight");
    const spacing =
        raw.letterSpacing === undefined
            ? undefined
            : member("dimension", raw.letterSpacing, ctx, "letterSpacing");
    let leading: Out | undefined;

    if (raw.lineHeight !== undefined) {
        const reference = wholeRef(raw.lineHeight);
        const unitless =
            typeof raw.lineHeight === "number" ||
            (typeof raw.lineHeight === "string" && /^[\d.]+$/.test(raw.lineHeight));

        if (reference !== undefined) {
            const target = ctx.ref(refName(reference), ["number", "dimension"]);

            leading = target === undefined ? undefined : alias(reference, [target.type], ctx);
        } else {
            leading = unitless ? number(raw.lineHeight, ctx) : dimension(raw.lineHeight, ctx);
        }
    }

    if (
        family === undefined ||
        size === undefined ||
        (raw.fontWeight !== undefined && weight === undefined) ||
        (raw.letterSpacing !== undefined && spacing === undefined) ||
        (raw.lineHeight !== undefined && leading === undefined)
    ) {
        return undefined;
    }

    const build = (pick: (out: Out) => string) =>
        `${weight === undefined ? "" : `${pick(weight)} `}${pick(size)}${leading === undefined ? "" : `/${pick(leading)}`} ${pick(family)}`;
    const parts: Record<string, string> = {
        "font-family": family.css,
        "font-size": size.css,
        ...(weight === undefined ? {} : { "font-weight": weight.css }),
        ...(leading === undefined ? {} : { "line-height": leading.css }),
        ...(spacing === undefined ? {} : { "letter-spacing": spacing.css }),
    };

    return {
        css: build((out) => out.css),
        literal: build((out) => out.literal),
        value: {
            fontFamily: family.value,
            fontSize: size.value,
            ...(weight === undefined ? {} : { fontWeight: weight.value }),
            ...(leading === undefined ? {} : { lineHeight: leading.value }),
            ...(spacing === undefined ? {} : { letterSpacing: spacing.value }),
        },
        parts,
    };
}

export function convert(type: TokenType, raw: unknown, ctx: Ctx): Out | undefined {
    switch (type) {
        case "color":
            return color(raw, ctx);
        case "dimension":
            return dimension(raw, ctx);
        case "duration":
            return duration(raw, ctx);
        case "cubicBezier":
            return cubicBezier(raw, ctx);
        case "fontWeight":
            return fontWeight(raw, ctx);
        case "fontFamily":
            return fontFamily(raw, ctx);
        case "number":
            return number(raw, ctx);
        case "shadow":
            return shadow(raw, ctx);
        case "strokeStyle":
            return strokeStyle(raw, ctx);
        case "border":
            return border(raw, ctx);
        case "transition":
            return transition(raw, ctx);
        case "gradient":
            return gradient(raw, ctx);
        case "typography":
            return typography(raw, ctx);
    }
}

export function inferType(value: unknown): TokenType | undefined {
    if (typeof value === "number") {
        return "number";
    }

    if (typeof value === "string") {
        const text = value.trim();

        if (parseColor(text) !== undefined) {
            return "color";
        }

        if (LENGTH.test(text) && LENGTH.exec(text)![2] !== undefined) {
            return "dimension";
        }

        if (TIME.test(text)) {
            return "duration";
        }

        if (/^(?:cubic-bezier|steps)\(/i.test(text)) {
            return "cubicBezier";
        }

        if (/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(text)) {
            return "gradient";
        }

        return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text) ? "number" : undefined;
    }

    if (Array.isArray(value)) {
        if (value.length === 4 && value.every((each) => typeof each === "number")) {
            return "cubicBezier";
        }

        if (value.length > 0 && value.every((each) => typeof each === "string")) {
            return "fontFamily";
        }

        if (value.length > 0 && value.every((each) => isObject(each))) {
            return Object.hasOwn(value[0] as Obj, "offsetX")
                ? "shadow"
                : Object.hasOwn(value[0] as Obj, "position")
                  ? "gradient"
                  : undefined;
        }

        return undefined;
    }

    if (isObject(value)) {
        if (Object.hasOwn(value, "colorSpace")) {
            return "color";
        }

        if (Object.hasOwn(value, "offsetX")) {
            return "shadow";
        }

        if (Object.hasOwn(value, "fontSize")) {
            return "typography";
        }

        if (Object.hasOwn(value, "width") && Object.hasOwn(value, "color")) {
            return "border";
        }

        if (Object.hasOwn(value, "duration")) {
            return "transition";
        }

        if (typeof value.value === "number" && typeof value.unit === "string") {
            return value.unit === "ms" || value.unit === "s" ? "duration" : "dimension";
        }
    }

    return undefined;
}
