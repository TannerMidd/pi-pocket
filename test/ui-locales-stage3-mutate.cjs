// Run only inside the approved disposable worktree. Every reversible mutation is restored in finally.
const { readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

const cases = {
    R26: {
        file: "src/server/ui-locales.ts",
        old: "    const messages = pack?.messages ?? EN;",
        replacement:
            "    const messages = snapshot.locales.find((each) => each.id === 'fr')?.messages ?? EN;",
        test: "test/ui-locales-http.test.ts",
        pattern: "^R26: concurrent login",
    },
    R26S: {
        file: "src/server/ui-locales.ts",
        old: "    const messages = pack?.messages ?? EN;",
        replacement:
            "    (globalThis as any).localeMutationMessages = pack?.messages ?? EN;\n    const messages = new Proxy(Object.create(null), {\n        getOwnPropertyDescriptor(_target, key) { const descriptor = Object.getOwnPropertyDescriptor((globalThis as any).localeMutationMessages, key); return descriptor && { ...descriptor, configurable: true }; },\n        get(_target, key) { return (globalThis as any).localeMutationMessages[key]; },\n    });",
        test: "test/ui-locales-http.test.ts",
        pattern: "^R26: one request keeps",
    },
    R25: {
        file: "src/server/ui-locales.ts",
        old: "    const messages = pack?.messages ?? EN;",
        replacement: "    const messages = EN;",
        test: "test/ui-locales-http.test.ts",
        pattern: "^R25: the installed pack",
    },
    R27T: {
        file: "src/server/http/sign-in.ts",
        old: 'escapeHtml(locale.t("signin.switch-title", "Switch account?"))',
        replacement: 'locale.t("signin.switch-title", "Switch account?")',
        test: "test/ui-locales-http.test.ts",
        pattern: "^R27: translation text and attribute",
    },
    R27A: {
        file: "src/server/http/sign-in.ts",
        old: 'escapeHtml(locale.t("signin.name-placeholder", "e.g. Alex"))',
        replacement: 'locale.t("signin.name-placeholder", "e.g. Alex")',
        test: "test/ui-locales-http.test.ts",
        pattern: "^R27: translation text and attribute",
    },
    R28C: {
        file: "src/server/http/sign-in.ts",
        old: "if (posted && crossSite(request)) {",
        replacement: "if (false && posted && crossSite(request)) {",
        test: "test/ui-locales-http.test.ts",
        pattern: "^R28:",
    },
    R28N: {
        file: "src/server/http/sign-in.ts",
        old: '    const next = localPath(form.get("next"));',
        replacement: '    const next = form.get("next") ?? "/";',
        test: "test/ui-locales-http.test.ts",
        pattern: "^R28:",
    },
};

const id = process.argv[2];
const item = cases[id];

if (!item || process.cwd().split("/").at(-1) !== "result-ui-locales-red") {
    throw new Error("Run a known Stage 3 risk only inside result-ui-locales-red.");
}

const original = readFileSync(item.file, "utf8");

if (original.split(item.old).length !== 2 || item.old === item.replacement) {
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
            timeout: 90000,
        },
    );

    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exitCode = result.status ?? 1;
} finally {
    writeFileSync(item.file, original);
}
