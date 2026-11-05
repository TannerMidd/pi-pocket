// One-time initial draft generator. It overwrites reviewed data; never use it for routine acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { analyzeSource } from "../../pi-pocket-pr-notes/dictionary/tools/codemod.mjs";

if (!process.argv.includes("--replace-reviewed-data")) {
    throw new Error(
        "初稿生成器会覆盖逐项审阅与键附件；仅手动指定 --replace-reviewed-data 才可执行",
    );
}

const root = new URL("../", import.meta.url);
const files =
    "browser-panel diff files-panel linked-sessions peeks pip rich run-frame subagents-board subagents"
        .split(" ")
        .map((name) => `web/${name}.js`);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const read = (path) => readFileSync(path, "utf8");
const parse = (file, text) =>
    ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const normalize = (text) => text.replace(/\s+/g, " ").trim();
const keyOf = (row) => `${row.section}:${row.file}:${row.line}:${row.column}`;
const report = read("/home/xianbei233/Work/pi-pocket-pr-notes/dictionary/CODEMOD-WEB.md");

assert.equal(sha(report), "503090b2102ef9161fd5a8769568fcc777f2b8ac78624396a2fb759fa0be88a0");
const rows = [];
let section;

for (const line of report.split("\n")) {
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

    rows.push({
        file,
        line: +lineNumber,
        column: +column,
        section,
        reason: reason ?? null,
        raw: JSON.parse(quoted),
        key: automatic ?? tail.match(/^（key=([^）]+)）/)?.[1] ?? null,
    });
}

const dev = [];

for (const line of read("/tmp/wp3-dev-ledger.md").split("\n")) {
    const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());

    if (
        cells.length !== 5 ||
        !cells[0].startsWith("`web/") ||
        !["人工", "无键"].includes(cells[2])
    ) {
        continue;
    }

    const [lineNumber, column] = cells[1].split(":").map(Number);

    dev.push({
        file: cells[0].slice(1, -1),
        line: lineNumber,
        column,
        section: cells[2] === "人工" ? "需人工" : "无法映射键",
        status: cells[3],
        reason: cells[4],
    });
}

const snapshot = JSON.parse(read("/tmp/wp3-initial-source-snapshot.json"));
const prepared = JSON.parse(read("/tmp/wp3-items.json"));
const records = JSON.parse(
    read("/home/xianbei233/Work/pi-pocket-pr-notes/dictionary/SOURCE-MAP.json"),
);
const english = JSON.parse(
    read("/home/xianbei233/Work/pi-pocket-pr-notes/dictionary/en-REFERENCE.json"),
).messages;
const chinese = JSON.parse(
    read("/home/xianbei233/Work/pi-pocket-pr-notes/dictionary/zh-CN-DRAFT.json"),
).messages;
const flatRecords = Array.isArray(records) ? records : records.records;
const references = JSON.parse(read("/tmp/wp3-dictionary-reference.json"));
const newKeys = JSON.parse(read("/tmp/wp3-dev-keys.json"));
const keySet = new Set(newKeys.map((entry) => entry.key));

assert.equal(dev.length, 308);
assert.equal(rows.length, 308);
assert.equal(keySet.size, newKeys.length);

function smallest(tree, position) {
    let result = tree;

    function visit(node) {
        if (node.getStart(tree) <= position && position < node.end) {
            result = node;
            ts.forEachChild(node, visit);
        }
    }

    visit(tree);

    return result;
}

function owner(node) {
    for (let each = node; each; each = each.parent) {
        if (ts.isFunctionDeclaration(each) && each.name) {
            return `function:${each.name.text}`;
        }

        if (ts.isMethodDeclaration(each)) {
            let parent = each.parent;

            while (parent && !ts.isClassDeclaration(parent)) {
                parent = parent.parent;
            }

            return `method:${parent?.name?.text ?? "?"}.${each.name.getText()}`;
        }

        if (
            (ts.isArrowFunction(each) || ts.isFunctionExpression(each)) &&
            ts.isVariableDeclaration(each.parent) &&
            ts.isIdentifier(each.parent.name)
        ) {
            return `variable:${each.parent.name.text}`;
        }
    }
}

function rawIdentity(row, source) {
    const tree = parse(row.file, source);
    const position = tree.getPositionOfLineAndCharacter(row.line - 1, row.column - 1);
    const node = smallest(tree, position);

    return { owner: owner(node), node, tree };
}

const matches = new Map();
const initialCalls = new Map();
const inventory = new Map();
const currentSources = new Map();

for (const file of files) {
    const initial = snapshot[file];
    const baseline = execFileSync(
        "git",
        ["-C", root.pathname, "show", `5e8e2de85bb3e5f04eb56c3ee2360c641a30b979:${file}`],
        { encoding: "utf8" },
    );
    const current = read(new URL(file, root));

    currentSources.set(file, current);
    const beforeTree = parse(file, baseline);
    const initialTree = parse(file, initial);
    const nowTree = parse(file, current);
    const analyzedOld = analyzeSource({
        file,
        source: baseline,
        records: flatRecords,
        english,
        chinese,
    });
    const analyzedInitial = analyzeSource({
        file,
        source: initial,
        records: flatRecords,
        english,
        chinese,
    });

    function calls(tree) {
        const out = [];

        function visit(node) {
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "t"
            ) {
                out.push(node);
            }

            ts.forEachChild(node, visit);
        }

        visit(tree);

        return out;
    }

    initialCalls.set(file, calls(initialTree));
    const initialStrings = new Set();

    function collectInitial(node) {
        if (ts.isStringLiteral(node)) {
            initialStrings.add(node.text);
        }

        ts.forEachChild(node, collectInitial);
    }

    collectInitial(initialTree);

    function collectCurrent(node) {
        if (
            ts.isStringLiteral(node) &&
            node.text.startsWith("web.") &&
            !initialStrings.has(node.text)
        ) {
            const key = node.text;
            const line = nowTree.getLineAndCharacterOfPosition(node.getStart(nowTree)).line + 1;
            const parent = node.parent;
            let english;

            if (ts.isArrayLiteralExpression(parent)) {
                const at = parent.elements.indexOf(node);
                const next = parent.elements[at + 1];

                if (next && ts.isStringLiteral(next)) {
                    english = next.text;
                }
            }

            if (
                ts.isCallExpression(parent) &&
                parent.arguments[0] === node &&
                ts.isStringLiteral(parent.arguments[1])
            ) {
                english = parent.arguments[1].text;
            }

            const list = inventory.get(key) ?? [];

            list.push({ file, line, english });
            inventory.set(key, list);
        }

        ts.forEachChild(node, collectCurrent);
    }

    collectCurrent(nowTree);

    for (const category of ["需人工", "无法映射键"]) {
        const frozen = rows.filter((row) => row.file === file && row.section === category);
        const handed = dev.filter((row) => row.file === file && row.section === category);
        const prior = (prepared[file] ?? []).filter(
            (row) => (row.kind === "manual" ? "需人工" : "无法映射键") === category,
        );
        const candidates = category === "需人工" ? analyzedOld.manual : analyzedOld.unmapped;
        const next = category === "需人工" ? analyzedInitial.manual : analyzedInitial.unmapped;

        assert.equal(frozen.length, handed.length, `${file} ${category} handoff count`);
        assert.equal(frozen.length, prior.length, `${file} ${category} initial count`);

        for (let i = 0; i < frozen.length; i++) {
            const row = frozen[i],
                entry = handed[i],
                item = prior[i];

            assert.equal(entry.line, item.line, `${file} ${category} #${i} initial line`);
            assert.equal(entry.column, item.col, `${file} ${category} #${i} initial column`);
            const rawOld = candidates.find(
                (candidate) =>
                    candidate.line === row.line &&
                    candidate.column === row.column &&
                    candidate.english === row.raw,
            );
            const initialText =
                category === "无法映射键"
                    ? item.text.slice(1, item.text.lastIndexOf('"（'))
                    : item.text;
            const rawInitial = next.find(
                (candidate) =>
                    candidate.line === item.line &&
                    candidate.column === item.col &&
                    candidate.english === initialText,
            );
            const before = rawIdentity(row, baseline);
            const atStart = rawIdentity({ file, line: item.line, column: item.col }, initial);
            const sameOwner = before.owner === atStart.owner && before.owner !== undefined;
            const evidence = rawOld && rawInitial && sameOwner;

            matches.set(keyOf(row), {
                entry,
                item: { ...item, text: initialText },
                evidence: Boolean(evidence),
                sameOwner,
                before,
                atStart,
                initial,
                current,
                nowTree,
            });
        }
    }
}

const placeholders = (text) =>
    [
        ...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1])),
    ].sort();
// Test-side proposals, not translations published by the app or verified by the developer.
const proposed = {
    "web.linked-sessions.linked-sessions.text.started": "源自：{title}",
    "web.linked-sessions.linked-sessions.text.linked-session": "关联会话：{title}",
    "web.peeks.tile-props.label.needs-one": "有 1 个子代理需要你处理",
    "web.peeks.tile-props.label.needs-many": "有 {count} 个子代理需要你处理",
    "web.peeks.tile-props.label.waiting-one": "有 1 个子代理在等待",
    "web.peeks.tile-props.label.waiting-many": "有 {count} 个子代理在等待",
    "web.peeks.tile-props.label.working-one": "有 1 个子代理在工作",
    "web.peeks.tile-props.label.working-many": "有 {count} 个子代理在工作",
    "web.peeks.peek-column.verb.needs-one": "1 个需要你处理",
    "web.peeks.peek-column.verb.need": "{count} 个需要你处理",
    "web.peeks.peek-column.verb.waiting-one": "1 个在等待",
    "web.peeks.peek-column.verb.waiting": "{count} 个在等待",
    "web.rich.rich-block.button.preview": "预览",
    "web.rich.rich-block.button.image": "图像",
    "web.rich.rich-block.button.diff": "差异",
    "web.subagents-board.summary-of.parts.failed": "失败",
    "web.subagents-board.summary-of.parts.working": "工作中",
};
const extras = [];

for (const [key, locations] of inventory) {
    if (keySet.has(key)) {
        continue;
    }

    const choices = [...new Set(locations.map((item) => item.english).filter(Boolean))];
    const fallback = choices.length === 1 ? choices[0] : null;
    const reference = references[key];
    const translation =
        proposed[key] ?? (reference?.english === fallback ? reference.chinese : null);
    const chineseOrigin = proposed[key]
        ? "测试侧建议，待集成审核"
        : translation
          ? "已有参考，待集成审核"
          : "未取得";

    extras.push({
        key,
        english: fallback,
        chinese: translation,
        chineseOrigin,
        values: fallback ? placeholders(fallback) : [],
        scope: "漏报动态键，待核对",
        locations,
    });
}

newKeys.push(...extras);
writeFileSync(new URL("./wp3-keys.json", import.meta.url), `${JSON.stringify(newKeys, null, 2)}\n`);

const review = [];
const sourceLine = (file, text) =>
    text
        .split("\n")
        .find((line) => line.includes(file))
        ?.trim();

for (const row of rows) {
    const m = matches.get(keyOf(row));
    const keys = m.entry.reason.match(/web\.[a-z0-9.-]+/g) ?? [];
    const anchors = [];
    let status = "未决";
    let reason = `${m.entry.reason}；待独立核验`;

    if (!m.evidence) {
        reason = `报告原文与初始源码/候选的逐项映射或所属函数不能一一证实；${m.entry.reason}`;
    } else if (m.entry.status.startsWith("新增")) {
        const anchored = keys.map((key) => {
            for (const file of files) {
                const text = sourceLine(key, currentSources.get(file));

                if (text) {
                    return { file, text: key };
                }
            }

            return null;
        });

        if (keys.length > 0 && anchored.every(Boolean)) {
            // This confirms key declarations, not that they implement the candidate; that review stays open.
            anchors.push(...anchored);
            reason = `开发声明新增 ${keys.join("、")}；键已定位，候选行为与占位符需独立核验`;
        }
    } else if (m.entry.status.includes("自动迁移")) {
        const item = normalize(m.item.text);
        const call = initialCalls
            .get(row.file)
            .find(
                (node) =>
                    item.includes(normalize(node.getText(m.atStart.tree))) &&
                    ts.isStringLiteral(node.arguments[0]),
            );

        if (call) {
            const key = call.arguments[0].text;
            const text = sourceLine(key, m.current);

            if (text) {
                anchors.push({ file: row.file, text: key });
                reason = `初始复合候选内存在原有 t 键 ${key}；尚需逐一核对其余分支，不能仅凭该键计通过`;
            }
        }
    } else if (m.entry.status === "排除") {
        const raw = m.item.text;
        const simple = /^\$\{\s*([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*\}$/.exec(raw);
        const note = m.entry.reason;

        if (row.file === "web/diff.js" && row.line === 687 && row.column === 54) {
            reason =
                "kind 用于可见 title，不能按协议值排除；须翻译显示而保留原始 kind/class/KIND_LETTERS";
        } else if (
            simple &&
            /内容|路径|文件名|人名|标题|错误载荷|载荷|协议值|技术值|技术字母|计数|模型名|命令/.test(
                note,
            )
        ) {
            const variable = simple[1];
            const direct = sourceLine(variable, m.current);

            if (direct) {
                status = "排除";
                reason = `${note}；保留原始动态值 ${variable}，不是界面固定文案`;
                anchors.push({ file: row.file, text: variable });
            }
        }
    }

    review.push({
        id: keyOf(row),
        rawHash: sha(row.raw),
        initialRawHash: sha(m.item.text),
        initialPosition: `${m.entry.line}:${m.entry.column}`,
        mappingVerified: m.evidence,
        status,
        reason,
        keys,
        anchors,
    });
}

writeFileSync(
    new URL("./wp3-review.json", import.meta.url),
    `${JSON.stringify(review, null, 2)}\n`,
);
console.log(
    `报告 ${rows.length}；逐项基线/初始 AST 映射通过 ${[...matches.values()].filter((item) => item.evidence).length}`,
);
console.log(
    `开发新键 ${newKeys.length - extras.length}；静态声明漏报 ${extras.length}；附 ${newKeys.length} 条候选及当前定位`,
);

for (const category of ["需人工", "无法映射键"]) {
    const ids = new Set(rows.filter((row) => row.section === category).map(keyOf));
    const group = review.filter((row) => ids.has(row.id));

    console.log(
        `${category} ${group.length}；${Object.entries(Object.groupBy(group, (row) => row.status))
            .map(([status, values]) => `${status} ${values.length}`)
            .join("；")}`,
    );
}

console.log(
    `新增动态键待中文 ${extras.filter((entry) => !entry.chinese).length}；键列表仅待集成，不代表目录已发布。`,
);
