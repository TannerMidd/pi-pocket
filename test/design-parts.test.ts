// The workspace's plain parts (`extensions/design/*.js`), which touch no page: frame sizes and zoom, tweak knobs, text
// edits, the messages put in the message box for Pi, which comments have pins, and the list of designs.
import assert from "node:assert/strict";
import { test } from "node:test";

const load = (name: string) =>
    import(new URL(`../src/server/extensions/design/${name}.js`, import.meta.url).href);

const devices = await load("devices");
const tweaks = await load("tweaks");
const edits = await load("edits");
const messages = await load("messages");
const comments = await load("comments");
const data = await load("data");
const parts = await load("parts");

test("on a phone the zoom that nobody chose is the width of the room, and the page scrolls; a tap goes width, whole page, 100%", () => {
    const room = { w: 390, h: 300 };

    // A phone's page (390 × 844) at the width of a 390 px room, less the margin: readable; the whole page would be 0.3.
    assert.equal(devices.scaleOf("width", { w: 390, h: 844 }, room), 0.91);
    assert.equal(devices.scaleOf("fit", { w: 390, h: 844 }, room), 0.31);
    assert.equal(devices.scaleOf("width", { w: 200, h: 200 }, { w: 800, h: 600 }), 1);
    assert.equal(devices.scaleOf("width", { w: 390, h: 844 }, { w: 0, h: 0 }), 1);
    assert.equal(devices.zoomOf("auto", true), "width");
    assert.equal(devices.zoomOf("auto", false), "fit");
    assert.equal(devices.zoomOf("fit", true), "fit");
    assert.equal(devices.zoomOf(0.5, true), 0.5);
    assert.equal(devices.zoomWord("width"), "Width ");
    assert.equal(devices.zoomWord("fit"), "Fit ");
    assert.equal(devices.zoomWord(1), "");
    assert.deepEqual(
        [devices.nextZoom("width", true), devices.nextZoom("fit", true), devices.nextZoom(1, true)],
        ["fit", 1, "width"],
    );
    assert.deepEqual([devices.nextZoom("fit", false), devices.nextZoom(1, false)], [1, "fit"]);
});

test("a frame's size is its device's, or the person's own kept between 200 and 4000", () => {
    assert.deepEqual(devices.sizeOf("mobile"), { w: 390, h: 844 });
    assert.deepEqual(devices.sizeOf("desktop"), { w: 1280, h: 800 });
    assert.deepEqual(devices.sizeOf("slide"), { w: 1280, h: 720 });
    assert.deepEqual(devices.sizeOf("custom", { w: 100, h: 9000 }), { w: 200, h: 4000 });
    assert.deepEqual(devices.sizeOf("custom", { w: "700", h: "x" }), { w: 700, h: 600 });
    assert.deepEqual(devices.sizeOf("nonsense"), { w: 1280, h: 800 });
    assert.equal(devices.exportViewport("tablet", {}), "tablet");
    assert.equal(devices.exportViewport("custom", { w: 400, h: 400 }), "mobile");
    assert.equal(devices.exportViewport("custom", { w: 900, h: 400 }), "tablet");
    assert.equal(devices.exportViewport("slide", { w: 1280, h: 720 }), "desktop");
});

test("fit never scales a page past 100%, and keeps a margin; a number is a number", () => {
    const room = { w: 700, h: 500 };

    assert.equal(devices.scaleOf("fit", { w: 390, h: 844 }, room), 0.55);
    assert.equal(devices.scaleOf("fit", { w: 200, h: 200 }, room), 1);
    assert.equal(devices.scaleOf("fit", { w: 1280, h: 800 }, { w: 0, h: 0 }), 1);
    assert.equal(devices.scaleOf(1.5, { w: 1280, h: 800 }, room), 1.5);
    assert.equal(devices.scaleOf("bad", { w: 1, h: 1 }, room), 1);
    assert.ok(devices.scaleOf("fit", { w: 100000, h: 100000 }, room) >= 0.1);
    assert.equal(devices.stepZoom(0.38, 1), 0.5);
    assert.equal(devices.stepZoom(0.38, -1), 0.33);
    assert.equal(devices.stepZoom(2, 1), 2);
    assert.equal(devices.stepZoom(0.25, -1), 0.25);
    assert.equal(devices.percent(0.755), "76%");
});

test("a page's knobs are cleaned: unknown types and repeats go, ranges and choices get sane values", () => {
    const knobs = tweaks.normalizeKnobs([
        { name: "--accent", type: "color", value: "#fff", label: "Accent" },
        { name: "--r", type: "range", min: 0, max: 10, value: 50, unit: "px" },
        { name: "--r", type: "range", value: 1 },
        { name: "mode", type: "select", options: ["a", { value: "b", label: "Bee" }], value: "z" },
        { name: "on", type: "toggle", value: "yes" },
        { name: "", type: "text" },
        { name: "odd", type: "slider" },
        null,
        { name: "t", type: "text", value: 5 },
    ]);

    assert.deepEqual(
        knobs.map((knob: { name: string }) => knob.name),
        ["--accent", "--r", "mode", "on", "t"],
    );
    assert.equal(knobs[1].value, 10);
    assert.equal(knobs[1].step, 0.1);
    assert.deepEqual(knobs[2].options, [
        { value: "a", label: "a" },
        { value: "b", label: "Bee" },
    ]);
    assert.equal(knobs[3].value, false);
    assert.equal(knobs[4].value, "5");
    assert.deepEqual(tweaks.normalizeKnobs("no"), []);
    assert.equal(
        tweaks.normalizeKnobs(
            Array.from({ length: 90 }, (_, at) => ({ name: `k${at}`, type: "text" })),
        ).length,
        40,
    );
});

test("saved values keep for the knobs that still exist and still fit", () => {
    const knobs = tweaks.normalizeKnobs([
        { name: "--accent", type: "color", value: "#3b6cf6" },
        { name: "--r", type: "range", min: 0, max: 32, step: 1, unit: "px", value: 12 },
        { name: "mode", type: "select", options: ["a", "b"], value: "a" },
        { name: "shout", type: "toggle", value: false },
    ]);
    const saved = { "--accent": "#ff0000", "--r": 99, mode: "gone", shout: "yes", old: 1 };
    const values = tweaks.usable(knobs, saved);

    assert.deepEqual(values, { "--accent": "#ff0000", "--r": 32 });
    assert.deepEqual(
        tweaks
            .changed(knobs, { ...values, shout: false })
            .map((knob: { name: string }) => knob.name),
        ["--accent", "--r"],
    );
    assert.equal(tweaks.coerce(knobs[0], "red"), undefined);
    assert.equal(tweaks.coerce(knobs[1], "7"), 7);
    // What goes to the page: a custom property gets its unit; an event gets the value as it is.
    assert.equal(tweaks.forPage(knobs[1], 20), "20px");
    assert.equal(tweaks.forPage({ name: "gap", type: "range", unit: "px" }, 20), 20);
    assert.equal(tweaks.forPage({ name: "--on", type: "toggle" }, true), "1");
    assert.equal(tweaks.show(knobs[1], 20), "20px");
    assert.equal(tweaks.show(knobs[3], true), "on");
});

test("text edits of one element merge, and one that ends where it began is dropped", () => {
    const target = { pid: "h", selector: "[data-pid=h]", tag: "h1", text: "Hello" };
    let list = edits.addEdit([], { target, before: "Hello", after: "Hello w" });

    assert.equal(list.length, 1);
    list = edits.addEdit(list, { target, before: "Hello w", after: "Hello world" });
    assert.deepEqual(list, [{ target, before: "Hello", after: "Hello world" }]);
    list = edits.addEdit(list, { target: { ...target, selector: "p" }, before: "a", after: "b" });
    assert.equal(list.length, 2);
    list = edits.addEdit(list, { target, before: "Hello world", after: "Hello" });
    assert.equal(list.length, 1);
    assert.equal(edits.addEdit([], { target, before: "same", after: "same" }).length, 0);
    assert.equal(edits.nameOf(target), "h1 “Hello”");
    assert.equal(edits.nameOf({ tag: "div", selector: ".x", text: "" }), "div .x");
});

test("the message for Pi names the design, and its JSON cannot end its own fence", () => {
    const target = { pid: "p", selector: "s", text: "```evil```\n```` more" };
    const text = messages.commentsMessage({
        title: "Landing",
        id: "landing",
        version: 3,
        comments: [{ text: " Make it bolder ", version: 2, byName: "Gale", target }],
    });

    assert.match(text, /^Design feedback on “Landing” \(artifact `landing`\)/);
    assert.match(text, /1\. Make it bolder\n\(on version 2, from Gale\)\n`{5}json/);
    // Longer than any run of backticks inside it.
    assert.ok(text.includes("`````json") && text.trimEnd().endsWith("`````"));
    // It starts with a letter, so the message box never takes it for a command.
    assert.match(text, /^[A-Za-z]/);

    const edit = messages.editsMessage({
        title: "L",
        id: "l",
        version: 1,
        edits: [{ target: { selector: "h1", pid: "x" }, before: "a", after: "b" }],
    });

    assert.match(edit, /“a” → “b”/);
    assert.match(edit, /"pid": "x"/);

    const knob = { name: "--r", label: "Corners", type: "range", unit: "px", value: 12 };
    const keep = messages.tweaksMessage({
        title: "L",
        id: "l",
        version: 1,
        changes: [{ knob, value: 20 }],
    });

    assert.match(keep, /Corners \(`--r`\): 12px → 20px/);
    assert.match(keep, /"--r": 20/);
    assert.match(
        messages.variationMessage({
            title: "A",
            id: "a",
            group: "hero",
            others: [{ id: "b" }, { id: "c" }],
        }),
        /\(`b`, `c`\) stay as they are/,
    );
});

test("pins are the open comments made on the version shown, in order", () => {
    const list = [
        { id: "a", version: 2 },
        { id: "b", version: 3, resolved: { by: "x", at: 1 } },
        { id: "c", version: 3 },
        { id: "d", version: 3 },
    ];

    assert.deepEqual(
        comments.openOf(list).map((each: { id: string }) => each.id),
        ["a", "c", "d"],
    );
    assert.deepEqual(
        comments.pinsOf(list, 3).map((each: { id: string }) => each.id),
        ["c", "d"],
    );
    assert.equal(comments.pinNumber(list, list[3], 3), 2);
    assert.equal(comments.pinNumber(list, list[1], 3), 0);
    assert.equal(comments.pinNumber(list, list[0], 3), 0);
});

test("the designs of a session: the app's live list, with groups and kinds from the server, newest first", () => {
    const live = {
        artifacts: [
            {
                id: "old",
                title: "Old",
                type: "html",
                versions: [{ version: 1, size: 5, createdAt: 10 }],
            },
            {
                id: "text",
                title: "Notes",
                type: "markdown",
                versions: [{ version: 1, size: 5, createdAt: 50 }],
            },
            {
                id: "new",
                title: "New",
                type: "html",
                versions: [
                    { version: 1, size: 5, createdAt: 20 },
                    { version: 2, size: 5, createdAt: 90 },
                ],
            },
        ],
    };
    const listed = [
        { id: "new", group: "g", kind: "deck", versions: [{ version: 2, restoredFrom: 1 }] },
        { id: "old", group: "g", kind: "page", versions: [] },
    ];
    const list = data.designsOf(live, listed);

    assert.deepEqual(
        list.map((each: { id: string }) => each.id),
        ["new", "old"],
    );
    assert.equal(list[0].kind, "deck");
    assert.equal(list[0].versions[1].restoredFrom, 1);
    assert.deepEqual(
        data.siblingsOf(list, list[0]).map((each: { id: string }) => each.id),
        ["new", "old"],
    );
    assert.deepEqual(data.siblingsOf(list, { id: "x" }), []);
    // Before the server's list comes, the app's own is enough.
    assert.equal(data.designsOf(live, null)[0].kind, "page");
    assert.equal(data.latestOf(list[0]), 2);
});

test("how long ago, short", () => {
    const now = 1_000_000_000_000;

    assert.equal(parts.ago(now - 10_000, now), "now");
    assert.equal(parts.ago(now - 5 * 60_000, now), "5m ago");
    assert.equal(parts.ago(now - 3 * 3_600_000, now), "3h ago");
    assert.equal(parts.ago(now - 2 * 86_400_000, now), "2d ago");
});
