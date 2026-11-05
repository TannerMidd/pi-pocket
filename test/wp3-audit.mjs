// Reparse the report, bind every baseline position to its named real source function, and keep unresolved items explicit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const baseline = "5e8e2de85bb3e5f04eb56c3ee2360c641a30b979";
const reportPath = "/home/xianbei233/Work/pi-pocket-pr-notes/dictionary/CODEMOD-WEB.md";
const reviewPath = new URL("./wp3-review.json", import.meta.url);
const reportHash = "503090b2102ef9161fd5a8769568fcc777f2b8ac78624396a2fb759fa0be88a0";
const files =
    "browser-panel diff files-panel linked-sessions peeks pip rich run-frame subagents-board subagents"
        .split(" ")
        .map((name) => `web/${name}.js`);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const source = (file) => readFileSync(new URL(file, root), "utf8");
const id = (row) => `${row.section}:${row.file}:${row.line}:${row.column}`;
const normalize = (text) => text.replace(/\s+/g, " ").trim();

function reportRows(text) {
    let section;
    const rows = [];

    for (const line of text.split("\n")) {
        const heading = line.match(/^## (可自动改写|需人工|无法映射键)\s*$/);

        if (heading) {
            section = heading[1];
        }

        const match = line.match(
            /^- ((?:web|src\/server)\/[^:\r\n]+):(\d+):(\d+) (?:\[([^\]]+)\] |key=([^ ]+) )?原文=("(?:[^"\\]|\\.)*")(.*)$/,
        );

        if (!match || !files.includes(match[1]) || section === "可自动改写") {
            continue;
        }

        const [, file, lineNumber, column, reason, automatic, quoted, tail] = match;
        const key = automatic ?? tail.match(/^（key=([^）]+)）/)?.[1] ?? null;

        rows.push({
            file,
            line: Number(lineNumber),
            column: Number(column),
            section,
            reason: reason ?? null,
            raw: JSON.parse(quoted),
            key,
        });
    }

    return rows;
}

function parse(file, text) {
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

    assert.equal(tree.parseDiagnostics.length, 0, `${file}: parse failed`);

    return tree;
}

function smallest(tree, position) {
    let found = tree;

    function visit(node) {
        if (node.getStart(tree) <= position && position < node.end) {
            found = node;
            ts.forEachChild(node, visit);
        }
    }

    visit(tree);

    return found;
}

function functionIdentity(node) {
    for (let each = node; each; each = each.parent) {
        if (ts.isFunctionDeclaration(each) && each.name) {
            return `function:${each.name.text}`;
        }

        if (ts.isMethodDeclaration(each) && each.name) {
            let owner = each.parent;

            while (owner && !ts.isClassDeclaration(owner)) {
                owner = owner.parent;
            }

            return `method:${owner?.name?.text ?? "?"}.${each.name.getText()}`;
        }

        if (
            (ts.isArrowFunction(each) || ts.isFunctionExpression(each)) &&
            ts.isVariableDeclaration(each.parent) &&
            ts.isIdentifier(each.parent.name)
        ) {
            return `variable:${each.parent.name.text}`;
        }
    }

    return undefined;
}

function functionsOf(tree) {
    const found = new Map();

    function visit(node) {
        if (ts.isFunctionLike(node)) {
            const identity = functionIdentity(node);

            if (identity && functionIdentity(node.parent) !== identity) {
                const bucket = found.get(identity) ?? [];

                bucket.push(node);
                found.set(identity, bucket);
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(tree);

    return found;
}

function isT(node) {
    return (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "t"
    );
}

function tCalls(node) {
    const found = [];

    function visit(each) {
        if (isT(each)) {
            found.push(each);
        }

        ts.forEachChild(each, visit);
    }

    visit(node);

    return found;
}

function firstExpression(node, tree) {
    for (let each = node; each; each = each.parent) {
        if (ts.isTemplateSpan(each)) {
            return normalize(each.expression.getText(tree));
        }
    }

    return "";
}

function lineOf(tree, position) {
    return tree.getLineAndCharacterOfPosition(position).line + 1;
}

function audit() {
    const report = readFileSync(reportPath, "utf8");

    assert.equal(sha(report), reportHash, "CODEMOD-WEB.md fingerprint changed");
    const rows = reportRows(report);

    assert.equal(rows.filter((row) => row.section === "需人工").length, 297);
    assert.equal(rows.filter((row) => row.section === "无法映射键").length, 11);
    assert.equal(new Set(rows.map(id)).size, 308, "candidate coordinates must be unique");

    const reviews = existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, "utf8")) : [];
    const reviewed = new Map(reviews.map((row) => [row.id, row]));

    assert.equal(reviewed.size, reviews.length, "review IDs must be unique");
    assert(
        reviews.every((entry) => rows.some((row) => id(row) === entry.id)),
        "review references a missing report row",
    );
    const cache = new Map();
    const duplicates = [];

    for (const file of files) {
        const old = execFileSync("git", ["-C", root.pathname, "show", `${baseline}:${file}`], {
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
        });
        const current = source(file);
        const before = parse(file, old);
        const now = parse(file, current);
        const functions = functionsOf(now);

        for (const call of tCalls(now)) {
            // Values may be translated fragments; only a translated key or fallback is a duplicate wrapper.
            if (call.arguments.slice(0, 2).some((argument) => tCalls(argument).length > 0)) {
                duplicates.push(`${file}:${lineOf(now, call.getStart(now))}`);
            }
        }

        cache.set(file, { old, current, before, now, functions });
    }

    const results = rows.map((row) => {
        const { old, current, before, now, functions } = cache.get(row.file);
        const position = before.getPositionOfLineAndCharacter(row.line - 1, row.column - 1);
        const node = smallest(before, position);
        const identity = functionIdentity(node);
        const targets = functions.get(identity) ?? [];
        const anchor = targets.length === 1 ? targets[0] : undefined;
        const oldLine = old.split("\n")[row.line - 1];
        const needle = firstExpression(node, before);
        const anchorText = anchor?.getText(now) ?? "";
        const compact = normalize(anchorText);
        const text = normalize(row.raw);
        const direct = text.length >= 4 && compact.includes(text);
        const expression = needle.length >= 4 && compact.includes(needle);
        const sameLine = oldLine.trim().length >= 5 && compact.includes(normalize(oldLine));
        const reason =
            anchor === undefined
                ? "当前源未唯一定位同名函数，必须人工核对"
                : direct
                  ? "候选原文在同函数中；仍须核对是否应翻译"
                  : expression
                    ? "原表达式在同函数中；仍须核对周围文案与排除依据"
                    : sameLine
                      ? "基线原行在同函数中；仍须核对周围文案与排除依据"
                      : "原候选已改变或格式重排，必须人工核对";
        const calls = anchor ? tCalls(anchor) : [];
        const adjacent = calls.slice(0, 6).map((call) => {
            const key = call.arguments[0];

            return `${lineOf(now, call.getStart(now))}:${key && ts.isStringLiteral(key) ? key.text : "<动态键>"}`;
        });
        const review = reviewed.get(id(row));
        let disposition = "未决";
        let reviewReason = reason;

        if (review && ["新增接入", "既有接入", "上游接入", "排除"].includes(review.status)) {
            const referenceValid = review.rawHash === sha(row.raw);
            const reasonValid = typeof review.reason === "string" && review.reason.length > 4;
            const anchors = Array.isArray(review.anchors) ? review.anchors : [];
            const anchorsValid =
                anchors.length > 0 &&
                anchors.every((item) => {
                    const content = source(item.file);

                    return (
                        typeof item.text === "string" &&
                        item.text.length >= 2 &&
                        content.includes(item.text)
                    );
                });
            const keyValid =
                review.status !== "新增接入" ||
                (Array.isArray(review.keys) &&
                    review.keys.length > 0 &&
                    review.keys.every((key) => anchors.some((item) => item.text.includes(key))));

            if (referenceValid && reasonValid && anchorsValid && keyValid) {
                disposition = review.status;
                reviewReason = review.reason;
            } else {
                reviewReason = `审查证据不匹配：原文=${referenceValid}、理由=${reasonValid}、锚点=${anchorsValid}、键=${keyValid}`;
            }
        } else if (review) {
            reviewReason = review.reason ?? reason;
        }

        return {
            ...row,
            baselineLineHash: sha(oldLine),
            identity: identity ?? "无",
            currentStart: anchor ? lineOf(now, anchor.getStart(now)) : null,
            currentEnd: anchor ? lineOf(now, anchor.end) : null,
            currentFunctionHash: anchor ? sha(anchorText) : null,
            currentFileHash: sha(current),
            currentMatch: direct ? "原文" : expression ? "原表达式" : sameLine ? "原行" : "无",
            nearbyCalls: adjacent,
            disposition,
            reason: reviewReason,
            evidence: review?.anchors ?? [],
        };
    });

    return { results, duplicates };
}

const escapeCell = (text) =>
    String(text).replaceAll("|", "&#124;").replaceAll("\n", " ").replaceAll("`", "&#96;");

function ledger({ results, duplicates }) {
    const lines = [
        "# WP3 独立逐项审计（未决项不得计作通过）",
        "",
        `报告基线 ${baseline}；报告 SHA256 ${reportHash}。`,
        "每条按报告段落、文件、行、列计数；报告位置是基线 AST 中的坐标，并非当前行。",
        "当前定位为所属真实函数的范围及源字节哈希；函数级 t 键只是定位辅助，不证明候选已迁移。",
        "候选可能包含多个模板片段或与其他候选重叠；必须逐项人工核对，不能用 t 调用总数替代。",
        `检测到重复 t 包装（键或英文回退是 t 调用）：${duplicates.length ? duplicates.join("、") : "无"}；命名值内独立翻译的片段不算重复。`,
        "",
        "| 段落 | 报告位置 | 原文摘要 | 基线行 SHA256 | 当前函数与行 | 当前函数 SHA256 | 当前文件 SHA256 | 原文关联 | 函数内部分 t 键 | 状态 | 原因 | 源码证据 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ];

    for (const row of results) {
        const where =
            row.currentStart === null
                ? "未定位"
                : `${row.identity}:${row.currentStart}-${row.currentEnd}`;

        const evidence = row.evidence.map((anchor) => `${anchor.file}: ${anchor.text}`).join("；");

        lines.push(
            `| ${escapeCell(row.section)} | ${escapeCell(`${row.file}:${row.line}:${row.column}`)} | ${escapeCell(normalize(row.raw).slice(0, 120))} | ${row.baselineLineHash} | ${escapeCell(where)} | ${row.currentFunctionHash ?? "—"} | ${row.currentFileHash} | ${row.currentMatch} | ${escapeCell(row.nearbyCalls.join(", "))} | ${row.disposition} | ${escapeCell(row.reason)} | ${escapeCell(evidence)} |`,
        );
    }

    return `${lines.join("\n")}\n`;
}

const result = audit();

if (process.argv.includes("--ledger")) {
    writeFileSync("/tmp/wp3-test-ledger.md", ledger(result));
}

for (const section of ["需人工", "无法映射键"]) {
    const group = result.results.filter((row) => row.section === section);
    const located = group.filter((row) => row.currentStart !== null).length;
    const match = group.filter((row) => row.currentMatch !== "无").length;

    const counts = Object.fromEntries(
        ["新增接入", "既有接入", "上游接入", "排除", "未决"].map((status) => [
            status,
            group.filter((row) => row.disposition === status).length,
        ]),
    );

    console.log(
        `${section} ${group.length}；定位同名函数 ${located}；原文/表达式/原行关联 ${match}；${Object.entries(
            counts,
        )
            .map(([key, count]) => `${key} ${count}`)
            .join("；")}`,
    );
}

console.log(
    `重复 t 包装：${result.duplicates.length}${result.duplicates.length ? `；${result.duplicates.join("、")}` : ""}`,
);
console.log(`报告 SHA256 ${reportHash}；统计直接来自冻结报告；当前文件 SHA256 已逐项记录。`);

if (process.argv.includes("--ledger")) {
    console.log("审计表：/tmp/wp3-test-ledger.md");
}

if (process.argv.includes("--require-complete")) {
    assert.equal(
        result.results.filter((row) => row.disposition === "未决").length,
        0,
        "存在尚未审定的候选",
    );
    assert.equal(result.duplicates.length, 0, "存在重复 t 包装");
}
