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
import ts from "typescript";
import { type Facts, factsIn, modulesIn } from "./fs-scan.ts";

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
    dynamicImport: Record<string, string>;
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

/** The files as they are written. Every check reads their syntax tree, which has no comments or strings in its code. */
const raws = new Map(
    walk(ROOT).map((file) => [relative(ROOT, file), readFileSync(file, "utf8")] as const),
);

const modulesOf = modulesIn;

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
        [...raws].flatMap(([file, text]) => {
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
        if (!raws.has(file)) {
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
        const text = raws.get(file);

        assert.notEqual(text, undefined, `${file} is not a file`);

        if (census.indirect[file]!.verdict !== "own") {
            assert.deepEqual(primitivesOf(text!), [], `${file} imports a primitive`);
        }
    }
});

/** Whether a file uses the escape `name`: as a name, or as a member of `process`. */
const escapes: Record<string, (facts: Facts) => boolean> = {
    createRequire: (facts) => facts.names.has("createRequire"),
    getBuiltinModule: (facts) => facts.names.has("getBuiltinModule"),
    binding: (facts) => facts.members.has("process.binding"),
    dlopen: (facts) => facts.names.has("dlopen"),
};

const factsOf = new Map([...raws].map(([file, text]) => [file, factsIn(text)] as const));
const loaderNames = () => new Set(census.loaders.pattern.split("|"));

test("createRequire, getBuiltinModule, process.binding, and dlopen are used only where the census says", () => {
    const problems: string[] = [];

    for (const [name, uses] of Object.entries(escapes)) {
        const allowed = census.escapes[name] ?? {};

        for (const [file, facts] of factsOf) {
            if (uses(facts) && !(file in allowed)) {
                problems.push(`${file} uses ${name} and the census does not allow it`);
            }
        }

        for (const file of Object.keys(allowed)) {
            if (!uses(factsOf.get(file) ?? factsIn(""))) {
                problems.push(`${file} is listed for ${name} and no longer uses it`);
            }
        }
    }

    assert.deepEqual(problems, []);
});

test("Pi's loaders, which read the paths they are given, are called only on a snapshot", () => {
    const callers = [...factsOf]
        .filter(([, facts]) => facts.calls.some((call) => loaderNames().has(call.name)))
        .map(([file]) => file);

    assert.deepEqual(callers.sort(), [...census.loaders.allowed].sort());
});

test("the escape and loader checks read the syntax: a string with comment markers hides nothing", () => {
    const hide = (code: string) => `const open = "/*";\n${code}\nconst close = "*/";\n`;

    assert.equal(escapes.binding!(factsIn(hide("process.binding('fs');"))), true);
    assert.equal(escapes.binding!(factsIn(hide("process['binding']('fs');"))), true);
    assert.equal(escapes.getBuiltinModule!(factsIn(hide("process.getBuiltinModule('fs');"))), true);
    assert.equal(escapes.createRequire!(factsIn(hide("createRequire(import.meta.url);"))), true);
    assert.equal(escapes.dlopen!(factsIn(hide("process.dlopen(m, 'x');"))), true);
    assert.equal(
        factsIn(hide("loadSkillsFromDir({ dir });")).calls.some((call) =>
            loaderNames().has(call.name),
        ),
        true,
    );
    assert.equal(
        factsIn(hide("loadProjectContextFiles({ cwd });")).calls.some((call) =>
            loaderNames().has(call.name),
        ),
        true,
    );
    // A word in a string or a comment is not a use.
    assert.equal(
        escapes.binding!(factsIn("const t = 'process.binding'; // process.binding()")),
        false,
    );
    assert.equal(
        factsIn("const t = 'loadSkills('; /* loadSkills() */").calls.some((call) =>
            loaderNames().has(call.name),
        ),
        false,
    );
});

test("no package that wraps fs or spawn is imported, except where the census names it", () => {
    const problems: string[] = [];

    for (const [file, text] of raws) {
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
            const imports = [...modulesOf(raws.get(file) ?? "")].some(
                (each) => each === name || each.startsWith(`${name}/`),
            );

            if (!imports) {
                problems.push(`${file} is listed for ${name} and no longer imports it`);
            }
        }
    }

    assert.deepEqual(problems, []);
});

/**
 * Every `import(…)` and `require(…)` call of a source file, read with the TypeScript compiler (not a pattern): whether its
 * one argument is a single plain string literal. A template with a placeholder, a concatenation, or a name is not.
 */
export function loadsOf(text: string): { literal: boolean; text: string }[] {
    const file = ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest, true);
    const found: { literal: boolean; text: string }[] = [];

    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
            const argument = node.arguments[0];

            found.push({
                literal:
                    node.arguments.length === 1 &&
                    argument !== undefined &&
                    (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)),
                text: node.getText(file),
            });
        }

        ts.forEachChild(node, visit);
    };

    visit(file);

    return found;
}

test("the dynamic-load check reads the syntax: a placeholder, a concatenation, and a name are not literals", () => {
    const flagged = (code: string) => loadsOf(code).filter((each) => !each.literal).length;

    assert.equal(flagged('await import("node:fs");'), 0);
    assert.equal(flagged("await import(`node:fs`);"), 0);
    assert.equal(flagged('const fs = require("node:fs");'), 0);
    assert.equal(flagged('await import(`node:${"fs"}`);'), 1);
    assert.equal(flagged('await import("node:" + "fs");'), 1);
    assert.equal(flagged("await import(name);"), 1);
    assert.equal(flagged("require(name);"), 1);
    assert.equal(flagged('await import("a", { with: { type: "json" } });'), 1);
    assert.equal(flagged("// import(`node:${x}`)\nconst text = 'import(name)';"), 0);
});

test("import() and require() take a single string literal, except where the census says", () => {
    const problems: string[] = [];
    const raw = (file: string) => readFileSync(join(ROOT, file), "utf8");

    for (const file of raws.keys()) {
        const open = loadsOf(raw(file)).filter((each) => !each.literal);

        if (open.length > 0 && !(file in census.dynamicImport)) {
            problems.push(
                `${file} loads a module by a name that is not a literal: ${open[0]!.text}`,
            );
        }
    }

    for (const file of Object.keys(census.dynamicImport)) {
        if (!loadsOf(raw(file)).some((each) => !each.literal)) {
            problems.push(`${file} is listed for dynamic import and no longer has one`);
        }
    }

    assert.deepEqual(problems, []);
});

test("a module is read by its decoded name: backticks and escapes are the same module", () => {
    const primitives = (code: string) => primitivesOf(code);

    assert.deepEqual(primitives("import(`node:fs`);"), ["fs"]);
    assert.deepEqual(primitives('import("node:\\x66s");'), ["fs"]);
    assert.deepEqual(primitives('import("node:fs\\u002Fpromises");'), ["fs/promises"]);
    assert.deepEqual(primitives("const c = require(`child_process`);"), ["child_process"]);
    assert.deepEqual(primitives('const c = require("child_pro\\x63ess");'), ["child_process"]);
    assert.deepEqual(primitives('import fs from "node:\\u0066s";'), ["fs"]);
    assert.deepEqual(primitives('export * from "fs";'), ["fs"]);
    assert.deepEqual(primitives('import fs = require("fs");'), ["fs"]);
    assert.deepEqual(primitives('type T = import("node:fs").Stats;'), ["fs"]);
    assert.deepEqual(primitives('import("node:path");'), []);
    assert.deepEqual(primitives('const text = "import(`node:fs`)"; // import("fs")'), []);
});

test("a string that holds a comment marker does not hide an import: the source is read as it is written", () => {
    const hidden = 'const open = "/*";\nimport fs from "node:fs";\nconst close = "*/";\n';

    assert.deepEqual(primitivesOf(hidden), ["fs"]);
    assert.equal(
        [...raws.values()].some((text) => primitivesOf(text).length > 0),
        true,
    );
});
