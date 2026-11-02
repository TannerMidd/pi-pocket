import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error The browser module is plain JavaScript, like Pocket itself.
import setup, { configuration, validateSource } from "../mermaid/index.js";
import createMermaid from "../mermaid.ts";
import type { Host, Web } from "../_pocket.d.ts";

test("the module only registers a view-access browser folder", () => {
    const calls: unknown[] = [];

    createMermaid(
        {} as Host,
        { client: (...args: unknown[]) => calls.push(args) } as unknown as Web,
    );
    assert.deepEqual(calls, [["mermaid", { access: "view" }]]);
});

test("an older API fails clearly without touching the page", () => {
    assert.throws(() => setup({}), /0.27.0 has no such API/);
});

test("Mermaid settings are strict and bounded", () => {
    assert.equal(configuration.securityLevel, "strict");
    assert.equal(configuration.startOnLoad, false);
    assert.equal(configuration.htmlLabels, false);
    assert.equal(configuration.suppressErrorRendering, true);
    assert.equal(configuration.flowchart.htmlLabels, false);
    assert.equal(configuration.maxEdges, 200);
    assert.equal(configuration.maxTextSize, 20_000);
    assert.ok(configuration.secure.includes("securityLevel"));
});

test("resource functions cannot reach Mermaid through CSS escapes or comments", () => {
    for (const css of [
        "url(/probe)",
        "URL (/probe)",
        String.raw`u\72l(/probe)`,
        String.raw`\000075 rl(/probe)`,
        "u/*comment*/rl(/probe)",
        String.raw`\75\72\6c(/probe)`,
        'image-set("/probe" 1x)',
        '@import "/probe"',
        'src("/probe")',
    ]) {
        assert.throws(
            () => validateSource(`classDiagram\n class A\n style A fill:${css}`),
            /resource functions/,
            css,
        );
    }
});

test("a quoted comment opener cannot hide resource loads from validation", () => {
    for (const source of [
        'classDiagram\n class A["/*"]\n style A fill:url(/probe)',
        'C4Context\n Person(a, "/*")\n UpdateElementStyle(a, $bgColor="url(/probe)")',
        String.raw`classDiagram
 class A["\2f*"]
 style A fill:u\72l(/probe)`,
    ]) {
        assert.throws(() => validateSource(source), /comment openers/);
    }
});

test("source limits cannot be changed by message configuration", () => {
    assert.doesNotThrow(() => validateSource("flowchart LR\n A --> B"));
    assert.doesNotThrow(() => validateSource("a".repeat(20_000)));
    assert.throws(() => validateSource("a".repeat(20_001)), /20,000-character/);
    assert.throws(
        () => validateSource('flowchart LR\n A@{img: "/probe", h: 20}'),
        /Extended node definitions/,
    );

    for (const source of [
        '%%{init: {"securityLevel": "loose"}}%%\ngraph TD; A-->B',
        '%% {init: {"htmlLabels": true}}%%\ngraph TD; A-->B',
        "---\nconfig:\n  securityLevel: loose\n---\ngraph TD; A-->B",
        " \r\n---\r\nconfig: {}\r\n---",
        "---\rconfig: {}\r---\rgraph TD; A-->B",
    ]) {
        assert.throws(() => validateSource(source), /directives and front matter/);
    }
});
