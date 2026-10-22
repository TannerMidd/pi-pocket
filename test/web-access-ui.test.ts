import { cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);

test(
    "web access phone controls save options and ordered routing across reload",
    { skip: findBrowser() ? false : "no Chromium-based browser" },
    async () => {
        const app = await openApp(scriptedModel());
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "web-ui-")),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const evaluate = async <T>(script: string): Promise<T> =>
            JSON.parse(await page.evaluate(script));

        const open = async () => {
            await page.evaluate(`(await import('/store.js')).openSheet({type:'web-access'})`);
            await until(
                async () =>
                    evaluate<boolean>(
                        `return JSON.stringify(!!document.querySelector('.web-access-options'))`,
                    ),
                "web access options",
            );
        };

        try {
            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await open();
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
                ),
                true,
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.querySelector('[aria-label="quick provider 1"]').value)`,
                ),
                "brave",
            );
            await page.evaluate(
                `document.querySelector('[aria-label="Move quick route 2 up"]').click()`,
            );
            await until(
                async () =>
                    (await app.webAccess.getState()).tierRouting.quick[0]?.provider === "exa",
                "saved reorder",
            );
            await until(
                async () =>
                    evaluate<boolean>(
                        `return JSON.stringify(!document.querySelector('[aria-label="quick provider 1"]').disabled)`,
                    ),
                "save finished",
            );
            await page.evaluate(
                `document.querySelector('[aria-label="quick mode 1"]').value = 'deep-lite'; document.querySelector('[aria-label="quick mode 1"]').dispatchEvent(new Event('change', {bubbles:true}))`,
            );
            await until(
                async () =>
                    (await app.webAccess.getState()).tierRouting.quick[0]?.mode === "deep-lite",
                "saved route mode",
            );
            await page.evaluate(
                `const details = [...document.querySelectorAll('details')].find((d) => d.querySelector('summary')?.textContent === 'tavily options'); details.open = true`,
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.querySelector('[name="pageLimit"]').form.querySelector('[name="mode"]').value)`,
                ),
                "basic",
            );
            await page.evaluate(
                `const form = document.querySelector('[name="pageLimit"]').form; const mode = form.querySelector('[name="mode"]'); mode.value = 'advanced'; mode.dispatchEvent(new Event('change', {bubbles:true})); form.querySelector('[name="pageLimit"]').value = '6'; form.requestSubmit()`,
            );
            await until(
                async () =>
                    (await app.webAccess.getState()).providerSettings.tavily?.pageLimit === 6,
                "saved crawl limit",
            );
            assert.equal(
                (await app.webAccess.getState()).providerSettings.tavily?.mode,
                "advanced",
            );
            assert.equal(
                (await app.webAccess.getState()).providerSettings.tavily?.includeAnswer,
                true,
            );
            await page.reload();
            await open();
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.querySelector('[aria-label="quick provider 1"]').value)`,
                ),
                "exa",
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.querySelector('[aria-label="quick mode 1"]').value)`,
                ),
                "deep-lite",
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.querySelector('[name="pageLimit"]').value)`,
                ),
                "6",
            );
            await page.evaluate(
                `document.querySelectorAll('.web-options-group').forEach((e) => { if(e.tagName === 'DETAILS') e.open = true; })`,
            );
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
                ),
                true,
            );
            const overflow = await evaluate<string[]>(
                `return JSON.stringify([...document.querySelectorAll('.web-access-options *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && e.getBoundingClientRect().width > 0).map((e) => e.tagName + ':' + e.className).slice(0,10))`,
            );

            assert.deepEqual(overflow, []);
            await page.evaluate(`document.querySelector('.web-access-options').scrollIntoView()`);
            await page.waitFor({ ms: 300 });
            const screenshot = await page.screenshot();

            writeFileSync(
                join(tmpdir(), "pi-pocket-web-access-mobile.png"),
                Buffer.from(screenshot.data, "base64"),
            );
            assert.deepEqual(
                page
                    .logs()
                    .filter((l) => l.level === "error")
                    .map((l) => l.text),
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
