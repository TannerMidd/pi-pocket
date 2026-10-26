// The owner's Compact context controls in the Providers sheet: on, off, from-full vs over, and the token presets.
import { type App, cleanUp, openApp, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(faux);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "compaction-ui-")),
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

const see = (script: string, what: string) =>
    until(async () => {
        try {
            return JSON.parse(await page.evaluate(script)) === true;
        } catch {
            return false;
        }
    }, what);

async function openProviders(token: string): Promise<void> {
    await page.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
    await page.evaluate(`
        const { openSheet } = await import("/store.js");

        openSheet({ type: "providers" });
        return "true";
    `);
    await see(
        `return JSON.stringify(document.querySelector(".limit-wait") !== null || document.querySelector(".providers-main") !== null)`,
        "the providers",
    );
}

test(
    "the owner turns Compact context off and picks a reserve in the Providers sheet",
    real,
    async () => {
        await page.setViewport(VIEWPORTS.mobile);
        await openProviders(app.config.ownerToken);
        await see(
            `return JSON.stringify([...document.querySelectorAll(".limit-wait .small")].some((el) => el.textContent === "Compact context"))`,
            "Compact context",
        );

        await page.evaluate(`
            const row = [...document.querySelectorAll(".limit-wait")].find((el) =>
                [...el.querySelectorAll(".small")].some((label) => label.textContent === "Compact context"),
            );
            const press = (text) =>
                [...row.querySelectorAll("button")].find((el) => el.textContent.trim() === text).click();

            press("Off");
            press("32k");
            return "true";
        `);
        await until(() => app.compactionSettings()?.enabled === false, "compaction off");
        await until(() => app.compactionSettings()?.reserveTokens === 32768, "32k reserve");

        const on = JSON.parse(
            await page.evaluate(`
                const row = [...document.querySelectorAll(".limit-wait")].find((el) =>
                    [...el.querySelectorAll(".small")].some((label) => label.textContent === "Compact context"),
                );
                const pressed = [...row.querySelectorAll("[aria-pressed=true]")].map((el) => el.textContent.trim());

                return JSON.stringify(pressed);
            `),
        ) as string[];

        assert.ok(on.includes("Off"));
        assert.ok(on.includes("32k"));
        assert.ok(on.includes("From full"));
        assert.equal(app.settings.getCompactionSettings().reserveTokens, 32768);
        assert.equal(app.settings.getCompactionSettings().enabled, false);

        await page.evaluate(`
            const row = [...document.querySelectorAll(".limit-wait")].find((el) =>
                [...el.querySelectorAll(".small")].some((label) => label.textContent === "Compact context"),
            );
            const press = (text) =>
                [...row.querySelectorAll("button")].find((el) => el.textContent.trim() === text).click();

            press("Once over");
            return "true";
        `);
        await until(() => app.compactionSettings()?.trigger === "over", "once-over trigger");
        await see(
            `return JSON.stringify([...document.querySelectorAll(".limit-wait button")].some((el) => el.textContent.trim() === "60k"))`,
            "60k over choice",
        );
        await page.evaluate(`
            const row = [...document.querySelectorAll(".limit-wait")].find((el) =>
                [...el.querySelectorAll(".small")].some((label) => label.textContent === "Compact context"),
            );

            [...row.querySelectorAll("button")].find((el) => el.textContent.trim() === "60k").click();
            return "true";
        `);
        await until(() => app.compactionSettings()?.overTokens === 60000, "60k over");

        const over = JSON.parse(
            await page.evaluate(`
                const row = [...document.querySelectorAll(".limit-wait")].find((el) =>
                    [...el.querySelectorAll(".small")].some((label) => label.textContent === "Compact context"),
                );
                const pressed = [...row.querySelectorAll("[aria-pressed=true]")].map((el) => el.textContent.trim());

                return JSON.stringify(pressed);
            `),
        ) as string[];

        assert.ok(over.includes("Once over"));
        assert.ok(over.includes("60k"));
        assert.equal(app.compactionSettings()?.trigger, "over");
        assert.equal(app.settings.getCompactionSettings().reserveTokens, 32768);
        assert.equal(app.settings.getCompactionSettings().enabled, false);
    },
);
