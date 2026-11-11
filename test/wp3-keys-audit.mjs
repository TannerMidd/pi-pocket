// Check all newly declared WP3 keys against the source, including dynamic lookup tables.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const files =
    "browser-panel diff files-panel linked-sessions peeks pip rich run-frame subagents-board subagents"
        .split(" ")
        .map((name) => `web/${name}.js`);
const initial = JSON.parse(
    readFileSync(new URL("./wp3-key-baseline.json", import.meta.url), "utf8"),
);
const records = JSON.parse(readFileSync(new URL("./wp3-keys.json", import.meta.url), "utf8"));
const declared = new Map();
const byKey = new Map(records.map((entry) => [entry.key, entry]));
const placeholders = (text) =>
    [
        ...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1])),
    ].sort();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const failures = [];
let valueCalls = 0;
let dynamicCalls = 0;
let priorCalls = 0;

assert.equal(byKey.size, records.length, "keys must be unique");

for (const file of files) {
    const before = new Set(initial[file].webLiterals);
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const currentCalls = new Map();

    assert.equal(tree.parseDiagnostics.length, 0, `${file} does not parse`);

    function current(node) {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "t"
        ) {
            const first = node.arguments[0];
            const row = first && ts.isStringLiteral(first) ? byKey.get(first.text) : undefined;

            if (
                first &&
                ts.isStringLiteral(first) &&
                node.arguments[1] &&
                ts.isStringLiteral(node.arguments[1])
            ) {
                const signature = JSON.stringify([first.text, node.arguments[1].text]);

                currentCalls.set(signature, (currentCalls.get(signature) ?? 0) + 1);
            }

            if (row && row.values.length > 0) {
                valueCalls++;
                const values = node.arguments[2];
                const names =
                    values && ts.isObjectLiteralExpression(values)
                        ? values.properties.flatMap((item) =>
                              item.name ? [item.name.getText(tree)] : [],
                          )
                        : [];
                const missing = row.values.filter((name) => !names.includes(name));

                if (missing.length) {
                    failures.push(`${row.key}: 调用缺 values ${missing.join(", ")}`);
                }
            } else if (first && ts.isSpreadElement(first)) {
                dynamicCalls++;
            }
        }

        if (ts.isStringLiteral(node) && node.text.startsWith("web.") && !before.has(node.text)) {
            const parent = node.parent;
            let english;

            if (ts.isArrayLiteralExpression(parent)) {
                const at = parent.elements.indexOf(node);

                if (parent.elements[at + 1] && ts.isStringLiteral(parent.elements[at + 1])) {
                    english = parent.elements[at + 1].text;
                }
            }

            if (
                ts.isCallExpression(parent) &&
                parent.arguments[0] === node &&
                ts.isStringLiteral(parent.arguments[1])
            ) {
                english = parent.arguments[1].text;
            }

            const entries = declared.get(node.text) ?? [];

            entries.push({
                file,
                line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
                english,
            });
            declared.set(node.text, entries);
        }

        ts.forEachChild(node, current);
    }

    current(tree);

    for (const call of initial[file].calls) {
        priorCalls += call.count;
        const count = currentCalls.get(JSON.stringify([call.key, call.english])) ?? 0;

        if (count < call.count) {
            failures.push(`${file}: 既有调用 ${call.key} 从 ${call.count} 处减少到 ${count} 处`);
        }
    }
}

for (const [key, places] of declared) {
    const row = byKey.get(key);
    const words = [...new Set(places.map((place) => place.english).filter(Boolean))];

    if (!row) {
        failures.push(`${key}: 源码新增键未列入附件`);
    } else if (words.length !== 1 || words[0] !== row.english) {
        failures.push(`${key}: 英文回退不一致或动态声明不可解析`);
    }
}

for (const row of records) {
    if (!declared.has(row.key)) {
        failures.push(`${row.key}: 附件的键不在源码新增声明中`);
    }

    if (typeof row.english !== "string" || !row.english.trim()) {
        failures.push(`${row.key}: 缺英文`);
    }

    if (typeof row.chinese !== "string" || !row.chinese.trim()) {
        failures.push(`${row.key}: 缺中文`);
    }

    if (
        typeof row.english === "string" &&
        typeof row.chinese === "string" &&
        !equal(placeholders(row.english), placeholders(row.chinese))
    ) {
        failures.push(`${row.key}: 英中占位符不一致`);
    }

    if (
        typeof row.english === "string" &&
        (!Array.isArray(row.values) ||
            !equal(placeholders(row.english), [...new Set(row.values)].sort()))
    ) {
        failures.push(`${row.key}: values 占位符不一致`);
    }
}

console.log(
    `源码新增键 ${declared.size}；附件 ${records.length}；既有静态调用 ${priorCalls}；具名参数调用 ${valueCalls}；动态展开调用 ${dynamicCalls}（声明核验，不证明运行分支）；${failures.length} 项缺陷`,
);

for (const failure of failures) {
    console.log(`FAIL ${failure}`);
}

if (failures.length) {
    process.exitCode = 1;
}
