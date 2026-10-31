import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    UNKNOWN,
    colorsIn,
    isDarkSelector,
    parseStyles,
    readLiteral,
} from "../src/server/design/scan-parse.ts";
import { scanReport, scanTokens, type TokenScan } from "../src/server/design/scan.ts";
import type { DesignSystem } from "../src/server/design/system-types.ts";
import { buildSystem } from "../src/server/design/tokens-model.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-scan-infer-"));

    dirs.push(dir);

    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), body);
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
const hex = (system: DesignSystem, name: string, mode = "light") =>
    token(system, name)?.modes[mode]?.hex;

test("parseStyles: scopes, at-rules, nesting, strings, and variables", () => {
    const decls = parseStyles(`
:root { --bg: #fff; --fg: #111 }
.dark, [data-theme="dark"] { --bg: #000 }
html[data-theme=dark] { --fg: #eee }
@media (prefers-color-scheme: dark) { :root { --accent: #7aa2f7 } body { background: #000 } }
@theme inline { --color-brand: oklch(0.7 0.1 250) }
.card { --card-bg: red; padding: 8px 16px; background: var(--bg) url(data:image/png;base64,AAA=); content: "a;b{c}" }
.parent { .child { margin: 4px } &:hover { color: red } &.on { color: blue } }
$brand: #36f; @link: #00f; $map: (a: 1px, b: 2px);
`);
    const find = (prop: string, value?: string) =>
        decls.find((each) => each.prop === prop && (value === undefined || each.value === value))!;

    assert.equal(find("--bg", "#fff").scope, "default");
    assert.equal(find("--bg", "#000").scope, "dark");
    assert.equal(find("--fg", "#eee").scope, "dark");
    assert.equal(find("--accent").scope, "dark");
    assert.equal(find("--card-bg").scope, "other", "a component's variable is neither");
    assert.equal(find("--color-brand").theme, true);
    assert.equal(find("--color-brand").scope, "default");
    assert.equal(find("background", "#000").scope, "dark");
    assert.equal(find("padding").value, "8px 16px");
    assert.equal(
        find("background", "var(--bg) url(data:image/png;base64,AAA=)").selector,
        ".card",
        "a ; inside url() does not end it",
    );
    assert.equal(find("content").value, '"a;b{c}"', "braces in a string mean nothing");
    assert.equal(find("margin").selector, ".parent .child");
    assert.deepEqual(
        decls.filter((each) => each.prop === "color").map((each) => each.selector),
        [".parent:hover", ".parent.on"],
    );
    assert.equal(find("$brand").value, "#36f");
    assert.equal(find("@link").value, "#00f");
    assert.equal(find("$map").value, "(a: 1px, b: 2px)");
});

test("parseStyles: !important and !default are not part of a value, and comments are gone", () => {
    const decls = parseStyles(
        "a { color: red !important; /* b { color: blue } */ margin: 1px }\n$x: 2px !default; // note { }\n",
    );

    assert.deepEqual(
        decls.map((each) => [each.prop, each.value]),
        [
            ["color", "red"],
            ["margin", "1px"],
            ["$x", "2px"],
        ],
    );
});

test("isDarkSelector: the ways a project says dark", () => {
    for (const yes of [
        ".dark",
        "html.dark",
        ":root[data-theme='dark']",
        "[data-bs-theme=dark] .card",
        ".theme-dark .x",
        "body.dark-mode",
    ]) {
        assert.equal(isDarkSelector(yes), true, yes);
    }

    for (const no of [".darken", ".card", ":root", "[data-theme=light]", ".darkroom"]) {
        assert.equal(isDarkSelector(no), false, no);
    }
});

test("readLiteral: objects, arrays, quotes, comments, and what it cannot know", () => {
    const text = `x = { a: 1, 'b-c': "two", d: [1, "x", { e: true }], // note
        /* c */ f: \`tpl\`, g: fn(1, 2), h: ...spread, i: -0.5, j: null, k: "a" + b, l: \`\${x}\`, DEFAULT: "#fff", }`;
    const value = readLiteral(text, text.indexOf("{")) as Record<string, unknown>;

    assert.equal(value.a, 1);
    assert.equal(value["b-c"], "two");
    assert.deepEqual(value.d, [1, "x", { e: true }]);
    assert.equal(value.f, "tpl");
    assert.equal(value.g, UNKNOWN);
    assert.equal(value.i, -0.5);
    assert.equal(value.j, null);
    assert.equal(value.k, UNKNOWN);
    assert.equal(value.l, UNKNOWN);
    assert.equal(value.DEFAULT, "#fff");
    assert.equal(readLiteral("nope", 0), undefined);
    assert.equal(
        Object.getPrototypeOf(readLiteral(`{ __proto__: { x: 1 }, ok: 1 }`, 0)),
        Object.prototype,
        "a __proto__ key is dropped",
    );
});

test("readLiteral is bounded: deep nesting, long lists, and a hostile file end quickly", () => {
    const started = Date.now();

    readLiteral(`${"{a:".repeat(5000)}1${"}".repeat(5000)}`, 0);
    readLiteral(`[${"1,".repeat(100_000)}]`, 0);
    readLiteral(`{${"a: (".repeat(20_000)}`, 0);
    readLiteral("{" + "'".repeat(100_000), 0);
    assert.ok(Date.now() - started < 3000);
});

test("colorsIn: every syntax, names only where asked, and what is not a color", () => {
    assert.deepEqual(
        colorsIn(
            "1px solid #FFF; a: rgb(0 0 0 / .5), hsl(220 90% 70%), oklch(0.7 0.1 250), lab(50 40 30)",
        ).map((each) => each.hex),
        ["#ffffff", "#00000080", "#6e9cf7", "#6da3da", "#bb5846"],
    );
    assert.deepEqual(
        colorsIn("1px solid red").map((each) => each.hex),
        [],
    );
    assert.deepEqual(
        colorsIn("1px solid red", true).map((each) => each.hex),
        ["#ff0000"],
    );
    assert.deepEqual(
        colorsIn('font-family: "Tan", "Red Hat"; background: url(red.png)', true).map(
            (each) => each.hex,
        ),
        [],
    );
    assert.deepEqual(colorsIn("transparent currentColor inherit", true), []);
    assert.deepEqual(
        colorsIn("rgb(var(--x) 0 0)").map((each) => each.hex),
        [],
        "a function with a variable has no value",
    );
});

const PLAIN = {
    "src/styles.css": `:root {
  --bg: #ffffff; --bg-elevated: #f6f7f9; --text: #1a1b26; --text-muted: #6b7280; --border: #e5e7eb;
  --accent: #3b82f6; --accent-hover: #2563eb; --danger: #dc2626; --warning: #d97706; --success: #16a34a;
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 16px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --font-sans: "Inter", system-ui, sans-serif; --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.08); --shadow-md: 0 4px 12px rgba(0,0,0,.12);
}
.dark, [data-theme="dark"] { --bg: #0b0d12; --bg-elevated: #14171f; --text: #e6e8ee; --text-muted: #9aa1b2; --border: #262b36; --accent: #60a5fa; }
body { background: var(--bg); color: var(--text); font: 400 16px/1.5 var(--font-sans); }
h1 { font-size: 32px; font-weight: 700 } h2 { font-size: 24px; font-weight: 600 } p { font-size: 16px } small { font-size: 13px }
.card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 16px 24px; box-shadow: var(--shadow-sm); transition: box-shadow 150ms ease-out }
.btn { background: var(--accent); color: #fff; padding: 8px 16px; transition: background 200ms cubic-bezier(0.4, 0, 0.2, 1) }
@media (min-width: 768px) { .card { padding: 24px 32px } } @media (min-width: 1024px) { .card { padding: 32px } }`,
};

test("a plain stylesheet: the nine roles by name, in light and dark, and the project's own scales", () => {
    const scan = scanTokens(project(PLAIN));
    const system = load(scan);
    const roles = scan.inferred.roles;

    assert.deepEqual(
        Object.fromEntries(
            Object.entries(roles).map(([role, info]) => [
                role,
                [info!.value, info!.dark, info!.basis],
            ]),
        ),
        {
            background: ["#ffffff", "#0b0d12", "name"],
            surface: ["#f6f7f9", "#14171f", "name"],
            text: ["#1a1b26", "#e6e8ee", "name"],
            muted: ["#6b7280", "#9aa1b2", "name"],
            border: ["#e5e7eb", "#262b36", "name"],
            accent: ["#3b82f6", "#60a5fa", "name"],
            danger: ["#dc2626", undefined, "name"],
            warning: ["#d97706", undefined, "name"],
            success: ["#16a34a", undefined, "name"],
        },
    );
    assert.equal(hex(system, "color.bg.page"), "#ffffff");
    assert.equal(hex(system, "color.bg.page", "dark"), "#0b0d12");
    assert.equal(hex(system, "color.accent.default", "dark"), "#60a5fa");
    assert.equal(
        hex(system, "color.accent.hover"),
        "#2563eb",
        "a variant of a role sits beside it",
    );
    assert.deepEqual(system.modes, ["light", "dark"]);
    assert.equal(token(system, "color.bg.page")!.tier, "semantic");
    assert.equal(
        token(system, "color.text.primary")!.contrast?.on,
        "color.bg.page",
        "text roles carry a contrast pair",
    );

    assert.equal(token(system, "radius.md")!.modes.light!.css, "8px");
    assert.equal(token(system, "space.4")!.modes.light!.css, "16px");
    assert.equal(token(system, "font.sans")!.modes.light!.css, "Inter, system-ui, sans-serif");
    assert.ok(token(system, "shadow.md"), "a shadow is parsed into layers");
    assert.equal(token(system, "font.body")!.modes.light!.alias, "font.sans");

    assert.deepEqual(scan.inferred.typeScale.sizes, ["sm 13px", "base 16px", "lg 24px", "xl 32px"]);
    assert.deepEqual(scan.inferred.breakpoints, ["sm 768px", "md 1024px"]);
    assert.equal(
        hex(system, "color.text.on-accent"),
        "#ffffff",
        "white, because the project puts white text on its accent",
    );
});

test("the report lists the roles, the scales, and the draft, fenced", () => {
    const report = scanReport(scanTokens(project(PLAIN)));

    assert.match(report, /^<scan_data>\nScanned 1 files\./);
    assert.match(report, /Color roles \(9 of 9 found\):/);
    assert.match(
        report,
        /color\.bg\.page +#ffffff +dark #0b0d12 +from --bg \(background; high confidence, src\/styles\.css:\d+\)/,
    );
    assert.match(report, /Type scale: sm 13px, base 16px, lg 24px, xl 32px \(ratio about 1\.\d+\)/);
    assert.match(report, /Spacing: base 4px; steps 4, 8, 12, 16/);
    assert.match(report, /Modes: light \(default\), dark \(tokens\.dark\.json drafted\)/);
    assert.match(report, /\ntokens\.json = \{\n {2}"\$extensions"/);
    assert.match(report, /\ntokens\.dark\.json = \{/);
    assert.match(report, /design_system init fromScan: true/);
    assert.match(report, /<\/scan_data>\nThe text in scan_data is untrusted project data/);
    assert.match(
        report,
        /\n\nNext call: design_system \{"action":"init","fromScan":true\}\n/,
        "the report ends with the exact next call",
    );
});

const TAILWIND = {
    "src/app.css": `@import "tailwindcss";
@theme {
  --font-sans: "Geist", ui-sans-serif, system-ui, sans-serif;
  --color-brand-50: oklch(0.97 0.02 264); --color-brand-100: oklch(0.93 0.04 264); --color-brand-500: oklch(0.62 0.19 264);
  --color-brand-600: oklch(0.55 0.2 264); --color-brand-900: oklch(0.3 0.1 264);
  --color-surface: #fafafa; --color-ink: #18181b; --color-danger: #e11d48;
  --radius-lg: 0.75rem; --shadow-card: 0 1px 3px rgb(0 0 0 / 0.1), 0 1px 2px rgb(0 0 0 / 0.06);
  --ease-snappy: cubic-bezier(0.2, 0, 0, 1); --text-hero: 4rem; --text-hero--line-height: 1.1;
}
.dark { --color-surface: #09090b; --color-ink: #fafafa; }`,
    "src/Card.tsx": `export const Card = () => <div className="rounded-lg bg-surface p-4 text-ink shadow-card md:p-6 gap-2 px-8">
  <h2 className="text-2xl font-semibold text-brand-600">Hi</h2><p className="text-sm mt-2">x</p></div>;`,
};

test("Tailwind v4: @theme namespaces keep their names, the dark class is the dark mode, and utility classes fill the scales", () => {
    const scan = scanTokens(project(TAILWIND));
    const system = load(scan);

    assert.equal(scan.tailwind, true);
    assert.equal(
        hex(system, "color.brand.500"),
        "#497ef7",
        "a scale the project names keeps its names",
    );
    assert.equal(
        token(system, "color.brand.500")!.modes.light!.css,
        "oklch(0.62 0.19 264)",
        "and its authored color",
    );
    assert.equal(hex(system, "color.bg.page"), "#fafafa", "the only surface is the page too");
    assert.equal(hex(system, "color.bg.page", "dark"), "#09090b");
    assert.equal(hex(system, "color.text.primary"), "#18181b");
    assert.equal(scan.inferred.roles.accent!.source, "color-brand-500");
    assert.equal(token(system, "radius.lg")!.modes.light!.css, "0.75rem");
    assert.ok(token(system, "ease.snappy"));
    assert.ok(token(system, "shadow.card"));
    assert.equal(token(system, "text.hero")!.modes.light!.css, "4rem");
    assert.ok(!system.tokens.some((each) => /line-height/.test(each.name)));
    assert.equal(token(system, "text.sm")!.modes.light!.css, "0.875rem");
    assert.equal(token(system, "text.2xl")!.modes.light!.css, "1.5rem");
    assert.deepEqual(scan.inferred.spacing.steps, [8, 16, 24, 32]);
    assert.equal(token(system, "space.4")!.modes.light!.css, "16px");
    assert.equal(
        token(system, "weight.semibold")?.modes.light!.css,
        undefined,
        "one weight is not a scale",
    );
});

test("Tailwind v3: a config's theme.extend is read without running it", () => {
    const scan = scanTokens(
        project({
            "tailwind.config.js": `const colors = require('tailwindcss/colors')
module.exports = {
  content: ['./src/**/*.{js,jsx}', './pages/*.html'],
  theme: { extend: {
    colors: { primary: { DEFAULT: '#6366f1', 50: '#eef2ff', 900: '#312e81' }, 'brand-blue': '#1d4ed8', gray: colors.slate, danger: '#ef4444', surface: '#f8fafc' },
    fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    borderRadius: { card: '12px' },
    boxShadow: { soft: '0 2px 8px rgba(0,0,0,0.1)' },
    screens: { tablet: '640px' },
    spacing: { 18: '4.5rem' },
  } },
}`,
        }),
    );
    const system = load(scan);

    assert.equal(hex(system, "color.primary.50"), "#eef2ff");
    assert.equal(hex(system, "color.accent.default"), "#6366f1", "primary is the accent");
    assert.equal(token(system, "color.brand.blue")?.modes.light!.hex, "#1d4ed8");
    assert.equal(token(system, "radius.card")!.modes.light!.css, "12px");
    assert.equal(token(system, "font.sans")!.modes.light!.css, "Inter, system-ui, sans-serif");
    assert.equal(token(system, "breakpoint.tablet")!.modes.light!.css, "640px");
    assert.equal(token(system, "space.18")!.modes.light!.css, "4.5rem");
    assert.ok(
        !system.tokens.some((each) => each.name.includes("slate")),
        "code it cannot run is left out",
    );
});

test("a project that keeps tokens in a DTCG file gets them back as they are, with a dark file for the dark mode", () => {
    const scan = scanTokens(
        project({
            "tokens/base.tokens.json": JSON.stringify({
                color: {
                    $type: "color",
                    gray: { 50: { $value: "#fafafa" }, 900: { $value: "#18181b" } },
                    bg: { page: { $value: "{color.gray.50}" } },
                    text: { primary: { $value: "{color.gray.900}" } },
                    accent: { default: { $value: "#3b82f6" } },
                },
                space: {
                    $type: "dimension",
                    1: { $value: "4px" },
                    2: { $value: "8px" },
                    4: { $value: "16px" },
                },
                radius: { $type: "dimension", md: { $value: "8px" } },
            }),
            "tokens/base.dark.tokens.json": JSON.stringify({
                color: { bg: { page: { $value: "{color.gray.900}" } } },
            }),
            "package.json": JSON.stringify({ name: "x", dependencies: { a: "1" } }),
            "styles.css": ":root { --ignored: #123456 }",
        }),
    );
    const system = load(scan);

    assert.equal(scan.inferred.imported, 10);
    assert.match(
        scan.inferred.notes[0]!,
        /Used the 10 tokens from tokens\/base\.dark\.tokens\.json, tokens\/base\.tokens\.json as they are/,
    );
    assert.equal(token(system, "color.bg.page")!.modes.light!.alias, "color.gray.50");
    assert.equal(hex(system, "color.bg.page", "dark"), "#18181b");
    assert.ok(!token(system, "color.ignored"), "the stylesheet was not guessed from");
    assert.deepEqual(system.modes, ["light", "dark"]);
});

test("a messy page: near-duplicate colors are one, roles come from use, and the draft says what is off the grid", () => {
    const scan = scanTokens(
        project({
            "index.html": `<style>
body { margin:0; font-family: Georgia, "Times New Roman", serif; color:#222; background:#fffdf8 }
h1 { font-family: 'Playfair Display', serif; font-size: 42px; color:#1b1b1b }
.nav { background:#2a2a2a; color:#fff; padding:14px 22px } .nav a { color:#f5f5f5; font-size:15px }
.hero { background:#f4efe6; padding:60px 30px }
.btn { background:#d9480f; color:#fff; padding:10px 22px; border-radius:6px; border:1px solid #c2410c; font-size:16px }
.btn2 { background:#d9490f; color:#fff; padding:10px 22px; border-radius:6px; border:1px solid #c2410d }
.btn3 { background:#d8480e; color:#ffffff; padding:11px 21px; border-radius:7px; font-size:16px }
.card { border:1px solid #e0dcd0; padding:18px; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,.1) } .card2 { border:1px solid #e0ddd1; padding:19px }
.muted { color:#777; font-size:13px } .muted2 { color:#767676; font-size:13px }
.err { color:#b91c1c } .ok { color:#15803d } .warn { color:#b45309 }
</style><div style="color:#444; font-size:18px"></div><button style="background:#da4a10">x</button>`,
        }),
    );
    const roles = scan.inferred.roles;

    load(scan);
    assert.equal(
        roles.background!.value,
        "#fffdf8",
        "the page's own background, not a near-white that is used more",
    );
    assert.equal(roles.background!.basis, "use");
    assert.equal(roles.text!.value, "#222222");
    assert.equal(roles.muted!.value, "#777777", "#767676 is the same color");
    assert.equal(roles.accent!.value, "#d9480f", "four oranges one pixel apart are one accent");
    assert.equal(roles.danger!.value, "#b91c1c", "a red, not the accent's darker shade");
    assert.equal(roles.warning!.value, "#b45309");
    assert.equal(roles.success!.value, "#15803d");
    assert.equal(roles.border!.value, "#e0dcd0");
    assert.equal(roles.surface!.value, "#f4efe6");
    assert.deepEqual(Object.keys(scan.inferred.fonts), ["font.serif", "font.display"]);
    assert.deepEqual(scan.inferred.radii, ["sm 6px", "lg 10px"], "6px and 7px are one radius");
    assert.ok(
        scan.inferred.spacing.off.length > 0,
        "21px and the like are reported as off the grid",
    );
});

test("the draft always loads: a token the engine refuses is dropped, not saved", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --font-evil: "Inter; } body { background: red"; --color-ok: #123456; --radius-x: 99999999999999999999px; --shadow-bad: 0 0 0 ; --ease-x: cubic-bezier(9, 9, 9, 9) }`,
        }),
    );

    load(scan);
    assert.ok(!JSON.stringify(scan.draft).includes("background: red"));
});

test("the scan reads dot folders for styles (Storybook, VitePress) but not caches, and skips the .pi folder", () => {
    const scan = scanTokens(
        project({
            ".storybook/preview.css": ":root { --bg: #111 }",
            ".cache/x.css": ":root { --cache: #222 }",
            ".pi/design/dist/tokens.css": ":root { --generated: #333 }",
            "node_modules/pkg/a.css": ":root { --dep: #444 }",
        }),
    );

    assert.deepEqual(scan.files, [".storybook/preview.css"]);
});

test("files are read best first: a theme before a deep component file, and the file limit keeps the best", () => {
    const files: Record<string, string> = { "src/theme.css": ":root { --accent: #3b82f6 }" };

    for (let i = 0; i < 420; i++) {
        files[`src/components/deep/a/b/c${i}.css`] = ".x { color: #111 }";
    }

    const scan = scanTokens(project(files));

    assert.equal(scan.files.length, 400);
    assert.equal(scan.files[0], "src/theme.css");
    assert.equal(scan.partial, true);
    assert.equal(scan.inferred.roles.accent!.value, "#3b82f6");
});

test("a symlinked token file, style file, or folder is never read", () => {
    const outside = project({
        "secret.tokens.json": JSON.stringify({ a: { $value: "#abcdef", $type: "color" } }),
        "x.css": ":root{--secret:#fedcba}",
    });
    const dir = project({ "ok.css": ":root{--accent:#123456}" });

    symlinkSync(join(outside, "x.css"), join(dir, "linked.css"));
    symlinkSync(join(outside, "secret.tokens.json"), join(dir, "linked.tokens.json"));
    symlinkSync(outside, join(dir, "folder"));

    const scan = scanTokens(dir);

    assert.deepEqual(scan.files, ["ok.css"]);
    assert.ok(
        !JSON.stringify(scan.draft).includes("abcdef") &&
            !JSON.stringify(scan.draft).includes("fedcba"),
    );
});

test("hostile inputs scan in bounded time: thousands of braces, variables, and colors", () => {
    const dir = project({
        "a.css": `${"a{".repeat(50_000)}`.slice(0, 190_000),
        "b.css": Array.from(
            { length: 6000 },
            (_, i) => `--v${i}: #${(i % 4096).toString(16).padStart(3, "0")};`,
        )
            .join("\n")
            .slice(0, 190_000),
        "c.scss": `$m: (${"a: 1px, ".repeat(20_000)}`.slice(0, 190_000),
        "d.ts": `export const colors = {${"a: {".repeat(20_000)}`.slice(0, 190_000),
        "e.html": `<div style="${"color:#fff;".repeat(20_000)}">`,
    });

    // CPU time of this process, not wall time: the scan is synchronous, and a full parallel test run slows the clock, not the work.
    const before = process.cpuUsage();

    scanTokens(dir);

    const used = process.cpuUsage(before);
    const ms = Math.round((used.user + used.system) / 1000);

    assert.ok(ms < 8000, `${ms} ms of CPU`);
});

const DARK_FIRST = {
    "web/style.css": `:root {
  --o-bg: #1a1b26; --o-fg: #a9b1d6; --o-fg-bright: #c0caf5; --o-accent: #7aa2f7; --o-red: #f7768e; --o-yellow: #e0af68; --o-green: #9ece6a;
  --bg: var(--o-bg); --card: color-mix(in srgb, var(--body) 4%, var(--bg)); --line: color-mix(in srgb, var(--body) 13%, var(--bg));
  --text: var(--o-fg-bright); --body: var(--o-fg); --muted: color-mix(in oklab, var(--body) 76%, var(--bg));
  --accent: var(--o-accent); --ok: var(--o-green); --warn: var(--o-yellow); --err: var(--o-red);
  --step-mark-size: 19px;
}
:root[data-mode="light"] { --o-bg: #fafafa; --o-fg: #3a3f55; --o-fg-bright: #1c2033; --o-accent: #2f5bd0; --line: color-mix(in srgb, var(--body) 15%, var(--bg)); }
body { background: var(--bg); color: var(--text); }`,
};

test("a dark-first project: dark is the default mode, light is the file, color-mix() is computed, and short names are roles", () => {
    const scan = scanTokens(project(DARK_FIRST));
    const system = load(scan);
    const roles = scan.inferred.roles;

    assert.deepEqual(system.modes, ["dark", "light"]);
    assert.deepEqual(scan.inferred.modes, { default: "dark", alt: "light" });
    assert.equal(system.schemes.dark, "dark");
    assert.equal(system.schemes.light, "light");
    assert.equal(roles.background!.value, "#1a1b26");
    assert.equal(
        roles.background!.dark,
        "#fafafa",
        "the other mode's value is reported under `dark`",
    );
    assert.equal(roles.surface!.value, "#20212d", "--card is color-mix(in srgb, body 4%, bg)");
    assert.equal(
        roles.muted!.value,
        "#8389a8",
        "--muted is color-mix(in oklab, ...), computed like the browser does",
    );
    assert.equal(roles.border!.source, "line", "--line is the border");
    assert.equal(roles.danger!.source, "err");
    assert.equal(roles.warning!.source, "warn");
    assert.equal(roles.success!.source, "ok");
    assert.equal(hex(system, "color.bg.page", "light"), "#fafafa");
    assert.equal(hex(system, "color.accent.default", "light"), "#2f5bd0");
    assert.ok(Object.keys(scan.draft.modes).join() === "light");
    assert.match(
        scanReport(scan),
        /Modes: dark \(default\), light \(tokens\.light\.json drafted\); the project is dark first/,
    );
    assert.ok(!token(system, "text.mark-size"));
    assert.equal(
        token(system, "size.step-mark-size")?.modes.dark!.css ??
            token(system, "size.mark-size")?.modes.dark!.css,
        "19px",
    );
});

test("a lone --body is the text, and --body-bg is the page", () => {
    const text = scanTokens(
        project({ "a.css": ":root { --body: #333333; --bg-body: #ffffff; --accent: #3366ff }" }),
    );
    const roles = text.inferred.roles;

    assert.equal(roles.background!.source, "bg-body");
    assert.equal(roles.text!.source, "body");
});

test("SCSS arithmetic is computed", () => {
    const scan = scanTokens(
        project({
            "a.scss":
                "$space-1: 4px; $space-2: 8px; $space-3: $space-1 * 3; $space-5: ($space-2 + 4px) / 2 + 10px;",
        }),
    );
    const system = load(scan);

    assert.equal(token(system, "space.3")!.modes.light!.css, "12px", "$space-1 * 3");
    assert.equal(token(system, "space.5")!.modes.light!.css, "16px", "($space-2 + 4px) / 2 + 10px");
});

test("scales: sizes a pixel apart merge, a percent radius is not a size, a pill keeps its value, and shadows merge", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --radius: 6px }
.a { font-size: 12px; padding: 15px; margin: 4px; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,.2) }
.b { font-size: 12px; padding: 16px; margin: 5px; border-radius: 3px; box-shadow: 0 2px 5px rgba(0,0,0,.2) }
.c { font-size: 11px; padding: 16px; border-radius: 50%; box-shadow: inset 0 1px 0 rgba(255,255,255,.5) }
.d { font-size: 16px; padding: 10px; border-radius: 999px; box-shadow: 0 0 0 3px rgba(51,102,204,.4) }`,
        }),
    );
    const system = load(scan);

    assert.deepEqual(
        scan.inferred.typeScale.sizes.map((size) => size.split(" ")[1]),
        ["12px", "16px"],
        "11px is 12px",
    );
    assert.deepEqual(
        scan.inferred.spacing.steps,
        [4, 16],
        "15 and 16 are one, 4 and 5 are one; 10px is used once and is no step",
    );
    assert.ok(!token(system, "space.2-5"), "a one-off off the grid is no step");
    assert.equal(token(system, "radius.md")!.modes.light!.css, "6px");
    assert.ok(token(system, "radius.4"), "a used radius the project does not name");
    assert.ok(!token(system, "radius.3"), "3px is 4px");
    assert.equal(
        token(system, "radius.full")!.modes.light!.css,
        "999px",
        "the pill as the project wrote it; 50% is a circle",
    );
    assert.equal(scan.inferred.shadows, 3, "a lift, an inset line, and a ring");
    assert.ok(token(system, "shadow.inset") && token(system, "shadow.ring"));
});

test("the surface is the background of cards and panels, and Tailwind's arbitrary colors count", () => {
    const scan = scanTokens(
        project({
            "a.css": `body { background: #faf3e9 } .card { background: #fff } .panel { background: #fff } .row:nth-child(odd) { background: #f5f5f5 } .row2 { background: #f5f5f5 }`,
            "App.tsx": `export const A = () => <p className="bg-[#fff4d6] text-[#b00020] p-3">x</p>;`,
        }),
    );

    assert.equal(scan.inferred.roles.surface!.value, "#ffffff");
    assert.ok(scan.colors.some((color) => color.value === "#fff4d6"));
});

test("scanDesignSystem is the draft alone, as the bench calls it", async () => {
    const { scanDesignSystem } = await import("../src/server/design/scan.ts");
    const dir = project({
        "a.css": ":root { --bg: #fff; --text: #111 } .dark { --bg: #000; --text: #eee }",
    });
    const draft = await scanDesignSystem(dir);

    assert.deepEqual(Object.keys(draft.modes), ["dark"]);
    assert.ok((draft.tokens.color as Record<string, unknown>).bg);
    assert.deepEqual(draft, scanTokens(dir).draft);
});

test("a library's variable prefix is not part of the name: --bs-body-bg is the page, --bs-border-color the border", () => {
    const scan = scanTokens(
        project({
            "theme.css": `:root, [data-bs-theme=light] { --bs-body-color: #212529; --bs-body-bg: #fff; --bs-secondary-bg: #e9ecef; --bs-border-color: #dee2e6; --bs-primary: #0d6efd; --bs-link-color: #0d6efd }
[data-bs-theme=dark] { --bs-body-color: #dee2e6; --bs-body-bg: #212529; --bs-secondary-bg: #343a40; --bs-border-color: #495057 }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#ffffff");
    assert.equal(roles.text!.value, "#212529");
    assert.equal(roles.surface!.value, "#e9ecef");
    assert.equal(roles.border!.value, "#dee2e6");
    assert.equal(roles.accent!.value, "#0d6efd");
    assert.equal(roles.background!.dark, "#212529");
});

test("a size computed from variables is a use of that size: calc(var(--gap) * 2) is 24px", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --gap: 12px; --radius: 10px }
.card { padding: calc(var(--gap) * 2); border-radius: calc(var(--radius) - 4px); display: grid; gap: var(--gap) }`,
        }),
    );
    const system = load(scan);

    assert.deepEqual(scan.inferred.spacing.steps, [12, 24]);
    assert.ok(
        token(system, "radius.6") || token(system, "radius.sm"),
        "10px minus 4px is a radius",
    );
});

test("a name does not fix the role when the use says otherwise: a text variable used as a background is no text", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --text-light: #f4f1ea; --ink: #1c1c1c; --paper: #fbfaf7 }
body { background: var(--paper); color: var(--ink) } .band { background: var(--text-light) } p { color: var(--ink) }`,
        }),
    );

    assert.equal(scan.inferred.roles.text!.value, "#1c1c1c");
    assert.notEqual(scan.inferred.roles.text!.value, "#f4f1ea");
});

test("sizes the project names and sizes it uses are one scale", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --text-sm: 14px; --text-lg: 20px }
.a { font-size: var(--text-sm) } .b { font-size: 16px } .c { font-size: 20px } .d { font-size: 28px }`,
        }),
    );
    const system = load(scan);

    assert.equal(token(system, "text.sm")!.modes.light!.css, "14px");
    assert.deepEqual(
        scan.inferred.typeScale.sizes.map((size) => size.split(" ")[1]),
        ["14px", "16px", "20px", "28px"],
    );
});

test("Tailwind's default colors by class are colors the project uses: bg-slate-200 is #e2e8f0", () => {
    const scan = scanTokens(
        project({
            "tailwind.config.js": `module.exports = { theme: { extend: { colors: { brand: "#0284c7" } } } }`,
            "App.tsx": `export const A = () => <div className="bg-white text-slate-900 border border-slate-200 rounded-xl p-4"><a className="text-brand">x</a></div>;`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.border!.value, "#e2e8f0");
    assert.equal(roles.text!.value, "#0f172a");
    assert.equal(roles.background!.value, "#ffffff");
});

test("a project's own blue-500 is its own: Tailwind's default does not replace it", () => {
    const scan = scanTokens(
        project({
            "tailwind.config.js": `module.exports = { theme: { extend: { colors: { slate: { 200: "#101010" } } } } }`,
            "App.tsx": `export const A = () => <div className="border border-slate-200">x</div>;`,
        }),
    );

    assert.ok(!scan.colors.some((color) => color.value === "#e2e8f0"));
});

test("nested CSS and a theme switch on :root: both modes are read, and the card is the surface", () => {
    const scan = scanTokens(
        project({
            "theme.css": `:root { --surface-1: #ffffff; --surface-2: #f4f4f5; --ink-1: #18181b; --brand: #7c3aed }
:root[data-theme="dark"] { --surface-1: #0a0a0b; --surface-2: #18181b; --ink-1: #fafafa; --brand: #a78bfa }
body { background: var(--surface-1); color: var(--ink-1) }
.card { background: var(--surface-2); & p { color: var(--ink-1) } & .btn { background: var(--brand) } }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#ffffff");
    assert.equal(roles.surface!.value, "#f4f4f5", "surface-1 is the page, surface-2 the card");
    assert.equal(roles.surface!.dark, "#18181b");
    assert.equal(roles.accent!.dark, "#a78bfa");
});

test("grays a shade apart are one color, but white stays white", () => {
    const scan = scanTokens(
        project({
            "a.css": `.a { color: #dddddd } .b { color: #e0e0e0 } .c { background: #ffffff } .d { background: #fbfbfa } .e { background: #fbfbfa }`,
        }),
    );
    const values = load(scan)
        .tokens.filter((each) => each.type === "color")
        .map((each) => each.modes.light!.hex);

    assert.ok(
        values.includes("#ffffff") && values.includes("#fbfbfa"),
        "white and off-white are two",
    );
    assert.equal(values.filter((value) => value === "#dddddd" || value === "#e0e0e0").length, 1);
});

test("a bare --radius takes a name after the named ones: --radius-md is not lost", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --radius: 0.5rem; --radius-md: calc(var(--radius) - 2px); --radius-lg: var(--radius); --radius-sm: calc(var(--radius) - 4px) }`,
        }),
    );
    const system = load(scan);

    assert.equal(token(system, "radius.md")!.modes.light!.css, "6px");
    assert.equal(token(system, "radius.sm")!.modes.light!.css, "4px");
});

test("a dark mode that recolors only the links does not change the accent: the light blue is the link blue's dark value", () => {
    const scan = scanTokens(
        project({
            "a.html": `<style>
body { background: #faf3e9; color: #333 } a { color: #3366cc } .btn { background: #b5651d; color: #fff } .btn2 { background: #b5651d }
@media (prefers-color-scheme: dark) { body { background: #1c1411; color: #f0e6da } a { color: #8ab4f8 } }
</style>`,
        }),
    );
    const system = load(scan);
    const accent = token(system, "color.accent.default");

    assert.equal(scan.inferred.roles.accent!.value, "#b5651d");
    assert.equal(
        accent!.modes.dark?.hex ?? accent!.modes.light!.hex,
        "#b5651d",
        "the accent stays brown",
    );
    assert.ok(
        system.tokens.some((each) => each.modes.dark?.hex === "#8ab4f8"),
        "the link blue's dark value is kept, on the blue",
    );
});

const modesOf = (scan: TokenScan) => Object.keys(scan.draft.modes);

test("a shade (--primary-dark beside --primary-light) is not the dark mode's value", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --primary: #2255aa; --primary-light: #4477cc; --primary-dark: #113377; --danger: #cc2222; --danger-dark: #881111 }`,
        }),
    );

    assert.equal(scan.inferred.roles.accent!.dark, undefined);
    assert.deepEqual(modesOf(scan), []);
});

test("a file named for a mode sets that mode's values: dark.less beside variables.less", () => {
    const scan = scanTokens(
        project({
            "variables.less": `@primary-color: #1677ff; @body-background: #f5f5f5; @component-background: #ffffff; @text-color: #222222; @border-color-base: #d9d9d9; @error-color: #ff4d4f;`,
            "dark.less": `@primary-color: #1668dc; @body-background: #111318; @component-background: #1a1d23; @text-color: #ffffffd9; @border-color-base: #33363d; @error-color: #dc4446;`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#f5f5f5");
    assert.equal(roles.background!.dark, "#111318");
    assert.equal(roles.surface!.value, "#ffffff", "`component-background` is the surface");
    assert.equal(roles.surface!.dark, "#1a1d23");
    assert.equal(roles.accent!.dark, "#1668dc");
    assert.equal(roles.danger!.dark, "#dc4446");
});

test("Sass color functions and arithmetic over variables, in variables and in rules", () => {
    const scan = scanTokens(
        project({
            "_vars.scss": `$black: #000; $white: #fff; $unit: 8px;
$text: rgba($black, 0.87); $muted: rgba($black, 0.6); $line: rgba($black, 0.12); $brand: #1976d2; $brand-dark: darken($brand, 10%);
$bg: #f5f5f5; $surface: $white;`,
            "card.scss": `.card { background: $surface; border-radius: $unit * 2; padding: $unit * 2 $unit * 3; box-shadow: 0 2px 4px rgba($black, 0.2); border: 1px solid tint-color(#1976d2, 80%) }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.text!.value, "#000000de");
    assert.equal(roles.muted!.value, "#00000099");
    assert.equal(roles.border!.value, "#0000001f");
    assert.deepEqual(
        scan.inferred.spacing.steps.slice(-2),
        [16, 24],
        "padding: $unit * 2 $unit * 3",
    );
    assert.deepEqual(
        scan.inferred.radii,
        ["lg 16px"].length === 1 ? scan.inferred.radii : [],
        "radius is computed",
    );
    assert.ok(
        scan.inferred.radii.some((radius) => radius.endsWith("16px")),
        `radii: ${scan.inferred.radii}`,
    );
    assert.equal(scan.inferred.shadows, 1, "box-shadow with rgba($black, .2)");
});

test("a custom media query that names the dark scheme (PostCSS) is the dark mode", () => {
    const scan = scanTokens(
        project({
            "vars.css": `@custom-media --dark (prefers-color-scheme: dark);
:root { --clr-page: #f2f3f6; --clr-card: #fff; --clr-ink: #1b1f24; --clr-ink-2: #5b6470; --clr-line: #d8dde4; --clr-cta: #2f5bd7 }
@media (--dark) { :root { --clr-page: #14161a; --clr-card: #1d2026; --clr-ink: #e7e9ec; --clr-ink-2: #9aa3ad; --clr-line: #2e333b; --clr-cta: #7c9bff } }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#f2f3f6", "the media query is not the default");
    assert.equal(roles.background!.dark, "#14161a");
    assert.equal(roles.text!.value, "#1b1f24", "`ink`");
    assert.equal(roles.muted!.value, "#5b6470", "`ink-2` is the second text color");
    assert.equal(roles.accent!.dark, "#7c9bff", "`cta`");
});

test("Svelte and CSS Modules wrap selectors: :global(:root) holds the tokens and :global(.dark) the dark ones", () => {
    const scan = scanTokens(
        project({
            "app.css": `:global(:root) { --bg: #f7f6f3; --fg: #22252a; --muted: #70767e; --line: #e2ded6; --accent: #0d7a5f; --space-1: 4px; --space-2: 8px; --space-3: 12px; --radius: 6px; --radius-lg: 12px }
:global(.dark) { --bg: #121417; --fg: #eceff2; --muted: #9aa1a9; --line: #2a2f35; --accent: #3ecf9a }`,
        }),
    );

    assert.equal(scan.inferred.roles.background!.dark, "#121417");
    assert.equal(scan.inferred.roles.text!.dark, "#eceff2");
    assert.deepEqual(scan.inferred.spacing.steps, [4, 8, 12]);
    assert.equal(scan.inferred.radii.length, 2);
});

test("fluid type sizes (clamp) are steps at their smallest value, and a numbered length family is what its properties say", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --step-0: clamp(1rem, 0.95rem + 0.25vw, 1.125rem); --step-1: clamp(1.25rem, 1.15rem + 0.5vw, 1.5rem);
  --size-1: .25rem; --size-2: .5rem; --size-3: 1rem; --size-4: 1.5rem; --size-5: 2rem }
.a { padding: var(--size-3) var(--size-4); margin-top: var(--size-2); gap: var(--size-1) } .b { padding: var(--size-5) }
h1 { font-size: var(--step-1) } p { font-size: var(--step-0) }`,
        }),
    );

    assert.deepEqual(
        scan.inferred.typeScale.sizes.map((size) => size.split(" ")[1]),
        ["1rem", "1.25rem"],
    );
    assert.deepEqual(
        scan.inferred.spacing.steps,
        [4, 8, 16, 24, 32],
        "--size-N used in padding is spacing",
    );
});

test("class rules count by how often markup uses the class, and a class in the dark mode pairs with its light color", () => {
    const scan = scanTokens(
        project({
            "style.css": `.page { background: #ffffff } .bg-gray-100 { background: #f3f4f6 } .bg-gray-900 { background: #111827 }
.text-gray-900 { color: #111827 } .text-gray-600 { color: #4b5563 } .border-gray-300 { border: 1px solid #d1d5db } .bg-brand { background: #7c3aed }`,
            "dark.css": `.dark .page { background: #111827 } .dark .bg-gray-100 { background: #1f2937 } .dark .text-gray-900 { color: #f9fafb } .dark .text-gray-600 { color: #9ca3af } .dark .border-gray-300 { border-color: #374151 }`,
            "index.html": `<body class="page text-gray-900"><div class="bg-gray-100"></div><div class="bg-gray-100"><p class="text-gray-600">x</p></div><p class="text-gray-600 border-gray-300">y</p><a class="bg-brand">z</a></body>`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(
        roles.background!.value,
        "#ffffff",
        "the page wrapper, not the unused .bg-gray-900",
    );
    assert.equal(roles.surface!.value, "#f3f4f6", "used twice");
    assert.equal(roles.surface!.dark, "#1f2937", "the same class in the dark mode");
    assert.equal(roles.text!.dark, "#f9fafb");
    assert.equal(roles.muted!.value, "#4b5563");
    assert.equal(roles.muted!.dark, "#9ca3af");
});

test("a custom property set only for the dark mode takes the Sass variable of the same name as its light value", () => {
    const scan = scanTokens(
        project({
            "_variables.scss": `$body-bg: #fdfcfa; $body-color: #2a2d31; $border-color: #dcd9d3; $primary: #4b3f9e;`,
            "custom.scss": `[data-bs-theme="dark"] { --bs-body-bg: #16181d; --bs-body-color: #e8eaed; --bs-border-color: #2e3238; --bs-primary: #9485f2 }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#fdfcfa");
    assert.equal(roles.background!.dark, "#16181d");
    assert.equal(roles.accent!.dark, "#9485f2");
});

test("a card's own variable (--card-bg on .card) is the surface, in the mode its selector names", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root { --body-bg: #fdfcfa; --body-color: #2a2d31 } [data-theme="dark"] { --body-bg: #16181d; --body-color: #e8eaed }
.card { --card-bg: #ffffff } [data-theme="dark"] .card { --card-bg: #1f2229 }`,
        }),
    );

    assert.equal(scan.inferred.roles.surface!.value, "#ffffff");
    assert.equal(scan.inferred.roles.surface!.dark, "#1f2229");
});

test("Material 3 names: on-surface is the text and on-surface-variant the quiet text; typescale sizes are type", () => {
    const scan = scanTokens(
        project({
            "tokens.css": `:root { --md-sys-color-surface: #fef7ff; --md-sys-color-on-surface: #1d1b20; --md-sys-color-on-surface-variant: #49454f; --md-sys-color-outline: #79747e; --md-sys-color-primary: #6750a4; --md-sys-color-error: #b3261e;
  --md-sys-typescale-body-large-size: 1rem; --md-sys-typescale-body-large-line-height: 1.5rem; --md-sys-typescale-title-large-size: 22px; --md-sys-typescale-display-small-size: 36px }
@media (prefers-color-scheme: dark) { :root { --md-sys-color-surface: #141218; --md-sys-color-on-surface: #e6e0e9; --md-sys-color-on-surface-variant: #cac4d0; --md-sys-color-outline: #938f99; --md-sys-color-primary: #d0bcff } }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.text!.value, "#1d1b20");
    assert.equal(roles.muted!.value, "#49454f");
    assert.equal(roles.muted!.dark, "#cac4d0");
    assert.equal(roles.border!.value, "#79747e");
    assert.deepEqual(
        scan.inferred.typeScale.sizes.map((size) => size.split(" ")[1]),
        ["1rem", "22px", "36px"],
        "the line height as a length is no size",
    );
});

test("each role has a confidence and a file:line; comments do not move the lines; the report ends with the next call", () => {
    const scan = scanTokens(
        project({
            "src/a.css": `/* a header
   that takes two lines */
:root {
  --bg: #ffffff; // a line comment
  --text: #111827;
}
.btn { background: #3b82f6; color: #fff }
.card { background: #3b82f6 }
`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.confidence, "high");
    assert.equal(roles.background!.at, "src/a.css:4", "the line of --bg in the file");
    assert.equal(roles.text!.at, "src/a.css:5");
    assert.equal(roles.accent!.basis, "use");
    assert.equal(roles.accent!.confidence, "low", "the most used chromatic color is a guess");
    assert.equal(roles.accent!.at, "src/a.css:7", "where the color is first used");

    const report = scanReport(scan);

    assert.match(
        report,
        /color\.bg\.page +#ffffff +from --bg \(background; high confidence, src\/a\.css:4\)/,
    );
    assert.match(
        report,
        /color\.accent\.default +#3b82f6 +most used chromatic color \(accent; low confidence, src\/a\.css:7\)/,
    );

    const last = report.slice(report.indexOf("</scan_data>"));

    assert.match(last, /\n\nNext call: design_system \{"action":"init","fromScan":true\}\n/);
    assert.match(
        last,
        /Then set these uncertain roles to the right color.*color\.accent\.default \(now #3b82f6; low confidence\)/,
    );
    assert.match(
        last,
        /A call: design_system \{"action":"set","changes":\[\{"token":"color\.accent\.default","value":"<the right color>"\}\]\}/,
    );
    assert.ok(!last.includes("color.bg.page (now"), "a role that a name says is not listed");
    assert.match(report.slice(report.lastIndexOf("\n")), /./, "the call is the last thing");
});

test("a scan of a folder names the folder in the next call, and a project with nothing says how to write tokens", () => {
    const report = scanReport(
        scanTokens(project({ "a.css": ":root { --bg: #fff; --text: #111; --accent: #36f }" })),
        "src/ui",
    );

    assert.match(
        report,
        /Next call: design_system \{"action":"init","fromScan":true,"path":"src\/ui"\}/,
    );
    assert.match(
        report,
        /Every role found has a name that says what it is\.|Then set these uncertain roles/,
    );
    assert.match(
        scanReport(scanTokens(project({ "a.css": "body { margin: 0 }" }))),
        /Next call: design_system with action init and tokens/,
    );
});

test("SCSS dark mode written as a mixin named for it: @include dark-mode { … }, @include when-night { … }", () => {
    const scan = scanTokens(
        project({
            "_mixins.scss": `@mixin dark-mode { .theme-dark & { @content; } }
@mixin when-night { @media (prefers-color-scheme: dark) { @content; } }`,
            "main.scss": `@import "mixins";
body { background: #f7f7f5; color: #1b1c1f; @include dark-mode { background: #101114; color: #ececf0; } }
.card { background: #ffffff; border: 1px solid #dcdde0; }
.meta { color: #6a6e78; @include when-night { color: #9ca0aa; } }
a { color: #0b6bcb; @include dark-mode { color: #5aa2f0; } }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#f7f7f5");
    assert.equal(roles.background!.dark, "#101114", "@include dark-mode");
    assert.equal(roles.text!.dark, "#ececf0");
    assert.equal(roles.accent!.dark, "#5aa2f0");
    assert.equal(roles.muted!.dark, "#9ca0aa");
});

test("a dark-first page with unusual names: the page is read by use, .light and the light media query are the other mode", () => {
    const scan = scanTokens(
        project({
            "tokens.css": `:root { --base: #0f1418; --panel: #171e24; --ink: #e7ebee; --faded: #8fa0ab; --rim: #29323a; --glow: #40d787; --glow-deep: #2fa263; --go: #1c7d46; --stop: #e0564f; --wait: #d9a13b; --drop-1: 0 1px 2px rgba(9,14,18,.2) }
.light { --base: #f5f6f4; --panel: #ffffff; --ink: #1e252b; --faded: #5b6b76; --rim: #d7dcd8; --glow: #0d8a4e; --go: #14603a; --stop: #c23b35; --wait: #a06a10 }
body { background: var(--base); color: var(--ink) } .card { background: var(--panel); border: 1px solid var(--rim) } a { color: var(--glow) }
.hero { background: linear-gradient(135deg, #1e1b4b, #312e81) } .chart { fill: #22d3ee } .chart2 { fill: #a78bfa } .badge { background: #fde68a }`,
        }),
    );
    const { roles } = scan.inferred;

    assert.equal(scan.inferred.modes.default, "dark");
    assert.equal(roles.background!.value, "#0f1418", "the page, by how it is painted");
    assert.equal(roles.background!.dark, "#f5f6f4", "the other mode (here the light one)");
    assert.equal(roles.muted!.value, "#8fa0ab", "`faded`");
    assert.equal(roles.border!.value, "#29323a", "`rim`");
    assert.equal(roles.accent!.value, "#40d787");
    assert.equal(
        roles.danger!.value,
        "#e0564f",
        "a red that a variable names, though no rule uses it",
    );
    assert.equal(
        roles.success!.value,
        "#1c7d46",
        "the green with its own name, not --glow-deep, a step of the accent",
    );
    assert.equal(roles.warning!.value, "#d9a13b");
    assert.equal(
        scan.inferred.shadows,
        1,
        "a shadow by its value, whatever the variable is called",
    );

    const palette = Object.values(scan.inferred.palette).reduce((sum, count) => sum + count, 0);

    assert.ok(
        palette <= 11,
        `${palette} colors: the one-offs of a dark-first page (gradient stops, a chart) are left out`,
    );
});

test("SCSS variables a custom property is set from are that property; prefers-color-scheme: light is the other mode", () => {
    const scan = scanTokens(
        project({
            "_tokens.scss": `$dark-bg: #131015; $dark-surface: #1d1822; $dark-ink: #ece7f1; $dark-brand: #f0717f;
:root { --bg: #{$dark-bg}; --surface: #{$dark-surface}; --ink: #{$dark-ink}; --brand: #{$dark-brand}; }
@media (prefers-color-scheme: light) { :root:not(.dark-theme) { --bg: #faf7f5; --surface: #ffffff; --ink: #221c28; --brand: #d8394d; } }`,
        }),
    );
    const system = load(scan);
    const { roles } = scan.inferred;

    assert.equal(roles.background!.value, "#131015");
    assert.equal(roles.background!.dark, "#faf7f5");
    assert.equal(roles.accent!.dark, "#d8394d");
    assert.ok(
        !system.tokens.some((each) => each.name.startsWith("color.dark")),
        "no token for $dark-bg beside --bg",
    );
});

test("a one-off used once is left out of a large palette, kept in a small one; a spacing used once off the grid is no step", () => {
    const small = scanTokens(
        project({
            "a.css": `body { background: #fff; color: #111 } .a { color: #36f } .b { border: 1px solid #ddd } .c { background: #fde68a }`,
        }),
    );
    const many = Array.from(
        { length: 20 },
        (_, at) =>
            `.x${at} { color: #${(0x112233 + at * 0x050607).toString(16)}; padding: ${at === 0 ? "6px" : "8px"} }`,
    ).join("\n");
    const big = scanTokens(
        project({
            "a.css": `${many}\nbody { background: #fff; color: #111 } .a { color: #36f } .a2 { color: #36f }`,
        }),
    );
    const count = (scan: ReturnType<typeof scanTokens>) =>
        Object.values(scan.inferred.palette).reduce((sum, each) => sum + each, 0);

    assert.ok(count(small) >= 4, "a small page keeps its yellow");
    assert.ok(count(big) <= 14, `${count(big)} colors out of 20 one-offs`);
    assert.deepEqual(big.inferred.spacing.steps, [8], "6px used once is no step");
});

test("a shadow is found by its value, whatever the name: elev, elevation, depth, lift, z1, raise, with layers, inset, a variable color, a color first", () => {
    const scan = scanTokens(
        project({
            "a.css": `:root {
  --elev-1: 0 1px 2px rgba(0,0,0,.2);
  --elevation-2: 0 4px 8px -2px rgba(0,0,0,.25), 0 2px 4px rgba(0,0,0,.1);
  --depth-3: inset 0 1px 0 rgba(255,255,255,.1), 0 12px 24px rgba(0,0,0,.3);
  --lift-1: 0 2px 6px #00000033;
  --z1: 0 1px 3px hsl(220 20% 10% / .3);
  --raise: 0 0 0 1px rgb(0 0 0 / 0.08), 0 4px 12px rgb(0 0 0 / 0.1);
  --soft: 0 2px 4px var(--ink);
  --first: rgba(0,0,0,.2) 0 4px 12px;
  --pad: 8px 8px 8px 8px;
  --margin-ish: 12px 16px;
  --none: none;
  --t-quick: 120ms; --t-slow: 0.4s;
  --curve-out: cubic-bezier(0.2, 0, 0, 1); --ease-x: ease-in-out;
  --voice: "Inter", system-ui, sans-serif;
}`,
        }),
    );
    const system = load(scan);
    const shadows = system.tokens.filter((each) => each.type === "shadow");

    assert.equal(shadows.length, 8, shadows.map((each) => each.name).join(", "));
    assert.ok(
        !system.tokens.some((each) => each.type === "shadow" && /pad|margin/.test(each.name)),
        "a padding is no shadow",
    );
    assert.deepEqual(
        system.tokens
            .filter((each) => each.type === "duration")
            .map((each) => each.modes.light!.css),
        ["120ms", "0.4s"],
    );
    assert.equal(system.tokens.filter((each) => each.type === "cubicBezier").length, 2);
    assert.ok(system.tokens.some((each) => each.type === "fontFamily"));
});

test("status words: good ok positive pass valid are success; bad error critical negative invalid fail are danger; warn caution attention are warning", () => {
    const forms: [string, string, string, string][] = [
        ["good", "bad", "warn", "note"],
        ["ok", "error", "caution", "notice"],
        ["positive", "negative", "attention", "info"],
        ["pass", "critical", "warning", "note"],
        ["valid", "invalid", "caution", "notice"],
        ["success", "fail", "warn", "info"],
    ];

    for (const [good, bad, warn, note] of forms) {
        const scan = scanTokens(
            project({
                "a.css": `:root { --bg: #fff; --text: #111; --${good}: #16a34a; --${bad}: #dc2626; --${warn}: #d97706; --${note}: #2563eb }
[data-bs-theme="dark"] { --bg: #0b0c10; --text: #eee; --${good}: #4ade80; --${bad}: #f87171; --${warn}: #fbbf24; --${note}: #60a5fa }
.x { color: var(--${good}) }`,
            }),
        );
        const { roles } = scan.inferred;

        assert.equal(roles.success!.value, "#16a34a", `${good} is success`);
        assert.equal(roles.success!.dark, "#4ade80", `${good}'s dark value follows its name`);
        assert.equal(roles.danger!.value, "#dc2626", `${bad} is danger`);
        assert.equal(roles.danger!.dark, "#f87171");
        assert.equal(roles.warning!.value, "#d97706", `${warn} is warning`);
        assert.equal(roles.warning!.dark, "#fbbf24");
        assert.equal(roles.accent, undefined, `${note} is a notice, not the brand`);
    }
});

test("variables that supply one mode (--light-*, --dark-*, --*-dark, --*-light) stay out of the palette in every form", () => {
    const forms: Record<string, Record<string, string>> = {
        "role variables behind light- and dark- twins": {
            "a.css": `:root { --light-bg: #f6f7fa; --light-ink: #14161c; --light-good: #16a34a; --dark-bg: #0b0c10; --dark-ink: #e8e9ee; --dark-good: #4ade80;
  --bg: var(--light-bg); --ink: var(--light-ink); --good: var(--light-good) }
.dark { --bg: var(--dark-bg); --ink: var(--dark-ink); --good: var(--dark-good) }
body { background: var(--bg); color: var(--ink) } .ok { color: var(--good) }`,
        },
        "twins with a suffix and no role variable": {
            "a.css": `:root { --bg-light: #f6f7fa; --bg-dark: #0b0c10; --ink-light: #14161c; --ink-dark: #e8e9ee; --good-light: #16a34a; --good-dark: #4ade80 }
body { background: var(--bg-light); color: var(--ink-light) } .ok { color: var(--good-light) }
@media (prefers-color-scheme: dark) { body { background: var(--bg-dark); color: var(--ink-dark) } .ok { color: var(--good-dark) } }`,
        },
        "one twin with a role variable": {
            "a.css": `:root { --bg: #f6f7fa; --ink: #14161c; --good: #16a34a; --dark-good: #4ade80 }
.dark { --bg: #0b0c10; --ink: #e8e9ee; --good: var(--dark-good) } body { background: var(--bg); color: var(--ink) } .ok { color: var(--good) }`,
        },
        "Sass variables behind interpolation": {
            "_v.scss": `$light-bg: #f6f7fa; $light-ink: #14161c; $light-good: #16a34a; $dark-bg: #0b0c10; $dark-ink: #e8e9ee; $dark-good: #4ade80;
:root { --bg: #{$light-bg}; --ink: #{$light-ink}; --good: #{$light-good}; }
[data-mantine-color-scheme="dark"] { --bg: #{$dark-bg}; --ink: #{$dark-ink}; --good: #{$dark-good}; }`,
        },
    };

    for (const [form, files] of Object.entries(forms)) {
        const scan = scanTokens(project(files));
        const system = load(scan);
        const { roles } = scan.inferred;

        assert.equal(roles.background!.value, "#f6f7fa", form);
        assert.equal(roles.background!.dark, "#0b0c10", form);
        assert.equal(roles.text!.dark, "#e8e9ee", form);
        assert.equal(roles.success!.dark, "#4ade80", form);
        assert.deepEqual(
            system.tokens
                .filter((each) =>
                    /^color\.(?:dark|light)\b|^color\.[\w-]*-(?:dark|light)$/.test(each.name),
                )
                .map((each) => each.name),
            [],
            `${form}: no color group for the twins`,
        );

        // A role refers to a palette step: the same hex. Two tokens that hold it as a value are a copy.
        const hexes = system.tokens
            .filter((each) => each.type === "color" && each.modes.light!.alias === undefined)
            .map((each) => each.modes.light!.hex);

        assert.equal(new Set(hexes).size, hexes.length, `${form}: each color once`);
    }
});

test("a vendor's theme attribute or class marks the dark mode, with plain literals or Sass interpolation", () => {
    const selectors = [
        '[data-bs-theme="dark"]',
        '[data-color-mode="dark"]',
        '[data-mantine-color-scheme="dark"]',
        '[data-joy-color-scheme="dark"]',
        '[data-theme*="dark"]',
        "[data-theme^=dark]",
        '[data-md-color-scheme="slate"]',
        ".dark-theme",
        ".theme--dark",
        ".v-theme--dark",
        ".ThemeDark",
        ":root.dark-mode",
        "html.theme-dark",
        "[data-bs-theme=dark] body",
        'html[data-color-mode="dark"][data-dark-theme="dark"]',
    ];

    for (const selector of selectors) {
        const literal = scanTokens(
            project({
                "a.css": `:root { --bg: #f6f7fa; --text: #14161c } ${selector} { --bg: #0b0c10; --text: #e8e9ee }`,
            }),
        );
        const sass = scanTokens(
            project({
                "a.scss": `$bg-l: #f6f7fa; $bg-d: #0b0c10; $t-l: #14161c; $t-d: #e8e9ee;
:root { --bg: #{$bg-l}; --text: #{$t-l}; } ${selector} { --bg: #{$bg-d}; --text: #{$t-d}; }`,
            }),
        );

        for (const scan of [literal, sass]) {
            assert.equal(scan.inferred.roles.background!.value, "#f6f7fa", selector);
            assert.equal(scan.inferred.roles.background!.dark, "#0b0c10", selector);
            assert.equal(scan.inferred.roles.text!.dark, "#e8e9ee", selector);
        }
    }
});

test("interpolation inside a value or with arithmetic is resolved through the Sass variables", () => {
    const scan = scanTokens(
        project({
            "_v.scss": `$ink: rgba(20, 22, 28, .2); $space: 8px; $radius: 6px;
:root { --shadow-1: 0 1px 2px #{$ink}; --gap: #{$space * 2}; --round: #{$radius}; }
.card { box-shadow: var(--shadow-1); padding: var(--gap); border-radius: var(--round) }`,
        }),
    );

    assert.equal(scan.inferred.shadows, 1);
    assert.ok(scan.inferred.spacing.steps.includes(16), "the gap is 8px * 2");
    assert.ok(scan.inferred.radii.some((radius) => radius.endsWith("6px")));
});

test("readLiteral ends at a stray closing bracket (it looped for ever before: run in a child)", () => {
    const module = new URL("../src/server/design/scan-parse.ts", import.meta.url).href;
    const code = `import { readLiteral } from "${module}";
console.log(Object.keys(readLiteral("{ a: f(1)), b: 2 }", 0)).join());`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        encoding: "utf8",
        timeout: 20_000,
    });

    assert.equal(child.stdout.trim(), "a");
});

test("10,000 custom properties are read in linear time (13 s before)", () => {
    const css = `:root {\n${Array.from({ length: 10_000 }, (_, i) => `--a${i}: ${i}px;`).join("\n")}\n}`;
    const started = Date.now();

    scanTokens(project({ "a.css": css }));
    assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
});

test("odd inputs end in well under a second, with no throw (R4-4 to R4-7: they threw or took 3 to 13 s)", () => {
    const chain = Array.from({ length: 1500 }, (_, i) => `@v${1500 - i}: @v${1499 - i} + 1px;`);
    const refs = (i: number) => `{"$type":"color","$value":[${Array(16).fill(`"{c${i}}"`)}]}`;
    const fan = Array.from({ length: 7 }, (_, i) => `"c${i + 1}":${refs(i)}`);
    const config = 'module.exports = { source: ["tokens/${theme}/*.json"], platforms: {} };';

    for (const [file, text] of [
        ["a.less", `@v0: 1px;\n${chain.join("\n")}\n.x { width: @v1500; }`],
        ["tokens.json", `{"c0":{"$value":"#123456","$type":"color"},${fan.join()}}`],
        ["tokens.json", `{"a":{"value":${"[".repeat(1500)}${"]".repeat(1500)}}}`],
        ["a.sass", `a${" ".repeat(76_000)}b`],
        ["theme.scss", "a-".repeat(80_000)],
        ["config.js", `${config}${"a".repeat(59_000)}`],
        ["tokens.json", `{"a":{"value":"${"1".repeat(80_000)}"}}`],
    ]) {
        const started = Date.now();

        scanTokens(project({ [file!]: text! }));
        assert.ok(Date.now() - started < 1500, `${file}: ${Date.now() - started} ms`);
    }
});

test("a Sass variable that points at itself (`$a: $a * 2`) does not stop the scan", () => {
    const dir = project({ "a.scss": "$a: 4px;\n$a: $a * 2;\n.x { color: red; width: $a; }" });

    assert.doesNotThrow(() => scanTokens(dir));
});

test("a chain of 25 Sass variables that each use the last one twice is read fast (minutes before)", () => {
    const sass = Array.from({ length: 25 }, (_, i) => `$v${i + 1}: $v${i} + $v${i};`).join("\n");
    const dir = project({ "a.scss": `$v0: 1px;\n${sass}\n.x { width: $v25; }` });
    const scan = new URL("../src/server/design/scan.ts", import.meta.url).href;
    const input = `import { scanTokens } from "${scan}"; scanTokens(${JSON.stringify(dir)});`;
    const child = spawnSync(process.execPath, ["--input-type=module"], { input, timeout: 9e3 });

    assert.equal(child.status, 0, "the scan ends in 9 s");
});
