// Each mutation is restricted to the approved disposable worktree and restored in finally.
const { readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

const cases = {
    R11: {
        file: "web/ui-locale.js",
        old: "    writePreference(preferred);\n    publish();",
        replacement:
            "    writePreference(preferred);\n    publish();\n    setTimeout(() => location.reload(), 50);",
        test: "test/ui-locale-ui.test.ts",
        pattern: "^R11 and R22:",
    },
    R12: {
        file: "web/slots.js",
        old: 'label: () => t("slots.topbar", "Top bar buttons")',
        replacement: 'label: () => "Top bar buttons"',
        test: "test/ui-locale-ui.test.ts",
        pattern: "^R12:",
    },
    R13: {
        file: "web/ui-locale.js",
        old: "if (mine === generation) {",
        replacement: "if (true) {",
        test: "test/ui-locale-ui.test.ts",
        pattern: "^R13: an older held real catalog",
    },
    R13S: {
        file: "web/ui-locale.js",
        old: "const key = `${applied}:${catalogRevision}:${id}`;",
        replacement: "const key = `${catalogRevision}:${id}`;",
        test: "test/ui-locale-ui.test.ts",
        pattern: "^R13: same-revision catalog bytes",
    },
    R14: {
        file: "web/ui-locale.js",
        old: '    return catalog.has(preferred) ? preferred : "en";',
        replacement: '    return catalog.has(preferred) ? preferred : "fr";',
        test: "test/ui-locale-ui.test.ts",
        pattern: "^R14:",
    },
    R15: {
        file: "web/ui-locale.js",
        old: 'addEventListener("focus", rereadPreference);',
        replacement: 'addEventListener("focus", () => {});',
        test: "test/ui-locale-ui.test.ts",
        pattern: "^R15: missing, invalid",
    },
    R19: {
        file: "web/ui-locale.js",
        old: "return translate(messagesOf(effectiveId()), key, english, values);",
        replacement:
            'return key === "appearance.title" && effectiveId() === "en" ? "Broken default" : translate(messagesOf(effectiveId()), key, english, values);',
        test: "test/ui-locale-ui.test.ts",
        pattern: "^R19: default English",
    },
    R20: {
        file: "web/safe-mode.js",
        old: "export const safeMode = () => safe;",
        replacement: "export const safeMode = () => false;",
        test: "test/ui-locale-ui.test.ts",
        pattern: "^R20:",
    },
    R21: {
        file: "web/sheets/appearance.js",
        old: "<select\n                    value=${localeId()}",
        replacement: "<select disabled\n                    value=${localeId()}",
        test: "test/ui-locale-ui.test.ts",
        pattern: "^R21: the mobile language selector",
    },
    R22: {
        file: "web/app.js",
        old: "${state.view.conversation.title} · Pi Pocket",
        replacement:
            "${state.view.conversation.title === 'Close' ? 'Fermer' : state.view.conversation.title} · Pi Pocket",
        test: "test/ui-locale-ui.test.ts",
        pattern: "^R22: user titles",
    },
    R23: {
        file: "src/server/http.ts",
        old: "json(response, 200, { revision: snapshot.revision, locales: snapshot.locales });",
        replacement:
            "json(response, 200, { revision: snapshot.revision, locales: snapshot.locales, privatePath: app.dataDir });",
        test: "test/ui-locales-http.test.ts",
        pattern: "^R23:",
    },
    R24: {
        file: "src/server/http.ts",
        old: 'if (request.method !== "GET") {',
        replacement: 'if (false && request.method !== "GET") {',
        test: "test/ui-locales-http.test.ts",
        pattern: "^R24:",
    },
};

const id = process.argv[2];
const item = cases[id];

if (!item || process.cwd().split("/").at(-1) !== "result-ui-locales-red") {
    throw new Error("Run a known risk only inside result-ui-locales-red.");
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
