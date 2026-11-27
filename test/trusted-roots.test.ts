// What this server or Pi loads as code or trusted settings is not reached through a link into a folder that a guest
// writes: a read-write sandbox is refused while a link under such a place leads into the folder, and a module in such a
// folder, or that imports from one, is not loaded.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { linkInto, onSandboxedFolders } from "../src/server/confined.ts";
import { documentImports } from "../src/server/extension-document-imports.ts";
import { FakeDriver, sandboxOptions, useDriver } from "./gondolin-fake.ts";
import { cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";

after(cleanUp);

let opened = 0;

async function app() {
    useDriver(new FakeDriver());
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
