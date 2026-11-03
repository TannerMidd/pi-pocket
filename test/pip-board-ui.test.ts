// Appearance → PiP: Floating (the corner, or a phone's sheet) or Board (the conversation's place, as Running now), in
// an isolated real browser. These tests never select a real provider or use the running server's data or browser.
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
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let pip: ConversationId;
let background: ConversationId;
const project = join(work, "project-board");

/** Where PiP shows, as the store and the page say. */
type Seen = {
    pipOpen: boolean;
    board: string | false;
    stored: string | null;
    panels: number;
    topbar: boolean;
    close: boolean;
    rail: boolean | null;
    conversationId: number | null;
};

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const see = (condition: string, what: string) =>
    until(
        () => inPage<boolean>(`return JSON.stringify(Boolean(await (${condition})))`),
        what,
        20_000,
    );
const settle = () =>
    page.evaluate(`
    await Promise.all(document.getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => {})));
    for (let frame = 0; frame < 3; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
    }
`);

const seen = () =>
    inPage<Seen>(`
        const { store } = await import('/store.js');
        const rail = document.querySelector('.rail-pip');

        return JSON.stringify({
            pipOpen: store.state.pipOpen,
            board: store.state.board,
            stored: sessionStorage.getItem('pocket.pip'),
            panels: document.querySelectorAll('.pip-panel:not(.leaving)').length,
            topbar: document.querySelector('.pane .topbar') !== null,
            close: document.querySelector('.topbar [aria-label="Close PiP"]') !== null,
            rail: rail ? rail.classList.contains('open') : null,
            conversationId: store.state.conversationId,
        });
    `);

/**
 * PiP as a board: its conversation open in the session's place, as a session is (its top bar, its menu, every step),
 * with a × to close it, and no floating panel.
 */
async function boarded(what: string): Promise<void> {
    await see(
        `(async () => {
            const { store } = await import('/store.js');
            return !store.state.pipOpen && !store.state.board && store.state.page === null &&
                store.state.conversationId === ${Number(pip)} &&
                location.pathname === '/s/${Number(pip)}' &&
                store.state.view.conversation?.id === ${Number(pip)} &&
                document.querySelector('.pane .topbar [aria-label="Close PiP"]') !== null &&
                document.querySelector('.pane .composer textarea') !== null &&
                document.querySelector('.pip-panel:not(.leaving)') === null &&
                (document.querySelector('.rail-pip')?.classList.contains('open') ?? true);
        })()`,
        what,
    );
    await settle();
}

/** PiP floating: open, over the app, and the session's place left as it was. */
async function floating(what: string): Promise<void> {
    await see(
        `(async () => {
            const { store } = await import('/store.js');
            return store.state.pipOpen && store.state.conversationId !== ${Number(pip)} &&
                document.querySelector('.layout > .pip-panel:not(.leaving)') !== null &&
                store.state.pipView.conversation?.id === ${Number(pip)};
        })()`,
        what,
    );
    await settle();
}

/** PiP closed: in neither place, and not open in the store or the tab. */
async function shut(what: string): Promise<void> {
    await see(
        `(async () => {
            const { store } = await import('/store.js');
            return !store.state.pipOpen && !(await import('/pip.js')).pipShown() &&
                sessionStorage.getItem('pocket.pip') === null &&
                document.querySelector('.pip-panel') === null &&
                document.querySelector('[aria-label="Close PiP"]') === null;
        })()`,
        what,
    );
    await settle();
}

/** Type `text` in the box in view and send it. */
async function sendInSession(text: string): Promise<void> {
    await page.evaluate(`
        const box = document.querySelector('.pane .composer textarea');
        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await page.click({ selector: ".pane .send-button" });
}

const place = (value: "floating" | "board") =>
    page.evaluate(`(await import('/theme.js')).setPrefs({ pip: ${JSON.stringify(value)} })`);

/** A fresh tab on the background session, PiP closed, in `mode`. */
async function fresh(mode: "floating" | "board", viewport: Viewport = VIEWPORTS.desktop) {
    await page.evaluate(`
        (await import('/store.js')).closeSheet();
        (await import('/pip.js')).closePip();
        (await import('/theme.js')).setPrefs({ pip: ${JSON.stringify(mode)} });
    `);
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${background}`);
    await see(`document.querySelector('.composer textarea') !== null`, "the background session");
    await see(`(await import('/store.js')).store.state.server?.pip === true`, "PiP available");
    await settle();
    await shut("PiP closed at the start");
}

/** The session under PiP is back in its place, with its own message box. */
const backTo = (id: ConversationId, what: string) =>
    see(
        `(await import('/store.js')).store.state.conversationId === ${Number(id)} &&
            location.pathname === '/s/${Number(id)}' &&
            document.querySelector('.pane .composer textarea') !== null`,
        what,
    );

before(async () => {
    if (real.skip) {
        return;
    }

    mkdirSync(project);
    app = await openApp(
        scriptedModel(async (request) =>
            fauxAssistantMessage([
                fauxText(`PiP heard: ${lastText(request as never).text.slice(-40)}`),
            ]),
        ),
    );

    app.watches.gh = async () => {
        throw new Error("No GitHub in PiP UI tests");
    };

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
    await see(`(await import('/store.js')).store.state.me?.role === 'owner'`, "owner signed in");
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

test(
    "Floating is the default: the corner window, as before, without its old Open button",
    real,
    async () => {
        assert.equal(
            await inPage<string>(`return JSON.stringify((await import('/theme.js')).prefs().pip)`),
            "floating",
        );
        await fresh("floating");
        await page.evaluate(`(await import('/pip.js')).openPip()`);
        await floating("the floating panel");
        const now = await seen();

        assert.equal(now.board, false, "the conversation keeps its place");
        assert.equal(now.conversationId, Number(background));
        assert.equal(now.stored, "1");
        assert.equal(now.rail, true);
        assert.equal(now.close, false, "no × in the session's bar");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelectorAll('.pip-panel .pip-resize').length === 3 &&
                document.querySelector('.pip-panel [aria-label="Open as a conversation"]') === null)`,
            ),
            true,
            "the floating window keeps its resize handles; Board replaces its Open as a conversation button",
        );
        await page.evaluate(`(await import('/pip.js')).closePip()`);
        await shut("Floating closed");
    },
);

test(
    "Board: PiP's conversation in the session's place, answers there, and Back returns",
    real,
    async () => {
        await fresh("board");
        await page.click({ selector: ".rail-pip" });
        await boarded("PiP as a board from the rail button");
        const now = await seen();

        assert.equal(now.stored, null, "no floating panel is kept open");
        assert.equal(now.panels, 0);
        assert.equal(now.topbar, true, "the session's top bar, with its menu");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.sidebar .rail') !== null &&
                document.querySelector('.pane .topbar [aria-label="Menu"]') !== null &&
                document.querySelector('.pane .topbar .title-main')?.textContent === 'PiP')`,
            ),
            true,
            "the sidebar stays; the bar is PiP's, with the menu",
        );

        // Sent and answered in the board, as in a session.
        await sendInSession("hello from the board");
        await see(
            `[...document.querySelectorAll('.pane .reply')].some((each) => each.textContent.includes('PiP heard:'))`,
            "PiP's answer in the board",
        );

        // Back: to the session it took the place of.
        await page.evaluate(`history.back()`);
        await shut("Back closed the board");
        await backTo(background, "the session again after Back");

        // Its × does the same.
        await page.click({ selector: ".rail-pip" });
        await boarded("PiP again");
        await page.click({ selector: '.topbar [aria-label="Close PiP"]' });
        await shut("× closed the board");
        await backTo(background, "the session again after ×");

        // And the rail button, as a toggle; Esc does not close a session.
        await page.click({ selector: ".rail-pip" });
        await boarded("PiP again");
        await page.click({ selector: ".rail-pip" });
        await shut("the rail button closed the board");
        await backTo(background, "the session again after the rail button");
    },
);

test("Board: from the home screen, closing it goes home", real, async () => {
    await fresh("board");
    await page.evaluate(`(await import('/store.js')).navigate(null)`);
    await see(`(await import('/store.js')).store.state.conversationId === null`, "home");
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await boarded("PiP from home");
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");
    await see(
        `(await import('/store.js')).store.state.conversationId === null && location.pathname === '/'`,
        "home again",
    );
});

test("Board: another board, a session, or an extension's page takes the place", real, async () => {
    await fresh("board");
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await boarded("PiP as a board");

    await page.click({ selector: ".rail-running" });
    await see(
        `(await import('/store.js')).store.state.board === 'running' && document.querySelector('.running-board') !== null`,
        "Running now",
    );
    await shut("Running now took PiP's place");

    // The rail button brings PiP back over Running now.
    await page.click({ selector: ".rail-pip" });
    await boarded("PiP back from Running now");
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('.rail-running').classList.contains('open'))`,
        ),
        false,
    );

    await page.evaluate(`(await import('/sessions.js')).toggleBoard('subagents')`);
    await see(
        `(await import('/store.js')).store.state.board === 'subagents'`,
        "the subagents board",
    );
    await shut("the subagents board took PiP's place");

    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await boarded("PiP again");
    await page.evaluate(`(await import('/store.js')).navigate(${Number(background)})`);
    await shut("picking a session closed PiP");
    await backTo(background, "the session picked");

    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await boarded("PiP again");
    await page.evaluate(
        `(await import('/store.js')).store.set({ board: false, page: { module: 'x', id: 'y' } })`,
    );
    await shut("an extension's page took PiP's place");
    await page.evaluate(`(await import('/store.js')).store.set({ page: null })`);
    await page.evaluate(`(await import('/store.js')).navigate(${Number(background)})`);
});

test("Board: every way in opens the board", real, async () => {
    await fresh("board");

    // Alt+A, and again to close.
    await page.press("Alt+a");
    await boarded("Alt+A");
    await page.press("Alt+a");
    await shut("Alt+A again");

    // /pip, and /pip with a message.
    await page.evaluate(`
        const { parseCommand } = await import('/commands.js');
        const { command, arg } = parseCommand('/pip');
        command.run(arg);
    `);
    await boarded("/pip");
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");
    await page.evaluate(`
        const { parseCommand } = await import('/commands.js');
        const { command, arg } = parseCommand('/pip asked from the slash command');
        await command.run(arg);
    `);
    await boarded("/pip with a message");
    await see(
        `[...document.querySelectorAll('.pane .reply')].some((each) => each.textContent.includes('slash command'))`,
        "the answer to /pip's message",
    );
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");

    // An extension's pocket.pip.ask, which puts the text in the box.
    await page.evaluate(
        `await (await import('/pip.js')).askPipFrom({ module: 'demo' }, 'from a module', false)`,
    );
    await boarded("pocket.pip.ask");
    await see(
        `document.querySelector('.pane .composer textarea')?.value.includes('from a module')`,
        "the module's text in the box",
    );
    await page.evaluate(`
        const box = document.querySelector('.pane .composer textarea');
        box.value = '';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        (await import('/pip.js')).closePip();
    `);
    await shut("closed");

    // The launcher's Ask PiP.
    await page.press("Control+K");
    await see(`document.querySelector('.launcher input') !== null`, "the launcher");
    await page.evaluate(`
        const input = document.querySelector('.launcher input');
        input.value = 'Ask PiP';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await see(
        `document.querySelector('.launcher-item.on')?.textContent.includes('Ask PiP')`,
        "Ask PiP chosen",
    );
    await page.press("Enter");
    await boarded("the launcher's Ask PiP");
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify((await import('/store.js')).store.state.launcher)`,
        ),
        false,
    );
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");

    // A notification's link.
    await page.navigate(`${base}/?pip=1`);
    await boarded("?pip=1");
    assert.equal(await inPage<string>(`return JSON.stringify(location.search)`), "");

    // A reload keeps the route: still PiP's conversation.
    await page.navigate(`${base}/s/${Number(pip)}`);
    await boarded("PiP as a board after a reload");
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");
});

test("Changing the setting while PiP shows moves it, never into both places", real, async () => {
    await fresh("floating");
    await page.evaluate(`
        window.pipBoth = 0;
        window.pipNeither = 0;
        const { store } = await import('/store.js');
        const { pipShown } = await import('/pip.js');
        new MutationObserver(() => {
            const board = document.querySelector('.topbar [aria-label="Close PiP"]') !== null;
            const floating = document.querySelector('.pip-panel') !== null;
            window.pipBoth += board && floating ? 1 : 0;
        }).observe(document.body, { childList: true, subtree: true });
    `);
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await floating("floating to start");

    await place("board");
    await boarded("moved to the board");
    await place("floating");
    await floating("moved back to the corner");
    await backTo(background, "the session under it again");

    // From Appearance, over the board: the sheet stays, and PiP moves under it.
    await place("board");
    await boarded("on the board");
    await page.evaluate(`(await import('/store.js')).openSheet({ type: 'appearance' })`);
    await see(`document.querySelector('.sheet') !== null`, "Appearance");
    await page.evaluate(`
        [...document.querySelectorAll('.sheet .segmented button')]
            .find((button) => button.textContent.trim() === 'Floating').click();
    `);
    await floating("Floating chosen in Appearance");
    await page.evaluate(`
        [...document.querySelectorAll('.sheet .segmented button')]
            .find((button) => button.textContent.trim() === 'Board').click();
    `);
    await see(
        `(await import('/store.js')).store.state.conversationId === ${Number(pip)} && !(await import('/store.js')).store.state.pipOpen`,
        "Board chosen in Appearance",
    );
    assert.equal(
        await inPage<boolean>(`return JSON.stringify(document.querySelector('.sheet') !== null)`),
        true,
        "the sheet that changed it stays",
    );
    await page.evaluate(`(await import('/store.js')).closeSheet()`);
    await boarded("on the board under the sheet");

    assert.equal(await inPage<number>(`return JSON.stringify(window.pipBoth)`), 0, "never both");
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");
    await place("floating");
});

test(
    "Board: × closes PiP past a panel over it, back to the session it was opened over",
    real,
    async () => {
        await fresh("board", VIEWPORTS.mobile);
        await page.evaluate(`(await import('/pip.js')).openPip()`);
        await boarded("PiP as a board");
        // The Files tile covers the conversation on a phone, with its own back entry.
        await page.evaluate(`(await import('/files-panel.js')).setFilesOpen(true)`);
        await see(
            `document.querySelector('.files-tile:not(.leaving)') !== null`,
            "the Files tile over PiP",
        );
        await settle();
        await page.evaluate(`(await import('/pip.js')).closePip()`);
        await shut("× closed PiP, not only the tile");
        await backTo(background, "the session PiP was opened over");
        await see(
            `document.querySelector('.files-tile:not(.leaving)') === null`,
            "the tile closed too",
        );
        await page.setViewport(VIEWPORTS.desktop);
    },
);

/** The session the list marks as open (its row's `aria-current`), or null for none. */
const markedOpen = () =>
    inPage<number | null>(
        `const row = document.querySelector('.sidebar .session-row:has([aria-current="page"])');
        return JSON.stringify(row ? Number(row.dataset.id) : null)`,
    );

test(
    "Board: the session under PiP stays marked open in the list, as under Running now",
    real,
    async () => {
        const other = await newSession(app, project);

        await fresh("board");
        await see(`document.querySelector('.sidebar .session-row') !== null`, "the session list");
        assert.equal(await markedOpen(), Number(background), "the session is marked open");

        await page.click({ selector: ".rail-running" });
        await see(`(await import('/store.js')).store.state.board === 'running'`, "Running now");
        await settle();
        assert.equal(await markedOpen(), Number(background), "under Running now it stays marked");
        await page.click({ selector: ".rail-running" });
        await backTo(background, "the session again");
        await settle();

        await page.click({ selector: ".rail-pip" });
        await boarded("PiP as a board");
        assert.equal(await markedOpen(), Number(background), "under PiP it stays marked too");

        // Kept on PiP's entry: through a reload, and back to it from another session.
        await page.evaluate(`location.reload()`);
        await boarded("PiP after a reload");
        await see(`document.querySelector('.sidebar .session-row') !== null`, "the session list");
        assert.equal(await markedOpen(), Number(background), "still marked after a reload");

        await page.evaluate(`(await import('/store.js')).navigate(${Number(other)})`);
        await backTo(other, "another session");
        assert.equal(await markedOpen(), Number(other), "the session picked is the one marked");
        await page.evaluate(`history.back()`);
        await boarded("PiP again, by back");
        assert.equal(await markedOpen(), Number(background), "back on PiP, the one under it again");

        await page.click({ selector: '.topbar [aria-label="Close PiP"]' });
        await shut("closed");
        await backTo(background, "the session under it");
        assert.equal(await markedOpen(), Number(background));
    },
);

test("Board: back and forward keep where PiP closes to", real, async () => {
    const other = await newSession(app, project);

    await fresh("board");
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await boarded("PiP over the background session");
    await page.evaluate(`(await import('/store.js')).navigate(${Number(other)})`);
    await backTo(other, "another session");
    await page.evaluate(`history.back()`);
    await boarded("PiP again, by back");
    await page.click({ selector: '.topbar [aria-label="Close PiP"]' });
    await shut("closed");
    await backTo(background, "the session PiP was first opened over, not home");
});

test(
    "Board: text for PiP goes into PiP's box only, even when a session shows first",
    real,
    async () => {
        await fresh("board");
        await page.evaluate(
            `(await import('/store.js')).insertIntoComposer('only for pip', [], { conversationId: ${Number(pip)} })`,
        );
        await settle();
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('.pane .composer textarea').value)`,
            ),
            "",
            "the session's box does not take it",
        );
        await page.evaluate(`(await import('/pip.js')).openPip()`);
        await boarded("PiP");
        await see(
            `document.querySelector('.pane .composer textarea')?.value.includes('only for pip')`,
            "PiP's box has it",
        );
        await page.evaluate(`
        const box = document.querySelector('.pane .composer textarea');
        box.value = '';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        (await import('/pip.js')).closePip();
    `);
        await shut("closed");
    },
);

test("A setting changed and changed back at once moves nothing", real, async () => {
    await fresh("floating");
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await floating("floating");
    await page.evaluate(`
        const { setPrefs } = await import('/theme.js');
        setPrefs({ pip: 'board' });
        setPrefs({ pip: 'floating' });
    `);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await floating("still floating");
    await backTo(background, "the session stays");
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");
});

test("Phones: Board is the session's screen; Floating keeps the sheet", real, async () => {
    await fresh("board", VIEWPORTS.mobile);
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await boarded("PiP as a board on a phone");
    const box = await inPage<{ width: number; scrim: number }>(`
        const rect = document.querySelector('.pane').getBoundingClientRect();

        return JSON.stringify({
            width: Math.round(rect.width),
            scrim: document.querySelectorAll('.pip-scrim').length,
        });
    `);

    assert.deepEqual(box, { width: 390, scrim: 0 });
    await page.evaluate(`history.back()`);
    await shut("Back on a phone");
    await backTo(background, "the session again");

    await place("floating");
    await page.evaluate(`(await import('/pip.js')).openPip()`);
    await floating("the phone's sheet");
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('.pip-scrim') !== null && document.querySelector('.pip-panel').getAttribute('aria-modal') === 'true')`,
        ),
        true,
        "the sheet keeps its scrim",
    );
    await page.evaluate(`(await import('/pip.js')).closePip()`);
    await shut("closed");
});
