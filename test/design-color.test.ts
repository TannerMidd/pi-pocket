import assert from "node:assert/strict";
import { test } from "node:test";
import {
    NAMED_COLORS,
    colorObjectCss,
    contrastRatio,
    luminance,
    mixColors,
    num,
    over,
    parseColor,
    toHex,
    toOklch,
} from "../src/server/design/color.ts";
import { contrastOf } from "../src/server/design/lint-color.ts";

const hex = (text: string) => {
    const color = parseColor(text);

    return color === undefined ? undefined : toHex(color);
};

test("hex in 3, 4, 6, and 8 digits, any case", () => {
    assert.equal(hex("#7AA2F7"), "#7aa2f7");
    assert.equal(hex("#abc"), "#aabbcc");
    assert.equal(hex("#abcd"), "#aabbccdd");
    assert.equal(hex("#11223344"), "#11223344");
    assert.equal(hex("#12345"), undefined);
    assert.equal(hex("#ggg"), undefined);
    assert.equal(hex("#"), undefined);
});

test("rgb and hsl in the modern and the legacy syntax, with alpha", () => {
    assert.equal(hex("rgb(122 162 247)"), "#7aa2f7");
    assert.equal(hex("rgb(122, 162, 247)"), "#7aa2f7");
    assert.equal(hex("rgba(0,0,0,0.5)"), "#00000080");
    assert.equal(hex("rgb(0 0 0 / 50%)"), "#00000080");
    assert.equal(hex("rgb(100% 0% 0%)"), "#ff0000");
    assert.equal(hex("hsl(220 90% 70%)"), "#6e9cf7");
    assert.equal(hex("hsl(220, 90%, 70%)"), "#6e9cf7");
    assert.equal(hex("hsla(0, 100%, 50%, 0.5)"), "#ff000080");
    assert.equal(hex("hsl(0.5turn 100% 50%)"), "#00ffff");
    assert.equal(hex("hwb(220 10% 10%)"), "#1a5ee6");
    assert.equal(hex("hsl(0 0% 100%)"), "#ffffff");
});

test("oklch, oklab, lab, and lch match the browser's conversion", () => {
    // Values taken from Chromium's canvas for the same input.
    assert.equal(hex("oklch(0.72 0.12 264)"), "#7ea3f0");
    assert.equal(hex("oklch(70% 0.15 30deg)"), "#ed7665");
    assert.equal(hex("oklab(0.7 0.1 0.05)"), "#db8279");
    assert.equal(hex("lab(50 40 30)"), "#bb5846");
    assert.equal(hex("lch(50 40 30)"), "#b25d57");
    assert.equal(hex("oklch(1 0 0)"), "#ffffff");
    assert.equal(hex("oklch(0 0 0)"), "#000000");
});

test("color() in the supported spaces", () => {
    assert.equal(hex("color(srgb 1 0.5 0)"), "#ff8000");
    assert.equal(hex("color(display-p3 1 0 0)"), "#ff0000");
    assert.equal(hex("color(display-p3 0.2 0.5 0.8)"), "#0082d2");
    assert.equal(hex("color(xyz-d65 0.4 0.2 0.1)"), "#f80053");
    assert.equal(hex("color(xyz-d50 0.4 0.2 0.1)"), "#f10063");
    assert.equal(hex("color(rec2020 0.5 0.5 0.5)"), "#8b8b8b");
    assert.equal(hex("color(prophoto-rgb 1 0 0)"), undefined);
});

test("names, transparent, and what is not a color", () => {
    assert.equal(hex("white"), "#ffffff");
    assert.equal(hex("RebeccaPurple"), "#663399");
    assert.equal(hex("transparent"), "#00000000");
    assert.equal(NAMED_COLORS.size, 148);
    assert.equal(hex("currentColor"), undefined);
    assert.equal(hex("var(--x)"), undefined);
    assert.equal(hex("color-mix(in srgb, red, blue)"), undefined);
    assert.equal(hex("rgb(calc(1 + 1) 0 0)"), undefined);
    assert.equal(hex("rgb(1 2)"), undefined);
    assert.equal(hex(""), undefined);
    assert.equal(hex("blueish"), undefined);
});

test("the WCAG 2.2 contrast ratio", () => {
    const black = parseColor("#000")!;
    const white = parseColor("#fff")!;

    assert.equal(contrastRatio(black, white), 21);
    assert.equal(contrastRatio(white, white), 1);
    // #777 on white is the classic 4.48:1 (just under AA).
    assert.ok(Math.abs(contrastRatio(parseColor("#777")!, white) - 4.478) < 0.01);
    assert.ok(Math.abs(contrastRatio(parseColor("#767676")!, white) - 4.54) < 0.01);
    assert.equal(luminance(white), 1);
    assert.equal(luminance(black), 0);
    assert.equal(contrastRatio(white, black), contrastRatio(black, white));
});

test("the Check's contrastOf of 0-255 channels is contrastRatio to the last bit", () => {
    const channels = [0, 0.4, 1, 17, 118.5, 127, 128, 200, 254.6, 255];

    for (const r of channels) {
        for (const g of channels) {
            for (const b of [0, 51, 255]) {
                const front = [r, g, b];
                const back = [255 - g, b, r];
                const color = ([red, green, blue]: number[]) => ({
                    r: red! / 255,
                    g: green! / 255,
                    b: blue! / 255,
                    a: 1,
                });

                assert.equal(contrastOf(front, back), contrastRatio(color(front), color(back)));
            }
        }
    }
});

test("translucent colors are composited: the foreground over the background, the background over the page", () => {
    const white = parseColor("#fff")!;
    const half = parseColor("rgb(0 0 0 / 0.5)")!;

    assert.deepEqual(toHex(over(half, white)), "#808080");
    assert.ok(
        Math.abs(contrastRatio(half, white) - contrastRatio(parseColor("#808080")!, white)) < 0.05,
    );
    const glass = parseColor("rgb(255 255 255 / 0.1)")!;
    const text = parseColor("#fff")!;

    assert.ok(contrastRatio(text, glass, { r: 0, g: 0, b: 0, a: 1 }) > contrastRatio(text, glass));
});

test("oklch of a color, and its CSS text", () => {
    const blue = toOklch(parseColor("#7aa2f7")!);

    assert.ok(Math.abs(blue.l - 0.719) < 0.002);
    assert.ok(Math.abs(blue.h - 264.2) < 0.5);
    assert.equal(toOklch(parseColor("#808080")!).h, 0, "a gray has no hue");
});

test("the DTCG color object becomes CSS, and a bad one says how to fix it", () => {
    assert.deepEqual(colorObjectCss({ colorSpace: "srgb", components: [0.5, 0.2, 1] }), {
        css: "#8033ff",
    });
    assert.deepEqual(
        colorObjectCss({ colorSpace: "srgb", components: [0.5, 0.2, 1], alpha: 0.5 }),
        {
            css: "rgb(128 51 255 / 0.5)",
        },
    );
    assert.deepEqual(colorObjectCss({ colorSpace: "oklch", components: [0.72, 0.12, 264] }), {
        css: "oklch(0.72 0.12 264)",
    });
    assert.deepEqual(colorObjectCss({ colorSpace: "hsl", components: [220, 90, 70] }), {
        css: "hsl(220 90% 70%)",
    });
    assert.deepEqual(
        colorObjectCss({ colorSpace: "display-p3", components: [1, 0, "none"], alpha: 0.25 }),
        {
            css: "color(display-p3 1 0 none / 0.25)",
        },
    );
    assert.deepEqual(
        colorObjectCss({ colorSpace: "lab", components: [50, 40, 30], hex: "#bb5846" }),
        {
            css: "lab(50 40 30)",
        },
    );

    for (const bad of [
        null,
        [],
        { components: [0, 0, 0] },
        { colorSpace: "cmyk", components: [0, 0, 0, 0] },
        { colorSpace: "srgb", components: [0, 0] },
        { colorSpace: "srgb", components: [0, "x", 0] },
        { colorSpace: "srgb", components: [0, 0, 0], alpha: 2 },
        { colorSpace: "srgb", components: [0, 0, 0], hex: "nope" },
    ]) {
        const result = colorObjectCss(bad);

        assert.ok("error" in result, JSON.stringify(bad));
    }
});

test("num trims digits and the sign of zero", () => {
    assert.equal(num(0.123456), "0.1235");
    assert.equal(num(-0.00001), "0");
    assert.equal(num(2), "2");
    assert.equal(num(1 / 3, 2), "0.33");
});

test("mixColors matches the browser's color-mix()", () => {
    const parse = (text: string) => parseColor(text)!;
    const mixed = (space: string, a: string, pa: number | undefined, b: string, pb?: number) =>
        toHex(
            mixColors(
                space,
                { color: parse(a), ...(pa === undefined ? {} : { percent: pa }) },
                { color: parse(b), ...(pb === undefined ? {} : { percent: pb }) },
            ),
        );

    // Values from Chromium's canvas for the same color-mix().
    assert.equal(mixed("oklab", "#a9b1d6", 76, "#1a1b26"), "#8389a8");
    assert.equal(mixed("srgb", "#a9b1d6", 4, "#1a1b26"), "#20212d");
    assert.equal(mixed("srgb", "red", undefined, "blue"), "#800080");
    assert.equal(
        mixed("srgb", "#a9b1d6", 7, "transparent"),
        "#a9b1d612",
        "a mix with transparent keeps the color, less opaque",
    );
    // The hue turns the short way; a channel may differ by one in the last place.
    const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

    assert.ok(
        channels(mixed("oklch", "#7aa2f7", 50, "#f7768e")).every(
            (value, at) => Math.abs(value - channels("#c986e0")[at]!) <= 1,
        ),
    );
    assert.equal(mixed("srgb", "#000", 25, "#fff", 25), "#80808080");
});
