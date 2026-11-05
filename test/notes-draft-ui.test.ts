// The Notes tab keeps an unsaved edit and its first revision through a closed panel and a reload.
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
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
};
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const sees = (expression: string) =>
    until(
        () => inPage<boolean>(`return JSON.stringify(${expression})`).catch(() => false),
        expression,
        20_000,
    );
const store = `(await import("/store.js"))`;
const box = `document.querySelector("textarea.notes")`;
const notes = () =>
    inPage<[string, boolean]>(`return JSON.stringify([
        ${box}.value,
        document.body.textContent.includes("Use theirs"),
    ])`);
const press = (label: string) =>
    page.evaluate(`[...document.querySelectorAll(".people-content button")]
        .find((button) => button.textContent.trim() === ${JSON.stringify(label)}).click()`);

async function openNotes(id: ConversationId, reload = false): Promise<void> {
    if (reload) {
        await page.navigate(`${base}/s/${id}`);
    } else {
        await page.evaluate(`${store}.navigate(${Number(id)})`);
    }

    await sees(`document.readyState === "complete" && ${store}.store.state.notes !== null`);
    await page.evaluate(`${store}.openSheet({ type: "chat", tab: "notes" })`);
    await sees(`${box} !== null`);
}

async function edit(text: string): Promise<void> {
    await page.evaluate(`${box}.value = ${JSON.stringify(text)};
        ${box}.dispatchEvent(new Event("input", { bubbles: true }))`);
    await sees(`document.body.textContent.includes("unsaved changes")`);
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve));
    base = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "notes-draft-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await sees(`document.readyState === "complete" && ${store}.store.state.me?.id !== undefined`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("an unsaved notes edit outlives the panel and a reload, then asks first", real, async () => {
    const id = await newSession(app);
    const other = await newSession(app);

    await app.collab.saveNotes(id, owner(app), "Saved", 0);
    await openNotes(id);
    await edit("Mine");
    await page.evaluate(`${store}.closeSheet()`);
    await openNotes(other);
    assert.deepEqual(await notes(), ["", false]);
    await app.collab.saveNotes(id, owner(app), "Theirs", 1);
    await openNotes(id, true);
    assert.deepEqual(await notes(), ["Mine", true]);
    await press("Keep mine");
    await sees(`${store}.store.state.notes.text === "Mine"`);
    await edit("Cancel this");
    await press("Cancel");
    await openNotes(id, true);
    assert.deepEqual(await notes(), ["Mine", false]);
});
