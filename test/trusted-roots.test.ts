// What this server or Pi loads as code or trusted settings is not reached through a link into a folder that a guest
// writes: a read-write sandbox is refused while a link under such a place leads into the folder, and a module in such a
// folder, or that imports from one, is not loaded.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { onSandboxedFolders } from "../src/server/confined.ts";
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
