import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { loadDesignSystem, systemSummary } from "../src/server/design/tokens.ts";

const COMPONENT = (name: string) =>
    `<script type="application/json" id="pocket-component">{"name":"${name}","states":["default"]}</script><template data-state="default"><b>${name}</b></template>`;

function project(files: Record<string, string>): string {
    const cwd = mkdtempSync(join(tmpdir(), "design-cache-"));

    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(cwd, ".pi", "design", name, ".."), { recursive: true });
        writeFileSync(join(cwd, ".pi", "design", name), text);
    }

    return cwd;
}

const tokens = (accent: string) =>
    JSON.stringify({ color: { $type: "color", accent: { $value: accent } } });
const mode = (accent: string) => JSON.stringify({ color: { accent: { $value: accent } } });
const accent = (cwd: string, name = "light") =>
    loadDesignSystem(cwd)!.tokens.find((token) => token.name === "color.accent")!.modes[name]!.css;

// The cache trusts a file only 3 seconds after its last change, so each edit is made, then read after that time.
test("a kept system is the same object until a file changes; each kind of edit shows on the next load", async () => {
    const base = {
        "tokens.json": tokens("#111111"),
        "tokens.dark.json": mode("#222222"),
        "components/card.html": COMPONENT("Card"),
    };
    const edits: [string, (cwd: string) => void, (cwd: string) => void][] = [
        [
            "a same-size edit of tokens.json",
            (cwd) => writeFileSync(join(cwd, ".pi/design/tokens.json"), tokens("#999999")),
            (cwd) => assert.equal(accent(cwd), "#999999"),
        ],
        [
            "a mode file added",
            (cwd) => writeFileSync(join(cwd, ".pi/design/tokens.dim.json"), mode("#333333")),
            (cwd) => assert.equal(accent(cwd, "dim"), "#333333"),
        ],
        [
            "a mode file removed",
            (cwd) => rmSync(join(cwd, ".pi/design/tokens.dark.json")),
            (cwd) => assert.deepEqual(loadDesignSystem(cwd)!.modes, ["light"]),
        ],
        [
            "a component added",
            (cwd) =>
                writeFileSync(join(cwd, ".pi/design/components/badge.html"), COMPONENT("Badge")),
            (cwd) =>
                assert.deepEqual(
                    loadDesignSystem(cwd)!.components.map((each) => each.slug),
                    ["badge", "card"],
                ),
        ],
        [
            "a component removed",
            (cwd) => rmSync(join(cwd, ".pi/design/components/card.html")),
            (cwd) => assert.deepEqual(loadDesignSystem(cwd)!.components, []),
        ],
    ];
    const folders = edits.map(() => project(base));

    try {
        await sleep(3100);

        for (const cwd of folders) {
            assert.equal(loadDesignSystem(cwd), loadDesignSystem(cwd), "kept while unchanged");
        }

        edits.forEach(([, edit], index) => edit(folders[index]!));
        await sleep(3100);
        edits.forEach(([what, , check], index) => {
            assert.doesNotThrow(() => check(folders[index]!), what);
        });
    } finally {
        for (const cwd of folders) {
            rmSync(cwd, { recursive: true, force: true });
        }
    }
});

test("an edit shows at once: a file changed in the last 3 seconds is read again on each load", () => {
    const cwd = project({ "tokens.json": tokens("#111111") });

    try {
        assert.notEqual(loadDesignSystem(cwd), loadDesignSystem(cwd));
        assert.equal(accent(cwd), "#111111");
        writeFileSync(join(cwd, ".pi/design/tokens.json"), tokens("#999999"));
        assert.equal(accent(cwd), "#999999");
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("a loaded system is frozen, so that no caller changes the one that others get", () => {
    const cwd = project({ "tokens.json": tokens("#111111") });

    try {
        const system = loadDesignSystem(cwd)!;

        assert.throws(() => system.tokens.push(system.tokens[0]!), TypeError);
        assert.throws(() => {
            system.tokens[0]!.modes.light!.css = "red";
        }, TypeError);
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("at the limits (5,000 tokens, 16 modes), a repeated load and summary take a few milliseconds", async () => {
    const color: Record<string, unknown> = { $type: "color" };
    const over: Record<string, unknown> = {};

    for (let index = 0; index < 5000; index++) {
        color[`c${index}`] = {
            $value: `#${(index * 2654435).toString(16).padStart(6, "0").slice(-6)}`,
        };
        over[`c${index}`] = {
            $value: `#${(index * 7919).toString(16).padStart(6, "0").slice(-6)}`,
        };
    }

    const files: Record<string, string> = { "tokens.json": JSON.stringify({ color }) };

    for (let index = 1; index < 16; index++) {
        files[`tokens.m${index}.json`] = JSON.stringify({ color: over });
    }

    const cwd = project(files);

    try {
        await sleep(3100);
        systemSummary(loadDesignSystem(cwd)!, 12_000);

        const start = performance.now();
        const system = loadDesignSystem(cwd)!;

        systemSummary(system, 12_000);
        assert.equal(system.modes.length, 16);
        assert.ok(performance.now() - start < 100, `took ${performance.now() - start} ms`);
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});
