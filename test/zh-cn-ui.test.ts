// The shipped example is exercised by the real loader and Chromium in i18n-ui.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import zhCnUi from "../docs/examples/zh-cn-ui.ts";
import { setUiLocales, t } from "../web/i18n.js";

test("Chinese pack keeps template placeholders and dynamic values intact", () => {
    const extension = zhCnUi();
    const pack = extension.uiLocales[0]!;
    const slots = (text: string) =>
        [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();

    assert.equal(extension.name, "zh-cn-ui");
    assert.equal(pack.locale, "zh-CN");
    assert.ok(Object.keys(pack.strings).length > 700);
    assert.ok(Object.keys(pack.templates).length > 90);

    for (const [key, value] of Object.entries(pack.templates)) {
        assert.deepEqual(slots(value), slots(key), key);
    }

    try {
        setUiLocales(extension.uiLocales);
        assert.equal(t("Menu"), "菜单");
        assert.equal(t("Unregistered English UI"), "Unregistered English UI");
        const name = "Menu {{name}} <img> /some/path";
        const error = "EXTERNAL RAW {{name}}";
        const translated = t("Could not attach {{name}}: {{error}}", { name, error });

        assert.ok(translated.includes(name));
        assert.ok(translated.includes(error));
        assert.notEqual(translated, `Could not attach ${name}: ${error}`);
    } finally {
        setUiLocales([]);
    }

    assert.equal(t("Menu"), "Menu");
});

test("Chinese pack covers literal and conditional t() keys in the web app", () => {
    const pack = zhCnUi().uiLocales[0]!;
    const keys = new Set([...Object.keys(pack.strings), ...Object.keys(pack.templates)]);
    const missing = new Set<string>();
    let checked = 0;

    const literals = (node: ts.Node): string[] => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            return [node.text];
        }

        if (ts.isConditionalExpression(node)) {
            return [...literals(node.whenTrue), ...literals(node.whenFalse)];
        }

        return [];
    };

    const scan = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);

            if (entry.isDirectory()) {
                scan(path);
            } else if (entry.name.endsWith(".js")) {
                const file = ts.createSourceFile(
                    path,
                    readFileSync(path, "utf8"),
                    ts.ScriptTarget.Latest,
                    true,
                );

                const visit = (node: ts.Node) => {
                    if (
                        ts.isCallExpression(node) &&
                        ts.isIdentifier(node.expression) &&
                        node.expression.text === "t" &&
                        node.arguments[0]
                    ) {
                        for (const key of literals(node.arguments[0])) {
                            checked++;

                            if (!keys.has(key)) {
                                missing.add(key);
                            }
                        }
                    }

                    ts.forEachChild(node, visit);
                };

                visit(file);
            }
        }
    };

    scan(join(import.meta.dirname, "../web"));
    assert.ok(checked > 900);
    assert.deepEqual(
        [...missing],
        [],
        "indirect expressions and untranslated surfaces still require review",
    );
});
