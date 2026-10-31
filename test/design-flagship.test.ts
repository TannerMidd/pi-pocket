import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { contrastRatio, parseColor } from "../src/server/design/color.ts";
import type { DesignSystem, ResolvedToken } from "../src/server/design/system-types.ts";
import { loadSystem } from "./design-system-loader.ts";

const EXAMPLE = fileURLToPath(new URL("../docs/examples/design-system/pocket", import.meta.url));

const system = (): DesignSystem => {
    const loaded = loadSystem(EXAMPLE);

    assert.ok(loaded !== undefined, "the flagship loads");

    return loaded;
};

const byName = (tokens: ResolvedToken[]) => new Map(tokens.map((token) => [token.name, token]));

test("the flagship has what a complete system has: tiers, modes, scales, components, guidelines", () => {
    const loaded = system();

    assert.equal(loaded.name, "Pi Pocket");
    assert.deepEqual(loaded.modes, ["light", "dark", "high-contrast"]);
    assert.deepEqual(loaded.problems, [], "no validation error and no warning");

    const types = new Set(loaded.tokens.map((token) => token.type));

    for (const type of [
        "color",
        "dimension",
        "fontFamily",
        "fontWeight",
        "duration",
        "cubicBezier",
        "number",
        "shadow",
        "typography",
        "transition",
    ]) {
        assert.ok(types.has(type as never), `has ${type} tokens`);
    }

    const tiers = new Set(loaded.tokens.map((token) => token.tier));

    assert.deepEqual([...tiers].sort(), ["component", "primitive", "semantic"]);

    const roots = new Set(loaded.tokens.map((token) => token.path[0]));

    for (const group of [
        "color",
        "font",
        "type",
        "space",
        "radius",
        "shadow",
        "motion",
        "breakpoint",
        "z",
    ]) {
        assert.ok(roots.has(group), `has ${group}`);
    }

    assert.ok(loaded.components.length >= 8, `${loaded.components.length} components`);
    assert.ok(loaded.guidelines.length > 1000 && Buffer.byteLength(loaded.guidelines) <= 16_384);

    for (const token of loaded.tokens) {
        for (const mode of loaded.modes) {
            assert.ok(token.modes[mode] !== undefined, `${token.name} has a value in ${mode}`);
        }
    }

    const differing = loaded.tokens.filter(
        (token) => token.modes.dark!.css !== token.modes.light!.css,
    );

    assert.ok(differing.length >= 30, `${differing.length} tokens change in dark`);
    assert.ok(
        differing.every((token) => token.type === "color"),
        "only colors change by mode",
    );
});

test("every component has a template for each state, uses only tokens, and names the tokens it uses", () => {
    const loaded = system();
    const tokens = byName(loaded.tokens);
    const vars = new Map(loaded.tokens.map((token) => [token.cssVar, token]));

    for (const spec of loaded.components) {
        assert.ok(spec.states.length >= 2, `${spec.slug} has states`);
        assert.deepEqual(
            Object.keys(spec.markup),
            spec.states,
            `${spec.slug}: a template for each state`,
        );
        assert.ok(
            spec.description.length > 20 &&
                (spec.usage?.do.length ?? 0) > 0 &&
                (spec.usage?.dont.length ?? 0) > 0,
        );

        const own = new Set([...spec.css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
        const used = [...spec.css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!);

        for (const name of used) {
            assert.ok(own.has(name) || vars.has(name), `${spec.slug}: ${name} is a token`);
        }

        assert.doesNotMatch(
            spec.css,
            /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i,
            `${spec.slug}: no literal color`,
        );
        assert.doesNotMatch(
            spec.css,
            /font-size:\s*\d|border-radius:\s*\d|(padding|margin|gap):\s*\d+px/,
            `${spec.slug}: no literal size`,
        );

        const expected = [...new Set(used.filter((name) => !own.has(name)))]
            .map((name) => vars.get(name)!.name)
            .sort();

        assert.deepEqual([...spec.tokens].sort(), expected, `${spec.slug}: tokens list`);

        for (const name of spec.tokens) {
            assert.ok(tokens.has(name), `${spec.slug}: ${name} exists`);
        }

        for (const state of spec.states) {
            assert.ok(spec.markup[state]!.trim().length > 10, `${spec.slug}/${state} has markup`);
        }
    }
});

test("every contrast pair passes in every mode, and text roles pass on every ground", () => {
    const loaded = system();
    const tokens = byName(loaded.tokens);
    const ratio = (fg: string, bg: string, mode: string) =>
        contrastRatio(
            parseColor(String(tokens.get(fg)!.modes[mode]!.value))!,
            parseColor(String(tokens.get(bg)!.modes[mode]!.value))!,
        );

    // Disabled text is exempt from contrast (WCAG): its pair is declared, and the engine notes it instead of failing it.
    const exempt = loaded.tokens.filter((item) => item.contrast?.exempt !== undefined);

    assert.deepEqual(
        exempt.map((item) => item.name),
        ["color.text.disabled"],
    );
    assert.equal(exempt[0]!.contrast!.exempt, "disabled");

    for (const token of loaded.tokens.filter(
        (item) => item.contrast !== undefined && item.contrast.exempt === undefined,
    )) {
        for (const mode of loaded.modes) {
            const on = token.contrast!.on.replace(/[{}]/g, "");

            assert.ok(
                ratio(token.name, on, mode) >= token.contrast!.min,
                `${token.name} on ${on} in ${mode}`,
            );
        }
    }

    const grounds = ["canvas", "base", "surface", "raised", "sunken"].map(
        (name) => `color.bg.${name}`,
    );
    const readers = [
        "color.text.primary",
        "color.text.secondary",
        "color.text.muted",
        ...["accent", "danger", "warning", "success", "info", "brand", "spark"].map(
            (name) => `color.${name}.default`,
        ),
    ];

    for (const mode of loaded.modes) {
        for (const fg of readers) {
            for (const bg of grounds) {
                const need = mode === "high-contrast" ? 7 : 4.5;

                assert.ok(
                    ratio(fg, bg, mode) >= need,
                    `${fg} on ${bg} in ${mode}: ${ratio(fg, bg, mode).toFixed(2)}`,
                );
            }
        }

        for (const status of ["accent", "danger", "warning", "success", "info"]) {
            assert.ok(
                ratio(`color.${status}.default`, `color.${status}.soft`, mode) >= 4.5,
                `${status} on its wash in ${mode}`,
            );
        }

        for (const bg of ["color.bg.base", "color.bg.surface", "color.bg.raised"]) {
            assert.ok(
                ratio("color.border.strong", bg, mode) >= 3,
                `border.strong on ${bg} in ${mode}`,
            );
            assert.ok(
                ratio("color.border.focus", bg, mode) >= 3,
                `border.focus on ${bg} in ${mode}`,
            );
        }
    }
});

function lightness(hex: unknown): number {
    const color = parseColor(String(hex))!;
    const lin = [color.r, color.g, color.b].map((unit) =>
        unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4,
    );
    const l = Math.cbrt(0.4122214708 * lin[0]! + 0.5363325363 * lin[1]! + 0.0514459929 * lin[2]!);
    const m = Math.cbrt(0.2119034982 * lin[0]! + 0.6806995451 * lin[1]! + 0.1073969566 * lin[2]!);
    const s = Math.cbrt(0.0883024619 * lin[0]! + 0.2817188376 * lin[1]! + 0.6299787005 * lin[2]!);

    return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

test("every numbered color ramp falls in lightness at each step, with regular step numbers", () => {
    const loaded = system();
    const ramps = new Map<string, ResolvedToken[]>();

    for (const token of loaded.tokens.filter(
        (item) => item.tier === "primitive" && item.type === "color",
    )) {
        const [, group, step] = token.path;

        if (token.path.length === 3 && /^\d+$/.test(step!)) {
            ramps.set(group!, [...(ramps.get(group!) ?? []), token]);
        }
    }

    assert.deepEqual([...ramps.keys()].sort(), [
        "blue",
        "cyan",
        "green",
        "magenta",
        "neutral",
        "orange",
        "red",
        "yellow",
    ]);

    for (const [group, steps] of ramps) {
        const sorted = [...steps].sort((a, b) => Number(a.path[2]) - Number(b.path[2]));

        for (let at = 1; at < sorted.length; at++) {
            const before = lightness(sorted[at - 1]!.modes.light!.value);
            const now = lightness(sorted[at]!.modes.light!.value);

            assert.ok(
                now < before,
                `${group}.${sorted[at]!.path[2]} (${now.toFixed(3)}) is darker than ${group}.${sorted[at - 1]!.path[2]} (${before.toFixed(3)})`,
            );
        }

        const numbers = sorted.map((token) => Number(token.path[2]));

        if (group === "neutral") {
            const halves = numbers.filter(
                (n) => n % 100 !== 0 && !(n >= 700 && n % 50 === 0) && n !== 50,
            );

            assert.deepEqual(halves, [150, 550], "the half steps outside the dark end");
            assert.match(
                sorted.find((token) => token.path[2] === "550")!.description ?? "",
                /half step.*on purpose/i,
            );
            assert.match(
                sorted.find((token) => token.path[2] === "750")!.description ?? "",
                /half step.*on purpose/i,
            );
            assert.match(
                sorted.find((token) => token.path[2] === "150")!.description ?? "",
                /half step.*on purpose/i,
            );
        } else {
            assert.deepEqual(
                numbers,
                [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950],
                `${group} has the regular steps`,
            );
        }
    }

    const tokyo = {
        blue: "#7aa2f7",
        red: "#f7768e",
        yellow: "#e0af68",
        orange: "#eb927b",
        green: "#9ece6a",
        cyan: "#449dab",
        magenta: "#ad8ee6",
    };

    for (const [hue, hex] of Object.entries(tokyo)) {
        assert.equal(
            loaded.tokens.find((token) => token.name === `color.${hue}.400`)!.modes.light!.value,
            hex,
        );
    }
});

test("space is the scale, size holds sizes, and the corners are one scale with roles that point at it", () => {
    const loaded = system();
    const names = (root: string) =>
        loaded.tokens
            .filter((token) => token.path[0] === root)
            .map((token) => token.path.slice(1).join("."));

    assert.deepEqual(names("space"), ["0", "1", "2", "3", "4", "5", "6", "8", "10", "12", "16"]);
    assert.deepEqual(names("size"), [
        "control.sm",
        "control.md",
        "control.lg",
        "tap",
        "icon.sm",
        "icon.md",
        "icon.lg",
        "avatar",
    ]);
    assert.deepEqual(names("layout"), ["gap.in", "gap.out"]);
    assert.ok(loaded.tokens.find((token) => token.name === "switch.width")!.tier === "component");
    assert.ok(loaded.tokens.find((token) => token.name === "badge.dot")!.tier === "component");

    const scale = loaded.tokens.filter(
        (token) => token.path[0] === "radius" && token.path[1] === "scale",
    );

    assert.deepEqual(
        scale.map((token) => token.path[2]),
        ["xs", "sm", "md", "lg", "xl", "full"],
    );
    assert.deepEqual(
        scale.map((token) => token.modes.light!.css),
        ["2px", "4px", "6px", "8px", "12px", "999px"],
    );

    const roles = loaded.tokens.filter(
        (token) => token.path[0] === "radius" && token.path[1] !== "scale",
    );

    assert.deepEqual(
        roles.map((token) => token.path[1]),
        ["mark", "tag", "seg", "row", "control", "card", "window", "sheet", "float", "pill"],
    );

    for (const role of roles) {
        assert.ok(
            role.modes.light!.alias?.startsWith("radius.scale."),
            `${role.name} points at a step`,
        );
        assert.equal(role.tier, "semantic");
    }

    for (const [role, note] of [
        ["seg", /app uses 5 px/],
        ["control", /app uses 7 px/],
        ["window", /app uses 10 px/],
    ] as const) {
        assert.match(roles.find((token) => token.path[1] === role)!.description ?? "", note);
    }
});

test("the grounds are different colors in light and dark; where two share a value, the role says why", () => {
    const loaded = system();
    const tokens = byName(loaded.tokens);
    const value = (name: string, mode: string) =>
        tokens.get(`color.bg.${name}`)!.modes[mode]!.value;

    for (const mode of ["light", "dark"]) {
        for (const [first, second] of [
            ["canvas", "selected"],
            ["canvas", "sunken"],
            ["selected", "sunken"],
            ["base", "sunken"],
            ["base", "canvas"],
        ] as const) {
            assert.notEqual(
                value(first, mode),
                value(second, mode),
                `${first} and ${second} in ${mode}`,
            );
        }
    }

    assert.ok(lightness(value("sunken", "light")) < lightness(value("canvas", "light")));
    assert.ok(
        parseColor(String(value("selected", "light")))!.b >
            parseColor(String(value("selected", "light")))!.r,
    );

    assert.match(tokens.get("color.bg.raised")!.description ?? "", /same white as surface/);
    assert.match(tokens.get("color.bg.canvas")!.description ?? "", /high contrast/);
});
