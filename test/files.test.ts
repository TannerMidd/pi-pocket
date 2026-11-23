import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { listFiles, skipWalkDirectory } from "../src/server/files.ts";

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

test("on macOS, a walk outside git skips Library, System, and Apple media bundles, but keeps a project's Library", () => {
    const home = "/Users/alice";

    assert.equal(skipWalkDirectory(home, "", "Library", "darwin", home), true);
    // APFS is case-insensitive by default and mounts user data under /System/Volumes/Data.
    assert.equal(skipWalkDirectory(home, "", "library", "darwin", home), true);
    assert.equal(
        skipWalkDirectory("/System/Volumes/Data/Users/alice", "", "Library", "darwin", home),
        true,
    );
    assert.equal(
        skipWalkDirectory(home, "", "Library", "darwin", "/System/Volumes/Data/Users/alice"),
        true,
    );
    assert.equal(skipWalkDirectory("/", "", "Library", "darwin", home), true);
    assert.equal(skipWalkDirectory("/", "", "System", "darwin", home), true);
    assert.equal(skipWalkDirectory("/System/Volumes/Data", "", "Library", "darwin", home), true);

    for (const bundle of [
        "Photos Library.photoslibrary",
        "Old.photolibrary",
        "Music Library.musiclibrary",
        "TV Library.tvlibrary",
        "Aperture.aplibrary",
        "Archive.PHOTOSLIBRARY",
    ]) {
        assert.equal(skipWalkDirectory(home, "Pictures", bundle, "darwin", home), true, bundle);
    }

    assert.equal(skipWalkDirectory("/Users/alice/project", "", "Library", "darwin", home), false);
    assert.equal(skipWalkDirectory(home, "project", "Library", "darwin", home), false);
    assert.equal(skipWalkDirectory("/Users/alice/project", "", "System", "darwin", home), false);
});

test("on Windows, a walk outside git skips user app-data and drive-root system folders, but keeps project folders", () => {
    const home = "C:\\Users\\alice";

    assert.equal(skipWalkDirectory(home, "", "AppData", "win32", home), true);
    assert.equal(skipWalkDirectory(home, "", "appdata", "win32", home), true);
    assert.equal(skipWalkDirectory(home, "", "Application Data", "win32", home), true);
    assert.equal(skipWalkDirectory(home, "", "Local Settings", "win32", home), true);
    assert.equal(skipWalkDirectory("C:\\Users", "alice", "AppData", "win32", home), true);

    for (const systemDir of [
        "Windows",
        "ProgramData",
        "$Recycle.Bin",
        "System Volume Information",
        "Recovery",
    ]) {
        assert.equal(skipWalkDirectory("C:\\", "", systemDir, "win32", home), true, systemDir);
    }

    assert.equal(skipWalkDirectory("D:\\", "", "Windows", "win32", home), true);
    assert.equal(
        skipWalkDirectory("C:\\Users\\alice\\project", "", "Windows", "win32", home),
        false,
    );
    assert.equal(
        skipWalkDirectory("C:\\Users\\alice\\project", "", "AppData", "win32", home),
        false,
    );
    assert.equal(skipWalkDirectory("C:\\repo", "", "recovery", "win32", home), false);
});

test("on Linux, a walk outside git skips root virtual filesystems, but keeps project folders of the same name", () => {
    const home = "/home/alice";

    for (const dir of ["proc", "sys", "dev", "run"]) {
        assert.equal(skipWalkDirectory("/", "", dir, "linux", home), true, dir);
    }

    assert.equal(skipWalkDirectory("/home/alice/project", "", "dev", "linux", home), false);
    assert.equal(skipWalkDirectory("/home/alice/project", "", "proc", "linux", home), false);
    assert.equal(skipWalkDirectory("/repo", "", "sys", "linux", home), false);
    assert.equal(skipWalkDirectory("/repo", "", "run", "linux", home), false);
});

test("outside a repository, listFiles skips OS home and media folders while keeping project files", async () => {
    const fakeHome = join(root, "fake-home");

    files(fakeHome, [
        "notes/todo.md",
        "project/Library/keep.txt",
        "project/AppData/keep.txt",
        "Library/Caches/big.bin",
        "AppData/Local/cache.bin",
        "Photos.photoslibrary/database.sqlite",
        ".hidden/secret.txt",
        "node_modules/pkg/index.js",
    ]);

    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;

    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    try {
        const list = await listFiles(fakeHome);

        assert.ok(list.files.includes("notes/todo.md"));
        assert.ok(list.files.includes("project/Library/keep.txt"));
        assert.ok(list.files.includes("project/AppData/keep.txt"));
        assert.ok(!list.files.includes(".hidden/secret.txt"));
        assert.ok(!list.files.includes("node_modules/pkg/index.js"));

        if (process.platform === "darwin") {
            assert.ok(!list.files.includes("Library/Caches/big.bin"));
            assert.ok(!list.files.includes("Photos.photoslibrary/database.sqlite"));
        }

        if (process.platform === "win32") {
            assert.ok(!list.files.includes("AppData/Local/cache.bin"));
        }
    } finally {
        if (savedHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = savedHome;
        }

        if (savedProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = savedProfile;
        }
    }
});
