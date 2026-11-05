// Rebuild every WP4 record from the fixed report, Git baseline and current production AST.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { SourceFileWithParseDiagnostics } from "./wp4-audit.ts";
import { analyzeSource } from "/home/xianbei233/Work/pi-pocket-pr-notes/dictionary/tools/codemod.mjs";
import { EN } from "../web/locales/en.js";

const BASE = "5e8e2de85bb3e5f04eb56c3ee2360c641a30b979";
const ROOT = join(import.meta.dirname, "..");
const DICTIONARY = "/home/xianbei233/Work/pi-pocket-pr-notes/dictionary";
const REPORT = join(DICTIONARY, "CODEMOD-WEB.md");
const files = ["extensions", "gallery", "memory", "menu"].map((name) => `web/sheets/${name}.js`);
const counts = { 需人工: 1581, 无法映射键: 69 };

type Section = keyof typeof counts;
type RecordOfCandidate = {
    file: string;
    line: number;
    column: number;
    raw: string;
    section: Section;
    reason: string;
    key?: string;
};
type Call = { key: string; english: string; start: number; end: number };
type ManualStatus =
    | "translated"
    | "already-wired"
    | "structural-reviewed"
    | "content-excluded"
    | "identifier-excluded";
type AuditDecision = {
    file: string;
    line: number;
    column: number;
    raw: string;
    status: ManualStatus;
    producer: string;
    reason: string;
    scopes: string[];
    keys: string[];
    expressions: string[];
};
type AuditCall = {
    file: string;
    key: string;
    english: string;
    line: number;
    column: number;
    scopes: string[];
    values: string | null;
};
type AuditExpression = {
    file: string;
    scope: string;
    expression: string;
    offset: number;
    line: number;
    column: number;
};
type Audit = {
    baseline: string;
    sourceHashes: Record<string, string>;
    identities: Record<string, { line: number; column: number; sha256: string }>;
    calls: AuditCall[];
    baselineKeyScopes: {
        file: string;
        scope: string;
        key: string;
        english: string;
        line: number;
        column: number;
        origin: "baseline" | "automatic";
    }[];
    expressions: AuditExpression[];
    decisions: AuditDecision[];
};
const audit: Audit = JSON.parse(readFileSync(join(ROOT, "test/wp4-audit.json"), "utf8"));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const sourceMap = JSON.parse(readFileSync(join(DICTIONARY, "SOURCE-MAP.json"), "utf8")).records as {
    file: string;
}[];
const english = JSON.parse(readFileSync(join(DICTIONARY, "en-REFERENCE.json"), "utf8")).messages;
const chinese = JSON.parse(readFileSync(join(DICTIONARY, "zh-CN-DRAFT.json"), "utf8")).messages;
const messageRows = JSON.parse(readFileSync(join(ROOT, "test/wp4-messages.json"), "utf8")) as {
    key: string;
    english: string;
    chinese: string | null;
    catalog: string;
}[];
const catalog = new Map(messageRows.map((entry) => [entry.key, entry.english]));

assert.equal(catalog.size, messageRows.length, "message handoff has duplicate keys");
assert.equal(
    messageRows.filter((entry) => entry.catalog === "absent" && !entry.chinese).length,
    0,
    "all absent keys have handoff values",
);

for (const entry of messageRows) {
    const actual = Object.hasOwn(EN, entry.key)
        ? EN[entry.key] === entry.english
            ? "present"
            : "present-mismatch"
        : "absent";

    assert.equal(entry.catalog, actual, `catalog state drift: ${entry.key}`);
}

const statuses: ManualStatus[] = [
    "translated",
    "already-wired",
    "structural-reviewed",
    "content-excluded",
    "identifier-excluded",
];

assert.equal(audit.baseline, BASE, "audit baseline");

function readReport() {
    const generator = readFileSync(join(DICTIONARY, "tools/workpackages.mjs"), "utf8");
    const input = readFileSync(join(DICTIONARY, "WORK-PACKAGES.md"), "utf8");

    assert.ok(
        generator.includes(BASE) &&
            /id:\s*"WP4"[\s\S]*?sheets\("extensions gallery memory menu"\)/.test(generator),
        "generator WP4 ownership and baseline",
    );
    assert.ok(input.includes("| WP4 | 扩展图库与记忆面板 | 4 | 315 | 19 |"), "WP4 generated total");
    let section = "";
    const records: RecordOfCandidate[] = [];
    const totals = { 需人工: 0, 无法映射键: 0 };

    for (const line of readFileSync(REPORT, "utf8").split("\n")) {
        const heading = line.match(/^## (可自动改写|需人工|无法映射键)\s*$/);

        if (heading) {
            section = heading[1]!;
            continue;
        }

        if (!(section in counts) || !/^- web\/.+?:\d+:\d+ /.test(line)) {
            continue;
        }

        const match = line.match(
            /^- (web\/[^:\r\n]+):(\d+):(\d+) (?:\[([^\]]+)\] |key=([^ ]+) )?原文=("(?:[^"\\]|\\.)*")(.*)$/,
        );

        assert.ok(match, `unparsed report row: ${line}`);
        totals[section as Section]++;

        if (!files.includes(match[1]!)) {
            continue;
        }

        records.push({
            file: match[1]!,
            line: Number(match[2]),
            column: Number(match[3]),
            raw: JSON.parse(match[6]!),
            section: section as Section,
            reason: match[4] ?? "unmapped",
            key: match[5] ?? match[7]?.match(/^（key=([^）]+)）/)?.[1],
        });
    }

    assert.deepEqual(totals, counts, "complete report sections");
    assert.equal(
        new Set(records.map((r) => `${r.section}:${r.file}:${r.line}:${r.column}`)).size,
        records.length,
    );

    return records;
}

function parse(file: string, text: string) {
    const tree = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    ) as SourceFileWithParseDiagnostics;

    assert.equal(tree.parseDiagnostics.length, 0, file);

    return tree;
}

function calls(tree: ts.SourceFile) {
    const out: Call[] = [];

    function visit(n: ts.Node) {
        if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === "t" &&
            n.arguments[0] &&
            ts.isStringLiteral(n.arguments[0]) &&
            n.arguments[1] &&
            ts.isStringLiteral(n.arguments[1])
        ) {
            out.push({
                key: n.arguments[0].text,
                english: n.arguments[1].text,
                start: n.getStart(tree),
                end: n.end,
            });
        }

        ts.forEachChild(n, visit);
    }

    visit(tree);

    return out;
}

// The 19 separate report rows: each translated row names its actual call and placeholder source.
const extraAudit: Record<
    string,
    {
        key?: string;
        english?: string;
        values?: Record<string, string>;
        occurrence?: number;
        why: string;
    }
> = {
    "extensions.js:328:25": {
        key: "web.sheets.extensions.gallery-part.button.turn-it-off",
        english: "Turn it off",
        why: "fixed revoke action",
    },
    "extensions.js:653:87": {
        key: "web.sheets.extensions.extensions-content.row.aria-label.turn",
        english: "Turn on {title}?",
        values: { title: "module.title" },
        why: "ARIA prompt preserves author title",
    },
    "extensions.js:758:65": { why: "literal .ts file extension, not UI prose" },
    "extensions.js:809:65": { why: "literal .ts file extension, not UI prose" },
    "extensions.js:809:164": {
        key: "web.sheets.extensions.extensions-content.span.it-stays-off-until-turn",
        english: "It stays off until you turn it on.",
        why: "fixed footer sentence",
    },
    "gallery.js:804:63": {
        key: "web.sheets.gallery.gallery-sheet.aria-label.available",
        english: "{count} available",
        values: { count: "updates" },
        why: "ARIA count",
    },
    "gallery.js:1270:19": {
        key: "web.sheets.gallery.adds-section.text.app",
        english: "{detail}{detail2} in the app, for {access}",
        values: { access: "accessWords(d.access)" },
        why: "fixed prose with generated list and access",
    },
    "gallery.js:1514:29": {
        key: "web.sheets.gallery.gallery-entry-sheet.button.turn-it-off",
        english: "Turn it off",
        why: "fixed revoke action",
    },
    "gallery.js:1856:110": {
        key: "web.sheets.gallery.gallery-source-sheet.span.pinned",
        english: "✓ pinned",
        why: "pinned status label",
    },
    "gallery.js:1994:17": {
        key: "web.sheets.gallery.gallery-update-sheet.title.update.update",
        english: "Update {title}",
        values: { title: "data.title" },
        why: "update title preserves author text",
    },
    "gallery.js:2014:142": {
        key: "web.sheets.gallery.gallery-update-sheet.text.make-sure-trust-new",
        english: "Make sure you trust the new one.",
        why: "repository trust warning",
    },
    "gallery.js:2020:131": {
        key: "web.sheets.gallery.gallery-update-sheet.text.diff-against-your-files",
        english: "The diff is against your files, and the update replaces them.",
        why: "replacement warning",
    },
    "gallery.js:2160:39": {
        key: "web.sheets.gallery.gallery-share-sheet.title.share",
        english: "Share {name}",
        values: { name: "shareName" },
        occurrence: 0,
        why: "loading sheet title preserves author name",
    },
    "gallery.js:2202:35": {
        key: "web.sheets.gallery.gallery-share-sheet.title.share",
        english: "Share {name}",
        values: { name: "shareName" },
        occurrence: 1,
        why: "loaded sheet title preserves author name",
    },
    "memory.js:370:25": {
        key: "web.sheets.memory.memory-sheet.title.approve",
        english: "To approve · {count}",
        values: { count: "waiting.length" },
        occurrence: 0,
        why: "pending-only group count",
    },
    "memory.js:382:128": {
        key: "web.sheets.memory.memory-sheet.p.those-for-project",
        english:
            "Those for {name} go to every session in it, worktrees too; the rest go everywhere.",
        values: { name: "project.name" },
        why: "project introduction prefix",
    },
    "memory.js:382:161": {
        key: "web.sheets.memory.memory-sheet.p.those-for-project",
        english:
            "Those for {name} go to every session in it, worktrees too; the rest go everywhere.",
        values: { name: "project.name" },
        why: "project introduction suffix",
    },
    "memory.js:435:25": {
        key: "web.sheets.memory.memory-sheet.title.approve",
        english: "To approve · {count}",
        values: { count: "waiting.length" },
        occurrence: 1,
        why: "project group count",
    },
    "memory.js:444:25": {
        key: "web.sheets.memory.memory-sheet.title.project",
        english: "This project: {name}",
        values: { name: "project.name" },
        why: "group title preserves project name",
    },
};

function decideExtra(record: RecordOfCandidate, tree: ts.SourceFile, current: Call[]) {
    const id = `${record.file.split("/").at(-1)}:${record.line}:${record.column}`;
    const audit = extraAudit[id];

    assert.ok(audit, `extra candidate has no audit: ${id}`);

    if (!audit.key) {
        assert.equal(record.raw, ".ts", id);
        assert.ok(tree.text.includes(".ts"), `literal extension must remain in ${id}`);

        return { status: "excluded", why: audit.why, keys: [] as string[] };
    }

    const matches = current.filter(
        (call) => call.key === audit.key && call.english === audit.english,
    );
    const selected = matches[audit.occurrence ?? 0];

    assert.ok(selected, `exact key and fallback missing at ${id}`);
    const node = findCall(tree, selected.start);

    if (audit.values) {
        const values = node.arguments[2];

        assert.ok(values && ts.isObjectLiteralExpression(values), `missing values at ${id}`);

        for (const [field, source] of Object.entries(audit.values)) {
            const property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined =
                values.properties.find(
                    (item): item is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
                        (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) &&
                        item.name.getText(tree) === field,
                );

            assert.ok(property, `missing ${field} at ${id}`);
            const actual: string = ts.isPropertyAssignment(property)
                ? property.initializer.getText(tree)
                : property.name.getText(tree);

            assert.equal(actual, source, `incorrect ${field} source at ${id}`);
        }
    }

    const pos = tree.getLineAndCharacterOfPosition(selected.start);

    return {
        status: "translated",
        why: `${audit.why}; ${record.file}:${pos.line + 1}:${pos.character + 1}; fallback ${JSON.stringify(audit.english)}`,
        keys: [audit.key],
    };
}

function findCall(tree: ts.SourceFile, start: number) {
    let found: ts.CallExpression | undefined;

    function visit(node: ts.Node) {
        if (
            ts.isCallExpression(node) &&
            node.getStart(tree) === start &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "t"
        ) {
            found = node;
        }

        ts.forEachChild(node, visit);
    }

    visit(tree);
    assert.ok(found, `missing AST call at ${tree.fileName}:${start}`);

    return found;
}

function nodeNamed(tree: ts.SourceFile, scope: string) {
    if (scope === "<module>") {
        return tree;
    }

    const parts = scope.split("/");
    const name = parts.at(-1)!;
    const result: ts.Node[] = [];

    function visit(node: ts.Node) {
        if (
            (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
            (ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === name &&
                node.initializer)
        ) {
            let parent: ts.Node | undefined = node.parent;
            let parentFound = parts.length === 1;

            while (parent && !parentFound) {
                if (
                    (ts.isFunctionDeclaration(parent) && parent.name?.text === parts[0]) ||
                    (ts.isVariableDeclaration(parent) &&
                        ts.isIdentifier(parent.name) &&
                        parent.name.text === parts[0])
                ) {
                    parentFound = true;
                }

                parent = parent.parent;
            }

            if (parentFound) {
                result.push(node);
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(tree);
    assert.equal(result.length, 1, `${tree.fileName}: ${scope} producer count`);

    return result[0]!;
}

const normalize = (s: string) => s.replace(/\\[nr]/g, "").replace(/\s+/g, "");

function reportStart(text: string, position: number, raw: string) {
    if (raw.startsWith("${")) {
        return text.lastIndexOf("${", position);
    }

    if (text[position] === "\x60") {
        return position + 1;
    }

    return position;
}

const records = readReport();
const manual = records.filter((record) => record.section === "需人工");
const extra = records.filter((record) => record.section === "无法映射键");
const id = (file: string, line: number, column: number) =>
    `${file.split("/").at(-1)}:${line}:${column}`;
const audited = new Map<string, AuditDecision>();

for (const item of audit.decisions) {
    const key = id(item.file, item.line, item.column);

    assert.ok(!audited.has(key), `duplicate reviewed candidate ${key}`);
    assert.ok(statuses.includes(item.status), `invalid status ${key}`);
    assert.ok(
        item.reason && item.scopes.includes(item.producer),
        `missing producer or reason ${key}`,
    );
    audited.set(key, item);
}

assert.equal(audited.size, manual.length, "one explicit audit per manual report row");
assert.equal(
    Object.keys(extraAudit).length,
    extra.length,
    "one explicit audit per extra report row",
);
const reviewCalls = new Map(audit.calls.map((call) => [`${call.file}::${call.key}`, call]));
const reviewExpressions = new Map(
    audit.expressions.map((item) => [`${item.file}::${item.scope}::${item.expression}`, item]),
);

assert.equal(reviewCalls.size, audit.calls.length, "unique exact-key evidence");
assert.equal(reviewExpressions.size, audit.expressions.length, "unique expression evidence");
const result = new Map<string, { status: string; why: string; keys: string[] }>();
const staticKeys = new Set<string>();

for (const file of files) {
    const shortFile = file.split("/").at(-1)!;
    const beforeText = execFileSync("git", ["show", `${BASE}:${file}`], {
        cwd: ROOT,
        encoding: "utf8",
    });
    const currentText = readFileSync(join(ROOT, file), "utf8");

    assert.equal(
        sha256(currentText),
        audit.sourceHashes[shortFile],
        `${file} differs from reviewed production bytes`,
    );
    const before = parse(file, beforeText);
    const after = parse(file, currentText);
    const now = calls(after);

    for (const call of now) {
        staticKeys.add(call.key);
        assert.equal(
            catalog.get(call.key),
            call.english,
            `${file}: handoff missing or changed ${call.key}`,
        );
    }

    const entryResult = analyzeSource({
        file,
        source: beforeText,
        records: sourceMap.filter((item) => item.file === file),
        english,
        chinese,
    });
    const entry = parse(file, entryResult.code);

    for (const origin of audit.baselineKeyScopes.filter((item) => item.file === shortFile)) {
        if (origin.origin === "automatic") {
            assert.ok(
                entryResult.automatic.some(
                    (item: { key: string; english: string; line: number; column: number }) =>
                        item.key === origin.key &&
                        item.english === origin.english &&
                        item.line === origin.line &&
                        item.column === origin.column,
                ),
                `${file}: missing original codemod origin ${origin.key}`,
            );
        } else {
            assert.equal(origin.origin, "baseline", `${file}: invalid original key origin`);
            const start = ts.getPositionOfLineAndCharacter(
                before,
                origin.line - 1,
                origin.column - 1,
            );
            const old = findCall(before, start);

            assert.ok(
                ts.isStringLiteral(old.arguments[0]!) &&
                    (old.arguments[0] as ts.StringLiteral).text === origin.key,
                `${file}: missing baseline key ${origin.key}`,
            );
            assert.ok(
                ts.isStringLiteral(old.arguments[1]!) &&
                    (old.arguments[1] as ts.StringLiteral).text === origin.english,
                `${file}: baseline fallback differs ${origin.key}`,
            );
        }

        const node = nodeNamed(entry, origin.scope);
        let found = false;

        function visit(candidate: ts.Node) {
            if (
                ts.isCallExpression(candidate) &&
                ts.isIdentifier(candidate.expression) &&
                candidate.expression.text === "t" &&
                candidate.arguments[0] &&
                ts.isStringLiteral(candidate.arguments[0]) &&
                candidate.arguments[0].text === origin.key &&
                candidate.arguments[1] &&
                ts.isStringLiteral(candidate.arguments[1]) &&
                candidate.arguments[1].text === origin.english
            ) {
                found = true;
            }

            ts.forEachChild(candidate, visit);
        }

        visit(node);
        assert.ok(found, `${file}: original codemod scope ${origin.scope} missing ${origin.key}`);
    }

    for (const [identity, checked] of Object.entries(audit.identities)) {
        if (!identity.startsWith(`${shortFile}::`)) {
            continue;
        }

        const scope = identity.slice(shortFile.length + 2);
        const node = nodeNamed(after, scope);
        const point = after.getLineAndCharacterOfPosition(node.getStart(after));

        assert.equal(point.line + 1, checked.line, identity);
        assert.equal(point.character + 1, checked.column, identity);
        assert.equal(
            sha256(node.getText(after)),
            checked.sha256,
            `${identity} reviewed AST bytes changed`,
        );
    }

    for (const check of audit.calls.filter((item) => item.file === shortFile)) {
        assert.equal(
            catalog.get(check.key),
            check.english,
            `${check.key} differs from independently generated key fixture`,
        );
        const position = ts.getPositionOfLineAndCharacter(after, check.line - 1, check.column - 1);
        const node = findCall(after, position);

        assert.ok(
            node.arguments[0] &&
                ts.isStringLiteral(node.arguments[0]) &&
                node.arguments[0].text === check.key,
            `${check.key} call-site key`,
        );
        assert.ok(
            node.arguments[1] &&
                ts.isStringLiteral(node.arguments[1]) &&
                node.arguments[1].text === check.english,
            `${check.key} call-site fallback`,
        );
        assert.equal(
            node.arguments[2]?.getText(after) ?? null,
            check.values,
            `${check.key} exact placeholder value expressions`,
        );

        for (const scope of check.scopes) {
            const producer = nodeNamed(after, scope);

            assert.ok(
                position >= producer.getStart(after) && node.end <= producer.end,
                `${check.key} escaped ${scope}`,
            );
        }
    }

    for (const check of audit.expressions.filter((item) => item.file === shortFile)) {
        const producer = nodeNamed(after, check.scope);
        const normalized = producer.getText(after).replace(/\s+/g, "");

        assert.equal(
            normalized.indexOf(check.expression.replace(/\s+/g, "")),
            check.offset,
            `${shortFile} ${check.scope} producer/expression link changed: ${check.expression}`,
        );
    }

    const resultIds = new Set<string>();

    for (const item of records.filter((record) => record.file === file)) {
        const key = id(file, item.line, item.column);
        const offset = ts.getPositionOfLineAndCharacter(before, item.line - 1, item.column - 1);
        const start = reportStart(beforeText, offset, item.raw);
        const actual = normalize(
            beforeText.slice(start, offset + Math.min(item.raw.length * 3 + 100, 40000)),
        );

        assert.ok(
            start >= 0 && actual.startsWith(normalize(item.raw)),
            `baseline report mismatch ${file}:${item.line}:${item.column}`,
        );
        const original = (
            item.section === "需人工" ? entryResult.manual : entryResult.unmapped
        ).find(
            (entryItem: { line: number; column: number }) =>
                entryItem.line === item.line && entryItem.column === item.column,
        );

        assert.ok(original, `original codemod candidate missing ${key}`);
        assert.equal(original.english, item.raw, `exact original candidate raw differs ${key}`);
        let decision: { status: string; why: string; keys: string[] };

        if (item.section === "无法映射键") {
            decision = decideExtra(item, after, now);
        } else {
            const reviewed = audited.get(key);

            assert.ok(reviewed, `missing reviewed candidate ${key}`);
            assert.equal(reviewed.raw, item.raw, `review fixture raw differs from original ${key}`);

            for (const scope of reviewed.scopes) {
                assert.ok(
                    audit.identities[`${shortFile}::${scope}`],
                    `${key} missing reviewed producer ${scope}`,
                );
            }

            for (const messageKey of reviewed.keys) {
                assert.ok(
                    reviewCalls.has(`${shortFile}::${messageKey}`),
                    `${key} missing exact call evidence ${messageKey}`,
                );
            }

            for (const expression of reviewed.expressions) {
                assert.ok(
                    reviewExpressions.has(`${shortFile}::${expression}`),
                    `${key} missing expression link ${expression}`,
                );
            }

            if (reviewed.status === "already-wired") {
                for (const messageKey of reviewed.keys) {
                    assert.ok(
                        audit.baselineKeyScopes.some(
                            (origin) =>
                                origin.file === shortFile &&
                                origin.key === messageKey &&
                                reviewed.scopes.includes(origin.scope),
                        ),
                        `${key} missing same-producer session-entry evidence: ${messageKey}`,
                    );
                }
            }

            if (reviewed.status === "translated") {
                assert.ok(reviewed.keys.length > 0, `${key} translated without explicit keys`);
            }

            decision = {
                status: reviewed.status,
                why: `${reviewed.reason}; producer=${reviewed.producer}; scopes=${reviewed.scopes.join(",")}; expressions=${reviewed.expressions.join("|")}`,
                keys: reviewed.keys,
            };
        }

        assert.ok(!resultIds.has(`${item.section}:${key}`), `duplicate report candidate ${key}`);
        resultIds.add(`${item.section}:${key}`);
        result.set(`${item.section}:${key}`, decision);
        console.log(
            [
                item.section,
                `${file}:${item.line}:${item.column}`,
                decision.status,
                decision.why,
                decision.keys.join(",") || "-",
                JSON.stringify(item.raw),
            ].join("\t"),
        );
    }
}

for (const item of audit.decisions) {
    assert.ok(
        result.has(`需人工:${id(item.file, item.line, item.column)}`),
        `orphan audit ${id(item.file, item.line, item.column)}`,
    );
}

for (const file of files) {
    for (const section of Object.keys(counts) as Section[]) {
        const subset = records.filter(
            (record) => record.file === file && record.section === section,
        );
        const total = (status: string) =>
            subset.filter(
                (record) =>
                    result.get(`${section}:${id(file, record.line, record.column)}`)?.status ===
                    status,
            ).length;
        const labels = section === "需人工" ? statuses : ["translated", "excluded"];
        const values = labels.map((status) => `${status}=${total(status)}`);

        assert.equal(
            labels.reduce((sum, status) => sum + total(status), 0),
            subset.length,
            `${file} ${section} missing outcome`,
        );
        console.log(
            `SUMMARY\t${file}\t${section}\ttotal=${subset.length}\t${values.join("\t")}\tunresolved=0`,
        );
    }
}

assert.equal(result.size, records.length, "each original report row counted exactly once");
assert.equal(
    staticKeys.size,
    catalog.size,
    "handoff has stale keys absent from current WP4 source",
);
console.log(
    `MESSAGES\tkeys=${catalog.size}\tabsent=${messageRows.filter((entry) => entry.catalog === "absent").length}`,
);
console.log(`TOTAL\tmanual=${manual.length}\tunmapped=${extra.length}\tunresolved=0`);
