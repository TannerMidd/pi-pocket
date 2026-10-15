// Settings in the rail and PiP's model picker must configure PiP, not the session behind it.
import { cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();

test(
    "rail settings change PiP's model independently and keep it after reopening",
    {
        skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
    },
    async () => {
        const app = await openApp(scriptedModel());
        const session = await newSession(app);
        const original = (await app.agentState(session))?.model;
        const server = createServer(
            createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "pip-settings-browser-")),
            load: async () => undefined,
            save: () => {},
        });

        try {
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            const page = await browsers.open(1);
            const see = (script: string, what: string) =>
                until(
                    async () =>
                        JSON.parse(await page.evaluate(`return JSON.stringify(${script})`)) ===
                        true,
                    what,
                );

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await see(`(await import("/store.js")).store.state.me?.role === "owner"`, "signed in");
            await page.evaluate(`(await import("/store.js")).navigate(${session}); return "true"`);
            await see(
                `(await import("/store.js")).store.state.view.conversation?.id === ${session}`,
                "session loaded",
            );
            await see(`!!document.querySelector('.rail [aria-label="Settings"]')`, "rail settings");
            assert.equal(
                JSON.parse(
                    await page.evaluate(
                        `return JSON.stringify(document.querySelector('.rail [aria-label="Settings"]').nextElementSibling.getAttribute("aria-label"))`,
                    ),
                ),
                "Your name",
            );
            await page.evaluate(
                `document.querySelector('.rail [aria-label="Settings"]').click(); return "true"`,
            );
            await see(
                `!![...document.querySelectorAll(".list-item")].find(row => row.textContent.includes("PiP model"))`,
                "PiP setting",
            );
            await page.evaluate(
                `[...document.querySelectorAll(".list-item")].find(row => row.textContent.includes("PiP model")).click(); return "true"`,
            );
            await see(
                `!!document.querySelector('[aria-label="PiP model"].pop-menu')`,
                "PiP model picker",
            );
            await see(
                `!!(await import("/store.js")).store.state.pipView.agent`,
                "PiP agent loaded",
            );
            await page.evaluate(
                `const row = [...document.querySelectorAll('.pop-menu-row')].find(row => row.title.startsWith('faux/faux-2 ')); row.click(); return "true"`,
            );
            const pip = app.pip.idOf(app.config.users.find((user) => user.role === "owner")!.id)!;

            await until(
                async () => (await app.agentState(pip))?.model?.modelId === "faux-2",
                "PiP model changed",
            );
            assert.deepEqual((await app.agentState(session))?.model, original);
            await page.evaluate(
                `const pip = await import("/pip.js"); pip.closePip(); pip.openPip(); return "true"`,
            );
            await until(
                async () => (await app.agentState(pip))?.model?.modelId === "faux-2",
                "PiP model kept",
            );
            await see(
                `!!document.querySelector('.pip-head [aria-label="PiP model"]')`,
                "panel model button",
            );
            await see(
                `(await import("/store.js")).store.state.pipView.agent?.model?.modelId === "faux-2"`,
                "updated PiP model in the browser",
            );
            await page.evaluate(
                `(await import("/store.js")).openSheet({ type: "settings" }); return "true"`,
            );
            await see(
                `[...document.querySelectorAll(".list-item")].some(row => row.textContent.includes("PiP model") && row.textContent.includes("faux-2"))`,
                "settings show PiP's selected model",
            );
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            server.close();
            await app.close();
            cleanUp();
        }
    },
);
