// Generate the WP4 key handoff from live AST and the original, read-only dictionaries.
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import ts from "typescript";
import type { SourceFileWithParseDiagnostics } from "./wp4-audit.ts";
import { EN } from "../web/locales/en.js";
import { placeholders } from "../web/locale.js";

const root = join(import.meta.dirname, "..");
const dictionary = "/home/xianbei233/Work/pi-pocket-pr-notes/dictionary";
const english = JSON.parse(readFileSync(join(dictionary, "en-REFERENCE.json"), "utf8"))
    .messages as Record<string, string>;
const chinese = JSON.parse(readFileSync(join(dictionary, "zh-CN-DRAFT.json"), "utf8"))
    .messages as Record<string, string>;
const overrides = JSON.parse(
    readFileSync(join(import.meta.dirname, "wp4-overrides.json"), "utf8"),
) as Record<string, string>;
const byEnglish = new Map<string, Set<string>>();

for (const [key, value] of Object.entries(english)) {
    if (typeof chinese[key] !== "string" || !chinese[key]!.trim()) {
        continue;
    }

    if (!byEnglish.has(value)) {
        byEnglish.set(value, new Set());
    }

    byEnglish.get(value)!.add(chinese[key]!);
}

const sameNames = (a: string, b: string) =>
    JSON.stringify([...new Set(placeholders(a))].sort()) ===
    JSON.stringify([...new Set(placeholders(b))].sort());
const BASE = "5e8e2de85bb3e5f04eb56c3ee2360c641a30b979";
const baselineKeys = new Set<string>();

for (const name of ["extensions", "gallery", "memory", "menu"]) {
    const file = `web/sheets/${name}.js`;
    const content = execFileSync("git", ["show", `${BASE}:${file}`], {
        cwd: root,
        encoding: "utf8",
    });
    const tree = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

    function visit(node: ts.Node) {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "t" &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
        ) {
            baselineKeys.add(node.arguments[0].text);
        }

        ts.forEachChild(node, visit);
    }

    visit(tree);
}

const messages = new Map<
    string,
    {
        key: string;
        english: string;
        chinese: string | null;
        chineseSource: string;
        placeholders: string[];
        values: Record<string, string>;
        catalog: string;
        newSinceBaseline: boolean;
        sites: string[];
    }
>();

for (const name of ["extensions", "gallery", "memory", "menu"]) {
    const file = `web/sheets/${name}.js`;
    const tree = ts.createSourceFile(
        file,
        readFileSync(join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    ) as SourceFileWithParseDiagnostics;

    assert.equal(tree.parseDiagnostics.length, 0, file);

    function visit(node: ts.Node) {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "t" &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0]) &&
            node.arguments[1] &&
            ts.isStringLiteral(node.arguments[1])
        ) {
            const key = node.arguments[0].text;
            const fallback = node.arguments[1].text;
            const pos = tree.getLineAndCharacterOfPosition(node.getStart(tree));
            const location = `${file}:${pos.line + 1}:${pos.character + 1}`;
            const previous = messages.get(key);

            if (previous) {
                assert.equal(
                    previous.english,
                    fallback,
                    `key has incompatible fallbacks: ${key} at ${location}`,
                );
                previous.sites.push(location);
            } else {
                const candidates = [...(byEnglish.get(fallback) ?? [])].filter((item) =>
                    sameNames(fallback, item),
                );
                const exact =
                    english[key] === fallback && chinese[key] && sameNames(fallback, chinese[key]!);
                const translation =
                    overrides[key] ??
                    (exact ? chinese[key]! : candidates.length === 1 ? candidates[0]! : null);

                assert.ok(
                    !translation || sameNames(fallback, translation),
                    `placeholder mismatch: ${key}`,
                );
                const names = [...new Set(placeholders(fallback))].sort();

                messages.set(key, {
                    key,
                    english: fallback,
                    chinese: translation,
                    chineseSource:
                        overrides[key] !== undefined
                            ? "override: original proposal, corrected count or valid-input example"
                            : exact
                              ? "original key"
                              : translation === null
                                ? "unavailable or ambiguous"
                                : "unique exact-English match",
                    placeholders: names,
                    values: Object.fromEntries(
                        names.map((field) => [field, `<${field}-$&-{other}>`]),
                    ),
                    catalog: Object.hasOwn(EN, key)
                        ? EN[key] === fallback
                            ? "present"
                            : "present-mismatch"
                        : "absent",
                    newSinceBaseline: !baselineKeys.has(key),
                    sites: [location],
                });
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(tree);
}

const list = [...messages.values()].sort((a, b) => a.key.localeCompare(b.key));

for (const key of Object.keys(overrides)) {
    assert.ok(messages.has(key), `override has no real WP4 call site: ${key}`);
}

assert.deepEqual(
    list
        .filter((item) => item.catalog === "absent" && item.chinese === null)
        .map((item) => item.key),
    [],
    "all absent keys need Chinese handoff values",
);
writeFileSync(join(import.meta.dirname, "wp4-messages.json"), JSON.stringify(list, null, 2) + "\n");
console.log(
    `WP4 message keys: ${list.length}; new since baseline: ${list.filter((item) => item.newSinceBaseline).length}; catalog absent: ${list.filter((item) => item.catalog === "absent").length}; Chinese unavailable: ${list.filter((item) => item.chinese === null).length}; catalog mismatch: ${list.filter((item) => item.catalog === "present-mismatch").length}.`,
);
