// A catch-up glides to the bottom (`catchUp` in web/transcript.js): the server's first view after kept rows show, or
// after a reconnect, however late it comes. It used to jump: the window opened at the switch. Later updates do not.
import { cleanUp, newSession, openApp, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { App } from "./helpers.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let events: PromiseWithResolvers<void> | undefined;

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

before(async () => {
    if (findBrowser() === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    // `events` holds the server's views, as a slow connection does.
    server = createServer(async (request, response) => {
        if (/^\/api\/(events|poll)/.test(request.url ?? "")) {
            await events?.promise;
        }

        await handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "glide-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            (await inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(store.state.me !== undefined && store.state.sessionsLoaded);
            `)) === true,
        "signed in",
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

/** Open `id` and wait until its transcript shows `text`. */
async function openOn(id: ConversationId, text: string): Promise<void> {
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            (await inPage<boolean>(`
                return JSON.stringify((document.querySelector('[data-part="transcript"]')?.textContent ?? "").includes(${JSON.stringify(text)}));
            `)) === true,
        text,
        20_000,
    );
    await page.evaluate(`
        const scroller = document.querySelector(".pane > .scroller");

        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event("scroll"));

        return "null";
    `);
}

/** The connection drops and comes back, as after a sleep, with a draw between. */
async function reconnect(): Promise<void> {
    await page.evaluate(`
        const { store } = await import("/store.js");

        store.set({ connection: "closed" });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        store.set({ connection: "open" });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        return "null";
    `);
}

/**
 * Add `text` to the session on screen as a new row, the way a view from the server does, and watch for a glide
 * (`column.animate`) against a jump of the scroll. `afterMs` waits first, so the catch-up window can pass.
 */
async function arrive(text: string, afterMs = 0): Promise<{ glided: boolean; jumped: boolean }> {
    return inPage(`
        const { store } = await import("/store.js");
        const scroller = document.querySelector(".pane > .scroller");
        const column = scroller.querySelector('[data-part="transcript"]');
        const animated = column.animate.bind(column);
        let glided = false;

        column.animate = (...args) => {
            glided = true;

            return animated(...args);
        };

        if (${afterMs} > 0) {
            await new Promise((resolve) => setTimeout(resolve, ${afterMs}));
        }

        const before = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        const view = store.state.view;
        const id = "arrived-" + Math.random().toString(36).slice(2);

        store.set({
            view: {
                ...view,
                order: [...view.order, id],
                entries: new Map([...view.entries, [id, { id, kind: "user", text: ${JSON.stringify(text)} }]]),
            },
        });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const after = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

        column.animate = animated;

        return JSON.stringify({ glided, jumped: !glided && before < 40 && after > 80 });
    `);
}

test("a late catch-up glides, and an update after its window does not", real, async () => {
    const id = await newSession(app);

    await say(app, id, "shown first");
    await openOn(id, "shown first");
    await reconnect();

    // Past the old window of 3 s: the first view after the reconnect is still the catch-up.
    const seen = await arrive("late but gliding", 3200);

    assert.equal(seen.glided, true, "the column glides");
    assert.equal(seen.jumped, false, "the scroll does not jump");
    // Past the catch-up's window, an update draws as streaming always did.
    assert.equal(
        (await arrive("later still", 3200)).glided,
        false,
        "a later update does not glide",
    );
});

test(
    "a catch-up taller than the screen glides, and the whole entries after a light view do not jump",
    real,
    async () => {
        const id = await newSession(app);
        const long = (n: number) => `${"a line of a tall catch-up ".repeat(8)}${n}`;

        await say(app, id, long(0));
        await openOn(id, long(0));
        await reconnect();

        const seen = await inPage<{ glided: boolean; jumped: boolean; redraw: boolean }>(`
        const { store } = await import("/store.js");
        const scroller = document.querySelector(".pane > .scroller");
        const column = scroller.querySelector('[data-part="transcript"]');
        const animated = column.animate.bind(column);
        const glides = [];

        column.animate = (...args) => {
            glides.push(args[0]);

            return animated(...args);
        };

        const view = store.state.view;
        const added = [];

        for (let n = 1; n <= 30; n++) {
            const id = "tall-" + n;

            added.push([id, { id, kind: "user", text: ${JSON.stringify(long(1))}.replace(/1$/, String(n)) }]);
        }

        const before = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

        store.set({
            view: {
                ...view,
                order: [...view.order, ...added.map(([id]) => id)],
                entries: new Map([...view.entries, ...added]),
            },
        });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const mid = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        // The light entries, then the same rows whole: a redraw that moves nothing, which must not jump.
        const whole = new Map(store.state.view.entries);

        for (const [id, entry] of added) {
            whole.set(id, { ...entry, whole: true });
        }

        store.set({ view: { ...store.state.view, entries: whole } });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const after = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

        column.animate = animated;

        return JSON.stringify({
            glided: glides.length > 0,
            jumped: glides.length === 0 && before < 40 && mid > 80,
            redraw: Math.abs(after - mid) < 2 || glides.length > 0,
        });
    `);

        assert.equal(seen.glided, true, "a tall catch-up glides");
        assert.equal(seen.jumped, false, "it does not jump");
        assert.equal(seen.redraw, true, "the whole entries do not jump");
    },
);

test("a reader scrolled up keeps the same row when a late catch-up arrives", real, async () => {
    const id = await newSession(app);

    await say(app, id, "a reader's place");
    await openOn(id, "a reader's place");
    await reconnect();
    const displacement = await inPage<number>(`
        const { store } = await import('/store.js');
        const view = store.state.view;
        const extra = Array.from({ length: 40 }, (_, n) => ['reading-' + n, { id: 'reading-' + n, kind: 'user', text: 'Reading row ' + n }]);

        store.set({ view: { ...view, order: [...view.order, ...extra.map(([id]) => id)], entries: new Map([...view.entries, ...extra]) } });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const scroller = document.querySelector('.pane > .scroller');
        const row = document.querySelector('[data-part="prompt-row"]');

        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => setTimeout(resolve, 3200));
        const before = row.getBoundingClientRect().top;
        const current = store.state.view;

        store.set({ view: { ...current, order: [...current.order, 'below-reader'], entries: new Map([...current.entries, ['below-reader', { id: 'below-reader', kind: 'user', text: 'Below the reader' }]]) } });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        return JSON.stringify(row.getBoundingClientRect().top - before);
    `);

    assert.ok(Math.abs(displacement) < 2, "the reader is not moved to the bottom");
});

test(
    "a reconnect, and a reload of a cached session, glide what arrives after the rows show",
    real,
    async () => {
        const id = await newSession(app);

        await say(app, id, "here before the sleep");
        await openOn(id, "here before the sleep");
        // The rows are still on screen after the reconnect, and what arrives glides.
        await reconnect();

        const again = await arrive("after the reconnect");

        assert.equal(again.glided, true, "a reconnect glides");
        assert.equal(again.jumped, false, "a reconnect does not jump");

        // Saved on the device, then a reload: the cached rows show, and what arrives after them glides.
        await until(
            async () =>
                (await inPage<boolean>(`
                const { list } = await import("/session-cache.js");

                return JSON.stringify((await list()).some((each) => each.id === ${Number(id)}));
            `)) === true,
            "saved on the device",
            15_000,
        );
        // The server's view waits, so what arrives first after the cached rows is the catch-up.
        events = Promise.withResolvers();
        await page.reload();
        await until(
            async () =>
                (await inPage<boolean>(`
                return JSON.stringify((document.querySelector('[data-part="transcript"]')?.textContent ?? "").includes("here before the sleep"));
            `)) === true,
            "the cached rows, after the reload",
            20_000,
        );

        const reloaded = await arrive("after the reload");

        events.resolve();
        events = undefined;

        assert.equal(reloaded.glided, true, "a reload glides what arrives after the cached rows");
        assert.equal(reloaded.jumped, false, "a reload does not jump");
    },
);
