import assert from "node:assert/strict";
import { test } from "node:test";

type Vars = Record<string, string>;

// A web module, loaded as the browser loads it; its path as a value keeps the type checker from looking for types.
const ICON: string = "../web/app-icon.js";
const { iconSvg } = (await import(ICON)) as {
    iconSvg(vars: Vars, options?: { maskable?: boolean }): string;
};

// Vantablack's palette as theme.js's `themeVars` maps it (theme.js needs a page, so the variables are written out).
const vantablack: Vars = {
    "--o-bg": "#000000",
    "--o-bg-darker": "#070707",
    "--o-orange": "#b9b9b9",
    "--o-cyan": "#b0b0b0",
    "--o-green": "#b6b6b6",
};
const tokyo: Vars = {
    "--o-bg": "#1a1b26",
    "--o-bg-darker": "#16161e",
    "--o-orange": "#ff9e64",
    "--o-cyan": "#449dab",
    "--o-green": "#9ece6a",
};

test("the icon is drawn in the palette's colors", () => {
    const svg = iconSvg(vantablack);

    assert.match(svg, /fill="#000000"/, "the card is the palette's background");
    assert.match(svg, /fill="#070707"/, "the frame around it is the darker background");
    assert.match(svg, /fill="#b9b9b9"/, "the π is the palette's orange");
    assert.doesNotMatch(
        svg,
        /#ff9e64|#33ccff|#00ff99|#1a1b26|#13141c/,
        "no color of the app's own icon is left",
    );
});

test("two palettes give two icons", () => {
    assert.notEqual(iconSvg(tokyo), iconSvg(vantablack));
});

test("a palette that lacks a color keeps the app's own icon color there", () => {
    const svg = iconSvg({ ...vantablack, "--o-orange": undefined as unknown as string });

    assert.match(svg, /fill="#ff9e64"/, "the π falls back to the app's orange");
    assert.doesNotMatch(svg, /undefined/);
});

test("the drawing is that of icon.svg, so the two do not drift", async () => {
    const { readFile } = await import("node:fs/promises");
    const file = await readFile(new URL("../web/icon.svg", import.meta.url), "utf8");
    // The shapes of the file, with its colors taken out: what is left must be in the drawing too.
    const shapes = [...file.matchAll(/<(rect|text)\b([^>]*)>/g)].map(
        ([, tag, attrs]) =>
            `${tag} ${(attrs ?? "")
                .replace(/\s(fill|stroke)="[^"]*"/g, "")
                .replace(/\s+/g, " ")
                .trim()}`,
    );
    const drawn = iconSvg(tokyo)
        .replace(/\s(fill|stroke)="[^"]*"/g, "")
        .replace(/\s+/g, " ");

    assert.ok(shapes.length >= 3, "the file has its three shapes");

    for (const shape of shapes) {
        const [tag, ...attrs] = shape.split(" ");

        for (const attr of attrs.filter(
            (each) => !each.startsWith("font-family") && each.includes("="),
        )) {
            assert.ok(drawn.includes(attr), `${tag} keeps ${attr}`);
        }
    }
});
