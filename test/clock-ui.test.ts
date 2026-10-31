// The times a session shows, in a real browser: a hello the tab handles late (as a tab woken from the background does)
// does not move them.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
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

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "clock-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("a hello handled 3 minutes late leaves the times shown where they were", real, async () => {
    const id = await newSession(app);

    await say(app, id, "what time is it");
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () => (await inPage<string>(PROMPT_TIME)) !== "",
        "the message and its time",
        20_000,
    );

    const before = await inPage<{ time: string; at: number }>(SHOWN);

    // The tab handles the next hello 3 minutes after the server sent it: its clock reads 3 minutes on.
    await page.evaluate(`
        const real = Date.now;

        Date.now = () => real() + 180_000;
    `);
    // The server sends every tab a hello of its own: here for a changed approval rule.
    await app.setApprovalRule(owner(app), "others");
    await until(
        async () =>
            (await inPage<string>(
                `return JSON.stringify((await import("/store.js")).store.state.server?.approvalRule ?? "")`,
            )) === "others",
        "the late hello",
    );

    assert.deepEqual(await inPage<{ time: string; at: number }>(SHOWN), before);
});

/** The time the first message shows. */
const PROMPT_TIME = `return JSON.stringify(document.querySelector(".prompt-time")?.textContent ?? "")`;
/** The time the first message shows, and the moment `fromServer` makes of a fixed server time. */
const SHOWN = `
    const { fromServer } = await import("/seen.js");

    return JSON.stringify({
        time: document.querySelector(".prompt-time")?.textContent ?? "",
        at: fromServer(1_000_000_000_000),
    });
`;
