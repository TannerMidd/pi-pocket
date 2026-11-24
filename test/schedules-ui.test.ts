// The Schedules sheet marks the schedules of an archived session; the status line shows a session's schedules.
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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const items = async (id: Awaited<ReturnType<typeof newSession>>) => app.schedules.list(id);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const extensions = join(root, "data", "extensions");

    mkdirSync(extensions, { recursive: true });
    writeFileSync(
        join(extensions, "schedule-locale.ts"),
        `/** Minimal locale for schedule skip regressions. */
export default (_host, web) => web.uiLocales([{id:"zh-CN",label:"测试",messages:{
    "web.running-board.release0281.skipped":" · 已跳过 {count} 次",
    "web.sheets.schedules.release0281.skipped-once":"已跳过一次，最近一次为 {when}",
    "web.sheets.schedules.release0281.skipped-many":"已跳过 {count} 次，最近一次为 {when}"
}}]);\n`,
    );
    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("done")])));
    await app.setExtensionEnabled(owner(app), "schedule-locale.ts", true);
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

test(
    "Pause on a schedule's card stops it with one tap, and Resume starts it again",
    real,
    async () => {
        const id = await newSession(app);

        await app.commands.schedule(id, owner(app), { when: "every 30m pause me", zone: "UTC" });
        await page.setViewport(VIEWPORTS.mobile);
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                await inPage<boolean>(`
            const { store, openSheet } = await import("/store.js");
            if ((store.state.view.schedules ?? []).length < 1) {
                return JSON.stringify(false);
            }

            openSheet({ type: "schedules" });
            return JSON.stringify(document.querySelector(".sched-pause") !== null);
        `),
            "the sheet with its pause button",
            20_000,
        );
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".sheet").getAnimations().length === 0)`,
                ),
            "the sheet to settle",
        );
        await page.click({ selector: ".sched-pause" });
        await until(
            async () => (await items(id))[0]?.paused !== undefined,
            "the server to have it paused",
            10_000,
        );
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".sched-item.paused .sched-countdown")?.textContent.trim() === "paused")`,
                ),
            "the card to show it paused",
            10_000,
        );
        // The status line says the session's schedules are all paused, with nothing to count down to.
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".status-line .schedules-now")?.textContent ?? "")`,
            ),
            "1 paused",
        );
        assert.match(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".sched-summary").textContent)`,
            ),
            /0\s*scheduled · 1 paused/,
        );

        await page.click({ selector: ".sched-pause" });
        await until(
            async () => (await items(id))[0]?.paused === undefined,
            "the server to have it resumed",
            10_000,
        );
    },
);

test("the editor's Pause keeps what was typed, and Save after it still works", real, async () => {
    const id = await newSession(app);

    // Not this device's zone: a save that leaves the time of day as it was keeps it.
    await app.commands.schedule(id, owner(app), {
        when: "every weekday 8:00 before",
        zone: "Pacific/Kiritimati",
    });
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            await inPage<boolean>(`
            const { store, openSheet } = await import("/store.js");
            if ((store.state.view.schedules ?? []).length < 1) {
                return JSON.stringify(false);
            }

            openSheet({ type: "schedules" });
            return JSON.stringify(document.querySelector(".sched-card") !== null);
        `),
        "the sheet",
        20_000,
    );
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
                `return JSON.stringify(document.querySelector(".sched-editor textarea") !== null)`,
            ),
        "the editor",
    );
    await inPage<string>(`
        const box = document.querySelector(".sched-editor textarea");
        box.value = "typed, not saved";
        box.dispatchEvent(new Event("input", { bubbles: true }));
        return JSON.stringify("ok");
    `);
    await page.click({ selector: '[data-part="schedule-editor-pause"]' });
    await until(async () => (await items(id))[0]?.paused !== undefined, "paused", 10_000);
    await until(
        async () =>
            (await inPage<string>(
                `return JSON.stringify(document.querySelector('[data-part="schedule-editor-pause"]')?.textContent.trim() ?? "")`,
            )) === "Resume",
        "the editor's button to read Resume",
        10_000,
    );
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".sched-editor textarea").value)`,
        ),
        "typed, not saved",
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector(".sched-changed") !== null)`,
        ),
        false,
        "its own pause is no change by someone else",
    );
    await page.click({ selector: ".sched-editor .button.primary" });
    await until(async () => (await items(id))[0]?.text === "typed, not saved", "the save", 10_000);
    assert.ok((await items(id))[0]?.paused !== undefined, "still paused after the save");
    assert.equal((await items(id))[0]?.zone, "Pacific/Kiritimati");
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
                    "const row=[...document.querySelectorAll('.rb-sched')].find(row=>row.querySelector('.rb-sched-text')?.textContent==='skipping');return JSON.stringify(Boolean(row?.querySelector('.rb-sched-rel')?.textContent.includes('2')))",
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

test("the editor keeps a window, previews the server's next run, removes it", real, async () => {
    const id = await newSession(app);

    await app.commands.schedule(id, owner(app), {
        when: "every 1h between 9:00 and 17:00 on weekdays windowed",
        zone: "UTC",
    });
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    const read = (script: string) => inPage<string>(`return JSON.stringify(${script})`);
    const cardNext = () =>
        read(`/next (.*?) ·/.exec(document.querySelector(".sched-card")?.textContent)?.[1] ?? ""`);

    await until(
        async () => {
            await inPage(
                `(await import("/store.js")).openSheet({ type: "schedules" }); return "0";`,
            );

            return (await cardNext()) !== "";
        },
        "the sheet",
        20_000,
    );
    const next = await cardNext();

    await inPage(`document.querySelector(".sched-card").click(); return "0";`);
    await until(
        async () =>
            (await read(`document.querySelector('[aria-label="From"]')?.value`)) === "09:00",
        "the editor with its window",
    );
    assert.match(
        await read(`document.querySelector(".sched-preview").textContent`),
        new RegExp(`Weekdays, 09:00 to 17:00 · Next ${next}`),
    );
    await inPage(
        `const from = document.querySelector('[aria-label="From"]'); from.value = ""; from.dispatchEvent(new Event("input", { bubbles: true })); return "0";`,
    );
    await until(
        async () =>
            (await read(`document.querySelector(".sched-editor")?.textContent ?? ""`)).includes(
                "Pick when the window starts and ends.",
            ),
        "the window's message",
    );
    await page.click({ selector: ".sched-editor .switch" });
    await page.click({ label: "Save" });
    await until(async () => !("window" in ((await items(id))[0]?.every ?? {})), "no window");
    assert.deepEqual((await items(id))[0]?.every, { minutes: 60 });
});
