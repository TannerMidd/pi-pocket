// Overlap of session folders: by stated path, and by device and inode, so an alias or a link counts (invariant I1).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { foldersOverlap, within } from "../src/server/folder-overlap.ts";

const base = mkdtempSync(join(tmpdir(), "pi-pocket-overlap-"));

after(() => rmSync(base, { recursive: true, force: true }));

test("a folder overlaps itself, what it holds, and what holds it, by name", () => {
    assert.equal(within("/a/b", "/a/b/c"), true);
    assert.equal(within("/a/b", "/a/bc"), false);
    assert.equal(foldersOverlap("/a/b", "/a/b"), true);
    assert.equal(foldersOverlap("/a/b", "/a/b/c/d"), true);
    assert.equal(foldersOverlap("/a/b/c", "/a/b"), true);
    assert.equal(foldersOverlap("/a/b", "/a/c"), false);
});

test("an alias, a link into a folder, and a nested folder reached by a link overlap the real folder", () => {
    const project = join(base, "project");
    const sub = join(project, "sub");
    const elsewhere = join(base, "elsewhere");

    mkdirSync(sub, { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(project, join(base, "alias"));
    symlinkSync(sub, join(elsewhere, "to-sub"));

    assert.equal(foldersOverlap(join(base, "alias"), project), true, "an alias is the folder");
    assert.equal(foldersOverlap(join(base, "alias", "sub"), project), true);
    assert.equal(
        foldersOverlap(join(elsewhere, "to-sub"), project),
        true,
        "a link into the folder is inside it",
    );
    assert.equal(foldersOverlap(project, join(elsewhere, "to-sub")), true);
    assert.equal(foldersOverlap(elsewhere, join(base, "unrelated")), false);
    assert.equal(
        foldersOverlap(join(base, "missing", "x"), project),
        false,
        "a folder not there overlaps only by name",
    );
});
