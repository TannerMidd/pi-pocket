// The session list lets go of old app trees: switching sessions leaves no detached transcript alive.
import { type App, cleanUp, newSession, openApp, root, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false } as const;
const host = "127.0.0.1";
const ids: number[] = [];
let app: App, server: Server, browsers: Browsers, url: string;

before(async () => {
    app = await openApp(scriptedModel());

    for (const at of [0, 1, 2]) {
        ids.push(await newSession(app));
        await say(app, ids[at] as never, `hello ${at}`);
    }

    server = createServer(createHandler({ app, listen: { host, port: 0 }, restart() {} }));
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const token = encodeURIComponent(app.config.ownerToken);
    const [dataDir, args] = [`${root}/leak`, ["--js-flags=--expose-gc"]];

    url = `http://${host}:${(server.address() as { port: number }).port}/login?token=${token}`;
    browsers = new Browsers({ dataDir, load: async () => undefined, save() {}, args });
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.close();
    await app?.close();
    cleanUp();
});

for (const [at, start] of ["a session", "the list"].entries()) {
    test(`switching sessions after a start on ${start} frees the transcripts`, real, async () => {
        const page = await browsers.open(at + 1);

        await page.navigate(`${url}&next=${at === 0 ? `/s/${ids[0]}` : "/"}`);
        const alive = await page.evaluate(`
            const { navigate } = await import("/store.js");
            const refs = [], wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            await wait(1500);
            for (let at = 0; at <= 50; at++) {
                navigate([${ids}][at % 3]);
                await wait(100);
                refs.push(new WeakRef(document.querySelector("main.scroller") ?? {}));
            }
            for (const ms of [500, 300, 300]) (await wait(ms), gc());
            const old = refs.map((ref) => ref.deref()).filter((each) => each?.isConnected === false);
            return JSON.stringify(new Set(old).size);
        `);

        assert.ok(Number(alive) <= 2, `${alive} old transcripts are still in memory`);
    });
}
