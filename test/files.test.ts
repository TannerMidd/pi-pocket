import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { listFiles } from "../src/server/files.ts";

after(() => cleanUp());

/** Make the files at `paths` (each holding its own name) under `dir`. */
function files(dir: string, paths: string[]): void {
    for (const path of paths) {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), path);
    }
}

test("in a repository, the list is git's: tracked and untracked files, not ignored ones, relative to the folder", async () => {
    const repo = join(root, "mention-repo");

    files(repo, [
        ".gitignore",
        "README.md",
        "src/app.ts",
        "src/deep/util.ts",
        "build/out.js",
        "notes.txt",
    ]);
    writeFileSync(join(repo, ".gitignore"), "build/\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });

    git("init", "-q");
    git("add", ".gitignore", "README.md", "src");
    const list = await listFiles(repo);

    assert.deepEqual(list.files.sort(), [
        ".gitignore",
        "README.md",
        "notes.txt",
        "src/app.ts",
        "src/deep/util.ts",
    ]);
    assert.equal(list.truncated, false);
    // From a folder inside the repository: its own files, relative to it.
    assert.deepEqual((await listFiles(join(repo, "src"))).files.sort(), ["app.ts", "deep/util.ts"]);
});
