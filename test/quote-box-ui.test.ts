// Reply's quotes in the session's message box, in a real Chromium: they stack in the box's text, each stays one piece
// under real keys (typing in it goes under it, two Backspaces or its × remove it), a reload keeps them, and what goes
// to Pi is the text as written.
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
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
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

    // A file to name with @.
    writeFileSync(join(work, "noted.txt"), "hi");
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

// Each test starts from an empty box in Fade, whatever the one before left.
beforeEach(async () => {
    if (real.skip) {
        return;
    }

    await page.evaluate(`(await import('/theme.js')).setPrefs({ quoteStyle: 'fade' });
        const { personStorage } = await import('/person-storage.js');
        for (const key of ['draft', 'quotes', 'quoteStrips']) personStorage.set(key + '.${session}', null);`);
    await page.navigate(`${base}/s/${session}`);
    await see(`document.querySelector('${BOX}')?.value === ''`, "an empty box");
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
        assert.equal(await boxText(), "first\n> one passage\nyes\n> another\n");
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
        await caretAt("first\n> one".length);
        await page.type(undefined, "x", { append: true });
        assert.equal(await boxText(), "first\n> one passage\nxyes\n> another\n");

        // Backspace under a quote marks it, and a second removes it.
        await caretAt(-1);
        await page.press("Backspace");
        await see(`document.querySelector('.quote-block.marked') !== null`, "marked");
        assert.equal(await boxText(), "first\n> one passage\nxyes\n> another\n");
        await page.press("Backspace");
        assert.equal(await boxText(), "first\n> one passage\nxyes");

        // A reload keeps the quote a piece.
        await page.navigate(`${base}/s/${session}`);
        await see(
            `document.querySelectorAll('.quote-remove').length === 1`,
            "the quote after a reload",
        );
        await caretAt("first\n> one".length);
        await page.type(undefined, "y", { append: true });
        assert.equal(await boxText(), "first\n> one passage\nyxyes");

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
    },
);

test("a quote does not go with a command: a shell command stays as typed", real, async () => {
    await caretAt(0);
    await page.type(undefined, "!printf safe", { append: true });
    await reply("marker");
    await page.press("Enter");
    await see(
        `[...document.querySelectorAll('.toast, [role=status]')].some((each) => each.textContent.includes('A quote cannot go with a command'))`,
        "the notice",
    );
    assert.equal(await boxText(), "!printf safe\n> marker\n", "nothing went");
    assert.equal(await inPage(`${STORE}.store.state.pendingShells.length`), 0);
});

test("the drawing follows the box when a file row comes in over it", real, async () => {
    await reply("over a file");
    const gap = () =>
        inPage<number>(`(() => {
            const box = document.querySelector('${BOX}').getBoundingClientRect();
            const drawing = document.querySelector('.quote-box-drawing').getBoundingClientRect();
            return Math.round(Math.abs(drawing.top - box.top));
        })()`);

    assert.ok((await gap()) <= 1);
    // A file attached: its row comes in over the text, which moves down without changing size.
    await page.evaluate(`const input = document.querySelector('.composer input[type=file]');
        const data = new DataTransfer();
        data.items.add(new File(['hello'], 'note.txt', { type: 'text/plain' }));
        input.files = data.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));`);
    await see(`document.querySelector('.composer .files') !== null`, "the file row");
    await until(async () => (await gap()) <= 1, "the drawing moved with the box");
    await page.evaluate(`document.querySelector('.composer .files button')?.click()`);
});

test("Replies while a send is on its way all come in after it, in order", real, async () => {
    // The send held on its way: its words stay in the box, read only, until it went.
    await page.evaluate(`window.realFetch = window.fetch;
        window.releaseSend = null;
        window.fetch = (url, init) => String(url).includes('/submit')
            ? new Promise((resolve) => { window.releaseSend = () => resolve(window.realFetch(url, init)); })
            : window.realFetch(url, init);`);
    await caretAt(0);
    await page.type(undefined, "held", { append: true });
    await page.press("Enter");
    await see(`window.releaseSend !== null`, "the send held");
    await page.evaluate(
        `${STORE}.quoteReply('first waiting'); ${STORE}.quoteReply('second waiting');`,
    );
    assert.equal(await boxText(), "held");
    await page.evaluate(`window.releaseSend(); window.fetch = window.realFetch;`);
    await see(
        `document.querySelector('${BOX}').value === '> first waiting\\n\\n> second waiting\\n'`,
        "both quotes, after the send went",
    );
    assert.equal(await inPage(`document.querySelectorAll('.quote-remove').length`), 2);
});

test("a quote taken out by the box's own editing comes back a piece with undo", real, async () => {
    await reply("one");
    await page.type(undefined, "hello", { append: true });
    await page.press("Control+a");
    await page.press("Delete");
    await see(`document.querySelector('${BOX}').value === ''`, "all deleted");
    await page.press("Control+z");
    await see(`document.querySelector('${BOX}').value === '> one\\nhello'`, "undone");
    await see(`document.querySelectorAll('.quote-remove').length === 1`, "the piece back");
});

test("dictation with the caret in a quote writes under it", real, async () => {
    await reply("one");
    await page.evaluate(`window.heard = [];
        globalThis.SpeechRecognition = class {
            constructor() { window.heard.push(this); }
            start() {}
            stop() {}
            abort() {}
        };`);
    await caretAt(3);
    await page.evaluate(`(await import('/voice.js')).toggleDictation();
        window.heard.at(-1).onresult({ results: [{ 0: { transcript: 'words' }, isFinal: true }] });
        (await import('/voice.js')).toggleDictation();`);
    assert.equal(await boxText(), "> one\nwords");
    assert.equal(await inPage(`document.querySelectorAll('.quote-remove').length`), 1);
    await page.evaluate(`delete globalThis.SpeechRecognition`);
});

test("an @ inside a quote is the passage's: no files to pick there", real, async () => {
    // In the person's own words, the picker shows.
    await page.type(undefined, "@note", { append: true });
    await see(`document.querySelector('.file-options') !== null`, "the picker for one's own words");
    await page.press("Escape");
    await page.evaluate(
        `const box = document.querySelector('${BOX}'); box.select(); document.execCommand('delete');`,
    );
    await reply("see @note");
    await caretAt("> see @note".length);
    await page.press("ArrowLeft");
    await page.press("ArrowRight");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await inPage(`document.querySelector('.file-options')`), null);
});

test("a paste inside a quote, short or long, goes under it", real, async () => {
    await reply("one");
    await page.type(undefined, "mine", { append: true });

    // The real clipboard and Ctrl+V: what a person does, with its paste and beforeinput events.
    const paste = async (value: string) => {
        await page.evaluate(`await navigator.clipboard.writeText(${JSON.stringify(value)})`);
        await caretAt(3);
        await page.press("Control+v");
    };

    await paste("short");
    assert.equal(await boxText(), "> one\nshortmine");
    await paste("x".repeat(2100));
    assert.equal(await boxText(), "> one\n[Pasted text #1 · 2100 characters]shortmine");
    assert.equal(await inPage(`document.querySelectorAll('.quote-remove').length`), 1);
});

test("typing moved under a quote can be undone", real, async () => {
    await reply("one");
    await page.type(undefined, "yes", { append: true });
    await caretAt(3);
    await page.type(undefined, "x", { append: true });
    assert.equal(await boxText(), "> one\nxyes");
    await page.press("Control+z");
    assert.equal(await boxText(), "> one\nyes");
});

test(
    "quotes removed by × or Clear quotes come back pieces with undo, and the next key does not type over them",
    real,
    async () => {
        await reply("zero");
        await reply("one");
        await page.type(undefined, "hello", { append: true });
        await page.click({ selector: ".quote-remove" });
        assert.equal(await boxText(), "> one\nhello");
        await page.click({ label: "Remove quote" });
        assert.equal(await boxText(), "hello");
        await caretAt(-1);
        await page.press("Control+z");
        assert.equal(await boxText(), "> one\nhello");
        await page.press("Control+z");
        assert.equal(await boxText(), "> zero\n\n> one\nhello");
        assert.deepEqual(
            await inPage(
                `(() => { const box = document.querySelector('${BOX}'); return [box.selectionStart === box.selectionEnd, document.querySelectorAll('.quote-remove').length]; })()`,
            ),
            [true, 2],
        );
        await page.type(undefined, "x", { append: true });
        assert.ok((await boxText()).startsWith("> zero\n\n> one\n"), "the quotes are still there");
    },
);

test(
    "one quote is one block, its empty lines in it, its mark shown once, with no stray line under it",
    real,
    async () => {
        await reply("first line\n\nthird line");
        assert.equal(await boxText(), "> first line\n>\n> third line\n");
        assert.equal(await inPage(`document.querySelectorAll('.quote-block').length`), 1);
        assert.equal(
            await inPage(`document.querySelectorAll('.quote-block .quote-line').length`),
            3,
        );
        assert.deepEqual(
            await inPage(
                `[...document.querySelectorAll('.quote-line-mark')].map((mark) => getComputedStyle(mark).color === 'rgba(0, 0, 0, 0)')`,
            ),
            [false, true, true],
        );
    },
);

test("Appearance picks each look for the quotes in the box", real, async () => {
    await reply("styled");
    await page.evaluate(`(await import('/store.js')).openSheet({ type: 'appearance' })`);

    for (const [label, style] of [
        ["Tint", "tint"],
        ["Ghost", "ghost"],
        ["Fade", "fade"],
    ] as const) {
        await page.click({ label });
        await see(`document.querySelector('.composer').dataset.quoteStyle === '${style}'`, style);
    }

    await page.click({ label: "Separate" });
    await see(`document.querySelector('.composer').dataset.quoteStyle === undefined`, "separate");
    await page.press("Escape");

    // A saved look this version does not know shows as Fade.
    await page.evaluate(`(await import('/theme.js')).setPrefs({ quoteStyle: 'bogus' })`);
    await see(
        `document.querySelector('.composer').dataset.quoteStyle === 'fade'`,
        "fade for an unknown one",
    );
});
