// What arrives after a session is on screen glides to the bottom (`catchUp` in web/transcript.js). It used to jump:
// the catch-up window opened at the switch, so a slow answer landed after it, and a session that opened from the
// server's view never opened one.
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

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

before(async () => {
    if (findBrowser() === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
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

test(
    "a catch-up that arrives after the old window still glides, and does not jump",
    real,
    async () => {
        const id = await newSession(app);

        await say(app, id, "shown first");
        await openOn(id, "shown first");

        // Past the old window, which opened at the switch: 3 s. The rows are on screen, so this still glides.
        const seen = await arrive("late but gliding", 3200);

        assert.equal(seen.glided, true, "the column glides");
        assert.equal(seen.jumped, false, "the scroll does not jump");
        // A first update must not start another deadline that makes a later catch-up or reconnect jump.
        const later = await arrive("later still", 3200);

        assert.equal(later.glided, true, "a later update glides too");
        assert.equal(later.jumped, false, "no deadline can make the next update jump");
    },
);

test("rows that arrive for a session opened from the server glide in", real, async () => {
    const id = await newSession(app);

    await say(app, id, "opened from the server");
    await openOn(id, "opened from the server");

    const seen = await arrive("and then this");

    assert.equal(seen.glided, true, "a session opened from the server glides too");
    assert.equal(seen.jumped, false, "no jump");
});

test(
    "a catch-up taller than the screen glides, and the whole entries after a light view do not jump",
    real,
    async () => {
        const id = await newSession(app);
        const long = (n: number) => `${"a line of a tall catch-up ".repeat(8)}${n}`;

        await say(app, id, long(0));
        await openOn(id, long(0));

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
        // The connection drops and comes back, as after a sleep: the rows are still on screen, and what arrives glides.
        await page.evaluate(`
        const { store } = await import("/store.js");

        store.set({ connection: "closed" });
        store.set({ connection: "open" });

        return "null";
    `);

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

        assert.equal(reloaded.glided, true, "a reload glides what arrives after the cached rows");
        assert.equal(reloaded.jumped, false, "a reload does not jump");
    },
);
