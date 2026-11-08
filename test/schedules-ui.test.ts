// The Schedules sheet marks the schedules of an archived session; the status line shows a session's schedules.
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
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script));

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("done")])));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "schedules-ui-")),
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

test("a schedule of an archived session is marked in the Schedules sheet", real, async () => {
    const id = await newSession(app);

    await app.commands.schedule(id, owner(app), { when: "every 20m ping", zone: "UTC" });
    await app.commands.updateSession(id, owner(app), { archived: true });
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            await inPage<boolean>(`
                const { store, openSheet } = await import("/store.js");
                if (store.state.sessions.length === 0) {
                    return JSON.stringify(false);
                }

                openSheet({ type: "schedules" });
                return JSON.stringify(document.querySelector(".sched-card") !== null);
            `),
        "the sheet",
        20_000,
    );
    assert.match(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".sched-card").textContent)`,
        ),
        /session archived/,
    );
});

test(
    "the status line shows a session's schedules, counts down on hover, and opens the sheet",
    real,
    async () => {
        const id = await newSession(app);

        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".status-line") !== null)`,
                ),
            "the status line",
            20_000,
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".status-line .schedules-now") !== null)`,
            ),
            false,
            "no pill without schedules",
        );

        await app.commands.schedule(id, owner(app), {
            when: "in 30m check the deploy",
            zone: "UTC",
        });
        await app.commands.schedule(id, owner(app), { when: "every 2h ping", zone: "UTC" });
        await until(
            async () =>
                (await inPage<string>(
                    `return JSON.stringify(document.querySelector(".status-line .schedules-now")?.textContent ?? "")`,
                )) === "2 scheduled",
            "the pill",
            20_000,
        );

        await page.hover({ selector: ".status-line .schedules-now" });
        const readTip = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector(".schedules-tip")?.textContent ?? "")`,
            );

        await until(async () => (await readTip()) !== "", "the countdown", 10_000);
        const tip = await readTip();

        assert.match(tip, /Next in\s*(29:\d\d|30:00)/);
        assert.match(tip, /check the deploy/);
        assert.match(tip, /2 scheduled · 1 repeating/);

        await page.click({ selector: ".status-line .schedules-now" });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelectorAll(".sched-card").length === 2)`,
                ),
            "the Schedules sheet",
            10_000,
        );
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".sched-card .sched-countdown").textContent)`,
            ),
            /in (29:\d\d|30:00)/,
        );
    },
);

test(
    "the Schedules sheet edits a schedule: from once to weekdays at a time, and deletes one",
    real,
    async () => {
        const id = await newSession(app);

        await app.commands.schedule(id, owner(app), { when: "in 40m first one", zone: "UTC" });
        await app.commands.schedule(id, owner(app), { when: "in 50m second one", zone: "UTC" });
        await page.setViewport(VIEWPORTS.mobile);
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                await inPage<boolean>(`
                const { store, openSheet } = await import("/store.js");
                if ((store.state.view.schedules ?? []).length < 2) {
                    return JSON.stringify(false);
                }

                openSheet({ type: "schedules" });
                return JSON.stringify(document.querySelectorAll(".sched-card").length === 2);
            `),
            "the sheet with both",
            20_000,
        );

        // Open the first in the editor, change its text, and make it weekdays at 07:45.
        // A real tap, once the sheet has slid up: during its slide the card is not yet where it ends.
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".sheet").getAnimations().length === 0)`,
                ),
            "the sheet to settle",
        );
        await page.click({ selector: ".sched-card" });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".sched-editor textarea")?.value === "first one")`,
                ),
            "the editor",
        );
        await page.fill({ selector: ".sched-editor textarea" }, "changed one");
        await page.click({ label: "On days" });
        await inPage(`
        const field = document.querySelector('.sched-editor input[type="time"]');
        field.value = "07:45";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);
        await page.click({ selector: ".sched-chips .chip:nth-child(2)" });
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".sched-preview").textContent)`,
            ),
            /Weekdays at 07:45/,
        );
        await page.click({ label: "Save" });

        const ours = async () =>
            (await app.schedules.list(id)).find((each) => each.text === "changed one");

        await until(async () => (await ours()) !== undefined, "the change on the server");
        const changed = (await ours())!;

        assert.deepEqual(changed.every, { at: "07:45", days: [1, 2, 3, 4, 5] });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".sched-editor") === null && [...document.querySelectorAll(".sched-card")].some((card) => /weekdays at 07:45/.test(card.textContent)))`,
                ),
            "the list to show the repeat",
        );

        // Delete the other one from its editor.
        await inPage(`
        [...document.querySelectorAll(".sched-card")].find((card) => card.textContent.includes("second one")).click();
        return "null";
    `);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".sched-editor textarea")?.value === "second one")`,
                ),
            "its editor",
        );
        await page.click({ label: "Delete" });
        await until(async () => (await app.schedules.list(id)).length === 1, "it to be deleted");
    },
);
