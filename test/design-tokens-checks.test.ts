import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { designSystemTool } from "../src/server/design/system.ts";
import { loadDesignSystem, writeDesignSystem } from "../src/server/design/tokens.ts";

const dirs: string[] = [];

after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-pocket-ds-checks-"));

    dirs.push(dir);

    return dir;
}

const system = (tokens: unknown, modes?: Record<string, unknown>) =>
    writeDesignSystem(project(), { tokens, ...(modes === undefined ? {} : { modes }) });
const warnings = (made: ReturnType<typeof system>) =>
    made.problems.filter((problem) => problem.level === "warning");

test("a token named for its own value warns, with a fix; the steps of a scale do not", () => {
    const made = system({
        space: {
            $type: "dimension",
            0: { $value: "0px" },
            1: { $value: "4px" },
            4: { $value: "16px" },
            16: { $value: "16px" },
            24: { $value: "24px" },
        },
        radius: { $type: "dimension", 7: { $value: "7px" }, card: { $value: "8px" } },
        duration: {
            $type: "duration",
            140: { $value: "140ms" },
            fast: { $value: "150ms" },
            3: { $value: "300ms" },
        },
        color: { $type: "color", neutral: { 500: { $value: "#888888" } } },
        weight: { $type: "fontWeight", 500: { $value: 500 } },
    });
    const named = warnings(made).filter((problem) => problem.message.includes("own value"));

    assert.equal(named.length, 3, "one for each group: space, radius, duration");

    const space = named.find((problem) => problem.token === "space.16")!;

    assert.match(space.message, /2 tokens in "space" are named for their own value \(16, 24\)/);
    assert.match(space.fix!, /Rename each to a role .*or to a step of a scale/);
    assert.match(
        named.find((problem) => problem.token === "radius.7")!.message,
        /"radius\.7" is named for its own value/,
    );
    assert.match(
        named.find((problem) => problem.token === "duration.140")!.message,
        /own value \(140\)/,
    );
    assert.ok(
        !named.some((problem) =>
            /space\.(0|1|4)\b|duration\.3|neutral|weight/.test(problem.token ?? ""),
        ),
        "space.4 is 16px, space.0 is zero, duration.3 is 300ms, and a color or a weight is not a size",
    );
});

test("a name equal to the value in rem or in seconds is the same case", () => {
    const made = system({
        space: { $type: "dimension", 16: { $value: "1rem" } },
        time: { $type: "duration", 200: { $value: "0.2s" } },
    });

    assert.equal(
        warnings(made).filter((problem) => problem.message.includes("own value")).length,
        2,
    );
});

const textTokens = (disabled: unknown) => ({
    color: {
        $type: "color",
        bg: { page: { $value: "#ffffff" } },
        text: {
            primary: {
                $value: "#111111",
                $extensions: { "com.pi-pocket": { contrast: { on: "{color.bg.page}", min: 4.5 } } },
            },
            disabled: {
                $value: "#b8bac8",
                $extensions: { "com.pi-pocket": { contrast: disabled } },
            },
        },
    },
});

test("a pair that fails is a warning with a fix; an exempt pair is a note, not a warning", () => {
    const failing = system(textTokens({ on: "{color.bg.page}", min: 4.5 }));
    const warn = warnings(failing).find((problem) => problem.token === "color.text.disabled")!;

    assert.match(warn.message, /Contrast of "color\.text\.disabled" is too low/);
    assert.match(warn.fix!, /exempt/);
    assert.equal(failing.notes, undefined);

    for (const exempt of ["disabled", "decorative"]) {
        const made = system(textTokens({ on: "{color.bg.page}", min: 4.5, exempt }));

        assert.deepEqual(warnings(made), [], `${exempt}: no warning`);
        assert.equal(made.notes!.length, 1);
        assert.equal(made.notes![0]!.level, "info");
        assert.match(
            made.notes![0]!.message,
            new RegExp(`below its minimum .*exempt \\(${exempt}\\)`),
        );
        assert.equal(made.notes![0]!.token, "color.text.disabled");
        assert.equal(
            made.problems.length,
            0,
            "a note is not a problem, so nothing that counts problems counts it",
        );
        assert.deepEqual(
            made.tokens.find((token) => token.name === "color.text.disabled")!.contrast,
            { on: "color.bg.page", min: 4.5, exempt },
        );
        assert.equal(
            made.tokens.find((token) => token.name === "color.text.disabled")!.modes.light!
                .contrast!.exempt,
            exempt,
        );
    }

    assert.equal(
        system(textTokens({ on: "{color.bg.page}", min: 1.5, exempt: "disabled" })).notes,
        undefined,
    );
});

test("exempt is disabled or decorative, and nothing else", () => {
    assert.throws(
        () => system(textTokens({ on: "{color.bg.page}", min: 4.5, exempt: "faint" })),
        /exempt "faint"; it must be "disabled" or "decorative"/,
    );
});

test("a token with several contrast pairs lists all of them", () => {
    const made = system({
        color: {
            $type: "color",
            bg: { page: { $value: "#ffffff" }, card: { $value: "#f4f4f4" } },
            text: {
                primary: {
                    $value: "#111111",
                    $extensions: {
                        "com.pi-pocket": {
                            contrast: [
                                { on: "{color.bg.page}", min: 7 },
                                { on: "{color.bg.card}", min: 4.5 },
                            ],
                        },
                    },
                },
            },
        },
    });
    const token = made.tokens.find((each) => each.name === "color.text.primary")!;

    assert.deepEqual(token.contrasts, [
        { on: "color.bg.page", min: 7 },
        { on: "color.bg.card", min: 4.5 },
    ]);
    assert.deepEqual(token.contrast, token.contrasts![0], "contrast is the first pair");
});

test("a shadow has parts: its members as CSS, one layer plain, several by layer", () => {
    const made = system({
        color: { $type: "color", shadow: { $value: "#00000040" } },
        shadow: {
            $type: "shadow",
            one: {
                $value: {
                    color: "{color.shadow}",
                    offsetX: "0",
                    offsetY: "4px",
                    blur: "8px",
                    spread: "1px",
                },
            },
            two: {
                $value: [
                    { color: "#0001", offsetX: "0", offsetY: "1px", blur: "2px" },
                    {
                        color: "{color.shadow}",
                        offsetX: "0",
                        offsetY: "8px",
                        blur: "24px",
                        inset: true,
                    },
                ],
            },
        },
    });
    const parts = (name: string) =>
        made.tokens.find((token) => token.name === name)!.modes.light!.parts;

    assert.deepEqual(parts("shadow.one"), {
        "offset-x": "0",
        "offset-y": "4px",
        blur: "8px",
        spread: "1px",
        color: "var(--color-shadow)",
    });
    assert.equal(parts("shadow.two")!["layer-1-blur"], "2px");
    assert.equal(parts("shadow.two")!["layer-2-color"], "var(--color-shadow)");
    assert.equal(parts("shadow.two")!["layer-2-inset"], "inset");
    assert.doesNotMatch(made.compiled.css, /--shadow-one-blur/);
});

test("a mode lists the tokens its file sets, so a view can show the rest as inherited", () => {
    const made = system(
        {
            color: {
                $type: "color",
                bg: { page: { $value: "#ffffff" }, card: { $value: "#f4f4f4" } },
                text: { primary: { $value: "#111111" } },
            },
        },
        {
            dark: { color: { bg: { page: { $value: "#000000" }, card: { $value: "#f4f4f4" } } } },
            sepia: { color: { text: { primary: { $value: "#332211" } } } },
        },
    );

    assert.deepEqual(made.overrides, {
        dark: ["color.bg.page", "color.bg.card"],
        sepia: ["color.text.primary"],
    });
    assert.deepEqual(system({ n: { $type: "number", one: { $value: 1 } } }).overrides, {});
});

const tool = designSystemTool();
const run = (dir: string, args: Record<string, unknown>) =>
    tool.execute(args as never, { agent: async () => ({ cwd: dir }) } as never, undefined as never);

test("mode files past twice the mode limit are not read", () => {
    const dir = project();
    const folder = join(dir, ".pi", "design");

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "tokens.json"), "{}");

    for (let i = 0; i < 40; i++) {
        writeFileSync(join(folder, `tokens.m${i}.json`), "{}");
    }

    const unread = loadDesignSystem(dir)!.problems.filter((problem) =>
        problem.message.includes("is not read"),
    );

    assert.equal(unread.length, 8);
});

test("a parameter that does not fit the action is refused, with the action it fits", async () => {
    const dir = project();
    const changes = [{ token: "color.bg.page", value: "#fff" }];

    await assert.rejects(
        run(dir, { action: "set", fromScan: true, changes }),
        /fromScan is a parameter of init, not of set\. set takes: changes, remove\./,
    );
    await assert.rejects(
        run(dir, { action: "validate", changes }),
        /changes is a parameter of set and init, not of validate\. validate takes no other parameter\./,
    );
    await assert.rejects(
        run(dir, { action: "read", slug: "button" }),
        /slug is a parameter of component, not of read\. read takes: file\./,
    );
    await assert.rejects(
        run(dir, { action: "guidelines", tokens: {}, content: "x" }),
        /tokens is a parameter of init, not of guidelines\. guidelines takes: content\./,
    );
    await assert.rejects(
        run(dir, { action: "init", path: "src", tokens: {} }),
        /path is a parameter of init only with fromScan: true/,
    );
    await assert.rejects(
        run(dir, { action: "frobnicate" }),
        /not an action of design_system\. Actions: read, scan, init/,
    );

    assert.ok(await run(dir, { action: "scan", path: undefined }));
    assert.ok(await run(dir, { action: "validate", file: undefined }));
});

test("the 0.26 write still works and is not in the description", async () => {
    assert.doesNotMatch(tool.description, /\bwrite\b/);

    const schema = tool.parameters as { properties: Record<string, { description?: string }> };

    for (const [name, field] of Object.entries(schema.properties)) {
        assert.doesNotMatch(field.description ?? "", /\bwrite: /, `${name}'s description`);
    }

    const dir = project();
    const reply = await run(dir, {
        action: "write",
        content: '# Tokens\n```json\n{"color":{"accent":"#fff"}}\n```\n',
    });

    assert.match((reply.output as { text: string }[])[0]!.text, /Wrote \.pi\/design-system\.md/);
    assert.equal(loadDesignSystem(dir), undefined);
});

test("validate lists the notes apart from the problems", async () => {
    const dir = project();

    await run(dir, {
        action: "init",
        tokens: textTokens({ on: "{color.bg.page}", min: 4.5, exempt: "disabled" }),
    });

    const reply = (await run(dir, { action: "validate" })).output as { text: string }[];

    assert.match(reply[0]!.text, /No problems\./);
    assert.match(
        reply[0]!.text,
        /Notes \(no action needed\):\n- info: tokens\.json › color\.text\.disabled: Contrast/,
    );
});
