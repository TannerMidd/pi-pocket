// Build the source-bound review fixture from the 4 planner audits, never from aggregate totals.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { analyzeSource } from "/home/xianbei233/Work/pi-pocket-pr-notes/dictionary/tools/codemod.mjs";
import { extensions } from "./wp4-audit-extensions.ts";
import { galleryFirst } from "./wp4-audit-gallery-first.ts";
import { galleryLast } from "./wp4-audit-gallery-last.ts";
import { memory } from "./wp4-audit-memory.ts";
import { menu } from "./wp4-audit-menu.ts";
import type { Builder, Decision, SourceFileWithParseDiagnostics } from "./wp4-audit.ts";

const root = join(import.meta.dirname, "..");
const dictionary = "/home/xianbei233/Work/pi-pocket-pr-notes/dictionary";
const baseline = "5e8e2de85bb3e5f04eb56c3ee2360c641a30b979";
// A fixture regeneration must not silently accept later edits as reviewed source.
const reviewedHashes: Record<string, string> = {
    "extensions.js": "dd18ff0788396bef36487f97460ff01b2d0a172b4c23ee437e0f2294d705317d",
    "gallery.js": "3219347e8ed5270c81095dcf33b790c55a27e4e0ad0e6fbf869bdbbe91fe985b",
    "memory.js": "1968f82f70f0f53293878d9376c17aba0247e96e174f03f04cfd722ce07deb7f",
    "menu.js": "f5e65a6023c1694c1aac12d7b41712932588a22313f9d4635c3eda50b00ab1df",
};
const names = ["extensions", "gallery", "memory", "menu"];
const fileOf = (name: string) => `web/sheets/${name}.js`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const messages = new Map(
    (
        JSON.parse(readFileSync(join(import.meta.dirname, "wp4-messages.json"), "utf8")) as {
            key: string;
            english: string;
        }[]
    ).map((item) => [item.key, item.english]),
);
const trees = new Map<string, ts.SourceFile>();
const entryTrees = new Map<string, SourceFileWithParseDiagnostics>();
const entryKeys = new Map<string, Set<string>>();
const entryOrigins = new Map<
    string,
    {
        key: string;
        english: string;
        line: number;
        column: number;
        origin: "automatic" | "baseline";
    }[]
>();
const rawCandidates = new Map<string, string>();
let section = "";

for (const line of readFileSync(join(dictionary, "CODEMOD-WEB.md"), "utf8").split("\n")) {
    const heading = line.match(/^## (可自动改写|需人工|无法映射键)\s*$/);

    if (heading) {
        section = heading[1]!;
        continue;
    }

    if (section !== "需人工") {
        continue;
    }

    const match = line.match(
        /^- (web\/sheets\/(?:extensions|gallery|memory|menu)\.js):(\d+):(\d+) (?:\[[^\]]+\] |key=[^ ]+ )?原文=("(?:[^"\\]|\\.)*")/,
    );

    if (!match) {
        continue;
    }

    const key = `${match[1]!.split("/").at(-1)}:${match[2]}:${match[3]}`;

    assert.ok(!rawCandidates.has(key), `duplicate manual candidate ${key}`);
    rawCandidates.set(key, JSON.parse(match[4]!));
}

const allRecords = JSON.parse(readFileSync(join(dictionary, "SOURCE-MAP.json"), "utf8")).records;
const english = JSON.parse(readFileSync(join(dictionary, "en-REFERENCE.json"), "utf8")).messages;
const chinese = JSON.parse(readFileSync(join(dictionary, "zh-CN-DRAFT.json"), "utf8")).messages;

for (const name of names) {
    const file = fileOf(name);
    const current = readFileSync(join(root, file), "utf8");

    assert.equal(
        hash(current),
        reviewedHashes[`${name}.js`],
        `${file} changed since source review; review it again`,
    );
    const base = execFileSync("git", ["show", `${baseline}:${file}`], {
        cwd: root,
        encoding: "utf8",
    });
    const result = analyzeSource({
        file,
        source: base,
        records: allRecords.filter((item: { file: string }) => item.file === file),
        english,
        chinese,
    });

    assert.equal(
        result.manual.length,
        { extensions: 61, gallery: 209, memory: 33, menu: 12 }[name],
    );
    assert.equal(result.unmapped.length, { extensions: 5, gallery: 9, memory: 5, menu: 0 }[name]);
    const entry = ts.createSourceFile(
        file,
        result.code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    ) as SourceFileWithParseDiagnostics;
    const live = ts.createSourceFile(
        file,
        current,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    ) as SourceFileWithParseDiagnostics;

    assert.equal(entry.parseDiagnostics.length, 0, `${file} session-entry codemod`);
    assert.equal(live.parseDiagnostics.length, 0, file);
    trees.set(`${name}.js`, live);
    entryTrees.set(`${name}.js`, entry);
    const keys = new Set<string>();

    function visit(node: ts.Node) {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "t" &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
        ) {
            keys.add(node.arguments[0].text);
        }

        ts.forEachChild(node, visit);
    }

    visit(entry);
    entryKeys.set(`${name}.js`, keys);
    const origins: {
        key: string;
        english: string;
        line: number;
        column: number;
        origin: "automatic" | "baseline";
    }[] = result.automatic.map(
        (item: { key: string; english: string; line: number; column: number }) => ({
            key: item.key,
            english: item.english,
            line: item.line,
            column: item.column,
            origin: "automatic" as const,
        }),
    );
    const baseTree = ts.createSourceFile(
        file,
        base,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );

    function visitBase(node: ts.Node) {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "t" &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0]) &&
            node.arguments[1] &&
            ts.isStringLiteral(node.arguments[1])
        ) {
            const point = baseTree.getLineAndCharacterOfPosition(node.getStart(baseTree));

            origins.push({
                key: node.arguments[0].text,
                english: node.arguments[1].text,
                line: point.line + 1,
                column: point.character + 1,
                origin: "baseline",
            });
        }

        ts.forEachChild(node, visitBase);
    }

    visitBase(baseTree);
    entryOrigins.set(`${name}.js`, origins);
}

function ancestorContains(node: ts.Node, tree: ts.SourceFile, wanted: string) {
    if (wanted === "<module>") {
        for (let p = node.parent; p; p = p.parent) {
            if (
                ts.isFunctionDeclaration(p) ||
                ts.isArrowFunction(p) ||
                ts.isFunctionExpression(p)
            ) {
                return false;
            }
        }

        return true;
    }

    for (let p: ts.Node | undefined = node; p; p = p.parent) {
        if (ts.isFunctionDeclaration(p) && p.name?.text === wanted) {
            return true;
        }

        if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.name.text === wanted) {
            return true;
        }
    }

    return false;
}

function nodeNamed(tree: ts.SourceFile, scope: string) {
    if (scope === "<module>") {
        return tree;
    }

    const parts = scope.split("/");
    const name = parts.at(-1)!;
    const out: ts.Node[] = [];

    function visit(node: ts.Node) {
        if (
            (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
            (ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === name &&
                node.initializer)
        ) {
            if (parts.length === 1 || ancestorContains(node.parent, tree, parts[0]!)) {
                out.push(node);
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(tree);
    assert.equal(out.length, 1, `${tree.fileName} producer ${scope} count ${out.length}`);

    return out[0]!;
}

function within(tree: ts.SourceFile, parent: ts.Node, key: string, englishText: string) {
    const out: ts.CallExpression[] = [];

    function visit(node: ts.Node) {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "t" &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0]) &&
            node.arguments[0].text === key &&
            node.arguments[1] &&
            ts.isStringLiteral(node.arguments[1]) &&
            node.arguments[1].text === englishText
        ) {
            out.push(node);
        }

        ts.forEachChild(node, visit);
    }

    visit(parent);

    return out;
}

const compact = (text: string) => text.replace(/\s+/g, "");
const drafts: Decision[] = [];
const seen = new Set<string>();
const builder: Builder = {
    add(file, positions, status, producer, reason, scopes, keys = [], expressions = []) {
        const tree = trees.get(file);

        assert.ok(tree, `unknown audit file ${file}`);
        assert.ok(
            scopes.includes(producer),
            `${file} producer ${producer} must be an audited scope`,
        );
        const fullKeys = keys.map((key) =>
            key.startsWith("web.") || key.startsWith("menu.") || key.startsWith("app.")
                ? key
                : `web.sheets.${file.slice(0, -3)}.${key}`,
        );

        for (const pos of positions.trim().split(/\s+/)) {
            const [line, column, ...extra] = pos.split(":").map(Number);

            assert.ok(
                line && column && extra.length === 0,
                `invalid audit position ${file}:${pos}`,
            );
            const id = `${file}:${line}:${column}`;

            assert.ok(!seen.has(id), `duplicate audit position ${id}`);
            assert.ok(rawCandidates.has(id), `position missing from original report ${id}`);
            seen.add(id);
            drafts.push({
                file,
                line,
                column,
                status,
                producer,
                reason,
                scopes,
                keys: fullKeys,
                expressions,
            });
        }
    },
};

for (const review of [extensions, galleryFirst, galleryLast, memory, menu]) {
    review(builder);
}

assert.equal(seen.size, rawCandidates.size, "every original manual position reviewed exactly once");
const identities = new Map<
    string,
    { line: number; column: number; sha256: string; source: string }
>();
const requiredChecks: Record<
    string,
    { scopes?: string[]; keys?: string[]; expressions?: string[] }
> = {
    "extensions.js:222:47": {
        keys: ["web.sheets.extensions.module-settings.hint.set-type-replace"],
        expressions: ["ModuleSettings::field.placeholder"],
    },
    "extensions.js:224:41": {
        keys: [
            "web.sheets.extensions.module-settings.range.content",
            "web.sheets.extensions.module-settings.range.content.fallback.any",
        ],
        expressions: ["ModuleSettings::field.min ?? any", "ModuleSettings::field.max ?? any"],
    },
    "extensions.js:373:15": {
        scopes: ["PIP_COMPACT", "PipCompactAt"],
        keys: ["web.sheets.extensions.pip-compact.sessions"],
        expressions: ["PipCompactAt::label()"],
    },
    "extensions.js:380:23": {
        scopes: ["PIP_COMPACT", "PipCompactAt"],
        keys: ["web.sheets.extensions.pip-compact.sessions"],
        expressions: ["PipCompactAt::label()"],
    },
    "gallery.js:377:60": {
        scopes: ["Status", "liveStatus"],
        keys: [
            "web.sheets.gallery.live-status.text.revoked",
            "web.sheets.gallery.live-status.text.off",
        ],
        expressions: ["Status::status.text"],
    },
    "gallery.js:550:87": {
        scopes: ["ThemeCard", "GallerySheet"],
        keys: [
            "web.sheets.gallery.entry-row.text.installed",
            "web.sheets.extensions.extensions-content.text.yours",
        ],
    },
    "gallery.js:768:11": {
        scopes: ["kindLabel", "wantLabel"],
        expressions: ["GallerySheet::kindLabel(value)", "GallerySheet::wantLabel(value)"],
    },
    "gallery.js:1010:23": { scopes: ["GROUPS", "Declares"], expressions: ["Declares::label()"] },
    "gallery.js:1028:19": {
        scopes: ["Declares", "accessWords"],
        expressions: ["Declares::accessWords(declares.access)", "accessWords::return access"],
    },
    "gallery.js:1168:23": {
        keys: [
            "web.sheets.gallery.entry-facts.text.needs-extension-api",
            "web.sheets.gallery.entry-facts.text.needs-theme-api",
        ],
        expressions: [
            "EntryFacts::${needs}",
            "GalleryEntrySheet::entry.pocketApi",
            "ThemeEntry::entry.themeApi",
        ],
    },
    "gallery.js:1202:52": {
        scopes: ["ReachSection", "reachRows"],
        expressions: ["ReachSection::reachRows(", "ReachSection::row.text"],
    },
    "gallery.js:1343:66": {
        scopes: ["TurnOnDialog", "reachRows"],
        expressions: ["TurnOnDialog::reachRows(", "TurnOnDialog::row.text"],
    },
    "gallery.js:1662:11": {
        scopes: ["Swatches", "roleLabel"],
        expressions: ["Swatches::roleLabel(key)", "Swatches::colors[key]"],
    },
    "gallery.js:1669:15": {
        scopes: ["Swatches", "roleLabel", "textLabel"],
        expressions: ["Swatches::textLabel(key)", "textLabel::roleLabel(key)"],
    },
    "gallery.js:2054:80": {
        scopes: ["GalleryUpdateSheet", "changeLabel"],
        keys: [
            "web.sheets.gallery.gallery-update-sheet.span.change-added",
            "web.sheets.gallery.gallery-update-sheet.span.change-removed",
            "web.sheets.gallery.gallery-update-sheet.span.change-changed",
            "web.sheets.gallery.gallery-update-sheet.span.change-same",
        ],
        expressions: [
            "GalleryUpdateSheet::changeLabel(file.change)",
            "GalleryUpdateSheet::gallery-change ${file.change}",
        ],
    },
    "gallery.js:2130:50": {
        scopes: ["Field", "fieldProblems", "GalleryShareSheet"],
        expressions: ["GalleryShareSheet::fieldProblems(typed)", "Field::${problem}"],
    },
    "memory.js:288:36": {
        scopes: ["Group", "MemorySheet"],
        expressions: ["Group::${title}", "MemorySheet::<${Group}"],
    },
    "memory.js:289:74": {
        scopes: ["Group", "MemorySheet"],
        expressions: ["Group::${empty}", "MemorySheet::<${Group}"],
    },
    "menu.js:224:11": {
        scopes: ["PlacesGrid", "PLACES"],
        expressions: ['PlacesGrid::slotItems("places", { changes })', "PLACES::label: () => t"],
    },
};

for (const [id, required] of Object.entries(requiredChecks)) {
    const row = drafts.find((item) => `${item.file}:${item.line}:${item.column}` === id);

    assert.ok(row, `missing required audit ${id}`);

    for (const field of ["scopes", "keys", "expressions"] as const) {
        for (const value of required[field] ?? []) {
            assert.ok(row[field].includes(value), `${id} lacks required ${field} ${value}`);
        }
    }
}

const calls = new Map<
    string,
    {
        file: string;
        key: string;
        english: string;
        line: number;
        column: number;
        scopes: string[];
        values: string | null;
    }
>();
const exprs = new Map<
    string,
    {
        file: string;
        scope: string;
        expression: string;
        offset: number;
        line: number;
        column: number;
    }
>();
const errors: string[] = [];
const baselineKeyScope = new Set<string>();

for (const row of drafts) {
    const tree = trees.get(row.file)!;
    const entry = entryTrees.get(row.file)!;
    const id = `${row.file}:${row.line}:${row.column}`;

    try {
        for (const scope of row.scopes) {
            const identity = `${row.file}::${scope}`;

            if (!identities.has(identity)) {
                const node = nodeNamed(tree, scope);
                const at = tree.getLineAndCharacterOfPosition(node.getStart(tree));

                identities.set(identity, {
                    line: at.line + 1,
                    column: at.character + 1,
                    sha256: hash(node.getText(tree)),
                    source: node.getText(tree),
                });
            }
        }

        for (const key of row.keys) {
            const text = messages.get(key);

            assert.notEqual(text, undefined, `missing exact fallback ${key}`);
            const found: { scope: string; call: ts.CallExpression }[] = [];

            for (const scope of row.scopes) {
                for (const call of within(tree, nodeNamed(tree, scope), key, text!)) {
                    found.push({ scope, call });
                }
            }

            assert.ok(found.length, `${key} not inside named producers ${row.scopes.join(", ")}`);
            const chosen = found[0]!;
            const pos = tree.getLineAndCharacterOfPosition(chosen.call.getStart(tree));
            const identity = `${row.file}::${key}`;
            const previous = calls.get(identity);

            if (!previous) {
                calls.set(identity, {
                    file: row.file,
                    key,
                    english: text!,
                    line: pos.line + 1,
                    column: pos.character + 1,
                    scopes: [...new Set(found.map((item) => item.scope))],
                    values: chosen.call.arguments[2]?.getText(tree) ?? null,
                });
            } else {
                assert.equal(previous.english, text);
            }

            if (row.status === "already-wired") {
                assert.ok(
                    entryKeys.get(row.file)!.has(key),
                    `${key} absent from original automatic codemod inventory`,
                );
                const origin = entryOrigins.get(row.file)!.find((item) => item.key === key);

                assert.ok(origin, `${key} missing baseline/codemod origin`);
                const entryScope = nodeNamed(entry, chosen.scope);

                assert.ok(
                    within(entry, entryScope, key, text!).length,
                    `${key} absent from original scope ${chosen.scope}`,
                );
                baselineKeyScope.add(`${row.file}::${chosen.scope}::${key}`);
            }
        }

        for (const check of row.expressions) {
            const at = check.indexOf("::");

            assert.ok(at > 0, `expression must name a scope: ${check}`);
            const scope = check.slice(0, at);
            const expression = check.slice(at + 2);

            assert.ok(row.scopes.includes(scope), `expression scope not reviewed: ${check}`);
            const node = nodeNamed(tree, scope);
            const raw = node.getText(tree);
            const offset = compact(raw).indexOf(compact(expression));

            assert.ok(offset >= 0, `${check} missing from reviewed AST node`);
            const absolute = tree.text.indexOf(expression, node.getStart(tree));
            const pos = tree.getLineAndCharacterOfPosition(
                absolute >= node.getStart(tree) && absolute < node.end
                    ? absolute
                    : node.getStart(tree),
            );

            exprs.set(`${row.file}::${check}`, {
                file: row.file,
                scope,
                expression,
                offset,
                line: pos.line + 1,
                column: pos.character + 1,
            });
        }

        if (row.status === "already-wired") {
            assert.ok(row.keys.length > 0, "already-wired decision must name its keys");
            assert.ok(entry.parseDiagnostics.length === 0);
        }
    } catch (error) {
        errors.push(`${id}: ${(error as Error).message}`);
    }
}

for (const error of errors) {
    console.error(error);
}

if (errors.length) {
    console.error(`${errors.length} audit validation errors; no fixture written.`);
    process.exitCode = 1;
} else {
    const raw = JSON.parse(readFileSync(join(dictionary, "en-REFERENCE.json"), "utf8"));

    assert.ok(raw.messages);
    const output = {
        baseline,
        sourceHashes: Object.fromEntries([...trees].map(([file, tree]) => [file, hash(tree.text)])),
        identities: Object.fromEntries(
            [...identities].map(([key, value]) => [
                key,
                { line: value.line, column: value.column, sha256: value.sha256 },
            ]),
        ),
        calls: [...calls.values()],
        baselineKeyScopes: [...baselineKeyScope].map((item) => {
            const [file, scope, key] = item.split("::");
            const original = entryOrigins.get(file!)!.find((candidate) => candidate.key === key)!;

            return { file, scope, ...original };
        }),
        expressions: [...exprs.values()],
        decisions: drafts.map((row) => ({
            ...row,
            raw: rawCandidates.get(`${row.file}:${row.line}:${row.column}`),
        })),
    };

    writeFileSync(
        join(import.meta.dirname, "wp4-audit.json"),
        JSON.stringify(output, null, 2) + "\n",
    );
    console.log(
        `Wrote ${drafts.length} source-bound audit records; ${identities.size} producer identities; ${calls.size} exact keys; ${exprs.size} expression links.`,
    );
}
