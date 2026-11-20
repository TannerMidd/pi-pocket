// A tab whose event stream goes quiet past its pings connects again, though the stream never reports an error (#334).
import { type App, cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false } as const;
const host = "127.0.0.1";
let app: App, server: Server, browsers: Browsers, url: string;

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(createHandler({ app, listen: { host, port: 0 }, restart() {} }));
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const token = encodeURIComponent(app.config.ownerToken);

    url = `http://${host}:${(server.address() as { port: number }).port}/login?token=${token}`;
    browsers = new Browsers({ dataDir: `${root}/stream`, load: async () => undefined, save() {} });
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.close();
    await app?.close();
    cleanUp();
});

test("a stream that misses its pings is replaced", real, async () => {
    const page = await browsers.open(1);

    await page.navigate(url);
    const streams = await page.evaluate(`
        const { connect } = await import("/store.js");
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const made = [], Real = EventSource;
        globalThis.EventSource = class extends Real { constructor(...a) { super(...a); made.push(this); } };
        await wait(1000);
        connect();
        await wait(1000);
        // A ping says the server pings every 200 ms; then the stream stays quiet, as a half-open one does.
        made[0].dispatchEvent(new MessageEvent("ping", { data: '{"every":200}' }));
        await wait(1500);
        return JSON.stringify(made.length);
    `);

    assert.ok(Number(streams) >= 2, `${streams} streams: the quiet one was kept`);
});
