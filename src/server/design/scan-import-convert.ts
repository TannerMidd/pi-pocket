import { colorsIn } from "./scan-parse.ts";
import { shadowValue } from "./scan-scales.ts";

export type Obj = Record<string, unknown>;

export const isObject = (value: unknown): value is Obj =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export const isGroup = (value: unknown): value is Obj => isObject(value) && !("$value" in value);

const TYPES: Record<string, string> = {
    color: "color",
    dimension: "dimension",
    sizing: "dimension",
    spacing: "dimension",
    borderradius: "dimension",
    borderwidth: "dimension",
    fontsizes: "dimension",
    fontsize: "dimension",
    letterspacing: "dimension",
    paragraphspacing: "dimension",
    fontfamilies: "fontFamily",
    fontfamily: "fontFamily",
    fontweights: "fontWeight",
    fontweight: "fontWeight",
    lineheights: "number",
    lineheight: "number",
    opacity: "number",
    number: "number",
    boxshadow: "shadow",
    shadow: "shadow",
    typography: "typography",
    duration: "duration",
    cubicbezier: "cubicBezier",
    border: "border",
    transition: "transition",
    gradient: "gradient",
    strokestyle: "strokeStyle",
};

const LENGTH_TYPES = new Set(Object.keys(TYPES).filter((key) => TYPES[key] === "dimension"));

const WEIGHTS: Record<string, number> = {
    thin: 100,
    hairline: 100,
    extralight: 200,
    ultralight: 200,
    light: 300,
    regular: 400,
    normal: 400,
    book: 400,
    medium: 500,
    semibold: 600,
    demibold: 600,
    bold: 700,
    extrabold: 800,
    ultrabold: 800,
    black: 900,
    heavy: 900,
};

function weightOf(value: unknown): unknown {
    if (typeof value !== "string") {
        return value;
    }

    const text = value.trim();

    if (/^\d{3,4}$/.test(text)) {
        return Number(text);
    }

    const name = text
        .toLowerCase()
        .replace(/\b(?:italic|oblique)\b/g, "")
        .replace(/[\s_-]+/g, "");

    return WEIGHTS[name] ?? value;
}

const px = (value: unknown): unknown =>
    typeof value === "number" ||
    (typeof value === "string" && /^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()))
        ? `${Number(value)}px`
        : value;

// Figma's `-2%` letter spacing is `-0.02em`.
function trackingOf(value: unknown): unknown {
    if (typeof value === "string") {
        const percent = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*%\s*$/.exec(value);

        if (percent !== null) {
            return `${Number((Number(percent[1]) / 100).toFixed(4))}em`;
        }
    }

    return px(value);
}

// A bare line height is a ratio, as Tokens Studio writes it, not px.
function leadingOf(value: unknown): unknown {
    if (typeof value === "string") {
        const percent = /^\s*(\d+\.?\d*|\.\d+)\s*%\s*$/.exec(value);

        if (percent !== null) {
            return Number((Number(percent[1]) / 100).toFixed(4));
        }

        if (/^\s*(?:\d+\.?\d*|\.\d+)\s*$/.test(value)) {
            return Number(value);
        }
    }

    return value;
}

function shadowLayer(layer: unknown): unknown {
    if (!isObject(layer) || layer.x === undefined) {
        return layer;
    }

    const length = (value: unknown) =>
        typeof value === "number" || /^-?[\d.]+$/.test(String(value))
            ? `${value}px`
            : String(value);

    return {
        color: layer.color,
        offsetX: length(layer.x),
        offsetY: length(layer.y),
        blur: length(layer.blur ?? 0),
        ...(layer.spread === undefined ? {} : { spread: length(layer.spread) }),
        ...(layer.type === "innerShadow" ? { inset: true } : {}),
    };
}

function typographyOf(value: Obj): Obj {
    const family = value.fontFamily ?? value.fontFamilies;
    const size = value.fontSize ?? value.fontSizes;
    const weight = value.fontWeight ?? value.fontWeights;
    const leading = value.lineHeight ?? value.lineHeights;
    // Figma's `AUTO` is no number: the style has no line height of its own.
    const auto = /^\s*(?:auto|normal)\s*$/i.test(String(leading));

    return {
        ...(family === undefined ? {} : { fontFamily: family }),
        ...(size === undefined ? {} : { fontSize: px(size) }),
        ...(weight === undefined ? {} : { fontWeight: weightOf(weight) }),
        ...(leading === undefined || auto ? {} : { lineHeight: leadingOf(leading) }),
        ...(value.letterSpacing === undefined
            ? {}
            : { letterSpacing: trackingOf(value.letterSpacing) }),
    };
}

function borderOf(value: Obj): Obj {
    return {
        ...(value.color === undefined ? {} : { color: value.color }),
        ...(value.width === undefined ? {} : { width: px(value.width) }),
        ...(value.style === undefined ? {} : { style: value.style }),
    };
}

export function convert(node: Obj, value: unknown, rawType = ""): Obj | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    const key = rawType.toLowerCase();
    let type: string | undefined = TYPES[key];

    if (type === undefined && rawType === "" && typeof value === "string") {
        const colors = colorsIn(value, true);

        if (colors.length === 1 && colors[0]!.text === value.trim()) {
            type = "color";
        }
    }

    // A reference takes its type from its target, and a mode file leaves it to the default mode.
    const reference = typeof value === "string" && /^\{[^{}]+\}$/.test(value.trim());
    let out: unknown = value;

    if (type === undefined && !reference) {
        return undefined;
    }

    if (typeof value === "string" && !value.startsWith("{")) {
        if (key === "letterspacing" && type === "dimension") {
            out = trackingOf(value);
        } else if (LENGTH_TYPES.has(key) && /^-?[\d.]+$/.test(value)) {
            out = `${value}px`;
        } else if ((key.startsWith("lineheight") || key === "opacity") && /^[\d.]+%$/.test(value)) {
            out = Number.parseFloat(value) / 100;
        } else if (type === "number" && /^-?[\d.]+$/.test(value)) {
            out = Number(value);
        } else if (type === "fontWeight") {
            out = weightOf(value);
        } else if (type === "duration" && /^-?\d*\.?\d+$/.test(value.trim())) {
            out = `${value.trim()}ms`;
        }
    } else if (typeof value === "number" && LENGTH_TYPES.has(key)) {
        out = `${value}px`;
    } else if (typeof value === "number" && type === "duration") {
        out = `${value}ms`;
    }

    if (type === "shadow") {
        out =
            typeof out === "string" && !out.trim().startsWith("{")
                ? shadowValue(out)
                : Array.isArray(out)
                  ? out.map(shadowLayer)
                  : shadowLayer(out);
    } else if (type === "typography" && isObject(out)) {
        out = typographyOf(out);
    } else if (type === "border" && isObject(out)) {
        out = borderOf(out);
    }

    if (type === "number" && typeof out === "string" && !out.trim().startsWith("{")) {
        return undefined;
    }

    const token: Obj = type === undefined ? { $value: out } : { $value: out, $type: type };
    const description = node.$description ?? node.description ?? node.comment;

    if (typeof description === "string" && description !== "") {
        token.$description = description.slice(0, 200);
    }

    return token;
}
