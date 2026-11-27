/**
 * Two source tests for host file access (design 4.2). First: `node:fs` and `node:child_process` are imported only by
 * `hostfs.ts`, the named wrappers, and the files that touch only Pocket's own data, install, config, or system
 * locations (`own` in `src/server/fs-census.json`). Second: no `git` or `gh` is started outside the one hardened
 * runner (`git.ts`, its own-folder twin `git-own.ts`, and `github.ts`).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { modulesIn } from "./fs-scan.ts";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server");
const census = JSON.parse(readFileSync(join(ROOT, "fs-census.json"), "utf8")) as {
    files: Record<string, { verdict: string; primitives: string[] }>;
};

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? walk(join(dir, entry.name))
            : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
              ? [join(dir, entry.name)]
              : [],
    );
}

/** The files as they are written: module names are read from their syntax tree, which ignores comments itself. */
const raws = new Map(walk(ROOT).map((file) => [relative(ROOT, file), readFileSync(file, "utf8")]));

/** The files with their comments cut, for the check that looks for a word with a pattern. */
const sources = new Map(
    walk(ROOT).map((file) => [
        relative(ROOT, file),
        readFileSync(file, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, ""),
    ]),
);

/** Whether the file loads one of the modules (`names`, with or without `node:`), read from its syntax tree. */
const imports = (text: string, names: string[]): boolean => {
    const loaded = [...modulesIn(text)].map((name) => name.replace(/^node:/, ""));

    return names.some((name) => loaded.includes(name.replace(/\\\//g, "/")));
};

test("fs is imported only by hostfs.ts and files of Pocket's own data", () => {
    const allowed = new Set(
        Object.entries(census.files)
            .filter(([, entry]) => ["own", "hostfs"].includes(entry.verdict))
            .map(([file]) => file),
    );
    const found = [...raws]
        .filter(([, text]) => imports(text, ["fs", "fs\\/promises"]))
        .map(([file]) => file);

    assert.deepEqual(
        found.filter((file) => !allowed.has(file)),
        [],
    );
});

test("child_process is imported only by the named spawn wrappers and files of Pocket's own programs", () => {
    const allowed = new Set(
        Object.entries(census.files)
            .filter(([, entry]) => ["own", "wrapper"].includes(entry.verdict))
            .map(([file]) => file),
    );
    const found = [...raws]
        .filter(([, text]) => imports(text, ["child_process"]))
        .map(([file]) => file);

    assert.deepEqual(
        found.filter((file) => !allowed.has(file)),
        [],
    );

    // The wrappers hold no session-folder file access: they take a `FolderRef`.
    for (const [file, entry] of Object.entries(census.files)) {
        if (entry.verdict === "wrapper") {
            assert.equal(
                entry.primitives.includes("fs"),
                false,
                `${file} is a wrapper and imports fs`,
            );
        }
    }
});

test("no git or gh is started outside the hardened runner", () => {
    const runner = new Set(["git.ts", "git-own.ts", "github.ts"]);
    const start =
        /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(\s*(?:\[?\s*)?["'`](?:[^"'`]*[\\/])?(?:git|gh)(?:\.exe)?["'`]/;
    const bare = /["'`](?:git|gh)["'`]\s*,\s*\[/;
    const problems: string[] = [];

    for (const [file, text] of sources) {
        if (runner.has(file)) {
            continue;
        }

        if (start.test(text)) {
            problems.push(`${file} starts git or gh`);
        }

        // A command list that names git as its program, handed to a spawn helper of the file's own.
        if (bare.test(text) && imports(raws.get(file) ?? "", ["child_process"])) {
            problems.push(`${file} names git or gh as a program beside child_process`);
        }
    }

    assert.deepEqual(problems, []);
});

test("hostfs exports no raw path-based file primitive: its operations take a Place", async () => {
    const fs = await import("node:fs");
    const fsp = await import("node:fs/promises");
    const hostfs = (await import("../src/server/hostfs.ts")) as Record<string, unknown>;
    const raw = new Set<unknown>(
        [...Object.values(fs), ...Object.values(fsp)].filter(
            (value) => typeof value === "function",
        ),
    );
    const problems: string[] = [];

    for (const [name, value] of Object.entries(hostfs)) {
        if (raw.has(value)) {
            problems.push(`${name} is a node:fs function re-exported`);
        }
    }

    // A function that is named like a synchronous fs call is a `Place` wrapper: it takes no path string.
    for (const name of Object.keys(hostfs).filter((each) => /Sync$/.test(each))) {
        if (!["openSync", "openNoFollowSync", "opendirSyncAt"].includes(name)) {
            problems.push(`${name} is a raw sync primitive`);
        }
    }

    assert.deepEqual(problems, []);
});
