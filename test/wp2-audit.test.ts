// Provenance and location checks for the coordinator's final reviewed WP2 classification; real UI tests check behavior.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { AUDIT_ROWS, BASELINE, UNMAPPED_ROWS } from "./wp2-audit-data.ts";

const FILES = ["web/chat.js", "web/composer.js", "web/transcript.js", "web/voice.js"] as const;
const BASELINE_HASHES = [
    "48524bf3a28b63dc66637501ae5ec5561376eb77c48cd0f5094b7b2493686947",
    "fde07256deb69813c55ba38baa9829db0c0db75f03aa760083d21840bd3ef498",
    "354ab9a06bf5de72c9fc49400b419bf5c4a89a454842c7ead4b8cbd2c23b003a",
    "eda79e81f9258c8da019fe6234f7a2340fd35a88a03a61178cfe0a6fddcf7881",
];
const EXPECTED = [52, 105, 148, 1];
const ROOT = new URL("../", import.meta.url);

function baseline(file: string): string {
    return execFileSync("git", ["show", `${BASELINE}:${file}`], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
    });
}

function at(file: string, source: string, id: string): string {
    const prefix = `${file}:`;
    const match = /^([1-9]\d*):([1-9]\d*)$/.exec(id.slice(prefix.length));

    assert.ok(id.startsWith(prefix) && match, `${id}: invalid baseline position`);
    const lines = source.split("\n");
    const line = Number(match[1]);
    const column = Number(match[2]);

    assert.ok(line <= lines.length && column <= lines[line - 1]!.length + 1, id);

    return lines
        .slice(line - 1)
        .join("\n")
        .slice(column - 1);
}

function normalized(text: string): string {
    return text.replace(/\s+/gu, "");
}

test("WP2 audit: every report ID and its English source match the fixed Git baseline", (t) => {
    const all = [...AUDIT_ROWS, ...UNMAPPED_ROWS];
    const unique = new Set(all.map((row) => row.id));

    assert.equal(
        unique.size,
        all.length,
        "no position is counted twice or also counted as unmapped",
    );
    assert.equal(AUDIT_ROWS.length, 306);
    assert.equal(UNMAPPED_ROWS.length, 15);
    const totals = { ui: 0, covered: 0, content: 0, data: 0, render: 0, deferred: 0 };

    for (const row of AUDIT_ROWS) {
        assert.ok(Object.hasOwn(totals, row.classification), row.id);
        assert.ok(row.reason && row.raw, row.id);
        totals[row.classification]++;
    }

    assert.deepEqual(totals, {
        ui: 97,
        covered: 68,
        content: 62,
        data: 38,
        render: 40,
        deferred: 1,
    });
    assert.deepEqual(
        AUDIT_ROWS.filter((row) => row.classification === "deferred").map((row) => row.id),
        ["web/transcript.js:1415:46"],
    );
    t.diagnostic(
        `Final reviewed classifications: ${JSON.stringify(totals)}; covered is not an independent t call; the turns.js summary is deferred because turns.js is outside WP2's permitted files.`,
    );

    const perFile = [
        { ui: 20, covered: 13, content: 10, data: 5, render: 4, deferred: 0 },
        { ui: 45, covered: 21, content: 12, data: 14, render: 13, deferred: 0 },
        { ui: 31, covered: 34, content: 40, data: 19, render: 23, deferred: 1 },
        { ui: 1, covered: 0, content: 0, data: 0, render: 0, deferred: 0 },
    ];

    for (const [index, file] of FILES.entries()) {
        const source = baseline(file);
        const hash = createHash("sha256").update(source).digest("hex");
        const rows = AUDIT_ROWS.filter((row) => row.id.startsWith(`${file}:`));
        const extras = UNMAPPED_ROWS.filter((row) => row.id.startsWith(`${file}:`));

        assert.equal(hash, BASELINE_HASHES[index], `${file}: baseline bytes`);
        assert.equal(rows.length, EXPECTED[index], `${file}: manual rows`);
        const classified = { ui: 0, covered: 0, content: 0, data: 0, render: 0, deferred: 0 };

        for (const row of rows) {
            classified[row.classification]++;
        }

        assert.deepEqual(classified, perFile[index], `${file}: mutually exclusive classifications`);
        assert.equal(
            extras.length,
            file.endsWith("composer.js") ? 7 : file.endsWith("transcript.js") ? 8 : 0,
        );
        const current = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
        const parsed = ts.createSourceFile(
            file,
            current,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.JS,
        );

        assert.deepEqual(
            (parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
                .parseDiagnostics,
            [],
            `${file}: current source parses`,
        );
        const currentHash = createHash("sha256").update(current).digest("hex");

        t.diagnostic(
            `${file}: baseline ${hash}, current ${currentHash}; manual ${rows.length}, unmapped ${extras.length}`,
        );

        for (const row of [...rows, ...extras]) {
            const rest = at(file, source, row.id);
            // Report columns for an interpolation point just after `${`; compound text may continue after its `}`.
            const literal = row.raw.startsWith("${") ? row.raw.slice(2) : row.raw;
            const anchor = normalized(literal).slice(0, 80);

            assert.ok(anchor.length > 0, `${row.id}: empty baseline anchor`);
            assert.ok(
                normalized(rest.slice(0, Math.max(row.raw.length + 1024, 4096))).includes(anchor),
                `${row.id}: original English/expression is not at the report position`,
            );
        }
    }
});

test("WP2 audit: exact literal-content expressions are not passed directly to translation", () => {
    for (const file of FILES) {
        const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
        const parsed = ts.createSourceFile(
            file,
            source,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.JS,
        );
        const translatedArguments: string[] = [];

        function visit(node: ts.Node): void {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "t"
            ) {
                translatedArguments.push(
                    ...node.arguments.map((arg) => normalized(arg.getText(parsed))),
                );
            }

            ts.forEachChild(node, visit);
        }

        visit(parsed);
        const ambiguous = new Set(["name", "command", "parts", "subject", "text"]);

        for (const row of AUDIT_ROWS.filter(
            (item) => item.classification === "content" && item.id.startsWith(`${file}:`),
        )) {
            const exact = /^\$\{([\s\S]*)\}$/.exec(row.raw);

            if (!exact) {
                continue;
            }

            const expression = normalized(exact[1]!);

            if (ambiguous.has(expression)) {
                continue;
            }

            // A safe refactor can rename a local. Real UI tests, not substring equality, judge content preservation.
            assert.equal(
                translatedArguments.includes(expression),
                false,
                `${row.id}: content expression must not be passed directly to t`,
            );
        }
    }
});
