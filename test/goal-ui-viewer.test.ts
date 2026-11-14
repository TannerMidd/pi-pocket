// Read-only Goal controls on desktop, including reload and extension cleanup.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let browsers: Browsers;

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "desktop viewers see the goal after reload but cannot mutate it, and disabling its module removes its UI",
    { skip: findBrowser() === undefined ? "no Chromium browser" : false },
    async () => {
        app = await openApp(
            scriptedModel(() =>
                fauxAssistantMessage(
                    JSON.stringify({ verdict: "blocked", reason: "Needs a credential." }),
                ),
            ),
        );
        const id = await newSession(app);

        await app.commands.updateSession(id, owner(app), { title: "Visible goal" });
        await app.objectiveGoals.command(
            id,
            owner(app),
            "Verify the desktop fixture",
            crypto.randomUUID(),
        );
        await (await app.conversation(id)).waitForIdle(context);
        const viewer = app.config.addUser("Reader", "viewer");

        server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

        browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "goal-viewer-")),
            load: async () => undefined,
            save: () => {},
        });
        const page = await browsers.open(1);

        await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
        await page.navigate(
            `${base}/login?token=${encodeURIComponent(viewer.token)}&next=/s/${id}`,
        );
        const has = async (selector: string) =>
            JSON.parse(
                await page.evaluate(
                    `return JSON.stringify(!!document.querySelector(${JSON.stringify(selector)}))`,
                ),
            ) as boolean;

        await until(() => has(".x-goal-bar"), "viewer goal bar");
        assert.equal(await has(".x-goal-toggle"), false);
        await page.navigate(`${base}/s/${id}`);
        await until(() => has(".x-goal-bar"), "goal after reload");
        await page.click({ selector: ".x-goal-overview" });
        await until(() => has(".x-goal-sheet"), "read-only goal details");
        const controls = JSON.parse(
            await page.evaluate(
                `return JSON.stringify([...document.querySelectorAll('.x-goal-sheet button')].filter((b) => /Resume goal|Edit goal|Delete goal|Save budget|Save evaluator/.test(b.textContent)).map((b) => b.disabled))`,
            ),
        ) as boolean[];

        assert.ok(controls.length >= 3);
        assert.ok(controls.every(Boolean));
        assert.equal(await has(".x-goal-sheet .x-goal-full-objective"), true);
        await app.setExtensionEnabled(owner(app), "objective-goal.ts", false);
        await until(
            async () => !(await has(".x-goal-bar")) && !(await has(".x-goal-sheet")),
            "goal UI unloaded",
        );
        assert.equal(await has(".composer-wrap"), true, "the rest of the app stays usable");
    },
);
