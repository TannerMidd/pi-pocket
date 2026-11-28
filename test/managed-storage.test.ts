import assert from "node:assert/strict";
import fs, {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ManagedStorage, type ManagedFolderProof } from "../src/server/managed-storage.ts";

function fixture(t: TestContext): string {
    const sandbox = mkdtempSync(join(tmpdir(), "pocket-storage-id-"));

    t.after(() => rmSync(sandbox, { recursive: true, force: true }));

    return join(realpathSync.native(sandbox), "data");
}

for (const scope of ["data", "store", "session"]) {
    test(`a storage check requires the initialized ${scope} directory`, (t) => {
        const data = fixture(t);
        const store = join(data, "uploads");
        const session = join(store, "12");

        mkdirSync(session, { recursive: true });
        const storage = new ManagedStorage(data);

        assert.equal(storage.uploadFolder(12), session, "existing installations");
        assert.equal(storage.uploadFolder(13), undefined);
        assert.equal(storage.uploadFolder(13, true), join(store, "13"), "new uploads");
        mkdirSync(join(store, "14"));
        assert.throws(() => storage.uploadFolder(14, true), /expected/);
        const proof = storage.capture("uploads", "12");
        const path = scope === "data" ? data : scope === "store" ? store : session;

        assert.equal(proof.state, "verified");

        renameSync(path, path + ".original");
        mkdirSync(session, { recursive: true });
        const sentinel = join(session, "sentinel");

        writeFileSync(sentinel, "unrelated fixture");
        assert.throws(() => storage.uploadFolder(12), /expected/);
        assert.throws(() => storage.uploadFolder(12, true), /expected/);
        const changed = storage.capture("uploads", "12");
        const restarted = new ManagedStorage(data);

        assert.equal(changed.state, "changed");
        assert.throws(() => restarted.verifiedFolder("uploads", "12", proof), /expected/);
        assert.throws(() => restarted.verifiedFolder("uploads", "12", changed), /expected/);
        assert.equal(readFileSync(sentinel, "utf8"), "unrelated fixture");
    });
}

for (const ancestor of ["data", "store"]) {
    test(`a new ${ancestor} directory invalidates otherwise unchanged scope`, (t) => {
        const data = fixture(t);
        const store = join(data, "background");
        const folder = join(store, "12");

        mkdirSync(folder, { recursive: true });
        const storage = new ManagedStorage(data);
        const present = storage.capture("background", "12");
        const absent = storage.capture("background", "13");
        const path = ancestor === "data" ? data : store;

        renameSync(path, path + ".original");
        mkdirSync(path);
        const child = ancestor === "data" ? "background" : "12";

        renameSync(join(path + ".original", child), join(path, child));
        const restarted = new ManagedStorage(data);

        assert.equal(restarted.folder("background", "12"), folder);
        assert.throws(() => restarted.verifiedFolder("background", "12", present), /expected/);
        assert.throws(() => restarted.verifiedFolder("background", "13", absent), /expected/);
        renameSync(folder, folder + ".original");
        assert.throws(() => restarted.verifiedFolder("background", "12", present), /expected/);
    });
}

test("a proof survives a restart, but still needs this process's pins", (t) => {
    const data = fixture(t);

    mkdirSync(data);
    const early = new ManagedStorage(data);
    const writer = new ManagedStorage(data);
    const folder = writer.uploadFolder(12, true)!;
    const proof: ManagedFolderProof = JSON.parse(JSON.stringify(writer.capture("uploads", "12")));
    const unknown = early.capture("uploads", "12");
    const restarted = new ManagedStorage(data);

    assert.equal(unknown.state, "unknown");
    assert.throws(() => early.verifiedFolder("uploads", "12", proof), /expected/);
    assert.throws(() => restarted.verifiedFolder("uploads", "12", unknown), /expected/);
    assert.equal(restarted.verifiedFolder("uploads", "12", proof), folder);

    renameSync(folder, folder + ".original");
    assert.equal(restarted.verifiedFolder("uploads", "12", proof), undefined);
    assert.equal(new ManagedStorage(data).verifiedFolder("uploads", "12", proof), undefined);
    mkdirSync(folder);
    const differentPin = new ManagedStorage(data);

    renameSync(folder, folder + ".other");
    assert.throws(() => differentPin.verifiedFolder("uploads", "12", proof), /expected/);
});

test("an absent scope cannot authorize a new folder or another scope", (t) => {
    const data = fixture(t);

    mkdirSync(data);
    const storage = new ManagedStorage(data);
    const proof = storage.capture("uploads", "12");

    assert.equal(proof.state, "absent");
    assert.equal(storage.verifiedFolder("uploads", "12", proof), undefined);
    assert.throws(() => storage.verifiedFolder("uploads", "13", proof), /expected/);
    assert.throws(() => storage.verifiedFolder("background", "12", proof), /expected/);
    storage.uploadFolder(12, true);
    const restarted = new ManagedStorage(data);

    assert.throws(() => restarted.verifiedFolder("uploads", "12", proof), /expected/);
    const verified = restarted.capture("uploads", "12");
    const moved = data + ".moved";

    renameSync(data, moved);
    assert.throws(
        () => new ManagedStorage(moved).verifiedFolder("uploads", "12", verified),
        /expected/,
    );
});

test("unavailable birth times do not count as persistent identity or a detected change", (t) => {
    const data = fixture(t);
    const root = join(data, "uploads");
    const folder = join(root, "12");

    mkdirSync(folder, { recursive: true });
    const storage = new ManagedStorage(data);
    const proof = storage.capture("uploads", "12");
    const original = fs.lstatSync;
    let weak = data;
    const mock = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof original>) => {
        const stat = original(...args);

        if (args[0] === weak && stat && "birthtimeNs" in stat) {
            stat.birthtimeNs = 0n;
        }

        return stat;
    });

    syncBuiltinESMExports();
    t.after(() => {
        mock.mock.restore();
        syncBuiltinESMExports();
    });

    for (weak of [data, root, folder]) {
        assert.equal(storage.capture("uploads", "12").state, "unknown");
        assert.equal(new ManagedStorage(data).capture("uploads", "12").state, "unknown");
        assert.throws(() => storage.verifiedFolder("uploads", "12", proof), /expected/);
    }
});

test("legacy and malformed proofs cannot even confirm absence", (t) => {
    const data = fixture(t);

    mkdirSync(data);
    const storage = new ManagedStorage(data);
    const scope = storage.capture("uploads", "12");

    assert.equal(scope.state, "absent");

    for (const malformed of [
        undefined,
        null,
        {},
        { state: "absent" },
        { ...scope, version: 2 },
        { ...scope, rootId: undefined },
        { ...scope, dataId: "0:1:2" },
        { ...scope, state: "verified" },
        { ...scope, state: "verified", childId: "1:2:0" },
        { ...scope, childId: "1:2:3" },
    ]) {
        assert.throws(
            () =>
                storage.verifiedFolder(
                    "uploads",
                    "12",
                    malformed as ManagedFolderProof | undefined,
                ),
            /expected/,
        );
    }

    assert.equal(storage.capture("worktrees", "..").state, "unknown");
});
