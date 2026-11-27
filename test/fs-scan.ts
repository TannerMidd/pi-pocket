/** Reading the modules a source file loads, from its syntax tree: the decoded name, whatever way it is written. */
import ts from "typescript";

/**
 * Every module a file loads: `import … from`, `export … from`, `import x = require()`, `import "x"`, `import("x")`,
 * `require("x")`, and `import("x")` in a type. A name is read from the string or the plain template literal that holds
 * it (`.text` is the decoded value), so `"node:\x66s"` and `` `node:fs` `` are `node:fs`.
 */
export function modulesIn(text: string): Set<string> {
    const file = ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest, true);
    const found = new Set<string>();

    const literal = (node: ts.Node | undefined): void => {
        if (
            node !== undefined &&
            (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        ) {
            found.add(node.text);
        }
    };

    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            literal(node.moduleSpecifier);
        } else if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference)
        ) {
            literal(node.moduleReference.expression);
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
            literal(node.argument.literal);
        } else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
            literal(node.arguments[0]);
        }

        ts.forEachChild(node, visit);
    };

    visit(file);

    return found;
}

/** What a file uses, read from its syntax tree: names, member accesses, and calls. Comments and strings are never code. */
export type Facts = {
    /** Every identifier, and every property name. */
    names: Set<string>;
    /** `object.property` and `object["property"]`, for a plain identifier as the object. */
    members: Set<string>;
    /** Each call: the name that is called, the first argument when it is a string, and whether the second is an array. */
    calls: { name: string; first?: string; listed: boolean }[];
};

export function factsIn(text: string): Facts {
    const file = ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest, true);
    const facts: Facts = { names: new Set(), members: new Set(), calls: [] };
    const plain = (node: ts.Node | undefined): string | undefined =>
        node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
            ? node.text
            : undefined;

    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
            facts.names.add(node.text);
        } else if (ts.isPropertyAccessExpression(node)) {
            if (ts.isIdentifier(node.expression)) {
                facts.members.add(`${node.expression.text}.${node.name.text}`);
            }
        } else if (ts.isElementAccessExpression(node)) {
            const key = plain(node.argumentExpression);

            if (key !== undefined) {
                facts.names.add(key);

                if (ts.isIdentifier(node.expression)) {
                    facts.members.add(`${node.expression.text}.${key}`);
                }
            }
        }

        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const name = ts.isIdentifier(callee)
                ? callee.text
                : ts.isPropertyAccessExpression(callee)
                  ? callee.name.text
                  : (plain(
                        ts.isElementAccessExpression(callee)
                            ? callee.argumentExpression
                            : undefined,
                    ) ?? "");
            const first = node.arguments[0];

            facts.calls.push({
                name,
                // The program: a string, or the first string of a list (`["git", …]`).
                first:
                    plain(first) ??
                    (first !== undefined && ts.isArrayLiteralExpression(first)
                        ? plain(first.elements[0])
                        : undefined),
                listed:
                    node.arguments[1] !== undefined &&
                    ts.isArrayLiteralExpression(node.arguments[1]),
            });
        }

        ts.forEachChild(node, visit);
    };

    visit(file);

    return facts;
}
