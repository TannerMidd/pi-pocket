import { commaParts, px } from "./scan-parse.ts";
import { parseColor } from "./color.ts";
import { type Category, type Facts, namespaceOf } from "./scan-facts.ts";
import { channelColor, type Variable } from "./scan-variables.ts";

export const LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vw|vh|ch|pt)?$/;

const FONT_WORDS =
    /sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-monospace|ui-serif|cursive/i;

const COLOR_TOKEN =
    /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|var|light-dark)\(.*\)|transparent|currentcolor|[a-z]{3,20})$/i;

// Safe characters only: the value is written into a token file and a stylesheet.
export const GRADIENT =
    /^(?:repeating-)?(?:linear|radial|conic)-gradient\([\w\s,.%#()/+*-]{4,360}\)$/i;

const NUMBER_NAMES: [RegExp, Category][] = [
    [/leading|line-height|lh\b/, "leading"],
    [/^z|z-?index|layer/, "z"],
    [/opacity|alpha/, "opacity"],
];

// A line height written as a length is not a size: it gets no category.
const LENGTH_NAMES: [RegExp, Category | undefined][] = [
    [/radius|rounded|corner/, "radius"],
    [/tracking|letter/, "tracking"],
    [/breakpoint|screen|^bp-/, "breakpoint"],
    [/space|spacing|gap|gutter|pad|margin|inset/, "space"],
    [/line-height|leading|(?:^|-)lh$/, undefined],
];

function looksLikeShadow(text: string): boolean {
    // The token pattern below backtracks on many open parentheses: no shadow is this long.
    if (text.length > 600) {
        return false;
    }

    const layers = commaParts(text.trim());

    if (
        layers.length === 0 ||
        layers.length > 8 ||
        /^(?:none|inherit|initial|unset)$/i.test(text.trim())
    ) {
        return false;
    }

    return layers.every((layer) => {
        const tokens = layer.match(/(?:[^\s(]|\([^)]*(?:\([^)]*\)[^)]*)*\))+/g) ?? [];
        const isLength = (token: string) => /^-?(?:\d*\.?\d+)(?:px|rem|em)?$/i.test(token);
        const isInset = (token: string) => token.toLowerCase() === "inset";
        const lengths = tokens.filter(isLength).length;
        const others = tokens.filter((token) => !isLength(token) && !isInset(token));

        return (
            lengths >= 2 &&
            lengths <= 4 &&
            others.length === 1 &&
            COLOR_TOKEN.test(others[0]!) &&
            tokens.filter(isInset).length <= 1
        );
    });
}

export function categorize(
    variable: Variable,
    text: string,
    layouts?: Facts["varLayout"],
): Category | undefined {
    if (variable.hint !== undefined) {
        return variable.hint;
    }

    const name = variable.name.toLowerCase();
    const space = namespaceOf(name);

    if (space !== undefined && variable.kind === "theme") {
        return space.category;
    }

    if (
        channelColor(text, name) !== undefined ||
        parseColor(text) !== undefined ||
        /^color-mix\(/i.test(text) ||
        /^rgba?\(\s*[$@][\w-]+\s*,/i.test(text)
    ) {
        return "color";
    }

    if (GRADIENT.test(text)) {
        return "gradient";
    }

    if (/^\d*\.?\d+(?:ms|s)$/.test(text)) {
        return "duration";
    }

    if (
        /^cubic-bezier\(|^(?:ease|ease-in|ease-out|ease-in-out|linear)$/.test(text) ||
        (/ease|easing|curve|timing/.test(name) && /\(/.test(text))
    ) {
        return "ease";
    }

    if (
        !/[/\\]|\.(?:woff2?|ttf|otf|eot)\b|^url\(|^https?:/i.test(text) &&
        (FONT_WORDS.test(text) || (/font|family|typeface/.test(name) && /[,"']/.test(text)))
    ) {
        return "font";
    }

    if ((/shadow|elevation/.test(name) && /\d/.test(text)) || looksLikeShadow(text)) {
        return "shadow";
    }

    if (/^\d{3}$/.test(text) && /weight|fw\b/.test(name)) {
        return "weight";
    }

    if (/^-?\d*\.?\d+$/.test(text)) {
        return NUMBER_NAMES.find(([pattern]) => pattern.test(name))?.[1];
    }

    if (LENGTH.test(text)) {
        const named = LENGTH_NAMES.find(([pattern]) => pattern.test(name));

        if (named !== undefined) {
            return named[1];
        }

        if (/font-size|typescale|type-scale|^text-|-text-|^fs-|^type-|(?:^|-)step-\d/.test(name)) {
            const size = px(text) ?? 0;

            return size >= 8 && size <= 160 ? "text" : "size";
        }

        // A length with a neutral name (`--size-4`) is what the properties that take it say it is.
        // The numbered family decides (`--size-1` to `--size-8`), since not every step is used.
        const stem = (each: string) => each.replace(/[-_]?\d+$/, "");
        const layout = { space: 0, text: 0, radius: 0, box: 0 };

        for (const [each, counts] of layouts ?? []) {
            if (
                each === variable.name ||
                (/\d$/.test(variable.name) && stem(each) === stem(variable.name))
            ) {
                for (const key of ["space", "text", "radius", "box"] as const) {
                    layout[key] += counts[key];
                }
            }
        }

        const most = Math.max(layout.space, layout.text, layout.radius, layout.box);

        if (most > 0 && layout.box < most) {
            return layout.space === most ? "space" : layout.radius === most ? "radius" : "text";
        }

        return "size";
    }

    return undefined;
}
