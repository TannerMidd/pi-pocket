import assert from "node:assert/strict";
import { test } from "node:test";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { checkText } from "../src/server/design/index.ts";
import {
    acceptFindings,
    findingId,
    groupFindings,
    notJudgedText,
} from "../src/server/design/lint.ts";
import type { CheckFinding, CheckReport } from "../src/server/design/system-types.ts";
import { cleanReport } from "../src/server/extensions/design/system-routes.ts";
import { check, ofRule, page, testSystem } from "./design-lint-fixtures.ts";

const browser = { skip: findBrowser() === undefined, timeout: 120_000 };

const serif = (id: string) =>
    `<h1 data-pid="${id}" style="font-family:'Times New Roman';margin:0">Title ${id}</h1>`;

test(
    "one defect on several elements is one finding that lists them, with a pin for each",
    browser,
    async () => {
        const report = await check(page("", `${serif("title")}${serif("sub")}${serif("third")}`));
        const fonts = ofRule(report, "off-system-font");

        assert.equal(fonts.length, 1);
        assert.deepEqual(
            fonts[0]!.elements!.map((item) => item.pid),
            ["title", "sub", "third"],
        );
        assert.equal(fonts[0]!.pid, "title", "selector, pid, and rect are the first element's");
        assert.ok(
            fonts[0]!.elements!.every((item) => item.selector !== "" && item.rect!.width > 0),
        );
        assert.match(fonts[0]!.message, /The same in 2 more places: sub, third\.$/);
        assert.equal(report.summary.byRule["off-system-font"], 1);
        const swapped = await check(page("", `${serif("third")}${serif("title")}${serif("sub")}`));
        const fewer = await check(page("", `${serif("title")}${serif("sub")}`));

        assert.equal(ofRule(swapped, "off-system-font")[0]!.id, fonts[0]!.id);
        assert.notEqual(ofRule(fewer, "off-system-font")[0]!.id, fonts[0]!.id);
        const mixed = await check(
            page("", `${serif("a")}<p data-pid="b" style="font-family:Georgia;margin:0">B</p>`),
        );

        assert.equal(ofRule(mixed, "off-system-font").length, 2);
    },
);

test("grouping leaves page-level findings and different defects alone", () => {
    const base: CheckFinding = {
        rule: "tap-target",
        level: "error",
        selector: "a",
        pid: "x",
        value: "10×10px",
        message: "A <a> target is 10×10 px (and 1 more element).",
    };
    const same = { ...base, selector: "b", pid: "y", message: "A <a> target is 10×10 px." };
    const other = {
        ...base,
        selector: "c",
        pid: "z",
        value: "12×12px",
        message: "A <a> target is 12×12 px.",
    };
    const page1: CheckFinding = {
        rule: "missing-viewport",
        level: "error",
        selector: "",
        message: "No viewport.",
    };
    const page2 = { ...page1 };
    const alone = findingId(base);
    const grouped = [base, same, other, page1, page2].reduce(groupFindings, [] as CheckFinding[]);

    assert.deepEqual(
        grouped.map((item) => item.pid ?? item.rule),
        ["x", "z", "missing-viewport", "missing-viewport"],
    );
    assert.deepEqual(
        grouped[0]!.elements!.map((item) => item.pid),
        ["x", "y"],
    );
    assert.equal(grouped[1]!.elements, undefined);
    assert.notEqual(findingId(grouped[0]!), alone);
});

test(
    "a finding that a person accepted is reported apart, and stays accepted on the next check",
    browser,
    async () => {
        const content = page(
            "",
            `<p data-pid="blue" style="margin:0;color:#7ba3f8;background:var(--color-bg-surface)">On purpose</p><p data-pid="font" style="font-family:Georgia;margin:0">Serif</p>`,
        );
        const first = await check(content);
        const blue = ofRule(first, "off-system-color").find((item) => item.pid === "blue")!;

        assert.equal(first.accepted, undefined);
        assert.equal(first.summary.accepted, undefined);
        const accepted = await check(content, {
            accepted: [blue.id!, "off-system-size-0000000000"],
        });

        assert.equal(
            accepted.findings.some((item) => item.id === blue.id),
            false,
        );
        assert.deepEqual(
            accepted.accepted!.map((item) => item.id),
            [blue.id],
        );
        assert.equal(accepted.accepted![0]!.level, "error", "it keeps what it was");
        assert.equal(accepted.summary.accepted, 1);
        assert.equal(accepted.summary.errors, first.summary.errors - 1);
        assert.equal(
            accepted.summary.byRule["off-system-color"] ?? 0,
            (first.summary.byRule["off-system-color"] ?? 0) - 1,
        );
        assert.equal(accepted.findings.length, first.findings.length - 1);
        const again = await check(content, { accepted: [blue.id!], colorScheme: "dark" });

        assert.deepEqual(
            again.accepted!.map((item) => item.id),
            [blue.id],
        );
        const changed = await check(content.replace("#7ba3f8", "#7ba3fa"), {
            accepted: [blue.id!],
        });

        assert.equal(changed.accepted, undefined);
        assert.ok(ofRule(changed, "off-system-color").some((item) => item.value === "#7ba3fa"));
        assert.equal(acceptFindings(first, undefined), first);
        assert.equal(acceptFindings(first, ["nothing-0000000000"]), first);
    },
);

test(
    "contrast that was not judged is counted and named, and a page with nothing to say says nothing",
    browser,
    async () => {
        const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
        const body =
            `<div style="background:linear-gradient(#fff,#eee)"><p data-pid="grad" style="margin:0;color:#ccc">Over a gradient</p></div>` +
            `<div style="position:relative;height:40px"><img alt="" src="${gif}" style="position:absolute;inset:0;width:100%;height:40px"><p data-pid="image" style="position:absolute;margin:0;color:#ccc">Over an image</p></div>` +
            `<div style="opacity:0.5"><p data-pid="faded" style="margin:0;color:#1c1e26">Faded</p></div>` +
            `<p data-pid="judged" style="margin:0;color:#1c1e26;background:#fff">Judged</p><button disabled data-pid="off" style="color:#aaa">Disabled</button>`;
        const report = await check(page("", body), { viewport: "desktop" }, null);
        const left = report.summary.notJudged!.contrast;

        assert.equal(
            left.count,
            3,
            "three; the disabled button is exempt, and the judged text is judged",
        );
        assert.deepEqual(left.elements.length, 3);
        assert.ok(left.elements.some((each) => each.includes("grad")));
        assert.match(
            notJudgedText(report)!,
            /^Contrast not judged on 3 elements \(what is behind the text is not certain: a gradient, an image, an overlay, a filter, or a faded parent\): .*\[data-pid="grad"\]/,
        );
        const text = checkText([{ view: "desktop", report }], undefined, undefined, []);

        assert.equal(
            text.split("\n").filter((line) => line.startsWith("Contrast not judged on 3 elements"))
                .length,
            1,
        );
        const clean = await check(
            page("", `<p data-pid="a" style="margin:0;color:#1c1e26;background:#fff">Fine</p>`),
            {},
            null,
        );

        assert.equal(clean.summary.notJudged, undefined);
        assert.equal(notJudgedText(clean), undefined);
        assert.doesNotMatch(
            checkText([{ view: "mobile", report: clean }], undefined, undefined, []),
            /not judged/,
        );
    },
);

test("the route cleans what a report adds: elements, accepted findings, and what was not judged", () => {
    const finding = (id: string, extra: object = {}) => ({
        id,
        rule: "off-system-font" as const,
        level: "error" as const,
        selector: "h1",
        pid: "title",
        value: "Times New Roman",
        message: "Font is not a system font.",
        ...extra,
    });
    const report = {
        viewport: { width: 390, height: 844 },
        colorScheme: "light",
        findings: [
            finding("off-system-font-aaaaaaaaaa", {
                elements: [
                    { selector: "h1", pid: "title", rect: { x: 1, y: 2, width: 3, height: 4 } },
                    { selector: "h2", pid: "sub" },
                    { selector: 5 },
                ],
            }),
        ],
        accepted: [finding("off-system-color-bbbbbbbbbb"), { rule: "nope" }, null],
        summary: {
            errors: 1,
            warnings: 0,
            elements: 9,
            byRule: {},
            accepted: 1,
            notJudged: {
                contrast: {
                    count: 3,
                    elements: ["a", "b", "x".repeat(900), ...Array(20).fill("c")],
                },
            },
        },
        withoutSystem: false,
    } as unknown as CheckReport;
    const cleaned = cleanReport(report);

    assert.deepEqual(
        cleaned.findings[0]!.elements!.map((item) => item.pid),
        ["title", "sub", undefined],
    );
    assert.equal(cleaned.findings[0]!.elements![2]!.selector, "");
    assert.deepEqual(
        cleaned.accepted!.map((item) => item.id),
        ["off-system-color-bbbbbbbbbb"],
    );
    assert.equal(cleaned.summary.accepted, 1);
    assert.equal(cleaned.summary.notJudged!.contrast.count, 3);
    assert.equal(cleaned.summary.notJudged!.contrast.elements.length, 8);
    assert.ok(cleaned.summary.notJudged!.contrast.elements.every((each) => each.length <= 500));
    const bare = cleanReport({
        ...report,
        accepted: [],
        summary: { ...report.summary, accepted: undefined, notJudged: undefined },
    } as unknown as CheckReport);

    assert.deepEqual(bare.accepted, []);
    assert.equal(bare.summary.accepted, undefined);
    assert.equal(bare.summary.notJudged, undefined);
    void testSystem;
});
