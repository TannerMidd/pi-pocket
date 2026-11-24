// WP4 translations are checked at their real call sites and through the production lookup.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import type { SourceFileWithParseDiagnostics } from "./wp4-audit.ts";
import { placeholders, translate } from "../web/locale.js";
import { EN } from "../web/locales/en.js";

const files = ["extensions", "gallery", "memory", "menu"].map(
    (name) => new URL(`../web/sheets/${name}.js`, import.meta.url),
);

function source(file: URL) {
    const text = readFileSync(file, "utf8");
    const tree = ts.createSourceFile(
        file.pathname,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    ) as SourceFileWithParseDiagnostics;

    assert.equal(tree.parseDiagnostics.length, 0, file.pathname);

    return tree;
}

function isTranslation(node: ts.Node): node is ts.CallExpression {
    return (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "t"
    );
}

function position(tree: ts.SourceFile, node: ts.Node) {
    const at = tree.getLineAndCharacterOfPosition(node.getStart(tree));

    return `${tree.fileName}:${at.line + 1}:${at.character + 1}`;
}

function allCalls(tree: ts.SourceFile) {
    const calls: ts.CallExpression[] = [];

    function visit(node: ts.Node) {
        if (isTranslation(node)) {
            calls.push(node);
        }

        ts.forEachChild(node, visit);
    }

    visit(tree);

    return calls;
}

function localFunctions(tree: ts.SourceFile) {
    const functions = new Map<string, ts.FunctionLikeDeclaration>();

    for (const statement of tree.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) {
            functions.set(statement.name.text, statement);
        } else if (ts.isVariableStatement(statement)) {
            for (const item of statement.declarationList.declarations) {
                if (
                    ts.isIdentifier(item.name) &&
                    item.initializer &&
                    (ts.isArrowFunction(item.initializer) ||
                        ts.isFunctionExpression(item.initializer))
                ) {
                    functions.set(item.name.text, item.initializer);
                }
            }
        }
    }

    return functions;
}

// Follow local functions called from initializers and callbacks run by common eager array methods.
function loadTimeTranslations(tree: ts.SourceFile) {
    const found: string[] = [];
    const functions = localFunctions(tree);
    const visiting = new Set<ts.FunctionLikeDeclaration>();
    const eager = new Set([
        "map",
        "flatMap",
        "filter",
        "forEach",
        "reduce",
        "reduceRight",
        "some",
        "every",
        "find",
        "findIndex",
        "sort",
    ]);

    const run = (fn: ts.FunctionLikeDeclaration) => {
        if (visiting.has(fn)) {
            return;
        }

        visiting.add(fn);

        if (fn.body) {
            visit(fn.body);
        }

        visiting.delete(fn);
    };

    function visit(node: ts.Node) {
        if (ts.isFunctionLike(node)) {
            return;
        }

        if (isTranslation(node)) {
            found.push(position(tree, node));
        }

        if (ts.isCallExpression(node)) {
            const target = node.expression;

            if (ts.isIdentifier(target)) {
                const fn = functions.get(target.text);

                if (fn) {
                    run(fn);
                }
            } else if (
                ts.isParenthesizedExpression(target) &&
                (ts.isArrowFunction(target.expression) ||
                    ts.isFunctionExpression(target.expression))
            ) {
                run(target.expression);
            }

            if (ts.isPropertyAccessExpression(target) && eager.has(target.name.text)) {
                for (const arg of node.arguments) {
                    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
                        run(arg);
                    } else if (ts.isIdentifier(arg) && functions.has(arg.text)) {
                        run(functions.get(arg.text)!);
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    for (const statement of tree.statements) {
        visit(statement);
    }

    return found;
}

function reviewPromptTranslations(tree: ts.SourceFile) {
    const found: string[] = [];

    function visit(node: ts.Node) {
        if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            ts.isObjectBindingPattern(node.name) &&
            node.name.elements.some(
                (element) => ts.isIdentifier(element.name) && element.name.text === "prompt",
            ) &&
            ts.isAwaitExpression(node.initializer) &&
            ts.isCallExpression(node.initializer.expression) &&
            ts.isIdentifier(node.initializer.expression.expression) &&
            node.initializer.expression.expression.text === "galleryApi"
        ) {
            let fn: ts.Node = node;

            while (fn.parent && !ts.isFunctionLike(fn)) {
                fn = fn.parent;
            }

            function scan(candidate: ts.Node) {
                if (
                    isTranslation(candidate) &&
                    candidate.arguments.some((arg) => /\bprompt\b/.test(arg.getText(tree)))
                ) {
                    found.push(position(tree, candidate));
                }

                ts.forEachChild(candidate, scan);
            }

            scan(fn);
        }

        ts.forEachChild(node, visit);
    }

    visit(tree);

    return found;
}

test("WP4 never translates at module load or translates a translated key or fallback", () => {
    for (const file of files) {
        const tree = source(file);

        assert.deepEqual(loadTimeTranslations(tree), [], `module-load t: ${tree.fileName}`);
        assert.deepEqual(
            reviewPromptTranslations(tree),
            [],
            `gallery review prompt must stay unchanged: ${tree.fileName}`,
        );

        for (const call of allCalls(tree)) {
            const nested: string[] = [];

            for (const arg of call.arguments.slice(0, 2)) {
                const visit = (node: ts.Node) => {
                    if (isTranslation(node)) {
                        nested.push(position(tree, node));
                    }

                    ts.forEachChild(node, visit);
                };

                visit(arg);
            }

            assert.deepEqual(nested, [], `translated key or fallback at ${position(tree, call)}`);
        }
    }
});

test("WP4 gallery translates fixed visible labels and requirement prose", () => {
    const tree = source(files[1]!);
    const text = tree.text;
    const defects = [
        ...(text.includes("${file.change}</span>") ? ["server change enum is shown verbatim"] : []),
        ...(text.includes("${key} ${colors[key]}")
            ? ["palette tooltip contains untranslated role names"]
            : []),
        ...(text.includes('["background", "background"]')
            ? ["palette background label is untranslated"]
            : []),
        ...(text.includes('["foreground", "text"]') ? ["palette text label is untranslated"] : []),
        ...(text.includes('["accent", "accent"]') ? ["palette accent label is untranslated"] : []),
    ];
    const calls = allCalls(tree);
    const get = (key: string) =>
        calls.filter(
            (call) =>
                ts.isStringLiteral(call.arguments[0]!) &&
                (call.arguments[0] as ts.StringLiteral).text === key,
        );

    for (const [kind, api] of [
        ["extension", "pocketApi"],
        ["theme", "themeApi"],
    ]) {
        const key = `web.sheets.gallery.entry-facts.text.needs-${kind}-api`;
        const found = get(key);

        assert.equal(found.length, 1, key);
        const call = found[0]!;

        assert.ok(ts.isStringLiteral(call.arguments[1]!), key);
        assert.equal(
            (call.arguments[1] as ts.StringLiteral).text,
            `Pi Pocket {pocket} or newer · ${kind} API {api}`,
            key,
        );
        const values = call.arguments[2];

        assert.ok(values && ts.isObjectLiteralExpression(values), key);
        const pairs = new Map(
            values.properties
                .filter(ts.isPropertyAssignment)
                .map((item) => [item.name.getText(tree), item.initializer.getText(tree)]),
        );

        assert.equal(pairs.get("pocket"), "entry.minPocket", key);
        assert.equal(pairs.get("api"), `entry.${api}`, key);
        let node: ts.Node | undefined = call;

        while (node && !ts.isTaggedTemplateExpression(node)) {
            node = node.parent;
        }

        assert.ok(
            node && node.getText(tree).includes("<${EntryFacts}"),
            `${key} reaches EntryFacts`,
        );
    }

    const helpers = localFunctions(tree);
    const rolePrefix = "web.sheets.gallery.swatches.text.";

    for (const role of [
        "background",
        "foreground",
        "text",
        "accent",
        "red",
        "yellow",
        "green",
        "cyan",
        "blue",
        "magenta",
    ]) {
        const matching = get(rolePrefix + role);

        assert.equal(matching.length, 1, `palette role ${role}`);
        assert.equal((matching[0]!.arguments[1] as ts.StringLiteral).text, role);
        const parent = helpers.get(role === "text" ? "textLabel" : "roleLabel");

        assert.ok(
            parent &&
                matching[0]!.getStart(tree) >= parent.getStart(tree) &&
                matching[0]!.end <= parent.end,
            `palette role ${role} reaches helper`,
        );
    }

    const changePrefix = "web.sheets.gallery.gallery-update-sheet.span.change-";

    for (const status of ["added", "removed", "changed", "same"]) {
        const matching = get(changePrefix + status);

        assert.equal(matching.length, 1, `update status ${status}`);
        assert.equal((matching[0]!.arguments[1] as ts.StringLiteral).text, status);
        const helper = helpers.get("changeLabel");

        assert.ok(
            helper &&
                matching[0]!.getStart(tree) >= helper.getStart(tree) &&
                matching[0]!.end <= helper.end,
            `update ${status} reaches helper`,
        );
    }

    assert.match(
        helpers.get("textLabel")!.getText(tree),
        /roleLabel\(key\)/,
        "textLabel delegates other roles",
    );
    const swatches = helpers.get("Swatches")!.getText(tree);

    assert.match(swatches, /title=\$\{`\$\{roleLabel\(key\)\}/, "palette tooltips call roleLabel");
    assert.match(
        swatches,
        /\$\{textLabel\(key\)\} \$\{colors\[key\]\}/,
        "palette text calls textLabel",
    );
    assert.match(
        text,
        /gallery-change \$\{file\.change\}`\}>\$\{changeLabel\(file\.change\)\}/,
        "update CSS keeps enum but display uses changeLabel",
    );
    assert.deepEqual(
        defects,
        [],
        "gallery visible roles, version requirements and change statuses",
    );
});

test("WP4 calls preserve exact fallback and placeholder names through the real lookup", () => {
    let checked = 0;

    for (const file of files) {
        const tree = source(file);

        for (const call of allCalls(tree)) {
            const where = position(tree, call);
            const [key, english, values] = call.arguments;

            assert.ok(key && ts.isStringLiteral(key), `literal key at ${where}`);
            assert.ok(
                english && ts.isStringLiteral(english),
                `literal English, not author text, at ${where}`,
            );
            const names = [...new Set(placeholders(english.text))].sort();

            if (names.length > 0) {
                assert.ok(
                    values && ts.isObjectLiteralExpression(values),
                    `placeholder values at ${where}`,
                );
                const keys = values.properties
                    .map((item) => {
                        assert.ok(
                            ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item),
                            where,
                        );
                        const name = item.name;

                        assert.ok(ts.isIdentifier(name) || ts.isStringLiteral(name), where);

                        return name.text;
                    })
                    .sort();

                assert.deepEqual(
                    names.filter((name) => !keys.includes(name)),
                    [],
                    `missing placeholder values at ${where}`,
                );
            }

            if (Object.hasOwn(EN, key.text)) {
                assert.equal(EN[key.text], english.text, `catalog fallback at ${where}`);
            }

            const sentinels = Object.fromEntries(
                names.map((name) => [name, `<${name}-$&-{other}>`]),
            );
            const expected = english.text.replace(
                /\{([A-Za-z][A-Za-z0-9_]*)\}/g,
                (whole, name) => sentinels[name] ?? whole,
            );

            assert.equal(
                translate({}, key.text, english.text, sentinels),
                expected,
                `English fallback at ${where}`,
            );
            checked++;
        }
    }

    assert.ok(checked > 0, "WP4 contains translation call sites");
});
