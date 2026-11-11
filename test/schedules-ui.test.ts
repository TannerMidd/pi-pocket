// The Schedules sheet marks the schedules of an archived session.
import {
    type App,
    cleanUp,
    context,
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
import { ScheduleDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { capture0281 } from "./main-0281-ui-evidence.ts";
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
                return JSON.stringify(document.querySelector(".schedule") !== null);
            `),
        "the sheet",
        20_000,
    );
    assert.match(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".schedule").textContent)`,
        ),
        /session archived/,
    );
});

test("the Schedules sheet says how often a repeat skipped its time", real, async () => {
    const id = await newSession(app);
    const repeat = await app.commands.schedule(id, owner(app), {
        when: "every 20m skipping",
        zone: "UTC",
    });

    // As the scheduler leaves it after two times whose last message still waited in the queue.
    await app.harness.commit(async (tx) => {
        const item = (await tx.doc(ScheduleDoc, id)).items[repeat.id]!;

        item.skipped = 2;
        item.skippedAt = Date.now();
    }, context);
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
                return JSON.stringify(document.querySelector('[data-part="schedule-skipped"]') !== null);
            `),
        "the skips",
        20_000,
    );
    assert.match(
        await inPage<string>(
            `return JSON.stringify(document.querySelector('[data-part="schedule-skipped"]').textContent)`,
        ),
        /Skipped 2 times, last .*: its last message still waits in the queue/,
    );
    assert.ok(chromium, "Chromium is required for schedule skip locale acceptance");

    for (const viewport of ["mobile", "desktop"] as const) {
        await page.setViewport(VIEWPORTS[viewport]);
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                await inPage<boolean>(
                    "return JSON.stringify(document.querySelector('.composer')!==null)",
                ),
            "the actual session",
        );
        await page.evaluate(
            "(await import('/ui-locale.js')).setLocale('zh-CN');(await import('/store.js')).openSheet({type:'schedules'})",
        );
        await until(
            async () =>
                await inPage<boolean>(
                    "return JSON.stringify(/[\\u4e00-\\u9fff]/u.test(document.querySelector('[data-part=schedule-skipped]')?.textContent??''))",
                ),
            "the real Schedules skip line is Chinese",
        );
        const skipped = await inPage<string>(
            "return JSON.stringify(document.querySelector('[data-part=schedule-skipped]').textContent)",
        );

        assert.ok(skipped.includes("2") && !skipped.includes("Skipped"), skipped);
        await capture0281(
            page,
            viewport + "-schedule-skipped-chinese",
            "Schedules → actual repeat with 2 persisted skips",
            '[data-part="schedule-skipped"]',
        );
        await page.evaluate("(await import('/store.js')).openRunning()");
        await until(
            async () =>
                await inPage<boolean>(
                    "const row=[...document.querySelectorAll('.rb-sched')].find(row=>row.querySelector('.rb-sched-text')?.textContent==='skipping');return JSON.stringify(row?.querySelector('.rb-sched-rel')?.textContent.includes('2'))",
                ),
            "the actual Running board schedule",
        );
        const running = await inPage<{ text: string; zone: string }>(
            "const row=[...document.querySelectorAll('.rb-sched')].find(row=>row.querySelector('.rb-sched-text')?.textContent==='skipping');return JSON.stringify({text:row.querySelector('.rb-sched-rel').textContent,zone:row.querySelector('.rb-sched-time').title})",
        );

        assert.match(running.text, /[\u4e00-\u9fff]/u);
        assert.ok(running.text.includes("2") && !running.text.includes("skipped"), running.text);
        assert.equal(running.zone, "UTC");
        const state = await inPage<{ runs: number; skipped: number; zone: string }>(
            `const board=await (await fetch('/api/running/board')).json();const item=board.schedules.find(item=>item.id===${JSON.stringify(repeat.id)});return JSON.stringify({runs:item.runs,skipped:item.skipped,zone:item.zone});`,
        );
        const stored = (await app.harness.snapshot(ScheduleDoc, id, context))!.items[repeat.id]!;

        assert.deepEqual(state, { runs: stored.runs, skipped: 2, zone: "UTC" });
        await capture0281(
            page,
            viewport + "-running-skipped-chinese",
            "Running now → repeat keeps runs, skips, and original zone",
            '[data-part="running-board"]',
        );
        await page.evaluate("(await import('/ui-locale.js')).setLocale('en')");
        await until(
            async () =>
                await inPage<boolean>(
                    "const row=[...document.querySelectorAll('.rb-sched')].find(row=>row.querySelector('.rb-sched-text')?.textContent==='skipping');return JSON.stringify(row?.querySelector('.rb-sched-rel')?.textContent.includes('skipped 2'))",
                ),
            "the original English skip count returns",
        );
    }
});
