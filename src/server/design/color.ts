import {
    decodeSrgb,
    encodeSrgb,
    fromOklab,
    toOklch,
    type Rgba,
} from "../extensions/design/color.js";

export {
    NAMED_COLORS,
    colorObjectCss,
    contrastRatio,
    luminance,
    num,
    oklabOf,
    over,
    parseColor,
    toHex,
    toOklch,
    type Rgba,
} from "../extensions/design/color.js";

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function toOklab(color: Rgba): { l: number; a: number; b: number } {
    const { l, c, h } = toOklch(color);
    const rad = (h * Math.PI) / 180;

    return { l, a: c * Math.cos(rad), b: c * Math.sin(rad) };
}

// A percentage left out is the rest of 100%; if both add to less than 100%, the mix is translucent by the difference.
export function mixColors(
    space: string,
    first: { color: Rgba; percent?: number },
    second: { color: Rgba; percent?: number },
): Rgba {
    const p1 = first.percent ?? (second.percent === undefined ? 50 : 100 - second.percent);
    const p2 = second.percent ?? (first.percent === undefined ? 50 : 100 - first.percent);

    const total = p1 + p2;

    if (total <= 0) {
        return { r: 0, g: 0, b: 0, a: 0 };
    }

    const w1 = p1 / total;
    const w2 = p2 / total;
    const alpha = (first.color.a * w1 + second.color.a * w2) * Math.min(1, total / 100);
    const a1 = first.color.a * w1;
    const a2 = second.color.a * w2;
    const sum = a1 + a2;

    if (sum === 0) {
        return { r: 0, g: 0, b: 0, a: 0 };
    }

    if (space === "srgb" || space === "srgb-linear") {
        const mix = (x: number, y: number) =>
            space === "srgb"
                ? (x * a1 + y * a2) / sum
                : encodeSrgb((decodeSrgb(x) * a1 + decodeSrgb(y) * a2) / sum);

        return {
            r: clamp(mix(first.color.r, second.color.r)),
            g: clamp(mix(first.color.g, second.color.g)),
            b: clamp(mix(first.color.b, second.color.b)),
            a: clamp(alpha),
        };
    }

    // Polar spaces mix the hue along the shorter arc; the rest is mixed in Oklab.
    if (["oklch", "lch", "hsl", "hwb"].includes(space)) {
        const x = toOklch(first.color);
        const y = toOklch(second.color);
        // A gray has no hue of its own: it takes the other color's.
        const hueX = x.c < 0.0004 ? y.h : x.h;
        const hueY = y.c < 0.0004 ? x.h : y.h;
        const gap = ((hueY - hueX + 540) % 360) - 180;
        const hue = (((hueX + gap * (a2 / sum)) % 360) + 360) % 360;
        const l = (x.l * a1 + y.l * a2) / sum;
        const c = (x.c * a1 + y.c * a2) / sum;
        const rad = (hue * Math.PI) / 180;

        return fromOklab(l, c * Math.cos(rad), c * Math.sin(rad), alpha);
    }

    const x = toOklab(first.color);
    const y = toOklab(second.color);

    return fromOklab(
        (x.l * a1 + y.l * a2) / sum,
        (x.a * a1 + y.a * a2) / sum,
        (x.b * a1 + y.b * a2) / sum,
        alpha,
    );
}
