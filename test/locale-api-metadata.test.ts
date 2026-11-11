// This PR's locale API is unreleased; already shipped 0.28 presentation/session APIs keep their original versions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const source = ts.createSourceFile(
    "pocket.d.ts",
    readFileSync(new URL("types/pocket.d.ts", root), "utf8"),
    ts.ScriptTarget.Latest,
    true,
);

function declaration(name: string): ts.InterfaceDeclaration {
    const node = source.statements.find(
        (statement): statement is ts.InterfaceDeclaration =>
            ts.isInterfaceDeclaration(statement) && statement.name.text === name,
    );

    assert.ok(node, name);

    return node;
}

function member(owner: string, name: string): ts.TypeElement {
    const node = declaration(owner).members.find((node) => node.name?.getText(source) === name);

    assert.ok(node, `${owner}.${name}`);

    return node;
}

function metadata(node: ts.Node, since: string) {
    const tags = ts.getJSDocTags(node);
    const version = tags.find((tag) => tag.tagName.text === "since");

    assert.equal(version?.comment, since, node.getText(source).slice(0, 100));
    assert.ok(
        tags.some((tag) => tag.tagName.text === "experimental"),
        "the API stays experimental",
    );
}

function section(text: string, title: string) {
    const marker = "### `" + title + "`";
    const start = text.indexOf(marker);

    assert.ok(start >= 0, title);
    const end = text.indexOf("\n### ", start + marker.length);

    return text.slice(start, end < 0 ? undefined : end);
}

test("only this PR's locale declarations are Unreleased Experimental in types and reference", () => {
    metadata(declaration("UiLocalePack"), "Unreleased");
    metadata(declaration("PresentEntry"), "0.28.0");

    for (const name of ["id", "label", "messages"]) {
        metadata(member("UiLocalePack", name), "Unreleased");
    }

    for (const [owner, name] of [
        ["Web", "uiLocales"],
        ["WebRequest", "locale"],
        ["PublicPageRequest", "locale"],
        ["Pocket", "t"],
        ["Pocket", "onLocaleChange"],
    ]) {
        metadata(member(owner!, name!), "Unreleased");
    }

    for (const [owner, name] of [
        ["Web", "presentEntry"],
        ["WebRequest", "createSession"],
        ["Pocket", "entryPresentation"],
    ]) {
        metadata(member(owner!, name!), "0.28.0");
    }

    const web = readFileSync(new URL("docs/extensions/reference/web.md", root), "utf8");
    const pocket = readFileSync(new URL("docs/extensions/reference/pocket.md", root), "utf8");

    for (const reference of [web, pocket]) {
        assert.match(reference, /not in the official 0\.28\.0 or 0\.28\.1 releases/);
        assert.match(
            reference,
            /first release is (?:not assigned|unassigned); the maintainers decide it/,
        );
    }

    for (const [text, title] of [
        [web, "uiLocales"],
        [web, "UiLocalePack"],
        [pocket, "t"],
        [pocket, "onLocaleChange"],
    ] as const) {
        assert.match(section(text!, title!), /^Since Unreleased · Experimental$/m, title);
    }

    for (const owner of ["WebRequest", "PublicPageRequest"]) {
        const locale = section(web, owner)
            .split("\n")
            .find((line) => line.includes("`locale`") && line.includes("immutable"));

        assert.ok(locale, owner);
        assert.match(locale, /Unreleased.*[Ee]xperimental/);
        assert.doesNotMatch(locale, /Since 0\.28\.[01]/);
    }

    assert.match(section(web, "presentEntry"), /^Since 0\.28\.0 · Experimental$/m);
    assert.match(section(pocket, "entryPresentation"), /^Since 0\.28\.0 · Experimental$/m);
    assert.match(section(web, "WebRequest"), /Since 0\.28\.0.*`createSession`/);
});
