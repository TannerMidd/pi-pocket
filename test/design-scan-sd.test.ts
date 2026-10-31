import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanReport, scanTokens, type TokenScan } from "../src/server/design/scan.ts";
import { type Entry, Mode, flatten } from "../src/server/design/scan-import-eval.ts";
import type { DesignSystem } from "../src/server/design/system-types.ts";
import { buildSystem } from "../src/server/design/tokens-model.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-sd-"));

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

const classic = (value: unknown, extra: Record<string, unknown> = {}) => ({ value, ...extra });

const BASE = {
    color: {
        base: {
            gray: {
                50: classic("#f9fafb"),
                200: classic("#e5e7eb"),
                500: classic("#6b7280"),
                800: classic("#1f2937"),
                900: classic("#111827"),
            },
            blue: { 600: classic("#2563eb") },
            red: { 600: classic("#dc2626") },
            white: classic("#ffffff"),
        },
    },
};
const SEMANTIC = {
    color: {
        bg: {
            page: classic("{color.base.gray.50.value}"),
            surface: classic("{color.base.white.value}"),
        },
        text: {
            primary: classic("{color.base.gray.900.value}", { comment: "Body text" }),
            muted: classic("{color.base.gray.500}"),
        },
        border: { default: classic("{color.base.gray.200.value}") },
        accent: { default: classic("{color.base.blue.600.value}") },
        danger: { default: classic("{color.base.red.600.value}") },
        overlay: classic("rgba({color.base.gray.900.value}, 0.5)"),
    },
};
const SIZES = {
    size: {
        space: { 1: classic("4px"), 2: classic("8px"), 4: classic("16px"), 6: classic(24) },
        radius: { sm: classic("4"), md: classic("8px"), pill: classic("9999px") },
        font: { sm: classic("14px"), base: classic("16px"), lg: classic("20px") },
    },
};
const OTHERS = {
    font: {
        family: { sans: classic("Inter, system-ui, sans-serif") },
        weight: { bold: classic("700") },
    },
    shadow: {
        sm: classic("0 1px 2px rgba(0,0,0,0.2)"),
        md: classic(
            { x: "0", y: "4", blur: "12", spread: "0", color: "rgba(0,0,0,0.18)" },
            { type: "shadow" },
        ),
    },
    time: { fast: classic("120ms"), slow: classic(300) },
};
const SOURCE = {
    "tokens/color/base.json": BASE,
    "tokens/color/semantic.json": SEMANTIC,
    "tokens/size/spacing.json": SIZES,
    "tokens/font.json": { font: OTHERS.font },
    "tokens/shadow.json": { shadow: OTHERS.shadow },
    "tokens/motion.json": { time: OTHERS.time },
};

test("the classic format in several folders: files merge, references with and without .value, types from the categories", () => {
    const scan = scanTokens(
        project({
            ...SOURCE,
            "package.json": { name: "x", scripts: { build: "style-dictionary build" } },
        }),
    );
    const system = load(scan);

    assert.ok(scan.inferred.imported >= 30, String(scan.inferred.imported));
    assert.ok(token(system, "color.base.gray.50") && token(system, "color.bg.page"));
    assert.equal(
        token(system, "color.bg.page")!.modes.light!.alias,
        "color.base.gray.50",
        "a reference with .value is a reference",
    );
    assert.equal(
        token(system, "color.text.muted")!.modes.light!.alias,
        "color.base.gray.500",
        "and one without",
    );
    assert.equal(token(system, "color.text.primary")!.description, "Body text");
    assert.equal(hex(system, "color.overlay"), "#11182780", "rgba of a reference");
    assert.equal(css(system, "size.space.1"), "4px");
    assert.equal(css(system, "size.space.6"), "24px", "a bare number in size is px");
    assert.equal(css(system, "size.radius.sm"), "4px");
    assert.equal(token(system, "font.family.sans")!.type, "fontFamily");
    assert.equal(token(system, "font.weight.bold")!.modes.light!.value, 700);
    assert.equal(token(system, "shadow.sm")!.type, "shadow");
    assert.equal(token(system, "shadow.md")!.type, "shadow");
    assert.equal(css(system, "time.fast"), "120ms");
    assert.equal(css(system, "time.slow"), "300ms", "a bare number in time is ms");
    assert.equal(system.modes.length, 1);
    assert.equal(token(system, "package.name"), undefined, "package.json is not a token file");
});

test("brands and themes are modes: the same paths with other values; a theme named for dark is the dark mode", () => {
    const scan = scanTokens(
        project({
            ...SOURCE,
            "brands/acme/color.json": { color: { accent: { default: classic("#ea580c") } } },
            "brands/globex/color.json": { color: { accent: { default: classic("#7c3aed") } } },
            "themes/dark/color.json": {
                color: {
                    bg: {
                        page: classic("{color.base.gray.900.value}"),
                        surface: classic("{color.base.gray.800.value}"),
                    },
                    text: { primary: classic("{color.base.gray.50.value}") },
                },
            },
        }),
    );
    const system = load(scan);

    assert.deepEqual(system.modes, ["light", "dark", "globex"]);
    assert.equal(hex(system, "color.accent.default"), "#ea580c", "the first brand is the default");
    assert.equal(hex(system, "color.accent.default", "globex"), "#7c3aed");
    assert.equal(hex(system, "color.bg.page", "dark"), "#111827");
    assert.equal(hex(system, "color.text.primary", "dark"), "#f9fafb");
    assert.equal(
        hex(system, "color.border.default", "dark"),
        "#e5e7eb",
        "a mode holds only what it changes",
    );
    assert.ok(scan.inferred.notes.some((note) => /modes found: acme, globex, dark/.test(note)));
});

test("the usual folders, the old `properties/` layout, attributes and comments", () => {
    const system = load(
        scanTokens(
            project({
                "properties/color/base.json": {
                    color: {
                        base: {
                            gray: {
                                light: classic("#f5f5f5", { comment: "light gray" }),
                                dark: classic("#222222"),
                            },
                            red: classic("#e11d48", {
                                attributes: { category: "color", type: "base" },
                            }),
                        },
                    },
                },
                "properties/color/font.json": {
                    color: {
                        font: { base: classic("{color.base.gray.dark.value}") },
                        background: { base: classic("{color.base.gray.light.value}") },
                        danger: classic("{color.base.red.value}"),
                    },
                },
                "properties/size/size.json": {
                    size: {
                        font: { small: classic("0.75rem"), base: classic("1rem") },
                        padding: { tiny: classic("0.25rem"), small: classic("0.5rem") },
                        radius: { base: classic("4") },
                    },
                },
                "properties/time.json": {
                    time: { duration: { fast: classic("150"), slow: classic("400") } },
                },
            }),
        ),
    );

    assert.equal(hex(system, "color.base.gray.light"), "#f5f5f5");
    assert.equal(token(system, "color.font.base")!.modes.light!.alias, "color.base.gray.dark");
    assert.equal(token(system, "color.base.gray.light")!.description, "light gray");
    assert.equal(css(system, "size.font.small"), "0.75rem");
    assert.equal(css(system, "size.radius.base"), "4px");
    assert.equal(css(system, "time.duration.fast"), "150ms");
});

test("the report names the files the tokens came from", () => {
    const text = scanReport(scanTokens(project(SOURCE)));

    assert.match(text, /Used the \d+ tokens from tokens\/color\/base\.json/);
});

test("references that double a token's text at each level stop at a limit (the heap filled before)", () => {
    const chain = Array.from({ length: 24 }, (_, i) => [`c${i + 1}`, { $value: `{c${i}}{c${i}}` }]);
    const entries = new Map<string, Entry>();

    flatten(Object.fromEntries([["c0", { $value: "ab" }], ...chain]), entries, { left: 100 });
    assert.equal(new Mode(entries).valueOf("c24"), undefined);
});
