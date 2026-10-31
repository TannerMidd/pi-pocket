import assert from "node:assert/strict";
import { test } from "node:test";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { applyExactFixes } from "../src/server/design/fix.ts";
import { checkDesign } from "../src/server/design/lint.ts";
import type { CheckFinding, CheckFix } from "../src/server/design/system-types.ts";
import { bundleOf, check, host, ofRule, page, testSystem, token } from "./design-lint-fixtures.ts";

// One mode: a token that differs between modes cannot be put in a page by a fix (see the last test).
const single = () => ({ ...testSystem(), modes: ["light"] });
const system = single();
const color = (
    literal: string,
    name: string,
    properties: string[],
    extra: Partial<CheckFinding> = {},
): CheckFinding => ({
    id: `off-system-color-${literal}-${extra.pid ?? extra.selector ?? ""}`,
    rule: "off-system-color",
    level: "warning",
    selector: "",
    message: "m",
    value: literal,
    fix: {
        kind: "color",
        properties,
        literal,
        token: name,
        cssVar: `--${name.replaceAll(".", "-")}`,
        mode: "light",
    } satisfies CheckFix,
    ...extra,
});
const length = (
    literal: string,
    name: string,
    properties: string[],
    extra: Partial<CheckFinding> = {},
): CheckFinding => ({
    ...color(literal, name, properties, extra),
    rule: "off-system-size",
    fix: {
        kind: "length",
        properties,
        literal,
        token: name,
        cssVar: `--${name.replaceAll(".", "-")}`,
        mode: "light",
    },
});

const MUTED = "color.text.muted";

test("a literal is replaced where it is the declaration of the named property, and nowhere else", () => {
    const content = `<!doctype html><style>
/* color: #5a5f73 in a comment */
.a { color: #5a5f73; }
.b { content: "#5a5f73"; background: url(x.png#5a5f73); }
.c { color: var(--x, #5a5f73); }
@font-face { font-family: x; src: url(a.woff2); color: #5a5f73; }
@keyframes k { from { color: #5a5f73 } }
:root { --muted: #5a5f73; }
</style>
<script>const c = "color: #5a5f73"; document.body.style.color = '#5a5f73'; /* <style>.z{color:#5a5f73}</style> */</script>
<p data-pid="t" style="margin:0;color:#5a5f73">text #5a5f73</p>
<p title="color:#5a5f73" data-x='style="color:#5a5f73"'>x #5a5f73</p>`;
    const found = color("#5a5f73", MUTED, ["color"], { pid: "t", selector: '[data-pid="t"]' });
    const result = applyExactFixes(content, [found], system);

    assert.equal(result.applied, 1);
    assert.deepEqual(result.skipped, []);
    assert.equal(
        result.content,
        content.replace(
            'style="margin:0;color:#5a5f73"',
            'style="margin:0;color:var(--color-text-muted)"',
        ),
    );
    assert.match(result.content, /\.a \{ color: #5a5f73; \}/);
    assert.match(result.content, /\/\* color: #5a5f73 in a comment \*\//);
    assert.match(result.content, /content: "#5a5f73"; background: url\(x\.png#5a5f73\)/);
    assert.match(result.content, /var\(--x, #5a5f73\)/);
    assert.match(result.content, /@font-face \{[^}]*color: #5a5f73/);
    assert.match(result.content, /@keyframes k \{ from \{ color: #5a5f73 \} \}/);
    assert.match(result.content, /--muted: #5a5f73/);
    assert.match(
        result.content,
        /const c = "color: #5a5f73"; document\.body\.style\.color = '#5a5f73'/,
    );
    assert.match(result.content, /title="color:#5a5f73" data-x='style="color:#5a5f73"'>x #5a5f73/);
    const rule = applyExactFixes(
        content,
        [color("#5a5f73", MUTED, ["color"], { selector: ".a" })],
        system,
    );

    assert.equal(rule.applied, 1);
    assert.match(rule.content, /\.a \{ color: var\(--color-text-muted\); \}/);
    assert.match(rule.content, /style="margin:0;color:#5a5f73"/);
});

test("where several places match and none is certain, one finding is skipped and several are fixed together", () => {
    const content = `<style>.a{color:#5a5f73}.b{color:#5a5f73}.c{color:#5a5f73}</style>`;
    const one = applyExactFixes(
        content,
        [color("#5a5f73", MUTED, ["color"], { id: "x", selector: "p" })],
        system,
    );

    assert.equal(one.applied, 0);
    assert.equal(one.content, content);
    assert.match(one.skipped[0]!.reason, /3 places set color to #5a5f73 and none is certain/);
    assert.equal(one.skipped[0]!.id, "x");
    const three = applyExactFixes(
        content,
        ["a", "b", "c"].map((id) =>
            color("#5a5f73", MUTED, ["color"], { id, selector: `div.${id} > p` }),
        ),
        system,
    );

    assert.equal(three.applied, 3);
    assert.equal(three.content, content.replaceAll("#5a5f73", "var(--color-text-muted)"));
    assert.equal(
        applyExactFixes(
            `<style>.a{color:#5a5f73}</style>`,
            [color("#5a5f73", MUTED, ["color"])],
            system,
        ).applied,
        1,
    );
});

test("shorthands: only the literal changes, not the rest of the value; important stays", () => {
    const content = `<style>
.a { border: 1px solid #5a5f73 !important; }
.b { background: url(a.png#fff) no-repeat #ffffff; }
.c { border-bottom: 2px dashed rgb(90, 95, 115); }
.d { border-color: #5a5f73 #fff; }
</style>`;
    const result = applyExactFixes(
        content,
        [
            ...[".a", ".c", ".d"].map((selector) =>
                color("#5a5f73", MUTED, ["border", "border-color", "border-bottom"], {
                    id: `border${selector}`,
                    selector,
                }),
            ),
            color("#ffffff", "color.bg.surface", ["background-color", "background"], { id: "bg" }),
        ],
        system,
    );

    assert.equal(result.skipped.length, 0);
    assert.match(
        result.content,
        /\.a \{ border: 1px solid var\(--color-text-muted\) !important; \}/,
    );
    assert.match(
        result.content,
        /\.b \{ background: url\(a\.png#fff\) no-repeat var\(--color-bg-surface\); \}/,
    );
    assert.match(result.content, /\.c \{ border-bottom: 2px dashed var\(--color-text-muted\); \}/);
    // `border-color: #5a5f73 #fff`: the one that equals the token; the other is another color.
    assert.match(result.content, /\.d \{ border-color: var\(--color-text-muted\) #fff; \}/);
    assert.equal(result.applied, 4);
});

test("lengths: a px literal of the named property, not a line height, a negative, or a calc()", () => {
    const content = `<style>
.a { padding: 14px 16px; margin: -16px; gap: calc(16px + 1px); width: 16px; }
.b { font: 16px/16px sans-serif; }
.c { border-radius: 16px; }
</style><p data-pid="p" style="padding:16px 16.0px;margin:0 16px">x</p>`;
    const result = applyExactFixes(
        content,
        [
            length("16px", "space.4", ["padding", "margin", "gap"], {
                id: "space",
                selector: ".a",
            }),
            length("16px", "font.size.md", ["font-size", "font"], { id: "font", selector: ".b" }),
            length("16px", "radius.lg", ["border-radius"], { id: "radius", selector: ".c" }),
        ],
        { ...system, tokens: [...system.tokens, token("radius.lg", "dimension", "16px")] },
    );

    assert.deepEqual(result.skipped, []);
    assert.match(
        result.content,
        /\.a \{ padding: 14px var\(--space-4\); margin: -16px; gap: calc\(16px \+ 1px\); width: 16px; \}/,
    );
    assert.match(
        result.content,
        /\.b \{ font: var\(--font-size-md\)\/16px sans-serif; \}/,
        "the size, not the line height",
    );
    assert.match(result.content, /\.c \{ border-radius: var\(--radius-lg\); \}/);
    // The inline style is the same property and the same literal, and no selector or pid names it: not certain, so left.
    assert.match(result.content, /style="padding:16px 16\.0px;margin:0 16px"/);
});

test("a font list that equals the token's whole list is replaced; a part of it is not", () => {
    const content = `<style>.a{font-family:"System-UI", sans-serif}.b{font-family:system-ui,sans-serif,emoji}</style><p style="font-family:&quot;system-ui&quot;, sans-serif" data-pid="p">x</p>`;
    const found = (extra: Partial<CheckFinding>): CheckFinding => ({
        ...color("system-ui, sans-serif", "font.body", ["font-family"], extra),
        rule: "off-system-font",
        fix: {
            kind: "font",
            properties: ["font-family"],
            literal: "system-ui, sans-serif",
            token: "font.body",
            cssVar: "--font-body",
            mode: "light",
        },
    });
    const rule = applyExactFixes(content, [found({ selector: ".a" })], system);

    assert.match(rule.content, /\.a\{font-family:var\(--font-body\)\}/);
    assert.match(rule.content, /\.b\{font-family:system-ui,sans-serif,emoji\}/);
    const inline = applyExactFixes(
        content,
        [found({ pid: "p", selector: '[data-pid="p"]' })],
        system,
    );

    assert.match(inline.content, /style="font-family:var\(--font-body\)"/);
});

test("a finding is skipped when it has no fix, when the token changed, or when the place is not in the style", () => {
    const content = `<style>.a{color:#5a5f73}</style><script>x = "#5a5f73"</script>`;
    const plain: CheckFinding = {
        id: "p",
        rule: "off-system-color",
        level: "error",
        selector: "",
        message: "m",
    };
    const moved = single();

    Object.assign(moved.tokens.find((item) => item.name === MUTED)!.modes.light!, {
        value: "#5a5f74",
        css: "#5a5f74",
    });
    const gone = single();

    gone.tokens = gone.tokens.filter((item) => item.name !== MUTED);
    const result = applyExactFixes(
        content,
        [
            plain,
            color("#5a5f73", MUTED, ["color"], { id: "changed" }),
            color("#5a5f73", MUTED, ["color"], { id: "missing" }),
            color("#123456", "color.bg.page", ["color"], { id: "elsewhere" }),
        ],
        moved,
    );

    assert.equal(result.applied, 0);
    assert.equal(result.content, content);
    assert.deepEqual(
        result.skipped.map((item) => [item.id, item.reason.slice(0, 30)]),
        [
            ["p", "Not fixable: the value is not "],
            ["changed", "The token color.text.muted is "],
            ["missing", "The token color.text.muted is "],
            ["elsewhere", "The token color.bg.page is not"],
        ],
    );
    assert.match(
        applyExactFixes(content, [color("#5a5f73", MUTED, ["color"], { id: "g" })], gone)
            .skipped[0]!.reason,
        /not in the design system any more/,
    );
    const script = applyExactFixes(
        `<script>x = "color: #5a5f73"</script><p>#5a5f73</p>`,
        [color("#5a5f73", MUTED, ["color"], { id: "s" })],
        system,
    );

    assert.match(script.skipped[0]!.reason, /may come from a script or a file/);
});

test("broken and hostile pages are read safely", () => {
    const found = [color("#5a5f73", MUTED, ["color"], { id: "c", selector: ".a" })];
    const cases: [string, string][] = [
        ["an unclosed style", `<style>.a{color:#5a5f73}`],
        ["an unclosed comment", `<style>.a{color:#5a5f73} /* never closed`],
        ["an unclosed string", `<style>.a{color:#5a5f73;content:"x}.b{color:#5a5f73}</style>`],
        [
            "a closing style tag in a script",
            `<script>"</style>"</script><style>.a{color:#5a5f73}</style>`,
        ],
        ["upper case", `<STYLE>.a{COLOR:#5A5F73}</STYLE>`],
        [
            "an attribute with a > in it",
            `<p title="a > b" style="color:#5a5f73" data-pid="p">x</p><style>.a{color:#5a5f73}</style>`,
        ],
        [
            "a comment hides a tag",
            `<!-- <style>.a{color:#5a5f73}</style> --><style>.a{color:#5a5f73}</style>`,
        ],
        [
            "an unquoted attribute",
            `<p style=color:#5a5f73 data-pid=p>x</p><style>.a{color:#5a5f73}</style>`,
        ],
    ];

    for (const [name, content] of cases) {
        const result = applyExactFixes(content, found, system);

        assert.ok(result.content.length >= content.length - 2, name);
        assert.doesNotMatch(result.content, /var\(--color-text-muted\)var/, name);
    }

    const hidden = applyExactFixes(cases[5]![1], found, system);

    assert.match(hidden.content, /style="color:#5a5f73"/, "the inline style is not the .a rule");
    assert.match(hidden.content, /\.a\{color:var\(--color-text-muted\)\}/);
    assert.match(
        applyExactFixes(cases[6]![1], found, system).content,
        /<!-- <style>\.a\{color:#5a5f73\}<\/style> -->/,
    );
    assert.match(
        applyExactFixes(cases[4]![1], found, system).content,
        /<STYLE>\.a\{COLOR:var\(--color-text-muted\)\}<\/STYLE>/,
    );
    const huge = `<style>.a{color:#5a5f73}</style>${"x".repeat(2_000_001)}`;
    const refused = applyExactFixes(huge, found, system);

    assert.equal(refused.content, huge);
    assert.match(refused.skipped[0]!.reason, /too large/);
});

test("a large page with many findings is fixed in time: each declaration is read once", () => {
    const hex = (index: number) =>
        `#${(index * 40_503 + 4_097).toString(16).padStart(6, "0").slice(-6)}`;
    const many = {
        ...single(),
        tokens: Array.from({ length: 300 }, (_, index) =>
            token(`color.c${index}`, "color", hex(index)),
        ),
    };
    const rules: string[] = [];
    const inline: string[] = [];

    for (let index = 0; index < 10_000; index++) {
        rules.push(
            `.r${index} { color: ${hex(index % 300)}; border: 1px solid ${hex(index % 7)} }\n`,
        );
        inline.push(`<p data-pid="p${index}" style="color: ${hex(index % 300)}">x</p>\n`);
    }

    const content = `<style>${rules.join("")}</style>${inline.join("")}`;
    const findings = Array.from({ length: 300 }, (_, index) =>
        color(hex(index), `color.c${index}`, ["color"], {
            id: `f${index}`,
            selector: `.r${index}`,
        }),
    );
    const start = performance.now();
    const result = applyExactFixes(content, findings, many);

    assert.equal(result.skipped.length, 0);
    assert.equal(result.applied, 300);
    assert.ok(performance.now() - start < 1500, `took ${performance.now() - start} ms`);
});

test("a fix is idempotent: the second call finds nothing to do", () => {
    const content = `<style>.a{color:#5a5f73;padding:16px}</style>`;
    const findings = [
        color("#5a5f73", MUTED, ["color"], { id: "c", selector: ".a" }),
        length("16px", "space.4", ["padding"], { id: "s", selector: ".a" }),
    ];
    const first = applyExactFixes(content, findings, system);
    const second = applyExactFixes(first.content, findings, system);

    assert.equal(first.applied, 2);
    assert.equal(second.applied, 0);
    assert.equal(second.content, first.content);
    assert.equal(second.skipped.length, 2);
});

test(
    "a report's own fixable findings fix the page, and a new check finds them gone",
    { skip: findBrowser() === undefined, timeout: 120_000 },
    async () => {
        const content = page(
            ".note{margin:0;padding:16px;color:#5a5f73;background:#ffffff;border-radius:8px;font-family:system-ui,sans-serif}",
            `<p class="note" data-pid="note">Quiet</p><p data-pid="loud" style="margin:0;color:#7ba3f8;padding:16px">Loud</p>`,
        );
        const before = await check(content, {}, system);
        const fixable = before.findings.filter((item) => item.fix !== undefined);

        assert.deepEqual(fixable.map((item) => `${item.rule}:${item.fix!.token}`).sort(), [
            "off-system-color:color.bg.surface",
            "off-system-color:color.text.muted",
            "off-system-font:font.body",
            "off-system-size:radius.md",
            "off-system-size:space.4",
        ]);
        assert.equal(fixable.find((item) => item.fix!.token === "space.4")!.elements?.length, 2);
        // `#7ba3f8` is near a token but not equal to it: not fixable.
        assert.equal(
            ofRule(before, "off-system-color").find((item) => item.pid === "loud")?.fix,
            undefined,
        );
        const result = applyExactFixes(content, before.findings, system);

        assert.ok(result.applied >= 6);
        const after = await checkDesign(
            bundleOf(result.content),
            system,
            { viewport: "mobile" },
            host,
        );

        assert.deepEqual(
            after.findings.filter((item) => item.fix !== undefined),
            [],
            "nothing that was fixable is left",
        );
        assert.equal(
            ofRule(after, "off-system-color").filter((item) => item.pid === "note").length,
            0,
        );
        assert.ok(ofRule(after, "off-system-color").some((item) => item.pid === "loud"));
        assert.equal(applyExactFixes(result.content, after.findings, system).applied, 0);
    },
);

test(
    "a fix puts in a token only when it has the literal in every mode",
    { skip: findBrowser() === undefined, timeout: 120_000 },
    async () => {
        const content = page(
            ".note{margin:0;color:#5a5f73}",
            `<p class="note" data-pid="note">Quiet</p>`,
        );
        const fixOf = async (given: ReturnType<typeof testSystem>) =>
            ofRule(await check(content, {}, given), "off-system-color").find(
                (item) => item.pid === "note",
            )?.fix?.token;
        const steady = testSystem();

        steady.tokens.push(token("color.gray.600", "color", "#5a5f73", "#5a5f73", "primitive"));
        assert.equal(
            await fixOf(testSystem()),
            undefined,
            "color.text.muted is another color in dark",
        );
        assert.equal(await fixOf(steady), "color.gray.600");
    },
);
