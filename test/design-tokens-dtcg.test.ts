import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { writeDesignSystem } from "../src/server/design/tokens.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const project = () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-dtcg-"));

    dirs.push(dir);

    return dir;
};

const tokens = (format?: string) => ({
    $extensions: { "com.pi-pocket": { name: "Demo", ...(format === undefined ? {} : { format }) } },
    color: {
        $type: "color",
        base: { $value: { colorSpace: "srgb", components: [0.1, 0.2, 0.4], alpha: 1 } },
        ink: { $value: "#1a1b26" },
        glass: { $value: "rgba(255, 255, 255, 0.5)" },
        wide: { $value: { colorSpace: "display-p3", components: [0.9, 0.2, 0.2] } },
        surface: { $value: "{color.base}" },
    },
    space: {
        $type: "dimension",
        4: { $value: { value: 16, unit: "px" } },
        6: { $value: "1.5rem" },
        em: { $value: "2em" },
    },
    motion: {
        $type: "duration",
        fast: { $value: "150ms" },
        slow: { $value: { value: 0.4, unit: "s" } },
    },
    shadow: {
        md: {
            $type: "shadow",
            $value: [
                { color: "#0004", offsetX: "0px", offsetY: "4px", blur: "8px", spread: "0px" },
            ],
        },
    },
    type: {
        body: {
            $type: "typography",
            $value: {
                fontFamily: ["Inter", "sans-serif"],
                fontSize: "16px",
                fontWeight: 400,
                lineHeight: 1.5,
                letterSpacing: "-0.2px",
            },
        },
    },
    fx: {
        hover: {
            $type: "transition",
            $value: { duration: "150ms", delay: "0ms", timingFunction: [0.2, 0, 0, 1] },
        },
    },
});

const dark = () => ({ color: { base: { $value: "#101216" }, ink: { $value: "#e6e8ee" } } });

function stringForms(node: unknown, found: string[] = []): string[] {
    if (
        typeof node === "string" &&
        /^(#[0-9a-f]{3,8}|-?\d+(\.\d+)?(px|rem|em|ms|s))$/i.test(node)
    ) {
        found.push(node);
    } else if (typeof node === "object" && node !== null) {
        Object.entries(node).forEach(
            ([key, child]) => key !== "$description" && key !== "hex" && stringForms(child, found),
        );
    }

    return found;
}

test("the default is the string forms of the 2021 drafts, whatever form the tokens were written in, and the header says so", () => {
    const { compiled } = writeDesignSystem(project(), {
        tokens: tokens(),
        modes: { dark: dark() },
    });
    const light = JSON.parse(compiled.modes!.light!);

    assert.match(light.$description, /2021 to 2024 drafts' string forms \(the default\)/);
    assert.equal(light.$extensions["com.pi-pocket"].format, "2021");
    assert.equal(light.color.base.$value, "#1a3366", "a color object is written as hex");
    assert.equal(
        light.color.glass.$value,
        "rgba(255, 255, 255, 0.5)",
        "a color text stays as it was written",
    );
    assert.equal(light.space[4].$value, "16px", "a dimension object is written as text");
    assert.equal(light.space[6].$value, "1.5rem");
    assert.equal(light.motion.slow.$value, "0.4s");
    assert.deepEqual(light.shadow.md.$value[0], {
        color: "#0004",
        offsetX: "0px",
        offsetY: "4px",
        blur: "8px",
        spread: "0px",
    });
    assert.equal(light.type.body.$value.fontSize, "16px");
    assert.equal(light.fx.hover.$value.duration, "150ms");
    assert.equal(light.color.surface.$value, "#1a3366", "a reference is followed");
    assert.equal(JSON.parse(compiled.modes!.dark!).color.surface.$value, "#101216");
    assert.equal(stringForms(light).length > 8, true);
});

test('format "2025.10": a color is { colorSpace, components, alpha, hex }, a dimension or duration is { value, unit }, also inside a shadow, a type style, and a transition', () => {
    const { compiled, ...system } = writeDesignSystem(project(), {
        tokens: tokens("2025.10"),
        modes: { dark: dark() },
    });
    const light = JSON.parse(compiled.modes!.light!);

    assert.equal(system.dtcgFormat, "2025.10");
    assert.match(light.$description, /DTCG draft 2025\.10/);
    assert.equal(light.$extensions["com.pi-pocket"].format, "2025.10");
    assert.deepEqual(light.color.base.$value, {
        colorSpace: "srgb",
        components: [0.1, 0.2, 0.4],
        alpha: 1,
        hex: "#1a3366",
    });
    assert.deepEqual(light.color.ink.$value, {
        colorSpace: "srgb",
        components: [0.102, 0.1059, 0.149],
        alpha: 1,
        hex: "#1a1b26",
    });
    assert.deepEqual(light.color.glass.$value, {
        colorSpace: "srgb",
        components: [1, 1, 1],
        alpha: 0.5,
        hex: "#ffffff",
    });
    assert.equal(light.color.wide.$value.colorSpace, "display-p3", "another space keeps its space");
    assert.match(light.color.wide.$value.hex, /^#[0-9a-f]{6}$/);
    assert.deepEqual(
        light.color.surface.$value,
        light.color.base.$value,
        "a reference is followed",
    );
    assert.deepEqual(light.space[4].$value, { value: 16, unit: "px" });
    assert.deepEqual(light.space[6].$value, { value: 1.5, unit: "rem" });
    assert.equal(light.space.em.$value, "2em", "a unit that 2025.10 does not have stays as text");
    assert.deepEqual(light.motion.fast.$value, { value: 150, unit: "ms" });
    assert.deepEqual(light.motion.slow.$value, { value: 0.4, unit: "s" });
    assert.deepEqual(light.shadow.md.$value[0].offsetY, { value: 4, unit: "px" });
    assert.equal(light.shadow.md.$value[0].color.colorSpace, "srgb");
    assert.deepEqual(light.type.body.$value.fontSize, { value: 16, unit: "px" });
    assert.deepEqual(light.type.body.$value.letterSpacing, { value: -0.2, unit: "px" });
    assert.equal(light.type.body.$value.lineHeight, 1.5, "a line height is a number");
    assert.deepEqual(light.fx.hover.$value.duration, { value: 150, unit: "ms" });
    assert.deepEqual(light.fx.hover.$value.timingFunction, [0.2, 0, 0, 1]);

    const darkFile = JSON.parse(compiled.modes!.dark!);

    assert.equal(darkFile.color.surface.$value.hex, "#101216");
    assert.deepEqual(
        stringForms(light),
        ["2em"],
        "no string form is left but the unit that has no object",
    );
});

test("the other files do not change with the format: tokens.css, tailwind.css, the compact summary", () => {
    const a = writeDesignSystem(project(), { tokens: tokens() }).compiled;
    const b = writeDesignSystem(project(), { tokens: tokens("2025.10") }).compiled;

    assert.equal(a.css, b.css.replace(/2025\.10/g, "2021"));
    assert.equal(a.tailwind, b.tailwind);
    assert.equal(a.json, b.json);
    assert.equal(a.studio, b.studio, "Tokens Studio reads the string forms");
});

test("an unknown format is a warning, and the default is used", () => {
    const system = writeDesignSystem(project(), { tokens: tokens("3000") });

    assert.equal(system.dtcgFormat, undefined);
    assert.ok(
        system.problems.some(
            (problem) => problem.level === "warning" && /format "3000"/.test(problem.message),
        ),
    );
    assert.match(JSON.parse(system.compiled.modes!.light!).$description, /string forms/);
});

test("tokens.studio.json: a token set for each mode, a $themes array, the order, and references where a mode has them", () => {
    const { compiled } = writeDesignSystem(project(), {
        tokens: tokens(),
        modes: { dark: dark() },
    });
    const studio = JSON.parse(compiled.studio!);

    assert.deepEqual(Object.keys(studio), ["light", "dark", "$themes", "$metadata"]);
    assert.deepEqual(studio.$metadata, { tokenSetOrder: ["light", "dark"] });
    assert.deepEqual(studio.$themes, [
        { id: "light", name: "light", selectedTokenSets: { light: "enabled", dark: "disabled" } },
        { id: "dark", name: "dark", selectedTokenSets: { light: "disabled", dark: "enabled" } },
    ]);
    assert.deepEqual(studio.light.color.surface, { $type: "color", $value: "{color.base}" });
    assert.deepEqual(studio.dark.color.base, { $type: "color", $value: "#101216" });
    assert.equal(studio.light.color.ink.$value, "#1a1b26");
    assert.equal(studio.dark.color.ink.$value, "#e6e8ee");
    assert.equal(studio.dark.space[4].$value, "16px", "the string forms");
    assert.equal(studio.light.color.base.$value, "#1a3366");

    const count = (node: Record<string, unknown>): number =>
        Object.entries(node).reduce(
            (sum, [key, child]) =>
                sum +
                (key.startsWith("$")
                    ? 0
                    : typeof child === "object" && child !== null && "$value" in child
                      ? 1
                      : count(child as Record<string, unknown>)),
            0,
        );

    assert.equal(count(studio.light), count(studio.dark));
    assert.equal(count(studio.light), Object.keys(JSON.parse(compiled.json).tokens).length);
});

test("the files on disk: the studio file is written with the others, and the compact summary says it is secondary", () => {
    const dir = project();
    const { compiled } = writeDesignSystem(dir, { tokens: tokens(), modes: { dark: dark() } });
    const compact = JSON.parse(compiled.json);

    assert.match(compact.about, /compact summary/);
    assert.match(compact.about, /tokens\.<mode>\.resolved\.json/);
    assert.match(compact.about, /tokens\.studio\.json/);
});
