// A Markdown artifact's viewer in a real browser, where this machine has Chromium: the artifact's page, in a sandbox,
// cannot see the app's look, so the viewer names the theme in its frame's address, as hex without its "#", and the
// address follows a change of theme while the viewer is open.
import { type App, cleanUp, lastText, newSession, openApp, root, say, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** Writes a Markdown artifact when asked to. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("done")]);
    }

    return text.includes("write a markdown artifact")
        ? fauxAssistantMessage(
              [
                  fauxToolCall("artifact", {
                      id: "notes",
                      title: "Notes",
                      type: "markdown",
                      content: "# Notes\n\nSome **text**.",
                  }),
              ],
              { stopReason: "toolUse" },
          )
        : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const faux = fauxProvider({ tokensPerSecond: 2000, models: [{ id: "faux-1" }] });

faux.setResponses(Array.from({ length: 20 }, () => route));

/** Two themes' colors in `web/themes.js`, one dark and one light, as the frame's address names them. */
const TOKYO_NIGHT = {
    mode: "dark",
    bg: "1a1b26",
    fg: "a9b1d6",
    text: "c0caf5",
    accent: "7aa2f7",
    code: "13141c",
};
const CATPPUCCIN_LATTE = {
    mode: "light",
    bg: "eff1f5",
    fg: "4c4f69",
    text: "4c4f69",
    accent: "1e66f5",
    code: "e3e4e8",
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Wait until a script in the page returns true. */
const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what);

/** The address of the viewer's frame, as the app wrote it; null while there is none. */
const frameSrc = () =>
    inPage<string | null>(
        `return JSON.stringify(document.querySelector(".viewer iframe")?.getAttribute("src") ?? null)`,
    );

/** The query of a frame's address, by name. */
const query = (src: string) => Object.fromEntries(new URL(src, base).searchParams);

/**
 * Wait until what moves as the page opens has stopped (not what loops for ever). Until then a click can miss: the
 * timeline unrolls from the top, clipped below, so for its first moments the point a link is at is the group behind it.
 */
const still = () =>
    page.evaluate(`
        for (;;) {
            const moving = document
                .getAnimations()
                .filter(
                    (each) =>
                        each.playState === "running" &&
                        each.effect?.getComputedTiming().endTime !== Infinity,
                );

            if (moving.length === 0) {
                return "true";
            }

            await Promise.all(moving.map((each) => each.finished.catch(() => {})));
        }
    `);

const choose = (theme: string) =>
    page.evaluate(
        `(await import("/theme.js")).chooseTheme(${JSON.stringify(theme)}); return "true"`,
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(faux);
    session = await newSession(app);
    await say(app, session, "please write a markdown artifact");
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "artifact-viewer-ui-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a Markdown artifact's frame is named the app's theme, and follows a theme of the other mode",
    real,
    async () => {
        await page.setViewport(VIEWPORTS.mobile);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await see(
            `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
            "signed in",
        );
        await choose("tokyo-night");
        await page.navigate(`${base}/s/${String(session)}`);
        await see(
            `return JSON.stringify(document.querySelector(".artifact-link") !== null)`,
            "the artifact in the conversation",
        );
        await still();
        await page.click({ selector: ".artifact-link" });
        await until(async () => (await frameSrc()) !== null, "the viewer's frame");
        const dark = (await frameSrc())!;

        assert.match(dark, new RegExp(`^/a/${String(session)}/notes/1\\?`));
        assert.deepEqual(query(dark), TOKYO_NIGHT);

        // A light theme, chosen while the viewer is open: the frame loads with its colors.
        await choose("catppuccin-latte");
        await until(async () => (await frameSrc()) !== dark, "the frame on the light theme");
        const light = (await frameSrc())!;

        assert.deepEqual(query(light), CATPPUCCIN_LATTE);
        // The artifact's page takes them.
        assert.match(
            await inPage<string>(
                `return JSON.stringify(await (await fetch(${JSON.stringify(light)})).text())`,
            ),
            /:root\{color-scheme:light;--bg:#eff1f5;--fg:#4c4f69;--text:#4c4f69;--accent:#1e66f5;--code:#e3e4e8\}/,
        );
    },
);
