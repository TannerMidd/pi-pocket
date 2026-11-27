// What this server or Pi loads as code or trusted settings is not reached through a link into a folder that a guest
// writes: a read-write sandbox is refused while a link under such a place leads into the folder, and a module in such a
// folder, or that imports from one, is not loaded.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { linkInto, onSandboxedFolders } from "../src/server/confined.ts";
import { documentImports } from "../src/server/extension-document-imports.ts";
import { FakeDriver, sandboxOptions, useDriver } from "./gondolin-fake.ts";
import { SandboxDoc } from "../src/server/docs.ts";
import { cleanUp, context, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";

after(cleanUp);

let opened = 0;

let driver: FakeDriver;

async function app() {
    driver = new FakeDriver();
    useDriver(driver);
    const fresh = await openApp(
        scriptedModel(),
        join(root, `data-trusted-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );

    await fresh.setExtensionEnabled(owner(fresh), "gondolin.ts", true);

    return fresh;
}

function project(name: string): string {
    const path = join(root, name);

    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "example.ts"), "export default 1;\n");
    mkdirSync(join(path, "skill"));
    writeFileSync(join(path, "skill", "SKILL.md"), "---\nname: skill\ndescription: x\n---\n");

    return path;
}

test("a read-write sandbox is refused while a drop-in extension is a link into the folder", async () => {
    const running = await app();

    try {
        const shared = project("trusted-dropin");

        mkdirSync(join(running.dataDir, "extensions"), { recursive: true });
        symlinkSync(join(shared, "example.ts"), join(running.dataDir, "extensions", "example.ts"));
        const id = await newSession(running, shared);

        await assert.rejects(
            running.sandboxes.set(id, owner(running), true),
            /extensions\/example\.ts reaches into .*trusted-dropin/,
        );
        assert.equal((await running.sandboxes.get(id)).on, false);

        // Read only: the guest cannot write what the link names.
        running.setExtensionSettings(owner(running), "gondolin", { mount: "ro" });
        await running.sandboxes.set(id, owner(running), true);
        assert.equal((await running.sandboxes.get(id)).on, true);
    } finally {
        useDriver(undefined);
        await running.close();
    }
});

test("a skill folder of Pi that is a link into the folder, or passes through it, refuses a read-write sandbox", async () => {
    const running = await app();

    try {
        const shared = project("trusted-skill");
        const alias = join(root, "trusted-skill-alias");
        const skills = join(process.env.PI_CODING_AGENT_DIR!, "skills");

        symlinkSync(shared, alias);
        mkdirSync(skills, { recursive: true });
        // Through an alias of the project, and then a folder inside it: every name on the way is looked at.
        symlinkSync(join(alias, "skill"), join(skills, "linked"));
        const id = await newSession(running, shared);

        await assert.rejects(
            running.sandboxes.set(id, owner(running), true),
            /skills\/linked reaches into/,
        );
    } finally {
        useDriver(undefined);
        await running.close();
    }
});

test("a module in a folder that a sandboxed session works in, or a link to one, is not imported", async () => {
    const shared = project("trusted-import");
    const dropIn = join(root, "trusted-import-dropins");

    mkdirSync(dropIn, { recursive: true });
    writeFileSync(join(shared, "dependency.mjs"), "export const value = 1;\n");
    symlinkSync(join(shared, "dependency.mjs"), join(dropIn, "linked.mjs"));
    writeFileSync(join(dropIn, "own.mjs"), "export const value = 2;\n");
    writeFileSync(
        join(dropIn, "importer.mjs"),
        `import { value } from ${JSON.stringify(pathToFileURL(join(shared, "dependency.mjs")).href)};\nexport default value;\n`,
    );
    const stopImports = documentImports(dropIn, () => {});
    const stop = onSandboxedFolders(() => [shared]);

    try {
        const load = (name: string, tag: string) =>
            import(`${pathToFileURL(join(dropIn, name)).href}?${tag}`);

        assert.equal((await load("own.mjs", "a")).value, 2);

        for (const name of ["linked.mjs", "importer.mjs"]) {
            await assert.rejects(
                load(name, name),
                /dependency\.mjs is in a folder that a sandboxed session works in/,
                name,
            );
        }
    } finally {
        stop();
        stopImports();
    }
});

/** A trusted place with `depth` folders under it and a link at the bottom that leads into `shared`. */
function tree(name: string, depth: number, shared: string): { top: string; link: string } {
    const top = join(root, name);
    let at = top;

    for (let level = 0; level < depth; level++) {
        at = join(at, `level-${level}`);
    }

    mkdirSync(at, { recursive: true });
    symlinkSync(shared, join(at, "link"));

    return { top, link: join(at, "link") };
}

test("a link five folders deep under a trusted place is found, and no link is followed on the way", async () => {
    const shared = project("trusted-deep");
    const { top, link } = tree("trusted-deep-roots", 5, shared);

    assert.deepEqual(await linkInto([top], shared), { link });
    // A link to somewhere else is not a link into the folder.
    assert.equal(await linkInto([top], project("trusted-elsewhere")), undefined);
});

test("a look that does not finish is not clean: more entries than the cap, or a folder that cannot be read", async () => {
    const shared = project("trusted-unfinished");
    const top = join(root, "trusted-unfinished-roots");

    for (const name of ["a", "b", "c", "d"]) {
        mkdirSync(join(top, name), { recursive: true });
        writeFileSync(join(top, name, "file"), "x");
    }

    assert.equal(await linkInto([top], shared), undefined);
    assert.match(
        ((await linkInto([top], shared, { limit: 3 })) as { unfinished: string }).unfinished,
        /more than 3 entries/,
    );
    assert.match(
        ((await linkInto([top], shared, { ms: -1 })) as { unfinished: string }).unfinished,
        /took more than/,
    );
});

const canDeny =
    process.platform !== "win32" && process.getuid?.() !== 0 && "permissions are not kept";

test(
    "a folder that cannot be read under a trusted place refuses a read-write sandbox, with the reason",
    { skip: !canDeny },
    async () => {
        const running = await app();
        const hidden = join(process.env.PI_CODING_AGENT_DIR!, "prompts", "hidden");

        try {
            const shared = project("trusted-unreadable");

            mkdirSync(hidden, { recursive: true });
            chmodSync(hidden, 0o000);
            const id = await newSession(running, shared);

            await assert.rejects(
                running.sandboxes.set(id, owner(running), true),
                /could not all be looked at .*prompts\/hidden cannot be read/,
            );
            running.setExtensionSettings(owner(running), "gondolin", { mount: "ro" });
            await running.sandboxes.set(id, owner(running), true);
        } finally {
            chmodSync(hidden, 0o755);
            useDriver(undefined);
            await running.close();
        }
    },
);

test("a link under a folder that a trusted link names is found: its content is under the trusted place", async () => {
    const shared = project("trusted-nested");
    const top = join(root, "trusted-nested-roots");
    const outside = join(root, "trusted-nested-outside");

    mkdirSync(join(top, "skills"), { recursive: true });
    mkdirSync(join(outside, "tool"), { recursive: true });
    symlinkSync(join(outside, "tool"), join(top, "skills", "tool"));
    symlinkSync(join(shared, "example.ts"), join(outside, "tool", "SKILL.md"));

    assert.deepEqual(await linkInto([top], shared), { link: join(outside, "tool", "SKILL.md") });
});

test("links that make a loop end the look: each folder is looked at once", async () => {
    const shared = project("trusted-loop");
    const top = join(root, "trusted-loop-roots");
    const other = join(root, "trusted-loop-other");

    mkdirSync(join(top, "a"), { recursive: true });
    mkdirSync(other, { recursive: true });
    symlinkSync(top, join(top, "a", "back"));
    symlinkSync(join(top, "a"), join(top, "self"));
    symlinkSync(other, join(top, "away"));
    symlinkSync(top, join(other, "home"));
    writeFileSync(join(other, "file"), "x");

    assert.equal(await linkInto([top], shared), undefined);
    // And it counts what it visits against the cap, the folder outside too.
    assert.match(
        ((await linkInto([top], shared, { limit: 3 })) as { unfinished: string }).unfinished,
        /more than 3 entries/,
    );
});

/**
 * A server whose first look at the trusted places is held: a session that was sandboxed before is noted while it is held,
 * and its folder has a link under the drop-in folder, so that the look ends in a refusal.
 */
async function firstLook() {
    const running = await app();
    const shared = project(`trusted-first-${opened}`);

    mkdirSync(join(running.dataDir, "extensions"), { recursive: true });
    symlinkSync(join(shared, "example.ts"), join(running.dataDir, "extensions", "example.ts"));
    const id = await newSession(running, shared);
    const first = running.trustedFolders[0]!;
    const original = fsp.readdir;
    let reach!: () => void;
    let open!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    const held = new Promise<void>((resolve) => (open = resolve));
    let taken = false;

    (fsp as unknown as { readdir: unknown }).readdir = async (...args: unknown[]) => {
        if (!taken && args[0] === first) {
            taken = true;
            reach();
            await held;
        }

        return (original as (...call: unknown[]) => unknown)(...args);
    };

    syncBuiltinESMExports();

    // Stored as sandboxed before: the setting is in, and nothing asked whether the folder may be shared.
    await running.harness.commit(async (tx) => {
        Object.assign(await tx.doc(SandboxDoc, id), { on: true });
    }, context);
    await reached;

    return {
        running,
        shared,
        id,
        open,
        restore: () => {
            open();
            (fsp as unknown as { readdir: unknown }).readdir = original;
            syncBuiltinESMExports();
        },
    };
}

test("a browser launch while the first look is under way starts no VM when the look refuses", async () => {
    const { running, id, open, restore } = await firstLook();

    try {
        const launch = running.sandboxes
            .browserFor(Number(id))!
            .launch([])
            .then(
                () => "launched",
                (error: unknown) => String(error),
            );

        open();
        assert.match(await launch, /being looked at|reaches into/);
        assert.equal(driver.log.started.length, 0, "a VM started for a folder that was refused");
    } finally {
        restore();
        useDriver(undefined);
        await running.close();
    }
});

test("an environment made while the first look is under way starts no VM when the look refuses", async () => {
    const { running, shared, id, open, restore } = await firstLook();

    try {
        const env = running.sandboxes.env(id, shared);

        open();
        await running.sandboxes.settled(id);
        const result = await env.exec("true", {}, context);

        assert.equal(result.ok, false);
        assert.equal(driver.log.started.length, 0, "a VM started for a folder that was refused");
        // And an environment made after the look says why.
        const later = await running.sandboxes.env(id, shared).exec("true", {}, context);

        assert.equal(later.ok, false);
        assert.match(String(later.ok ? "" : later.error.message), /reaches into/);
    } finally {
        restore();
        useDriver(undefined);
        await running.close();
    }
});

/** Pi's settings file for a test, removed after. */
async function withSettings(settings: unknown, run: () => Promise<void>): Promise<void> {
    const file = join(process.env.PI_CODING_AGENT_DIR!, "settings.json");

    writeFileSync(file, JSON.stringify(settings));

    try {
        await run();
    } finally {
        rmSync(file, { force: true });
    }
}

for (const [name, key] of [
    ["skill", "skills"],
    ["prompt", "prompts"],
] as const) {
    test(`a ${name} path that Pi's settings name, inside the folder, refuses a read-write sandbox; one outside does not`, async () => {
        const running = await app();

        try {
            const shared = project(`trusted-configured-${name}`);
            const elsewhere = project(`trusted-configured-${name}-elsewhere`);
            const id = await newSession(running, shared);

            // Named by an absolute path, a path in the home folder's style, and (not there yet) a path of a new file.
            await withSettings({ [key]: [join(elsewhere, "skill")] }, async () => {
                await running.sandboxes.set(id, owner(running), true);
                await running.sandboxes.set(id, owner(running), false);
            });

            for (const path of [
                join(shared, "skill", "SKILL.md"),
                join(shared, "not-there-yet", "new.md"),
                `+${join(shared, "skill")}`,
                join(shared, "skill", "*.md"),
            ]) {
                await withSettings({ [key]: [path] }, async () => {
                    await assert.rejects(
                        running.sandboxes.set(id, owner(running), true),
                        /reaches into/,
                        path,
                    );
                });
            }

            // Exclusions load nothing, and a settings change is read again at the next look.
            await withSettings({ [key]: [`!${join(shared, "skill")}`] }, async () => {
                await running.sandboxes.set(id, owner(running), true);
            });
        } finally {
            useDriver(undefined);
            await running.close();
        }
    });
}

test("a folder that a configured path holds, a package, a program, and an MCP server in the folder refuse a read-write sandbox", async () => {
    const running = await app();

    try {
        const shared = project("trusted-configured-more");
        const id = await newSession(running, shared);
        const cases: [string, unknown][] = [
            ["a directory that holds the folder", { skills: [root] }],
            ["a local package", { packages: [{ source: shared }] }],
            ["a program", { shellPath: join(shared, "shell") }],
            ["an MCP server's program", {}],
        ];

        for (const [what, settings] of cases) {
            writeFileSync(
                join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"),
                JSON.stringify(
                    what === "an MCP server's program"
                        ? { mcpServers: { tool: { command: join(shared, "server") } } }
                        : {},
                ),
            );
            await withSettings(settings, async () => {
                await assert.rejects(
                    running.sandboxes.set(id, owner(running), true),
                    /reaches into/,
                    what,
                );
            });
        }
    } finally {
        rmSync(join(process.env.PI_CODING_AGENT_DIR!, "mcp.json"), { force: true });
        useDriver(undefined);
        await running.close();
    }
});
