import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { calls, DYNAMIC_COUNT_ARGS } from "./wp2-keys.mjs";
import { WP2_HISTORY, WP2_KEYS, WP2_RELEASE_KEYS, WP2_RETIRED_KEYS } from "./wp2-locale-keys.ts";

test("WP2 key extraction reads AST fallbacks, ignores examples, and reports dynamic calls", () => {
    const source = `
        // t("not.a.key", "A comment")
        const example = "t('not.a.key', 'A string')";
        const x = t("web.chat.test.one", "one {name}");
        const y = t(
            'web.composer.test.two',
            'two',
            { count: 2 },
        );
        const z = t(dynamicKey, "unresolved");
        const n = countedText(1, ['web.transcript.one', '{count} line'], ['web.transcript.many', '{count} lines']);
    `;
    const result = calls("fixture.js", source);

    assert.deepEqual(
        result.result.map(({ key, english }: { key: string; english: string }) => ({
            key,
            english,
        })),
        [
            { key: "web.chat.test.one", english: "one {name}" },
            { key: "web.composer.test.two", english: "two" },
            { key: "web.transcript.one", english: "{count} line" },
            { key: "web.transcript.many", english: "{count} lines" },
        ],
    );
    assert.equal(result.unresolved.length, 1);
    assert.ok(result.unresolved[0]);
    assert.match(result.unresolved[0].code, /dynamicKey/);
});

const files = ["web/chat.js", "web/composer.js", "web/transcript.js", "web/voice.js"];
const placeholders = (text: string) =>
    [
        ...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1])),
    ].sort();

test("WP2 key manifest matches actual t calls, countedText tuples, and placeholder contracts", (t) => {
    const manifest = new Map(WP2_KEYS.map((row) => [row.key, row]));
    const actual = new Map<string, string>();
    let helperTuples = 0;

    assert.equal(manifest.size, WP2_KEYS.length, "manifest keys are unique");

    for (const file of files) {
        const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
        const found = calls(file, source);

        assert.deepEqual(
            found.unresolved,
            [],
            `${file}: every t key and English fallback must be accounted for`,
        );

        for (const call of found.result) {
            const prior = actual.get(call.key);
            const location = `${call.file}:${call.line}`;

            assert.ok(
                prior === undefined || prior === call.english,
                `${location}: same key has conflicting English`,
            );
            actual.set(call.key, call.english);
            const row = manifest.get(call.key);

            assert.ok(row, `${location}: no manifest entry for ${call.key}`);
            assert.equal(call.english, row.english, `${location}: fallback differs from manifest`);
            assert.deepEqual(
                placeholders(row.zh),
                placeholders(row.english),
                `${call.key}: Chinese placeholders`,
            );
            assert.notEqual(
                call.names,
                DYNAMIC_COUNT_ARGS,
                `${location}: dynamic translation values need review`,
            );
            assert.ok(call.names !== DYNAMIC_COUNT_ARGS);
            assert.deepEqual(
                [...new Set(call.names)].sort(),
                placeholders(call.english),
                `${location}: runtime value names`,
            );

            if (call.helper === "countedText") {
                helperTuples++;
            }
        }

        const parsed = ts.createSourceFile(
            file,
            source,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.JS,
        );

        function inspect(node: ts.Node): void {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "t"
            ) {
                for (const arg of node.arguments.slice(0, 2)) {
                    assert.ok(
                        !ts.isCallExpression(arg) ||
                            !ts.isIdentifier(arg.expression) ||
                            arg.expression.text !== "t",
                        `${file}: nested t wrapper`,
                    );
                }
            }

            ts.forEachChild(node, inspect);
        }

        inspect(parsed);
    }

    assert.deepEqual(
        [...actual.keys()].sort(),
        [...manifest.keys()].sort(),
        "the manifest is neither missing keys nor stale",
    );
    assert.equal(WP2_HISTORY.length, 417, "the original WP2 history remains intact");
    assert.equal(WP2_RELEASE_KEYS.length, 16, "reviewed release additions");
    assert.equal(
        WP2_RETIRED_KEYS.length,
        4,
        "only explicitly superseded keys leave the live manifest",
    );
    assert.deepEqual(
        WP2_HISTORY.filter((row) => !actual.has(row.key))
            .map((row) => row.key)
            .sort(),
        [...WP2_RETIRED_KEYS].sort(),
        "every historical key is still live or explicitly retired",
    );
    assert.equal(actual.size, 417 - 4 + 16);
    assert.ok(helperTuples >= 10, "singular and plural tuple keys are included");

    for (const row of [...WP2_HISTORY, ...WP2_RELEASE_KEYS]) {
        assert.match(row.key, /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
        assert.ok(row.zh.trim(), `${row.key}: Chinese suggestion is not empty`);
        assert.deepEqual(
            placeholders(row.zh),
            placeholders(row.english),
            `${row.key}: manifest placeholder names`,
        );
    }

    const reference = WP2_HISTORY.filter((row) => row.source === "reference").length;
    const added = WP2_HISTORY.filter((row) => row.source === "new").length;

    assert.equal(reference, 351);
    assert.equal(added, 66);
    t.diagnostic(
        `Manifest: ${actual.size} live keys; original ${reference} reference and ${added} new suggestions retained; ${WP2_RELEASE_KEYS.length} release additions, ${WP2_RETIRED_KEYS.length} retired; ${helperTuples} tuple occurrences. Startup existing-en snapshot not supplied.`,
    );
});
