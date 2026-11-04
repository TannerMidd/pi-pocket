// Appearance → PiP: Floating (the corner, or a phone's sheet) or Board (PiP's conversation in the
// session's place), in an isolated real browser with a scripted model.
import {
    type App,
    cleanUp,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
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

/** PiP as a board: its conversation in the session's place, with its box and a ×, and no panel. */
const boarded = (what: string) =>
    see(
        `${STORE}.store.state.view.conversation?.id === ${Number(pip)} &&
            ${PIP}.pipBoard() && !${STORE}.store.state.pipOpen &&
            document.querySelector('.pane .topbar [aria-label="Close PiP"]') !== null &&
            document.querySelector('.pane .composer textarea') !== null &&
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
const place = (value: "floating" | "board") =>
    page.evaluate(`(await import('/theme.js')).setPrefs({ pip: '${value}' })`);
/** The session the list marks open. */
const markedOpen = () =>
    inPage<number>(
        `Number(document.querySelector('.sidebar .session-row:has([aria-current="page"])')
            ?.dataset.id)`,
    );

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

    // Text for PiP goes into its box only, not a session's in view; `pocket.pip.ask` puts it there.
    await page.evaluate(
        `${STORE}.insertIntoComposer('not here', [], { conversationId: ${Number(pip)} })`,
    );
    await settle();
    assert.equal(await inPage(`document.querySelector('.pane .composer textarea').value`), "");
    await page.evaluate(`${PIP}.askPipFrom({ module: 'demo' }, 'only for pip', false)`);
    await boarded("pocket.pip.ask");
    await see(
        `document.querySelector('.pane .composer textarea').value.includes('only for pip')`,
        "in PiP's box",
    );
    await page.evaluate(`${PIP}.closePip()`);
    await backTo(background, "the session");

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
});

test("Phones: × closes past the Files tile, and PiP opens again without it", real, async () => {
    await fresh("board", VIEWPORTS.mobile);
    await page.evaluate(`${PIP}.openPip()`);
    await boarded("PiP on a phone");
    await page.evaluate(`(await import('/files-panel.js')).setFilesOpen(true)`);
    await see(`document.querySelector('.files-tile:not(.leaving)') !== null`, "the Files tile");
    await settle();
    await page.evaluate(`${PIP}.closePip()`);
    await backTo(background, "the session, past the tile");
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

test("Changing the setting moves PiP, never into both places", real, async () => {
    await fresh("floating");
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

    // From Appearance: the sheet that changed it stays, over PiP's board.
    await page.evaluate(`${STORE}.openSheet({ type: 'appearance' })`);
    await see(`document.querySelector('.sheet .segmented') !== null`, "Appearance");
    await page.evaluate(`[...document.querySelectorAll('.sheet .segmented button')]
        .find((button) => button.textContent.trim() === 'Board').click()`);
    await see(`${STORE}.store.state.conversationId === ${Number(pip)}`, "Board chosen");
    assert.equal(await inPage(`${STORE}.store.state.sheet?.type ?? null`), "appearance");
    await page.evaluate(`${STORE}.closeSheet()`);
    await boarded("on the board");
    assert.equal(await inPage(`window.pipBoth`), 0, "never both");
});

test("Ask PiP: the passage over the board's box, and PiP told its session", real, async () => {
    await fresh("board");
    await page.evaluate(`${PIP}.quotePip('the build is red', ${Number(background)})`);
    await boarded("PiP");
    await see(
        `document.querySelector('.pane .quote-strip-text')?.textContent === 'the build is red'`,
        "the quote over the board's box",
    );
    await page.evaluate(`
        const box = document.querySelector('.pane .composer textarea');
        box.value = 'why?';
        box.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await page.click({ selector: ".pane .send-button" });
    await see(`${STORE}.store.state.replyAbout === null`, "sent");
    await until(async () => lastAsked.includes("the build is red"), "PiP asked");
    assert.ok(lastAsked.includes(`<pocket-context session=\\"${Number(background)}`));
    await page.evaluate(`${PIP}.closePip()`);
});

test("Pending memories: PiP's strip in both places, only while one waits", real, async () => {
    const COUNT = (where: string) =>
        `document.querySelector('${where} .pip-memory-count')?.textContent.trim()`;

    await fresh("board");
    await page.evaluate(`${PIP}.openPip()`);
    await boarded("PiP");
    await settle();
    assert.equal(await inPage(`${COUNT(".pane .dock")} ?? null`), null, "none waits: no strip");

    const lesson = await app.memory.add(
        background,
        project,
        { userId: owner(app).id, byPi: true, name: "Pi" },
        { text: "Run the board tests alone.", scope: "everywhere" },
    );

    await see(`${COUNT(".pane .dock")} === '1 pending'`, "on the board");
    await place("floating");
    await see(`${COUNT(".pip-panel")} === '1 pending'`, "floating");
    await app.memory.edit(background, owner(app), lesson.id, "discard");
    await see(`document.querySelector('.pip-memory') === null`, "gone once none waits");
    await page.evaluate(`${PIP}.closePip()`);
});

test("PiP turned off in Extensions closes the board", real, async () => {
    await fresh("board");
    await page.evaluate(`${PIP}.openPip()`);
    await boarded("PiP");
    await page.evaluate(`${STORE}.api('extensions/pip.ts', { enabled: false })`);
    await backTo(background, "the session again");
    await page.evaluate(`${STORE}.api('extensions/pip.ts', { enabled: true })`);
    await see(`${PIP}.pipAvailable()`, "PiP on again");
});
