// A run waiting for a provider's limit, in a real browser: the live line says so and has Retry now.
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
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const state = { limited: true, answered: false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

before(async () => {
    if (real.skip) {
        return;
    }

    const model = scriptedModel(() => {
        if (state.limited) {
            throw new Error("529 overloaded_error");
        }

        state.answered = true;

        return fauxAssistantMessage([fauxText("answered")]);
    });

    app = await openApp(model, undefined, undefined, { minWaitMs: 50, backoffMs: [60_000] });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "limit-ui-")),
        load: async () => undefined,
        save: () => {},
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

test(
    "the live line says Pi waits for a limit and has Retry now, which sends the request",
    real,
    async () => {
        const id = await newSession(app);
        const line = async () =>
            JSON.parse(
                await page.evaluate(
                    `return JSON.stringify(document.querySelector(".live-line")?.innerText ?? "")`,
                ),
            ) as string;

        await app.commands.submit(id, owner(app), { text: "hello", requestId: "w-1" });
        await until(() => app.limits.waitFor(Number(id)) !== undefined, "the wait");
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () => /Waiting for .*Retry now/s.test(await line()),
            "the live line",
            20_000,
        );

        // On a phone the line wraps: Retry now stays in the column, and the conversation does not scroll sideways.
        await page.setViewport(VIEWPORTS.mobile);

        const fits = JSON.parse(
            await page.evaluate(`
                const scroller = document.querySelector(".pane > .scroller");
                const retry = document.querySelector(".live-retry").getBoundingClientRect();

                return JSON.stringify(retry.right <= innerWidth && scroller.scrollWidth <= scroller.clientWidth);
            `),
        );

        assert.equal(
            fits,
            true,
            "Retry now is on screen and the conversation does not scroll sideways",
        );
        assert.equal(
            await page.evaluate(
                `return String(!!document.querySelector('[data-part="live-stop"]'))`,
            ),
            "true",
            "Stop is available on a phone",
        );

        state.limited = false;
        await page.click({ selector: ".live-retry" });
        await until(() => state.answered, "the answer");
    },
);

test("Stop cancels a usage wait on a phone", real, async () => {
    state.limited = true;
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "stop me", requestId: "w-2" });
    await until(() => app.limits.waitFor(Number(id)) !== undefined, "the wait");
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            (await page.evaluate(`return !!document.querySelector('[data-part="live-stop"]')`)) ===
            "true",
        "the Stop button",
        20_000,
    );
    await page.click({ selector: '[data-part="live-stop"]' });
    await until(() => app.limits.waitFor(Number(id)) === undefined, "the wait ends");
});
