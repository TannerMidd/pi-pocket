import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSystem } from "../src/server/design/tokens-model.ts";

function problems(tokens: unknown, modes: Record<string, unknown> = {}): string[] {
    const system = buildSystem({
        folder: "x",
        tokens: tokens as Record<string, unknown>,
        modes: new Map(Object.entries(modes)),
        components: new Map(),
        guidelines: "",
        problems: [],
    });

    return system.problems
        .filter((problem) => /ramp/.test(problem.message))
        .map((problem) => `${problem.level}: ${problem.message} | ${problem.fix ?? ""}`);
}

const ramp = (steps: Record<string, string>) => ({
    color: {
        $type: "color",
        blue: Object.fromEntries(
            Object.entries(steps).map(([step, value]) => [step, { $value: value }]),
        ),
    },
});

const STEADY = {
    50: "#eff6ff",
    100: "#dbeafe",
    200: "#bfdbfe",
    300: "#93c5fd",
    500: "#3b82f6",
    700: "#1d4ed8",
    900: "#1e3a8a",
};

test("a ramp that gets steadily darker, or steadily lighter, has no warning", () => {
    assert.deepEqual(problems(ramp(STEADY)), []);
    assert.deepEqual(
        problems(
            ramp({
                50: "#1e3a8a",
                100: "#1d4ed8",
                300: "#3b82f6",
                500: "#93c5fd",
                700: "#bfdbfe",
                900: "#eff6ff",
            }),
        ),
        [],
        "numbers that rise as the color gets lighter are as good",
    );
});

test("a step that breaks the order is a warning that names the two steps and what to do", () => {
    const found = problems(ramp({ ...STEADY, 100: "#bfdbfe", 200: "#dbeafe" }));

    assert.equal(found.length, 1);
    assert.match(found[0]!, /^warning: The ramp "color\.blue" is not steady in lightness/);
    assert.match(
        found[0]!,
        /step 200 \(\d+%\) is lighter than step 100 \(\d+%\), but the ramp gets darker as its numbers rise/,
    );
    assert.match(found[0]!, /Swap the values of color\.blue\.100 and color\.blue\.200/);

    const reversed = problems(
        ramp({
            50: "#1e3a8a",
            100: "#1d4ed8",
            300: "#bfdbfe",
            500: "#93c5fd",
            700: "#dbeafe",
            900: "#eff6ff",
        }),
    );

    assert.equal(reversed.length, 1);
    assert.match(
        reversed[0]!,
        /step 500 \(\d+%\) is darker than step 300 \(\d+%\), but the ramp gets lighter as its numbers rise/,
    );
});

test("each ramp is checked on its own, and each mode: a mode that breaks a ramp says which", () => {
    const tokens = {
        color: {
            $type: "color",
            blue: {
                100: { $value: "#dbeafe" },
                500: { $value: "#3b82f6" },
                900: { $value: "#1e3a8a" },
            },
            red: {
                100: { $value: "#fee2e2" },
                500: { $value: "#ef4444" },
                900: { $value: "#7f1d1d" },
            },
        },
    };

    assert.deepEqual(problems(tokens), []);

    const found = problems(tokens, { dark: { color: { red: { 500: { $value: "#fef2f2" } } } } });

    assert.equal(found.length, 1);
    assert.match(found[0]!, /"color\.red" is not steady in lightness in the dark mode/);
});

test("what is not a ramp is left alone: fewer than three steps, a flat ramp, translucent steps, names that are not numbers", () => {
    assert.deepEqual(problems(ramp({ 100: "#dbeafe", 200: "#eff6ff" })), [], "two steps");
    assert.deepEqual(
        problems(ramp({ 100: "#808080", 200: "#818181", 300: "#808080", 400: "#828282" })),
        [],
        "no direction",
    );
    assert.deepEqual(
        problems(ramp({ 100: "#00000010", 200: "#00000040", 300: "#00000020", 400: "#00000080" })),
        [],
        "translucent",
    );
    assert.deepEqual(
        problems({
            color: {
                $type: "color",
                brand: {
                    low: { $value: "#bfdbfe" },
                    mid: { $value: "#dbeafe" },
                    high: { $value: "#1e3a8a" },
                },
            },
        }),
        [],
        "named steps",
    );
    assert.deepEqual(
        problems({
            space: {
                $type: "dimension",
                4: { $value: "16px" },
                2: { $value: "8px" },
                6: { $value: "24px" },
            },
        }),
        [],
        "not colors",
    );
});
