// Appearance's session tabs in a headless browser, with isolated app data and a scripted model: the strip shows the
// numbered sessions, the open one is selected, a tap opens another, and the default (the sidebar) draws no strip.
import { type App, cleanUp, newSession, openApp, scriptedModel, until } from "./helpers.ts";
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
import { root } from "./helpers.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let sessions: ConversationId[] = [];

const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    sessions = [await newSession(app), await newSession(app), await newSession(app)];
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "session-tabs-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(DESKTOP);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** The tabs as they show: each one's session id, selection, and name. */
const strip = () =>
    inPage<{ tabs: { selected: string; name: string }[]; rail: string | undefined }>(`
        const tabs = [...document.querySelectorAll('.tabstrip .tabstrip-tab')];

        return JSON.stringify({
            tabs: tabs.map((tab) => ({
                selected: tab.getAttribute("aria-current"),
                name: tab.querySelector(".tabstrip-name").textContent,
            })),
            rail: document.documentElement.dataset.rail,
        });
    `);

test(
    "tabs: a segment for each session, the open one selected, a tap opens another",
    real,
    async () => {
        await page.evaluate(
            `localStorage.setItem("pocket.appearance", JSON.stringify({ sessionTabs: true, sidebar: "rail" }))`,
        );
        await page.navigate(`${base}/s/${sessions[0]}`);
        await until(async () => (await strip()).tabs.length === sessions.length, "the strip");

        const before = await strip();

        assert.equal(before.rail, "on", "the sidebar is folded to its rail");
        assert.equal(before.tabs.filter((tab) => tab.selected === "page").length, 1);

        const other = before.tabs.findIndex((tab) => tab.selected !== "page");

        await page.click({ selector: `.tabstrip .tabstrip-tab:nth-of-type(${other + 1})` });
        await until(async () => (await strip()).tabs[other]?.selected === "page", "the tapped tab");
        assert.equal(
            (await strip()).tabs.filter((tab) => tab.selected === "page").length,
            1,
            "only the tapped one is selected",
        );
    },
);

test("the sidebar is the default: no strip", real, async () => {
    await page.evaluate(`localStorage.removeItem("pocket.appearance")`);
    await page.navigate(`${base}/s/${sessions[0]}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(!!document.querySelector(".pane .topbar"))`,
            ),
        "the top bar",
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector(".tabstrip") !== null)`,
        ),
        false,
    );
});
