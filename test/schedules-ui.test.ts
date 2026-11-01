// The Schedules sheet marks the schedules of an archived session.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script));

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("done")])));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "schedules-ui-")),
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

test("a schedule of an archived session is marked in the Schedules sheet", real, async () => {
    const id = await newSession(app);

    await app.commands.schedule(id, owner(app), { when: "every 20m ping", zone: "UTC" });
    await app.commands.updateSession(id, owner(app), { archived: true });
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            await inPage<boolean>(`
                const { store, openSheet } = await import("/store.js");
                if (store.state.sessions.length === 0) return JSON.stringify(false);
                openSheet({ type: "schedules" });
                return JSON.stringify(document.querySelector(".schedule") !== null);
            `),
        "the sheet",
        20_000,
    );
    assert.match(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".schedule").textContent)`,
        ),
        /session archived/,
    );
});
