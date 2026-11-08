// Reply's quotes in the session's message box, in a real Chromium: they stack in the box's text, each stays one piece
// under real keys (typing in it goes under it, two Backspaces or its × remove it), a reload keeps them, and what goes
// to Pi is the text as written.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
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

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const STORE = "(await import('/store.js'))";
const BOX = ".composer textarea";

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(`return JSON.stringify(${script})`)) as T;
const see = (condition: string, what: string) =>
    until(() => inPage<boolean>(`Boolean(await (async () => ${condition})())`), what, 20_000);
const boxText = () => inPage<string>(`document.querySelector('${BOX}').value`);
/** The caret into the box at `at` (from the end when negative). */
const caretAt = (at: number) =>
    // After the frames the box's own caret moves wait for.
    page.evaluate(`await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const box = document.querySelector('${BOX}');
        box.focus();
        const at = ${at} < 0 ? box.value.length + ${at} + 1 : ${at};
        box.setSelectionRange(at, at);`);

const reply = async (passage: string) => {
    const before = await boxText();

    await page.evaluate(`${STORE}.quoteReply(${JSON.stringify(passage)})`);
    await see(
        `document.querySelector('${BOX}').value !== ${JSON.stringify(before)}`,
        "the quote in",
    );
};

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    session = await newSession(app);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "quote-box-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1280, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await see(
        `document.querySelector('${BOX}') !== null && ${STORE}.store.state.streamId`,
        "the box",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "Reply stacks quotes in the box, each one piece, and Pi gets the text as written",
    real,
    async () => {
        await caretAt(0);
        await page.type(undefined, "first", { append: true });
        await reply("one passage");
        await page.type(undefined, "yes", { append: true });
        await reply("another");
        assert.equal(await boxText(), "first\n\n> one passage\n\nyes\n\n> another\n\n");
        assert.equal(
            await inPage(`document.querySelector('.quote-count strong').textContent`),
            "2",
        );
        // Each quote drawn, with its ×, in Fade unless chosen otherwise.
        assert.equal(await inPage(`document.querySelectorAll('.quote-remove').length`), 2);
        assert.equal(
            await inPage(`document.querySelector('.composer').dataset.quoteStyle`),
            "fade",
        );

        // Typing inside a quote writes on the line under it instead.
        await caretAt("first\n\n> one".length);
        await page.type(undefined, "x", { append: true });
        assert.equal(await boxText(), "first\n\n> one passage\n\nxyes\n\n> another\n\n");

        // Backspace under a quote marks it, and a second removes it.
        await caretAt(-1);
        await page.press("Backspace");
        await see(`document.querySelector('.quote-line.marked') !== null`, "marked");
        assert.equal(await boxText(), "first\n\n> one passage\n\nxyes\n\n> another\n\n");
        await page.press("Backspace");
        assert.equal(await boxText(), "first\n\n> one passage\n\nxyes\n\n");

        // A reload keeps the quote a piece.
        await page.navigate(`${base}/s/${session}`);
        await see(
            `document.querySelectorAll('.quote-remove').length === 1`,
            "the quote after a reload",
        );
        await caretAt("first\n\n> one".length);
        await page.type(undefined, "y", { append: true });
        assert.equal(await boxText(), "first\n\n> one passage\n\nyxyes\n\n");

        await caretAt(-1);
        await page.press("Enter");
        await see(`document.querySelector('${BOX}').value === ''`, "sent");
        await until(
            async () =>
                (await app.transcripts.allEntries(session, true)).some(
                    (entry) =>
                        entry.kind === "user" &&
                        entry.text.includes("first\n\n> one passage\n\nyxyes"),
                ),
            "Pi got the text as written",
        );
        await see(`document.querySelector('.quote-count') === null`, "no quotes left");
    },
);

test(
    "Separate: Reply stacks strips over the box, a reload keeps them, and they go first",
    real,
    async () => {
        await page.evaluate(`(await import('/theme.js')).setPrefs({ quoteStyle: 'separate' })`);
        await page.evaluate(`${STORE}.quoteReply('strip one')`);
        await page.evaluate(`${STORE}.quoteReply('strip two')`);
        await see(`document.querySelectorAll('.quote-strip').length === 2`, "two strips");
        assert.equal(await boxText(), "", "the box keeps only its words");
        await page.click({ selector: ".quote-strip button" });
        await see(`document.querySelectorAll('.quote-strip').length === 1`, "one removed");
        await page.evaluate(`${STORE}.quoteReply('strip three')`);

        await page.navigate(`${base}/s/${session}`);
        await see(
            `[...document.querySelectorAll('.quote-strip-text')].map((each) => each.textContent).join() === 'strip two,strip three'`,
            "the strips after a reload",
        );
        await caretAt(0);
        await page.type(undefined, "both", { append: true });
        await page.press("Enter");
        await see(`document.querySelector('.quote-strip') === null`, "sent");
        await until(
            async () =>
                (await app.transcripts.allEntries(session, true)).some(
                    (entry) =>
                        entry.kind === "user" &&
                        entry.text.includes("> strip two\n\n> strip three\n\nboth"),
                ),
            "Pi got the strips first",
        );
        await page.evaluate(`(await import('/theme.js')).setPrefs({ quoteStyle: 'fade' })`);
    },
);

test("its × removes one quote; one typed by hand is plain text", real, async () => {
    await reply("drop me");
    await page.type(undefined, "keep", { append: true });
    await page.click({ selector: ".quote-remove" });
    assert.equal(await boxText(), "keep");

    await caretAt(0);
    await page.type(undefined, "> mine\n\nok", { append: true });
    await caretAt(3);
    await page.type(undefined, "z", { append: true });
    assert.equal(await boxText(), "> mzine\n\nokkeep");
    assert.equal(await inPage(`document.querySelector('.quote-count')`), null);
});
