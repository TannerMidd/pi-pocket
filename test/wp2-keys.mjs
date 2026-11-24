// Extract WP2's static t calls and countedText tuple arguments with the TypeScript parser.
import assert from "node:assert/strict";
import ts from "typescript";

export const DYNAMIC_COUNT_ARGS = Symbol("countedText");

export function calls(file, source) {
    const parsed = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    const result = [];
    const unresolved = [];

    assert.equal(parsed.parseDiagnostics.length, 0, `${file}: source syntax`);

    function visit(node) {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "t"
        ) {
            const [key, english] = node.arguments;
            const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;

            if (key && english && ts.isStringLiteralLike(key) && ts.isStringLiteralLike(english)) {
                const values = node.arguments[2];
                const names =
                    values && ts.isObjectLiteralExpression(values)
                        ? values.properties.map((property) =>
                              property.name &&
                              (ts.isIdentifier(property.name) ||
                                  ts.isStringLiteralLike(property.name))
                                  ? property.name.text
                                  : null,
                          )
                        : values
                          ? DYNAMIC_COUNT_ARGS
                          : [];

                result.push({ file, line, key: key.text, english: english.text, names });
            } else if (
                !(file === "web/transcript.js" && key?.getText(parsed) === "oneKey") &&
                !(file === "web/transcript.js" && key?.getText(parsed) === "manyKey")
            ) {
                unresolved.push({ file, line, code: node.getText(parsed).slice(0, 200) });
            }
        }

        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "countedText"
        ) {
            for (const tuple of node.arguments.slice(1)) {
                if (
                    !ts.isArrayLiteralExpression(tuple) ||
                    tuple.elements.length !== 2 ||
                    !tuple.elements.every(ts.isStringLiteralLike)
                ) {
                    unresolved.push({
                        file,
                        line: parsed.getLineAndCharacterOfPosition(tuple.getStart(parsed)).line + 1,
                        code: tuple.getText(parsed).slice(0, 200),
                    });
                    continue;
                }

                result.push({
                    file,
                    line: parsed.getLineAndCharacterOfPosition(tuple.getStart(parsed)).line + 1,
                    key: tuple.elements[0].text,
                    english: tuple.elements[1].text,
                    helper: "countedText",
                    names: ["count"],
                });
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(parsed);

    return { result, unresolved };
}
