import { cleanUp, newSession, openApp, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { filePolicy } from "../src/server/file-policy.ts";

after(() => cleanUp());

test("the same protected-name classification applies to previews and reads", async () => {
    const app = await openApp(scriptedModel(), join(root, "readable-data"));

    try {
        const id = await newSession(app);
        const guest = app.config.addUser("Gale", "guest").user;
        const spelled = [
            join(root, "AGENT", "sample.txt"),
            join(root, "READABLE-DATA", "sample.txt"),
            join(root, "READABLE-DATA", "UPLOADS", "42", "sample.txt"),
        ];
        const note = join(work, "note.txt");

        for (const file of [...spelled, note]) {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, "x");
        }

        for (const file of spelled) {
            assert.throws(() => app.workspace.readableFile(guest, id, file), { status: 404 });
            assert.throws(() => app.workspace.conversationFile(guest, id, file), { status: 404 });
        }

        assert.equal(app.workspace.readableFile(guest, id, note), note);
    } finally {
        await app.close();
    }
});

test("an unexpected data directory grants neither upload paths nor transferable references", async () => {
    const dataDir = join(root, "other-data");
    const sample = join(dataDir, "uploads", "17", "sample.txt");

    mkdirSync(dirname(sample), { recursive: true });
    writeFileSync(sample, "sample");
    const policy = filePolicy({
        dataDir,
        canonicalDataDir: join(root, "original-data"),
        managedStorage: {
            root: () => assert.fail("unexpected root"),
            uploadFolder: () => undefined,
        },
        agentDir: join(root, "agent"),
        cwd: root,
        session: "17",
        ancestors: new Set(),
        inherited: [],
        unrestrictedWorkspace: true,
    });

    assert.equal(policy.file(sample), undefined);
    assert.equal(await policy.grant("17/sample.txt"), undefined);
    assert.deepEqual(policy.children(dataDir), []);
});

test("a file policy checks current folder identity on each use", async () => {
    const dataDir = join(root, "identity-data");
    const uploads = join(dataDir, "uploads");
    const folder = join(uploads, "17");
    const sample = join(folder, "sample.txt");
    let present = true;

    mkdirSync(folder, { recursive: true });
    writeFileSync(sample, "example");
    const policy = filePolicy({
        dataDir,
        canonicalDataDir: dataDir,
        managedStorage: { root: () => uploads, uploadFolder: () => (present ? folder : undefined) },
        agentDir: join(root, "agent"),
        cwd: root,
        session: "17",
        ancestors: new Set(),
        inherited: [],
        unrestrictedWorkspace: true,
    });

    assert.equal(policy.file(sample), sample);
    assert.deepEqual(policy.children(uploads), ["17"]);
    present = false;
    assert.equal(policy.file(sample), undefined);
    assert.deepEqual(policy.children(uploads), []);
    assert.equal(await policy.allow(sample), false);
});
