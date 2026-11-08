// Appearance → PiP: Floating (the corner, or a phone's sheet) or Board (PiP's conversation in the
// session's place), in an isolated real browser with a scripted model.
import {
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const STORE = "(await import('/store.js'))";
const PIP = "(await import('/pip.js'))";
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let pip: ConversationId;
let background: ConversationId;
/** The newest request the model got, as JSON: what PiP was told. */
let lastAsked = "";
/** What the model waits for before it answers: a test keeps Pi working with it. */
let thinking = Promise.resolve();
const project = join(work, "project-board");

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(`return JSON.stringify(${script})`)) as T;
const see = (condition: string, what: string) =>
    until(() => inPage<boolean>(`Boolean(await (async () => ${condition})())`), what, 20_000);
const settle = () =>
    page.evaluate(`
        await Promise.all(document.getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
            .map((animation) => animation.finished.catch(() => {})));
        await new Promise((resolve) => setTimeout(resolve, 100));
    `);

/** PiP's own box as a board, in the session's place. */
const BOARD_BOX = ".pane .pip-composer textarea";
/** A session's own box. */
const BOX = ".pane .composer textarea";
/** PiP as a board: its conversation in the session's place, with its own box (no session box) and a ×, and no panel. */
const boarded = (what: string) =>
    see(
        `${STORE}.store.state.view.conversation?.id === ${Number(pip)} &&
            ${PIP}.pipBoard() && !${STORE}.store.state.pipOpen &&
            document.querySelector('.pane .topbar [aria-label="Close PiP"]') !== null &&
            document.querySelector('${BOARD_BOX}') !== null &&
            document.querySelector('.pane .composer') === null &&
            document.querySelector('.pip-panel:not(.leaving)') === null`,
        what,
    );
/** PiP floating, over the session it left in place. */
const floating = (what: string) =>
    see(
        `${STORE}.store.state.conversationId === ${Number(background)} &&
            document.querySelector('.pip-panel:not(.leaving)') !== null && !${PIP}.pipBoard()`,
        what,
    );
/** PiP in neither place. */
const shut = (what: string) =>
    see(`!${PIP}.pipShown() && document.querySelector('.pip-panel') === null`, what);
/** `id` back in the session's place. */
const backTo = (id: ConversationId, what: string) =>
    see(
        `${STORE}.store.state.conversationId === ${Number(id)} &&
            location.pathname === '/s/${Number(id)}'`,
        what,
    );
/** Type `value` into the box `selector` finds, as a person does. */
const type = (selector: string, value: string) =>
    page.evaluate(`const box = document.querySelector('${selector}');
        box.value = ${JSON.stringify(value)};
        box.dispatchEvent(new Event('input', { bubbles: true }));`);
/** Attach a file through the file input `picker` finds, as the picker does. */
const attach = (picker: string) =>
    page.evaluate(`const data = new DataTransfer();
        data.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
        const picker = document.querySelector('${picker}');
        picker.files = data.files;
        picker.dispatchEvent(new Event('change', { bubbles: true }));`);
const place = (value: "floating" | "board") =>
    page.evaluate(`(await import('/theme.js')).setPrefs({ pip: '${value}' })`);
/** The session the list marks open. */
const markedOpen = () =>
    inPage<number>(
        `Number(document.querySelector('.sidebar .session-row:has([aria-current="page"])')
            ?.dataset.id)`,
    );

/**
 * Run `steps` while each send (`/submit`) waits for `window.release()`, which then sends it (or, with `fail`, fails it).
 * Every send held is let go, and fetch put back, also when a step fails: no test leaves the page stuck.
 */
async function holdingSends(steps: () => Promise<void>, fail = false) {
    await page.evaluate(`
        const real = window.fetch;
        const held = [];
        window.sends = 0;
        window.release = () => held.splice(0).forEach((go) => go());
        window.unhold = () => { window.fetch = real; window.release(); };
        window.fetch = (url, init) => {
            if (!String(url).includes('/submit')) {
                return real(url, init);
            }

            window.sends++;

            return new Promise((resolve) => held.push(() =>
                resolve(${fail} ? new Response('{}', { status: 400 }) : real(url, init))));
        };
    `);

    try {
        await steps();
    } finally {
        await page.evaluate(`window.unhold?.()`);
    }
}

/** Send `words` from the session's box: its request reaches the server (`path`), not its answer. */
async function lost(path: string, words: string) {
    await page.evaluate(`const real = window.fetch;
        window.fetch = async (url, init) => {
            if (!String(url).endsWith('${path}')) {
                return real(url, init);
            }

            window.fetch = real;
            await real(url, init);
            window.lost = true;

            return new Response('{}', { status: 502 });
        };`);
    await type(BOX, words);
    await page.press("Enter");
    await see(`window.lost && !document.querySelector('.pane .send-button').disabled`, "lost");
    await page.evaluate(`window.lost = false`);
}

/** A fresh tab on the background session, PiP closed, in `mode`. */
async function fresh(mode: "floating" | "board", viewport: Viewport = VIEWPORTS.desktop) {
    await page.evaluate(`${STORE}.closeSheet(); ${PIP}.closePip();`);
    await place(mode);
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${background}`);
    await see(`${STORE}.store.state.streamId && ${PIP}.pipAvailable()`, "connected, PiP on");
    await shut("PiP closed at the start");
    await settle();
}

before(async () => {
    if (real.skip) {
        return;
    }

    mkdirSync(project);
    app = await openApp(
        scriptedModel(async (request) => {
            await thinking;
            lastAsked = JSON.stringify((request as { messages: unknown[] }).messages);

            return fauxAssistantMessage([
                fauxText(`PiP heard: ${lastText(request as never).text}`),
            ]);
        }),
    );
    background = await newSession(app, project);
    pip = await app.pip.ensure(owner(app));
    await app.commands.configure(pip, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "pip-board-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`${STORE}.store.state.me?.role === 'owner'`, "owner signed in");
    assert.equal(await inPage(`(await import('/theme.js')).prefs().pip`), "floating");
});

after(async () => {
    try {
        await browsers?.closeAll({ final: true });
    } finally {
        server?.closeAllConnections();
        server?.close();

        try {
            await app?.close();
        } finally {
            cleanUp();
        }
    }
});

test("Board: the ways in open it, and Back, Alt+A, and its × close it", real, async () => {
    await fresh("board");
    await page.click({ selector: ".rail-pip" });
    await boarded("the rail button");
    await page.evaluate(`history.back()`);
    await shut("Back");
    await backTo(background, "the session after Back");

    await page.press("Alt+a");
    await boarded("Alt+A");
    await page.press("Alt+a");
    await shut("Alt+A again");

    // `/pip …` sends, and its answer shows on the board.
    await page.evaluate(`
        const { command, arg } = (await import('/commands.js')).parseCommand('/pip from the slash');
        await command.run(arg);
    `);
    await boarded("/pip with a message");
    await see(`document.querySelector('.pane').textContent.includes('PiP heard:')`, "the answer");
    await page.click({ selector: '.topbar [aria-label="Close PiP"]' });
    await backTo(background, "the session after ×");

    // Text for PiP (`pocket.pip.ask`), then text for the box in the session's place, go into PiP's box there.
    await page.evaluate(`${PIP}.askPipFrom({ module: 'demo' }, 'only for pip', false)`);
    await boarded("pocket.pip.ask");
    await page.evaluate(`${STORE}.insertIntoComposer('and this')`);
    await see(
        `document.querySelector('${BOARD_BOX}').value.includes('only for pip\\n\\nand this')`,
        "in PiP's box",
    );
    await type(BOARD_BOX, "");
    await page.evaluate(`${PIP}.closePip()`);
    await backTo(background, "the session");
    assert.equal(await inPage(`document.querySelector('.pane .composer textarea').value`), "");

    // A notification's link, from a fresh tab at home.
    await page.navigate(`${base}/?pip=1`);
    await boarded("?pip=1");
    await page.evaluate(`${PIP}.closePip()`);
    await see(`location.pathname === '/' && !${PIP}.pipShown()`, "home again");
});

test("Board: the session under it stays marked open, and is where it closes to", real, async () => {
    const other = await newSession(app, work);

    await fresh("board");
    await page.evaluate(`${PIP}.openPip()`);
    await boarded("PiP");
    await see(`document.querySelector('.sidebar .session-row') !== null`, "the list");
    assert.equal(await markedOpen(), Number(background));

    // Kept on PiP's history entry: through a reload, and back to it from another session.
    await page.evaluate(`location.reload()`);
    await boarded("PiP after a reload");
    await see(`document.querySelector('.sidebar .session-row') !== null`, "the list");
    assert.equal(await markedOpen(), Number(background));
    await page.evaluate(`${STORE}.navigate(${Number(other)})`);
    await backTo(other, "another session");
    assert.equal(await markedOpen(), Number(other));
    await page.evaluate(`history.back()`);
    await boarded("PiP again, by back");
    assert.equal(await markedOpen(), Number(background));

    // Running now takes PiP's place.
    await page.click({ selector: ".rail-running" });
    await see(
        `document.querySelector('.running-board') !== null && !${PIP}.pipShown()`,
        "Running now",
    );
    await settle();
    await page.click({ selector: ".rail-pip" });
    await boarded("PiP over Running now");
    await page.evaluate(`${PIP}.closePip()`);
    await backTo(background, "the session it was first opened over");

    // Its Reply quote waits under PiP's board, whose box has PiP's own: a Reply there is PiP's, also before PiP's id
    // comes (after a reload).
    const STRIP = "document.querySelector('.pane .quote-strip-text')?.textContent ?? null";

    await page.evaluate(`${STORE}.quoteReply('under the board')`);
    await page.evaluate(`${PIP}.openPip()`);
    await boarded("PiP over a Reply quote");
    assert.equal(await inPage(STRIP), null, "not over PiP's box");
    await page.evaluate(`${STORE}.store.set({ pip: null }); ${STORE}.quoteReply('on the board')`);
    assert.equal(await inPage(`${STORE}.store.state.pipQuote?.text ?? null`), "on the board");
    await page.evaluate(`${PIP}.closePip()`);
    await see(`${STRIP} === 'under the board'`, "the session's quote again");
});

test("Phones: × closes past the Files tile, and PiP opens again without it", real, async () => {
    const FILES = "(await import('/files-panel.js'))";

    await fresh("board", VIEWPORTS.mobile);
    // The session's own tile, which PiP's closing must not take with it.
    await page.evaluate(`${FILES}.setFilesOpen(true)`);
    await see(`document.querySelector('.files-tile:not(.leaving)') !== null`, "its Files tile");
    await settle();
    await page.evaluate(`${PIP}.openPip()`);
    await boarded("PiP on a phone");
    await page.evaluate(`${FILES}.setFilesOpen(true)`);
    await see(`document.querySelector('.files-tile:not(.leaving)') !== null`, "the Files tile");
    await settle();
    await page.evaluate(`${PIP}.closePip()`);
    await backTo(background, "the session, past the tile");
    await settle();
    assert.equal(await inPage(`${STORE}.store.state.filesOpen`), true, "the session's tile");
    await page.evaluate(`${FILES}.setFilesOpen(false)`);
    await settle();
    await page.evaluate(`${PIP}.openPip()`);
    await boarded("PiP again");
    await settle();
    assert.equal(await inPage(`${STORE}.store.state.filesOpen`), false, "no panel kept for PiP");
    // The one panel an older version kept for the tab: a reload on the board gives it to no one.
    await page.evaluate(`sessionStorage.setItem('pocket.files', '1')`);

    for (const when of ["the update's reload", "another reload"]) {
        await page.evaluate(`location.reload()`);
        await boarded(`PiP after ${when}`);
        await settle();
        assert.equal(await inPage(`${STORE}.store.state.filesOpen`), false, when);
    }

    await page.evaluate(`history.back()`);
    await backTo(background, "Back on a phone");
    await page.setViewport(VIEWPORTS.desktop);
});

test("Phones: the first Ask PiP after a load focuses PiP's box on the board", real, async () => {
    await fresh("board", VIEWPORTS.mobile);
    // Its conversation comes a moment after the route, as a slower connection brings it.
    await page.evaluate(`const real = window.fetch;
        window.fetch = async (url, init) => String(url).endsWith('/switch')
            ? new Promise((go) => setTimeout(go, 300)).then(() => real(url, init))
            : real(url, init);
        ${PIP}.quotePip('focus me', ${Number(background)})`);
    await boarded("PiP");
    await see(`document.activeElement === document.querySelector('${BOARD_BOX}')`, "its box");
    await page.evaluate(`${PIP}.closePip()`);
    await page.setViewport(VIEWPORTS.desktop);
});

test("Changing the setting moves PiP, never into both places", real, async () => {
    const choose = async (value: string) => {
        await see(`document.querySelector('.sheet .segmented') !== null`, "Appearance");
        await page.evaluate(`[...document.querySelectorAll('.sheet .segmented button')]
            .find((button) => button.textContent.trim() === '${value}').click()`);
    };

    await fresh("floating");
    // Home under the session, in this page's history.
    await page.evaluate(`${STORE}.navigate(null); ${STORE}.navigate(${Number(background)})`);
    await backTo(background, "the session again");
    await page.evaluate(`
        window.pipBoth = 0;
        new MutationObserver(() => {
            window.pipBoth += document.querySelector('.topbar [aria-label="Close PiP"]') &&
                document.querySelector('.pip-panel') ? 1 : 0;
        }).observe(document.body, { childList: true, subtree: true });
        ${PIP}.openPip();
    `);
    await floating("floating");
    await place("board");
    await boarded("moved to the board");
    await place("floating");
    await floating("moved back to the corner");

    // Changed and changed back at once: nothing moves.
    await page.evaluate(`
        const { setPrefs } = await import('/theme.js');
        setPrefs({ pip: 'board' });
        setPrefs({ pip: 'floating' });
    `);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await floating("still floating");

    // From Appearance: the sheet that changed it stays, over PiP's board, and over the session back from there.
    await page.evaluate(`${STORE}.openSheet({ type: 'appearance' })`);
    await choose("Board");
    await see(`${STORE}.store.state.conversationId === ${Number(pip)}`, "Board chosen");
    assert.equal(await inPage(`${STORE}.store.state.sheet?.type ?? null`), "appearance");
    await page.evaluate(`${STORE}.closeSheet()`);
    await boarded("on the board");
    await page.evaluate(`${STORE}.openSheet({ type: 'appearance' })`);
    await choose("Floating");
    await floating("Floating chosen");
    assert.equal(await inPage(`${STORE}.store.state.sheet?.type ?? null`), "appearance");
    assert.equal(await inPage(`window.pipBoth`), 0, "never both");
    // No entry of PiP's board is left for back to open again.
    await page.evaluate(`${STORE}.closeSheet(); ${PIP}.closePip()`);
    await shut("closed");
    await settle();
    await page.evaluate(`history.back()`);
    await see(`location.pathname === '/'`, "back past the session");
});

test("Ask PiP: the passage over the board's box, and PiP told its session", real, async () => {
    await fresh("board");
    await page.evaluate(`${PIP}.quotePip('the build is red', ${Number(background)})`);
    await boarded("PiP");
    await see(
        `document.querySelector('.pane .quote-strip-text')?.textContent === 'the build is red'`,
        "the quote over the board's box",
    );
    await type(BOARD_BOX, "why?");
    await page.click({ selector: ".pane .pip-send" });
    await see(`${STORE}.store.state.pipQuote === null`, "sent");
    await until(async () => lastAsked.includes("the build is red"), "PiP asked");
    assert.ok(lastAsked.includes(`<pocket-context session=\\"${Number(background)}`));
    await page.evaluate(`${PIP}.closePip()`);
});

test("PiP's one box: its words, file, quote, and send on its way move with it", real, async () => {
    const shown = (where: string) =>
        inPage(`[document.querySelector('${where} .pip-composer textarea').value,
            document.querySelector('${where} .pip-attachment-name')?.textContent ?? null,
            document.querySelector('${where} .quote-strip-text')?.textContent ?? null,
            document.querySelector('${where} .pip-attachment-remove')?.disabled ?? null]`);

    await fresh("floating");
    await page.evaluate(`${PIP}.quotePip('still red', ${Number(background)})`);
    await floating("in the corner");
    await type(".pip-composer textarea", "half a thought");
    await attach(".pip-file-picker");
    await see(`!document.querySelector('.pip-send').disabled`, "the file uploaded");
    await place("board");
    await boarded("on the board");
    assert.deepEqual(await shown(".pane"), ["half a thought", "notes.txt", "still red", false]);
    // Sent on the board, held until PiP is in the corner, beside a Reply quote of the same words: on its way there too.
    await holdingSends(async () => {
        await page.click({ selector: ".pane .pip-send" });
        await see(`window.sends === 1`, "the send on its way");
        await place("floating");
        await floating("in the corner");
        assert.deepEqual(await shown(".pip-panel"), ["", "notes.txt", null, true], "on its way");
        await page.press("Enter");
        await page.evaluate(`${STORE}.quoteReply('still red'); window.release()`);
    });
    await until(async () => lastAsked.includes("still red"), "PiP asked");
    await see(`document.querySelector('.pip-attachment') === null`, "sent with its file");
    assert.equal(await inPage(`window.sends`), 1, "once");
    assert.equal(await inPage(`${STORE}.store.state.replyQuote?.text`), "still red", "Reply's");
    await page.evaluate(`${PIP}.closePip()`);
});

test(
    "Ask PiP: a failed send gives the words and quote back, wherever PiP shows",
    real,
    async () => {
        await fresh("floating");
        await page.evaluate(`${PIP}.quotePip('try again', ${Number(background)})`);
        await floating("in the corner");
        // The send waits, and then fails, after PiP moved to the board.
        await holdingSends(async () => {
            await type(".pip-composer textarea", "again?");
            await page.click({ selector: ".pip-panel .pip-send" });
            await see(`window.sends === 1`, "the send on its way");
            await place("board");
            await boarded("moved meanwhile");
            assert.equal(
                await inPage(`document.querySelector('.pane .quote-strip') === null`),
                true,
                "on its way",
            );
        }, true);
        await see(
            `document.querySelector('.pane .quote-strip-text')?.textContent === 'try again' &&
            document.querySelector('${BOARD_BOX}').value === 'again?'`,
            "the quote and the words back",
        );
        await page.evaluate(`${PIP}.closePip()`);
    },
);

test(
    "Over PiP's box: Pending memories in both places while one waits, and waiting messages",
    real,
    async () => {
        const COUNT = (where: string) =>
            `document.querySelector('${where} .pip-memory-count')?.textContent.trim()`;

        await fresh("board");
        await page.evaluate(`${PIP}.openPip()`);
        await boarded("PiP");
        await settle();
        assert.equal(await inPage(`${COUNT(".pane")} ?? null`), null, "none waits: no strip");

        const lesson = await app.memory.add(
            background,
            project,
            { userId: owner(app).id, byPi: true, name: "Pi" },
            { text: "Run the board tests alone.", scope: "everywhere" },
        );

        await see(
            `${COUNT(".pane .pip-composer-wrap")} === '1 pending'`,
            "over PiP's box on the board",
        );
        // Over it too: your message that waits while PiP works, as in the panel.
        await page.evaluate(`${STORE}.store.set((state) => ({ view: { ...state.view, inbox: [
        { id: 9001, mode: 'steer', by: '${owner(app).id}', text: 'also this' }] } }))`);
        await see(
            `document.querySelector('.pane .pip-you.pending')?.textContent.includes('also this')`,
            "waiting",
        );
        await place("floating");
        await see(`${COUNT(".pip-panel")} === '1 pending'`, "floating");
        await app.memory.edit(background, owner(app), lesson.id, "discard");
        await see(`document.querySelector('.pip-memory') === null`, "gone once none waits");
        await page.evaluate(`${PIP}.closePip()`);
    },
);

test("PiP turned off in Extensions closes the board", real, async () => {
    await fresh("board");
    await page.evaluate(`${PIP}.openPip()`);
    await boarded("PiP");
    await page.evaluate(`${STORE}.api('extensions/pip.ts', { enabled: false })`);
    await backTo(background, "the session again");
    await page.evaluate(`${STORE}.api('extensions/pip.ts', { enabled: true })`);
    await see(`${PIP}.pipAvailable()`, "PiP on again");
});

test("A session's send on its way, its box shown again: once, or all back", real, async () => {
    // Its words, the quote and file with their ×, Dictate, and Send: what is on its way is locked.
    const LOCKS =
        ".pane .quote-strip button, .pane .files button, .pane .composer-mic, .pane .send-button";
    const held = () =>
        inPage(`[document.querySelector('${BOX}').value,
            document.querySelector('.pane .quote-strip-text')?.textContent ?? null,
            [...document.querySelectorAll(${JSON.stringify(LOCKS)})]
                .map((button) => button.disabled)]`);

    // Away and back while it goes, and Enter again there.
    const awayAndBack = async () => {
        await page.press("Alt+a");
        await boarded("PiP's board over the session");
        await page.press("Alt+a");
        await backTo(background, "the session again");
        await page.press("Enter");
    };

    await fresh("board");
    await page.evaluate(`${STORE}.quoteReply('this part')`);
    // With a space at the end, as a phone's keyboard leaves it.
    await type(BOX, "only once ");
    await attach(".pane .composer input[type=file]");
    await see(
        `document.querySelector('.pane .files .chip:not(:has(.spinner))')`,
        "the file uploaded",
    );
    await holdingSends(async () => {
        await page.press("Enter");
        await see(`window.sends === 1`, "on its way");
        await awayAndBack();
        assert.deepEqual(await held(), ["only once ", "this part", [true, true, true, true]]);
        await type(BOX, "changed");
    }, true);
    await see(`!document.querySelector('.pane .send-button').disabled`, "failed");
    assert.deepEqual(await held(), ["only once ", "this part", [false, false, false, false]]);
    // Sent at last, with words put in the box meanwhile: they stay.
    await holdingSends(async () => {
        await page.press("Enter");
        await see(`window.sends === 1`, "on its way again");
        await awayAndBack();
        await page.evaluate(`${STORE}.insertIntoComposer('and then'); window.release()`);
    });
    await see(`document.querySelector('${BOX}').value === 'and then'`, "sent");
    assert.equal(await inPage(`window.sends`), 1, "once");
});

test("Text put in the box during a send waits for its own session, all of it", real, async () => {
    const other = await newSession(app, work);
    const words = (value: string, what: string) =>
        see(`document.querySelector('${BOX}')?.value === ${JSON.stringify(value)}`, what);

    await fresh("floating");
    await holdingSends(async () => {
        await type(BOX, "going");
        await page.press("Enter");
        await see(`window.sends === 1`, "on its way");
        await page.evaluate(
            `${STORE}.insertIntoComposer('first'); ${STORE}.insertIntoComposer('second')`,
        );
        await page.evaluate(`${STORE}.navigate(${Number(other)})`);
        await backTo(other, "another session");
        await words("", "another session's box, empty");
        await settle();
        await words("", "still empty");
        await page.evaluate(`${STORE}.navigate(${Number(background)}); window.release()`);
    });
    await backTo(background, "its own session");
    await words("first\n\nsecond", "both, in order, in its own box");
    await type(BOX, "");
});

test("A queued message's Edit during a send: kept through a reload or a move", real, async () => {
    const queued = `[...document.querySelectorAll('.pane .queued-text')]
        .find((each) => each.textContent.includes('tell him'))`;
    const EDIT = "document.querySelector('.pane .queued-actions .button')";
    const back = (words: string, what: string) =>
        see(`document.querySelector('${BOX}').value === '${words}'`, what);

    const edit = async (twice = false) => {
        await page.evaluate(`${queued}.click()`);
        await see(EDIT, "its Edit");
        await page.evaluate(`${EDIT}.click()${twice ? `; ${EDIT}.click()` : ""}`);
        await see(`!${queued}`, "taken back");
    };

    let answer = () => {};

    thinking = new Promise((resolve) => (answer = resolve));
    await fresh("board");

    try {
        for (const words of ["start", "tell him hello from me"]) {
            await type(BOX, words);
            await page.press("Enter");
            await back("", `"${words}" went`);
        }

        // Edit while "hello" reaches the server, its answer lost; then a reload. The message waits
        // until "hello", sent again, is known to have gone: it goes once.
        await type(BOX, "hello");
        await page.evaluate(`const real = window.fetch;
            window.fetch = async (url, init) => {
                if (!String(url).includes('/submit')) {
                    return real(url, init);
                }

                window.fetch = real;
                await real(url, init);
                window.reached = true;

                return new Promise(() => {});
            };`);
        await page.press("Enter");
        await see(`window.reached`, "on the server, its answer lost");
        await edit(true);
        await see(`Object.keys(localStorage).some((key) => key.includes(':takenBack.'))`, "kept");
        await page.evaluate(`location.reload()`);
        await see(`${STORE}.store.state.streamId`, "loaded again");
        await back("hello", "only the words of the send");
        await page.press("Enter");
        await back("tell him hello from me", "taken back after a reload");
        assert.deepEqual(await inPage(`${STORE}.store.state.view.inbox.map((i) => i.text)`), [
            "hello",
        ]);
        await page.press("Enter");
        await see(queued, "queued again");

        // Edit, tapped twice, while "hello" goes and fails; the box shown again meanwhile.
        await type(BOX, "hello");
        await holdingSends(async () => {
            await page.press("Enter");
            await see(`window.sends === 1`, "on its way");
            await edit(true);
            await page.press("Alt+a");
            await boarded("PiP's board over the session");
            await page.press("Alt+a");
            await backTo(background, "the session again");
            await page.evaluate(`window.release()`);
        }, true);
        await back("tell him hello from me\\nhello", "taken back after a move");
        await page.press("Enter");
        await see(queued, "queued again");

        // With no send on its way, also when one begins in the frame it comes back in.
        await type(BOX, "x");
        await page.evaluate(`const storage = (await import('/person-storage.js')).personStorage;
            const set = storage.set;
            storage.set = (key, value) => {
                if (key.startsWith('takenBack.') && value !== null) {
                    storage.set = set;
                    setTimeout(() => document.querySelector('.pane .send-button').click());
                }

                return set(key, value);
            };`);
        await edit();
        await see(`${STORE}.store.state.view.inbox.some((item) => item.text === 'x')`, "x went");
        await back("tell him hello from me\\nhello", "taken back, without x");
        assert.deepEqual(
            await inPage(`${STORE}.store.state.notices.map((n) => n.message)`),
            ["HTTP 400"],
            "only the failed send's",
        );
    } finally {
        answer();
    }

    await see(`!${STORE}.store.state.view.live.busy`, "Pi done");
});

test("A `!` command with its answer lost runs once when sent again", real, async () => {
    const ran = join(project, "ran.txt");
    const echo = (word: string) => `!echo ${word} >> ${ran}`;
    const file = () => (existsSync(ran) ? readFileSync(ran, "utf8") : "");

    await fresh("board");
    await lost("/shell", echo("x"));
    // Sent again from its box shown again.
    await page.press("Alt+a");
    await boarded("PiP's board over the session");
    await page.press("Alt+a");
    await backTo(background, "the session again");
    await page.press("Enter");
    await see(`document.querySelector('${BOX}').value === ''`, "sent again");
    // After a lost answer, the same command typed again is a new one, and so is another command.
    await lost("/shell", echo("y"));
    await type(BOX, "");
    await type(BOX, echo("y"));
    await page.press("Enter");
    await until(() => file().endsWith("y\ny\n"), "y typed again ran");
    await type(BOX, echo("z"));
    await page.press("Enter");
    await until(() => file().includes("z"), "z ran");
    assert.equal(file(), "x\ny\ny\nz\n");
});

test("A message goes once: refused, its answer lost to a reload, sent again", real, async () => {
    const sent = async () =>
        (await app.transcripts.allEntries(background, true)).filter(
            (entry) => entry.kind === "user" && entry.text.includes("keep me"),
        ).length;

    // A spend limit refuses it: the server keeps nothing of the request.
    const refused = async () => {
        await app.spend.setSessionBudget(owner(app), background, 0.01);
        await page.press("Enter");
        await see(
            `${STORE}.store.state.notices.some((notice) => notice.message.includes('spend limit'))`,
            "refused",
        );
        await app.spend.setSessionBudget(owner(app), background, null);
    };

    await fresh("board");
    await recordCost(app, background, 0.02);
    await type(BOX, "keep me");
    await refused();

    // The server gets it, and a reload loses its answer (and puts fetch back).
    try {
        await page.evaluate(`const real = window.fetch;
            window.fetch = async (url, init) => String(url).endsWith('/submit')
                ? (await real(url, init), new Promise(() => {}))
                : real(url, init);`);
        await page.press("Enter");
        await until(async () => (await sent()) === 1, "the message there");
    } finally {
        await page.navigate(`${base}/s/${background}`);
    }

    await see(`document.querySelector('${BOX}')?.value === 'keep me'`, "the box after a reload");
    // Refused when sent again, then sent: it went before, so it goes once.
    await refused();
    await page.press("Enter");
    await see(`document.querySelector('${BOX}').value === ''`, "sent again");
    assert.equal(await sent(), 1, "once");
    // Known sent: the same words again are a new message.
    await type(BOX, "keep me");
    await page.press("Enter");
    await until(async () => (await sent()) === 2, "a new message");
    // After a lost answer, the same words typed again, or with another quote, are a new message.
    await lost("/submit", "keep me");
    await type(BOX, "");
    await type(BOX, "keep me");
    await page.press("Enter");
    await until(async () => (await sent()) === 4, "typed again");
    await page.evaluate(`${STORE}.quoteReply('one part')`);
    await lost("/submit", "keep me");
    await page.evaluate(`${STORE}.quoteReply('another part')`);
    await page.press("Enter");
    await until(async () => (await sent()) === 6, "another quote");
});
