// Claude subscription billing asks before it turns on, with the risks, and says them while it is on.
import { cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);

test(
    "Claude subscription billing says Anthropic's terms and help pages disagree, before and while it is on",
    { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false },
    async (t) => {
        const app = await openApp(scriptedModel());
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "claude-billing-ui-")),
            load: async () => undefined,
            save: () => {},
        });

        t.after(async () => {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            server.close();
            await app.close();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const inPage = async <T>(script: string) => JSON.parse(await page.evaluate(script)) as T;
        const see = (expression: string, what: string) =>
            until(() => inPage<boolean>(`return JSON.stringify(${expression})`), what);
        const id = await newSession(app);
        const toggle = `button[role="switch"][aria-label^="Claude subscription billing:"]`;

        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await page.navigate(`${base}/s/${id}`);
        await see(`document.querySelector(".composer") !== null`, "the session");
        await page.evaluate(
            `(await import("/store.js")).openSheet({ type: "extensions", tab: "installed", show: "built-in" }); return "null"`,
        );
        await see(`document.querySelector(${JSON.stringify(toggle)}) !== null`, "its switch");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(toggle)}).getAttribute("aria-checked"))`,
            ),
            "false",
        );

        // Its row says so first, where a cut-off line still shows it.
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(toggle)}).closest(".ext-row").querySelector(".ext-row-desc").textContent)`,
            ),
            /^At your own risk, as Anthropic's terms and its help pages disagree on it/,
        );

        // Turning it on asks first, with what Anthropic's terms say.
        await page.click({ selector: toggle });
        await see(`document.querySelector(".ext-confirm") !== null`, "the question");
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".ext-confirm").textContent)`,
            ),
            /Anthropic's terms forbid using Claude through scripts.*Turn it on only if you accept that risk/,
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(toggle)}).getAttribute("aria-checked"))`,
            ),
            "false",
        );

        await page.click({ selector: ".ext-confirm .button.primary" });
        await see(
            `document.querySelector(${JSON.stringify(toggle)})?.getAttribute("aria-checked") === "true"`,
            "it on",
        );
        await see(
            `[...document.querySelectorAll(".ext-row-under.warn")].some((line) => line.textContent.startsWith("On at your own risk"))`,
            "the line while it is on",
        );
    },
);
