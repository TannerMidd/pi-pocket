// Where the focus goes as a session opens, in a headless browser with a mouse: into its message box on a computer; not
// on a touch screen, where the keyboard would come up over the conversation; and not after an Alt shortcut on an Apple
// keyboard, where the box would take the next Alt shortcut as a character to type; nor from another field that has it,
// such as the docked chat a mention opened.
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
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { WEB } from "../src/server/http/assets.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const BOX = ".composer textarea";
/** Wide enough for the People panel to dock beside the conversation. */
const WIDE = { width: 1440, height: 900, scale: 1, mobile: false };

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let one: ConversationId;
let two: ConversationId;
/** Whether the page takes this for an Apple keyboard: `ui.js` served as a Mac's `navigator.platform` would make it. */
let apple = false;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const boxFocused = () =>
    inPage<boolean>(
        `return JSON.stringify(document.activeElement?.matches(${JSON.stringify(BOX)}) ?? false)`,
    );

/** The session `id` open with its message box, a few frames on: by then the box has the focus if it takes it. */
async function opened(id: ConversationId): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(
                    location.pathname === "/s/${Number(id)}" &&
                        store.state.view.conversation?.id === ${Number(id)} &&
                        document.querySelector(${JSON.stringify(BOX)}) !== null,
                );
            `),
        `session ${id} open`,
    );
    await page.evaluate(`
        for (let frame = 0; frame < 6; frame++) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    `);
}

/** The session list, loaded afresh at `viewport`. */
async function home(viewport: Viewport): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.session-row[data-id="${Number(one)}"]') !== null)`,
            ),
        "the session list",
        20_000,
    );
}

/** Alt and the number the rail gives `id`. */
const altDigit = async (id: ConversationId) =>
    `Alt+${
        (await inPage<number>(`
            const { workspaceOrder } = await import("/sessions.js");

            return JSON.stringify(workspaceOrder().findIndex((each) => each.id === ${Number(id)}));
        `)) + 1
    }`;

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    one = await newSession(app);
    two = await newSession(app);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });
    const ui = readFileSync(join(WEB, "ui.js"), "utf8");
    const appleUi = ui.replace(`navigator.platform ?? ""`, `"MacIntel"`);

    assert.notEqual(appleUi, ui, "ui.js reads the keyboard's kind from navigator.platform");
    server = createServer((request, response) => {
        if (apple && new URL(request.url ?? "/", base).pathname === "/ui.js") {
            response.writeHead(200, {
                "content-type": "text/javascript; charset=utf-8",
                "cache-control": "no-store",
            });
            response.end(appleUi);

            return;
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "composer-focus-ui-")),
        load: async () => undefined,
        save: () => {},
        // A mouse, whatever this machine has; the phone size's touch emulation still makes it a touch screen.
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
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

test("on a computer, a session opens with the caret in its message box", real, async () => {
    await home(VIEWPORTS.desktop);
    await page.click({ selector: `.sidebar .session-row[data-id="${Number(one)}"] > .session` });
    await opened(one);
    await until(boxFocused, "the box, after a click on the session's row");

    // From the box, Alt and a number go to another session, whose box takes the focus in turn.
    await page.press(await altDigit(two));
    await opened(two);
    await until(boxFocused, "the box, after Alt and the session's number");
});

test(
    "on a touch screen, a session opens with its message box waiting for a tap",
    real,
    async () => {
        await home(VIEWPORTS.mobile);
        assert.equal(
            await inPage<boolean>(`return JSON.stringify(matchMedia("(pointer: coarse)").matches)`),
            true,
            "a touch screen",
        );
        await page.click({
            selector: `.home-list .session-row[data-id="${Number(one)}"] > .session`,
        });
        await opened(one);
        assert.equal(await boxFocused(), false, "no keyboard over the conversation");
    },
);

test(
    "on an Apple keyboard, Alt+1…9 leaves the message box alone, so the next one still switches sessions",
    real,
    async () => {
        apple = true;

        try {
            await home(VIEWPORTS.desktop);
            assert.equal(
                await inPage<boolean>(`return JSON.stringify((await import("/ui.js")).APPLE)`),
                true,
                "the page takes this for an Apple keyboard",
            );
            await page.press(await altDigit(one));
            await opened(one);
            assert.equal(await boxFocused(), false, "the box left alone after Alt+1…9");
            await page.press(await altDigit(two));
            await opened(two);
            assert.equal(await boxFocused(), false, "the second Alt+1…9 switched sessions too");
        } finally {
            apple = false;
        }
    },
);

test(
    "on a wide screen, a mention's notice opens the docked chat, and the chat's box keeps the focus",
    real,
    async () => {
        const alex = app.config.addUser("Alex", "guest").user;

        await page.setViewport(WIDE);
        await page.navigate(`${base}/s/${Number(one)}`);
        await opened(one);
        await until(boxFocused, "the message box, as the session opened");
        await app.collab.postChat(two, alex, {
            text: `@${owner(app).name} a word about this`,
            requestId: "mention-1",
        });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll(".notices .notice")].some((each) => each.textContent.includes("mentioned you")))`,
                ),
            "the mention's notice",
        );
        await page.click({ selector: ".notices .notice:not(.leaving)" });
        await opened(two);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".people.window .chat-compose textarea") !== null)`,
                ),
            "the chat, docked beside the conversation",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.activeElement?.matches(".people.window .chat-compose textarea") ?? false)`,
            ),
            true,
            "the chat's box has the focus, not Pi's",
        );
    },
);
