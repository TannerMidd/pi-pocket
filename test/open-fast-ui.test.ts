// What opening a session on a phone keeps doing while it does less: the transcript stays at the bottom as Pi writes,
// the rows shown start where they did, earlier messages and jumps still reach back, replies are still sanitized, and
// what animates on open plays only when someone asks for it. In a real Chromium, at phone size.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let first: ConversationId;

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Wait until a script in the page returns true. */
const waitFor = (script: string, what: string) =>
    until(
        async () =>
            (await (/\bawait\b/.test(script)
                ? settled<boolean>(script)
                : inPage<boolean>(script))) === true,
        what,
    );

const row = (id: ConversationId) => `.home-list .session-row[data-id="${id}"] .session`;

/** How far the transcript is from its bottom, in pixels. */
const gap = () =>
    inPage<number>(`
        const scroller = document.querySelector(".pane > .scroller");

        return JSON.stringify(Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight));
    `);

/**
 * Run `script` in the page and wait for what it returns, kept on the page: a promise a script waits on across frames
 * can be collected before it settles, which fails the call.
 */
async function settled<T>(script: string): Promise<T> {
    await page.evaluate(`
        window.settled = undefined;
        window.settling = (async () => { ${script} })().then(
            (value) => (window.settled = { value }),
            (error) => (window.settled = { error: String(error?.stack ?? error) }),
        );
        "started";
    `);
    await waitFor(`return JSON.stringify(window.settled !== undefined)`, "the script's end");
    const result = await inPage<{ value?: string; error?: string }>(
        `return JSON.stringify(window.settled)`,
    );

    if (result.error !== undefined) {
        throw new Error(result.error);
    }

    return JSON.parse(result.value ?? "null") as T;
}

/** A few frames, for what the page does after a change to show. */
const frames = () =>
    settled(
        `await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))); return "null";`,
    );

/**
 * A session's view in the page with `count` rows of messages and answers, ids from `from`, as the server would send
 * it. Replaces what the view had, and shows its newest rows, as a session just opened does.
 */
const showRows = (count: number, from = 920000) =>
    settled(`
        const { store } = await import("/store.js");
        const entries = [];

        for (let n = 0; n < ${count}; n++) {
            const id = ${from} + n;

            entries.push(n % 2 === 0
                ? { id, kind: "user", text: "Question " + n, images: 0, at: Date.now() }
                : { id, kind: "assistant", stopReason: "stop", at: Date.now(),
                    blocks: [{ type: "text", text: "Answer " + n + "\\n\\n" + "Words. ".repeat(40) }] });
        }

        store.set((state) => ({
            transcriptFrom: null,
            view: { ...state.view,
                entries: new Map(entries.map((entry) => [entry.id, entry])),
                order: entries.map((entry) => entry.id),
                live: { busy: false },
            },
        }));

        return "null";
    `);

/** The session list, freshly loaded at phone size: each test starts from here. */
async function fresh(): Promise<void> {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/`);
    await waitFor(
        `return JSON.stringify(document.querySelector(${JSON.stringify(row(first))}) !== null)`,
        "the session list",
    );
}

/** Open the first session from inside the app, and wait for its view. */
async function openFirst(): Promise<void> {
    await settled(`(await import("/store.js")).navigate(${Number(first)}); return "null";`);
    await waitFor(
        `return JSON.stringify((await import("/store.js")).store.state.view.conversation?.id === ${Number(first)})`,
        "the session's view",
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "open-fast-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    first = await newSession(app);
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(first))}) !== null)`,
            )) === true,
        "the session list",
        20_000,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the transcript stays at the bottom as an answer streams, and as rows come",
    real,
    async () => {
        await fresh();
        await openFirst();
        await showRows(30);
        await until(async () => (await gap()) < 2, "the bottom, once the rows show");

        // Pi writes: the answer being written grows, with no new entry, update after update.
        for (let n = 1; n <= 8; n++) {
            await settled(`
            const { store } = await import("/store.js");
            const text = "Streaming. ".repeat(${n * 30});

            store.set((state) => ({ view: { ...state.view, live: { busy: true,
                generation: { attempt: 0, message: { blocks: [{ type: "text", text }] } } } } }));

            return "null";
        `);
            await frames();
            assert.ok((await gap()) < 2, `at the bottom after streamed update ${n}`);
        }

        // The answer is stored, and a new message comes: a draw that changes the rows.
        await settled(`
        const { store } = await import("/store.js");
        const { view } = store.state;
        const answer = { id: 929998, kind: "assistant", stopReason: "stop", at: Date.now(),
            blocks: [{ type: "text", text: "Streaming. ".repeat(240) }] };
        const message = { id: 929999, kind: "user", text: "And then?", images: 0, at: Date.now() };
        const entries = new Map(view.entries);

        entries.set(answer.id, answer);
        entries.set(message.id, message);
        store.set({ view: { ...view, entries, order: [...view.order, answer.id, message.id], live: { busy: false } } });

        return "null";
    `);
        await frames();
        assert.ok((await gap()) < 2, "at the bottom after new rows");

        // A row grows by itself, with no draw of the app (an image, a card that draws late): still at the bottom.
        await page.evaluate(`
        const last = [...document.querySelectorAll(".transcript > *")].at(-1);
        const tall = document.createElement("div");

        tall.style.height = "400px";
        last.append(tall);
    `);
        await frames();
        assert.ok((await gap()) < 2, "at the bottom after a row grew by itself");
    },
);

test(
    "the rows shown start where they did, without a draw for it, and earlier ones show when asked",
    real,
    async () => {
        await fresh();
        await openFirst();
        // Every change to the store from here on that changes where the rows start and nothing else (the server's own
        // updates to the view may come too): each draws the whole app.
        await settled(`
        const { store } = await import("/store.js");
        let before = store.state;

        window.changes = [];
        window.stopCounting = store.subscribe((state) => {
            const changed = Object.keys(state).filter((key) => state[key] !== before[key]);

            before = state;

            if (changed.length === 1 && changed[0] === "transcriptFrom") {
                window.changes.push(state.transcriptFrom);
            }
        });

        return "null";
    `);
        await showRows(150);
        await waitFor(
            `return JSON.stringify((await import("/store.js")).store.state.transcriptFrom !== null)`,
            "where the rows shown start, noted",
        );
        await frames();
        // A fresh open shows the newest 60 rows: they start at the 90th.
        const noted = await settled<{ from: number; rows: number; changes: unknown[] }>(`
        const { store } = await import("/store.js");

        window.stopCounting();

        return JSON.stringify({
            from: store.state.transcriptFrom,
            rows: document.querySelectorAll(".transcript .user-row").length,
            changes: window.changes,
        });
    `);

        assert.equal(noted.from, 920090, "the first of the newest 60 rows");
        assert.equal(noted.rows, 30, "30 messages among them");
        assert.deepEqual(
            noted.changes,
            [],
            "no change to the store after the draw, for where they start",
        );

        // Show earlier messages: the 60 before show too, and the reader stays where they were.
        await page.evaluate(`
        const scroller = document.querySelector(".pane > .scroller");

        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event("scroll"));
    `);
        await frames();
        const top = await inPage<number>(`
        const first = document.querySelector("#entry-920090");

        return JSON.stringify(Math.round(first.getBoundingClientRect().top));
    `);

        await page.evaluate(`
        [...document.querySelectorAll(".transcript button")]
            .find((each) => each.textContent.trim() === "Show earlier messages").click();
    `);
        await waitFor(
            `return JSON.stringify((await import("/store.js")).store.state.transcriptFrom === 920030)`,
            "the 60 rows before shown",
        );
        await frames();
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelectorAll(".transcript .user-row").length)`,
            ),
            60,
        );
        const after = await inPage<number>(`
        return JSON.stringify(Math.round(document.querySelector("#entry-920090").getBoundingClientRect().top));
    `);

        assert.ok(
            Math.abs(after - top) < 4,
            `the row read before stays in place (${top} → ${after})`,
        );
    },
);

test(
    "a jump to a message above the rows shown shows from it down, and scrolls to it",
    real,
    async () => {
        await fresh();
        await openFirst();
        await showRows(150);
        await waitFor(
            `return JSON.stringify((await import("/store.js")).store.state.transcriptFrom === 920090)`,
            "the newest 60 rows",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.getElementById("entry-920010") === null)`,
            ),
            true,
            "not drawn before the jump",
        );
        const shown = await settled<boolean>(`
        const { jumpToEntry } = await import("/chat.js");

        return JSON.stringify(await jumpToEntry(920010, { quiet: true }));
    `);

        assert.equal(shown, true);
        await waitFor(
            `
        const found = document.getElementById("entry-920010");
        const box = found?.getBoundingClientRect();

        return JSON.stringify(box !== undefined && box.bottom > 0 && box.top < innerHeight);
    `,
            "the message on screen",
        );
        assert.equal(
            await settled<number>(
                `return JSON.stringify((await import("/store.js")).store.state.transcriptFrom)`,
            ),
            920010,
        );
    },
);

test(
    "the sanitizer still takes out what is unsafe, every time, and leaves extensions' DOMPurify as it was",
    real,
    async () => {
        await fresh();
        await openFirst();
        const unsafe = [
            "<script>window.hit = 1</script>",
            '<img src="x" onerror="window.hit = 2">',
            '<a href="javascript:window.hit = 3">a</a>',
            '<a href=" JaVaScRiPt:window.hit = 4">b</a>',
            '<svg><a xlink:href="javascript:window.hit = 5"><text>c</text></a></svg>',
            '<iframe src="https://example.com"></iframe>',
            '<form><input value="x"><button>d</button></form>',
            '<div data-part="approval" class="sheet" style="position:fixed" id="app">e</div>',
            '<img src="data:text/html,<b>f</b>">',
            '<a href="https://example.com" data-path="web.env">g</a>',
            "![shot](file:///tmp/shot.png)",
            '<img src="file:///tmp/raw.png">',
            "[here](app.ts:42)",
        ].join("\n\n");
        const drawn = await inPage<{ first: string; second: string; global: string }>(`
        const { h, render } = await import("preact");
        const { Markdown } = await import("/ui.js");
        const DOMPurify = (await import("dompurify")).default;
        const draw = (text) => {
            const box = document.createElement("div");

            render(h(Markdown, { text, cache: false }), box);

            return box.innerHTML;
        };
        // Once, and again with the settings kept from the first: the same words, the same result.
        const first = draw(${JSON.stringify(unsafe)});
        const second = draw(${JSON.stringify(unsafe)});
        const global = DOMPurify.sanitize('<p class="kept">p</p>');

        return JSON.stringify({ first, second, global });
    `);

        assert.equal(drawn.second, drawn.first, "the same result each time");

        for (const gone of [
            "<script",
            "onerror",
            "javascript:",
            "JaVaScRiPt",
            "<iframe",
            "<form",
            "<input",
            "<button",
            "data-part=",
            'class="sheet"',
            "position:fixed",
            'id="app"',
            "data:text/html",
            'data-path="web.env"',
            "file://",
        ]) {
            assert.ok(!drawn.first.includes(gone), `${gone} is taken out`);
        }

        assert.match(
            drawn.first,
            /<img[^>]+src="\/api\/c\/\d+\/file\?path=%2Ftmp%2Fshot\.png"/,
            "a file:// image in Markdown, through the app",
        );
        assert.match(
            drawn.first,
            /<img[^>]+src="\/api\/c\/\d+\/file\?path=%2Ftmp%2Fraw\.png"/,
            "a file:// image in HTML, through the app",
        );
        assert.match(
            drawn.first,
            /href="\.\/app\.ts:42"/,
            "a file path with a line stays a local link",
        );
        assert.match(
            drawn.first,
            /target="_blank" rel="noopener noreferrer"/,
            "links open apart from the app",
        );
        assert.equal(
            drawn.global,
            '<p class="kept">p</p>',
            "the module's own DOMPurify keeps its defaults",
        );
        assert.equal(
            await inPage<unknown>(`return JSON.stringify(window.hit ?? null)`),
            null,
            "nothing ran",
        );
    },
);

test("a group unrolls when a person opens it, not as a session opens", real, async () => {
    await fresh();
    await openFirst();
    // A message, then Pi's calls: the newest group opens by itself as the session shows.
    await settled(`
        const { store } = await import("/store.js");
        const entries = [{ id: 930000, kind: "user", text: "go", images: 0, at: Date.now() }];

        for (let n = 1; n <= 3; n++) {
            entries.push({ id: 930000 + n * 2, kind: "assistant", stopReason: "toolUse", at: Date.now(),
                blocks: [{ type: "toolCall", id: "u" + n, name: "bash", args: { command: "echo " + n } }] });
            entries.push({ id: 930001 + n * 2, kind: "toolResult", callId: "u" + n, text: String(n), at: Date.now() });
        }

        entries.push({ id: 930100, kind: "assistant", stopReason: "stop", at: Date.now(),
            blocks: [{ type: "text", text: "Done." }] });
        store.set((state) => ({ transcriptFrom: null, view: { ...state.view,
            entries: new Map(entries.map((entry) => [entry.id, entry])),
            order: entries.map((entry) => entry.id),
        } }));

        return "null";
    `);
    await waitFor(
        `return JSON.stringify(document.querySelector(".transcript .activity.open .timeline") !== null)`,
        "the newest group, open",
    );
    const animation = (selector: string) =>
        inPage<string>(`
            const element = document.querySelector(${JSON.stringify(selector)});

            return JSON.stringify(element ? getComputedStyle(element).animationName : "gone");
        `);

    assert.equal(
        await animation(".transcript .activity.open .timeline"),
        "none",
        "open by itself: no unroll",
    );

    // Closed and opened again by a tap: it unrolls.
    await page.evaluate(
        `document.querySelector(".transcript .activity.open .activity-head").click()`,
    );
    await waitFor(
        `return JSON.stringify(document.querySelector(".transcript .activity .timeline") === null)`,
        "the group, closed",
    );
    await page.evaluate(`document.querySelector(".transcript .activity .activity-head").click()`);
    await waitFor(
        `return JSON.stringify(document.querySelector(".transcript .activity.open .timeline") !== null)`,
        "the group, open again",
    );
    assert.equal(
        await animation(".transcript .activity.open .timeline"),
        "unroll",
        "opened by a tap: it unrolls",
    );

    // A step opened by a tap unrolls too.
    await page.evaluate(
        `document.querySelector(".transcript .timeline [data-part~='tool-call'] .step-head").click()`,
    );
    await waitFor(
        `return JSON.stringify(document.querySelector(".transcript .timeline .step-body") !== null)`,
        "the step, open",
    );
    assert.equal(await animation(".transcript .timeline .step-body"), "unroll");
});

test(
    "on a phone, a session opened slides in on its window's mark, with no second entrance",
    real,
    async () => {
        await fresh();
        const seen = await settled<{
            pane: string | null;
            root: string | null;
            transcript: string;
        }>(`
        const { navigate } = await import("/store.js");

        navigate(${Number(first)});

        // The window slides in at once; its column draws once the view comes.
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const pane = document.querySelector(".pane")?.dataset.route ?? null;
        const root = document.documentElement.dataset.route ?? null;

        while (!document.querySelector(".pane > .scroller > .transcript")) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const transcript = getComputedStyle(document.querySelector(".pane > .scroller > .transcript")).animationName;

        return JSON.stringify({ pane, root, transcript });
    `);

        assert.equal(seen.pane, "forward", "the window carries the slide's way");
        assert.equal(seen.root, null, "the page's root does not");
        assert.equal(seen.transcript, "none", "the column does not rise in as well");
        await waitFor(
            `return JSON.stringify(document.querySelector(".pane").dataset.route === undefined)`,
            "the mark gone once the slide ended",
        );
    },
);
