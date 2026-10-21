// Real isolated routes and assets. Touch is Chromium emulation, not hardware input.
import {
    cleanUp,
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
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser" : false };
const host = ".sheet-host:not(.leaving)";
const search = `${host} input[aria-label="Search tags"]`;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let scopeTarget: ConversationId;
let tagWrites = 0;
const ids: ConversationId[] = [];

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function expectPage(script: string, message: string): Promise<void> {
    await until(
        () => inPage<boolean>(`return JSON.stringify(Boolean(${script}))`),
        message,
        15_000,
    );
}

async function click(selector: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 320));
    await page.click({ selector });
}

async function button(text: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 320));
    const position = await inPage<{ x: number; y: number }>(`
        const button = [...document.querySelectorAll('${host} button')].find(each => each.textContent.trim().startsWith(${JSON.stringify(text)}));
        if (!button) throw Error('Missing button: ' + ${JSON.stringify(text)});
        button.scrollIntoView({ block: 'nearest' });
        const box = button.getBoundingClientRect();
        return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    `);

    await page.click(position);
}

async function fresh(width: number, height: number): Promise<string> {
    await page.setViewport({ width, height, scale: 1, mobile: width < 700 });
    await page.navigate(`${base}/`);
    const list = width < 700 ? ".home-list" : ".sidebar";

    await expectPage(
        `document.querySelector(${JSON.stringify(`${list} .search-filters`)}) !== null`,
        "native filter action ready",
    );
    await page.evaluate(
        "await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 350))",
    );

    return list;
}

async function openFilters(list: string): Promise<void> {
    await click(`${list} .search-filters`);
    await expectPage(
        `(await import('/store.js')).store.state.sheet?.type === 'session-tag-filter'`,
        "native Filter sessions modal",
    );
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector(${JSON.stringify(search)}) !== null)`,
        ),
        true,
        "Filter sessions has an accessible Search tags field",
    );
}

async function query(value: string, expectedRows: number): Promise<void> {
    await page.type({ selector: search }, value);
    await expectPage(
        `document.querySelectorAll('${host} .tag-filter-results input[type="checkbox"]').length === ${expectedRows}`,
        `vocabulary query ${JSON.stringify(value)} has ${expectedRows} rows`,
    );
}

async function toggle(tag: string): Promise<void> {
    const selector = await inPage<string>(`
        const labels = [...document.querySelectorAll('${host} .tag-filter-results label')];
        const index = labels.findIndex(each => each.textContent.trim() === ${JSON.stringify(tag)});
        if (index < 0) throw Error('Missing result ' + ${JSON.stringify(tag)});
        return JSON.stringify('${host} .tag-filter-results label:nth-child(' + (index + 1) + ') input');
    `);

    await click(selector);
}

function metadata(): string {
    return JSON.stringify(ids.map((id) => [Number(id), app.sessionMeta(id)?.tags ?? []]));
}

before(async () => {
    if (!chromium) {
        return;
    }

    app = await openApp(scriptedModel());

    for (let index = 0; index < 16; index++) {
        const id = await newSession(app);

        ids.push(id);
        await app.commands.updateSession(id, owner(app), { title: `Vocabulary ${index}` });
        await app.commands.updateSessionTags(owner(app), {
            ids: [Number(id)],
            add: Array.from(
                { length: 8 },
                (_, tag) => `topic-${String(index * 8 + tag).padStart(3, "0")}`,
            ),
        });
    }

    for (const [title, tags] of [
        ["Scope both", ["topic-000", "topic-127"]],
        ["Scope first", ["topic-000"]],
    ] as const) {
        const id = await newSession(app);

        ids.push(id);
        scopeTarget = id;
        await app.commands.updateSession(id, owner(app), { title });
        await app.commands.updateSessionTags(owner(app), { ids: [Number(id)], add: [...tags] });
    }

    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        if (request.method === "POST" && request.url?.split("?")[0] === "/api/sessions/tags") {
            tagWrites++;
        }

        return handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "tag-filter-ui-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1280, height: 800, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.close();
    cleanUp();
});

test(
    "tag filter: vocabulary search preserves immediate scoped AND filters and selected chips without metadata writes",
    real,
    async () => {
        const before = metadata();
        const list = await fresh(390, 844);

        await page.type({ selector: `${list} input[aria-label="Search sessions"]` }, "Scope");
        await openFilters(list);
        await query("", 128);
        await query("  TOPIC-12  ", 8);
        await toggle("topic-127");
        await expectPage(
            `document.querySelector('${host} [role="status"]')?.textContent.includes('1 matching session')`,
            "scope query matches one session immediately",
        );
        await query("topic-000", 1);
        await toggle("topic-000");
        await expectPage(
            `document.querySelectorAll('${host} .tag-filter-selected button').length === 2 && document.querySelector('${host} [role="status"]')?.textContent.includes('1 matching session')`,
            "two selected tags combine with AND, not OR",
        );
        await query("does-not-exist", 0);
        await expectPage(
            `document.querySelector('${host} .tag-filter-results')?.textContent.toLowerCase().includes('no')`,
            "empty search has an explicit state",
        );
        await page.evaluate(
            `document.querySelector('${host} .tag-filter-selected [aria-label="Remove topic-127 filter"]').focus()`,
        );
        await page.press("Enter");
        await expectPage(
            `document.querySelectorAll('${host} .tag-filter-selected button').length === 1 && document.querySelector('${host} [role="status"]')?.textContent.includes('2 matching sessions')`,
            "hidden selected chip removes its AND constraint immediately",
        );
        const focus = await inPage<boolean>(`
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const active = document.activeElement;
        return JSON.stringify(Boolean(active !== document.body && active?.isConnected && document.querySelector('${host}').contains(active) && (active.matches('input[aria-label="Search tags"]') || active.closest('.tag-filter-selected'))));
    `);

        assert.equal(
            focus,
            true,
            "keyboard chip removal leaves focus on a meaningful modal control",
        );
        await button("Clear tags");
        await expectPage(
            `document.querySelector(${JSON.stringify(search)}).value === 'does-not-exist' && document.querySelectorAll('${host} .tag-filter-selected button').length === 0 && document.querySelector('${host} [role="status"]')?.textContent.includes('2 matching sessions')`,
            "Clear tags preserves vocabulary query and current session scope",
        );
        await query("", 128);
        await query("topic-127", 1);
        await toggle("topic-127");
        await button("Done");
        await expectPage(
            `(await import('/store.js')).store.state.sheet === null && document.querySelectorAll(${JSON.stringify(`${list} .session-row`)}).length === 1`,
            "Done keeps the immediate filter on the session list",
        );
        await openFilters(list);
        await expectPage(
            `document.querySelectorAll('${host} .tag-filter-selected button').length === 1`,
            "reopening retains selected filters",
        );
        await page.press("Escape");
        await expectPage(
            `(await import('/store.js')).store.state.sheet === null && document.querySelector(${JSON.stringify(`${list} .search-filters`)})?.getAttribute('aria-label') === 'Filters, 1 active tags'`,
            "closing retains filters",
        );
        assert.equal(metadata(), before, "filtering never changes shared session tags");
        assert.equal(tagWrites, 0, "no shared tag mutation HTTP requests");
    },
);

test(
    "tag filter: large results scroll independently with stationary footer across desktop and touch; edit modal stays separate",
    real,
    async () => {
        const before = metadata();

        for (const [width, height] of [
            [1280, 800],
            [390, 844],
            [320, 500],
        ] as const) {
            const list = await fresh(width, height);

            await openFilters(list);
            await button("Clear tags");
            await query("", 128);
            const geometry = await inPage<{
                bounded: boolean;
                footerVisible: boolean;
                independent: boolean;
                stationary: boolean;
                targets: boolean;
                overflow: boolean;
            }>(`
            const host = document.querySelector('${host}');
            const results = host.querySelector('.tag-filter-results');
            const selected = host.querySelector('.tag-filter-selected');
            const footer = host.querySelector('.tag-filter-footer');
            if (!results || !footer) throw Error('Missing bounded results or stationary footer');
            const initial = footer.getBoundingClientRect();
            results.scrollTop = results.scrollHeight;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const final = footer.getBoundingClientRect();
            return JSON.stringify({
                bounded: results.scrollHeight > results.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(results).overflowY) && results.clientHeight < innerHeight * .65,
                footerVisible: final.top >= 0 && final.bottom <= innerHeight,
                independent: !results.contains(footer) && (!selected || !results.contains(selected)),
                stationary: Math.abs(initial.top - final.top) < .5,
                targets: !matchMedia('(pointer:coarse)').matches || [...results.querySelectorAll('label'), ...footer.querySelectorAll('button')].every(each => each.getBoundingClientRect().height >= 40),
                overflow: document.documentElement.scrollWidth > innerWidth,
            });
        `);

            console.log("TAG_FILTER_GEOMETRY", JSON.stringify({ width, height, geometry }));
            assert.deepEqual(
                geometry,
                {
                    bounded: true,
                    footerVisible: true,
                    independent: true,
                    stationary: true,
                    targets: true,
                    overflow: false,
                },
                `${width}x${height}: independent bounded results and accessible stationary actions`,
            );
            await button("Done");
            await expectPage(
                `(await import('/store.js')).store.state.sheet === null`,
                "filter modal closed",
            );
        }

        const list = await fresh(1280, 800);

        await page.evaluate(
            `document.querySelector('${list} .session-row[data-id="${scopeTarget}"] > .session').focus()`,
        );
        await page.press("Shift+F10");
        await expectPage(
            `(await import('/store.js')).store.state.sheet?.type === 'session'`,
            "native session actions",
        );
        await button("Edit tags");
        await expectPage(
            `(await import('/store.js')).store.state.sheet?.type === 'session-tags'`,
            "existing edit modal",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(!!document.querySelector('#session-tag-input') && !document.querySelector(${JSON.stringify(search)}) && !document.querySelector('${host} .tag-filter-results'))`,
            ),
            true,
            "edit modal retains its own input and is not converted to the filter UI",
        );
        await button("Cancel");
        assert.equal(metadata(), before, "geometry and edit inspection never change metadata");
        assert.equal(tagWrites, 0);
    },
);
