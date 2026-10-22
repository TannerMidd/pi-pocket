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
    "phone menu global auto-resume toggle updates existing/new chats and survives reload",
    { skip: findBrowser() ? false : "no Chromium-based browser" },
    async () => {
        const app = await openApp(scriptedModel());
        const id = await newSession(app);
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "resume-ui-")),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const evaluate = async <T>(script: string): Promise<T> =>
            JSON.parse(await page.evaluate(script));

        const openMenu = async () => {
            await page.evaluate(`(await import('/store.js')).openSheet({type:'menu'})`);
            await until(
                async () =>
                    evaluate<boolean>(
                        `return JSON.stringify([...document.querySelectorAll('.list-item')].some((e) => e.textContent.includes('Auto-resume by default')))`,
                    ),
                "global auto-resume menu control",
            );
        };

        const click = (label: string) =>
            page.evaluate(
                `const item = [...document.querySelectorAll('.list-item')].find((e) => e.textContent.includes(${JSON.stringify(label)})); if (!item) throw new Error('Missing menu control'); item.click()`,
            );
        const on = () =>
            evaluate<boolean>(
                `return JSON.stringify((await import('/store.js')).store.state.view.usageResume?.on === true)`,
            );

        try {
            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(
                `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=${encodeURIComponent(`/s/${id}`)}`,
            );
            await until(
                async () =>
                    evaluate<boolean>(
                        `return JSON.stringify(!!(await import('/store.js')).store.state.view.conversation)`,
                    ),
                "the existing chat",
            );
            await openMenu();
            assert.equal(await on(), false);
            await click("Auto-resume by default");
            await until(
                async () => app.config.usageResumeDefault && (await on()),
                "global default reflected in existing chat",
            );
            await page.reload();
            await until(on, "the default after reload");
            await openMenu();
            await click("Auto-resume after usage reset");
            await until(async () => !(await on()), "per-chat opt-out");
            await until(
                async () =>
                    evaluate<boolean>(
                        `return JSON.stringify([...document.querySelectorAll('.list-item')].some((e) => e.textContent.includes('Use app auto-resume default')))`,
                    ),
                "return-to-default control",
            );
            await click("Use app auto-resume default");
            await until(on, "per-chat inheritance restored");
            assert.equal(
                await evaluate(
                    `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
                ),
                true,
            );
            const second = await newSession(app);

            await page.navigate(`${base}/s/${second}`);
            await until(
                async () =>
                    evaluate<boolean>(
                        `const s=(await import('/store.js')).store.state; return JSON.stringify(Number(s.view.conversation?.id) === ${Number(second)} && s.view.usageResume?.on === true)`,
                    ),
                "new chat using global default",
            );
            await openMenu();
            await click("Auto-resume by default");
            await until(
                async () => !app.config.usageResumeDefault && !(await on()),
                "global default disabled",
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
