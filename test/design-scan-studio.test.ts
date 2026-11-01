import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanTokens, type TokenScan } from "../src/server/design/scan.ts";
import type { DesignSystem } from "../src/server/design/system-types.ts";
import { buildSystem } from "../src/server/design/tokens-model.ts";
import { loadDesignSystem } from "../src/server/design/tokens.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-studio-"));

    dirs.push(dir);

    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(
            join(dir, name),
            typeof body === "string" ? body : JSON.stringify(body, null, 2),
        );
    }

    return dir;
}

function load(scan: TokenScan): DesignSystem {
    const system = buildSystem({
        folder: "scan",
        tokens: scan.draft.tokens,
        modes: new Map(Object.entries(scan.draft.modes)),
        components: new Map(),
        guidelines: "",
        problems: [],
    });

    assert.deepEqual(
        system.problems.filter((problem) => problem.level === "error"),
        [],
        "the draft has no error",
    );

    return system;
}

const token = (system: DesignSystem, name: string) =>
    system.tokens.find((each) => each.name === name);
const css = (system: DesignSystem, name: string, mode = "light") =>
    token(system, name)?.modes[mode]?.literal;
const hex = (system: DesignSystem, name: string, mode = "light") =>
    token(system, name)?.modes[mode]?.hex;

const old = (value: unknown, type: string, extra: Record<string, unknown> = {}) => ({
    value,
    type,
    ...extra,
});

const GLOBAL = {
    color: {
        gray: {
            50: old("#f8fafc", "color"),
            200: old("#e2e8f0", "color"),
            500: old("#64748b", "color"),
            900: old("#0f172a", "color"),
            950: old("#020617", "color"),
        },
        indigo: { 400: old("#818cf8", "color"), 600: old("#4f46e5", "color") },
        red: { 400: old("#f87171", "color"), 500: old("#ef4444", "color") },
        white: old("#ffffff", "color"),
    },
    spacing: {
        base: old("4", "spacing"),
        sm: old("{spacing.base} * 2", "spacing"),
        md: old("{spacing.base}*4", "spacing"),
        lg: old("{spacing.md} + {spacing.sm}", "spacing"),
    },
    fontFamilies: { sans: old("Inter", "fontFamilies") },
    fontWeights: { regular: old("Regular", "fontWeights"), bold: old("Semi Bold", "fontWeights") },
    fontSizes: {
        base: old("16", "fontSizes"),
        lg: old("{fontSizes.base} * 1.25", "fontSizes"),
        xl: old("round({fontSizes.base} * 1.6)", "fontSizes"),
    },
    lineHeights: { body: old("150%", "lineHeights") },
    letterSpacing: { tight: old("-2%", "letterSpacing") },
    typography: {
        body: old(
            {
                fontFamily: "{fontFamilies.sans}",
                fontWeight: "{fontWeights.regular}",
                lineHeight: "{lineHeights.body}",
                fontSize: "{fontSizes.base}",
                letterSpacing: "{letterSpacing.tight}",
                textCase: "none",
                paragraphSpacing: "0",
            },
            "typography",
        ),
    },
};
const LIGHT = {
    color: {
        bg: { page: old("{color.gray.50}", "color"), surface: old("{color.white}", "color") },
        text: { primary: old("{color.gray.900}", "color") },
        accent: { default: old("{color.indigo.600}", "color") },
        danger: { default: old("{color.red.500}", "color") },
        overlay: old("rgba({color.gray.950}, 0.5)", "color"),
        soft: old("{color.indigo.600}", "color", {
            $extensions: {
                "studio.tokens": { modify: { type: "alpha", value: "0.2", space: "srgb" } },
            },
        }),
    },
};
const DARK = {
    color: {
        bg: { page: old("{color.gray.950}", "color"), surface: old("{color.gray.900}", "color") },
        text: { primary: old("{color.gray.50}", "color") },
        accent: { default: old("{color.indigo.400}", "color") },
        danger: { default: old("{color.red.400}", "color") },
        glow: old("{color.indigo.400}", "color"),
    },
};
const THEMES = [
    {
        id: "a",
        name: "Light",
        selectedTokenSets: { global: "source", light: "enabled", dark: "disabled" },
    },
    {
        id: "b",
        name: "Dark",
        selectedTokenSets: { global: "source", light: "disabled", dark: "enabled" },
    },
];

test("one file, the older form: every set is read, the themes make the modes, and a reference crosses sets", () => {
    const scan = scanTokens(
        project({
            "tokens.json": {
                global: GLOBAL,
                light: LIGHT,
                dark: DARK,
                $themes: THEMES,
                $metadata: { tokenSetOrder: ["global", "light", "dark"] },
            },
        }),
    );
    const system = load(scan);

    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(
        token(system, "color.bg.page")!.modes.light!.alias,
        "color.gray.50",
        "a reference stays one",
    );
    assert.equal(hex(system, "color.bg.page"), "#f8fafc");
    assert.equal(
        hex(system, "color.bg.page", "dark"),
        "#020617",
        "the dark theme turns on the dark set",
    );
    assert.equal(hex(system, "color.accent.default", "dark"), "#818cf8");
    assert.equal(hex(system, "color.text.primary", "dark"), "#f8fafc");
    assert.equal(token(system, "global.color.gray.50"), undefined);
    assert.equal(token(system, "dark.color.bg.page"), undefined);
    assert.equal(token(system, "color.glow"), undefined);
    assert.ok(
        scan.inferred.notes.some((note) =>
            /1 tokens that only the dark mode has were left out/.test(note),
        ),
    );
    assert.ok(
        scan.inferred.notes.some((note) =>
            /default mode is global \+ light; the dark mode is global \+ dark/.test(note),
        ),
    );
    assert.equal(scan.inferred.imported, system.tokens.length);
});

test("math is evaluated, with units and references: {a} * 2, {a}*4, {a} + {b}", () => {
    const system = load(
        scanTokens(
            project({
                "tokens.json": {
                    global: GLOBAL,
                    $themes: [],
                    $metadata: { tokenSetOrder: ["global"] },
                },
            }),
        ),
    );

    assert.equal(css(system, "spacing.base"), "4px", "a bare number in a spacing token is px");
    assert.equal(css(system, "spacing.sm"), "8px");
    assert.equal(css(system, "spacing.md"), "16px");
    assert.equal(css(system, "spacing.lg"), "24px", "two references added");
    assert.equal(css(system, "fontSizes.lg"), "20px");
});

test("a color: rgba() of a reference; a token with a modifier is left out, not drafted wrong", () => {
    const system = load(
        scanTokens(
            project({
                "tokens.json": {
                    global: GLOBAL,
                    light: {
                        color: {
                            ...LIGHT.color,
                            lighter: old("#2563eb", "color", {
                                $extensions: {
                                    "studio.tokens": { modify: { type: "lighten", value: "0.5" } },
                                },
                            }),
                            darker: old("#2563eb", "color", {
                                $extensions: {
                                    "studio.tokens": { modify: { type: "darken", value: "0.5" } },
                                },
                            }),
                            mixed: old("#ff0000", "color", {
                                $extensions: {
                                    "studio.tokens": {
                                        modify: {
                                            type: "mix",
                                            value: "0.5",
                                            color: "{color.white}",
                                        },
                                    },
                                },
                            }),
                        },
                    },
                    $themes: [],
                    $metadata: { tokenSetOrder: ["global", "light"] },
                },
            }),
        ),
    );

    assert.equal(hex(system, "color.overlay"), "#02061780");

    for (const name of ["color.soft", "color.lighter", "color.darker", "color.mixed"]) {
        assert.equal(token(system, name), undefined, name);
    }
});

test("a folder of Tokens Studio files: $metadata.json, $themes.json, and a file for each set, in folders", () => {
    const scan = scanTokens(
        project({
            "tokens/$metadata.json": {
                tokenSetOrder: ["global", "semantic/light", "semantic/dark", "brand/b2c"],
            },
            "tokens/$themes.json": [
                {
                    id: "x1",
                    name: "light",
                    selectedTokenSets: {
                        global: "source",
                        "semantic/light": "enabled",
                        "brand/b2c": "enabled",
                    },
                },
                {
                    id: "x2",
                    name: "dark",
                    selectedTokenSets: {
                        global: "source",
                        "semantic/dark": "enabled",
                        "brand/b2c": "enabled",
                    },
                },
            ],
            "tokens/global.json": GLOBAL,
            "tokens/semantic/light.json": LIGHT,
            "tokens/semantic/dark.json": DARK,
            "tokens/brand/b2c.json": { color: { brand: old("{color.indigo.600}", "color") } },
        }),
    );
    const system = load(scan);

    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(hex(system, "color.bg.page", "dark"), "#020617");
    assert.equal(hex(system, "color.brand"), "#4f46e5");
    assert.equal(css(system, "spacing.lg"), "24px");
    assert.equal(token(system, "global.color.gray.50"), undefined);
    assert.equal(scan.files.length, 6);
});

test("a folder whose name is not tokens: the files beside $themes.json are the sets", () => {
    const system = load(
        scanTokens(
            project({
                "figma/$themes.json": [
                    {
                        id: "1",
                        name: "Light",
                        selectedTokenSets: { base: "source", day: "enabled" },
                    },
                    {
                        id: "2",
                        name: "Dark",
                        selectedTokenSets: { base: "source", night: "enabled" },
                    },
                ],
                "figma/$metadata.json": { tokenSetOrder: ["base", "day", "night"] },
                "figma/base.json": GLOBAL,
                "figma/day.json": LIGHT,
                "figma/night.json": DARK,
            }),
        ),
    );

    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(hex(system, "color.bg.page", "dark"), "#020617");
});

test("no themes: sets named for dark are the dark mode, the others are the default", () => {
    for (const [base, lightName, darkName] of [
        ["global", "light", "dark"],
        ["core", "Mode/Light", "Mode/Dark"],
        ["base", "theme-light", "theme-dark"],
        ["Primitives", "LightMode", "DarkMode"],
    ] as const) {
        const system = load(
            scanTokens(
                project({
                    "tokens.json": { [base]: GLOBAL, [lightName]: LIGHT, [darkName]: DARK },
                }),
            ),
        );
        const label = [base, lightName, darkName].join(", ");

        assert.deepEqual(system.modes, ["light", "dark"], label);
        assert.equal(hex(system, "color.bg.page"), "#f8fafc", label);
        assert.equal(hex(system, "color.bg.page", "dark"), "#020617", label);
        assert.equal(css(system, "spacing.lg"), "24px", label);
    }
});

test("themes in groups apply together: a mode group and a brand group; extra themes of the mode group are modes", () => {
    const scan = scanTokens(
        project({
            "tokens.json": {
                core: GLOBAL,
                light: LIGHT,
                dark: DARK,
                contrast: {
                    color: {
                        bg: { page: old("#000000", "color") },
                        text: { primary: old("#ffffff", "color") },
                    },
                },
                "brand-a": { color: { brand: old("{color.indigo.600}", "color") } },
                "brand-b": { color: { brand: old("{color.red.500}", "color") } },
                $themes: [
                    {
                        id: "1",
                        name: "Light",
                        group: "Mode",
                        selectedTokenSets: { core: "source", light: "enabled" },
                    },
                    {
                        id: "2",
                        name: "Dark",
                        group: "Mode",
                        selectedTokenSets: { core: "source", dark: "enabled" },
                    },
                    {
                        id: "3",
                        name: "High contrast",
                        group: "Mode",
                        selectedTokenSets: { core: "source", contrast: "enabled" },
                    },
                    {
                        id: "4",
                        name: "Brand A",
                        group: "Brand",
                        selectedTokenSets: { "brand-a": "enabled" },
                    },
                    {
                        id: "5",
                        name: "Brand B",
                        group: "Brand",
                        selectedTokenSets: { "brand-b": "enabled" },
                    },
                ],
                $metadata: {
                    tokenSetOrder: ["core", "light", "dark", "contrast", "brand-a", "brand-b"],
                },
            },
        }),
    );
    const system = load(scan);

    assert.deepEqual(system.modes, ["light", "dark", "high-contrast"]);
    assert.equal(hex(system, "color.brand"), "#4f46e5", "the first brand theme");
    assert.equal(hex(system, "color.brand", "dark"), "#4f46e5", "the brand is in every mode");
    assert.equal(hex(system, "color.bg.page", "high-contrast"), "#000000");
    assert.equal(hex(system, "color.text.primary", "high-contrast"), "#ffffff");
    assert.ok(scan.inferred.notes.some((note) => /Brand B/.test(note) && /scan reads/.test(note)));
});

test("a theme that is only dark is the default mode; a theme that is not dark and has no dark set has one mode", () => {
    const onlyDark = load(
        scanTokens(
            project({
                "tokens.json": {
                    global: GLOBAL,
                    dark: DARK,
                    $themes: [
                        {
                            id: "1",
                            name: "Dark",
                            selectedTokenSets: { global: "source", dark: "enabled" },
                        },
                    ],
                    $metadata: { tokenSetOrder: ["global", "dark"] },
                },
            }),
        ),
    );

    assert.equal(hex(onlyDark, "color.bg.page"), "#020617", "the dark theme is the default");
    assert.equal(onlyDark.modes.length, 1);

    const one = load(
        scanTokens(
            project({
                "tokens.json": {
                    global: GLOBAL,
                    light: LIGHT,
                    $themes: [
                        {
                            id: "1",
                            name: "Default",
                            selectedTokenSets: { global: "enabled", light: "enabled" },
                        },
                    ],
                    $metadata: { tokenSetOrder: ["global", "light"] },
                },
            }),
        ),
    );

    assert.equal(one.modes.length, 1);
    assert.equal(hex(one, "color.accent.default"), "#4f46e5");
});

test("a reference that loops or points nowhere drops that token, not the scan; set names that are unsafe are only names", () => {
    const system = load(
        scanTokens(
            project({
                "tokens.json": {
                    global: {
                        color: {
                            a: old("{color.b}", "color"),
                            b: old("{color.a}", "color"),
                            c: old("{color.nowhere}", "color"),
                            fine: old("#123456", "color"),
                            d: old("#abcdef", "color"),
                            e: old("#fedcba", "color"),
                        },
                        space: {
                            1: old("1", "spacing"),
                            2: old("2", "spacing"),
                            3: old("3 * ", "spacing"),
                            4: old("1 / 0", "spacing"),
                        },
                    },
                    __proto__: { color: { x: old("#000000", "color") } },
                    constructor: { color: { y: old("#000000", "color") } },
                    $themes: [],
                    $metadata: { tokenSetOrder: ["global", "__proto__"] },
                },
            }),
        ),
    );

    assert.ok(token(system, "color.fine"));
    assert.equal(token(system, "color.a"), undefined);
    assert.equal(token(system, "color.b"), undefined);
    assert.equal(token(system, "color.c"), undefined);
    assert.equal(({} as Record<string, unknown>).x, undefined, "nothing reached Object.prototype");
});

test("a round trip: the Tokens Studio file that Pi Pocket exports reads back as the same system, in every mode", () => {
    const flagship = join(import.meta.dirname, "..", "docs", "examples", "design-system", "pocket");
    const original = loadDesignSystem(flagship)!;
    const dir = project({ "tokens.json": original.compiled.studio! });
    const scan = scanTokens(dir);
    const back = load(scan);

    assert.deepEqual(back.modes, original.modes);
    assert.equal(back.tokens.length, original.tokens.length);

    const byName = new Map(back.tokens.map((each) => [each.name, each]));
    const wrong: string[] = [];

    for (const each of original.tokens) {
        const found = byName.get(each.name);

        for (const mode of original.modes) {
            const a = each.modes[mode]?.literal;
            const b = found?.modes[mode]?.literal;

            if (found === undefined || a !== b) {
                wrong.push(`${each.name} ${mode}: ${a} / ${b}`);
            }
        }
    }

    assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} tokens differ`);
    assert.ok(readFileSync(join(dir, "tokens.json"), "utf8").includes("$themes"));
});

test("a large file is read whole: a system with thousands of tokens is more than 200 KB", () => {
    const palette: Record<string, unknown> = {};

    for (let at = 0; at < 3000; at++) {
        palette[`c${at}`] = old(
            `#${(at * 5303 + 0x101010).toString(16).padStart(6, "0").slice(-6)}`,
            "color",
            {
                description: "A palette color that a large system has among thousands.",
            },
        );
    }

    const text = JSON.stringify({
        core: {
            color: palette,
            space: { base: old("4", "spacing"), two: old("{space.base} * 2", "spacing") },
        },
        $themes: [],
        $metadata: { tokenSetOrder: ["core"] },
    });

    assert.ok(text.length > 300_000, String(text.length));

    const scan = scanTokens(project({ "tokens.json": text }));

    assert.ok(scan.inferred.imported > 2900, `${scan.inferred.imported} tokens`);
});

test("Figma's own forms: AUTO line heights, textCase members that point nowhere, and paragraph spacing", () => {
    const system = load(
        scanTokens(
            project({
                "tokens.json": {
                    global: {
                        colors: {
                            red: old("#ff0000", "color"),
                            blue: old("#0000ff", "color"),
                            ink: old("#111111", "color"),
                        },
                        fontFamilies: { roboto: old("Roboto", "fontFamilies") },
                        fontWeights: {
                            "roboto-0": old("Regular", "fontWeights"),
                            "roboto-1": old("Bold", "fontWeights"),
                        },
                        lineHeights: {
                            0: old("AUTO", "lineHeights"),
                            1: old("125%", "lineHeights"),
                        },
                        fontSizes: { 0: old("12", "fontSizes"), 7: old("32", "fontSizes") },
                        letterSpacing: { 0: old("0%", "letterSpacing") },
                        paragraphSpacing: { 0: old("0", "paragraphSpacing") },
                        typography: {
                            heading: {
                                h1: old(
                                    {
                                        fontFamily: "{fontFamilies.roboto}",
                                        fontWeight: "{fontWeights.roboto-1}",
                                        lineHeight: "{lineHeights.0}",
                                        fontSize: "{fontSizes.7}",
                                        letterSpacing: "{letterSpacing.0}",
                                        paragraphSpacing: "{paragraphSpacing.0}",
                                        textCase: "{textCase.none}",
                                        textDecoration: "{textDecoration.none}",
                                    },
                                    "typography",
                                ),
                            },
                        },
                    },
                    $themes: [],
                    $metadata: { tokenSetOrder: ["global"] },
                },
            }),
        ),
    );
    const h1 = token(system, "typography.heading.h1")!;

    assert.equal(h1.type, "typography");
    assert.equal(h1.modes.light!.parts!["font-size"], "32px");
    assert.equal(h1.modes.light!.parts!["font-weight"], "700");
    assert.equal(h1.modes.light!.parts!["line-height"], undefined, "AUTO is no line height");
    assert.equal(token(system, "lineHeights.0"), undefined, "AUTO is no number");
    assert.equal(css(system, "lineHeights.1"), "1.25");
    assert.equal(css(system, "letterSpacing.0"), "0em");
});
