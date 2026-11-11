// Session opens share the checked device cache, before `/api/me` on reload and before a switch's server view.
import { cleanUp, newSession, openApp, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { App } from "./helpers.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";
import { json } from "../src/server/http/io.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
    timeout: 45_000,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let meUser: Parameters<App["hello"]>[0] | undefined;
let failModule = false;
let retryMe: { requests: number; user: Parameters<App["hello"]>[0] } | undefined;
const gates = new Map<string, { wait: Promise<void>; release: () => void; entered: boolean }>();

/** Hold a real request at the server, including across a page reload. */
function hold(path: string) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const gate = {
        wait: promise,
        entered: false,
        release: () => {
            gates.delete(path);
            resolve();
        },
    };

    gates.set(path, gate);

    return gate;
}

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
    const source = readFileSync(join(import.meta.dirname, "../web/app.js"), "utf8");
    // Installed before the app's first render on every document. Disable idle read-ahead so the device-only switch
    // really is device-only, not accidentally warmed into tab memory while the test waits.
    const probe = `
        const idle = requestIdleCallback;

        globalThis.requestIdleCallback = (callback, options) => options?.timeout === 1000 ? 0 : idle(callback, options);
        globalThis.openProbe = { boot: false, rows: false };
        new MutationObserver(() => {
            if ([...document.querySelectorAll('[data-part="prompt-row"]')].some((node) => node.getClientRects().length > 0)) {
                openProbe.rows = true;
            }

            if ([...document.querySelectorAll('.boot:not(.inline)')].some((node) => node.getClientRects().length > 0)) {
                openProbe.boot = true;
            }
        }).observe(document, { subtree: true, childList: true, attributes: true });
    `;

    server = createServer(async (request, response) => {
        const path = new URL(request.url ?? "/", "http://test.local").pathname;
        const gate = gates.get(path);

        if (gate !== undefined) {
            gate.entered = true;
            await gate.wait;
        }

        if (failModule && path === "/text-hash.js") {
            response.writeHead(403).end();

            return;
        }

        if (path === "/app.js") {
            response.writeHead(200, {
                "content-type": "text/javascript",
                "cache-control": "no-store",
            });
            response.end(probe + source);

            return;
        }

        if (path === "/api/me" && retryMe !== undefined) {
            const attempt = retryMe;

            attempt.requests++;

            if (attempt.requests === 1) {
                // Give IndexedDB time to paint the early snapshot, then exercise the actual startup retry.
                await new Promise((resolve) => setTimeout(resolve, 1500));
                json(response, 503, { error: "temporarily unavailable" });
            } else {
                json(response, 200, await app.hello(attempt.user));
            }

            return;
        }

        if (path === "/api/me" && meUser !== undefined) {
            json(response, 200, await app.hello(meUser));

            return;
        }

        await handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "open-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await ready();
});

after(async () => {
    for (const gate of gates.values()) {
        gate.release();
    }

    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function ready(): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(`
            const { store } = await import("/store.js");

            return JSON.stringify(store.state.me != null && store.state.sessionsLoaded && store.state.connection === "open");
        `),
        "signed in and connected",
        20_000,
    );
}

/** Open a new document, losing all tab memory. */
async function openOn(id: ConversationId, text: string): Promise<void> {
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await shown(text)).rows, text, 20_000);
    await ready();
}

async function saved(id: ConversationId): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(`
            return JSON.stringify((await (await import("/session-cache.js")).list()).some((each) => each.id === ${Number(id)}));
        `),
        "saved on the device",
        15_000,
    );
}

function shown(
    text: string,
): Promise<{ boot: boolean; loader: boolean; rows: boolean; me: boolean }> {
    return inPage(`
        const { store } = await import("/store.js");
        const transcript = document.querySelector('[data-part="transcript"]');

        return JSON.stringify({
            boot: globalThis.openProbe?.boot ?? false,
            loader: transcript?.querySelector('.loader') != null,
            rows: [...(transcript?.querySelectorAll('[data-part="prompt-row"]') ?? [])].some((row) => row.textContent.includes(${JSON.stringify(text)})),
            me: store.state.me !== undefined,
        });
    `);
}

/** Leave the transcript before changing the device record, so pagehide cannot overwrite the test's record. */
async function leave(): Promise<void> {
    await page.navigate(`${base}/`);
    await ready();
}

test(
    "a cached reload paints rows before /api/me, without ever showing the boot screen",
    real,
    async () => {
        const id = await newSession(app);

        await say(app, id, "kept across the reload");
        await openOn(id, "kept across the reload");
        await saved(id);
        const me = hold("/api/me");

        try {
            await page.reload();
            await until(
                async () => (await shown("kept across the reload")).rows,
                "cached rows",
                15_000,
            );
            const early = await shown("kept across the reload");

            assert.equal(me.entered, true);
            assert.equal(early.me, false, "/api/me is still held");
            assert.equal(early.boot, false, "no static or app boot-screen flash");
            assert.equal(early.rows, true);
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.title-open').disabled)`,
                ),
                true,
                "the session menu waits for /api/me",
            );
        } finally {
            me.release();
        }

        await ready();
        assert.equal((await shown("kept across the reload")).boot, false);
    },
);

test(
    "a reload with no device copy keeps the boot screen until /api/me, then shows rows",
    real,
    async () => {
        const id = await newSession(app);

        await say(app, id, "nothing kept for this one");
        await openOn(id, "nothing kept for this one");
        await leave();
        await inPage(`await (await import('/session-cache.js')).clear(); return 'null';`);
        const me = hold("/api/me");

        try {
            await inPage(`history.replaceState(history.state, '', '/s/${id}'); return 'null';`);
            await page.reload();
            await until(
                async () => (await shown("nothing kept for this one")).boot,
                "the boot screen",
            );
            const early = await shown("nothing kept for this one");

            assert.equal(early.me, false);
            assert.equal(early.rows, false);
        } finally {
            me.release();
        }

        await until(
            async () => (await shown("nothing kept for this one")).rows,
            "the server's rows",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(![...document.querySelectorAll('.boot:not(.inline)')].some((node) => node.getClientRects().length > 0))`,
            ),
            true,
        );
    },
);

test("a switch reads rows kept only on the device before the server answers", real, async () => {
    const first = await newSession(app);
    const second = await newSession(app);

    await say(app, first, "in memory");
    await say(app, second, "only on the device");
    await openOn(second, "only on the device");
    await saved(second);
    // A new document has never shown second and cannot read it ahead (the probe disables idle read-ahead).
    await openOn(first, "in memory");
    const switched = hold("/api/switch");

    try {
        await inPage(
            `openProbe.boot = false; (await import('/store.js')).navigate(${Number(second)}); return 'null';`,
        );
        await until(async () => (await shown("only on the device")).rows, "the device's rows");
        await until(() => switched.entered, "the held switch request");
        assert.equal((await shown("only on the device")).boot, false);
    } finally {
        switched.release();
    }
});

test(
    "an uncached switch keeps its header and a quiet loader, then fills the same pane",
    real,
    async () => {
        const first = await newSession(app);
        const second = await newSession(app);

        await say(app, first, "the one on screen");
        await say(app, second, "not kept anywhere");
        await openOn(first, "the one on screen");
        await until(
            async () =>
                await inPage<boolean>(`
        return JSON.stringify((await import('/store.js')).store.state.sessions.some((each) => each.id === ${Number(second)}));
    `),
            "the session list",
        );
        const switched = hold("/api/switch");

        try {
            await inPage(`
            const { store, navigate } = await import('/store.js');

            globalThis.expectedTitle = store.state.sessions.find((each) => each.id === ${Number(second)}).title;
            openProbe.boot = false;
            navigate(${Number(second)});

            return 'null';
        `);
            await until(() => switched.entered, "the held switch request");
            const waiting = await shown("not kept anywhere");

            assert.equal(waiting.boot, false);
            assert.equal(waiting.rows, false);
            assert.equal(waiting.loader, true);
            assert.equal(
                await inPage<boolean>(`
            return JSON.stringify(document.querySelector('[data-part="topbar-title"]').textContent === expectedTitle);
        `),
                true,
                "the session's own header shows",
            );
            await inPage(
                `globalThis.waitingPane = document.querySelector('.pane'); return 'null';`,
            );
        } finally {
            switched.release();
        }

        await until(async () => (await shown("not kept anywhere")).rows, "the server's rows");
        const late = await shown("not kept anywhere");

        assert.equal(late.boot, false);
        assert.equal(late.loader, false);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.pane') === waitingPane)`,
            ),
            true,
        );
    },
);

test(
    "Wait for updates still holds a changed tab-memory view until the server answers",
    real,
    async () => {
        const first = await newSession(app);
        const second = await newSession(app);

        await say(app, first, "waited-for rows");
        await say(app, second, "the other session");
        await openOn(first, "waited-for rows");
        await inPage(`(await import('/store.js')).navigate(${Number(second)}); return 'null';`);
        await until(async () => (await shown("the other session")).rows, "the other session");
        const switched = hold("/api/switch");

        try {
            await inPage(`
            const { store, navigate } = await import('/store.js');
            const { setPrefs } = await import('/theme.js');

            setPrefs({ waitForUpdates: true });
            store.set({ sessions: store.state.sessions.map((each) => each.id === ${Number(first)} ? { ...each, busy: true } : each) });
            navigate(${Number(first)});

            return 'null';
        `);
            await until(() => switched.entered, "the held switch");
            assert.equal((await shown("waited-for rows")).rows, false);
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.pane .boot.inline') !== null)`,
                ),
                true,
            );
        } finally {
            switched.release();
            await inPage(
                `(await import('/theme.js')).setPrefs({ waitForUpdates: false }); return 'null';`,
            );
        }

        await until(async () => (await shown("waited-for rows")).rows, "the complete view");
    },
);

test("another person's device copy is refused before /api/me", real, async () => {
    const id = await newSession(app);

    await say(app, id, "someone else's words");
    await openOn(id, "someone else's words");
    await saved(id);
    await leave();
    await inPage(`
        const cache = await import('/session-cache.js');
        const found = await cache.read(${Number(id)});

        await cache.save(${Number(id)}, found.record, { ...found.info, owner: 'someone-else' }, 100_000_000);

        return 'null';
    `);
    const me = hold("/api/me");

    try {
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () => (await shown("someone else's words")).boot,
            "the refused cache's boot screen",
        );
        const early = await shown("someone else's words");

        assert.equal(early.me, false);
        assert.equal(early.rows, false, "another person's rows are never painted");
    } finally {
        me.release();
    }

    await until(
        async () => (await shown("someone else's words")).rows,
        "the authorized server view",
    );
});

test(
    "the page's cache identity is authenticated, escaped, and absent when caching is off",
    real,
    async () => {
        const user = app.config.users[0]!;
        const original = user.name;
        const cachePolicy = process.env.PI_POCKET_SESSION_CACHE;
        const headers = { authorization: `Bearer ${app.config.ownerToken}` };

        try {
            user.name = "</script><script>not a script</script>";
            const response = await fetch(`${base}/s/1`, { headers });
            const html = await response.text();
            const facts = JSON.parse(html.match(/id="pocket-known">([^<]+)<\/script>/)![1]!);

            assert.equal(facts.user.id, user.id);
            assert.equal(facts.user.name, user.name);
            assert.equal(facts.build, app.build);
            assert.ok(html.includes('<div id="app" hidden>'));
            assert.ok(!html.includes(user.name), "a name cannot close the JSON script tag");
            assert.ok(response.headers.get("content-security-policy")?.includes("'sha256-"));
            assert.ok(!JSON.stringify(facts).includes(app.config.ownerToken));
            assert.ok(
                !(await (await fetch(base)).text()).includes('id="pocket-known"'),
                "signed out has no early identity",
            );
            process.env.PI_POCKET_SESSION_CACHE = "off";
            const disabled = await (await fetch(base, { headers })).text();

            assert.ok(!disabled.includes('id="pocket-known"'));
            assert.ok(!disabled.includes('<div id="app" hidden>'));
        } finally {
            user.name = original;

            if (cachePolicy === undefined) {
                delete process.env.PI_POCKET_SESSION_CACHE;
            } else {
                process.env.PI_POCKET_SESSION_CACHE = cachePolicy;
            }
        }
    },
);

test(
    "/api/me changing the person removes the early view and cannot keep it for a switch",
    real,
    async () => {
        const id = await newSession(app);

        await say(app, id, "the previous person's rows");
        await openOn(id, "the previous person's rows");
        await saved(id);
        const me = hold("/api/me");
        const events = hold("/api/events");
        const poll = hold("/api/poll");

        try {
            await page.reload();
            await until(
                async () => (await shown("the previous person's rows")).rows,
                "the early view",
            );
            meUser = { ...app.config.users[0]!, id: "another-person" };
            me.release();
            await until(
                async () =>
                    await inPage<boolean>(`
            return JSON.stringify((await import('/store.js')).store.state.me?.id === 'another-person');
        `),
                "the changed identity",
            );
            assert.equal((await shown("the previous person's rows")).rows, false);
            assert.equal(
                await inPage<boolean>(`
            return JSON.stringify(!(await (await import('/session-cache.js')).list()).some((each) => each.id === ${Number(id)}));
        `),
                true,
                "the old view was forgotten on the device too",
            );
        } finally {
            meUser = undefined;
            me.release();
            events.release();
            poll.release();
        }
    },
);

for (const changed of [false, true]) {
    test(
        `a startup retry ${changed ? "drops an early snapshot after the person changes" : "keeps a still-usable early snapshot"}`,
        real,
        async () => {
            const id = await newSession(app);
            const text = `rows retained through a startup failure (${changed})`;

            await say(app, id, text);
            await openOn(id, text);
            await saved(id);
            const events = hold("/api/events");
            const poll = hold("/api/poll");
            const attempt = {
                requests: 0,
                user: {
                    ...app.config.users[0]!,
                    ...(changed ? { id: "another-person" } : {}),
                },
            };

            try {
                retryMe = attempt;
                await page.reload();
                await until(
                    async () => await inPage<boolean>(`return JSON.stringify(openProbe.rows);`),
                    "the early snapshot was painted",
                );
                await until(() => attempt.requests >= 2, "the automatic startup retry", 15_000);
                await until(async () => (await shown(text)).me, "the retry's identity");
                assert.equal(
                    (await shown(text)).rows,
                    !changed,
                    "revalidation precedes any session connection response",
                );
            } finally {
                retryMe = undefined;
                events.release();
                poll.release();
            }

            await leave();
        },
    );
}

test("a blocked module still reveals the startup error on a signed-in page", real, async () => {
    failModule = true;

    try {
        await page.reload();
        await until(
            async () =>
                await inPage<boolean>(`
            const boot = document.querySelector('#app > .boot.failed');

            return JSON.stringify(boot != null && boot.getClientRects().length > 0 && boot.textContent.includes('did not load'));
        `),
            "the visible startup error",
        );
    } finally {
        failModule = false;
    }
});
