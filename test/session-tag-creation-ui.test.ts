// Real isolated routes and assets. Mobile input is Chromium emulation, not hardware input.
// Import helpers first so no server module reads the owner's Pi configuration.
import {
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const vocabulary = Array.from(
    { length: 11 },
    (_, index) => `creation-${String(index).padStart(2, "0")}`,
);
const inherited = [vocabulary[0]!, vocabulary[10]!];
const viewports = [
    [1280, 800],
    [390, 844],
    [320, 500],
] as const;

interface CreationRequest {
    body: { cwd?: string; worktree?: boolean; tags?: string[] };
    status: number;
}
const requests: CreationRequest[] = [];
let tagWrites = 0;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

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
    // Sheet entrance/exit animations can otherwise intercept the next native click.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await page.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'nearest' })`,
    );
    await page.click({ selector });
}

async function sheetButton(text: string): Promise<void> {
    const selector = await inPage<string>(`
        const buttons = [...document.querySelectorAll('${host} button')];
        const index = buttons.findIndex(button => button.textContent.trim() === ${JSON.stringify(text)});
        if (index < 0) throw new Error('Missing sheet button ' + ${JSON.stringify(text)});
        buttons[index].setAttribute('data-creation-test-action', 'current');
        return JSON.stringify('${host} button[data-creation-test-action="current"]');
    `);

    await click(selector);
    await page.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.removeAttribute('data-creation-test-action')`,
    );
}

async function fresh(width: number, height: number): Promise<string> {
    await page.setViewport({ width, height, scale: 1, mobile: width < 700 });
    await page.navigate(`${base}/`);
    const list = width < 700 ? ".home-list" : ".sidebar";

    await expectPage(
        `document.querySelector('${list} .search-filters') !== null`,
        "native session list ready",
    );
    await page.evaluate(
        "await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 350))",
    );
    await expectPage(
        `document.querySelector('${list} .search-filters').getAttribute('aria-label') === 'Filters'`,
        "reload resets personal filters",
    );

    return list;
}

async function selectFilters(list: string, tags: readonly string[]): Promise<void> {
    await click(`${list} .search-filters`);
    await expectPage(
        `(await import('/store.js')).store.state.sheet?.type === 'session-tag-filter'`,
        "native tag filter sheet",
    );

    await new Promise((resolve) => setTimeout(resolve, 350));

    for (const tag of tags) {
        await page.type({ selector: `${host} input[aria-label="Search tags"]` }, tag);
        await expectPage(
            `document.querySelectorAll('${host} .tag-filter-results input[type="checkbox"]').length === 1`,
            `exact vocabulary result for ${tag}`,
        );
        await click(`${host} .tag-filter-results input[type="checkbox"]`);
        await expectPage(
            `document.querySelector('${host} .tag-filter-results input[type="checkbox"]').checked`,
            `${tag} selected`,
        );
    }

    await sheetButton("Done");
    await expectPage(
        `(await import('/store.js')).store.state.sheet === null && document.querySelector('${list} .search-filters').getAttribute('aria-label') === ${JSON.stringify(`Filters, ${tags.length} active tags`)}`,
        "Done retains every active tag",
    );
}

async function openNew(list: string): Promise<void> {
    await click(`${list} .sessions-head .new-button`);
    await expectPage(
        `(await import('/store.js')).store.state.sheet?.type === 'cwd' && document.querySelector('${host} .fp-buttons .primary:not(:disabled)') !== null`,
        "native folder picker ready",
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector('${host} .fp-options input[type="checkbox"]').checked)`,
        ),
        false,
        "Own git worktree keeps its existing unchecked default",
    );
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
        ),
        true,
        "folder picker has no page overflow",
    );
}

function sessionIds(): number[] {
    return app
        .sessions(owner(app))
        .map((session) => session.id)
        .sort((a, b) => a - b);
}

async function createdSession(beforeIds: number[], requestCount: number): Promise<ConversationId> {
    await until(
        () => requests.length === requestCount + 1 && sessionIds().length === beforeIds.length + 1,
        "one real session created",
    );
    const added = sessionIds().filter((id) => !beforeIds.includes(id));

    assert.equal(added.length, 1);
    assert.equal(requests.at(-1)?.status, 200);
    await expectPage(
        `(await import('/store.js')).store.state.sheet === null && Number((await import('/store.js')).store.state.conversationId) === ${added[0]}`,
        "Open navigates to the created session and dismisses the picker",
    );

    // The real HTTP creation and catalogue projection expose numeric conversation IDs.
    return added[0]! as ConversationId;
}

async function showMatchingRow(list: string, id: number, tags: readonly string[]): Promise<void> {
    if (list === ".home-list") {
        await click('button[aria-label^="Back to sessions"]');
    }

    await expectPage(
        `document.querySelector('${list} .session-row[data-id="${id}"]') !== null`,
        "created session remains in the active AND-filtered list",
    );
    const rowTags = await inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll('${list} .session-row[data-id="${id}"] .session-tags .chip')].map(tag => tag.textContent.trim()))`,
    );

    for (const tag of tags) {
        assert.ok(rowTags.includes(tag), `matching row displays ${tag}`);
    }
}

before(async () => {
    if (!chromium) {
        return;
    }

    app = await openApp(scriptedModel());

    // No seeded session contains all 11 tags (nor the 2-tag success intersection).
    for (const tags of [vocabulary.slice(0, 6), vocabulary.slice(6)]) {
        const id = await newSession(app);

        await app.commands.updateSessionTags(owner(app), { ids: [Number(id)], add: tags });
    }

    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        const path = request.url?.split("?")[0];

        if (request.method === "POST" && path === "/api/sessions") {
            let body = "";

            request.on("data", (chunk) => {
                body += String(chunk);
            });
            response.on("finish", () => {
                requests.push({ body: JSON.parse(body), status: response.statusCode });
            });
        }

        if (request.method === "POST" && path === "/api/sessions/tags") {
            tagWrites++;
        }

        return handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "tag-creation-ui-")),
        load: async () => undefined,
        save: () => {},
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.close();
    cleanUp();
});

for (const [width, height] of viewports) {
    test(
        `session creation ${width}x${height}: header New inherits all active filters atomically and persists after reload`,
        real,
        async () => {
            const list = await fresh(width, height);

            await selectFilters(list, inherited);
            const beforeIds = sessionIds();
            const requestCount = requests.length;

            await openNew(list);
            await sheetButton("Open");
            const id = await createdSession(beforeIds, requestCount);

            assert.deepEqual(
                requests.at(-1)?.body,
                { cwd: work, tags: inherited },
                "one creation request carries every filter and preserves folder/worktree options",
            );
            assert.deepEqual(
                app.sessionMeta(id)?.tags,
                inherited,
                "tags exist on the real created session",
            );
            assert.equal(tagWrites, 0, "creation never follows with a tag patch");
            await showMatchingRow(list, id, inherited);
            const evidenceDir = process.env.POLISH_EVIDENCE_DIR;

            if (evidenceDir) {
                mkdirSync(evidenceDir, { recursive: true });
                const shot = await page.screenshot();

                writeFileSync(
                    join(evidenceDir, `creation-${width}x${height}.jpg`),
                    Buffer.from(shot.data, "base64"),
                );
            }

            await fresh(width, height);
            await selectFilters(list, inherited);
            await expectPage(
                `document.querySelector('${list} .session-row[data-id="${id}"]') !== null`,
                "reloaded server projection retains the created session and its matching tags",
            );
            assert.deepEqual(app.sessionMeta(id)?.tags, inherited);
        },
    );

    test(
        `session creation ${width}x${height}: header New without filters starts untagged`,
        real,
        async () => {
            const list = await fresh(width, height);
            const beforeIds = sessionIds();
            const requestCount = requests.length;

            await openNew(list);
            await sheetButton("Open");
            const id = await createdSession(beforeIds, requestCount);

            assert.deepEqual(requests.at(-1)?.body.tags ?? [], []);
            assert.equal(requests.at(-1)?.body.cwd, work);
            assert.equal(requests.at(-1)?.body.worktree ?? false, false);
            assert.deepEqual(
                app.sessionMeta(id)?.tags ?? [],
                [],
                "no tags leak from previous filtered creation",
            );
            await showMatchingRow(list, id, []);
            await fresh(width, height);
            await expectPage(
                `document.querySelector('${list} .session-row[data-id="${id}"]') !== null`,
                "untagged creation survives reload",
            );
            assert.deepEqual(app.sessionMeta(id)?.tags ?? [], []);
            assert.equal(tagWrites, 0);
        },
    );

    test(
        `session creation ${width}x${height}: 11 active filters reject creation without a partial session and keep the picker open`,
        real,
        async () => {
            const list = await fresh(width, height);

            await selectFilters(list, vocabulary);
            await expectPage(
                `document.querySelectorAll('${list} .session-row').length === 0`,
                "no session matches the over-capacity tag union",
            );
            const beforeIds = sessionIds();
            const beforeTags = JSON.stringify(
                app.sessions(owner(app)).map((session) => [session.id, session.tags]),
            );
            const requestCount = requests.length;

            await openNew(list);
            await sheetButton("Open");
            await until(
                () => requests.length === requestCount + 1,
                "real rejected creation response",
            );
            assert.equal(requests.at(-1)?.status, 409);
            assert.deepEqual(
                requests.at(-1)?.body.tags,
                vocabulary,
                "all 11 filters reach server validation, never truncated",
            );
            await expectPage(
                `document.querySelector('.notice.error .notice-text')?.textContent.includes('10')`,
                "UI reports the tag-capacity error",
            );
            await expectPage(
                `(await import('/store.js')).store.state.sheet?.type === 'cwd' && document.querySelector('${host} .fp-buttons .primary:not(:disabled)') !== null`,
                "failed creation leaves the folder picker open and usable",
            );
            assert.deepEqual(sessionIds(), beforeIds, "rejection creates no session");
            assert.equal(
                JSON.stringify(
                    app.sessions(owner(app)).map((session) => [session.id, session.tags]),
                ),
                beforeTags,
                "rejection changes no existing tags",
            );
            assert.equal(tagWrites, 0);
            await sheetButton("Cancel");
            await expectPage(
                `document.querySelector('${list} .search-filters').getAttribute('aria-label') === 'Filters, 11 active tags'`,
                "failure preserves all active filters",
            );
            await fresh(width, height);
            assert.deepEqual(sessionIds(), beforeIds, "reload reveals no partial creation");
        },
    );
}
