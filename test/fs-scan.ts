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
