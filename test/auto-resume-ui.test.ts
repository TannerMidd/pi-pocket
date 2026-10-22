// Auto-resume's sheet in the app, in Chromium on a phone's screen: this chat's switch, the owner's default and delay.
import { cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);

test(
    "the menu opens auto-resume's sheet, whose choices last across a reload",
    { skip: findBrowser() ? false : "no Chromium-based browser" },
    async () => {
        const app = await openApp(scriptedModel());
        const id = await newSession(app);
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "auto-resume-ui-")),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const evaluate = async <T>(script: string): Promise<T> =>
            JSON.parse(await page.evaluate(script));
        const state = () =>
            evaluate<{
                on: boolean;
                choice: boolean | null;
                defaultOn: boolean;
                delayMinutes: number;
            }>(
                `return JSON.stringify(await (await fetch('/api/x/auto-resume/chat/${id}', { headers: { 'x-pocket': '1' } })).json())`,
            );
        const visible = (selector: string) =>
            evaluate<boolean>(
                `return JSON.stringify(!!document.querySelector(${JSON.stringify(selector)}))`,
            );
        const click = (selector: string) =>
            page.evaluate(
                `const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing ' + ${JSON.stringify(selector)}); element.click()`,
            );

        const openSheet = async () => {
            await page.evaluate(`(await import('/store.js')).openSheet({type:'menu'})`);
            await until(
                async () =>
                    evaluate<boolean>(
                        `return JSON.stringify([...document.querySelectorAll('.list-item')].some((e) => e.textContent.trim().startsWith('Auto-resume')))`,
                    ),
                "auto-resume's menu row",
            );
            await page.evaluate(
                `[...document.querySelectorAll('.list-item')].find((e) => e.textContent.trim().startsWith('Auto-resume')).click()`,
            );
            await until(() => visible('[aria-label^="Auto-resume in this chat"]'), "the sheet");
        };

        try {
            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=${encodeURIComponent(`/s/${id}`)}`,
            );
            await openSheet();
            assert.equal((await state()).on, false);

            await click('[aria-label^="Auto-resume in this chat"]');
            await until(async () => (await state()).choice === true, "this chat on");
            await until(
                () =>
                    evaluate<boolean>(
                        `return JSON.stringify([...document.querySelectorAll('button')].some((e) => e.textContent.trim() === 'Use default'))`,
                    ),
                "the way back to the default",
            );
            await page.evaluate(
                `[...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Use default').click()`,
            );
            await until(async () => (await state()).choice === null, "the default again");

            await click('[aria-label^="Auto-resume by default"]');
            await until(async () => (await state()).defaultOn, "the default on");
            await page.evaluate(
                `const select = document.querySelector('select[aria-label="Retry without a reset time"]'); select.value = '30'; select.dispatchEvent(new Event('change', { bubbles: true }))`,
            );
            await until(async () => (await state()).delayMinutes === 30, "the delay set");
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
                ),
                true,
            );

            await page.reload();
            await openSheet();
            assert.deepEqual(
                {
                    ...(await state()),
                    switch: await evaluate(
                        `return JSON.stringify(document.querySelector('[aria-label^="Auto-resume in this chat"]').getAttribute('aria-label'))`,
                    ),
                },
                {
                    ...(await state()),
                    on: true,
                    defaultOn: true,
                    delayMinutes: 30,
                    switch: "Auto-resume in this chat: on",
                },
            );
            assert.deepEqual(
                page
                    .logs()
                    .filter((line) => line.level === "error")
                    .map((line) => line.text),
                [],
            );
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
