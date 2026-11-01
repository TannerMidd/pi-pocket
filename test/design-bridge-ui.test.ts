// Design mode's bridge (stream B of docs/design/design-mode.md), in a real Chromium: a design page in the artifact
// sandbox, with the app's side of the bridge on it. Inspect picks an element and the page's own handler does not run;
// text edit makes text editable and reports a change; tweaks go in as custom properties and events and the manifest
// comes out; pins show and clear; a deck shows one slide at a time with keys and swipes; each mode leaves the page as it
// was; and what the page sends is checked, and cannot be forged by the page itself.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import { ARTIFACT_INSPECT, isDeckPage, withDeck } from "../src/server/http/artifact-inspect.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** The page's side of the test: answers `dump`, `count`, `swipe`, and `forge` from the test page. */
const TEST_HOOKS = `<script>
window.clicked = 0;
window.tweaks = [];
addEventListener("pocket:tweak", (event) => tweaks.push(event.detail));
addEventListener("pocket:slide", (event) => (window.lastSlide = event.detail));
const rectOf = (selector) => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    return box && { x: box.x, y: box.y, width: box.width, height: box.height };
};
addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data.id !== "string") return;
    const root = getComputedStyle(document.documentElement);
    if (data.type === "dump") {
        parent.postMessage({
            id: data.id,
            html: document.documentElement.outerHTML,
            clicked, tweaks,
            accent: root.getPropertyValue("--accent").trim(),
            radius: root.getPropertyValue("--radius").trim(),
            overlay: document.querySelector("pocket-overlay") !== null,
            rects: { title: rectOf("#t"), go: rectOf("#go"), lead: rectOf(".lead"), li: rectOf("li:nth-child(3)") },
            slides: [...document.querySelectorAll("section.slide")].map((slide) => {
                const box = slide.getBoundingClientRect();
                return { shown: getComputedStyle(slide).display !== "none", width: Math.round(box.width) };
            }),
            lastSlide: window.lastSlide,
        }, "*");
    } else if (data.type === "count") {
        let count = -1;
        try { count = document.querySelectorAll(data.selector).length; } catch {}
        parent.postMessage({ id: data.id, count }, "*");
    } else if (data.type === "swipe") {
        const touch = (x) => new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 100 });
        document.body.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch(300)], changedTouches: [touch(300)] }));
        document.body.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [touch(300 + data.dx)] }));
        parent.postMessage({ id: data.id }, "*");
    } else if (data.type === "forge") {
        parent.postMessage({ type: "pocket-picked", target: { selector: "body", tag: "body", text: "forged", html: "", rect: { x: 0, y: 0, width: 1, height: 1 }, styles: {} } }, "*");
        parent.postMessage({ type: "pocket-deck", slides: 9, current: 3 }, "*");
        parent.postMessage({ id: data.id }, "*");
    }
});
</script>`;

const DESIGN = `<!doctype html><html><head><meta charset="utf-8"><title>Design</title>
<style>:root{--accent:#3366ff;--radius:8px}body{font:16px system-ui;margin:0;padding:20px}h1{color:var(--accent)}.card{border-radius:var(--radius);padding:12px;background:#eef}</style></head>
<body><h1 id="t" data-pid="title">Hello world</h1>
<div class="card" data-pid="card"><p class="lead">Lead text <b>bold</b></p><button id="go" data-pid="cta">Buy now</button></div>
<ul><li>One</li><li>Two</li><li>Two</li></ul>
<a href="https://example.com/away" id="away">A link</a>
<script type="application/json" id="pocket-tweaks">[
{"name":"--accent","label":"Accent","type":"color","value":"#3366ff"},
{"name":"--radius","label":"Radius","type":"range","value":8,"min":0,"max":32,"step":1,"unit":"px"},
{"name":"dark","type":"toggle","value":false},
{"name":"mood","type":"select","value":"calm","options":["calm","loud",{"value":"odd"}]},
{"name":"","type":"text","value":"dropped"}
]</script>
<script>document.getElementById("go").onclick = () => { window.clicked += 1; };</script>
${TEST_HOOKS}</body></html>`;

const LONG = `<!doctype html><html><head><meta charset="utf-8"><title>Long</title>
<style>body{font:16px/1.5 system-ui;margin:0}p{margin:0;padding:0 40px}</style></head>
<body>${Array.from({ length: 160 }, (_, at) => `<p data-pid="p${at}">Row ${at}: boarding opens at nine, and the ferry leaves on the hour.</p>`).join("")}
<script>
window.hits = 0;
const hitTest = document.elementsFromPoint.bind(document);
document.elementsFromPoint = (x, y) => { window.hits += 1; return hitTest(x, y); };
addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "pinwork" || typeof data.id !== "string") return;
    if (data.reset) { window.hits = 0; }
    if (data.scroll) { scrollBy(0, data.scroll); }
    parent.postMessage({ id: data.id, hits: window.hits, scrollY: scrollY }, "*");
});
</script></body></html>`;

const PINS = `<!doctype html><html><head><meta charset="utf-8"><title>Pins</title>
<style>body{margin:0;height:1500px}#target{position:absolute;left:200px;top:700px;width:120px;height:40px;background:#cde}</style></head>
<body><div id="target" data-pid="target">Target</div>
${TEST_HOOKS}</body></html>`;

const DECK = `<!doctype html><html><head><meta charset="utf-8"><title>Deck</title><meta name="pocket-kind" content="deck">
<style>body{margin:8px}.slide{width:1920px;max-width:100%;min-width:10px;height:1080px;background:#123;color:#fff;font-size:80px}</style></head>
<body><section class="slide"><h1>One</h1></section><section class="slide"><h1>Two</h1></section><section class="slide"><h1>Three</h1></section>
${TEST_HOOKS}</body></html>`;

/** Replaces addEventListener at once to collect every handler, then calls them all with an invented trusted click. */
const INTERCEPT = `<!doctype html><html><body><h1 id="t">Hi</h1><script>
const stolen = [];
const original = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (type, handler, options) {
    stolen.push([type, handler]);
    return original.call(this, type, handler, options);
};
addEventListener("message", (event) => {
    if (!event.data || event.data.type !== "steal") return;
    const fake = { isTrusted: true, type: "click", target: document.body, preventDefault() {}, stopImmediatePropagation() {} };
    for (const [, handler] of stolen) { try { handler(fake); } catch {} }
    parent.postMessage({ id: event.data.id, stolen: stolen.length }, "*");
});
</script></body></html>`;

/** A slow script holds up the parser; the app speaks before the page is there. */
const SLOW_PAGE = (
    src: string,
) => `<!doctype html><html><head><meta charset="utf-8"><title>Slow</title>
<script src="${src}"></script></head><body><h1 id="t" data-pid="title">Late title</h1>
<script type="application/json" id="pocket-tweaks">[{"name":"--radius","type":"range","value":8,"unit":"px"}]</script>
${TEST_HOOKS}</body></html>`;

/** A deck that hides all its slides but the first itself, and lays them out as flex. */
const HIDDEN_DECK = `<!doctype html><html><head><meta charset="utf-8"><meta name="pocket-kind" content="deck">
<style>.slide{display:flex;align-items:center}.slide:not(:first-child){display:none}</style>
<title>Hidden deck</title></head><body>
<section class="slide">One</section><section class="slide">Two</section><section class="slide">Three</section>
</body></html>`;

/** A deck whose slides carry the usual width limits, under a policy that allows no style but the page's own and requires Trusted Types. */
const CSP_DECK = `<!doctype html><html><head><meta charset="utf-8"><meta name="pocket-kind" content="deck">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'none'; require-trusted-types-for 'script'">
<title>CSP deck</title></head><body>
<section class="slide">A</section><section class="slide">B</section>
${TEST_HOOKS}</body></html>`;

const CSP_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'none'; require-trusted-types-for 'script'">
<title>CSP page</title></head><body><h1 id="t">Policy</h1>${TEST_HOOKS}</body></html>`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;
let calls = 0;
let late: Server;
let lateBase = "";
const SLOW = 30_000;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function publish(id: string, content: string) {
    await createArtifacts({} as PocketHost).tools![0]!.execute(
        { id, title: id, content } as never,
        {
            conversationId: session,
            taskId: 9100 + (calls += 1),
            callId: "publish",
            agent: async () => ({ cwd: work }),
            snapshot: app.harness.snapshot.bind(app.harness),
            commit: app.harness.commit.bind(app.harness),
        } as never,
        context,
    );
}

type Dump = {
    html: string;
    clicked: number;
    tweaks: { name: string; value: unknown }[];
    accent: string;
    radius: string;
    overlay: boolean;
    rects: Record<string, { x: number; y: number; width: number; height: number } | null>;
    slides: { shown: boolean; width: number }[];
    lastSlide?: { index: number; count: number };
};

/** Open a design in a frame over the app's page, with the bridge on it, as the workspace will. Messages pile up in `__got`. */
async function openDesign(id: string, queued?: object[]) {
    await inPage(`
        document.querySelector("#design-frame")?.remove();
        const { attachBridge, sendToFrame } = await import("/artifact-bridge.js");
        const frame = document.createElement("iframe");
        frame.id = "design-frame";
        frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads");
        frame.style.cssText = "position:fixed;left:0;top:0;width:800px;height:600px;border:0;z-index:99999;background:#fff";
        window.__got = [];
        window.__ready = 0;
        window.__bridge = attachBridge({ current: frame }, {
            artifact: ${JSON.stringify(id)},
            source: "the design",
            onMessage: (message) => window.__got.push(message),
            onReady: () => (window.__ready += 1),
        });
        document.body.append(frame);
        window.__frame = frame;
        window.__send = (message) => __bridge.send(message);
        for (const message of ${JSON.stringify(queued ?? [])}) {
            if (!sendToFrame(frame, message)) throw new Error("refused " + JSON.stringify(message));
        }
        frame.src = "/a/${session}/${id}/latest";
        return "null";
    `);
    await until(
        async () => (await inPage<number>(`return JSON.stringify(window.__ready)`)) === 1,
        "the page's line",
        SLOW,
    );
}

const send = (message: object) =>
    inPage<boolean>(`return JSON.stringify(__send(${JSON.stringify(message)}))`);

const got = () => inPage<{ type: string; [key: string]: any }[]>(`return JSON.stringify(__got)`);

const gotOf = async (type: string) => (await got()).filter((message) => message.type === type);

/** Ask the page something (`dump`, `count`, ...) and wait for its answer. */
async function ask<T>(message: object): Promise<T> {
    return inPage<T>(`
        const id = String(Math.random());
        const answer = new Promise((resolve) => {
            addEventListener("message", function hear(event) {
                if (event.source === __frame.contentWindow && event.data && event.data.id === id) {
                    removeEventListener("message", hear);
                    resolve(event.data);
                }
            });
        });
        __frame.contentWindow.postMessage({ ...${JSON.stringify(message)}, id }, "*");
        return JSON.stringify(await answer);
    `);
}

const dump = () => ask<Dump>({ type: "dump" });
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

/** The page as the test left it, without what the test's own hooks hold (the events they collected). */
const bare = (html: string) => html;

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    ({ id: session } = await app.commands.createSession(owner(app), { cwd: work }));
    await publish("design", DESIGN);
    await publish("deck", DECK);
    await publish("long", LONG);
    await publish("pins", PINS);
    await publish("intercept", INTERCEPT);
    await publish("cspdeck", CSP_DECK);
    await publish("csppage", CSP_PAGE);
    await publish("hiddendeck", HIDDEN_DECK);
    late = createServer((_request, response) => {
        setTimeout(
            () => response.writeHead(200, { "content-type": "text/javascript" }).end(""),
            700,
        );
    });
    await new Promise<void>((resolve) => late.listen(0, "127.0.0.1", resolve));
    lateBase = `http://127.0.0.1:${(late.address() as { port: number }).port}`;
    await publish("slow", SLOW_PAGE(`${lateBase}/late.js`));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "design-bridge-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".composer textarea")))`,
            ),
        "the message box",
        SLOW,
    );
});

after(async () => {
    late?.closeAllConnections();
    late?.close();
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("the page side is a script that parses, and a deck is told by its meta", () => {
    assert.doesNotThrow(() => new Function(`return ${ARTIFACT_INSPECT}`));
    assert.ok(!ARTIFACT_INSPECT.includes("`"), "no backtick: it sits in a template string");
    assert.ok(!ARTIFACT_INSPECT.includes("</script"));
    assert.ok(isDeckPage('<meta name="pocket-kind" content="deck">'));
    assert.ok(isDeckPage("<meta content='deck' name='pocket-kind'>"));
    assert.ok(!isDeckPage('<meta name="pocket-kind" content="page">'));
    assert.ok(!isDeckPage("<p>pocket-kind deck</p>"));
    assert.equal(withDeck("<p>hi</p>"), "<p>hi</p>", "another page stays as written");

    const deck = withDeck('<!doctype html><meta name="pocket-kind" content="deck"><p>x</p>');

    assert.match(deck, /^<!doctype html><script>/);
    assert.ok(deck.endsWith('<meta name="pocket-kind" content="deck"><p>x</p>'));
});

test(
    "the page's tweaks manifest comes out, and what waited for the line goes in first",
    real,
    async () => {
        await openDesign("design", [
            { type: "pocket-tweak-set", values: { "--accent": "#00ff00" } },
            { type: "pocket-tweak-set", values: { "--radius": 3 } },
        ]);
        await until(async () => (await gotOf("pocket-tweaks")).length === 1, "the manifest", SLOW);

        const message = (await gotOf("pocket-tweaks"))[0]!;

        assert.deepEqual(
            message.knobs.map((knob: { name: string }) => knob.name),
            ["--accent", "--radius", "dark", "mood"],
            "the knob with no name is dropped",
        );
        assert.deepEqual(message.knobs[1], {
            name: "--radius",
            label: "Radius",
            type: "range",
            value: 8,
            min: 0,
            max: 32,
            step: 1,
            unit: "px",
        });
        assert.deepEqual(message.knobs[3].options, ["calm", "loud", "odd"]);

        const seen = await dump();

        assert.equal(seen.accent, "#00ff00", "the first word said before the line opened");
        assert.equal(seen.radius, "3px", "a number gets the knob's unit");
        assert.equal(seen.overlay, false);
        await send({ type: "pocket-tweak-set", values: { "--accent": null, "--radius": null } });
    },
);

test(
    "inspect picks an element, the page's handler does not run, and it leaves the page as it was",
    real,
    async () => {
        await openDesign("design");

        const before = await dump();

        assert.equal(await send({ type: "pocket-inspect", on: true }), true);
        await settle();

        const go = before.rects.go!;
        const click = { x: Math.round(go.x + go.width / 2), y: Math.round(go.y + go.height / 2) };

        await page.click(click);
        await until(async () => (await gotOf("pocket-picked")).length === 1, "the pick", SLOW);

        const picked = (await gotOf("pocket-picked"))[0]!;

        assert.equal(picked.target.tag, "button");
        assert.equal(picked.target.pid, "cta");
        assert.equal(picked.target.selector, "#go");
        assert.equal(picked.target.text, "Buy now");
        assert.match(picked.target.html, /^<button id="go" data-pid="cta">Buy now<\/button>$/);
        assert.ok(Math.abs(picked.target.rect.x - go.x) < 1 && picked.target.rect.width > 20);
        assert.deepEqual(Object.keys(picked.target.styles).sort(), [
            "background-color",
            "border-radius",
            "color",
            "font-family",
            "font-size",
            "font-weight",
            "gap",
            "line-height",
            "margin",
            "padding",
        ]);
        assert.equal((await dump()).clicked, 0, "the page's own click handler did not run");
        assert.equal((await dump()).overlay, true, "the pick is outlined");

        // The third list item has no id: its selector is short, and it names that item alone.
        const li = before.rects.li!;

        await page.click({ x: Math.round(li.x + 5), y: Math.round(li.y + li.height / 2) });
        await until(
            async () => (await gotOf("pocket-picked")).length === 2,
            "the second pick",
            SLOW,
        );

        const second = (await gotOf("pocket-picked"))[1]!;

        assert.equal(second.target.tag, "li");
        assert.equal(
            (await ask<{ count: number }>({ type: "count", selector: second.target.selector }))
                .count,
            1,
        );
        assert.ok(second.target.selector.length < 80, second.target.selector);

        // A link does not go anywhere while inspecting.
        const away = await page.evaluate(`return JSON.stringify(location.href)`);

        assert.equal(JSON.parse(away), `${base}/s/${session}`);

        await send({ type: "pocket-inspect", on: false });
        await settle();
        assert.equal(bare((await dump()).html), bare(before.html), "the page is as it was");
        assert.equal((await dump()).overlay, false);

        await page.click(click);
        await until(async () => (await dump()).clicked === 1, "its own handler again", SLOW);
        assert.equal((await gotOf("pocket-picked")).length, 2, "nothing picked once off");
    },
);

test(
    "text edit makes text editable, reports a change, blocks the page's clicks, and restores the page",
    real,
    async () => {
        await openDesign("design");

        const before = await dump();
        const title = before.rects.title!;
        const at = { x: Math.round(title.x + 20), y: Math.round(title.y + title.height / 2) };

        assert.equal(await send({ type: "pocket-edit-text", on: true }), true);
        await settle();
        assert.match((await dump()).html, /contenteditable="plaintext-only"/);
        assert.match(
            (await dump()).html,
            /<h1 id="t" data-pid="title" contenteditable="plaintext-only"/,
        );

        await page.input([
            { type: "click", ...at },
            { type: "key", key: "a", modifiers: 2 },
            { type: "text", text: "Hi there" },
            { type: "key", key: "Enter" },
        ]);
        await until(async () => (await gotOf("pocket-text-edited")).length === 1, "the edit", SLOW);

        const edit = (await gotOf("pocket-text-edited"))[0]!;

        assert.equal(edit.before, "Hello world");
        assert.equal(edit.after, "Hi there");
        assert.equal(edit.target.pid, "title");
        assert.equal(edit.target.selector, "#t");
        assert.equal(
            edit.target.html,
            '<h1 id="t" data-pid="title">Hi there</h1>',
            "the editing attributes are not in the html",
        );

        // The button's text is editable, and its click does not run.
        const go = before.rects.go!;

        await page.click({
            x: Math.round(go.x + go.width / 2),
            y: Math.round(go.y + go.height / 2),
        });
        assert.equal((await dump()).clicked, 0, "no click handler while editing");

        // Typing again and putting the old words back is reported too, against the first words.
        await page.input([
            { type: "click", ...at },
            { type: "key", key: "a", modifiers: 2 },
            { type: "text", text: "Hello world" },
            { type: "key", key: "Enter" },
        ]);
        await until(
            async () => (await gotOf("pocket-text-edited")).length === 2,
            "the second edit",
            SLOW,
        );
        assert.equal((await gotOf("pocket-text-edited"))[1]?.after, "Hello world");
        assert.equal((await gotOf("pocket-text-edited"))[1]?.before, "Hello world");

        await send({ type: "pocket-edit-text", on: false });
        await settle();

        const after = await dump();

        assert.equal(
            after.html,
            before.html,
            "the page is as it was: text back, no attributes left",
        );
        assert.equal(after.overlay, false);
    },
);

test("text edit in a deck also reaches the slide that comes into view", real, async () => {
    await openDesign("deck");
    await until(async () => (await gotOf("pocket-deck")).length >= 1, "the deck's slides", SLOW);

    const editable = async (selector: string) =>
        (await ask<{ count: number }>({ type: "count", selector })).count;

    await send({ type: "pocket-edit-text", on: true });
    await settle();
    await send({ type: "pocket-goto", slide: 1 });
    await settle();
    assert.equal(await editable("section.slide:nth-child(2) [contenteditable]"), 1);
    await send({ type: "pocket-edit-text", on: false });
    await settle();
    assert.equal(await editable("[contenteditable]"), 0);
});

test(
    "tweaks set custom properties and fire events; bad values are refused in the app",
    real,
    async () => {
        await openDesign("design");
        await until(async () => (await gotOf("pocket-tweaks")).length === 1, "the manifest", SLOW);
        assert.equal(
            await send({
                type: "pocket-tweak-set",
                values: { "--accent": "#ff0000", "--radius": 12, dark: true, "--pad": "4px" },
            }),
            true,
        );
        await settle();

        const seen = await dump();

        assert.equal(seen.accent, "#ff0000");
        assert.equal(seen.radius, "12px");
        assert.deepEqual(seen.tweaks, [
            { name: "--accent", value: "#ff0000" },
            { name: "--radius", value: 12 },
            { name: "dark", value: true },
            { name: "--pad", value: "4px" },
        ]);

        assert.equal(
            await send({ type: "pocket-tweak-set", values: { "--bad name": "x" } }),
            false,
        );
        assert.equal(await send({ type: "pocket-tweak-set", values: { "--x": { a: 1 } } }), false);
        assert.equal(await send({ type: "pocket-tweak-set", values: "x" }), false);
        assert.equal(await send({ type: "pocket-nothing" }), false);
        assert.equal(await send({ type: "pocket-inspect", on: "yes" }), false);

        // A boolean for a custom property is 1 or 0.
        await send({ type: "pocket-tweak-set", values: { "--flag": true } });
        await settle();
        assert.match((await dump()).html, /--flag: 1/);
    },
);

test("pins show for a list of targets and clear on an empty list", real, async () => {
    await openDesign("design");

    const before = await dump();

    assert.equal(
        await send({
            type: "pocket-highlight",
            targets: [
                { selector: "#t" },
                { selector: "li:nth-child(3)", label: "B" },
                { selector: ".gone", pid: "cta" },
            ],
        }),
        true,
    );
    await settle();
    assert.equal((await dump()).overlay, true);

    await send({ type: "pocket-highlight", targets: [] });
    await settle();
    assert.equal((await dump()).overlay, false);
    assert.equal((await dump()).html, before.html, "no trace");
    assert.equal(await send({ type: "pocket-highlight", targets: [{}] }), false);
    assert.equal(
        await send({ type: "pocket-highlight", targets: Array(101).fill({ selector: "p" }) }),
        false,
    );
});

test(
    "pins are placed once, and a scroll or a quiet page does not look at the page again",
    real,
    async () => {
        await openDesign("long");

        const work = (extra: object = {}) =>
            ask<{ hits: number; scrollY: number }>({ type: "pinwork", ...extra });

        assert.equal(
            await send({
                type: "pocket-highlight",
                targets: Array.from({ length: 100 }, (_, at) => ({
                    selector: `[data-pid="p${at}"]`,
                    label: at + 1,
                })),
            }),
            true,
        );
        await settle();
        await settle();
        assert.ok((await work()).hits > 0, "the pins in view were given a place");

        const quiet = await work({ reset: true });

        assert.equal(quiet.hits, 0);
        await settle();
        assert.equal((await work()).hits, 0, "a quiet page costs no hit tests");

        const before = await work({ reset: true });

        assert.equal(before.hits, 0);

        await work({ scroll: 5 });
        await settle();

        const scrolled = await work();

        assert.equal(scrolled.scrollY, 5);
        assert.ok(
            scrolled.hits <= 12,
            "a small scroll finds a place only for the pins that reach the edge",
        );

        await send({ type: "pocket-highlight", targets: [] });
    },
);

test(
    "a tap on a pin is told to the app, and a pin asked to come into view says where its element is",
    real,
    async () => {
        await openDesign("pins");
        await send({ type: "pocket-highlight", targets: [{ selector: "#target", label: 7 }] });
        await settle();
        await settle();

        // The page is scrolled to the top: the element is below the frame's fold, so bring it in first.
        await send({
            type: "pocket-highlight",
            targets: [{ selector: "#target", label: 7, reveal: true }],
        });
        await until(
            async () => (await gotOf("pocket-pin")).some((each) => each.rect !== undefined),
            "where the element is",
            SLOW,
        );

        const told = (await gotOf("pocket-pin")).find((each) => each.rect !== undefined)!;

        assert.equal(told.label, "7");
        assert.ok(Math.abs(told.rect.y + told.rect.height / 2 - 300) < 3, JSON.stringify(told));
        assert.equal(told.rect.x, 200);
        assert.equal(told.rect.width, 120);

        await settle();

        const above = told.rect.y - 22 - 3;

        await page.click({ x: told.rect.x + 11, y: above + 11 });
        await until(
            async () => (await gotOf("pocket-pin")).some((each) => each.tap === true),
            "the tap",
            SLOW,
        );
        assert.deepEqual(
            (await gotOf("pocket-pin")).find((each) => each.tap === true),
            { type: "pocket-pin", label: "7", tap: true },
        );

        assert.equal((await dump()).clicked, 0);
        await send({ type: "pocket-highlight", targets: [] });
    },
);

test(
    "a deck shows one slide at a time, scaled to fit, with keys, swipes, and goto",
    real,
    async () => {
        await openDesign("deck");
        await until(
            async () => (await gotOf("pocket-deck")).length >= 1,
            "the deck's slides",
            SLOW,
        );
        assert.deepEqual((await gotOf("pocket-deck"))[0], {
            type: "pocket-deck",
            slides: 3,
            current: 0,
        });

        // The frame may not have its size the moment its page starts: wait for the slide to fit it.
        await until(
            async () => Math.abs((await dump()).slides[0]!.width - 800) <= 1,
            "the slide scaled to the frame",
            SLOW,
        );

        const first = await dump();

        assert.deepEqual(
            first.slides.map((slide) => slide.shown),
            [true, false, false],
        );
        // The frame is 800 wide: 1920 scaled to fit 800 by 600 is 800.
        assert.ok(Math.abs(first.slides[0]!.width - 800) <= 1, String(first.slides[0]!.width));

        await page.click({ x: 400, y: 300 });
        await page.press("ArrowRight");
        await until(
            async () => (await gotOf("pocket-deck")).at(-1)?.current === 1,
            "next by key",
            SLOW,
        );
        assert.deepEqual(
            (await dump()).slides.map((slide) => slide.shown),
            [false, true, false],
        );
        assert.deepEqual((await dump()).lastSlide, { index: 1, count: 3 });

        assert.equal(await send({ type: "pocket-goto", slide: 2 }), true);
        await until(async () => (await gotOf("pocket-deck")).at(-1)?.current === 2, "goto", SLOW);

        await ask({ type: "swipe", dx: 120 });
        await until(
            async () => (await gotOf("pocket-deck")).at(-1)?.current === 1,
            "back by swipe",
            SLOW,
        );
        await ask({ type: "swipe", dx: -120 });
        await until(
            async () => (await gotOf("pocket-deck")).at(-1)?.current === 2,
            "forward by swipe",
            SLOW,
        );
        await ask({ type: "swipe", dx: -120 });
        await settle();
        assert.equal((await gotOf("pocket-deck")).at(-1)?.current, 2, "the last slide stays");
        assert.equal(await send({ type: "pocket-goto", slide: -1 }), false);
        assert.equal(await send({ type: "pocket-goto", slide: 1.5 }), false);

        await page.press("Home");
        await until(async () => (await gotOf("pocket-deck")).at(-1)?.current === 0, "home", SLOW);
    },
);

test("a deck in a tab of its own also shows one slide at a time", real, async () => {
    await page.navigate(`${base}/a/${session}/deck/latest`);
    await until(
        async () =>
            (await inPage<number>(
                `return JSON.stringify([...document.querySelectorAll("section.slide")].filter((slide) => getComputedStyle(slide).display !== "none").length)`,
            )) === 1,
        "one slide shown",
        SLOW,
    );
    await page.click({ x: 300, y: 300 });
    await page.press("ArrowRight");
    await until(
        async () =>
            (await inPage<string>(
                `return JSON.stringify(document.querySelector("section.slide[data-pocket-current]")?.textContent)`,
            )) === "Two",
        "the second slide",
        SLOW,
    );
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".composer textarea")))`,
            ),
        "the message box",
        SLOW,
    );
});

test(
    "a deck that hides its own slides still shows the current one, in its own layout",
    real,
    async () => {
        await page.navigate(`${base}/a/${session}/hiddendeck/latest`);
        const shown = () =>
            inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll("section.slide")].filter((slide) => getComputedStyle(slide).display !== "none").map((slide) => slide.textContent + ":" + getComputedStyle(slide).display))`,
            );

        await until(async () => (await shown()).join() === "One:flex", "the first slide", SLOW);
        await page.click({ x: 300, y: 300 });
        await page.press("ArrowRight");
        await until(async () => (await shown()).join() === "Two:flex", "the second slide", SLOW);
        await page.press("ArrowLeft");
        await until(async () => (await shown()).join() === "One:flex", "back to the first", SLOW);
        // The second slide got its own inline display back.
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelectorAll("section.slide")[1].style.display)`,
            ),
            "",
        );
        await page.navigate(`${base}/s/${session}`);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(Boolean(document.querySelector(".composer textarea")))`,
                ),
            "the message box",
            SLOW,
        );
    },
);

test("the page cannot send the inspector's messages itself", real, async () => {
    await openDesign("design");
    await until(async () => (await gotOf("pocket-tweaks")).length === 1, "the manifest", SLOW);
    await ask({ type: "forge" });
    await settle();
    assert.equal((await gotOf("pocket-picked")).length, 0);
    assert.equal((await gotOf("pocket-deck")).length, 0);
});

test("what a page says is checked for its shape and length", real, async () => {
    const check = (call: string) =>
        inPage<unknown>(`
            const bridge = await import("/artifact-bridge.js");
            return JSON.stringify(${call});
        `);
    const target = {
        pid: "hero",
        selector: "main > h1",
        tag: "H1",
        text: "x".repeat(300),
        html: "y".repeat(1500),
        rect: { x: 1, y: 2, width: 3, height: 4 },
        styles: { color: "red", "font-size": "z".repeat(300), evil: "1", margin: 5 },
        extra: "dropped",
    };
    const picked = (await check(
        `bridge.checkPageMessage({ type: "pocket-picked", target: ${JSON.stringify(target)}, more: 1 })`,
    )) as { target: any } & Record<string, unknown>;

    assert.deepEqual(Object.keys(picked), ["type", "target"]);
    assert.equal(picked.target.tag, "h1");
    assert.equal(picked.target.text.length, 200);
    assert.equal(picked.target.html.length, 1000);
    assert.deepEqual(Object.keys(picked.target.styles), ["color", "font-size"]);
    assert.equal(picked.target.styles["font-size"].length, 200);
    assert.equal(picked.target.extra, undefined);

    const bad = (patch: object) =>
        check(
            `bridge.checkPageMessage({ type: "pocket-picked", target: ${JSON.stringify({ ...target, ...patch })} })`,
        );

    assert.equal(await bad({ selector: "a".repeat(501) }), null);
    assert.equal(await bad({ selector: "" }), null);
    assert.equal(await bad({ tag: "<script>" }), null);
    assert.equal(await bad({ text: 5 }), null);
    assert.equal(await bad({ rect: { x: 1, y: 2, width: "3", height: 4 } }), null);
    assert.equal(await bad({ rect: { x: 1, y: 2, width: null, height: 4 } }), null);
    assert.equal(await check(`bridge.checkPageMessage({ type: "pocket-picked" })`), null);
    assert.equal(
        await check(`bridge.checkPageMessage({ type: "pocket-follow-up", text: "x" })`),
        null,
    );
    assert.equal(await check(`bridge.checkPageMessage("pocket-picked")`), null);
    assert.equal(await check(`bridge.checkPageMessage(null)`), null);

    const edit = (before: string, after: string) =>
        check(
            `bridge.checkPageMessage({ type: "pocket-text-edited", target: ${JSON.stringify(target)}, before: ${JSON.stringify(before)}, after: ${JSON.stringify(after)} })`,
        );

    assert.ok(await edit("a".repeat(2000), "b"));
    assert.equal(await edit("a".repeat(2001), "b"), null);
    assert.equal(await edit("a", "b".repeat(2001)), null);

    const knobs = Array.from({ length: 45 }, (_, index) => ({
        name: `k${index % 43}`,
        type: "range",
        value: index,
    }));
    const tweaks = (await check(
        `bridge.checkPageMessage({ type: "pocket-tweaks", knobs: ${JSON.stringify([...knobs, { name: "x", type: "wrong", value: 1 }, { name: "y", type: "text", value: { a: 1 } }])} })`,
    )) as { knobs: unknown[] };

    assert.equal(tweaks.knobs.length, 40, "at most 40, and a repeated name once");
    assert.equal(
        (await check(`bridge.checkPageMessage({ type: "pocket-tweaks", knobs: "no" })`)) as null,
        null,
    );

    const deck = (slides: unknown, current: unknown) =>
        check(
            `bridge.checkPageMessage({ type: "pocket-deck", slides: ${JSON.stringify(slides)}, current: ${JSON.stringify(current)} })`,
        );

    assert.ok(await deck(3, 2));
    assert.equal(await deck(3, 3), null);
    assert.equal(await deck(3, -1), null);
    assert.equal(await deck(1001, 0), null);
    assert.equal(await deck("3", 0), null);
    assert.equal(await deck(3, 0.5), null);

    const pin = (body: object) =>
        check(`bridge.checkPageMessage({ type: "pocket-pin", ...${JSON.stringify(body)} })`);

    assert.deepEqual(await pin({ label: "7", tap: true, extra: 1 }), {
        type: "pocket-pin",
        label: "7",
        tap: true,
    });
    assert.deepEqual(
        await pin({ label: "7", rect: { x: 1, y: 2, width: 3, height: 4, more: 5 } }),
        { type: "pocket-pin", label: "7", rect: { x: 1, y: 2, width: 3, height: 4 } },
    );
    assert.equal(await pin({ label: "7" }), null, "neither a tap nor a place");
    assert.equal(await pin({ label: "toolongalabel", tap: true }), null);
    assert.equal(await pin({ tap: true }), null);
    assert.equal(await pin({ label: "7", rect: { x: "1", y: 2, width: 3, height: 4 } }), null);
    assert.equal(await pin({ label: "7", rect: { x: 1, y: 2, width: 3 } }), null);
    assert.equal(await pin({ label: "7", rect: { x: 1e9, y: 2, width: 3, height: 4 } }), null);
});

test("the app's own messages are checked before they go", real, async () => {
    const check = (message: object) =>
        inPage<{ error?: string; message?: unknown }>(`
            const bridge = await import("/artifact-bridge.js");
            return JSON.stringify(bridge.checkAppMessage(${JSON.stringify(message)}));
        `);

    assert.deepEqual((await check({ type: "pocket-inspect", on: true, extra: 1 })).message, {
        type: "pocket-inspect",
        on: true,
    });
    assert.ok((await check({ type: "pocket-inspect" })).error);
    assert.ok((await check({ type: "pocket-goto", slide: 1001 })).error);
    assert.ok((await check({ type: "pocket-tweak-set", values: { "--a-b_1": "1px" } })).message);
    assert.ok((await check({ type: "pocket-tweak-set", values: { "--": "1px" } })).error);
    assert.ok((await check({ type: "pocket-tweak-set", values: { x: "y".repeat(201) } })).error);
    assert.ok(
        (await check({ type: "pocket-highlight", targets: [{ selector: "p", label: 3 }] })).message,
    );
    assert.ok(
        (
            await check({
                type: "pocket-highlight",
                targets: [{ selector: "p", label: "toolonglabel" }],
            })
        ).error,
    );
    assert.ok((await check({ type: "pocket-run", html: "<p>" })).error);
    assert.ok(
        (await check({ type: "pocket-highlight", targets: [{ selector: "p", reveal: true }] }))
            .message,
    );
    assert.ok(
        (await check({ type: "pocket-highlight", targets: [{ selector: "p", reveal: "yes" }] }))
            .error,
    );
});

test(
    "HTML run in the run frame, which wipes its document, still gets the design side",
    real,
    async () => {
        const html = `<!doctype html><html><head><meta name="pocket-kind" content="deck"></head><body>
        <section class="slide">A</section><section class="slide">B</section>
        <script type="application/json" id="pocket-tweaks">[{"name":"--x","type":"text","value":"1"}]</script></body></html>`;

        await inPage(`
        document.querySelector("#design-frame")?.remove();
        const { attachBridge } = await import("/artifact-bridge.js");
        const frame = document.createElement("iframe");
        frame.id = "design-frame";
        frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads");
        frame.style.cssText = "position:fixed;left:0;top:0;width:800px;height:600px;border:0;z-index:99999;background:#fff";
        window.__got = [];
        window.__bridge = attachBridge({ current: frame }, {
            source: "a reply",
            onMessage: (message) => window.__got.push(message),
        });
        window.__send = (message) => __bridge.send(message);
        addEventListener("message", function hear(event) {
            if (event.source === frame.contentWindow && event.data?.type === "pocket-run-ready") {
                removeEventListener("message", hear);
                frame.contentWindow.postMessage({ type: "pocket-run", html: ${JSON.stringify(html)} }, "*");
            }
        });
        frame.src = "/a/frame";
        document.body.append(frame);
        window.__frame = frame;
        return "null";
    `);
        await until(
            async () =>
                (await gotOf("pocket-deck")).length >= 1 &&
                (await gotOf("pocket-tweaks")).length === 1,
            "the deck and the manifest of the replaced page",
            SLOW,
        );
        assert.deepEqual((await gotOf("pocket-deck"))[0], {
            type: "pocket-deck",
            slides: 2,
            current: 0,
        });
        assert.equal(await send({ type: "pocket-goto", slide: 1 }), true);
        await until(async () => (await gotOf("pocket-deck")).at(-1)?.current === 1, "goto", SLOW);
    },
);

test(
    "a page that replaces addEventListener cannot get a handler and forge a pick",
    real,
    async () => {
        await openDesign("intercept");
        await send({ type: "pocket-inspect", on: true });
        await send({ type: "pocket-edit-text", on: true });
        await send({ type: "pocket-inspect", on: true });

        const answer = await ask<{ stolen: number }>({ type: "steal" });

        assert.equal(answer.stolen, 1, "only the page's own message handler was ever seen by it");
        await settle();
        assert.equal((await gotOf("pocket-picked")).length, 0);
        assert.equal((await gotOf("pocket-text-edited")).length, 0);
    },
);

test("what the app says before the page is parsed waits for it", real, async () => {
    await openDesign("slow", [
        { type: "pocket-edit-text", on: true },
        { type: "pocket-tweak-set", values: { "--radius": 5 } },
        { type: "pocket-highlight", targets: [{ selector: "#t" }] },
    ]);
    // Its line opens as the page starts; the page is still waiting for its script.
    await until(async () => (await gotOf("pocket-tweaks")).length === 1, "the page parsed", SLOW);
    await settle();

    const seen = await dump();

    assert.match(seen.html, /<h1 id="t" data-pid="title" contenteditable="plaintext-only"/);
    assert.equal(seen.radius, "5px", "the unit of a manifest that was not there yet");
    assert.equal(seen.overlay, true);
});

test(
    "a deck with width limits, and a policy with no style and Trusted Types, still works",
    real,
    async () => {
        await openDesign("cspdeck");
        await until(async () => (await gotOf("pocket-deck")).length >= 1, "the deck", SLOW);

        const seen = await dump();

        assert.ok(Math.abs(seen.slides[0]!.width - 800) <= 1, String(seen.slides[0]!.width));
        assert.deepEqual(
            seen.slides.map((slide) => slide.shown),
            [true, false],
        );

        await openDesign("csppage");
        await send({ type: "pocket-edit-text", on: true });
        await send({ type: "pocket-highlight", targets: [{ selector: "#t" }] });
        await settle();
        assert.match((await dump()).html, /contenteditable="plaintext-only"/);
        assert.equal((await dump()).overlay, true);
        await send({ type: "pocket-edit-text", on: false });
        await send({ type: "pocket-highlight", targets: [] });
        await settle();
        assert.equal((await dump()).overlay, false);
    },
);

test(
    "a run frame that replaces its document gets its modes, pins, and tweaks again",
    real,
    async () => {
        const html = `<!doctype html><html><head><meta name="pocket-kind" content="deck"></head><body><section class="slide"><p id="t">second</p></section>${TEST_HOOKS}</body></html>`;

        await inPage(`
        document.querySelector("#design-frame")?.remove();
        const { attachBridge } = await import("/artifact-bridge.js");
        const frame = document.createElement("iframe");
        frame.id = "design-frame";
        frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads");
        frame.style.cssText = "position:fixed;left:0;top:0;width:800px;height:600px;border:0;z-index:99999;background:#fff";
        window.__got = [];
        window.__ready = 0;
        window.__bridge = attachBridge({ current: frame }, { source: "a reply", onMessage: (message) => window.__got.push(message), onReady: () => (window.__ready += 1) });
        window.__send = (message) => __bridge.send(message);
        window.__frame = frame;
        frame.src = "/a/frame";
        document.body.append(frame);
        return "null";
    `);
        await until(
            async () => (await inPage<number>(`return JSON.stringify(window.__ready)`)) === 1,
            "the run frame's line",
            SLOW,
        );
        // The app asks for its modes while the frame still holds no page of the reply's.
        await send({ type: "pocket-edit-text", on: true });
        await send({ type: "pocket-highlight", targets: [{ selector: "#t" }] });
        await send({ type: "pocket-tweak-set", values: { "--k": "7px" } });
        await inPage(
            `__frame.contentWindow.postMessage({ type: "pocket-run", html: ${JSON.stringify(html)} }, "*"); return "null"`,
        );
        await until(async () => (await gotOf("pocket-deck")).length >= 1, "the reply's page", SLOW);
        await settle();

        const seen = await dump();

        assert.match(seen.html, /<p id="t" contenteditable="plaintext-only"[^>]*>second<\/p>/);
        assert.match(seen.html, /--k: 7px/);
        assert.equal(seen.overlay, true, "the pins are on the new page");
        assert.deepEqual(
            seen.slides.map((slide) => slide.shown),
            [true],
        );
        await send({ type: "pocket-edit-text", on: false });
        await send({ type: "pocket-highlight", targets: [] });
        await settle();
        assert.equal((await dump()).overlay, false);
    },
);
