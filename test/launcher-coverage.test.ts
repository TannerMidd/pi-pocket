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

function itemNames(source: string): string[] {
    const tree = ts.createSourceFile(
        "menu.js",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    const names: string[] = [];

    function labels(node: ts.Node | undefined): string[] {
        if (node === undefined) {
            return [];
        }

        if (ts.isStringLiteralLike(node)) {
            return [node.text];
        }

        if (ts.isConditionalExpression(node)) {
            return [...labels(node.whenTrue), ...labels(node.whenFalse)];
        }

        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "t"
        ) {
            return labels(node.arguments[1]);
        }

        return [];
    }

    function visit(node: ts.Node): void {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "item"
        ) {
            names.push(...labels(node.arguments[0]));
        }

        ts.forEachChild(node, visit);
    }

    visit(tree);

    return names;
}

test("menu name extraction includes both literal and translated conditional branches", () => {
    assert.deepEqual(
        itemNames(
            `item("Literal", open); item(on ? "On" : "Off", toggle); item(on ? t("on", "Turn on") : t("off", "Turn off"), toggle);`,
        ),
        ["Literal", "On", "Off", "Turn on", "Turn off"],
    );
});

test("the launcher has every row of the menu, by name", () => {
    const names = itemNames(menu);
    const missing = names.filter((name) => !launcher.includes(`"${name}`));

    assert.ok(names.includes("Webhooks and watches") && names.includes("Take turns"));
    assert.deepEqual(missing, [], `the launcher has no action named: ${missing.join(", ")}`);
});
