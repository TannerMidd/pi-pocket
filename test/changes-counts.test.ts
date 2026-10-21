// Adapted from Lucas Neuhaus's issue #57 regression cases.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changesIn } from "../src/server/changes.ts";

function fixture(firstCommit = true) {
    const root = mkdtempSync(join(tmpdir(), "pocket-counts-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");

    if (firstCommit) {
        writeFileSync(join(root, "tracked.txt"), "old\n");
        git("add", "tracked.txt");
        git("commit", "-qm", "baseline");
    }

    return { root, git };
}

const counts = (files: Awaited<ReturnType<typeof changesIn>>["files"]) =>
    files
        .map(({ path, added, removed }) => ({ path, added, removed }))
        .sort((a, b) => a.path.localeCompare(b.path));

test("new text and binary counts stay correct after staging, even with a large diff and tabbed path", async (t) => {
    const { root, git } = fixture();

    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "tracked.txt"), "new\n");
    // Patch output exceeds the Git runner's buffer; summary counts must still work.
    writeFileSync(join(root, "large\tfile.txt"), `${"x".repeat(79)}\n`.repeat(16384));
    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 10]));
    const expected = [
        { path: "binary.bin", added: undefined, removed: undefined },
        { path: "large\tfile.txt", added: 16384, removed: 0 },
        { path: "tracked.txt", added: 1, removed: 1 },
    ];

    assert.deepEqual(counts((await changesIn(root, [])).files), expected);
    git("add", "-A");
    assert.deepEqual(counts((await changesIn(root, [])).files), expected);
});

test("before the first commit, staged and untracked files both have counts", async (t) => {
    const { root, git } = fixture(false);

    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "staged.txt"), "one\ntwo\n");
    git("add", "staged.txt");
    writeFileSync(join(root, "fresh.txt"), "three");
    const changes = await changesIn(root, []);

    assert.deepEqual(counts(changes.files), [
        { path: "fresh.txt", added: 1, removed: 0 },
        { path: "staged.txt", added: 2, removed: 0 },
    ]);
});
