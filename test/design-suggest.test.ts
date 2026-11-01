import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { contrastOf, type RgbaTuple, type TokenSet } from "../src/server/design/lint-color.ts";
import {
    exactColorToken,
    nearestColor,
    nearestPassing,
    sameBytes,
    sameFamily,
} from "../src/server/design/lint-suggest.ts";
import { checkDesign } from "../src/server/design/lint.ts";
import { loadDesignSystem } from "../src/server/design/tokens.ts";
import { bundleOf, host } from "./design-lint-fixtures.ts";

const browser = { skip: findBrowser() === undefined, timeout: 120_000 };
const rgb = (hex: string, alpha = 1): RgbaTuple => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    alpha,
];

function set(...entries: [string, string, "semantic" | "primitive" | "component"][]): TokenSet {
    return {
        mode: "light",
        fonts: [],
        lengths: [],
        colors: entries.map(([name, hex, tier]) => ({
            name,
            cssVar: `--${name.replaceAll(".", "-")}`,
            tier,
            css: hex,
            rgba: rgb(hex),
        })),
    };
}

test("an exact match wins, and among exact matches a role token beats a palette step beats a component's", () => {
    const colors = set(
        ["color.blue.400", "#7aa2f7", "primitive"],
        ["switch.track.off", "#7aa2f7", "component"],
        ["color.text.link", "#7aa2f7", "semantic"],
        ["color.accent.default", "#7aa2f7", "semantic"],
        ["color.text.disabled", "#9097b8", "semantic"],
    );

    assert.equal(
        exactColorToken(colors, rgb("#7aa2f7"), "text")!.name,
        "color.text.link",
        "the role",
    );
    assert.equal(
        exactColorToken(colors, rgb("#7aa2f7"), "background")!.name,
        "color.accent.default",
        "an accent, for a background",
    );
    assert.equal(nearestColor(colors, rgb("#7aa2f7"), "text")!.token.name, "color.text.link");
    assert.equal(nearestColor(colors, rgb("#7aa2f7"), "text")!.exact, true);
    const palette = set(
        ["color.blue.400", "#7aa2f7", "primitive"],
        ["switch.track.off", "#7aa2f7", "component"],
        ["color.text.disabled", "#9097b8", "semantic"],
    );

    assert.equal(nearestColor(palette, rgb("#7aa2f7"), "text")!.token.name, "color.blue.400");
    assert.equal(
        nearestColor(set(["switch.track.off", "#7aa2f7", "component"]), rgb("#7aa2f7"), "text")!
            .token.name,
        "switch.track.off",
    );
    assert.equal(nearestColor(palette, rgb("#7aa2f8"), "text")!.exact, false);
    assert.equal(sameBytes(rgb("#7aa2f7"), rgb("#7aa2f8")), false);
    assert.equal(sameBytes(rgb("#7aa2f7"), rgb("#7aa2f7")), true);
    assert.equal(sameBytes([122, 162, 247, 0.5], [122, 162, 247, 0.9]), false);
});

test("the same color in a token of another role is not offered when a token that fits the use is close", () => {
    const colors = set(
        ["color.text.primary", "#1c1e26", "semantic"],
        ["color.bg.inverse", "#1c2230", "semantic"],
    );

    assert.equal(
        nearestColor(colors, rgb("#1c1e26"), "background")!.token.name,
        "color.bg.inverse",
    );
    assert.equal(nearestColor(colors, rgb("#1c1e26"), "text")!.token.name, "color.text.primary");
    const only = set(["color.text.primary", "#1c1e26", "semantic"]);

    assert.equal(
        nearestColor(only, rgb("#1c1e26"), "background")!.token.name,
        "color.text.primary",
    );
});

test("a suggestion stays in the hue family: a blue is not given a yellow, a grey is not given a teal", () => {
    const colors = set(
        ["color.yellow.900", "#5c4400", "primitive"],
        ["color.info.line", "#90c9d3", "semantic"],
        ["color.neutral.200", "#d0d5e3", "primitive"],
        ["color.neutral.600", "#565f89", "primitive"],
        ["color.neutral.500", "#7882a8", "primitive"],
        ["color.neutral.400", "#9097b8", "primitive"],
        ["color.border.default", "#c0caf5", "semantic"],
    );

    assert.equal(sameFamily(rgb("#cccccc"), rgb("#90c9d3"), 285), false, "a teal for a grey");
    assert.equal(
        sameFamily(rgb("#cccccc"), rgb("#d0d5e3"), 285),
        true,
        "a tinted neutral of the system's own hue",
    );
    assert.equal(sameFamily(rgb("#cccccc"), rgb("#ffffff")), true);
    assert.equal(sameFamily(rgb("#1f5fd6"), rgb("#5c4400")), false, "a yellow for a blue");
    assert.equal(sameFamily(rgb("#1f5fd6"), rgb("#3557a5")), true);
    assert.equal(sameFamily(rgb("#1f5fd6"), rgb("#9097b8")), false, "a grey for a blue");
    // A gray border gets a neutral of the system's hue (a border token if one is near), not the teal that is nearer.
    const border = nearestColor(colors, rgb("#cccccc"), "border")!;

    assert.notEqual(border.token.name, "color.info.line");
    assert.match(border.token.name, /^color\.(neutral\.200|border\.default)$/);
    assert.equal(
        nearestColor(
            set(
                ["color.yellow.900", "#5c4400", "primitive"],
                ["color.info.line", "#90c9d3", "semantic"],
            ),
            rgb("#1f5fd6"),
            "background",
        ),
        undefined,
    );
});

test("a component's token is never suggested for a color that no token equals", () => {
    const colors = set(
        ["switch.track.on", "#2b6ae0", "component"],
        ["color.accent.default", "#3557a5", "semantic"],
    );
    const found = nearestColor(colors, rgb("#2d6be2"), "background")!;

    assert.equal(found.token.name, "color.accent.default");
    assert.equal(found.exact, false);
    assert.equal(
        nearestColor(
            set(["switch.track.on", "#2b6ae0", "component"]),
            rgb("#2d6be2"),
            "background",
        ),
        undefined,
    );
});

test("a failing contrast gets a passing token of its hue; with none, a text token, and it says so", () => {
    const back: [number, number, number] = [244, 245, 249];
    const colors = set(
        ["color.magenta.600", "#7c64a8", "primitive"],
        ["color.yellow.900", "#5c4400", "primitive"],
        ["color.accent.default", "#3557a5", "semantic"],
        ["color.text.primary", "#1a1b26", "semantic"],
        ["switch.track.off", "#4a5a99", "component"],
    );
    const blue = nearestPassing(colors, rgb("#7aa2f7"), back, 4.5, contrastOf)!;

    assert.equal(
        blue.token.name,
        "color.accent.default",
        "the blue that passes, not the magenta, the yellow, or a component's",
    );
    assert.equal(blue.sameHue, true);
    const onBlue = nearestPassing(
        set(
            ["color.yellow.900", "#5c4400", "primitive"],
            ["color.text.primary", "#1a1b26", "semantic"],
            ["color.border.default", "#1c1c1c", "semantic"],
        ),
        rgb("#ffffff"),
        [91, 141, 239],
        4.5,
        contrastOf,
    )!;

    assert.equal(onBlue.token.name, "color.text.primary");
    assert.equal(
        nearestPassing(
            set(["color.yellow.900", "#5c4400", "primitive"]),
            rgb("#7aa2f7"),
            back,
            4.5,
            contrastOf,
        ),
        undefined,
    );
    const hue = nearestPassing(
        set(["color.text.primary", "#1a1b26", "semantic"]),
        rgb("#7aa2f7"),
        back,
        4.5,
        contrastOf,
    )!;

    assert.equal(hue.sameHue, false, "a dark neutral for a blue: the hue changes");
});

test(
    "the judge's three cases, on the flagship: no yellow for text, no teal for a grey border, no wrong 'equals'",
    browser,
    async () => {
        const system = loadDesignSystem(
            join(import.meta.dirname, "..", "docs", "examples", "design-system", "pocket"),
        )!;
        const assets = [
            { name: "ds/tokens.css", type: "text/css", bytes: Buffer.from(system.compiled.css) },
        ];
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="ds/tokens.css"><style>body{margin:0;background:var(--color-bg-base);color:var(--color-text-primary)}</style></head><body><main>
<div data-pid="white" style="background:#5b8def;color:#ffffff;padding:var(--space-4)">White on a light blue</div>
<div data-pid="gray" style="border:1px solid #cccccc;padding:var(--space-4)">Gray border</div>
<p data-pid="blue" style="margin:0;color:#7aa2f7;padding:var(--space-4)">Literal blue 400</p>
<p data-pid="near" style="margin:0;color:#7aa2f8;padding:var(--space-4)">One step off</p>
</main></body></html>`;
        const report = await checkDesign(
            bundleOf(html, assets),
            system,
            { viewport: "desktop" },
            host,
        );
        const find = (rule: string, pid: string, value?: string) =>
            report.findings.find(
                (item) =>
                    item.rule === rule &&
                    item.pid === pid &&
                    (value === undefined || item.value === value),
            )!;

        const white = find("contrast", "white");

        assert.match(white.suggestion!, /^var\(--color-(text-|neutral-)/);
        assert.doesNotMatch(white.suggestion!, /yellow|magenta|info|warning|danger|success/);
        const gray = find("off-system-color", "gray", "#cccccc");

        assert.doesNotMatch(
            gray.suggestion ?? "",
            /info|cyan|teal|yellow|magenta|danger|warning|success/,
        );
        const exact = find("off-system-color", "blue", "#7aa2f7");

        assert.equal(exact.suggestion, "var(--color-blue-400)");
        assert.match(exact.message, /\(#7aa2f7, the same color\)/);
        assert.equal(exact.fix?.token, "color.blue.400");
        const near = find("off-system-color", "near", "#7aa2f8");

        assert.doesNotMatch(near.message, /the same color/);
        assert.match(
            near.message,
            /The closest token is #7aa2f7, which is slightly (darker|lighter|different in hue, at the same lightness)\./,
        );
        assert.equal(near.fix, undefined);

        for (const item of report.findings.filter((each) =>
            each.message.includes("the same color"),
        )) {
            assert.ok(item.suggestion !== undefined);
        }
    },
);
