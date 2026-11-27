// The guest can swap a folder for a link at any moment, so the host never checks a path and then uses it. Each test
// swaps `race/` for a link to a folder outside, at the instant before the host first opens something under it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { revertFile } from "../src/server/changes.ts";
import {
    onSandboxedFolders,
    openInside,
    readInsideSync,
    writeInside,
} from "../src/server/confined.ts";
import { viewFile } from "../src/server/files.ts";
import { createWorktree } from "../src/server/worktrees.ts";

const SECRET = "OUTSIDE_SECRET_MARKER_42";
const made: string[] = [];

after(() => {
    for (const path of made) {
        rmSync(path, { recursive: true, force: true });
    }
});

function scratch(): string {
    const path = realpathSync(mkdtempSync(join(tmpdir(), "pocket-race-")));

    made.push(path);

    return path;
}

/** A folder `folder/race` with `file`, and a folder `outside` that has the same file with the secret in it. */
function layout(file: string): { folder: string; outside: string } {
    const base = scratch();
    const folder = join(base, "folder");
    const outside = join(base, "outside");

    for (const [path, text] of [
        [join(folder, "race"), `inside ${file}\n`],
        [outside, `${SECRET}\n`],
    ] as const) {
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, file), text);
    }

    return { folder, outside };
}

/** Before the first call that names a path under `race/`, swap `race/` for a link to `outside`. */
function swapBeforeUse(folder: string, outside: string): () => void {
    const race = join(folder, "race");
    let swapped = false;

    const wrap = (
        target: Record<string, unknown>,
        name: string,
        saved: [object, string, unknown][],
    ) => {
        const original = target[name] as (...args: unknown[]) => unknown;

        saved.push([target, name, original]);

        target[name] = function (this: unknown, ...args: unknown[]) {
            if (!swapped && typeof args[0] === "string" && /\/race(\/[^/]*)?$/.test(args[0])) {
                swapped = true;
                renameSync(race, `${race}.moved`);
                symlinkSync(outside, race);
            }

            return original.apply(this, args);
        };
    };

    const saved: [object, string, unknown][] = [];

    for (const name of ["openSync", "unlinkSync", "renameSync"]) {
        wrap(fs as never, name, saved);
    }

    for (const name of ["open", "opendir", "rm", "copyFile", "unlink"]) {
        wrap(fsp as never, name, saved);
    }

    syncBuiltinESMExports();

    return () => {
        for (const [target, name, original] of saved) {
            (target as Record<string, unknown>)[name] = original;
        }

        syncBuiltinESMExports();
    };
}

test("a folder swapped for a link while a sandboxed folder is listed does not list the outside folder", async () => {
    const { folder, outside } = layout("only-outside-or-inside.txt");
    const stop = onSandboxedFolders((used) => used === folder);
    const restore = swapBeforeUse(folder, outside);

    try {
        const view = await viewFile(join(folder, "race"), undefined, folder).catch(
            (error: unknown) => error,
        );

        assert.ok(view instanceof Error, "the listing went on after the swap");
        assert.match(view.message, /not followed/);
    } finally {
        restore();
        stop();
    }
});

test("a folder swapped for a link while a file of a sandboxed folder is opened does not open the outside file", async () => {
    const { folder, outside } = layout("file.txt");
    const stop = onSandboxedFolders((used) => used === folder);
    const restore = swapBeforeUse(folder, outside);

    try {
        await assert.rejects(openInside(folder, join(folder, "race", "file.txt")), /not followed/);
    } finally {
        restore();
        stop();
    }
});

test("a folder swapped for a link while a file is written does not write outside the sandboxed folder", () => {
    const { folder, outside } = layout("out.txt");
    const stop = onSandboxedFolders((used) => used === folder);
    const restore = swapBeforeUse(folder, outside);

    try {
        assert.throws(
            () =>
                writeInside(folder, join(folder, "race", "out.txt"), Buffer.from("written"), 0o644),
            /not followed/,
        );
        assert.equal(readFileSync(join(outside, "out.txt"), "utf8"), `${SECRET}\n`);
        assert.deepEqual(readdirSync(outside), ["out.txt"]);
    } finally {
        restore();
        stop();
    }
});

function repository(): { folder: string; outside: string } {
    const { folder, outside } = layout("new.txt");
    const run = (...args: string[]) =>
        execFileSync("git", args, {
            cwd: folder,
            env: {
                ...process.env,
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_SYSTEM: "/dev/null",
                GIT_AUTHOR_NAME: "t",
                GIT_AUTHOR_EMAIL: "t@example.com",
                GIT_COMMITTER_NAME: "t",
                GIT_COMMITTER_EMAIL: "t@example.com",
            },
        });

    writeFileSync(join(folder, "kept.txt"), "kept\n");
    run("init", "-q", "-b", "main");
    run("add", "kept.txt");
    run("commit", "-q", "-m", "first");

    return { folder, outside };
}

test("undo of a new file, in a folder swapped for a link, does not delete outside the sandboxed folder", async () => {
    const { folder, outside } = repository();
    const stop = onSandboxedFolders((used) => used === folder);
    const restore = swapBeforeUse(folder, outside);

    try {
        await revertFile(folder, "race/new.txt").catch(() => undefined);
        assert.ok(lstatSync(join(folder, "race")).isSymbolicLink(), "the swap did not run");
        assert.ok(existsSync(join(outside, "new.txt")), "a file outside the folder was deleted");
    } finally {
        restore();
        stop();
    }
});

test("undo in a sandboxed folder puts a changed, a deleted, and an executable file back, by blob", async () => {
    const { folder } = repository();

    writeFileSync(join(folder, "script.sh"), "#!/bin/sh\n");
    execFileSync("chmod", ["755", "script.sh"], { cwd: folder });
    execFileSync("git", ["add", "script.sh"], { cwd: folder });
    execFileSync("git", ["commit", "-q", "-m", "script"], {
        cwd: folder,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@e",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@e",
        },
    });
    const stop = onSandboxedFolders((used) => used === folder);

    try {
        writeFileSync(join(folder, "kept.txt"), "changed\n");
        rmSync(join(folder, "script.sh"));
        await revertFile(folder, "kept.txt");
        await revertFile(folder, "script.sh");
        assert.equal(readFileSync(join(folder, "kept.txt"), "utf8"), "kept\n");
        assert.equal(readFileSync(join(folder, "script.sh"), "utf8"), "#!/bin/sh\n");
        assert.equal(fs.statSync(join(folder, "script.sh")).mode & 0o111, 0o111);
        assert.equal(
            execFileSync("git", ["status", "--porcelain"], { cwd: folder }).toString(),
            "?? race/\n",
        );
    } finally {
        stop();
    }
});

test("a folder swapped for a link while a worktree copies new files does not copy a file from outside", async () => {
    const { folder, outside } = repository();
    const trees = scratch();
    const stop = onSandboxedFolders((used) => used === folder);
    const restore = swapBeforeUse(folder, outside);

    try {
        await createWorktree(folder, trees, "race").catch(() => undefined);

        const copied = (path: string): string[] =>
            readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
                entry.name === ".git"
                    ? []
                    : entry.isDirectory()
                      ? copied(join(path, entry.name))
                      : [readFileSync(join(path, entry.name), "utf8")],
            );

        assert.ok(lstatSync(join(folder, "race")).isSymbolicLink(), "the swap did not run");
        assert.ok(
            !copied(trees).some((text) => text.includes(SECRET)),
            "a file from outside the folder was copied",
        );
    } finally {
        restore();
        stop();
    }
});

test("where the system has no way to open a name inside a folder safely, a sandboxed folder is not read", async () => {
    const { folder } = layout("file.txt");
    const stop = onSandboxedFolders((used) => used === folder);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
        const file = join(folder, "race", "file.txt");

        await assert.rejects(viewFile(file, undefined, folder), /cannot open a name inside/);
        await assert.rejects(openInside(folder, file), /cannot open a name inside/);
        assert.throws(() => readInsideSync(folder, file), /cannot open a name inside/);
        assert.throws(
            () => writeInside(folder, file, Buffer.from("x"), 0o644),
            /cannot open a name inside/,
        );
    } finally {
        Object.defineProperty(process, "platform", platform);
        stop();
    }
});
