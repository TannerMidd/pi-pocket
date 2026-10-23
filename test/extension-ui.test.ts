// Extensions' browser modules in a real Chromium: what they add shows in the app (the rail, a page in the conversation's
// place), hears its module's events, fails alone, and goes when turned off.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import type { ExtensionWeb } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import type { Pocket } from "../types/pocket.d.ts";
import { pocketVersion } from "../src/server/versions.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const dropIns = join(root, "data", "extensions");
const seen = globalThis as unknown as { meterWeb?: ExtensionWeb };

/** `Pocket`'s members in the public types: `npm run check` holds this to them, and the first test holds `pocket` to it. */
const POCKET_MEMBERS: Record<keyof Pocket, true> = {
    version: true,
    pocketVersion: true,
    module: true,
    title: true,
    h: true,
    html: true,
    Fragment: true,
    useState: true,
    useEffect: true,
    useLayoutEffect: true,
    useRef: true,
    useMemo: true,
    useCallback: true,
    useReducer: true,
    Icon: true,
    Spinner: true,
    Loader: true,
    Markdown: true,
    Switch: true,
    Conversation: true,
    me: true,
    conversationId: true,
    openConversation: true,
    api: true,
    on: true,
    notify: true,
    rail: true,
    menu: true,
    launcher: true,
    page: true,
    sheet: true,
    panel: true,
    status: true,
    topbar: true,
    composerButton: true,
    replyAction: true,
    insertText: true,
    arrange: true,
    toolCall: true,
    openPage: true,
    closePage: true,
    openSheet: true,
    closeSheet: true,
    openPanel: true,
    closePanel: true,
    style: true,
    onDispose: true,
};

/** The owner's meter: a route, events, and a browser module with a rail button and a page. */
const METER = `/** Meter: a reading on a page of its own. */
export default function (_host, web) {
	let reading = 41;
	web.route("GET", "reading", () => ({ reading: ++reading }));
	web.client("meter.js");
	globalThis.meterWeb = web;
}
`;

const METER_JS = `export const pocketApi = 1;

export default function (pocket) {
	const { html, useEffect, useState } = pocket;

	function Meter() {
		const [reading, setReading] = useState(null);

		useEffect(() => {
			pocket.api("reading").then((answer) => setReading(answer.reading));

			return pocket.on("reading", (value) => setReading(value));
		}, []);

		return html\`<p class="meter">Reading: \${reading ?? "…"}</p>\`;
	}

	pocket.page({ id: "meter", title: "Meter", component: Meter });
	pocket.panel({ id: "dial", title: "Dial", icon: "pulse", component: () => html\`<p class="dial">Dial</p>\` });
	pocket.status({ id: "watts", text: "46W · 74° · 95%", short: "46W", title: "Node 1", panel: "dial", before: "core:here" });
	pocket.arrange("status", { hide: ["core:spend"] });
	pocket.replyAction({ id: "quote", label: "Quote", run: (reply) => pocket.insertText("> " + reply.text) });
	const rail = pocket.rail({ id: "meter", title: "Meter", icon: "pulse", page: "meter" });
	// The tests reach this version's pocket, and its rail button, through these.
	globalThis.meterPocket = pocket;
	globalThis.meterRail = rail;
}
`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string, on: BrowserPage = page): Promise<T> {
    return JSON.parse(await on.evaluate(script)) as T;
}

/**
 * Wait for the page's own finite animations (sheets rising, the page fading in), so clicks land where they aim. Not
 * the notices': their countdown runs for seconds.
 */
async function settled(on: BrowserPage = page): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.getAnimations().every((each) => each.effect?.getComputedTiming().endTime === Infinity || each.playState !== "running" || each.effect?.target?.closest?.(".notices")))`,
                on,
            ),
        "animations to finish",
    );
    // A click soon after a layer opened is let go (back.js): wait it out.
    await new Promise((resolve) => setTimeout(resolve, 450));
}

const has = (selector: string, on: BrowserPage = page) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
        on,
    );

const text = (selector: string) =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? "")`,
    );

const notices = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".notice")].map((each) => each.textContent.trim()))`,
    );

/** Run `script` in the page with the meter's `pocket` (the version loaded now) and `html`; what it returns. */
const withMeter = <T>(script: string) =>
    inPage<T>(`const pocket = globalThis.meterPocket; const { html } = pocket; ${script}`);

/** How this tab's copy of a module's browser module stands, as the Extensions sheet reads it. */
const stateOf = (module: string) =>
    inPage<unknown>(
        `return JSON.stringify((await import("/extension-ui.js")).browserModuleState(${JSON.stringify(module)}) ?? null)`,
    );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Time, in the page, from now until the meter stops, kept as `globalThis.meterTook`. */
const timeTheStop = () =>
    inPage<null>(`
        const { store } = await import("/store.js");
        const { browserModuleState } = await import("/extension-ui.js");
        const started = performance.now();
        const stop = store.subscribe(() => {
            if (browserModuleState("meter")?.status === "failed") {
                globalThis.meterTook = performance.now() - started;
                stop();
            }
        });

        globalThis.meterTook = null;

        return "null";
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(dropIns, { recursive: true });
    writeFileSync(join(dropIns, "meter.ts"), METER);
    writeFileSync(join(dropIns, "meter.js"), METER_JS);
    // A second module, for everyone who sees every session, from a folder.
    writeFileSync(
        join(dropIns, "shared.ts"),
        `/** Shared: a rail button for everyone. */\nexport default (_host, web) => { web.client("shared", { access: "view" }); };\n`,
    );
    mkdirSync(join(dropIns, "shared"));
    writeFileSync(
        join(dropIns, "shared", "index.js"),
        `export default (pocket) => {
	pocket.rail({ id: "hi", title: "Shared", run: () => pocket.notify("info", "hi from shared") });
};
`,
    );
    // Fails while it sets up: the app goes on without it.
    writeFileSync(
        join(dropIns, "broken.ts"),
        `/** Broken: a browser module that throws. */\nexport default (_host, web) => { web.client("broken.js"); };\n`,
    );
    writeFileSync(
        join(dropIns, "broken.js"),
        `export default (pocket) => {
	pocket.rail({ id: "x", title: "Broken", run() {} });
	throw new Error("broken on purpose");
};
`,
    );

    // Browser modules for API 2 (this one), 3 (a newer app's), and 0 (older than the oldest): only the first loads.
    for (const [name, api] of [
        ["fresh", 2],
        ["future", 3],
        ["past", 0],
    ] as const) {
        writeFileSync(
            join(dropIns, `${name}.ts`),
            `/** ${name}: a browser module for API ${api}. */\nexport default (_host, web) => { web.client("${name}.js"); };\n`,
        );
        writeFileSync(
            join(dropIns, `${name}.js`),
            `export const pocketApi = ${api};\nexport default (pocket) => { pocket.rail({ id: "x", title: "${name}", run() {} }); };\n`,
        );
    }

    app = await openApp(
        scriptedModel((request) => {
            const last = lastText(request as never);

            return last.role === "user" && last.text === "embed tool check"
                ? fauxAssistantMessage(
                      [fauxToolCall("bash", { command: "printf embed-tool-ok" })],
                      { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage([fauxText(`echo: ${last.text}`)]);
        }),
    );

    // Broken is turned on in its own test: its notice would cover the top bar's buttons in the others.
    for (const file of ["meter.ts", "shared.ts"]) {
        await app.setExtensionEnabled(owner(app), file, true);
    }

    session = await newSession(app);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        // A test-only document keeps a normal app document and 2 SDK embeds alive independently.
        // Reloading the normal document must not unmount either SDK embed.
        if (request.url?.startsWith("/paste-isolation-harness?")) {
            const id = Number(
                new URL(request.url, "http://test").searchParams.get("conversationId"),
            );

            assert.ok(Number.isSafeInteger(id) && id > 0);
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
                <script type="importmap">{"imports":{"preact":"/vendor/preact.mjs","preact/hooks":"/vendor/preact-hooks.mjs","htm":"/vendor/htm.mjs","marked":"/vendor/marked.mjs","dompurify":"/vendor/purify.mjs"}}</script>
                <iframe id="main-document" src="/s/${id}" style="width:100%;height:300px"></iframe>
                <div id="sdk-embeds" style="height:500px;display:flex"></div>
                <script type="module">
                    import { h, render } from "preact";
                    import { Conversation } from "/conversation-embed.js";
                    render(h("div", { style: "display:contents" }, h(Conversation, {conversationId:${id}}), h(Conversation, {conversationId:${id}})), document.querySelector("#sdk-embeds"));
                </script>`);

            return;
        }

        return handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "extension-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(DESKTOP);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const rail = (title: string) => `.sidebar .rail-ext[title="${title}"]`;

test(
    "a browser module's rail button opens its page, which calls its route and hears its events",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        assert.deepEqual(
            await withMeter<string[]>(`return JSON.stringify(Object.keys(pocket).sort())`),
            Object.keys(POCKET_MEMBERS).sort(),
            "pocket has the members of Pocket in types/pocket.d.ts",
        );
        await settled();
        await page.click({ selector: rail("Meter") });
        await until(
            async () => (await text(".ext-page .meter")) === "Reading: 42",
            "the reading from its route",
        );

        assert.equal(
            await withMeter<string>(`return JSON.stringify(pocket.pocketVersion)`),
            pocketVersion(),
        );
        seen.meterWeb!.send("reading", 7);
        await until(
            async () => (await text(".ext-page .meter")) === "Reading: 7",
            "the reading the server sent",
        );
        await withMeter(`pocket.openConversation("${session}"); return "null"`);
        await until(
            async () => (await has(".composer")) && !(await has(".ext-page")),
            "normal conversation navigation",
        );
    },
);

test(
    "a status item opens its panel beside the conversation, which the Files panel replaces",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has('[data-part="status-item"]'), "the meter's status item");
        assert.equal(await text('[data-part="status-item"] .long'), "46W · 74° · 95%");
        // The module put its item first and hid the spend; the person's own choice brings the spend back.
        const line = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector(".status-line").innerText.replace(/\\s+/g, " ").trim())`,
            );

        assert.match(await line(), /^46W · 74° · 95% 1 here/);
        assert.doesNotMatch(await line(), /\$0\.00/);
        await inPage(
            `(await import("/slots.js")).setShown("status", "core:spend", true); return "null";`,
        );
        await until(async () => /\$0\.00/.test(await line()), "the spend shown again");
        await inPage(`(await import("/slots.js")).resetSlot("status"); return "null";`);
        await settled();
        await page.click({ selector: '[data-part="status-item"]' });
        await until(
            () => has(".layout.paneling .ext-panel .dial"),
            "the panel beside the conversation",
        );
        assert.equal(await has(".composer"), true, "the conversation stays beside it");

        // A reload keeps it, and one panel shows at a time.
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(".ext-panel .dial"), "the panel after a reload");
        await inPage(`(await import("/files-panel.js")).setFilesOpen(true); return "null";`);
        await until(async () => !(await has(".ext-panel")), "the Files panel in its place");
        await inPage(`(await import("/files-panel.js")).setFilesOpen(false); return "null";`);
    },
);

test(
    "an action under Pi's answer gets the answer, and puts text into the message box",
    real,
    async () => {
        await say(app, session, "quote me");
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(".ext-reply-action"), "the action under the answer");
        await settled();
        await page.click({ selector: ".ext-reply-action" });
        await until(
            async () =>
                (await inPage<string>(
                    `return JSON.stringify(document.querySelector(".composer textarea").value)`,
                )) === "> echo: quote me",
            "the quote in the message box",
        );
        await inPage(`(await import("/store.js")).drafts.set(${session}, ""); return "null";`);
    },
);

test("an action under answers redraws on update, and runs the new run", real, async () => {
    await say(app, session, "an answer to act on");
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(".ext-reply-action"), "the actions under the answer");
    await withMeter(
        `globalThis.sayAction = pocket.replyAction({ id: "say", label: "Say v1", run: () => { globalThis.said = "v1"; } }); return "null";`,
    );
    const labels = () =>
        inPage<string[]>(
            `return JSON.stringify([...document.querySelectorAll(".ext-reply-action")].map((each) => each.textContent.trim()))`,
        );

    await until(async () => (await labels()).includes("Say v1"), "the new action");
    await withMeter(
        `globalThis.sayAction.update({ label: "Say v2", run: () => { globalThis.said = "v2"; } }); return "null";`,
    );
    await until(async () => (await labels()).includes("Say v2"), "the updated label");
    await inPage(
        `[...document.querySelectorAll(".ext-reply-action")].find((each) => each.textContent.trim() === "Say v2").click(); return "null";`,
    );
    await until(
        async () => (await inPage<string>(`return JSON.stringify(globalThis.said ?? "")`)) === "v2",
        "the new run",
    );
    await withMeter(`globalThis.sayAction.remove(); return "null";`);
});

test(
    "the same action under answers added again keeps the slot's key; a new run changes it and runs",
    real,
    async () => {
        await say(app, session, "an answer for the same action");
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(".ext-reply-action"), "the actions under the answer");
        const key = () =>
            inPage<string>(`return JSON.stringify((await import("/slots.js")).slotKey("reply"))`);

        // (a) The same object 2 times.
        await withMeter(
            `globalThis.sameSpec = { id: "same", label: "Same", run: () => { globalThis.ran = "first"; } }; pocket.replyAction(globalThis.sameSpec); return "null";`,
        );
        const first = await key();

        await withMeter(`pocket.replyAction(globalThis.sameSpec); return "null";`);
        assert.equal(await key(), first, "the same object keeps the key");
        // (b) A new object with the same fields and the same run.
        await withMeter(`pocket.replyAction({ ...globalThis.sameSpec }); return "null";`);
        assert.equal(await key(), first, "the same fields and run keep the key");
        // (c) A new run: the key changes, and the new run runs.
        await withMeter(
            `pocket.replyAction({ ...globalThis.sameSpec, run: () => { globalThis.ran = "second"; } }); return "null";`,
        );
        assert.notEqual(await key(), first, "a new run changes the key");
        await sleep(200);
        await inPage(
            `[...document.querySelectorAll(".ext-reply-action")].findLast((each) => each.textContent.trim() === "Same").click(); return "null";`,
        );
        await until(
            async () =>
                (await inPage<string>(`return JSON.stringify(globalThis.ran ?? "")`)) === "second",
            "the new run",
        );
        await withMeter(`pocket.replyAction(globalThis.sameSpec).remove(); return "null";`);
    },
);

test(
    "a top bar button cannot take its panel's id, and an order that names an id twice keeps every button",
    real,
    async () => {
        const clash = await withMeter<string>(
            `try { pocket.topbar({ id: "dial", title: "Twin", run() {} }); return JSON.stringify("accepted"); } catch (error) { return JSON.stringify(error.message); }`,
        );

        assert.match(clash, /share their ids/);
        const ids = () =>
            inPage<string[]>(
                `return JSON.stringify((await import("/slots.js")).arranged("topbar").map(({ item }) => item.id))`,
            );
        const before = await ids();

        await withMeter(
            `pocket.arrange("topbar", { order: ["core:files", "core:files", "core:changes"] }); return "null";`,
        );
        const after = await ids();

        assert.deepEqual([...after].sort(), [...before].sort(), "each button once, none lost");
        await withMeter(`pocket.arrange("topbar", {}); return "null";`);
    },
);

test(
    "a browser module for API 2 loads, and one for a newer API says why it does not",
    real,
    async () => {
        await app.setExtensionEnabled(owner(app), "fresh.ts", true);
        await app.setExtensionEnabled(owner(app), "future.ts", true);
        await app.setExtensionEnabled(owner(app), "past.ts", true);
        await page.navigate(`${base}/s/${session}`);
        await until(
            async () =>
                (await notices()).some((each) =>
                    each.includes(
                        "it needs version 3 of the app's extension API, and this app has 2",
                    ),
                ),
            "the newer API's notice",
        );
        await until(
            async () =>
                (await notices()).some((each) =>
                    each.includes("it was written for version 0 of the app's extension API"),
                ),
            "the older API's notice",
        );
        await until(() => has(rail("fresh")), "the API 2 module's button");
        assert.equal(await has(rail("future")), false);
        assert.equal(await has(rail("past")), false);
        await app.setExtensionEnabled(owner(app), "fresh.ts", false);
        await app.setExtensionEnabled(owner(app), "future.ts", false);
        await app.setExtensionEnabled(owner(app), "past.ts", false);
    },
);

test("a browser module that fails says so, and the rest of the app goes on", real, async () => {
    await app.setExtensionEnabled(owner(app), "broken.ts", true);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            (await notices()).some((each) =>
                each.includes("broken failed to load in this browser: broken on purpose"),
            ),
        "the failure's notice",
    );
    // What it added before it threw is gone; the others' stay.
    assert.equal(await has(rail("Broken")), false);
    assert.equal(await has(rail("Meter")), true);
    assert.equal(await has(".composer"), true);
    await app.setExtensionEnabled(owner(app), "broken.ts", false);
});

test(
    "an endless loop of microtasks that calls pocket is stopped in about a second",
    real,
    async () => {
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the meter's rail button");
        await timeTheStop();
        // Each turn of the loop after an await. The page answers again only once the loop ends.
        await withMeter<null>(`
            globalThis.spinEnded = null;
            (async () => {
                let count = 0;

                try {
                    for (;;) {
                        await Promise.resolve();
                        globalThis.meterRail.update({ badge: (++count % 50) + 1 });
                    }
                } catch (error) {
                    globalThis.spinEnded = error.message;
                }
            })();

            return "null";
        `);
        await until(
            () => inPage<boolean>(`return JSON.stringify(globalThis.spinEnded !== null)`),
            "the loop ended",
        );
        assert.deepEqual(await stateOf("meter"), {
            status: "failed",
            error: "it redraws without end",
        });

        const took = await inPage<number | null>(`return JSON.stringify(globalThis.meterTook)`);

        assert.ok(typeof took === "number" && took < 2000, `stopped after ${took} ms`);
    },
);

test("safe mode: ?noext=1 loads no browser modules in the tab, across a reload", real, async () => {
    try {
        await page.navigate(`${base}/s/${session}?noext=1`);
        await until(() => has(".composer"), "the conversation");
        await until(
            async () =>
                (await notices()).some((each) =>
                    each.includes("Extensions' browser parts are off in this tab"),
                ),
            "the notice",
        );
        assert.equal(await has(".rail-ext"), false);

        // A reload in the same tab keeps it.
        await page.navigate(`${base}/s/${session}`);
        await until(() => has(".composer"), "the conversation again");
        await sleep(500);
        assert.equal(await has(".rail-ext"), false);
    } finally {
        await inPage<null>(`sessionStorage.removeItem("pocket.noext"); return "null"`);
    }
});

test("Lancet Guard stays on until its inline confirmation is accepted", real, async () => {
    await app.setExtensionEnabled(owner(app), "guard.ts", true);
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(".composer"), "the conversation");
    await inPage(
        `(await import("/store.js")).openSheet({ type: "extensions", tab: "installed" }); return "null";`,
    );
    await until(() => has('.switch[aria-label="Lancet Guard: on"]'), "the guard switch");
    await settled();
    await inPage(
        `document.querySelector('.switch[aria-label="Lancet Guard: on"]').focus(); return "null";`,
    );
    await page.press("Space");
    await until(() => has(".guard-confirm"), "the inline confirmation");
    assert.equal(await has('.switch[aria-label="Lancet Guard: on"]'), true);
    await page.press("Enter");
    await until(async () => !(await has(".guard-confirm")), "Keep it on cancels");
    assert.equal(await has('.switch[aria-label="Lancet Guard: on"]'), true);
    await page.press("Space");
    await until(() => has(".guard-confirm"), "the confirmation to accept");
    await page.press("Tab");
    await page.press("Enter");
    await until(
        () => has('.switch[aria-label="Lancet Guard: off"]:focus'),
        "guard off and focus restored",
    );
});

test(
    "Conversation embeds isolate streams, drafts, tools, approvals, and parent selection",
    real,
    async () => {
        const first = await newSession(app);
        const second = await newSession(app);

        await page.navigate(`${base}/s/${session}`);
        await until(() => has(rail("Meter")), "the SDK");
        await withMeter(`
        pocket.page({ id: "embeds", title: "Embeds", component: () => html\`<div style="height:700px;display:flex">
            <\${pocket.Conversation} conversationId=\${${first}} draft="embed tool check" onClose=\${() => { globalThis.embedClosed = (globalThis.embedClosed ?? 0) + 1; }} />
            <\${pocket.Conversation} conversationId=\${${second}} draft="second draft" />
        </div>\` });
        pocket.openPage("embeds"); return "null";
    `);
        const frames = (script: string) =>
            inPage<any>(
                `const frames = [...document.querySelectorAll(".ext-page iframe")]; ${script}`,
            );

        await until(
            async () =>
                await frames(
                    `return JSON.stringify(frames.length === 2 && frames.every(f => f.contentDocument?.querySelector(".composer textarea")));`,
                ),
            "two native composers",
        );
        await until(
            async () =>
                await frames(
                    `return JSON.stringify(frames[0].contentDocument.querySelector("textarea").value === "embed tool check" && frames[1].contentDocument.querySelector("textarea").value === "second draft");`,
                ),
            "drafts inserted without sending",
        );
        assert.deepEqual(
            await frames(
                `return JSON.stringify(frames.map(f => !!f.contentDocument.querySelector(".sidebar, .ext-page, .pip")));`,
            ),
            [false, false],
        );
        assert.equal(
            await inPage(
                `return JSON.stringify((await import("/store.js")).store.state.conversationId);`,
            ),
            session,
        );
        assert.equal(
            await frames(
                `return JSON.stringify(frames[0].contentDocument.body.textContent.includes("echo:"));`,
            ),
            false,
        );
        await frames(
            `frames[0].contentDocument.querySelector('[aria-label="Send"]').click(); return "null";`,
        );
        await until(
            async () =>
                await frames(
                    `return JSON.stringify(frames[0].contentDocument.body.textContent.includes("embed-tool-ok"));`,
                ),
            "native send and real tool result",
        );
        assert.equal(
            await frames(
                `return JSON.stringify(frames[1].contentDocument.querySelector("textarea").value);`,
            ),
            "second draft",
        );
        await frames(
            `globalThis.embedDocument = frames[1].contentDocument; const box = frames[1].contentDocument.querySelector('textarea'); box.value = 'human edited draft'; box.dispatchEvent(new frames[1].contentWindow.Event('input', { bubbles: true })); return "null";`,
        );

        for (let index = 0; index < 3; index++) {
            await withMeter(`pocket.notify("info", "parent redraw"); return "null";`);
            await sleep(100);
        }

        assert.equal(
            await frames(
                `return JSON.stringify(frames[1].contentDocument === globalThis.embedDocument && frames[1].contentDocument.querySelector('textarea').value === 'human edited draft');`,
            ),
            true,
        );
        const answer = app.approvals.request(
            {
                id: "embed-approval",
                conversationId: first,
                taskId: 999 as unknown as TaskId,
                tool: "bash",
                subject: "printf approval",
                reason: "test approval",
                createdAt: Date.now(),
            },
            context,
        );

        await until(
            async () =>
                await frames(
                    `return JSON.stringify([...frames[0].contentDocument.querySelectorAll("button")].some(b => b.textContent.trim() === "Allow"));`,
                ),
            "native approval",
        );
        await frames(
            `[...frames[0].contentDocument.querySelectorAll("button")].find(b => b.textContent.trim() === "Allow").click(); return "null";`,
        );
        assert.equal((await answer).allow, true);
        assert.equal(
            await inPage(
                `return JSON.stringify((await import("/store.js")).store.state.conversationId);`,
            ),
            session,
        );
        await frames(
            `frames[0].contentDocument.querySelector('.model-chip').click(); return "null";`,
        );
        await until(
            async () =>
                await frames(
                    `return JSON.stringify(!!frames[0].contentDocument.querySelector('[role="dialog"]'));`,
                ),
            "native sheet",
        );
        await sleep(500);
        await frames(
            `frames[0].contentWindow.dispatchEvent(new frames[0].contentWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return "null";`,
        );
        await sleep(500);
        assert.equal(await inPage(`return JSON.stringify(globalThis.embedClosed ?? 0);`), 0);
        await frames(
            `frames[0].contentWindow.dispatchEvent(new frames[0].contentWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return "null";`,
        );
        await until(
            async () => await inPage(`return JSON.stringify(globalThis.embedClosed === 1);`),
            "Escape close callback",
        );
        await frames(
            `window.postMessage({ type: 'pocket:conversation:close', channel: new URL(frames[0].src).searchParams.get('embedChannel'), conversationId: ${first} }, location.origin); return "null";`,
        );
        await sleep(50);
        assert.equal(await inPage(`return JSON.stringify(globalThis.embedClosed);`), 1);
        await withMeter(`pocket.closePage(); return "null";`);
        await until(async () => !(await has(".ext-page iframe")), "unmounted frames");
    },
);

test("same-conversation long pastes stay private to each embedded composer", real, async () => {
    const id = await newSession(app);
    const mainPaste = "main-paste-" + "M".repeat(2100);
    const firstPaste = "first-paste-" + "F".repeat(2100);
    const secondPaste = "second-paste-" + "S".repeat(2100);

    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            await inPage<boolean>(
                `const { store } = await import('/store.js'); return JSON.stringify(store.state.conversationId === ${id} && store.state.view.conversation?.id === ${id} && !!document.querySelector('.composer textarea'));`,
            ),
        "main conversation composer",
    );
    const paste = async (frame: number | null, value: string) =>
        inPage(`
        const doc = ${frame === null ? "document" : `document.querySelectorAll('#paste-test-host iframe')[${frame}].contentDocument`};
        const transfer = new doc.defaultView.DataTransfer();
        transfer.setData('text/plain', ${JSON.stringify(value)});
        doc.querySelector('.composer textarea').dispatchEvent(new doc.defaultView.ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
        return "null";
    `);
    const state = () =>
        inPage<{ main: string; first?: string; second?: string; stored: string | null }>(`
        const frames = [...document.querySelectorAll('#paste-test-host iframe')];
        return JSON.stringify({ main: document.querySelector('.composer textarea').value, first: frames[0]?.contentDocument?.querySelector('.composer textarea')?.value, second: frames[1]?.contentDocument?.querySelector('.composer textarea')?.value, stored: localStorage.getItem('pocket.pastes.${id}') });
    `);
    const mount = () =>
        withMeter(`
        const { render } = await import('preact');
        const host = document.createElement('div');
        host.id = 'paste-test-host';
        host.style = 'position:fixed;inset:0;display:flex;z-index:100';
        document.body.append(host);
        render(html\`<div style="display:contents">
            <\${pocket.Conversation} conversationId=\${${id}} />
            <\${pocket.Conversation} conversationId=\${${id}} />
        </div>\`, host);
        return "null";
    `);

    await paste(null, mainPaste);
    await until(
        async () => (await state()).main.startsWith("[Pasted text #1"),
        "main paste placeholder",
    );
    const saved = await state();

    assert.deepEqual(JSON.parse(saved.stored!), { 1: mainPaste });
    await mount();
    await until(
        async () => (await state()).first === "" && (await state()).second === "",
        "fresh private drafts",
    );
    await paste(0, firstPaste);
    await paste(1, secondPaste);
    await until(
        async () =>
            (await state()).first?.startsWith("[Pasted text #1") === true &&
            (await state()).second?.startsWith("[Pasted text #1") === true,
        "private paste numbering",
    );
    assert.equal((await state()).stored, saved.stored);
    await inPage(
        `document.querySelectorAll('#paste-test-host iframe')[0].contentDocument.querySelector('[aria-label="Send"]').click(); return "null";`,
    );
    await until(async () => (await state()).first === "", "first embed sent");
    const afterFirst = await state();

    assert.equal(afterFirst.main, saved.main);
    assert.equal(afterFirst.stored, saved.stored);
    assert.equal(afterFirst.second?.startsWith("[Pasted text #1"), true);
    await until(
        async () =>
            await inPage(
                `return JSON.stringify(document.body.textContent.includes(${JSON.stringify(firstPaste)}));`,
            ),
        "expanded first paste in native transcript",
    );
    await inPage(
        `document.querySelectorAll('#paste-test-host iframe')[1].contentDocument.querySelector('[aria-label="Send"]').click(); return "null";`,
    );
    await until(async () => (await state()).second === "", "second embed sent");
    await until(
        async () =>
            await inPage(
                `return JSON.stringify(document.body.textContent.includes(${JSON.stringify(secondPaste)}));`,
            ),
        "second paste retained its own payload",
    );
    assert.equal((await state()).stored, saved.stored);
    await page.reload();
    await until(() => has(".composer textarea"), "main reloaded");
    assert.equal((await state()).main, saved.main);
    assert.equal((await state()).stored, saved.stored);
    await mount();
    await until(
        async () => (await state()).first === "" && (await state()).second === "",
        "fresh embeds never import main draft",
    );
    await paste(1, secondPaste);
    await until(
        async () => (await state()).second?.startsWith("[Pasted text #1") === true,
        "fresh embed never imports main paste map",
    );
    assert.equal((await state()).stored, saved.stored);
    await inPage(
        `const host = document.querySelector('#paste-test-host'); const { render } = await import('preact'); render(null, host); host.remove(); document.querySelector('[aria-label="Send"]').click(); return "null";`,
    );
    await until(
        async () =>
            await inPage(
                `return JSON.stringify(document.body.textContent.includes(${JSON.stringify(mainPaste)}));`,
            ),
        "main paste still expands after reload",
    );
});

test(
    "a main document reload preserves both same-conversation embedded paste payloads",
    real,
    async () => {
        const id = await newSession(app);
        const payloads = ["MAIN-", "EMBED-ONE-", "EMBED-TWO-"].map(
            (label) => label + "p".repeat(2100),
        );
        const run = <T>(script: string) =>
            inPage<T>(
                `const frames = [document.querySelector('#main-document'), ...document.querySelectorAll('#sdk-embeds iframe')]; ${script}`,
            );
        const paste = (index: number) =>
            run(`
        const doc = frames[${index}].contentDocument;
        const transfer = new doc.defaultView.DataTransfer();
        transfer.setData('text/plain', ${JSON.stringify(payloads[index])});
        doc.querySelector('.composer textarea').dispatchEvent(new doc.defaultView.ClipboardEvent('paste', {clipboardData: transfer, bubbles:true, cancelable:true}));
        return "null";
    `);
        const texts = () =>
            run<string[]>(
                `return JSON.stringify(frames.map(f => f?.contentDocument?.querySelector('.composer textarea')?.value));`,
            );
        const stored = () =>
            run<string | null>(
                `return JSON.stringify(localStorage.getItem('pocket.pastes.${id}'));`,
            );

        await page.navigate(`${base}/paste-isolation-harness?conversationId=${id}`);
        await until(
            async () =>
                (await texts()).length === 3 && (await texts()).every((value) => value === ""),
            "3 independent native composers",
        );
        await paste(0);
        await until(
            async () => (await texts())[0]!.startsWith("[Pasted text #1"),
            "main long paste",
        );
        const saved = await stored();

        for (const index of [1, 2]) {
            await paste(index);
            await until(
                async () => (await texts())[index]!.startsWith("[Pasted text #1"),
                "private embed long paste",
            );
        }

        assert.equal(await stored(), saved);
        const before = await texts();

        await run(
            `globalThis.otherEmbeddedDocument = frames[2].contentDocument; frames[1].contentDocument.querySelector('[aria-label="Send"]').click(); return "null";`,
        );
        await until(async () => (await texts())[1] === "", "1 embed send");
        assert.equal((await texts())[0], before[0]);
        assert.equal((await texts())[2], before[2]);
        assert.equal(await stored(), saved);
        await run(
            `globalThis.oldMainDocument = frames[0].contentDocument; frames[0].contentWindow.location.reload(); return "null";`,
        );
        await until(
            async () =>
                await run<boolean>(
                    `return JSON.stringify(frames[0].contentDocument !== globalThis.oldMainDocument && frames[0].contentDocument?.querySelector('.composer textarea')?.value === ${JSON.stringify(before[0])});`,
                ),
            "main draft restored after document reload",
        );
        assert.equal((await texts())[2], before[2]);
        assert.equal(
            await run(
                `return JSON.stringify(frames[2].contentDocument === globalThis.otherEmbeddedDocument);`,
            ),
            true,
        );
        assert.equal(await stored(), saved);
        await run(
            `frames[2].contentDocument.querySelector('[aria-label="Send"]').click(); return "null";`,
        );
        await until(
            async () =>
                await run<boolean>(
                    `return JSON.stringify(frames[0].contentDocument.body.textContent.includes(${JSON.stringify(payloads[2])}));`,
                ),
            "other embed payload survived main reload",
        );
        assert.equal(await stored(), saved);
        await run(
            `frames[0].contentDocument.querySelector('[aria-label="Send"]').click(); return "null";`,
        );
        await until(
            async () =>
                await run<boolean>(
                    `return JSON.stringify(frames[0].contentDocument.body.textContent.includes(${JSON.stringify(payloads[0])}));`,
                ),
            "main payload survived embed sends and main reload",
        );
    },
);

test("turning the module off takes away its button and closes its page", real, async () => {
    await page.navigate(`${base}/s/${session}`);
    await until(() => has(rail("Meter")), "the meter's rail button");
    await settled();
    await page.click({ selector: rail("Meter") });
    await until(() => has(".ext-page .meter"), "the page");
    await app.setExtensionEnabled(owner(app), "meter.ts", false);
    await until(
        async () => !(await has(".ext-page")) && !(await has(rail("Meter"))),
        "the page and button gone",
    );
    assert.equal(await has(rail("Shared")), true);
});

test("native embeds preserve guest, viewer, and scoped access checks", real, async () => {
    const visible = await newSession(app);
    const hidden = await newSession(app);
    const guest = app.config.addUser("Embed Guest", "guest", [String(visible)]);
    const viewer = app.config.addUser("Embed Viewer", "viewer", [String(visible)]);

    try {
        await page.navigate(
            `${base}/login?token=${encodeURIComponent(guest.token)}&next=${encodeURIComponent(`/s/${visible}?pocketEmbed=1`)}`,
        );
        await until(() => has('form button[type="submit"]'), "guest account switch");
        await page.click({ selector: 'form button[type="submit"]' });
        await until(() => has(".conversation-embed .composer textarea"), "guest composer");
        assert.equal(await has(".sidebar"), false);
        await page.navigate(`${base}/s/${hidden}?pocketEmbed=1`);
        await until(() => has(".conversation-embed .error-box"), "scoped access error");
        assert.equal(await has(".composer textarea"), false);
        await page.navigate(
            `${base}/login?token=${encodeURIComponent(viewer.token)}&next=${encodeURIComponent(`/s/${visible}?pocketEmbed=1`)}`,
        );
        await until(() => has('form button[type="submit"]'), "viewer account switch");
        await page.click({ selector: 'form button[type="submit"]' });
        await until(() => has('.conversation-embed [data-part="composer"]'), "viewer conversation");
        assert.equal(await has(".composer textarea"), false);
        assert.equal(await has('[aria-label="Send"]'), false);
        await page.navigate(`${base}/s/999999999?pocketEmbed=1`);
        await until(() => has(".error-box"), "missing conversation error");
    } finally {
        app.config.removeUser(guest.user.id);
        app.config.removeUser(viewer.user.id);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);

        if (await has('form button[type="submit"]')) {
            await page.click({ selector: 'form button[type="submit"]' });
        }
    }
});
