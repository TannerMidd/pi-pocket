// Contribution-boundary checks read actual source imports, not migration reports or external authoring data.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { modulesWith } from "../src/server/config.ts";
import { VENDOR } from "../src/server/http/assets.ts";

const root = resolve(import.meta.dirname, "..");
const extensions = join(root, "src/server/extensions");

function sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? sources(join(directory, entry.name))
            : /\.(?:[cm]?[jt]s)$/.test(entry.name)
              ? [join(directory, entry.name)]
              : [],
    );
}

function runtimeImportAllowed(file: string, specifier: string): boolean {
    if (specifier.startsWith("/")) {
        const name = /^\/vendor\/([^/]+)$/.exec(specifier)?.[1];

        return name !== undefined && Object.hasOwn(VENDOR, name) && existsSync(VENDOR[name]!);
    }

    return (
        !specifier.startsWith(".") || resolve(dirname(file), specifier).startsWith(extensions + "/")
    );
}

test("C10 permits only exact third-party vendor mappings and rejects core imports", () => {
    const expected: Record<string, [string, string]> = {
        "preact.mjs": ["preact", "dist/preact.mjs"],
        "preact-hooks.mjs": ["preact", "hooks/dist/hooks.mjs"],
        "htm.mjs": ["htm", "dist/htm.module.js"],
        "marked.mjs": ["marked", "lib/marked.esm.js"],
        "purify.mjs": ["dompurify", "dist/purify.es.mjs"],
        "pele.mjs": ["pele", "dist/pele.js"],
        "katex.mjs": ["katex", "dist/katex.mjs"],
    };
    const dependencies = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies;
    const file = join(extensions, "diagrams", "index.js");

    assert.deepEqual(Object.keys(VENDOR).sort(), Object.keys(expected).sort());

    for (const [name, [dependency, path]] of Object.entries(expected)) {
        const packageRoot = join(modulesWith(dependency), dependency);

        assert.ok(Object.hasOwn(dependencies, dependency), dependency);
        assert.equal(
            JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name,
            dependency,
        );
        assert.equal(VENDOR[name], join(packageRoot, path));
        assert.ok(existsSync(VENDOR[name]!), name);
        assert.equal(runtimeImportAllowed(file, `/vendor/${name}`), true);
    }

    for (const specifier of [
        "/ui-locale.js",
        "/store.js",
        "/vendor/nope.mjs",
        "/vendor/../store.js",
        "/vendor/pele.mjs/extra",
        "/vendor/pele.mjs?core=1",
        "/vendor/%2e%2e/store.js",
        "/vendor/__proto__",
        "../../ui-locales.ts",
        "../diagrams/../../ui-locales.ts",
    ]) {
        assert.equal(runtimeImportAllowed(file, specifier), false, specifier);
    }

    assert.equal(runtimeImportAllowed(file, "./local.js"), true);
});

test("browser extensions import their own modules, not core internals at runtime", () => {
    const violations: string[] = [];

    for (const file of sources(extensions).filter((path) => path.endsWith(".js"))) {
        const text = readFileSync(file, "utf8");
        const tree = ts.createSourceFile(
            file,
            text,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.JS,
        );

        function inspect(node: ts.Node): void {
            let specifier: string | undefined;

            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
                specifier = node.moduleSpecifier.text;
            }

            if (
                ts.isCallExpression(node) &&
                node.expression.kind === ts.SyntaxKind.ImportKeyword &&
                node.arguments[0] &&
                ts.isStringLiteral(node.arguments[0])
            ) {
                specifier = node.arguments[0].text;
            }

            if (specifier && !runtimeImportAllowed(file, specifier)) {
                violations.push(`${relative(root, file)}: ${specifier}`);
            }

            ts.forEachChild(node, inspect);
        }

        inspect(tree);
    }

    assert.deepEqual(violations, [], "C10: browser modules must not import core runtime files");
});

test("the public-page extension uses only type imports from core", () => {
    const file = join(extensions, "ask-someone.ts");
    const tree = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    const runtime = tree.statements
        .filter(ts.isImportDeclaration)
        .filter(
            (node) =>
                ts.isStringLiteral(node.moduleSpecifier) &&
                node.moduleSpecifier.text.startsWith("..") &&
                !node.importClause?.isTypeOnly,
        );

    assert.deepEqual(
        runtime.map((node) => node.moduleSpecifier.getText(tree)),
        [],
    );
});

test("formal tests do not import or read private authoring notes", () => {
    const violations: string[] = [];

    for (const file of sources(join(root, "test"))) {
        const text = readFileSync(file, "utf8");
        const tree = ts.createSourceFile(
            file,
            text,
            ts.ScriptTarget.Latest,
            true,
            file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
        );

        function inspect(node: ts.Node): void {
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
                const specifier = node.moduleSpecifier.text;

                if (specifier.startsWith("/") || specifier.includes("pi-pocket-pr-notes")) {
                    violations.push(`${relative(root, file)}: ${specifier}`);
                }

                if (specifier.startsWith(".") && !existsSync(resolve(dirname(file), specifier))) {
                    violations.push(`${relative(root, file)}: missing ${specifier}`);
                }
            }

            if (
                ts.isStringLiteralLike(node) &&
                node.text.includes(["pi-pocket", "pr-notes"].join("-") + "/")
            ) {
                violations.push(`${relative(root, file)}: private authoring dependency`);
            }

            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                ["readFileSync", "readFile", "writeFileSync", "writeFile"].includes(
                    node.expression.text,
                ) &&
                node.arguments[0] &&
                ts.isStringLiteralLike(node.arguments[0]) &&
                node.arguments[0].text.startsWith("/")
            ) {
                violations.push(`${relative(root, file)}: absolute file dependency`);
            }

            ts.forEachChild(node, inspect);
        }

        inspect(tree);
    }

    assert.deepEqual(violations, [], "tests must run in a clean checkout without private notes");
});
