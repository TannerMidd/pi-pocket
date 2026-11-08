// design_system resync: a second scan of the code updates a saved system without losing what people wrote.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { designSystemTool, resyncPlan } from "../src/server/design/system.ts";
import {
    loadDesignSystem,
    loadDesignSystemWithRaw,
    writeDesignSystem,
} from "../src/server/design/tokens.ts";
import type { ResyncPlan } from "../src/server/design/tokens-resync.ts";
import { planResync, resyncChange, resyncReport } from "../src/server/design/tokens-resync.ts";
import type { Draft } from "../src/server/design/scan-scales.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-dsresync-"));

    dirs.push(dir);

    for (const [name, body] of Object.entries(files)) {
        mkdirSync(join(dir, name, ".."), { recursive: true });
        writeFileSync(join(dir, name), body);
    }

    return dir;
}

const tool = designSystemTool();
const run = (dir: string, args: Record<string, unknown>) =>
    tool.execute(args as never, { agent: async () => ({ cwd: dir }) } as never, undefined as never);
const say = async (call: ReturnType<typeof run>) =>
    ((await call).output as { type: string; text: string }[])[0]!.text;
const failure = (call: ReturnType<typeof run>) =>
    call.then(
        (result) => `no error: ${(result.output as { text: string }[])[0]?.text.slice(0, 80)}`,
        (error: Error) => error.message,
    );

/** The project's style file: a light and a dark scope, and the accent and radius the tests change. */
const styles = (options: { accent?: string; radius?: boolean; plum?: string } = {}) => `:root {
    --bg: #ffffff;
    --text: #1a1b26;
    --accent: ${options.accent ?? "#3b82f6"};
    --space-4: 16px;${options.radius === false ? "" : "\n    --radius-md: 8px;"}${options.plum === undefined ? "" : `\n    --plum-500: ${options.plum};`}
}
.dark { --bg: #0b0d12; --text: #e6e8ee; --accent: #60a5fa }
body { background: var(--bg); color: var(--text) }
`;

/** A folder with the first version of the code, and a system saved from it. */
async function saved(options: Parameters<typeof styles>[0] = {}): Promise<string> {
    const dir = project({ "src/styles.css": styles(options) });

    await say(run(dir, { action: "init", fromScan: true }));

    return dir;
}

/** Every file under `.pi/design/`, by relative path, with its text. */
function snapshot(dir: string, prefix = "", out: Record<string, string> = {}) {
    const base = join(dir, ".pi/design", prefix);

    for (const entry of readdirSync(base, { withFileTypes: true })) {
        const name = join(prefix, entry.name);

        if (entry.isDirectory()) {
            snapshot(dir, name, out);
        } else {
            out[name] = readFileSync(join(base, entry.name), "utf8");
        }
    }

    return out;
}

const file = (dir: string, name: string) =>
    JSON.parse(readFileSync(join(dir, ".pi/design", name), "utf8"));
const colors = (body: object) => ({ color: { $type: "color", ...body } });

/** A saved system with no scan behind it: `tokens.json` (light by default) and one `tokens.<mode>.json` for each mode. */
function system(tokens: object, modes: Record<string, object> = {}): string {
    return project({
        ".pi/design/tokens.json": JSON.stringify({
            $extensions: { "com.pi-pocket": { name: "Test", mode: "light" } },
            ...tokens,
        }),
        ...Object.fromEntries(
            Object.entries(modes).map(([mode, body]) => [
                `.pi/design/tokens.${mode}.json`,
                JSON.stringify(body),
            ]),
        ),
    });
}

function load(dir: string) {
    const loaded = loadDesignSystemWithRaw(dir);

    assert.ok(loaded !== undefined, "the system loaded");

    return loaded;
}

const planOf = (dir: string, tokens: object, modes: Record<string, object> = {}) => {
    const loaded = load(dir);

    return planResync(loaded.system, { tokens, modes } as Draft, loaded.raw);
};

const reportOf = (plan: ResyncPlan, name = "Test") =>
    resyncReport({ name, path: ".", files: 1, partial: false, saved: false, plan });
const applyPlan = (dir: string, plan: ResyncPlan) =>
    writeDesignSystem(
        dir,
        resyncChange(plan, {
            path: ".",
            scannedAt: new Date().toISOString(),
            tokens: plan.scanned,
        }),
    );

test("a dry run reports what the code added and saves nothing", async () => {
    const dir = await saved();
    const before = snapshot(dir);

    writeFileSync(join(dir, "src/styles.css"), styles({ plum: "#7c3aed" }));

    const reply = await say(run(dir, { action: "resync" }));

    assert.match(reply, /2 to add, 9 kept/);
    assert.match(
        reply,
        /Added \(2\):\n {2}color\.indigo\.500 = #7c3aed\n {2}color\.plum-500 = \{color\.indigo\.500\}/,
    );
    assert.match(reply, /Nothing was saved/);
    assert.deepEqual(snapshot(dir), before, "a dry run writes no file and changes none");
});

test("apply adds only what is new, keeps what people wrote, and a second apply adds nothing", async () => {
    const dir = await saved();
    const specimen = `<script type="application/json" id="pocket-component">{"name":"Button","states":["default"]}</script>
<style>.btn{padding:var(--space-4)}</style>
<template data-state="default"><button class="btn">Go</button></template>`;
    const named = file(dir, "tokens.json").$extensions["com.pi-pocket"].name;

    await say(
        run(dir, {
            action: "set",
            changes: [{ token: "color.bg.page", value: "{color.white}", description: "By hand" }],
        }),
    );
    await say(run(dir, { action: "guidelines", content: "# Voice\n" }));
    await say(run(dir, { action: "component", slug: "button", content: specimen }));
    writeFileSync(join(dir, "src/styles.css"), styles({ plum: "#7c3aed" }));

    assert.match(await say(run(dir, { action: "resync", apply: true })), /2 added, 9 kept/);

    const tokens = file(dir, "tokens.json");
    const source = tokens.$extensions["com.pi-pocket"].source;

    assert.equal(tokens.color.indigo["500"].$value, "#7c3aed");
    assert.equal(tokens.color.indigo["500"].$extensions["com.pi-pocket"].tier, "primitive");
    assert.equal(tokens.color.bg.page.$description, "By hand");
    assert.equal(
        tokens.$extensions["com.pi-pocket"].name,
        named,
        "the source sits beside the name",
    );
    assert.deepEqual([source.path, source.tokens], [".", 11]);
    assert.match(source.scannedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(readFileSync(join(dir, ".pi/design/guidelines.md"), "utf8"), "# Voice\n");
    assert.equal(readFileSync(join(dir, ".pi/design/components/button.html"), "utf8"), specimen);

    const count = loadDesignSystem(dir)?.tokens.length;
    const css = readFileSync(join(dir, ".pi/design/dist/tokens.css"), "utf8");

    assert.match(
        await say(run(dir, { action: "resync", apply: true })),
        /0 added, 11 kept as they are, 0 differ from the code, 0 not in the code now/,
    );
    assert.equal(loadDesignSystem(dir)?.tokens.length, count, "no token is added twice");
    assert.equal(readFileSync(join(dir, ".pi/design/dist/tokens.css"), "utf8"), css);

    // A later change to the system keeps the provenance.
    await say(
        run(dir, { action: "set", changes: [{ token: "color.bg.page", value: "{color.white}" }] }),
    );
    assert.equal(file(dir, "tokens.json").$extensions["com.pi-pocket"].source.tokens, 11);
});

test("a value that differs from the code is listed, and a variable it dropped stays: neither is changed", async () => {
    const dir = await saved();

    await say(
        run(dir, { action: "set", changes: [{ token: "color.accent.default", value: "#123456" }] }),
    );
    writeFileSync(join(dir, "src/styles.css"), styles({ accent: "#2f5bd0", radius: false }));

    const reply = await say(run(dir, { action: "resync", apply: true }));

    assert.match(reply, /\n {2}color\.blue\.500: #3b82f6 \(system\) vs #2f5bd0 \(code\)\n/);
    assert.match(reply, /\n {2}color\.accent\.default: #123456 \(system\) vs #2f5bd0 \(code\)\n/);
    assert.match(reply, /Not in the code now \(1\):\n {2}radius\.md\n/);
    assert.equal(file(dir, "tokens.json").color.accent.default.$value, "#123456");
    assert.equal(file(dir, "tokens.json").radius.md.$value, "8px");
});

const longFile = () => {
    let css = "";

    for (let at = 0; css.length < 220_000; at++) {
        css += `.c${at} { color: #123456; margin: 4px 8px }\n`;
    }

    return `${css}:root { --plum-500: #7c3aed }\n`;
};

for (const [limit, files] of [
    [
        "a file deeper than the scan reads",
        { "src/a/b/c/d/e/f/g/h/deep.css": ":root { --plum-500: #7c3aed }" },
    ],
    ["a file the scan cuts at 200 KB", { "src/big.css": longFile() }],
] as const) {
    test(`${limit} makes the scan partial: its token is not seen, not gone`, async () => {
        const dir = project({ "src/styles.css": styles(), ...files });

        await say(run(dir, { action: "init", fromScan: true }));
        await say(
            run(dir, { action: "set", changes: [{ token: "color.plum.500", value: "#7c3aed" }] }),
        );
        // The fixture has to be a partial scan, or the assertions below hold for the wrong reason.
        assert.match(await say(run(dir, { action: "scan" })), /a limit ended the scan early/);

        const reply = await say(run(dir, { action: "resync" }));

        assert.match(reply, /1 not seen in this scan\./);
        assert.match(reply, /Not seen in this scan \(1\):\n {2}color\.plum\.500\n/);
        assert.ok(
            !reply.includes("not in the code now"),
            "the scan cannot say the code dropped it",
        );
    });
}

test("only a limit makes a plan partial: the engine's 5000 tokens, not a token it drops", () => {
    const color: Record<string, unknown> = { $type: "color" };

    for (let at = 0; at < 7000; at++) {
        color[`v${at}`] = { $value: "#123456" };
    }

    const past = planOf(system(colors({ v6999: { $value: "#123456" } })), { color });

    assert.deepEqual(past.gone, ["color.v6999"], "the engine kept only its first 5000 tokens");
    assert.equal(past.partial, true);
    assert.match(reportOf(past), /Not seen in this scan \(1\):\n {2}color\.v6999\n/);

    // A token that does not resolve is dropped by the engine: the scan read the whole project, so it is really gone.
    const dropped = planOf(
        system(colors({ a: { $value: "#ffffff" } })),
        colors({ a: { $value: "{color.missing}" }, b: { $value: "#123456" } }),
    );

    assert.equal(dropped.partial, false);
    assert.deepEqual(dropped.gone, ["color.a"]);
    assert.ok(!reportOf(dropped).includes("not seen in this scan"));
});

test("resync names what is missing: a system, its tokens, style files, or a readable tokens.json", async () => {
    const style = { "src/a.css": ":root{--bg:#fff;--text:#111;--accent:#37f}" };

    assert.match(await failure(run(project(), { action: "resync" })), /no design system to resync/);
    assert.match(
        await failure(
            run(project({ ".pi/design/guidelines.md": "# Rules\n", ...style }), {
                action: "resync",
            }),
        ),
        /no tokens yet/,
    );
    assert.match(
        await failure(
            run(project({ ".pi/design/tokens.json": "{ not json", ...style }), {
                action: "resync",
            }),
        ),
        /tokens\.json cannot be read.*nothing to keep/,
    );

    // A folder with no style files cannot show resync the code: an apply refuses, and a dry run does not offer one.
    const empty = project({ "docs/notes.md": "nothing to scan here" });

    await say(
        run(empty, {
            action: "init",
            tokens: { color: { $type: "color", accent: { $value: "#3b82f6" } } },
        }),
    );
    assert.match(
        await say(run(empty, { action: "resync", path: "docs" })),
        /read no style files in docs, so an apply would be refused/,
    );
    assert.match(
        await failure(run(empty, { action: "resync", apply: true, path: "docs" })),
        /found no style files in docs/,
    );
});

test("a token whose reference the plan cannot add blocks the tokens that refer to it, so the write goes through", () => {
    // The system has a token at color.brand, so the code's color.brand.dark has no group there. The code's
    // color.accent.hover refers to it: adding only that one would make the whole write fail on a missing reference.
    const dir = system(colors({ brand: { $value: "#123456" } }));
    const plan = planOf(
        dir,
        colors({
            brand: { dark: { $value: "#0a0b0c" } },
            accent: { hover: { $value: "{color.brand.dark}" } },
        }),
    );

    assert.deepEqual(plan.added, []);
    assert.deepEqual(plan.blocked.map((token) => token.token).sort(), [
        "color.accent.hover",
        "color.brand.dark",
    ]);
    assert.match(
        reportOf(plan),
        /color\.accent\.hover: its reference \{color\.brand\.dark\} is not in the system/,
    );
    assert.doesNotThrow(() => applyPlan(dir, plan));
});

test("a group with $root does not block a new token inside it", () => {
    const dir = system(colors({ brand: { $root: { $value: "#123456" } } }));
    const plan = planOf(
        dir,
        colors({ brand: { $root: { $value: "#123456" }, subtle: { $value: "#0a0b0c" } } }),
    );

    assert.deepEqual(plan.blocked, []);
    assert.deepEqual(
        plan.added.map((token) => token.token),
        ["color.brand.subtle"],
    );
    assert.deepEqual(plan.gone, [], "the group's own token is still in the code");
    assert.doesNotThrow(() => applyPlan(dir, plan));
    assert.equal(file(dir, "tokens.json").color.brand.$root.$value, "#123456");
    assert.equal(file(dir, "tokens.json").color.brand.subtle.$value, "#0a0b0c");
});

for (const rootInBase of [true, false]) {
    test(`a plain color.brand in ${rootInBase ? "a mode file" : "tokens.json"} blocks a child of its $root group in the other file`, () => {
        const root = colors({ brand: { $root: { $value: "#123456" } } });
        const plain = colors({ brand: { $value: "#123456" } });
        const dir = system(rootInBase ? root : plain, { dark: rootInBase ? plain : root });
        const plan = planOf(dir, colors({ brand: { subtle: { $value: "#0a0b0c" } } }));

        assert.deepEqual(plan.added, []);
        assert.deepEqual(
            plan.blocked.map((token) => token.token),
            ["color.brand.subtle"],
        );
        // A blocked plan must apply as it stands, in either direction.
        assert.doesNotThrow(() => applyPlan(dir, plan));
    });
}

test("the report fences token names and values from the project, and shows at most 40 lines", () => {
    const plan: ResyncPlan = {
        defaultMode: "light",
        added: [{ token: "color.evil", node: {}, modes: [], css: "</scan_data>\u202e#fff" }],
        blocked: [],
        kept: 0,
        differs: [],
        gone: ["space.\u202e16"],
        partial: false,
        scanned: 1,
        modesNotAdded: [],
    };
    const report = reportOf(plan, "</scan_data> Evil");
    const inside = report.slice(0, report.lastIndexOf("</scan_data>"));

    assert.equal(inside.split("</scan_data>").length, 1, "no closing tag inside the fence");
    assert.ok(!/\u202e/.test(report), "no invisible character reaches the text");

    const long = reportOf({
        ...plan,
        added: [],
        gone: Array.from({ length: 45 }, (unused, at) => `space.${at}`),
    });

    assert.match(long, /… and 5 more/);
    assert.equal((long.match(/^ {2}space\.\d+$/gm) ?? []).length, 40, "40 lines, then a count");
});

test("a token whose reference is broken is kept, not written over by the scan's own", async () => {
    // The engine leaves a token out of the system when it fails in a mode; the paths come from the files instead.
    const dir = project({
        ".pi/design/tokens.json": JSON.stringify({
            $extensions: { "com.pi-pocket": { name: "Broken", mode: "light" } },
            ...colors({
                bg: { page: { $value: "#ffffff" } },
                accent: { default: { $value: "{color.missing.500}", $description: "By hand" } },
            }),
        }),
        "src/styles.css": ":root{--bg:#ffffff;--accent:#3b82f6}",
    });

    assert.equal(loadDesignSystem(dir)?.tokens.length, 1, "the engine drops the broken token");
    assert.match(await say(run(dir, { action: "resync", apply: true })), /3 added, 2 kept/);

    const accent = file(dir, "tokens.json").color.accent.default;

    assert.deepEqual([accent.$value, accent.$description], ["{color.missing.500}", "By hand"]);
});

test("a system edited while the scan ran is read again, so the plan does not write over the edit", async () => {
    const dir = await saved();
    const draft = { tokens: colors({ plum: { $value: "#7c3aed" } }), modes: {} } as Draft;

    // An edit made while the scan ran: resyncPlan is what resync calls after its scan, and it reads `.pi/design/` again.
    await say(
        run(dir, {
            action: "set",
            changes: [{ token: "color.plum", value: "#111111", description: "By hand" }],
        }),
    );

    const { plan } = resyncPlan(dir, draft);

    assert.deepEqual(plan.added, []);
    assert.equal(plan.kept, 1);
    assert.deepEqual(
        plan.differs.map((token) => [token.token, token.mode, token.system, token.scan]),
        [
            ["color.plum", "light", "#111111", "#7c3aed"],
            ["color.plum", "dark", "#111111", "#7c3aed"],
        ],
    );
    applyPlan(dir, plan);
    assert.equal(file(dir, "tokens.json").color.plum.$value, "#111111");
    assert.equal(file(dir, "tokens.json").color.plum.$description, "By hand");
});

test("a mode the code does not have is compared with the code's default value", () => {
    const dir = system(colors({ accent: { default: { $value: "#3b82f6" } } }), {
        "high-contrast": colors({ accent: { default: { $value: "#0033cc" } } }),
    });
    const plan = planOf(dir, colors({ accent: { default: { $value: "#3b82f6" } } }));

    assert.deepEqual(plan.differs, [
        {
            token: "color.accent.default",
            mode: "high-contrast",
            system: "#0033cc",
            scan: "#3b82f6",
        },
    ]);
});

test("when the default modes differ, a new token takes the code's default node, and each mode the value it should", () => {
    // A dark-first system with a light and a high-contrast mode, over code that is light first with a dark mode only.
    const dir = system(
        {
            $extensions: { "com.pi-pocket": { name: "Contrast", mode: "dark" } },
            ...colors({ bg: { page: { $value: "#0b0d12" } } }),
        },
        {
            light: colors({ bg: { page: { $value: "#ffffff" } } }),
            "high-contrast": colors({ bg: { page: { $value: "#ffffff" } } }),
        },
    );
    const code = {
        tokens: colors({
            bg: { page: { $value: "#ffffff" } },
            brand: {
                $value: "#ffffff",
                $description: "Brand ground",
                $extensions: { "com.pi-pocket": { tailwind: "--color-brand" } },
            },
        }),
        modes: {
            dark: colors({
                bg: { page: { $value: "#0b0d12" } },
                brand: { $value: "#7aa2f7", $description: "Dark only" },
            }),
        },
    };
    const plan = planOf(dir, code.tokens, code.modes);
    const added = plan.added.find((token) => token.token === "color.brand");

    assert.ok(added !== undefined, "the code's new token is added");
    // The system's dark default takes the code's dark value; the node stays the code's default one.
    assert.equal(added.node.$value, "#7aa2f7");
    assert.equal(added.node.$description, "Brand ground");
    const extensions = added.node.$extensions as Record<string, Record<string, unknown>>;

    assert.equal(extensions["com.pi-pocket"]?.tailwind, "--color-brand");
    // A mode the code lacks gets the code's default value (#ffffff), not the system's dark one.
    assert.deepEqual(added.modes, [
        { mode: "high-contrast", value: "#ffffff", css: "#ffffff" },
        { mode: "light", value: "#ffffff", css: "#ffffff" },
    ]);
    assert.match(reportOf(plan), /color\.brand = #7aa2f7 \(high-contrast #ffffff, light #ffffff\)/);

    applyPlan(dir, plan);
    assert.equal(file(dir, "tokens.high-contrast.json").color?.brand?.$value, "#ffffff");

    const brand = loadDesignSystem(dir)?.tokens.find((token) => token.name === "color.brand");

    assert.equal(brand?.modes["high-contrast"]?.hex, "#ffffff");

    const again = planOf(dir, code.tokens, code.modes);

    assert.deepEqual(again.added, [], "no token is added twice");
    assert.deepEqual(
        again.differs,
        [],
        "the mode holds the code's default value, so nothing differs",
    );
});

test("an I/O error partway through the write leaves the earlier files written, as the tool says", async () => {
    const dir = await saved();

    writeFileSync(join(dir, "src/styles.css"), styles({ plum: "#7c3aed" }));
    rmSync(join(dir, ".pi/design/dist"), { recursive: true, force: true });
    writeFileSync(join(dir, ".pi/design/dist"), "not a folder");

    // tokens.json goes in first, then dist/, which is a file here.
    assert.match(await failure(run(dir, { action: "resync", apply: true })), /dist/);
    assert.ok(file(dir, "tokens.json").color["plum-500"] !== undefined);
    assert.equal(file(dir, "tokens.json").$extensions["com.pi-pocket"].source.path, ".");
    assert.equal(readFileSync(join(dir, ".pi/design/dist"), "utf8"), "not a folder");
});
