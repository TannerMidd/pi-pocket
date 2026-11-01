import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { systemSummary, writeDesignSystem } from "../src/server/design/tokens.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-ds-summary-"));

    dirs.push(dir);

    return dir;
}

const ROLES = ["page", ...Array.from({ length: 23 }, (_, at) => `tone-${at + 1}`)];
const SLUGS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

function big() {
    const palette: Record<string, unknown> = {};

    for (const hue of ["gray", "blue", "red", "green", "amber", "violet"]) {
        palette[hue] = Object.fromEntries(
            [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((step, at) => [
                step,
                { $value: `#${(0x102030 + at * 0x0a0a0a + hue.length * 0x010101).toString(16)}` },
            ]),
        );
    }

    const roles = Object.fromEntries(
        ROLES.map((role, at) => [
            role,
            {
                $value: `{color.gray.${[50, 100, 200, 300, 400, 500, 600, 700, 800, 900][at % 10]}}`,
                $description: `The ${role} ground of a view, described at some length so that it costs bytes.`,
            },
        ]),
    );
    const parts = Object.fromEntries(
        SLUGS.flatMap((slug) =>
            [
                "bg",
                "edge",
                "ink",
                "hover",
                "active",
                "focus",
                "disabled",
                "label",
                "icon",
                "badge",
            ].map((part) => [`${slug}-${part}`, { $value: "{color.gray.100}" }]),
        ),
    );

    return {
        tokens: {
            $extensions: { "com.pi-pocket": { name: "Big" } },
            color: {
                $type: "color",
                ...palette,
                bg: roles,
                text: {
                    primary: { $value: "{color.gray.900}", $description: "Body text." },
                    muted: { $value: "{color.gray.600}", $description: "Quiet text." },
                },
                border: { default: { $value: "{color.gray.300}" } },
                accent: {
                    default: { $value: "{color.blue.600}" },
                    soft: { $value: "{color.blue.100}" },
                },
                danger: { default: { $value: "{color.red.600}" } },
                parts: { $extensions: { "com.pi-pocket": { tier: "component" } }, ...parts },
            },
            space: Object.fromEntries([
                ["$type", "dimension"],
                ...[0, 1, 2, 3, 4, 5, 6, 8, 10, 12].map((step) => [
                    String(step),
                    { $value: `${step * 4}px` },
                ]),
            ]),
            radius: { $type: "dimension", sm: { $value: "4px" }, md: { $value: "8px" } },
        },
        components: Object.fromEntries(
            SLUGS.map((slug, at) => [
                slug,
                `<script type="application/json" id="pocket-component">
{ "name": "${slug} widget", "description": "The ${slug} part of a view.", "states": ["default"], "tokens": ["color.${at < 4 ? "text.primary" : "bg.page"}", "color.accent.default"] }
</script>
<style>.${slug} { color: var(--color-text-primary); background: var(--color-bg-page) }</style>
<template data-state="default"><div class="${slug}">x</div></template>`,
            ]),
        ),
        guidelines: "# Rules\n- One accent per view.\n- Hairlines, not boxes.\n",
    };
}

test("a cut summary still holds every semantic color role and every component", () => {
    const system = writeDesignSystem(project(), big());
    const roles = system.tokens.filter(
        (token) => token.type === "color" && token.tier === "semantic",
    );
    const full = systemSummary(system, 1_000_000);

    assert.ok(roles.length >= 12, `${roles.length} roles`);
    assert.ok(
        Buffer.byteLength(full) > 7000,
        "the whole summary is larger than the cut that follows",
    );

    for (const max of [3600, 4500, 6000]) {
        const cut = systemSummary(system, max);

        assert.ok(Buffer.byteLength(cut) <= max, `${max}: ${Buffer.byteLength(cut)}`);
        assert.match(cut, /more lines? not shown/, `${max}: cut`);

        for (const role of roles) {
            assert.ok(
                cut.includes(`${role.cssVar} `),
                `${max}: ${role.cssVar} is in the cut summary`,
            );
        }

        for (const slug of SLUGS) {
            assert.ok(cut.includes(`  ${slug}: `), `${max}: component ${slug}`);
        }
    }
});

test("the order is the roles, the components, the scales, the palette, and last the tokens of one component", () => {
    const system = writeDesignSystem(project(), big());
    const text = systemSummary(system, 1_000_000);
    const at = (needle: string) => text.indexOf(needle);

    assert.ok(at("--color-bg-page") > 0);
    assert.ok(at("--color-bg-page") < at("Components ("), "roles before components");
    assert.ok(at("Components (") < at("Scales (raw values)"), "components before scales");
    assert.ok(at("Scales (raw values)") < at("Guidelines"), "scales before the rules");
    assert.ok(at("Guidelines") < at("Palette (raw colors"), "the rules before the palette");
    assert.ok(
        at("Palette (raw colors") < at("Component tokens ("),
        "the palette before component tokens",
    );
    assert.ok(
        at("--color-parts-alpha-bg") > at("Component tokens ("),
        "a component token is listed last",
    );
    assert.ok(!text.includes("--color-gray-50 "), "the palette is collapsed, not listed");
});

test("inside a group, a token that components use comes first; unused tokens keep their order", () => {
    const system = writeDesignSystem(project(), big());
    const text = systemSummary(system, 1_000_000);
    const at = (needle: string) => text.indexOf(needle);

    // text.primary and accent.default are in components; bg.page is in four; the rest are not.
    assert.ok(at("--color-text-primary ") < at("--color-bg-tone-1 "));
    assert.ok(at("--color-accent-default ") < at("--color-bg-tone-1 "));

    assert.ok(at("--color-bg-tone-1 ") < at("--color-bg-tone-2 "), "no use: the declared order");
    assert.ok(at("--color-bg-tone-2 ") < at("--color-bg-tone-3 "), "no use: the declared order");
});

test("a cut drops descriptions from the last token first, not a role", () => {
    const system = writeDesignSystem(project(), big());
    const cut = systemSummary(system, 4000);
    const line = (name: string) => cut.split("\n").find((each) => each.includes(`${name} `)) ?? "";

    assert.match(line("--color-text-primary"), /\/\/ Body text/);
    assert.doesNotMatch(line("--color-bg-tone-23"), /\/\//);
    assert.ok(line("--color-bg-tone-23") !== "", "the role itself is there");
});

test("a system with no components or no roles still summarizes: raw colors are listed when nothing names them", () => {
    const system = writeDesignSystem(project(), {
        tokens: {
            color: {
                $type: "color",
                blue: { 500: { $value: "#3366cc" } },
                red: { 500: { $value: "#cc3333" } },
            },
        },
    });
    const text = systemSummary(system, 4000);

    assert.match(text, /--color-blue-500 #3366cc/);
    assert.doesNotMatch(text, /Palette \(raw colors/);
    assert.doesNotMatch(text, /Components \(/);
});

test("the summary lists each component with its slug, the classes of its root element, and the other classes of its states", () => {
    const dir = project();

    const spec = (markup: string, name: string, extra = "") =>
        `<script type="application/json" id="pocket-component">{"name":"${name}","states":["default","hover"]}</script>
<style>.x{color:var(--color-text-primary)}</style>
<template data-state="default">${markup}</template>
<template data-state="hover">${extra || markup}</template>`;
    const system = writeDesignSystem(dir, {
        tokens: {
            color: { $type: "color", text: { primary: { $value: "#111111" } } },
        },
        components: {
            card: spec(
                '<article class="pk-card" tabindex="0"><h3 class="pk-card__title">T</h3></article>',
                "Card",
                '<article class="pk-card is-hover"><h3 class="pk-card__title">T</h3></article>',
            ),
            "text-field": spec('<label><input class="pk-input" style="x:y"></label>', "Field"),
            hostile: spec(
                '<div class="ok &lt;script&gt; a&quot;b {{x}} good-one">x</div>',
                "Hostile",
            ),
        },
    });
    const text = systemSummary(system, 6000);

    assert.match(
        text,
        /card: Card; root <article class="pk-card">; other classes pk-card__title is-hover; states default, hover/,
    );
    assert.match(
        text,
        /text-field: Field; root <label>; other classes pk-input; states/,
        "a root with no class",
    );
    assert.match(
        text,
        /hostile: Hostile; root <div class="ok good-one">/,
        "only safe class names are shown",
    );
    assert.doesNotMatch(text, /<script|\{\{x\}\}|style=/);
});
