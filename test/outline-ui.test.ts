// An extension's outline of a session, in a real Chromium (`pocket.onConversation`, `messages`, and `reveal`): it hears
// the session change, reads every message a page at a time, and jumps to one the transcript has not loaded yet.
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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
} as const;
const dropIns = join(root, "data", "extensions");
/** More than the newest rows a session opens with (80), so the first messages are not loaded. */
const MESSAGES = 60;

/** What the module heard and read goes on `globalThis`, for the test to read; its `pocket` too. */
const OUTLINE_JS = `export default (pocket) => {
	globalThis.outline = pocket;
	globalThis.heard = [];
	pocket.onConversation((id) => globalThis.heard.push(id));
};
`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;
let other: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(dropIns, "outline.ts"),
        `/** Outline: the session's messages. */\nexport default (_host, web) => { web.client("outline.js", { access: "view" }); };\n`,
    );
    writeFileSync(join(dropIns, "outline.js"), OUTLINE_JS);
    app = await openApp(scriptedModel());
    session = await newSession(app);
    other = await newSession(app);

    for (let index = 1; index <= MESSAGES; index++) {
        await say(app, session, `message ${index}`);
    }

    await app.setExtensionEnabled(owner(app), "outline.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "outline-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(globalThis.outline) && Boolean(document.querySelector(".composer textarea")))`,
            ),
        "the outline's browser module",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("it reads every message a page at a time, oldest first", real, async () => {
    const read = await inPage<{ texts: string[]; ids: string[]; pages: number; from: number }>(`
        let before = null;
        let messages = [];
        let pages = 0;
        let from;

        do {
            const page = await globalThis.outline.messages({ before, limit: 25 });

            from = page.conversationId;
            messages = [...page.messages, ...messages];
            before = page.before;
            pages++;
        } while (before !== null);

        return JSON.stringify({ texts: messages.map((each) => each.text), ids: messages.map((each) => each.id), pages, from });
    `);

    assert.equal(read.from, session);
    assert.equal(read.pages, Math.ceil(MESSAGES / 25));
    assert.deepEqual(
        read.texts,
        Array.from({ length: MESSAGES }, (_, index) => `message ${index + 1}`),
    );
    assert.equal(new Set(read.ids).size, MESSAGES, "each message its own id");
    assert.ok(read.ids.every((id) => typeof id === "string"));
});

test("reveal loads a message the transcript has not, and shows it", real, async () => {
    const first = await inPage<string>(
        `return JSON.stringify((await globalThis.outline.messages({ limit: ${MESSAGES} })).messages[0].id)`,
    );

    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(Boolean(document.getElementById("entry-${first}")))`,
        ),
        false,
        "not loaded as the session opened",
    );
    assert.equal(
        await inPage<boolean>(`return JSON.stringify(await globalThis.outline.reveal("${first}"))`),
        true,
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(Boolean(document.getElementById("entry-${first}")))`,
        ),
        true,
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(await globalThis.outline.reveal("999999999"))`,
        ),
        false,
        "not in this session",
    );
    assert.equal(
        await inPage<string>(
            `try { globalThis.outline.reveal("nope"); return JSON.stringify("no throw"); } catch (error) { return JSON.stringify(error.message); }`,
        ),
        "pocket.reveal: give it the id of a message",
    );
});

test("it hears the session change, and a page tells which session it is from", real, async () => {
    assert.deepEqual(await inPage<number[]>(`return JSON.stringify(globalThis.heard)`), [session]);
    await inPage(`globalThis.outline.openConversation(${other}); return "null"`);
    await until(
        async () =>
            (await inPage<number[]>(`return JSON.stringify(globalThis.heard)`)).length === 2,
        "the change",
    );
    assert.deepEqual(await inPage<number[]>(`return JSON.stringify(globalThis.heard)`), [
        session,
        other,
    ]);

    const page = await inPage<{ from: number; count: number }>(
        `const page = await globalThis.outline.messages(); return JSON.stringify({ from: page.conversationId, count: page.messages.length })`,
    );

    assert.deepEqual(page, { from: other, count: 0 });
});
