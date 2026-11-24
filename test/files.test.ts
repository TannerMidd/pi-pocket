import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { after, test } from "node:test";
import { FileLists, listFiles, viewFile, type FileFilter } from "../src/server/files.ts";

const root = mkdtempSync(join(tmpdir(), "pocket-list-"));

after(() => rmSync(root, { recursive: true, force: true }));

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

for (const repository of [false, true]) {
    test(`a restricted ${repository ? "git list" : "walk"} prunes before counting files`, async () => {
        const dir = join(root, `filtered-${repository}`);
        const doors = new Map<string, string[]>([
            [dir, ["shared", "closed", "empty", "absent", "shared", "../bad"]],
            [join(dir, "closed"), []],
            [join(dir, "shared"), ["permitted", "ignored.txt", "denied", "tracked.txt"]],
        ]);
        const filter: FileFilter = {
            children(path) {
                assert.ok(isAbsolute(path));

                return doors.get(path);
            },
            allow(path) {
                assert.ok(isAbsolute(path));
                assert.ok(!path.includes("unseen"), `enumerated a private name: ${path}`);

                return basename(path) !== "denied";
            },
        };

        files(dir, [
            "unseen",
            "closed/unseen",
            "shared/unseen",
            "shared/permitted",
            "shared/denied",
            "shared/ignored.txt",
            "shared/tracked.txt",
        ]);
        mkdirSync(join(dir, "empty"));

        if (repository) {
            writeFileSync(join(dir, ".gitignore"), "*.txt\n");
            execFileSync("git", ["init", "-q"], { cwd: dir });
            execFileSync("git", ["add", "-f", "shared/tracked.txt"], { cwd: dir });
        }

        const expected = ["shared/permitted", "shared/tracked.txt"];

        if (!repository) {
            expected.unshift("shared/ignored.txt");
        }

        const list = await listFiles(dir, expected.length, filter);

        assert.deepEqual(list.files, expected);
        assert.equal(list.truncated, false);
        files(dir, ["closed/new", "unseen-too"]);
        assert.deepEqual(await listFiles(dir, expected.length, filter), list);
        const shorter = await listFiles(dir, 1, filter);

        assert.equal(shorter.files.length, 1);
        assert.ok(expected.includes(shorter.files[0]!));
        assert.equal(shorter.truncated, true);
        doors.set(dir, []);
        assert.deepEqual((await listFiles(dir, 0, filter)).files, []);
        assert.equal((await listFiles(dir, 0, filter)).truncated, false);
    });
}

for (const repository of [false, true]) {
    test(`an ordinary ${repository ? "Git" : "non-Git"} workspace keeps the owner's order and version`, async () => {
        const dir = join(root, `ordinary-${repository}`);
        const all: FileFilter = {
            ordinaryTree: true,
            children: () => undefined,
            allow: () => true,
        };

        files(dir, ["z", "a/src", "b/sub/deep", "b/src", "a/file", "a!/file"]);

        if (repository) {
            execFileSync("git", ["init", "-q"], { cwd: dir });
            execFileSync("git", ["add", "a"], { cwd: dir });
        }

        assert.deepEqual(await listFiles(dir, 20, all), await listFiles(dir, 20));
        const visible = await listFiles(dir, 1, {
            ...all,
            allow: (path) => path === join(dir, "a", "src"),
        });

        assert.deepEqual(visible.files, ["a/src"]);
        assert.equal(visible.truncated, false);
    });
}

test("non-Git walks apply the same visible cap without creating a large fixture", async (t) => {
    const dir = join(root, "synthetic-large");

    mkdirSync(dir);
    const open = t.mock.method(fs, "opendir", async (path: string) => {
        assert.equal(path, dir);

        return (async function* () {
            for (let i = 0; i < 50_100; i++) {
                yield { name: String(i).padStart(5, "0"), isDirectory: () => false };
            }
        })();
    });

    syncBuiltinESMExports();

    try {
        const owner = await listFiles(dir);
        const restricted = await listFiles(dir, undefined, {
            children: () => undefined,
            allow: () => true,
        });

        assert.equal(owner.files.length, 50_000);
        assert.equal(owner.truncated, true);
        assert.deepEqual(restricted, owner);
    } finally {
        open.mock.restore();
        syncBuiltinESMExports();
    }
});

test("ordinary Git still stops checking names when its evaluation budget expires", async (t) => {
    const dir = join(root, "ordinary-budget");
    let now = Date.now();

    files(dir, ["a", "b", "c"]);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    t.mock.method(Date, "now", () => now);
    let examined = 0;
    const list = await listFiles(dir, 10, {
        ordinaryTree: true,
        children: () => undefined,
        allow: () => {
            now += 60_000;
            examined++;

            return true;
        },
    });

    assert.equal(examined, 1);
    assert.deepEqual(list.files, ["a"]);
    assert.equal(list.truncated, true);
});

test("a folder view counts only visible children, including when more than 1000 names are hidden", async () => {
    const dir = join(root, "view");
    const hidden = Array.from({ length: 1100 }, (_, i) => `private-${i}`);

    files(dir, [...hidden, "one.txt", "project/source"]);

    const allow = (path: string) => {
        assert.ok(isAbsolute(path));

        return !basename(path).startsWith("private-");
    };

    assert.deepEqual(await viewFile(dir, allow), {
        kind: "folder",
        entries: [
            { name: "project", dir: true },
            { name: "one.txt", dir: false },
        ],
        truncated: false,
    });
    assert.deepEqual(await viewFile(dir, () => false), {
        kind: "folder",
        entries: [],
        truncated: false,
    });
    const list = await listFiles(dir, 2, { allow, children: () => undefined });

    assert.deepEqual(list.files, ["one.txt", "project/source"]);
    assert.equal(list.truncated, false);
    const full = await viewFile(dir, () => true);

    assert.ok(full.kind === "folder" && full.entries.length === 1000 && full.truncated);
});

test("restricted requests use fresh grants and filesystem state; unrestricted requests share the cache", async () => {
    const dir = join(root, "cache");
    const cache = new FileLists(() => 100);
    let grant = true;
    const filter: FileFilter = { allow: () => grant, children: () => undefined };

    files(dir, ["one"]);
    const owner = cache.get(dir);

    assert.equal(cache.get(dir), owner);
    assert.deepEqual((await owner).files, ["one"]);
    assert.deepEqual((await cache.get(dir, filter)).files, ["one"]);
    grant = false;
    assert.deepEqual((await cache.get(dir, filter)).files, []);
    files(dir, ["two"]);
    grant = true;
    assert.deepEqual((await cache.get(dir, filter)).files, ["one", "two"]);
    assert.equal(cache.get(dir), owner);
    assert.deepEqual((await owner).files, ["one"]);
});
