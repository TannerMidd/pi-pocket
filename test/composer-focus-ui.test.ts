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
import { type Viewport, VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const BOX = ".composer textarea";
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let one: ConversationId;
let two: ConversationId;

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

    server = createServer((request, response) => {
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

// Issue #83, reported by @vitalNohj: Enter after a click on Plan pressed it again, and plan mode went back off.
test("a click on Plan leaves the focus in the message box", real, async () => {
    await home(VIEWPORTS.desktop);
    await page.click({ selector: `.sidebar .session-row[data-id="${Number(one)}"] > .session` });
    await opened(one);
    await until(boxFocused, "the box");
    await page.click({ selector: ".composer .plan-chip" });
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify((await import("/store.js")).store.state.view.plan?.on === true)`,
            ),
        "plan mode on",
    );
    assert.equal(await boxFocused(), true, "Enter goes on to send, not to the chip");
});

test(
    "recall uses this session for arrows and search, and Down restores the draft",
    real,
    async () => {
        await home(VIEWPORTS.desktop);

        for (const [id, text] of [
            [one, "recall A marker"],
            [two, "recall B marker"],
        ] as const) {
            await page.navigate(`${base}/s/${Number(id)}`);
            await opened(id);
            await page.type({ selector: BOX }, text);
            await page.press("Enter");
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(document.querySelector('${BOX}').value === '')`,
                    ),
                "message sent",
            );
        }

        await page.navigate(`${base}/s/${Number(one)}`);
        await opened(one);
        await page.type({ selector: BOX }, "draft");
        await page.press("Home");
        await page.press("ArrowUp");
        const value = () =>
            inPage<string>(`return JSON.stringify(document.querySelector('${BOX}').value)`);

        assert.equal(await value(), "recall A marker");
        await page.press("ArrowDown");
        assert.equal(await value(), "draft");
        await page.type({ selector: BOX }, "recall");
        await page.press("Control+R");
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.history-options') !== null)`,
                ),
            "recall search open",
        );
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll('.history-options [role="option"]')].map(each => each.textContent.trim()))`,
            ),
            ["recall A marker"],
        );
        await page.press("Escape");
    },
);
