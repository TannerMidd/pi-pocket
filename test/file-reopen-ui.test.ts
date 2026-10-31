import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

const notes = join(work, "reopen-notes.txt");

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string, timeoutMs = 10_000) =>
    until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

const shows = (text: string) =>
    see(
        `return JSON.stringify(document.querySelector(".file-view")?.textContent.includes(${JSON.stringify(text)}) === true)`,
        `the viewer to show ${text}`,
    );

async function opened(viewport: (typeof VIEWPORTS)[keyof typeof VIEWPORTS]) {
    const id = await newSession(app);

    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${id}`);
    await see(
        `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
        "the session",
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(work, { recursive: true });
    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "file-reopen-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("opening the file that the sheet shows reads it again", real, async () => {
    writeFileSync(notes, "first text\n");
    await opened(VIEWPORTS.mobile);
    await inPage(`(await import("/ui.js")).openFile(${JSON.stringify(notes)}); return "null";`);
    await shows("first text");

    writeFileSync(notes, "second text\n");
    await inPage(`(await import("/ui.js")).openFile(${JSON.stringify(notes)}); return "null";`);
    await shows("second text");
});

test("opening the file that the Files tile shows reads it again", real, async () => {
    writeFileSync(notes, "tile first\n");
    await opened(VIEWPORTS.desktop);
    await inPage(`(await import("/files-panel.js")).setFilesOpen(true, "files"); return "null";`);
    await see(
        `return JSON.stringify(document.querySelector(".ft-view, .files-panel, .ft-row") !== null)`,
        "the tile",
    );
    await inPage(`(await import("/ui.js")).openFile(${JSON.stringify(notes)}); return "null";`);
    await shows("tile first");

    writeFileSync(notes, "tile second\n");
    await inPage(`(await import("/ui.js")).openFile(${JSON.stringify(notes)}); return "null";`);
    await shows("tile second");
    assert.equal(
        await inPage(`return JSON.stringify(document.querySelectorAll(".file-view").length)`),
        1,
    );
});
