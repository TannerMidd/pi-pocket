import assert from "node:assert/strict";
import { test } from "node:test";
import { findBrowser } from "../src/server/browser/discovery.ts";
import {
    colorCss,
    colorDistance,
    contrastOf,
    dimensionCss,
    familyList,
    formatColor,
    lengthKind,
    tokenSet,
} from "../src/server/design/lint-color.ts";
import { analyze, findingId, mergeFindings, modeFor, reportOf } from "../src/server/design/lint.ts";
import { colorRoleOf } from "../src/server/design/lint.ts";
import type { RawPage } from "../src/server/design/lint-page.ts";
import {
    bundleOf,
    check,
    host,
    ofRule,
    onPid,
    page,
    testSystem,
    token,
} from "./design-lint-fixtures.ts";
import { checkDesign } from "../src/server/design/lint.ts";
import { loadDesignSystem } from "../src/server/design/tokens.ts";
import { join } from "node:path";

const browser = { skip: findBrowser() === undefined, timeout: 120_000 };

test("colors: distance is perceptual, contrast follows WCAG, and values print as CSS", () => {
    assert.equal(colorDistance([122, 162, 247, 1], [122, 162, 247, 1]), 0);
    assert.ok(
        colorDistance([122, 162, 247, 1], [123, 163, 248, 1]) < 1.5,
        "one step is the same color",
    );
    assert.ok(
        colorDistance([122, 162, 247, 1], [226, 74, 74, 1]) > 20,
        "blue and red are far apart",
    );
    assert.ok(colorDistance([0, 0, 0, 1], [0, 0, 0, 0.5]) >= 50, "alpha counts");
    assert.equal(contrastOf([0, 0, 0], [255, 255, 255]), 21);
    assert.equal(contrastOf([255, 255, 255], [255, 255, 255]), 1);
    assert.ok(Math.abs(contrastOf([119, 119, 119], [255, 255, 255]) - 4.48) < 0.01);
    assert.equal(formatColor([122, 162, 247, 1]), "#7aa2f7");
    assert.equal(formatColor([255, 255, 255, 0.1]), "rgb(255 255 255 / 0.1)");
});

test("token values turn into CSS the browser can resolve", () => {
    assert.equal(colorCss("#7aa2f7"), "#7aa2f7");
    assert.equal(colorCss("{color.blue}"), undefined, "an unresolved reference is not a color");
    assert.equal(
        colorCss({ colorSpace: "srgb", components: [0.5, 0.25, 1], alpha: 0.5 }),
        "rgb(128 64 255 / 0.5)",
    );
    assert.equal(
        colorCss({ colorSpace: "oklch", components: [0.7, 0.1, 250] }),
        "oklch(0.7 0.1 250)",
    );
    assert.equal(colorCss({ colorSpace: "hsl", components: [210, 50, 40] }), "hsl(210 50% 40%)");
    assert.equal(
        colorCss({ colorSpace: "display-p3", components: [0.1, 0.2, 0.3] }),
        "color(display-p3 0.1 0.2 0.3)",
    );
    assert.equal(
        colorCss({ colorSpace: "weird", components: [1, 2, 3], hex: "#010203" }),
        "#010203",
    );
    assert.equal(colorCss(42), undefined);
    assert.equal(dimensionCss({ value: 1.5, unit: "rem" }), "1.5rem");
    assert.equal(dimensionCss("16px"), "16px");
    assert.equal(dimensionCss(8), "8px");
    assert.equal(dimensionCss({ value: 1, unit: "px; x" }), undefined);
    assert.equal(dimensionCss("1px}body{"), undefined);
    assert.deepEqual(familyList(`"JetBrains Mono", 'Fira Code', monospace`), [
        "jetbrains mono",
        "fira code",
        "monospace",
    ]);
});

test("a dimension token's scale comes from its name", () => {
    assert.equal(lengthKind(["space", "4"]), "space");
    assert.equal(lengthKind(["spacing", "md"]), "space");
    assert.equal(lengthKind(["radius", "md"]), "radius");
    assert.equal(lengthKind(["radii", "lg"]), "radius");
    assert.equal(lengthKind(["font", "size", "md"]), "font-size");
    assert.equal(lengthKind(["fontSize", "md"]), "font-size");
    assert.equal(lengthKind(["text", "md"]), "font-size");
    assert.equal(lengthKind(["font", "weight", "bold"]), undefined);
    assert.equal(lengthKind(["breakpoint", "md"]), undefined);
});

test("a token set holds one mode of the system, and modes pick by color scheme", () => {
    const system = testSystem();
    const light = tokenSet(system, "light");
    const dark = tokenSet(system, "dark");

    assert.equal(light.colors.find((item) => item.name === "color.bg.page")!.css, "#f6f7fb");
    assert.equal(dark.colors.find((item) => item.name === "color.bg.page")!.css, "#101218");
    assert.deepEqual(
        light.fonts.map((font) => font.families[0]),
        ["system-ui", "jetbrains mono"],
    );
    assert.deepEqual(
        light.lengths.map((item) => `${item.kind}:${item.name}`),
        [
            "font-size:font.size.sm",
            "font-size:font.size.md",
            "font-size:font.size.lg",
            "space:space.2",
            "space:space.3",
            "space:space.4",
            "space:space.6",
            "radius:radius.md",
        ],
    );
    assert.deepEqual(modeFor(system, "light"), { mode: "light", scheme: "light", named: false });
    assert.deepEqual(modeFor(system, "dark"), {
        mode: "dark",
        scheme: "dark",
        theme: "dark",
        named: false,
    });
    assert.deepEqual(modeFor(system, "dark", "light"), {
        mode: "light",
        scheme: "light",
        theme: "light",
        named: true,
    });
    assert.throws(() => modeFor(system, "light", "sepia"), /no mode "sepia"/);
    // A dark default mode: a light scheme shows the light mode (tokens.css's media query), so the check compares with it.
    const night = {
        ...system,
        modes: ["dark", "day"],
        schemes: { dark: "dark", day: "light" },
    } as typeof system;

    assert.deepEqual(modeFor(night, "light"), {
        mode: "day",
        scheme: "light",
        theme: "day",
        named: false,
    });
    assert.deepEqual(modeFor(night, "dark"), { mode: "dark", scheme: "dark", named: false });
    const aliased = token("color.alias", "color", { colorSpace: "srgb", components: [1, 0, 0] });

    aliased.modes.light!.css = "var(--color-red)";
    system.tokens.push(
        aliased,
        token("button.padding", "dimension", "10px", undefined, "component"),
    );
    const next = tokenSet(system, "light");

    assert.equal(next.colors.find((item) => item.name === "color.alias")!.css, "#ff0000");
    assert.equal(
        next.lengths.some((item) => item.name === "button.padding"),
        false,
    );
});

test("analyze: a color near a token is off-system, with the right token to use", () => {
    const empty: RawPage = {
        elements: 3,
        viewport: { width: 390, height: 844 },
        hasViewportMeta: true,
        resolvedColors: [
            [28, 30, 38, 1],
            [90, 95, 115, 1],
            [138, 144, 166, 1],
        ],
        resolvedLengths: [],
        colors: [],
        fonts: [],
        sizes: [],
        contrast: [],
        targets: [],
        images: [],
        headings: [],
        fontFaces: [],
        focus: [],
        pids: [],
    };
    const system = testSystem();
    const set = tokenSet(system, "light");

    // Only three colors are resolved here, in the order of `set.colors`: the page's text, muted, and border colors.
    set.colors = set.colors.filter((item) => /text|border/.test(item.name)).slice(0, 3);
    const el = { selector: "p", pid: "x", rect: { x: 0, y: 0, width: 10, height: 10 } };
    const found = analyze(
        {
            ...empty,
            colors: [
                { rgba: [90, 95, 115, 1], roles: { text: 2 }, count: 2, el },
                { rgba: [107, 113, 128, 1], roles: { text: 1 }, count: 1, el },
                { rgba: [139, 145, 167, 1], roles: { border: 1 }, count: 1, el },
            ],
        },
        set,
    );

    assert.equal(found.length, 1, "an exact color is on the system, and so is one 8-bit step away");
    assert.equal(found[0]!.rule, "off-system-color");
    assert.equal(found[0]!.value, "#6b7180");
    assert.equal(found[0]!.suggestion, "var(--color-text-muted)");
    assert.match(
        found[0]!.message,
        /Set `color: var\(--color-text-muted\)` \(#5a5f73\) instead of #6b7180\./,
    );
});

test("analyze: reports carry counts, and findings merge once", () => {
    const finding = {
        rule: "contrast" as const,
        level: "error" as const,
        selector: "p",
        message: "m",
    };
    const report = reportOf(
        [finding, { ...finding, rule: "image-alt", level: "warning" }],
        { viewport: { width: 1, height: 1 }, colorScheme: "light" },
        9,
        true,
    );

    assert.deepEqual(report.summary, {
        errors: 1,
        warnings: 1,
        elements: 9,
        byRule: { contrast: 1, "image-alt": 1 },
    });
    assert.equal(report.withoutSystem, true);
    assert.equal(mergeFindings([report, report]).length, 2);
});

test(
    "off-system colors, fonts, and sizes: the page's values against the system's",
    browser,
    async () => {
        const report = await check(
            page(
                ".ok{background:var(--color-bg-surface);padding:var(--space-4);margin:0 auto;max-width:300px;border-radius:var(--radius-md);color:var(--color-text-primary)}" +
                    ".pill{border-radius:999px;padding:var(--space-2) var(--space-4);background:var(--color-bg-page)}.round{width:40px;height:40px;border-radius:50%;background:var(--color-accent-default)}",
                `<section class="ok" data-pid="ok-card"><h2 data-pid="ok-title" style="margin:0 0 var(--space-2);font-size:var(--font-size-lg)">Title</h2><p style="margin:0;color:var(--color-text-muted);font-size:var(--font-size-sm)">Body</p><span class="pill">Pill</span><div class="round"></div></section>` +
                    `<p data-pid="off-color" style="margin:0;color:#7ba3f8;background:var(--color-bg-surface)">Close to the accent</p>` +
                    `<p data-pid="off-font" style="margin:0;font-family:Georgia,serif">Serif</p>` +
                    `<p data-pid="off-mono" style="margin:0;font-family:Menlo,monospace">Mono</p>` +
                    `<p data-pid="off-size" style="margin:0;font-size:15px;padding:14px;border-radius:12px;background:var(--color-bg-surface)">Sizes</p>` +
                    `<p data-pid="literal" style="margin:0;color:#5a5f73;padding:16px;font-family:system-ui,sans-serif;background:var(--color-bg-surface)">Hard-coded</p>`,
            ),
        );
        const hard = report.findings.filter((item) => item.pid === "literal");

        assert.deepEqual(hard.map((item) => [item.rule, item.level, item.suggestion]).sort(), [
            ["off-system-color", "warning", "var(--color-text-muted)"],
            ["off-system-font", "warning", "var(--font-body)"],
            ["off-system-size", "warning", "var(--space-4)"],
        ]);
        assert.match(hard[0]!.message, /written as a literal/);

        const color = onPid(report, "off-system-color", "off-color")!;

        assert.equal(color.level, "error");
        assert.equal(color.value, "#7ba3f8");
        assert.equal(
            color.suggestion,
            "var(--color-accent-default)",
            "a role, not the palette's blue.500",
        );
        assert.equal(color.selector, '[data-pid="off-color"]');
        assert.ok(color.rect!.width > 0);
        assert.equal(onPid(report, "off-system-font", "off-font")!.suggestion, "var(--font-body)");
        assert.equal(onPid(report, "off-system-font", "off-mono")!.suggestion, "var(--font-mono)");
        const sizes = ofRule(report, "off-system-size").filter((item) => item.pid === "off-size");

        assert.deepEqual(sizes.map((item) => item.value).sort(), ["12px", "14px", "15px"]);
        assert.equal(
            sizes.find((item) => item.value === "15px")!.suggestion,
            "var(--font-size-sm)",
            "a tie goes to the smaller step",
        );
        assert.equal(sizes.find((item) => item.value === "14px")!.suggestion, "var(--space-3)");
        assert.equal(sizes.find((item) => item.value === "12px")!.suggestion, "var(--radius-md)");
        assert.deepEqual(
            report.findings.filter((item) => item.pid === "ok-card"),
            [],
        );
        assert.equal(report.withoutSystem, false);
        assert.equal(report.colorScheme, "light");
        assert.deepEqual(report.viewport, { width: 390, height: 844 });
    },
);

test(
    "without a system the off-system rules stay quiet and the report says so",
    browser,
    async () => {
        const report = await check(
            page(
                "",
                `<p data-pid="a" style="color:#7ba3f8;font-family:Georgia;font-size:15px;padding:14px">x</p>`,
            ),
            {},
            null,
        );

        assert.equal(report.withoutSystem, true);
        assert.equal(ofRule(report, "off-system-color").length, 0);
        assert.equal(ofRule(report, "off-system-font").length, 0);
        assert.equal(ofRule(report, "off-system-size").length, 0);
    },
);

test("the same value on many elements is one finding with a count", browser, async () => {
    const items = Array.from(
        { length: 5 },
        () => `<p style="margin:0;color:#7ba3f8;background:var(--color-bg-surface)">x</p>`,
    );
    const report = await check(
        page(
            "",
            `<div data-pid="scope">${items.join("")}</div><div data-pid="other"><p style="margin:0;color:#7ba3f8;background:var(--color-bg-surface)">y</p></div>`,
        ),
    );
    const found = ofRule(report, "off-system-color").filter((item) => item.value === "#7ba3f8");

    assert.equal(found.length, 1);
    assert.deepEqual(found[0]!.elements!.map((item) => item.pid).sort(), ["other", "scope"]);
    assert.match(found[0]!.message, /text on 5 elements/);
    assert.match(found[0]!.message, /The same in 1 more place: other\./);
});

test(
    "contrast uses the real background: layers, alpha, opacity, and large text",
    browser,
    async () => {
        const report = await check(
            page(
                ".t{margin:0;padding:8px}",
                `<p class="t" data-pid="low" style="color:#999">Low contrast</p>` +
                    `<p class="t" data-pid="ok-dark" style="color:#1c1e26">Fine</p>` +
                    `<div style="background:#1c1e26"><p class="t" data-pid="ok-parent" style="color:#fff">On dark</p><p class="t" data-pid="low-parent" style="color:#2b2f3a">Dark on dark</p></div>` +
                    // A translucent background mixes with what is below it: white at 10% on dark stays dark.
                    `<div style="background:#1c1e26"><div style="background:rgba(255,255,255,0.1)"><p class="t" data-pid="low-alpha" style="color:#444a5a">Alpha layer</p></div></div>` +
                    // A translucent text color mixes with its background: 40% black on white is light grey.
                    `<p class="t" data-pid="low-text-alpha" style="color:rgba(0,0,0,0.45);background:#fff">Alpha text</p>` +
                    `<div style="opacity:0.4"><p class="t" data-pid="ok-opacity" style="color:#1c1e26;background:#fff">Faded</p></div>` +
                    // Large text needs 3:1 only: #777 on white is 4.48:1 (fails 4.5, passes 3), #aaa is 2.3:1.
                    `<p class="t" data-pid="ok-large" style="font-size:24px;color:#8a8a8a;background:#fff">Large</p><p class="t" data-pid="low-large" style="font-size:24px;color:#aaa;background:#fff">Large low</p>` +
                    `<p class="t" data-pid="low-bold" style="font-size:19px;font-weight:700;color:#a0a0a0;background:#fff">Bold low</p><p class="t" data-pid="ok-bold" style="font-size:19px;font-weight:700;color:#8a8a8a;background:#fff">Bold</p>` +
                    `<button class="t" disabled data-pid="ok-disabled" style="color:#aaa;background:#fff">Off</button>` +
                    `<p class="t" data-pid="ok-hidden" style="color:#fff;visibility:hidden">Hidden</p>` +
                    `<div style="background:linear-gradient(#fff,#eee)"><p class="t" data-pid="ok-gradient" style="color:#bbb">Over gradient</p></div>` +
                    `<div style="position:relative;height:60px;background:#fff"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="position:absolute;inset:0;width:100%;height:60px"><p class="t" data-pid="ok-image" style="position:absolute;margin:0;color:#ccc">Over image</p></div>`,
            ),
            {},
            null,
        );
        const contrast = ofRule(report, "contrast");
        const pids = contrast.map((item) => item.pid).sort();

        assert.deepEqual(pids, [
            "low",
            "low-alpha",
            "low-bold",
            "low-large",
            "low-parent",
            "low-text-alpha",
        ]);
        const low = onPid(report, "contrast", "low")!;

        assert.equal(low.level, "error");
        assert.equal(low.value, "2.66:1");
        assert.match(low.message, /#999999 on #f6f7fb is 2\.66:1; text needs 4\.5:1/);
        assert.match(onPid(report, "contrast", "low-large")!.message, /large text needs 3:1/);
    },
);

test("contrast is judged only where the background is certain", browser, async () => {
    const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    const css =
        ".t{margin:0;padding:8px}" +
        ".night{background:#10141c;color:#e8ecf2;padding:16px}.night .card{background:#fff;color:#1c1e26;padding:16px}" +
        ".scope{--ink:#e8ecf2;--paper:#171c24;background:var(--paper);color:var(--ink)}" +
        ".glass{background:rgba(255,255,255,.08)}" +
        ".hero{position:relative;background:#eee;color:#fff;padding:16px}.hero::before{content:'';position:absolute;inset:0;background:rgba(0,0,0,.6)}.hero>*{position:relative}" +
        ".box{position:relative;height:60px;background:#fff}.box img{position:absolute;inset:0;width:100%;height:60px}" +
        ".btn{border:0;padding:12px;background:#1f5fd6;color:#fff;font:inherit}.ghost{background:transparent;color:#1f5fd6;border:1px solid #1f5fd6}" +
        ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.sr2{position:absolute;clip-path:inset(50%);height:20px}" +
        ".over{position:absolute;left:0;top:0;width:100%;height:40px;background:#000}" +
        "input::placeholder{color:#bbb}";
    const body =
        `<section class="night" data-pid="night"><p class="t" data-pid="ok-on-night">Light on dark</p><p class="t" data-pid="low-on-night" style="color:#2b3140">Dark on dark</p><div class="card"><p class="t" data-pid="ok-card">Card text</p><p class="t" data-pid="low-card" style="color:#ddd">Pale on the card</p></div></section>` +
        `<section class="scope" data-pid="scope"><p class="t" data-pid="ok-scope">Scoped variables</p></section>` +
        `<section class="night"><div class="glass" data-pid="glass"><p class="t" data-pid="ok-glass">Glass over dark</p></div></section>` +
        `<button class="btn" data-pid="ok-btn">Primary</button><button class="btn ghost" data-pid="ok-ghost">Ghost</button>` +
        `<input data-pid="ok-placeholder" placeholder="Email" style="padding:8px">` +
        `<section class="hero" data-pid="hero"><p class="t" data-pid="ok-hero">Over an overlay drawn by ::before</p></section>` +
        `<div class="box" data-pid="box"><img alt="" src="${gif}"><p class="t" data-pid="ok-image" style="position:absolute;margin:0;color:#ccc">Over an image</p></div>` +
        `<div data-pid="grad" style="background:linear-gradient(#fff,#eee)"><p class="t" data-pid="ok-grad" style="color:#ccc">Over a gradient</p></div>` +
        `<div data-pid="blur" style="backdrop-filter:blur(4px);background:rgba(255,255,255,.2)"><p class="t" data-pid="ok-blur" style="color:#fff">Backdrop blur</p></div>` +
        `<div data-pid="blend" style="mix-blend-mode:multiply"><p class="t" data-pid="ok-blend" style="color:#ddd">Blend</p></div>` +
        `<div data-pid="faded" style="opacity:0.5"><p class="t" data-pid="ok-faded" style="color:#1c1e26">Faded parent</p></div>` +
        `<div data-pid="under" style="position:relative;height:40px"><p class="t" data-pid="ok-under" style="margin:0;color:#fff">Under a panel</p><div class="over"></div></div>` +
        `<span class="sr" data-pid="ok-sr">hidden</span><span class="sr2" data-pid="ok-sr2" style="color:#fff">hidden too</span>`;
    const report = await check(page(css, body), { viewport: "desktop" }, null);

    assert.deepEqual(
        ofRule(report, "contrast")
            .map((item) => item.pid)
            .sort(),
        ["low-card", "low-on-night"],
    );
});

test("a suggestion takes a token of the role the color plays", browser, async () => {
    // The system gets a dark ground that is near #1c1e26 but not equal to it.
    const system = testSystem();

    system.tokens.push(token("color.bg.inverse", "color", "#1c2230", "#1c2230"));
    const body =
        `<div data-pid="ground" style="background:#1c1e26;padding:var(--space-4)"><span data-pid="inside" style="color:var(--color-bg-surface)">x</span></div>` +
        `<p data-pid="words" style="margin:0;padding:var(--space-2);color:#1c2230;background:var(--color-bg-surface)">Words</p>`;
    const report = await check(page("", body), {}, system);
    const ground = onPid(report, "off-system-color", "ground")!;
    const words = onPid(report, "off-system-color", "words")!;

    // #1c1e26 is exactly the text color, but it is used as a background: the background token comes first.
    assert.equal(ground.suggestion, "var(--color-bg-inverse)");
    assert.doesNotMatch(ground.message, /is a text token/);
    // #1c2230 is used as text: the text token comes first, though the background token is the exact color.
    assert.equal(words.suggestion, "var(--color-text-primary)");
    const plain = await check(page("", body), {}, testSystem());
    const fallback = onPid(plain, "off-system-color", "ground")!;

    assert.equal(fallback.suggestion, "var(--color-text-primary)");
    assert.match(
        fallback.message,
        /It is a text token, and the system has no background token this close/,
    );
});

test(
    "every suggestion is an edit: the property, the token, its value, and what it replaces",
    browser,
    async () => {
        const report = await check(
            page(
                "",
                `<p data-pid="c" style="margin:0;color:#7ba3f8;background:var(--color-bg-surface)">c</p>` +
                    `<div data-pid="bg" style="margin:0;background:#f5f6fa;padding:var(--space-4)"><span data-pid="in" style="color:var(--color-text-primary)">x</span></div>` +
                    `<p data-pid="f" style="margin:0;font-family:Georgia,serif;font-size:15px;padding:14px;border-radius:12px;background:var(--color-bg-surface)">f</p>` +
                    `<p data-pid="k" style="margin:0;padding:var(--space-2);color:#8a90a6;background:var(--color-bg-surface)">k</p>` +
                    `<h1 data-pid="h1">One</h1><h3 data-pid="h3">Three</h3><img data-pid="im" width="4" height="4" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">` +
                    `<a data-pid="tap" href="#" style="display:inline-block;width:20px;height:20px;background:var(--color-accent-default)"></a>`,
            ),
        );
        const message = (rule: string, pid: string, value?: string) =>
            report.findings.find(
                (item) =>
                    item.rule === rule &&
                    item.pid === pid &&
                    (value === undefined || item.value === value),
            )!.message;

        assert.match(
            message("off-system-color", "c"),
            /Set `color: var\(--color-accent-default\)` \(#3b6cf6\) instead of #7ba3f8\./,
        );
        assert.match(
            message("off-system-color", "bg"),
            /Set `background-color: var\(--color-bg-page\)` \(#f6f7fb\) instead of #f5f6fa\./,
        );
        assert.match(
            message("off-system-font", "f"),
            /Set `font-family: var\(--font-body\)` instead of Georgia, serif\./,
        );
        assert.match(
            message("off-system-size", "f", "15px"),
            /Set `font-size` to var\(--font-size-sm\), 14px, instead of 15px\./,
        );
        assert.match(
            message("off-system-size", "f", "14px"),
            /Set `padding` to var\(--space-3\), 12px, instead of 14px\./,
        );
        assert.match(
            message("off-system-size", "f", "12px"),
            /Set `border-radius` to var\(--radius-md\), 8px, instead of 12px\./,
        );
        assert.match(
            message("contrast", "k"),
            /Set `color: var\(--color-text-muted\)` \([^)]*\) instead of #8a90a6\./,
        );
        assert.match(message("heading-order", "h3"), /Change the tag to <h2>/);
        assert.match(
            message("image-alt", "im"),
            /Add `alt="what it shows"`, or `alt=""` if it is decoration\./,
        );
        assert.match(message("tap-target", "tap"), /Set `min-width: 44px; min-height: 44px`/);
    },
);

test("a token's role comes from the words of its name", () => {
    assert.equal(colorRoleOf("color.text.primary"), "text");
    assert.equal(colorRoleOf("color.accent.on-fill"), "text");
    assert.equal(colorRoleOf("color.bg.surface"), "background");
    assert.equal(colorRoleOf("color.accent.fill"), "background");
    assert.equal(colorRoleOf("color.border.focus"), "border");
    assert.equal(colorRoleOf("color.borderSubtle"), "border");
    assert.equal(colorRoleOf("color.blue.500"), undefined);
    assert.equal(colorRoleOf("color.context.x"), undefined, "words, not letters");
});

test("a finding's id holds the rule, and a hash of the element and the value", () => {
    const one = { rule: "contrast" as const, pid: "title", selector: "h1", value: "2.1:1" };

    assert.match(findingId(one), /^contrast-[0-9a-f]{10}$/);
    assert.equal(
        findingId(one),
        findingId({ ...one, selector: "main > h1" }),
        "the pid is the scope",
    );
    assert.notEqual(findingId(one), findingId({ ...one, value: "2.2:1" }));
    assert.notEqual(findingId(one), findingId({ ...one, pid: "other" }));
    assert.notEqual(findingId(one), findingId({ ...one, rule: "tap-target" }));
    assert.notEqual(
        findingId({ ...one, pid: undefined }),
        findingId({ ...one, pid: undefined, selector: "h2" }),
        "without a pid the selector is the scope",
    );
});

test("ids are stable between runs and schemes, and unique in a report", browser, async () => {
    const content = page(
        "",
        `<p data-pid="a" style="margin:0;color:#7ba3f8;background:var(--color-bg-surface)">a</p><p data-pid="b" style="margin:0;color:#7ba3fa;background:var(--color-bg-surface)">b</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="4" height="4">`,
    );
    const first = await check(content);
    const again = await check(content);
    const dark = await check(content, { colorScheme: "dark" });
    const ids = (report: { findings: { id?: string }[] }) => report.findings.map((item) => item.id);

    assert.deepEqual(ids(first), ids(again));
    assert.equal(new Set(ids(first)).size, first.findings.length);
    assert.ok(
        onPid(first, "off-system-color", "a")!.id !== onPid(first, "off-system-color", "b")!.id,
    );
    assert.ok(ids(first).every((id) => typeof id === "string"));
    // The image has no pid: its id comes from its selector, and the image keeps it in the dark run.
    assert.equal(ofRule(first, "image-alt")[0]!.id, ofRule(dark, "image-alt")[0]!.id);
});

test("a contrast finding names the system color that passes", browser, async () => {
    const report = await check(
        page(
            "",
            `<p data-pid="low" style="margin:0;padding:8px;color:#8a90a6;background:#fff">Muted</p>`,
        ),
    );
    const finding = onPid(report, "contrast", "low")!;

    assert.equal(finding.suggestion, "var(--color-text-muted)");
    assert.match(
        finding.message,
        /Set `color: var\(--color-text-muted\)` \(#5a5f73, 6\.3\d:1\) instead of #8a90a6\./,
    );
});

test("a form field's edge needs 3:1 against what it sits on (a warning)", browser, async () => {
    const report = await check(
        page(
            "input{display:block;box-sizing:border-box;width:200px;height:44px;margin:8px;padding:8px;border:1px solid;font:inherit}",
            `<input data-pid="low-edge" style="border-color:#ddd;background:#fff">` +
                `<input data-pid="ok-edge" style="border-color:#777;background:#fff">` +
                `<input data-pid="ok-bare" style="border:0;background:transparent;box-shadow:none">`,
        ),
        {},
        null,
    );
    const finding = onPid(report, "contrast", "low-edge")!;

    assert.equal(finding.level, "warning");
    assert.match(finding.message, /edge of a form field/);
    assert.equal(onPid(report, "contrast", "ok-edge"), undefined);
    assert.equal(onPid(report, "contrast", "ok-bare"), undefined);
});

test("tap targets: under 24 px is an error, under 44 px a warning", browser, async () => {
    const css =
        "a,button{display:inline-block;margin:0;padding:0;color:#1c1e26}" +
        ".gap{margin-right:40px}";
    const body =
        `<div data-pid="crowded"><a href="#" style="width:16px;height:16px;background:#ccc"></a><a href="#" style="width:16px;height:16px;background:#ccc"></a></div>` +
        `<div data-pid="alone" style="margin-top:80px"><a class="gap" href="#" style="width:18px;height:18px;background:#ccc"></a></div>` +
        `<p data-pid="ok-inline" style="margin-top:80px">Read the <a href="#" style="display:inline">full story</a> today.</p>` +
        `<button data-pid="warn" style="margin-top:80px;width:120px;height:36px">Small</button>` +
        `<button data-pid="ok-big" style="margin-top:80px;width:120px;height:48px">Big</button>` +
        `<label data-pid="ok-label" style="display:block;margin-top:80px;height:48px"><input type="checkbox"> Gift</label>` +
        `<input data-pid="bare-checkbox" type="checkbox" style="margin-top:80px;display:block">`;
    const phone = await check(page(css, body), {}, null);
    const crowded = onPid(phone, "tap-target", "crowded")!;

    assert.equal(crowded.level, "error");
    assert.equal(crowded.value, "16×16px");
    assert.match(crowded.message, /\(and 1 more element\)/, "equal targets are one finding");
    assert.equal(onPid(phone, "tap-target", "alone")!.level, "error");
    assert.equal(onPid(phone, "tap-target", "ok-inline"), undefined);
    assert.equal(onPid(phone, "tap-target", "warn")!.level, "warning");
    assert.equal(onPid(phone, "tap-target", "ok-big"), undefined);
    assert.equal(onPid(phone, "tap-target", "ok-label"), undefined);
    assert.equal(
        onPid(phone, "tap-target", "bare-checkbox"),
        undefined,
        "a native checkbox is the browser's",
    );
    const desktop = await check(page(css, body), { viewport: "desktop" }, null);

    assert.equal(onPid(desktop, "tap-target", "warn")!.level, "warning");
    assert.equal(onPid(desktop, "tap-target", "crowded")!.level, "error");
});

test("overflow: a page that scrolls sideways, or hides what does not fit", browser, async () => {
    const wide = await check(
        page("", `<div data-pid="wide" style="width:600px;height:20px;background:#ccc"></div>`),
        {},
        null,
    );
    const finding = ofRule(wide, "overflow")[0]!;

    assert.equal(finding.level, "error");
    assert.equal(finding.pid, "wide");
    assert.match(finding.value!, /^6\d\dpx in 390px$/);
    const fits = await check(
        page(
            "",
            `<div data-pid="scroller" style="width:100%;overflow-x:auto"><div style="width:900px;height:20px;background:#ccc"></div></div><div style="position:fixed;left:0;top:0;width:900px;height:2px;background:#ccc"></div>`,
        ),
        {},
        null,
    );

    assert.equal(
        ofRule(fits, "overflow").length,
        0,
        "a box that scrolls itself, or a fixed bar, is fine",
    );
    const clipped = await check(
        page(
            "body{overflow-x:hidden}",
            `<div data-pid="cut" style="width:600px;height:20px;background:#ccc">Text that is cut off</div><div data-pid="glow" style="position:absolute;left:300px;width:300px;height:20px;background:#ccc"></div>`,
        ),
        {},
        null,
    );

    assert.equal(ofRule(clipped, "overflow")[0]!.level, "warning");
    assert.equal(
        ofRule(clipped, "overflow")[0]!.pid,
        "cut",
        "the text, not the decoration that also runs past the edge",
    );
    assert.match(ofRule(clipped, "overflow")[0]!.message, /cut off/);
    const decoration = await check(
        page(
            "body{overflow-x:hidden}",
            `<div data-pid="glow" style="width:600px;height:20px;background:#ccc"></div>`,
        ),
        {},
        null,
    );

    assert.equal(ofRule(decoration, "overflow").length, 0, "hidden decoration is on purpose");
});

test("images need alt text; headings keep their order", browser, async () => {
    const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    const report = await check(
        page(
            "",
            `<img data-pid="no-alt" src="${gif}" width="10" height="10">` +
                `<img data-pid="ok-alt" src="${gif}" alt="A dot" width="10" height="10">` +
                `<img data-pid="ok-decor" src="${gif}" alt="" width="10" height="10">` +
                `<svg data-pid="no-name" role="img" width="10" height="10"></svg>` +
                `<svg data-pid="ok-name" role="img" aria-label="Logo" width="10" height="10"></svg>` +
                `<h1 data-pid="h1">One</h1><h2 data-pid="h2">Two</h2><h4 data-pid="h4">Four</h4><h3 data-pid="h3">Three</h3><h2 data-pid="h2b">Two again</h2>`,
        ),
        {},
        null,
    );

    assert.deepEqual(
        ofRule(report, "image-alt")
            .map((item) => item.pid)
            .sort(),
        ["no-alt", "no-name"],
    );
    assert.equal(ofRule(report, "image-alt")[0]!.level, "error");
    const jumps = ofRule(report, "heading-order");

    assert.deepEqual(
        jumps.map((item) => [item.pid, item.value]),
        [["h4", "h4 after h2"]],
    );
    assert.equal(jumps[0]!.level, "warning");
});

test(
    "fonts: one that is declared but not loaded is reported, system and installed ones are not",
    browser,
    async () => {
        const missing = await check(
            page(
                "",
                `<p data-pid="gone" style="font-family:'Zzyzx Display',sans-serif">Missing</p>` +
                    `<p data-pid="ok-system" style="font-family:system-ui,sans-serif">System</p>` +
                    `<p data-pid="ok-arial" style="font-family:Arial,sans-serif">Arial</p>` +
                    `<p data-pid="ok-mono" style="font-family:monospace">Mono</p>`,
            ),
            {},
            null,
        );
        const found = ofRule(missing, "font-fallback");

        assert.deepEqual(
            found.map((item) => item.pid),
            ["gone"],
        );
        assert.equal(found[0]!.level, "warning");
        assert.equal(found[0]!.value, "Zzyzx Display");
        const face = (name: string, url: string) =>
            `@font-face{font-family:'${name}';src:url(${url}) format('woff2')}`;
        const loaded = await check(
            page(
                face("Broken Face", "fonts/none.woff2") +
                    face("Real Face", "fonts/real.ttf") +
                    ".a{font-family:'Broken Face',sans-serif}.b{font-family:'Real Face',sans-serif}",
                `<p class="a" data-pid="broken">Broken</p><p class="b" data-pid="ok-real">Real</p>`,
            ),
            {},
            null,
            [{ name: "fonts/real.ttf", type: "font/ttf", bytes: await realFont() }],
        );
        const broken = ofRule(loaded, "font-fallback");

        assert.deepEqual(
            broken.map((item) => item.pid),
            ["broken"],
        );
        assert.equal(broken[0]!.level, "error");
        assert.match(broken[0]!.message, /@font-face did not load/);
    },
);

/** Any real font file on this machine, so a face can load. A skip is not possible here: the test needs one. */
async function realFont(): Promise<Buffer> {
    const { execFileSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const path = execFileSync("fc-match", ["-f", "%{file}", "sans-serif:fontformat=TrueType"])
        .toString()
        .trim();

    return readFileSync(path);
}

test(
    "the viewport meta tag and data-pid are checked (a deck needs no viewport)",
    browser,
    async () => {
        const bare = await check(
            `<!doctype html><title>x</title><h1>Hi</h1><button>Go</button>`,
            {},
            null,
        );
        const viewport = ofRule(bare, "missing-viewport");

        assert.equal(viewport.length, 1);
        assert.equal(viewport[0]!.level, "error");
        assert.equal(viewport[0]!.selector, "");
        const pid = ofRule(bare, "missing-pid");

        assert.equal(pid.length, 1, "one finding names every tag");
        assert.equal(pid[0]!.level, "warning");
        assert.match(pid[0]!.message, /2 elements.*<h1>.*<button>/);
        const tagged = await check(
            page(
                "",
                `<main data-pid="main"><h1 data-pid="h1">Hi</h1><button data-pid="go">Go</button></main>`,
            ),
            {},
            null,
        );
        const parent = await check(
            page("", `<main data-pid="main"><h1>Hi</h1><button>Go</button></main>`),
            {},
            null,
        );

        assert.equal(ofRule(tagged, "missing-pid").length, 0);
        assert.match(
            ofRule(parent, "missing-pid")[0]!.message,
            /2 elements.*<h1>.*<button>/,
            "a control needs a data-pid of its own: a parent's does not name it",
        );
        assert.equal(ofRule(tagged, "missing-viewport").length, 0);
        const deck = await check(
            `<!doctype html><meta name="pocket-kind" content="deck"><section class="slide" data-pid="s1"><h1>Hi</h1></section>`,
            {},
            null,
        );

        assert.equal(ofRule(deck, "missing-viewport").length, 0);
    },
);

test(
    "focus: an element with no visible focus style is reported; rings, shadows, and sibling styles count",
    browser,
    async () => {
        const report = await check(
            page(
                "a,button{display:inline-block;min-height:48px;min-width:48px;margin:8px}" +
                    ".none{outline:none}" +
                    ".ring:focus-visible{outline:2px solid #3b6cf6}" +
                    ".shadow{outline:none}.shadow:focus-visible{box-shadow:0 0 0 3px #3b6cf6}" +
                    ".bg{outline:none}.bg:focus-visible{background:#3b6cf6;color:#fff}" +
                    ".box{display:inline-block;width:24px;height:24px;border:2px solid #777}" +
                    "input.sr,input.sr2{position:absolute;opacity:0;width:24px;height:24px}input.sr2{outline:none}input.sr:focus-visible + .box{outline:2px solid #3b6cf6}",
                `<a class="none" href="#" data-pid="no-focus">None</a>` +
                    `<a class="ring" href="#" data-pid="ok-ring">Ring</a>` +
                    `<button class="shadow" data-pid="ok-shadow">Shadow</button>` +
                    `<button class="bg" data-pid="ok-bg">Fill</button>` +
                    `<a href="#" data-pid="ok-default">Default ring</a>` +
                    `<label data-pid="ok-sibling"><input class="sr" type="checkbox"><span class="box"></span></label>` +
                    `<label data-pid="no-sibling"><input class="sr2" type="radio"><span class="box" style="margin-left:40px"></span></label>`,
            ),
            {},
            null,
        );
        const found = ofRule(report, "focus-visible");

        assert.deepEqual(found.map((item) => item.pid).sort(), ["no-focus", "no-sibling"]);
        assert.equal(found[0]!.level, "warning");
        assert.match(found.find((item) => item.pid === "no-focus")!.message, /outline is removed/);
    },
);

test("a dark color scheme compares with the dark mode of the system", browser, async () => {
    const linked = page("", `<p data-pid="text" style="margin:0;padding:var(--space-2)">Text</p>`);
    const light = await check(linked, { colorScheme: "light" });
    const dark = await check(linked, { colorScheme: "dark" });

    assert.equal(dark.colorScheme, "dark");
    assert.deepEqual(light.findings, []);
    assert.deepEqual(
        dark.findings,
        [],
        "var() follows the mode, so a page of variables is on both",
    );
    const hard = page(
        "",
        `<p data-pid="text" style="margin:0;color:#e6e8f0;background:#101218">Dark text</p>`,
    );
    const inLight = await check(hard, { colorScheme: "light" });
    const inDark = await check(hard, { colorScheme: "dark" });

    assert.equal(onPid(inLight, "off-system-color", "text")!.level, "error");
    assert.equal(onPid(inDark, "off-system-color", "text")!.level, "warning");
    assert.match(onPid(inDark, "off-system-color", "text")!.message, /written as a literal/);
    const forced = await check(hard, { colorScheme: "dark", mode: "light" });

    assert.equal(onPid(forced, "off-system-color", "text")!.level, "error");
    await assert.rejects(check(hard, { mode: "sepia" }), /no mode "sepia"/);
});

test("a page that sets its own data-theme is checked against that mode", browser, async () => {
    // A dark-default system: the light scheme alone would pick the light mode, but the page keeps its dark theme.
    const night = { ...testSystem(), modes: ["dark", "light"] };
    const dark = page("", `<p data-pid="text" style="margin:0;color:#e6e8f0">Dark</p>`);
    const report = await check(dark.replace("<html", '<html data-theme="dark"'), {}, night);

    assert.equal(report.mode, "dark");
    assert.equal(onPid(report, "off-system-color", "text")!.level, "warning");
});

test(
    "tweaks, another page of the bundle, and actions apply before the checks",
    browser,
    async () => {
        const manifest = `<script type="application/json" id="pocket-tweaks">[{"name":"--pad","type":"range","value":16,"unit":"px"}]</script>`;
        const content = page(
            ":root{--pad:16px}a.btn{display:inline-block;padding:var(--pad);color:#1c1e26;background:#fff}a.btn:hover{color:#bbb}",
            `<a class="btn" href="#" data-pid="btn">Go</a><a href="about.html" data-pid="about">About</a>${manifest}`,
        );
        const plain = await check(content);

        assert.equal(onPid(plain, "off-system-size", "btn"), undefined);
        const tweaked = await check(content, { tweaks: { "--pad": 15 } });

        assert.equal(
            onPid(tweaked, "off-system-size", "btn")!.value,
            "15px",
            "a number takes the knob's unit",
        );
        const hovered = await check(content, { actions: [{ type: "hover", selector: "a.btn" }] });

        assert.ok(onPid(hovered, "contrast", "btn"));
        assert.equal(onPid(plain, "contrast", "btn"), undefined);
        const about = bundleOf(content, [
            {
                name: "about.html",
                type: "text/html; charset=utf-8",
                bytes: Buffer.from(
                    page(
                        "",
                        `<p data-pid="about-text" style="margin:0;color:#999;background:#fff">Hi</p>`,
                    ),
                ),
            },
        ]);
        const other = await checkDesign(
            about,
            undefined,
            { viewport: "mobile", page: "about.html" },
            host,
        );

        assert.ok(onPid(other, "contrast", "about-text"));
        assert.equal(onPid(other, "contrast", "btn"), undefined);
    },
);

test("a deck is checked one slide at a time, or all of them", browser, async () => {
    const content =
        `<!doctype html><meta name="pocket-kind" content="deck"><meta name="viewport" content="width=device-width"><style>body{margin:0}.slide{width:1280px;height:720px;background:#fff;padding:16px}</style>` +
        `<section class="slide" data-pid="s1"><p style="margin:0;color:#1c1e26">Fine</p></section>` +
        `<section class="slide" data-pid="s2"><p style="margin:0;color:#ccc">Pale</p></section>`;
    const first = await check(content, { viewport: "desktop" }, null);
    const second = await check(content, { viewport: "desktop", slide: 2 }, null);
    const all = await check(content, { viewport: "desktop", slide: "all" }, null);

    assert.equal(ofRule(first, "contrast").length, 0);
    assert.equal(ofRule(second, "contrast")[0]!.pid, "s2");
    assert.equal(ofRule(all, "contrast")[0]!.pid, "s2");
    assert.equal(
        ofRule(first, "overflow").length,
        0,
        "a deck is scaled, so it has no overflow rule",
    );
});

test("a page cannot change the objects the check uses", browser, async () => {
    const hostile = `<script>
        Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 });
        window.getComputedStyle = () => { throw new Error("tampered"); };
        Element.prototype.querySelectorAll = () => { throw new Error("tampered"); };
        Array.from = () => { throw new Error("tampered"); };
        JSON.stringify = () => "{}";
        CSS.escape = () => "x";
    </script>`;
    const report = await check(
        page(
            "",
            `${hostile}<p data-pid="low" style="margin:0;padding:8px;color:#999;background:#fff">Low</p>`,
        ),
        {},
        null,
    );

    assert.equal(onPid(report, "contrast", "low")!.value, "2.84:1");
    assert.equal(
        onPid(report, "contrast", "low")!.rect!.height > 20,
        true,
        "real geometry, not the page's",
    );
});

test("a page made only of system values has no findings at all", browser, async () => {
    const report = await check(
        page(
            "main{padding:var(--space-4);display:grid;gap:var(--space-2);max-width:420px;margin:0 auto}h1{margin:0;font-size:var(--font-size-lg)}p{margin:0;font-size:var(--font-size-sm);color:var(--color-text-muted)}" +
                "a.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 var(--space-6);border-radius:var(--radius-md);background:var(--color-accent-default);color:var(--color-accent-fg);text-decoration:none}" +
                "a.btn:focus-visible{outline:2px solid var(--color-text-primary);outline-offset:2px}",
            `<main data-pid="main"><h1 data-pid="title">Welcome</h1><p>Small batches, roasted weekly.</p><a class="btn" href="#" data-pid="start">Start</a><img alt="" width="8" height="8" data-pid="dot" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main>`,
        ),
    );

    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.summary.byRule, {});
    assert.ok(report.summary.elements >= 5);
});

test("the page script's answer is untrusted: strings are cut and malformed groups skipped", () => {
    const el = {
        selector: "x".repeat(2000),
        pid: "p".repeat(2000),
        rect: { x: 1, y: 2, width: 3, height: 4 },
    };
    const raw = {
        elements: "many",
        viewport: { width: 1, height: 1 },
        hasViewportMeta: true,
        resolvedColors: [],
        resolvedLengths: [],
        colors: [{ rgba: "red", roles: {}, count: 1, el }],
        fonts: [],
        sizes: [],
        contrast: [{ fg: [0, 0, 0], bg: [1, 1], size: 1, large: false, ui: false, count: "x", el }],
        targets: [{ level: "error", width: "wide", height: 5, tag: "a".repeat(500), count: 1, el }],
        images: [{ tag: "img", why: "w".repeat(500), count: 1, el }],
        headings: [],
        fontFaces: [],
        focus: [],
        pids: [],
    } as unknown as RawPage;
    const found = analyze(raw, tokenSet(testSystem(), "light"));

    assert.equal(found.length, 2);
    assert.ok(found.every((item) => item.selector.length <= 500 && (item.pid?.length ?? 0) <= 200));
    assert.ok(found.every((item) => item.message.length < 400));
    assert.equal(found.find((item) => item.rule === "tap-target")!.value, "0×5px");
});

test(
    "a mode of the system: data-theme, the mode's scheme, and the mode's tokens",
    browser,
    async () => {
        const flagship = loadDesignSystem(
            join(import.meta.dirname, "..", "docs", "examples", "design-system", "pocket"),
        )!;
        const assets = [
            { name: "ds/tokens.css", type: "text/css", bytes: Buffer.from(flagship.compiled.css) },
        ];
        // High-contrast muted text (#b4bee6) on the page's ground: it reads on the high-contrast ground, not on the light one.
        const content = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="ds/tokens.css"><style>body{margin:0;background:var(--color-bg-base)}</style></head><body><p data-pid="quiet" style="margin:0;padding:var(--space-4);color:#b4bee6">Quiet words</p></body></html>`;
        const run = (options: object, system = flagship) =>
            checkDesign(
                bundleOf(content, assets),
                system,
                { viewport: "mobile", ...options },
                host,
            );
        const quiet = (report: Awaited<ReturnType<typeof run>>) =>
            report.findings.find((item) => item.rule === "contrast" && item.pid === "quiet");

        assert.equal(flagship.schemes["high-contrast"], "dark");
        const light = await run({});
        const contrast = await run({ mode: "high-contrast" });

        assert.equal(light.mode, "light", "the report names the mode that it compared with");
        assert.equal(light.colorScheme, "light");
        assert.ok(quiet(light), "pale text on the light ground");
        assert.equal(contrast.mode, "high-contrast");
        assert.equal(contrast.colorScheme, "dark", "the mode's own scheme, not the one asked for");
        assert.equal(quiet(contrast), undefined, "the ground is the high-contrast ground");
        assert.equal(
            (await run({ mode: "high-contrast", colorScheme: "light" })).colorScheme,
            "dark",
        );
        const set = content.replace("<html lang", '<html data-theme="light" lang');
        const forced = await checkDesign(
            bundleOf(set, assets),
            flagship,
            { viewport: "mobile", mode: "high-contrast" },
            host,
        );

        assert.equal(quiet(forced), undefined, "the named mode replaces the page's own data-theme");
        await assert.rejects(
            run({ mode: "sepia" }),
            /no mode "sepia"\. Modes: light, dark, high-contrast\./,
        );
        await assert.rejects(
            checkDesign(
                bundleOf(content, assets),
                undefined,
                { viewport: "mobile", mode: "high-contrast" },
                host,
            ),
            /needs a design system/,
        );
        assert.equal(light.withoutSystem, false);
        assert.equal(
            (await checkDesign(bundleOf(content, assets), undefined, { viewport: "mobile" }, host))
                .mode,
            undefined,
        );
    },
);

test(
    "motion: a long transition or a loop with no prefers-reduced-motion rule is a warning, with the rule in the message",
    browser,
    async () => {
        const slow = ".slow{transition:transform .8s ease}.fast{transition:opacity .2s}";
        const body = `<div class="slow" data-pid="slow">a</div><div class="fast" data-pid="fast">b</div>`;
        const flagged = await check(page(slow, body), {}, null);
        const finding = ofRule(flagged, "reduced-motion");

        assert.equal(finding.length, 1, "one finding for the page");
        assert.equal(finding[0]!.level, "warning");
        assert.equal(finding[0]!.pid, "slow");
        assert.equal(finding[0]!.value, "800ms");
        assert.match(
            finding[0]!.message,
            /1 element use a transition or an animation longer than 500 ms, or one that repeats forever \(the longest is 800 ms\)/,
        );
        assert.match(
            finding[0]!.message,
            /no `@media \(prefers-reduced-motion: reduce\)` rule\. Add `@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ animation-duration: 0\.01ms !important/,
        );
        const quiet = await check(
            page(
                ".a{transition:opacity .5s}.b{transition:none}.c{transition:all 2s;transition-property:none}.d{animation:none}",
                `<div class="a">a</div><div class="b">b</div><div class="c">c</div><div class="d">d</div>`,
            ),
            {},
            null,
        );

        assert.equal(ofRule(quiet, "reduced-motion").length, 0);
        const spin =
            ".spin{animation:turn 1s linear infinite}.once{animation:turn 300ms 1}@keyframes turn{to{transform:rotate(1turn)}}";
        const loop = await check(
            page(spin, `<div class="spin" data-pid="spin">s</div><div class="once">o</div>`),
            {},
            null,
        );

        assert.equal(ofRule(loop, "reduced-motion")[0]!.pid, "spin");

        for (const media of ["reduce", "no-preference"]) {
            const covered = await check(
                page(
                    `${slow}@media (prefers-reduced-motion: ${media}){.slow{transition-duration:.01ms}}`,
                    body,
                ),
                {},
                null,
            );

            assert.equal(ofRule(covered, "reduced-motion").length, 0, media);
        }

        const again = await check(page(slow, body), {}, null);

        assert.equal(ofRule(again, "reduced-motion").length, 1);
    },
);

test(
    "non-text contrast: focus rings and icon-only controls need 3:1, judged only when every color fails",
    browser,
    async () => {
        const css =
            "body{margin:0;background:var(--color-bg-surface)}button{min-height:48px;min-width:48px;margin:8px;padding:0 12px;border:1px solid var(--color-text-primary);background:var(--color-bg-surface);color:var(--color-text-primary);font:inherit}" +
            ".pale:focus-visible{outline:2px solid #dddddd;outline-offset:2px}.good:focus-visible{outline:2px solid var(--color-accent-default);outline-offset:2px}" +
            ".shadow{outline:none}.shadow:focus-visible{box-shadow:0 0 0 3px #e5e5e5}.double{outline:none}.double:focus-visible{box-shadow:0 0 0 2px #fff,0 0 0 4px #1d4ed8}" +
            ".rest{outline:none;box-shadow:0 0 0 1px #e5e5e5}.rest:focus-visible{background:#1d4ed8;color:#fff}" +
            ".dark{background:#10141c;padding:8px}.dark button{background:#10141c;color:#fff}.dark .low:focus-visible{outline:2px solid #1b2230;outline-offset:2px}";
        const icon = (id: string, shapes: string, extra = "") =>
            `<button data-pid="${id}" aria-label="${id}" ${extra}><svg width="20" height="20" viewBox="0 0 20 20">${shapes}</svg></button>`;
        const body =
            `<button class="pale" data-pid="pale">Pale ring</button><button class="good" data-pid="good">Good ring</button>` +
            `<button class="shadow" data-pid="shadow">Pale shadow</button><button class="double" data-pid="double">Double ring</button>` +
            `<button class="rest" data-pid="rest">Ring at rest</button><div class="dark"><button class="low" data-pid="low">Low on dark</button></div>` +
            icon("i-pale", '<path d="M2 2L18 18" stroke="#dddddd" stroke-width="2"/>') +
            icon("i-dark", '<path d="M2 5H18" stroke="#333333" stroke-width="2"/>') +
            icon(
                "i-mixed",
                '<circle cx="10" cy="10" r="9" fill="#eeeeee"/><path d="M5 10H15" stroke="#222222" stroke-width="2"/>',
            ) +
            icon("i-gradient", '<path d="M2 2h16v16H2z" fill="url(#g)"/>') +
            `<button data-pid="i-text" class="x"><svg width="20" height="20"><path d="M2 2L18 18" stroke="#dddddd" stroke-width="2"/></svg> Label</button>`;
        const report = await check(page(css, body), { viewport: "desktop" });
        const found = (pid: string) =>
            report.findings.find((item) => item.rule === "contrast" && item.pid === pid);

        assert.match(
            found("pale")!.message,
            /^The focus ring of a <button> is 1\.3\d:1 against what is around it; WCAG 1\.4\.11 needs 3:1\./,
        );
        assert.equal(found("pale")!.level, "warning");
        assert.match(
            found("pale")!.message,
            /Set `outline-color: var\(--color-[a-z-]+\)` \(#[0-9a-f]{6}, \d\.\d\d:1\) instead of #dddddd\./,
        );
        assert.ok(found("shadow"), "a pale spread shadow is a ring too");
        assert.ok(found("low"), "on a dark ground");
        assert.equal(found("good"), undefined);
        assert.equal(found("double"), undefined, "a double ring passes by its dark ring");
        assert.equal(
            found("rest"),
            undefined,
            "a shadow that is there at rest is not the focus ring",
        );
        assert.match(
            found("i-pale")!.message,
            /^The icon in a <button> is 1\.3\d:1 against what it sits on; WCAG 1\.4\.11 needs 3:1\./,
        );
        assert.equal(found("i-dark"), undefined);
        assert.equal(
            found("i-mixed"),
            undefined,
            "one color of the icon reads: judged by the best",
        );
        assert.equal(found("i-gradient"), undefined, "a paint that cannot be read is not judged");
        assert.equal(
            found("i-text"),
            undefined,
            "a control with a text label is not judged by its icon",
        );
    },
);
