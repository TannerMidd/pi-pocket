// The session list lets go of old app trees: switching sessions leaves no detached transcript alive.
import { type App, cleanUp, newSession, openApp, root, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false } as const;
const ids: ConversationId[] = [];
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());

    for (let at = 0; at < 3; at++) {
        const id = await newSession(app);

        ids.push(id);
        await say(app, id, `hello ${at}`);
    }

    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "session-list-leak-ui-")),
        load: async () => undefined,
        save: () => {},
        args: ["--js-flags=--expose-gc"],
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    const port = (server.address() as { port: number }).port;

    await page.navigate(
        `http://127.0.0.1:${port}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${ids[0]}`,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("switching sessions leaves no detached transcript alive", real, async () => {
    const alive = await page.evaluate(`
        const { navigate } = await import("/store.js");
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const seen = [];

        await wait(1500);

        for (let at = 0; at < 50; at++) {
            navigate(${JSON.stringify(ids)}[at % 3]);
            await wait(100);
            const found = document.querySelector("main.scroller");

            if (found && !found.dataset.seen) {
                found.dataset.seen = "1";
                seen.push(new WeakRef(found));
            }
        }

        navigate(${ids[0]});
        await wait(500);
        gc();
        await wait(300);
        gc();
        await wait(300);

        return JSON.stringify(seen.filter((ref) => ref.deref()?.isConnected === false).length);
    `);

    assert.ok(Number(alive) <= 2, `${alive} of 50 switched-away transcripts are still in memory`);
});
