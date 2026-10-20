// Real routes and web assets on an isolated app, mobile first. Touch holds are synthetic PointerEvents, not hardware.
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
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let empty: ConversationId;
let first: ConversationId;
let second: ConversationId;
let archived: ConversationId;
let layout: ConversationId;
let list = ".home-list";
const row = (id: ConversationId) => `${list} .session-row[data-id="${id}"]`;
const sheet = ".sheet-host:not(.leaving)";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function expectPage(script: string, what: string): Promise<void> {
    try {
        await until(
            () => inPage<boolean>(`return JSON.stringify(Boolean(${script}))`),
            what,
            15_000,
        );
    } catch (cause) {
        const state = await inPage<unknown>(`
            const { store } = await import('/store.js');
            return JSON.stringify({
                conversationId: store.state.conversationId,
                filters: store.state.sessionTagFilters,
                home: document.querySelector('.home-list') !== null,
                queries: [...document.querySelectorAll('input[aria-label="Search sessions"]')].map(each => each.value),
                active: document.activeElement?.getAttribute('aria-label'),
                sheet: store.state.sheet?.type ?? null,
                width: innerWidth,
                scrollWidth: document.documentElement.scrollWidth,
            });
        `);

        throw new Error(`${what}: ${JSON.stringify(state)}`, { cause });
    }
}

async function sheetType(type: string | null): Promise<void> {
    await until(
        () =>
            inPage<boolean>(`
        const { store } = await import('/store.js');
        return JSON.stringify((store.state.sheet?.type ?? null) === ${JSON.stringify(type)});
    `),
        `sheet ${type}`,
        15_000,
    );
}

// The app intentionally swallows taps for 280ms after a layer transition. Make separate deliberate taps, not doubles.
async function click(target: Parameters<BrowserPage["click"]>[0]): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 320));
    await page.click(target);
}

async function clickText(text: string, within = sheet): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 320));
    const box = await inPage<{ x: number; y: number }>(`
        const button = [...document.querySelectorAll(${JSON.stringify(`${within} button`)})]
            .find((each) => each.textContent.trim().startsWith(${JSON.stringify(text)}));
        if (!button) throw Error('Missing button: ' + ${JSON.stringify(text)});
        button.scrollIntoView({ block: 'nearest' });
        const box = button.getBoundingClientRect();
        return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    `);

    await page.click(box);
}

async function selectTab(text: string): Promise<void> {
    await clickText(text, `${list} .session-tabs`);
    await expectPage(
        `document.querySelector(${JSON.stringify(`${list} .session-tabs [aria-selected="true"]`)})?.textContent.trim() === ${JSON.stringify(text)}`,
        `${text} view`,
    );
}

async function fresh(width: number): Promise<void> {
    list = width < 700 ? ".home-list" : ".sidebar";
    await page.setViewport({
        width,
        height: width === 320 ? 740 : 844,
        scale: 1,
        mobile: width < 700,
    });
    await page.navigate(`${base}/`);
    await expectPage(
        `document.querySelector(${JSON.stringify(row(empty))}) !== null`,
        "session list",
    );
    await selectTab("Recent");
}

async function openFromKeyboard(id: ConversationId): Promise<void> {
    await page.evaluate(
        `document.querySelector(${JSON.stringify(`${row(id)} > .session`)}).focus()`,
    );
    await page.press("Shift+F10");
    await sheetType("session");
    await clickText("Edit tags");
    await sheetType("session-tags");
}

async function addName(name: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 320));
    await page.type({ selector: "#session-tag-input" }, name);
    await page.press("Enter");
    await expectPage(
        `document.querySelector(${JSON.stringify(`${sheet} .tag-draft`)})?.textContent.includes(${JSON.stringify(name)})`,
        "queued tag",
    );
}

before(async () => {
    if (!chromium) {
        return;
    }

    app = await openApp(scriptedModel());
    empty = await newSession(app);
    first = await newSession(app);
    second = await newSession(app);
    archived = await newSession(app);
    layout = await newSession(app);
    await app.commands.updateSession(layout, owner(app), {
        title: "A long session title should use the available space before the timestamp",
    });
    await app.commands.updateSessionTags(owner(app), {
        ids: [Number(layout)],
        add: ["layout-check-a", "layout-check-b", "layout-check-c"],
    });

    for (const [id, title] of [
        [empty, "Untagged notes"],
        [first, "Maintenance task"],
        [second, "Security device"],
        [archived, "Archived device"],
    ] as const) {
        await app.commands.updateSession(id, owner(app), { title });
    }

    await app.commands.updateSessionTags(owner(app), {
        ids: [Number(first)],
        add: ["arca", "maintenance"],
    });
    await app.commands.updateSessionTags(owner(app), {
        ids: [Number(second), Number(archived)],
        add: ["pi-pocket", "security"],
    });
    await app.commands.updateSession(archived, owner(app), { archived: true });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "tags-ui-")),
        load: async () => undefined,
        save: () => {},
        // Existing session-row test convention: a headless mouse, with phone touch emulation at narrow viewports.
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
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
    "390px: hold actions reach single tags; Cancel and Save preserve the right session",
    real,
    async () => {
        await fresh(390);
        assert.equal(
            await inPage<boolean>(`return JSON.stringify(matchMedia('(hover:hover)').matches)`),
            false,
        );
        await page.evaluate(`
        const button = document.querySelector(${JSON.stringify(`${row(empty)} > .session`)});
        button.scrollIntoView({ block: 'center' });
        const r = button.getBoundingClientRect();
        const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
        button.dispatchEvent(new PointerEvent('pointerdown', init));
        await new Promise(resolve => setTimeout(resolve, 1000));
        button.dispatchEvent(new PointerEvent('pointerup', init));
        document.elementFromPoint(init.clientX, init.clientY)?.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
    `);
        await sheetType("session");
        await new Promise((resolve) => setTimeout(resolve, 320));
        await clickText("Edit tags");
        await sheetType("session-tags");
        await addName("discard");
        await clickText("Cancel");
        await sheetType(null);
        assert.deepEqual(app.sessionMeta(empty)?.tags ?? [], []);
        await expectPage(
            `document.activeElement === document.querySelector(${JSON.stringify(`${row(empty)} > .session`)})`,
            "mobile Cancel restores row focus",
        );
        await openFromKeyboard(empty);
        await addName("triage");
        await clickText("Save tags");
        await until(
            () => app.sessionMeta(empty)?.tags?.includes("triage") === true,
            "persisted single tag",
        );
        await sheetType(null);
        await expectPage(
            `document.querySelector(${JSON.stringify(`${row(empty)} .session-tags`)})?.textContent.includes('triage')`,
            "committed row tags",
        );
        assert.deepEqual(app.sessionMeta(first)?.tags, ["arca", "maintenance"]);
        await expectPage(
            `!document.querySelector('button button') && document.documentElement.scrollWidth === innerWidth`,
            "valid controls without overflow",
        );
        await page.type({ selector: `${list} input[aria-label="Search sessions"]` }, "notes");
        await click({ selector: `${row(empty)} .session-tags [aria-label="Filter by triage"]` });
        await click({ selector: `${row(empty)} > .session` });
        await expectPage(
            `(await import('/store.js')).store.state.view.conversation?.id === ${Number(empty)}`,
            "conversation opened",
        );
        // The native success notice temporarily covers Back; do not click a different visible control through it.
        await expectPage(
            `document.querySelector('.notice') === null`,
            "native save notice expired",
        );
        await click({ selector: 'button[aria-label^="Back to sessions"]' });
        await expectPage(
            `document.querySelector(${JSON.stringify(`${list} .session-applied-tags [aria-label="Remove triage filter"]`)}) !== null && document.querySelector(${JSON.stringify(`${list} input[aria-label="Search sessions"]`)})?.value === 'notes'`,
            "mobile Back preserves query and tags",
        );
    },
);

test(
    "320px: additive filters preserve search/views and original search controls",
    real,
    async () => {
        await fresh(320);
        await click({
            selector: `${row(second)} .session-tags [aria-label="Filter by security"]`,
        });
        await expectPage(
            `document.querySelectorAll(${JSON.stringify(`${list} .session-applied-tags button[aria-label^="Remove "]`)}).length === 1`,
            "one additive tag",
        );
        await click({
            selector: `${row(second)} .session-tags [aria-label="Filter by security"]`,
        });
        await page.type({ selector: `${list} input[aria-label="Search sessions"]` }, "device");
        await selectTab("Folders");
        await click({
            selector: `${row(second)} .session-tags [aria-label="Filter by pi-pocket"]`,
        });
        await expectPage(
            `document.querySelectorAll(${JSON.stringify(`${list} .session-applied-tags button[aria-label^="Remove "]`)}).length === 2`,
            "AND filters, no duplicate",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(`${list} input[aria-label="Search sessions"]`)}).value)`,
            ),
            "device",
        );
        await selectTab("Archived");
        await expectPage(
            `document.querySelector(${JSON.stringify(row(archived))}) !== null`,
            "filtered archived session",
        );
        await click({ selector: `${list} .search-filters` });
        await sheetType("session-tag-filter");
        await clickText("Clear tags");
        await clickText("Done");
        await sheetType(null);
        await click({ selector: `${list} .search-clear` });
        await expectPage(
            `document.querySelector(${JSON.stringify(`${list} .search-launcher`)}) !== null && document.documentElement.scrollWidth === innerWidth`,
            "launcher retained and no overflow",
        );
        await click({ selector: `${list} .search-launcher` });
        await expectPage(
            `document.querySelector('[role="combobox"]') !== null`,
            "existing launcher still opens",
        );
        await page.press("Escape");
    },
);

test(
    "desktop: native hover/focus strip edits one row, while contextual batch patches preserve other tags",
    real,
    async () => {
        await fresh(1280);
        assert.equal(
            await inPage<boolean>(`return JSON.stringify(matchMedia('(hover:hover)').matches)`),
            true,
        );
        await page.hover({ selector: `${row(first)} > .session` });
        await click({ selector: `${row(first)} .session-act[aria-label="Edit tags"]` });
        await sheetType("session-tags");
        await page.press("Escape");
        await sheetType(null);
        await page.evaluate(
            `document.querySelector(${JSON.stringify(`${row(first)} > .session`)}).focus()`,
        );
        await page.press("Shift+F10");
        await sheetType("session");
        await clickText("Select");
        await sheetType(null);
        // A tag in selection mode selects its session, never adds a filter or opens it.
        await click({ selector: `${row(second)} .session-tags button` });
        assert.equal(
            await inPage<number>(`
                const action = [...document.querySelectorAll(${JSON.stringify(`${list} .select-bar button`)})]
                    .find(button => button.textContent.trim() === "Edit tags");
                return JSON.stringify(action.querySelectorAll("svg").length);
            `),
            0,
            "batch Edit tags is text-only like the existing Archive and Pin actions",
        );
        await clickText("Edit tags", `${list} .select-bar`);
        await sheetType("session-tags");
        await addName("reviewed");
        await page.evaluate(`
        const input = [...document.querySelectorAll(${JSON.stringify(`${sheet} .tag-options label`)})]
            .find(each => each.textContent.includes('maintenance')).querySelector('input');
        input.click();
    `);
        await clickText("Save tags");
        await until(
            () => app.sessionMeta(first)?.tags?.includes("reviewed") === true,
            "batch save",
        );
        assert.deepEqual(app.sessionMeta(first)?.tags, ["arca", "reviewed"]);
        assert.deepEqual(app.sessionMeta(second)?.tags, ["pi-pocket", "reviewed", "security"]);
        assert.deepEqual(app.sessionMeta(empty)?.tags, ["triage"]);
        await sheetType(null);
        await expectPage(
            `document.querySelectorAll(${JSON.stringify(`${list} .session-applied-tags button`)}).length === 0 && !document.querySelector('button button') && document.documentElement.scrollWidth === innerWidth`,
            "selection did not filter, native buttons and layout",
        );
    },
);

test(
    "selected-row editing stays single; collapsed selections are excluded and opened batch targets stay fixed",
    real,
    async () => {
        await fresh(1280);
        await page.evaluate(
            `document.querySelector(${JSON.stringify(`${row(first)} > .session`)}).focus()`,
        );
        await page.press("Shift+F10");
        await sheetType("session");
        await clickText("Select");
        await sheetType(null);
        await click({ selector: `${row(second)} .session-tags button` });
        const other = structuredClone(app.sessionMeta(second)?.tags);

        await page.hover({ selector: `${row(first)} > .session` });
        await click({ selector: `${row(first)} .session-act[aria-label="Edit tags"]` });
        await sheetType("session-tags");
        await addName("single-only");
        await clickText("Save tags");
        await sheetType(null);
        await until(
            () => app.sessionMeta(first)?.tags?.includes("single-only") === true,
            "one selected row edited",
        );
        assert.deepEqual(app.sessionMeta(second)?.tags, other);
        await expectPage(
            `document.querySelectorAll(${JSON.stringify(`${list} .session-row.selected`)}).length === 2`,
            "selection retained after single save",
        );

        await page.hover({ selector: `${row(first)} > .session` });
        await click({ selector: `${row(first)} .session-act[aria-label="Pin"]` });
        await clickText("Pinned", list);
        await expectPage(
            `document.querySelector(${JSON.stringify(row(first))})?.closest('.session-group').classList.contains('closed')`,
            "pinned selection folded",
        );
        await clickText("Edit tags", `${list} .select-bar`);
        await sheetType("session-tags");
        await expectPage(
            `document.querySelector(${JSON.stringify(`${sheet} .tag-targets summary`)})?.textContent.trim().startsWith('Review 1 selected session')`,
            "only the visible selected target included",
        );
        const untouched = structuredClone(app.sessionMeta(first)?.tags);

        await addName("frozen-target");
        // An external archive changes list visibility after opening; it must not shrink or retarget this draft.
        await app.commands.updateSession(second, owner(app), { archived: true });
        await clickText("Save tags");
        await sheetType(null);
        await until(
            () => app.sessionMeta(second)?.tags?.includes("frozen-target") === true,
            "frozen target saved",
        );
        assert.deepEqual(
            app.sessionMeta(first)?.tags,
            untouched,
            "folded selection stayed out of batch",
        );
        assert.deepEqual(app.sessionMeta(empty)?.tags, ["triage"]);
    },
);

test(
    "Escape then immediate keyboard reopen starts a clean tag draft during the closing animation",
    real,
    async () => {
        await fresh(1280);
        const before = structuredClone(app.sessionMeta(empty)?.tags);

        await page.hover({ selector: `${row(empty)} > .session` });
        await page.evaluate(
            `document.querySelector(${JSON.stringify(`${row(empty)} .session-act[aria-label="Edit tags"]`)}).focus()`,
        );
        await page.press("Enter");
        await sheetType("session-tags");
        await addName("cancel-me");
        await page.evaluate(`
        window.__tagReopenKeys = [];
        window.__recordTagReopen = (event) => {
            if (event.key === 'Escape' || event.key === 'Enter') {
                window.__tagReopenKeys.push({key: event.key, time: performance.now()});
            }
        };
        document.addEventListener('keydown', window.__recordTagReopen, true);
    `);
        // No settling or pointer tap-guard delay: both actual keys must land within usePresence's 200ms retention.
        await page.input([
            { type: "key", key: "Escape" },
            { type: "key", key: "Enter" },
        ]);
        await sheetType("session-tags");
        const gap = await inPage<number>(`
        document.removeEventListener('keydown', window.__recordTagReopen, true);
        const [close, reopen] = window.__tagReopenKeys;
        delete window.__recordTagReopen;
        delete window.__tagReopenKeys;
        return JSON.stringify(reopen.time - close.time);
    `);

        assert.ok(gap < 200, `reopened within the retained editor's lifetime (${gap}ms)`);
        await expectPage(
            `!document.querySelector(${JSON.stringify(`${sheet} .tag-draft`)})?.textContent.includes('cancel-me')`,
            "canceled draft is not reused",
        );
        await expectPage(
            `document.querySelector(${JSON.stringify(`${sheet} .tag-save button:last-child`)})?.disabled === true`,
            "fresh unchanged draft cannot save",
        );
        assert.deepEqual(app.sessionMeta(empty)?.tags, before);
        await page.press("Escape");
        await sheetType(null);
    },
);

test(
    "desktop row-open and four action hit areas stay distinct through supported sidebar resizing",
    real,
    async () => {
        const chain: ConversationId[] = [];

        for (let depth = 0; depth < 4; depth++) {
            const id = await newSession(app);

            await app.commands.updateSession(id, owner(app), { title: `Linked depth ${depth}` });
            chain.push(id);
        }

        await app.harness.commit(async (tx) => {
            const catalogue = await tx.doc(SessionsDoc);

            chain.forEach((id, index) => {
                if (index === 0) {
                    return;
                }

                const meta = catalogue.items[String(id)];
                const parent = chain[index - 1];

                if (!meta || parent === undefined) {
                    throw new Error("Missing linked fixture");
                }

                meta.linkedFrom = { id: parent };
            });
        }, context);

        for (const target of [empty, ...chain.slice(-1)]) {
            for (const width of [254, 228, 216, 204, 320, 400]) {
                await fresh(1280);
                await page.evaluate(`
            const sidebar = document.querySelector('.sidebar');
            const list = sidebar.querySelector('.sessions');
            const rest = sidebar.offsetWidth - list.offsetWidth;
            // The exact live variable ResizeHandle updates while dragging; preferences clamp the released width.
            document.documentElement.style.setProperty('--sidebar-w', String(${width} + rest) + 'px');
        `);
                await expectPage(
                    `document.querySelector('.sidebar .sessions').offsetWidth === ${width}`,
                    `${width}px list width`,
                );
                await expectPage(
                    `document.querySelector(${JSON.stringify(row(target))})?.style.getPropertyValue('--linked-depth') === ${JSON.stringify(target === empty ? "0" : "3")}`,
                    "root or actual depth-three fixture",
                );

                for (const hovered of [false, true]) {
                    await page.hover({
                        selector: hovered ? `${row(target)} > .session` : `${list} .session-tabs`,
                    });
                    const geometry = await inPage<{
                        centerHitsOpen: boolean;
                        distinct: boolean;
                        actionsHit: boolean;
                        idleFillsRow: boolean;
                        height: number;
                        titleWidth: number;
                        ellipsis: boolean;
                        fullTooltip: boolean;
                    }>(`
                const row = document.querySelector(${JSON.stringify(row(target))});
                const button = row.querySelector('button.session');
                const open = button.getBoundingClientRect();
                const acts = [...row.querySelectorAll('.session-act')];
                const box = each => each.getBoundingClientRect();
                const hits = each => {const r = box(each); return each.contains(document.elementFromPoint(r.x+r.width/2, r.y+r.height/2));};
                return JSON.stringify({
                    centerHitsOpen: hits(button),
                    distinct: acts.length === 4 && acts.every(each => {const r = box(each); return getComputedStyle(each).pointerEvents === 'none' || r.left >= open.right || r.right <= open.left || r.top >= open.bottom || r.bottom <= open.top;}),
                    actionsHit: acts.every(hits),
                    idleFillsRow: Math.abs(box(row.querySelector('.session-content')).right - box(row).right) < 0.01,
                    height: button.offsetHeight,
                    titleWidth: row.querySelector('.session-title').getBoundingClientRect().width,
                    ellipsis: getComputedStyle(row.querySelector('.session-title')).textOverflow === 'ellipsis',
                    fullTooltip: button.title.includes(${JSON.stringify(app.sessionMeta(target)?.title)}),
                });
            `);

                    assert.equal(
                        geometry.centerHitsOpen,
                        true,
                        `${width}px open center, hover=${hovered}`,
                    );
                    assert.equal(
                        geometry.distinct,
                        true,
                        `${width}px visible actions stay outside open hit area; hidden actions ignore pointers, hover=${hovered}`,
                    );

                    if (!hovered) {
                        assert.equal(
                            geometry.idleFillsRow,
                            true,
                            `${width}px no idle action gutter`,
                        );
                    }

                    assert.equal(geometry.height, 36, `${width}px native one-line desktop height`);
                    assert.ok(
                        geometry.titleWidth > 0 && geometry.ellipsis && geometry.fullTooltip,
                        `${width}px visible title with ellipsis and full tooltip`,
                    );

                    if (hovered) {
                        assert.equal(
                            geometry.actionsHit,
                            true,
                            `${width}px each native action receives its click`,
                        );
                    }
                }

                await click({ selector: `${row(target)} > .session` });
                await expectPage(
                    `(await import('/store.js')).store.state.conversationId === ${Number(target)}`,
                    `${width}px row center opens its session`,
                );
                assert.equal(
                    app.sessionMeta(target)?.archived,
                    undefined,
                    "opening must not archive the session",
                );
            }
        }

        await page.evaluate(`document.documentElement.style.setProperty('--sidebar-w', '312px');`);
    },
);

test("desktop layout: idle titles reclaim the hidden action strip", real, async () => {
    await fresh(1280);
    await page.hover({ selector: `${list} .session-tabs` });
    const geometry = await inPage<{
        rowWidth: number;
        lineWidth: number;
        lineBelongsToOpen: boolean;
        titleGap: number;
        hiddenActionsIgnorePointers: boolean;
    }>(`
        const row = document.querySelector(${JSON.stringify(row(layout))});
        const button = row.querySelector('.session');
        const title = row.querySelector('.session-title').getBoundingClientRect();
        const side = row.querySelector('.session-side').getBoundingClientRect();
        return JSON.stringify({
            rowWidth: row.getBoundingClientRect().width,
            lineWidth: row.querySelector('.session-content').getBoundingClientRect().width,
            lineBelongsToOpen: button.contains(document.elementFromPoint(side.right - 1, side.top + side.height / 2)),
            titleGap: side.left - title.right,
            hiddenActionsIgnorePointers: [...row.querySelectorAll('.session-act')]
                .every(each => getComputedStyle(each).pointerEvents === 'none'),
        });
    `);

    assert.equal(geometry.lineWidth, geometry.rowWidth, "idle visible line uses the full row");
    assert.equal(
        geometry.lineBelongsToOpen,
        true,
        "the extended idle line belongs to the open control",
    );
    assert.ok(geometry.titleGap <= 12, "title ends at native spacing before the timestamp");
    assert.equal(
        geometry.hiddenActionsIgnorePointers,
        true,
        "hidden actions cannot intercept clicks",
    );
});

test(
    "desktop layout: the whole item stays highlighted over its title, actions and tags",
    real,
    async () => {
        await fresh(1280);

        for (const target of [
            ".session",
            ".session-act:first-child",
            ".session-act:last-child",
            ".session-tags .chip",
        ]) {
            await page.hover({ selector: `${row(layout)} ${target}` });
            await expectPage(
                `getComputedStyle(document.querySelector(${JSON.stringify(`${row(layout)} .session-act`)})).opacity === '1'`,
                "native actions revealed",
            );
            const paint = await inPage<{
                fill: boolean;
                right: string;
                top: string;
                bottom: string;
                buttonClear: boolean;
            }>(`
            const row = document.querySelector(${JSON.stringify(row(layout))});
            const fill = getComputedStyle(row, '::before');
            return JSON.stringify({
                fill: fill.content !== 'none' && fill.backgroundColor !== 'rgba(0, 0, 0, 0)',
                right: fill.right, top: fill.top, bottom: fill.bottom,
                buttonClear: getComputedStyle(row.querySelector('.session')).backgroundColor === 'rgba(0, 0, 0, 0)',
            });
        `);

            assert.equal(paint.fill, true, `${target}: one painted item, not just the open button`);
            assert.deepEqual(
                [paint.right, paint.top, paint.bottom],
                ["0px", "0px", "0px"],
                "highlight reaches every item edge",
            );
            assert.equal(
                paint.buttonClear,
                true,
                "no separate title-only highlight over the item fill",
            );
        }
    },
);

test(
    "tag layout: chips have breathing room inside the item at phone and desktop widths",
    real,
    async () => {
        for (const width of [390, 320, 1280]) {
            await fresh(width);
            const geometry = await inPage<{
                topGap: number;
                bottomGap: number;
                overflow: boolean;
                titleHeight: number;
            }>(`
            const row = document.querySelector(${JSON.stringify(row(layout))});
            const title = row.querySelector('.session').getBoundingClientRect();
            const tags = [...row.querySelectorAll('.session-tags .chip')].map(each => each.getBoundingClientRect());
            return JSON.stringify({
                topGap: Math.min(...tags.map(each => each.top)) - title.bottom,
                bottomGap: row.getBoundingClientRect().bottom - Math.max(...tags.map(each => each.bottom)),
                overflow: document.documentElement.scrollWidth > innerWidth,
                titleHeight: title.height,
            });
        `);

            assert.ok(geometry.topGap >= 4, `${width}px: at least 4px between title and chips`);
            assert.ok(
                geometry.bottomGap >= 6,
                `${width}px: at least 6px below the final chip line`,
            );
            assert.equal(geometry.overflow, false, `${width}px: no horizontal overflow`);
            assert.equal(
                geometry.titleHeight,
                width < 700 ? 40 : 36,
                `${width}px: native title-row height unchanged`,
            );
        }
    },
);

test(
    "desktop layout: a direct idle-row click cannot become an archive click on hover",
    real,
    async () => {
        await fresh(1280);
        await page.hover({ selector: `${list} .session-tabs` });
        // Deliberately no row hover first: moving to click must not change the action under this target.
        await page.click({ selector: `${row(layout)} > .session` });
        assert.equal(
            app.sessionMeta(layout)?.archived,
            undefined,
            "opening must never archive the row",
        );
        await expectPage(
            `(await import('/store.js')).store.state.view.conversation?.id === ${Number(layout)}`,
            "direct idle click opens the session",
        );
    },
);

test(
    "desktop layout: active and selected item fills respect Pocket and Lantern",
    real,
    async () => {
        for (const look of ["pocket", "lantern"]) {
            await fresh(1280);

            if (look === "lantern") {
                await page.evaluate(`
                const { setPrefs } = await import('/theme.js');
                const loaded = new Promise(resolve => document.addEventListener('pocket:theme', resolve, { once: true }));
                setPrefs({ look: 'lantern' });
                await loaded;
            `);
            }

            await page.hover({ selector: `${row(layout)} > .session` });
            await click({ selector: `${row(layout)} > .session` });
            await expectPage(
                `(await import('/store.js')).store.state.conversationId === ${Number(layout)}`,
                "fixture opened",
            );

            for (const selected of [false, true]) {
                if (selected) {
                    await page.evaluate(
                        `document.querySelector(${JSON.stringify(`${row(layout)} > .session`)}).focus()`,
                    );
                    await page.press("Shift+F10");
                    await sheetType("session");
                    await clickText("Select");
                    await sheetType(null);
                }

                const expected = look === "lantern" ? "--card-2" : "--accent-soft";

                await expectPage(
                    `(() => {
                const row = document.querySelector(${JSON.stringify(row(layout))});
                // Resolve the native palette token in a separate probe, not by overriding app styles.
                const probe = document.createElement('span');
                probe.style.backgroundColor = 'var(${expected})';
                document.body.append(probe);
                const expected = getComputedStyle(probe).backgroundColor;
                probe.remove();
                return getComputedStyle(row, '::before').backgroundColor === expected
                    && getComputedStyle(row.querySelector('.session')).backgroundColor === 'rgba(0, 0, 0, 0)'
                    && row.classList.contains(${JSON.stringify(selected ? "selected" : "active")});
            })()`,
                    `${look}: whole-item ${selected ? "selection" : "active"} fill`,
                );
            }
        }
    },
);
