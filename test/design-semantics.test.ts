import assert from "node:assert/strict";
import { test } from "node:test";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { check, ofRule, onPid, page, testSystem, token } from "./design-lint-fixtures.ts";

const browser = { skip: findBrowser() === undefined, timeout: 120_000 };
const plain = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Plain</title></head><body>
<main data-pid="m"><h1 data-pid="h1">Plain controls</h1><h2 data-pid="h2">A subtitle</h2><p data-pid="p">Words, with a <a href="#" data-pid="a">link</a> and <code data-pid="code">code</code>.</p>
<button data-pid="b">Go</button> <input data-pid="i" aria-label="Name" type="text"> <select data-pid="s" aria-label="Pick"><option>A</option></select> <textarea data-pid="t" aria-label="Notes"></textarea>
<fieldset data-pid="f"><legend>Group</legend>x</fieldset><hr data-pid="hr"><details data-pid="d"><summary data-pid="sum">More</summary>text</details></main></body></html>`;

test(
    "the browser's own defaults are not the page's: plain controls and headings give no finding",
    browser,
    async () => {
        for (const scheme of ["light", "dark"] as const) {
            const report = await check(plain, { viewport: "desktop", colorScheme: scheme });

            assert.deepEqual(
                report.findings.map((item) => `${item.rule}:${item.pid ?? item.selector}`),
                [],
                scheme,
            );
        }

        const none = await check(plain, { viewport: "desktop" }, null);

        assert.deepEqual(none.findings, []);
    },
);

test("what the author sets on those controls is judged", browser, async () => {
    const styled = plain
        .replace("<style>", "<style>")
        .replace(
            "</head>",
            "<style>button{border:1px solid #123456;padding:14px;border-radius:12px}h1{font-size:30px}hr{border-color:#abcdef}</style></head>",
        );
    const report = await check(styled, { viewport: "desktop" });
    const values = (pid: string) =>
        report.findings
            .filter((item) => item.pid === pid)
            .map((item) => `${item.rule}:${item.value}`)
            .sort();

    assert.deepEqual(values("b"), [
        "off-system-color:#123456",
        "off-system-size:12px",
        "off-system-size:14px",
    ]);
    assert.deepEqual(values("h1"), ["off-system-size:30px"]);
    assert.deepEqual(values("hr"), ["off-system-color:#abcdef"]);
    // A text color that the author sets is judged, in a dark page too: the default white of a dark page is not.
    const dark = await check(
        plain.replace("</head>", "<style>html{color-scheme:dark}</style></head>"),
        { viewport: "desktop", colorScheme: "dark" },
    );

    assert.deepEqual(dark.findings, []);
    const authored = await check(
        plain.replace("</head>", "<style>body{color:#7ba3f8}</style></head>"),
        { viewport: "desktop" },
    );

    assert.ok(ofRule(authored, "off-system-color").some((item) => item.value === "#7ba3f8"));
});

test(
    "a suggestion prefers the role's token to a palette step, and says when it changes the value",
    browser,
    async () => {
        const system = testSystem();

        // A palette step that is nearer to the color than the border token is (but within 12 of it).
        system.tokens.push(token("color.gray.400", "color", "#8f95ab", "#8f95ab", "primitive"));
        const body =
            `<div data-pid="edge" style="border:1px solid #9399b0;padding:var(--space-4);background:var(--color-bg-surface)">x</div>` +
            `<p data-pid="words" style="margin:0;padding:var(--space-2);color:#6b7180;background:var(--color-bg-surface)">Words</p>` +
            `<p data-pid="size" style="margin:0;padding:15px;background:var(--color-bg-surface)">x</p>`;
        const report = await check(page("", body), { viewport: "desktop" }, system);
        const edge = onPid(report, "off-system-color", "edge")!;
        const words = onPid(report, "off-system-color", "words")!;

        assert.equal(
            edge.suggestion,
            "var(--color-border-default)",
            "a border color gets the border token, not gray.400",
        );
        assert.match(edge.message, /Set `border-color: var\(--color-border-default\)`/);
        assert.match(words.message, /The closest token is #5a5f73, which is darker\./);
        assert.match(edge.message, /The closest token is #8a90a6, which is slightly darker\./);
        const size = report.findings.find(
            (item) => item.rule === "off-system-size" && item.value === "15px",
        )!;

        assert.match(size.message, /The closest step is 1px (smaller|larger)\./);
    },
);

test("page semantics: language, labels, names, and a main landmark", browser, async () => {
    const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    const body =
        `<input data-pid="n1" type="email">` +
        `<input data-pid="n2" type="text" placeholder="Name">` +
        `<label>Wrapped <input data-pid="n3"></label><label for="x">Linked</label><input id="x" data-pid="n4">` +
        `<input data-pid="n5" aria-label="Q"><select data-pid="n6"><option>a</option></select><textarea data-pid="n7" title="Notes"></textarea>` +
        `<input type="checkbox" data-pid="n8"><input type="hidden" name="h"><input type="submit" data-pid="n9"><input type="range" data-pid="n10">` +
        `<button data-pid="b1"><svg width="16" height="16" aria-hidden="true"><path d="M0 0h16v16z"/></svg></button>` +
        `<button data-pid="b2" aria-label="Close"><svg width="16" height="16"></svg></button><button data-pid="b3">Text</button>` +
        `<a href="#" data-pid="a1"><img src="${gif}" alt="" width="10" height="10"></a><a href="#" data-pid="a2"><img src="${gif}" alt="Home" width="10" height="10"></a>` +
        `<a href="#" data-pid="a3"><svg width="10" height="10"><title>Home</title></svg></a><a data-pid="a4">no href</a>` +
        `<button data-pid="b4" aria-labelledby="lbl"></button><span id="lbl">Named by id</span>` +
        `<label>Switch <button role="switch" aria-checked="false" data-pid="b5"></button></label>` +
        `<label for="b6">Pointed at</label><button id="b6" data-pid="b6"></button>` +
        `<div role="switch" aria-checked="false" data-pid="b7" style="width:20px;height:10px"></div>` +
        `<div role="textbox" data-pid="w1" style="width:80px;height:20px">typed text is the value</div><div role="textbox" data-pid="w1b" aria-label="Search" style="width:80px;height:20px"></div>` +
        `<div role="checkbox" aria-checked="false" data-pid="w2" style="width:20px;height:20px"></div><div role="checkbox" aria-checked="false" data-pid="w3" style="width:80px;height:20px">Named by its text</div>` +
        `<div role="tab" data-pid="t1" style="width:40px;height:20px"></div><div role="tab" data-pid="t2" style="width:40px;height:20px">Tab</div>`;
    const bare = page("", body)
        .replace('<html lang="en">', "<html>")
        .replace('<main data-pid="page">', "<div>")
        .replace("</main>", "</div>");
    const report = await check(bare, { viewport: "desktop" }, null);
    const fields = ofRule(report, "form-label");
    const names = ofRule(report, "accessible-name");
    const pidsOf = (list: { pid?: string }[]) => list.map((item) => item.pid).sort();

    assert.deepEqual(pidsOf(fields), ["n1", "n10", "n2", "n6", "n8", "w1", "w2"]);
    assert.deepEqual(pidsOf(names), ["a1", "b1", "b7", "t1"]);
    assert.ok([...fields, ...names].every((item) => item.level === "error"));
    const message = (pid: string) =>
        [...fields, ...names].find((item) => item.pid === pid)!.message;

    assert.match(
        message("n1"),
        /^A <input type=email> has no label \(no label, aria-label, aria-labelledby, or title; a placeholder is not a label: it goes away when a person types, and not every screen reader reads it\)/,
    );
    assert.match(
        message("n2"),
        /Add a `<label for="id">` \(or wrap the field in a `<label>`\), or add `aria-label="what it is"`\./,
    );
    assert.match(message("w1"), /^A <div\[role=textbox\]> has no label/);
    assert.match(message("b1"), /^A <button> has no accessible name/);
    assert.match(message("b1"), /Add `aria-label="what it does"`\./);
    assert.match(message("b7"), /^A <div\[role=switch\]> has no accessible name/);
    const lang = ofRule(report, "missing-lang");

    assert.equal(lang.length, 1);
    assert.equal(lang[0]!.level, "error");
    assert.equal(lang[0]!.selector, "html");
    assert.match(lang[0]!.message, /Set `<html lang="en">`/);
    assert.equal(ofRule(report, "missing-main").length, 1);
    assert.equal(ofRule(report, "missing-main")[0]!.level, "warning");
    const empty = await check(
        page("", body).replace('<html lang="en">', '<html lang=" ">'),
        { viewport: "desktop" },
        null,
    );

    assert.equal(ofRule(empty, "missing-lang").length, 1);
    const fine = await check(page("", body), { viewport: "desktop" }, null);

    assert.equal(ofRule(fine, "missing-lang").length, 0);
    assert.equal(ofRule(fine, "missing-main").length, 0);
    assert.equal(ofRule(fine, "form-label").length + ofRule(fine, "accessible-name").length, 11);
    const role = await check(
        bare.replace("<div>", '<div role="main">'),
        { viewport: "desktop" },
        null,
    );

    assert.equal(ofRule(role, "missing-main").length, 0);
    const deck = await check(
        `<!doctype html><html lang="en"><meta name="pocket-kind" content="deck"><section class="slide" data-pid="s"><h1>Hi</h1></section>`,
        { viewport: "desktop" },
        null,
    );

    assert.equal(ofRule(deck, "missing-main").length, 0);
});

test("a field under 16px is a warning on a phone, with the token to use", browser, async () => {
    const body =
        `<input data-pid="small" aria-label="a" style="font-size:14px">` +
        `<input data-pid="plain" aria-label="b">` +
        `<input data-pid="ok" aria-label="c" style="font-size:16px">` +
        `<select data-pid="sel" aria-label="d" style="font-size:15px"><option>a</option></select>` +
        `<textarea data-pid="area" aria-label="e" style="font-size:13px"></textarea>` +
        `<input type="checkbox" data-pid="box" aria-label="f"><input type="range" data-pid="range" aria-label="g">` +
        `<div style="font-size:14px"><input data-pid="inherit" aria-label="h" style="font:inherit"></div>`;
    const phone = await check(page("", body), { viewport: "mobile" });
    const zoom = ofRule(phone, "input-zoom");

    // An unstyled input has the size of the browser, not of the page: it is not judged.
    assert.deepEqual(zoom.map((item) => item.pid).sort(), ["area", "sel", "small"]);
    assert.deepEqual(
        onPid(phone, "input-zoom", "small")!.elements!.map((item) => item.pid),
        ["small", "inherit"],
        "a field with font: inherit is judged: it is in the finding of the other 14px field",
    );
    assert.equal(zoom[0]!.level, "warning");
    assert.match(
        onPid(phone, "input-zoom", "small")!.message,
        /iOS Safari zooms the page in when a field under 16px gets the focus\. Set `font-size: var\(--font-size-md\)` \(16px\)\./,
    );
    assert.equal(onPid(phone, "input-zoom", "small")!.value, "14px");
    assert.equal(
        ofRule(await check(page("", body), { viewport: "desktop" }), "input-zoom").length,
        0,
    );
    const none = await check(page("", body), { viewport: "mobile" }, null);

    assert.match(onPid(none, "input-zoom", "small")!.message, /Set `font-size: 16px`\./);
});

const defaults =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Defaults</title>\n<link rel="stylesheet" href="site.css">\n<style>input,select,textarea{width:240px}button{min-height:44px;min-width:44px}</style></head><body>\n<main data-pid="m"><article data-pid="art"><section data-pid="sec"><h1 data-pid="h1">Nested h1</h1><section><h1 data-pid="h1b">Deeper h1</h1></section></section></article>\n<h2 data-pid="h2">Sub</h2><p data-pid="p">Text with <a href="#" data-pid="a">a link</a>, <code data-pid="c">code</code>, <small>small</small>, <mark data-pid="mk">mark</mark>.</p>\n<form data-pid="f"><fieldset data-pid="fs"><legend>Group</legend><label>Name <input data-pid="i" type="text"></label>\n<label><input type="radio" name="r" data-pid="r1"> One</label><label><input type="checkbox" data-pid="cb"> Two</label>\n<select data-pid="s" aria-label="Pick"><option>A</option></select><textarea data-pid="t" aria-label="Notes"></textarea>\n<button data-pid="b" type="submit">Send</button><input type="reset" data-pid="rs"></fieldset></form>\n<table data-pid="tb" border="1" cellpadding="6"><caption>Cap</caption><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>\n<ul data-pid="ul"><li>One<ul><li>Nested</li></ul></li></ul><ol data-pid="ol"><li>One</li></ol><dl data-pid="dl"><dt>T</dt><dd>D</dd></dl>\n<blockquote data-pid="bq">Quote</blockquote><pre data-pid="pre">pre text</pre><hr data-pid="hr"><details data-pid="d"><summary>More</summary>Body</details>\n<font color="#ff0000" data-pid="font">Old font tag</font> <center data-pid="center">Centered</center></main></body></html>\n';
const sheet = (css: string) => [{ name: "site.css", type: "text/css", bytes: Buffer.from(css) }];

test(
    "a value that no author CSS sets is never an off-system finding, whatever its value",
    browser,
    async () => {
        // The page keeps the browser's defaults on purpose (nested h1, table cells, controls, links, legacy tags) and sets
        // only the size of its controls, in a style element and in a linked sheet.
        for (const viewport of ["mobile", "desktop"] as const) {
            for (const colorScheme of ["light", "dark"] as const) {
                const report = await check(
                    defaults,
                    { viewport, colorScheme },
                    testSystem(),
                    sheet("main{max-width:60rem}"),
                );

                assert.deepEqual(
                    report.findings
                        .filter((item) => item.rule.startsWith("off-system"))
                        // `<font color>` and `cellpadding` are attributes of the markup, not CSS: the rule is about CSS.
                        .map((item) => `${item.rule}:${item.pid}`),
                    [],
                    `${viewport} ${colorScheme}`,
                );
            }
        }
    },
);

test(
    "what a linked sheet or a style attribute sets is judged, and a sheet that cannot be read does not break the rest",
    browser,
    async () => {
        const linked = await check(
            defaults
                .replace("</head>", "<style>h2{color:#123456}</style></head>")
                .replace('<p data-pid="p">', '<p data-pid="p" style="padding:14px">'),
            { viewport: "desktop" },
            testSystem(),
            sheet("button{padding:15px;border:1px solid #abcdef;border-radius:12px}"),
        );
        const values = (pid: string) =>
            linked.findings
                .filter((item) => item.pid === pid && item.rule.startsWith("off-system"))
                .map((item) => `${item.rule}:${item.value}`)
                .sort();

        assert.deepEqual(values("b"), [
            "off-system-color:#abcdef",
            "off-system-size:12px",
            "off-system-size:15px",
        ]);
        assert.deepEqual(values("h2"), ["off-system-color:#123456"]);
        assert.deepEqual(values("p"), ["off-system-size:14px"]);
        // A sheet from another site cannot be read (the check is offline): the browser's defaults then stand in, and the plain
        // page still gives no false finding.
        const external = await check(
            defaults.replace(
                '<link rel="stylesheet" href="site.css">',
                '<link rel="stylesheet" href="https://fonts.example/site.css">',
            ),
            { viewport: "desktop" },
        );

        assert.deepEqual(
            external.findings
                .filter((item) => item.rule.startsWith("off-system"))
                .map((item) => item.pid),
            [],
        );
    },
);

test(
    "a longhand that no author rule sets is the browser's, even when its shorthand family has another longhand set",
    browser,
    async () => {
        const body =
            // The paragraph's own margin below (1em of 14px = 14px) is not judged when only margin-top is set.
            `<p data-pid="p1" style="font-size:var(--font-size-sm);margin-top:0">x</p>` +
            `<p data-pid="p2" class="q">x</p><p data-pid="p3" style="font-size:var(--font-size-sm);margin-block-start:0">x</p>` +
            `<div data-pid="pad" style="padding-top:10px">x</div>` +
            `<div data-pid="gap" style="display:flex;row-gap:10px"><span>a</span><span>b</span></div>` +
            `<div data-pid="border" style="border-top:1px solid var(--color-text-muted);border-bottom-width:3px;border-bottom-style:solid;border-bottom-color:var(--color-text-muted)">x</div>` +
            `<div data-pid="corner" style="height:40px;border-top-left-radius:6px">x</div>` +
            `<p data-pid="all" style="font-size:var(--font-size-sm);margin:0 0 14px">x</p>` +
            `<p data-pid="logical" style="font-size:var(--font-size-sm);margin-block:0;padding-inline:10px">x</p>`;
        const report = await check(page(".q{font-size:var(--font-size-sm);margin-top:0}", body), {
            viewport: "desktop",
        });
        const values = (pid: string) =>
            report.findings
                .filter(
                    (item) =>
                        item.rule === "off-system-size" &&
                        (item.elements?.map((each) => each.pid) ?? [item.pid]).includes(pid),
                )
                .map((item) => item.value)
                .sort();

        assert.deepEqual(values("p1"), []);
        assert.deepEqual(values("p2"), []);
        assert.deepEqual(values("p3"), []);
        assert.deepEqual(values("pad"), ["10px"], "padding-top only: the bottom is 0");
        assert.deepEqual(values("gap"), ["10px"]);
        assert.deepEqual(
            values("border"),
            [],
            "border widths are not on a scale; the top border is the author's, the sides are not",
        );
        assert.deepEqual(values("corner"), ["6px"]);
        assert.deepEqual(values("all"), ["14px"], "the shorthand sets the bottom margin");
        assert.deepEqual(
            values("logical"),
            ["10px"],
            "padding-inline sets left and right; margin-block sets 0",
        );
    },
);
