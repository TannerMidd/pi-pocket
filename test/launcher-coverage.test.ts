// The launcher (Mod+K) finds what the menu has: each sheet the menu opens, and each of its rows by name. The two lists
// are written apart, and the launcher fell behind (Webhooks and watches, Memory, Notifications, and others).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = (path: string) => readFileSync(new URL(`../web/${path}`, import.meta.url), "utf8");
const menu = read("sheets/menu.js");
const launcher = read("launcher.js");
const sheets = (source: string) =>
    new Set([...source.matchAll(/openSheet\(\{ type: "([a-z-]+)"/g)].map((match) => match[1]));

test("the launcher opens every sheet the menu opens", () => {
    const missing = [...sheets(menu)].filter((type) => !sheets(launcher).has(type));

    assert.deepEqual(missing, [], `the launcher has no action for: ${missing.join(", ")}`);
});

/** The names a menu row shows, through the `t()` wrapper a localized row uses. */
test("the launcher has every row of the menu, by name", () => {
    const names = new Set<string>();

    const collect = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            names.add(node.text);
        } else if (ts.isConditionalExpression(node)) {
            collect(node.whenTrue);
            collect(node.whenFalse);
        } else if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "t" &&
            node.arguments[0]
        ) {
            collect(node.arguments[0]);
        }
    };

    const source = ts.createSourceFile("menu.js", menu, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "item" &&
            node.arguments[0]
        ) {
            collect(node.arguments[0]);
        }

        ts.forEachChild(node, visit);
    };

    visit(source);

    const missing = [...names].filter((name) => !launcher.includes(`"${name}`));

    assert.ok(names.has("Webhooks and watches") && names.has("Take turns"));
    assert.deepEqual(missing, [], `the launcher has no action named: ${missing.join(", ")}`);
});
