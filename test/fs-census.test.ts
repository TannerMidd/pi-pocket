/**
 * The census of host file and process access (`src/server/fs-census.json`, `docs/design/sandbox-v2-census.md`): which
 * files may import `node:fs`, `node:fs/promises`, and `node:child_process`, and what each is for. Host code that touches
 * a session's folder goes through `hostfs.ts` (a descriptor walk where a sandboxed tree works), so this test fails on a
 * file that imports a primitive and is not listed, a listed file that no longer does, and a `convert` or `split` file that
 * still does. It also catches the other ways in: `createRequire`, `process.getBuiltinModule`, `process.binding`,
 * packages that wrap fs or spawn, and calls into Pi's own loaders, which read the paths they are given.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server");

type Entry = {
    verdict: "own" | "wrapper" | "hostfs" | "convert" | "split";
    primitives: string[];
    source: string;
};
type Census = {
    files: Record<string, Entry>;
    indirect: Record<string, { verdict: string; reaches: string }>;
    escapes: Record<string, Record<string, string>>;
    loaders: { pattern: string; allowed: string[] };
    packages: { banned: string[]; capable: Record<string, string[]> };
};

const census = JSON.parse(readFileSync(join(ROOT, "fs-census.json"), "utf8")) as Census;

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? walk(join(dir, entry.name))
            : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
              ? [join(dir, entry.name)]
              : [],
    );
}

/** The source without its comments, so a sentence that quotes an import is not one. */
function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const sources = new Map(
    walk(ROOT).map((file) => [relative(ROOT, file), code(readFileSync(file, "utf8"))] as const),
);

/** The modules a file loads: `import … from`, `export … from`, `import "…"`, `import("…")`, and `require("…")`. */
function modulesOf(text: string): Set<string> {
    const found = new Set<string>();

    for (const pattern of [
        /\b(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/g,
        /\bimport\s*["']([^"']+)["']/g,
        /\bimport\s*\(\s*["']([^"']+)["']/g,
        /\brequire\s*\(\s*["']([^"']+)["']/g,
    ]) {
        for (const match of text.matchAll(pattern)) {
            found.add(match[1]!);
        }
    }

    return found;
}

const PRIMITIVES: Record<string, string> = {
    fs: "fs",
    "node:fs": "fs",
    "fs/promises": "fs/promises",
    "node:fs/promises": "fs/promises",
    child_process: "child_process",
    "node:child_process": "child_process",
};

const primitivesOf = (text: string): string[] =>
    [...new Set([...modulesOf(text)].flatMap((name) => PRIMITIVES[name] ?? []))].sort();

test("the census lists every importer of fs, fs/promises, and child_process, and no stale entry", () => {
    const actual = new Map(
        [...sources].flatMap(([file, text]) => {
            const found = primitivesOf(text);

            return found.length === 0 ? [] : [[file, found] as const];
        }),
    );
    const problems: string[] = [];

    for (const [file, found] of actual) {
        const entry = census.files[file];

        if (entry === undefined) {
            problems.push(`${file} imports ${found.join(", ")} and is not in the census`);
        } else if (entry.verdict === "convert" || entry.verdict === "split") {
            problems.push(
                `${file} is ${entry.verdict} and still imports ${found.join(", ")}: its file access goes through hostfs`,
            );
        } else if (JSON.stringify(entry.primitives) !== JSON.stringify(found)) {
            problems.push(
                `${file} imports ${found.join(", ")}; the census says ${entry.primitives.join(", ")}`,
            );
        }
    }

    for (const [file, entry] of Object.entries(census.files)) {
        if (!sources.has(file)) {
            problems.push(`${file} is in the census and is not a file`);
        } else if (
            (entry.verdict === "own" ||
                entry.verdict === "wrapper" ||
                entry.verdict === "hostfs") &&
            !actual.has(file)
        ) {
            problems.push(
                `${file} is ${entry.verdict} but imports no primitive: the entry is stale`,
            );
        }

        if (!["own", "wrapper", "hostfs", "convert", "split"].includes(entry.verdict)) {
            problems.push(`${file} has the verdict ${entry.verdict}`);
        }
    }

    assert.deepEqual(problems, []);
});

test("the census has the sizes the design names", () => {
    const counts: Record<string, number> = {};

    for (const entry of Object.values(census.files)) {
        counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1;
    }

    // 77 at the base: 41 own, 23 convert, 10 split, 3 wrapper. `no-follow.ts` folded into `hostfs.ts`, `processes.ts` is
    // a named wrapper, and `hostfs.ts` and `git-own.ts` are new.
    assert.deepEqual(counts, { own: 41, convert: 22, split: 9, wrapper: 5, hostfs: 1 });
    assert.equal(Object.keys(census.files).length, 78);
});

test("each indirect user exists and imports no primitive", () => {
    for (const file of Object.keys(census.indirect)) {
        const text = sources.get(file);

        assert.notEqual(text, undefined, `${file} is not a file`);

        if (census.indirect[file]!.verdict !== "own") {
            assert.deepEqual(primitivesOf(text!), [], `${file} imports a primitive`);
        }
    }
});

test("createRequire, getBuiltinModule, process.binding, and dlopen are used only where the census says", () => {
    const patterns: Record<string, RegExp> = {
        createRequire: /\bcreateRequire\b/,
        getBuiltinModule: /\bgetBuiltinModule\b/,
        binding: /\bprocess\s*\.\s*binding\b/,
        dlopen: /\bdlopen\b/,
    };
    const problems: string[] = [];

    for (const [name, pattern] of Object.entries(patterns)) {
        const allowed = census.escapes[name] ?? {};

        for (const [file, text] of sources) {
            if (pattern.test(text) && !(file in allowed)) {
                problems.push(`${file} uses ${name} and the census does not allow it`);
            }
        }

        for (const file of Object.keys(allowed)) {
            if (!pattern.test(sources.get(file) ?? "")) {
                problems.push(`${file} is listed for ${name} and no longer uses it`);
            }
        }
    }

    assert.deepEqual(problems, []);
});

test("Pi's loaders, which read the paths they are given, are called only on a snapshot", () => {
    const pattern = new RegExp(`\\b(?:${census.loaders.pattern})\\s*\\(`);
    const callers = [...sources].filter(([, text]) => pattern.test(text)).map(([file]) => file);

    assert.deepEqual(callers.sort(), [...census.loaders.allowed].sort());
});

test("no package that wraps fs or spawn is imported, except where the census names it", () => {
    const problems: string[] = [];

    for (const [file, text] of sources) {
        for (const name of modulesOf(text)) {
            const bare = name.startsWith("@")
                ? name.split("/").slice(0, 2).join("/")
                : name.split("/")[0]!;

            if (census.packages.banned.includes(bare)) {
                problems.push(`${file} imports ${name}, which wraps fs or spawn`);
            }

            const allowed = census.packages.capable[bare];

            if (allowed !== undefined && !allowed.includes(file)) {
                problems.push(`${file} imports ${name}, which is not in the census for it`);
            }
        }
    }

    for (const [name, files] of Object.entries(census.packages.capable)) {
        for (const file of files) {
            const imports = [...modulesOf(sources.get(file) ?? "")].some(
                (each) => each === name || each.startsWith(`${name}/`),
            );

            if (!imports) {
                problems.push(`${file} is listed for ${name} and no longer imports it`);
            }
        }
    }

    assert.deepEqual(problems, []);
});
