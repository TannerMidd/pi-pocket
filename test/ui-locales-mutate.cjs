// Run only inside the owner-approved disposable evidence worktree. Every mutation is restored in finally.
const { readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

const cases = {
    R01: {
        file: "src/server/ui-locales.ts",
        old: "if (fields.size === 0) {\n        throw new Error(`web.uiLocales: ${where}: messages is empty: give it at least one key`);",
        replacement:
            "if (false && fields.size === 0) {\n        throw new Error(`web.uiLocales: ${where}: messages is empty: give it at least one key`);",
        test: "test/ui-locales.test.ts",
        pattern: "^R01:",
    },
    R01T: {
        file: "src/server/ui-locales.ts",
        old: '        if (typeof text !== "string") {',
        replacement:
            '        if (key === "future.unknown" && typeof text === "object") {\n            continue;\n        }\n\n        if (typeof text !== "string") {',
        test: "test/ui-locales.test.ts",
        pattern: "^R05: unknown keys still enforce",
    },
    R02: {
        file: "src/server/ui-locales.ts",
        old: "const checked = declared(module, packs).map((each, at) => checkPack(module, each, at));",
        replacement:
            "const checked = Array.from(packs).map((each, at) => checkPack(module, each, at));",
        test: "test/ui-locales.test.ts",
        pattern: "^R02: an accessor on a declared pack array",
    },
    R03: {
        file: "src/server/ui-locales.ts",
        old: "value: 8 * 1024,",
        replacement: "value: 8 * 1024 + 1,",
        test: "test/ui-locales.test.ts",
        pattern: "^R03: package count",
    },
    R03A: {
        file: "src/server/ui-locales.ts",
        old: 'const bytes = Buffer.byteLength(`[${all.map(declaredJson).join(",")}]`);',
        replacement: "const bytes = Buffer.byteLength(JSON.stringify(all));",
        test: "test/ui-locales.test.ts",
        pattern: "^R03: ignored unknown keys count",
    },
    R04: {
        file: "web/locale.js",
        old: 'typeof said === "string" && said.trim() !== "" ? said : english',
        replacement: 'typeof said === "string" ? said : english',
        test: "test/locale-lookup.test.ts",
        pattern: "^R04:",
    },
    R05: {
        file: "web/locale.js",
        old: 'typeof said === "string" && said.trim() !== "" ? said : english',
        replacement: 'typeof said === "string" && said.trim() !== "" ? said : key',
        test: "test/locale-lookup.test.ts",
        pattern: "^R05:",
    },
    R06: {
        file: "src/server/ui-locales.ts",
        old: "!sameNames(placeholders(english), placeholders(text))",
        replacement: "false && !sameNames(placeholders(english), placeholders(text))",
        test: "test/locale-lookup.test.ts",
        pattern: "^R06: known placeholders must match",
    },
    R06I: {
        file: "web/locale.js",
        old: "    return format(text, values);",
        replacement: "    return format(format(text, values), values);",
        test: "test/locale-lookup.test.ts",
        pattern: "^R06: interpolation is literal",
    },
    R07: {
        file: "src/server/ui-locales.ts",
        old: 'if (id.toLowerCase() === "en") {',
        replacement: 'if (false && id.toLowerCase() === "en") {',
        test: "test/ui-locales.test.ts",
        pattern: "^R07:",
    },
    R07C: {
        file: "src/server/ui-locales.ts",
        old: "    return id;\n}\n\n/** A language's own name",
        replacement: "    return value;\n}\n\n/** A language's own name",
        test: "test/ui-locales.test.ts",
        pattern: "^R07: canonical IDs appear exactly",
    },
    R08: {
        file: "src/server/extension-web.ts",
        old: "            this.locales === undefined &&\n",
        replacement: "",
        test: "test/extension-loader.test.ts",
        pattern: "^R08:",
    },
    R08D: {
        file: "src/server/extension-web.ts",
        old: "            locales: (part.locales ?? []).map((pack) => pack.id),",
        replacement: "            locales: [],",
        test: "test/extension-web.test.ts",
        pattern: "^locale declarations are staged once",
    },
    R09: {
        file: "src/server/ui-locales.ts",
        old: "for (const file of this.#order()) {",
        replacement: "for (const file of this.#packs.keys()) {",
        test: "test/ui-locales.test.ts",
        pattern: "^R04 and R09:",
    },
    R10: {
        file: "src/server/extension-web.ts",
        old: "        part.sealed = true;\n        this.#staged.delete(part);\n        void this.#dispose(part);\n    }\n\n    /** The module was turned off or deleted. */",
        replacement:
            "        this.locales.set(part.file, part.locales);\n        part.sealed = true;\n        this.#staged.delete(part);\n        void this.#dispose(part);\n    }\n\n    /** The module was turned off or deleted. */",
        test: "test/extension-loader.test.ts",
        pattern: "^R10: invalid and throwing locale updates",
    },
    R16: {
        file: "src/server/ui-locales.ts",
        old: "return Object.freeze(checked.map((each) => each.pack));",
        replacement: "return checked.map((each) => each.pack);",
        test: "test/ui-locales.test.ts",
        pattern: "^R16: checked declaration array is immutable",
    },
    R16C: {
        file: "src/server/ui-locales.ts",
        old: "messages: Object.freeze(onlySaid(messages)),",
        replacement: 'messages: fields.get("messages") as Record<string, string>,',
        test: "test/ui-locales.test.ts",
        pattern: "^R16: changing the module",
    },
    R17: {
        file: "src/server/extension-web.ts",
        old: "        if (this.locales.set(part.file, undefined)) {\n            this.#options.localesChanged?.();\n        }",
        replacement:
            "        if (false && this.locales.set(part.file, undefined)) {\n            this.#options.localesChanged?.();\n        }",
        test: "test/extension-loader.test.ts",
        pattern: "^R09 and R17:",
    },
};

const id = process.argv[2];
const item = cases[id];

if (!item || process.cwd().split("/").at(-1) !== "result-ui-locales-red") {
    throw new Error("Run one known risk only inside result-ui-locales-red.");
}

const original = readFileSync(item.file, "utf8");

if (original.split(item.old).length !== 2) {
    throw new Error(`${id}: mutation target does not match exactly once`);
}

try {
    writeFileSync(item.file, original.replace(item.old, item.replacement));
    const result = spawnSync(
        process.execPath,
        ["--test", `--test-name-pattern=${item.pattern}`, item.test],
        {
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
        },
    );

    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exitCode = result.status ?? 1;
} finally {
    writeFileSync(item.file, original);
}
