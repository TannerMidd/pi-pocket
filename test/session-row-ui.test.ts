// Session-row actions in a dedicated headless browser, with isolated app data and a scripted model.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let active: ConversationId;
let folderSessions: ConversationId[];
const longFolder = "a-directory-with-a-name-long-enough-to-ellipsis-in-the-session-sidebar";

let list = ".sidebar";
const row = (id: ConversationId) => `${list} .session-row[data-id="${id}"]`;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function selectTab(name: "Priority" | "Recent" | "Folders" | "Archived"): Promise<void> {
    const tabName = (tab: string) => `
        const nameOf = (tab) => tab.getAttribute("data-tab") === "archived" ? "Archived" : tab.firstChild.textContent.trim();
    `;
    const index = await inPage<number>(`
        ${tabName(name)}
        const tabs = [...document.querySelectorAll(${JSON.stringify(`${list} .session-tabs [role="tab"]`)})];
        return JSON.stringify(tabs.findIndex((tab) => nameOf(tab) === ${JSON.stringify(name)}));
    `);

    assert.ok(index >= 0, `${name} tab exists in the current list`);
    await page.click({ selector: `${list} .session-tabs [role="tab"]:nth-of-type(${index + 1})` });
    await until(
        async () =>
            await inPage<boolean>(`
                ${tabName(name)}
                const tab = document.querySelector(${JSON.stringify(`${list} .session-tabs [aria-selected="true"]`)});
                return JSON.stringify(tab !== null && nameOf(tab) === ${JSON.stringify(name)});
            `),
        `${name} tab selected`,
    );
}

async function fresh(mobile = false): Promise<void> {
    list = mobile ? ".home-list" : ".sidebar";
    await page.setViewport(mobile ? VIEWPORTS.mobile : DESKTOP);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(active))}) !== null)`,
            ),
        "the session list",
        20_000,
    );
    await selectTab("Recent");
    await page.hover({ x: 1, y: 1 });
    assert.equal(
        await inPage<boolean>(`return JSON.stringify(matchMedia("(hover: hover)").matches)`),
        !mobile,
        "a mouse on the desktop, touch on the phone",
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    active = await newSession(app);
    const cwd = join(root, longFolder);

    mkdirSync(cwd);
    folderSessions = [await newSession(app, cwd)];
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "session-row-ui-")),
        load: async () => undefined,
        save: () => {},
        // A mouse, whatever this machine has: headless Chromium without one says (hover: none), and rows show their
        // buttons only where a pointer can hover. The phone size's touch emulation still makes it (hover: none).
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
    server?.close();
    await app?.close();
    cleanUp();
});

type Touched = {
    sheet: string | null;
    path: string;
    layers: number;
    pinned: number[];
};

const touched = () =>
    inPage<Touched>(`
        const { store } = await import("/store.js");

        return JSON.stringify({
            sheet: store.state.sheet?.type ?? null,
            path: location.pathname,
            layers: history.state?.pocket?.layers ?? 0,
            pinned: store.state.pinned,
        });
    `);

/** Wait until what a finger left is as `expected` says, in the fields it names. */
async function settled(expected: Partial<Touched>, what: string): Promise<Touched> {
    let last: Touched | undefined;

    try {
        await until(async () => {
            last = await touched();

            return Object.entries(expected).every(([key, value]) =>
                Array.isArray(value)
                    ? JSON.stringify(last![key as keyof Touched]) === JSON.stringify(value)
                    : last![key as keyof Touched] === value,
            );
        }, what);
    } catch {
        assert.fail(`${what}: ${JSON.stringify(last)}`);
    }

    return last!;
}

/**
 * A finger on a row: down, held `ms` (moving `dy` on the way), and lifted, with the click a lift makes where it lifts,
 * on whatever is there by then.
 */
const finger = (id: ConversationId, { ms, dy = 0 }: { ms: number; dy?: number }) =>
    inPage(`
        const button = document.querySelector(${JSON.stringify(`${row(id)} > .session`)});
        const box = button.getBoundingClientRect();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        const fire = (type, at = y) =>
            button.dispatchEvent(
                new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    pointerId: 7,
                    pointerType: "touch",
                    isPrimary: true,
                    button: type === "pointermove" ? -1 : 0,
                    clientX: x,
                    clientY: at,
                }),
            );
        const wait = (time) => new Promise((resolve) => setTimeout(resolve, time));

        fire("pointerdown");
        await wait(Math.min(250, ${ms} / 2));

        if (${dy} !== 0) {
            fire("pointermove", y + ${dy});
        }

        await wait(${ms} - Math.min(250, ${ms} / 2));
        fire("pointerup", y + ${dy});
        for (const type of ["mousedown", "mouseup", "click"]) {
            document
                .elementFromPoint(x, y + ${dy})
                .dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: y + ${dy} }));
        }

        return JSON.stringify({ });
    `);

/** Tap one of the open sheet's items by its label. */
async function choose(label: string): Promise<void> {
    await page.evaluate(`
        [...document.querySelectorAll(".sheet-host:not(.leaving) .list-item")]
            .find((each) => each.firstElementChild.textContent.trim() === ${JSON.stringify(label)})
            .click();
    `);
}

test(
    "touch screens: a finger held on a row opens its actions, a tap still opens it, and a scroll is not a press",
    real,
    async () => {
        await fresh(true);

        // Past the opening tap guard: the lift's mousedown must not close the sheet before its click is caught.
        await finger(active, { ms: 1000 });
        await settled(
            {
                sheet: "session",
                path: "/",
            },
            "the row's actions, open",
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        await settled({ sheet: "session", path: "/", layers: 1 }, "still open after the lift");
        await choose("Pin to the top");
        await settled({ sheet: null, pinned: [Number(active)] }, "pinned, and the sheet closed");
        await finger(active, { ms: 600 });
        await settled({ sheet: "session" }, "the pinned row offers Unpin");
        await choose("Unpin from the top");
        await settled({ sheet: null, pinned: [] }, "unpinned");

        // A finger that moves is scrolling or dragging: no press, no actions.
        await finger(active, { ms: 600, dy: 30 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        await settled({ sheet: null, path: "/" }, "no actions after a scroll");

        // A quick tap opens the session, as it always has.
        await finger(active, { ms: 80 });
        await settled({ sheet: null, path: `/s/${active}` }, "the session, opened by a tap");
    },
);

/**
 * A finger held on a row, and what the page there lets be selected meanwhile: the actions sheet rises under the
 * finger, and its own text is what Android's long press would otherwise take. Back is the sheet text's `user-select`
 * and whether its `selectstart` is stopped, while the finger is held and again after the lift.
 */
const heldSelection = (id: ConversationId) =>
    inPage<{ held: string; stopped: boolean; after: string; free: boolean }>(`
        const button = document.querySelector(${JSON.stringify(`${row(id)} > .session`)});
        const box = button.getBoundingClientRect();
        const at = {
            pointerId: 7,
            pointerType: "touch",
            isPrimary: true,
            button: 0,
            clientX: box.x + box.width / 2,
            clientY: box.y + box.height / 2,
        };
        const fire = (type) =>
            button.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...at }));
        const wait = (time) => new Promise((resolve) => setTimeout(resolve, time));
        // A selection starting on the sheet's own text, the way Android's long press makes one: true when stopped.
        const start = (word) => {
            const each = new Event("selectstart", { bubbles: true, cancelable: true });
            word.dispatchEvent(each);
            return each.defaultPrevented;
        };

        fire("pointerdown");
        await wait(600);
        const word = document.querySelector(".sheet-host:not(.leaving) .sheet-head h2");
        const held = { held: getComputedStyle(word).userSelect, stopped: start(word) };
        fire("pointerup");
        await wait(600);
        return JSON.stringify({ ...held, after: getComputedStyle(word).userSelect, free: !start(word) });
    `);

test(
    "a finger held on a row selects nothing, and the lift gives selection back",
    real,
    async () => {
        await fresh(true);

        const { held, stopped, after, free } = await heldSelection(active);

        assert.equal(held, "none", "the held finger leaves the page nothing to select");
        assert.equal(stopped, true, "and stops a selection the sheet's own text would start");
        assert.notEqual(after, "none", "the lift does not leave the page unselectable");
        assert.equal(free, true, "the sheet's text is selectable again");
    },
);

/** What this browser marked unread, and which rows show it. */
const marks = () =>
    inPage<{ stored: number[]; dots: number[] }>(`
        const rows = [...document.querySelectorAll(${JSON.stringify(`${list} .session-row`)})];

        return JSON.stringify({
            stored: JSON.parse(localStorage.getItem("pocket.unread") ?? "[]"),
            dots: rows.filter((each) => each.querySelector(".unread-dot")).map((each) => Number(each.dataset.id)),
        });
    `);

async function marked(ids: ConversationId[], what: string): Promise<void> {
    const want = JSON.stringify({
        stored: ids.map(Number),
        dots: ids.map(Number),
    });
    let last = "";

    try {
        await until(async () => (last = JSON.stringify(await marks())) === want, what);
    } catch {
        assert.fail(`${what}: ${last}`);
    }
}

test("a session marked unread shows it until it is opened", real, async () => {
    const [one] = folderSessions as [ConversationId];

    await fresh();
    await menuOpens(one, "the menu");
    await menuChoose("Mark unread");
    await marked([one], "marked: stored, a dot, and a bold title");
    await menuOpens(one, "the menu again");
    await menuChoose("Mark read");
    await marked([], "read again from the menu");

    // A tap on the row opens it.
    await menuOpens(one, "the menu once more");
    await menuChoose("Mark unread");
    await marked([one], "marked again");
    await page.evaluate(
        `document.querySelector(${JSON.stringify(`${row(one)} > .session`)}).click()`,
    );
    await until(async () => (await touched()).path === `/s/${one}`, "opened");
    await marked([], "opening it read it");
});

const rightClick = (id: ConversationId, keys: { shiftKey?: boolean; ctrlKey?: boolean } = {}) =>
    inPage<{ stopped: boolean; x: number; y: number }>(`
        const button = document.querySelector(${JSON.stringify(`${row(id)} > .session`)});
        const box = button.getBoundingClientRect();
        const x = Math.round(box.x + 40);
        const y = Math.round(box.y + box.height / 2);
        const event = new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: x,
            clientY: y,
            ...${JSON.stringify(keys)},
        });

        button.dispatchEvent(event);

        return JSON.stringify({ stopped: event.defaultPrevented, x, y });
    `);

const menuShown = () =>
    inPage<{ items: string[]; left: number; top: number } | null>(`
        const menu = document.querySelector('.sheet-host:not(.leaving) [data-part="session-menu"]');

        if (!menu) {
            return JSON.stringify(null);
        }

        // Where it was put, not where its opening animation has it now.
        return JSON.stringify({
            items: [...menu.querySelectorAll('[role="menuitem"] > :first-child')].map((each) => each.textContent.trim()),
            left: Math.round(parseFloat(menu.style.left)),
            top: Math.round(parseFloat(menu.style.top)),
        });
    `);

const menuChoose = (label: string) =>
    page.evaluate(`
        [...document.querySelectorAll('.sheet-host:not(.leaving) [data-part="session-menu"] [role="menuitem"]')]
            .find((each) => each.firstElementChild.textContent.trim() === ${JSON.stringify(label)})
            .click();
    `);

async function menuOpens(id: ConversationId, what: string) {
    const at = await rightClick(id);

    assert.equal(at.stopped, true, `${what}: the browser's own menu stays shut`);
    let shown: Awaited<ReturnType<typeof menuShown>> = null;

    await until(async () => (shown = await menuShown()) !== null, what);

    return { at, shown: shown! };
}

test(
    "a right-click on a row opens its actions at the pointer, and only a plain one does",
    real,
    async () => {
        const [other] = folderSessions as [ConversationId];

        await fresh();

        const { at, shown } = await menuOpens(active, "the menu");

        assert.deepEqual([shown.left, shown.top], [at.x, at.y], "its corner at the pointer");

        for (const label of [
            "Open in new tab",
            "Copy link",
            "Rename",
            "Fork",
            "Share",
            "Select",
            "Archive",
        ]) {
            assert.ok(shown.items.includes(label), `it offers ${label}: ${shown.items.join(", ")}`);
        }

        await page.press("Escape");
        await settled({ sheet: null, path: "/" }, "Esc closes it, and nothing opened");

        assert.equal(
            (await rightClick(active, { shiftKey: true })).stopped,
            false,
            "Shift+right-click",
        );
        assert.equal(
            (await rightClick(active, { ctrlKey: true })).stopped,
            true,
            "Ctrl+right-click",
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await settled({ sheet: null }, "neither opens the menu");

        await menuOpens(active, "the menu again");
        await menuChoose("Select");
        await settled({ sheet: null }, "selected, and the menu closed");
        await until(
            async () =>
                (await inPage<number>(
                    `return JSON.stringify(document.querySelectorAll(${JSON.stringify(`${list} .session-row.selected`)}).length)`,
                )) === 1,
            "one row selected",
        );
        assert.ok(
            (await menuOpens(other, "the menu, while selecting")).shown.items.includes(
                "Deselect all",
            ),
        );
        await menuChoose("Deselect all");
        await until(
            async () =>
                (await inPage<number>(
                    `return JSON.stringify(document.querySelectorAll(${JSON.stringify(`${list} .session-row.selected`)}).length)`,
                )) === 0,
            "nothing selected",
        );
        assert.ok((await menuOpens(active, "the menu, after")).shown.items.includes("Select"));
        await page.press("Escape");
        await settled({ sheet: null }, "closed");
    },
);

test(
    "pinned sessions keep the order they were pinned in, and Move to top changes it",
    real,
    async () => {
        const [other] = folderSessions as [ConversationId];
        const pinnedRows = () =>
            inPage<number[]>(`
            const group = [...document.querySelectorAll(${JSON.stringify(`${list} .session-row`)})];
            const { store } = await import("/store.js");
            const pins = new Set(store.state.pinned);

            return JSON.stringify(group.map((each) => Number(each.dataset.id)).filter((id) => pins.has(id)));
        `);

        await fresh();
        // `other` is pinned first, though `active` is the newer: pins are in the order they were pinned in.
        await page.evaluate(`
        const { togglePin } = await import("/theme.js");
        togglePin(${Number(other)});
        togglePin(${Number(active)});
    `);
        await settled({ pinned: [Number(other), Number(active)] }, "both pinned");
        await until(
            async () =>
                JSON.stringify(await pinnedRows()) ===
                JSON.stringify([Number(other), Number(active)]),
            "the Pinned group in pin order",
        );

        assert.ok(
            !(await menuOpens(other, "the first pin's menu")).shown.items.includes("Move to top"),
        );
        await page.press("Escape");
        await settled({ sheet: null }, "closed");
        await menuOpens(active, "the last pin's menu");
        await menuChoose("Move to top");
        await settled({ sheet: null, pinned: [Number(active), Number(other)] }, "moved to the top");
        await until(
            async () =>
                JSON.stringify(await pinnedRows()) ===
                JSON.stringify([Number(active), Number(other)]),
            "the Pinned group follows",
        );

        await page.evaluate(`
        const { togglePin } = await import("/theme.js");
        togglePin(${Number(other)});
        togglePin(${Number(active)});
    `);
        await settled({ pinned: [] }, "unpinned again");
    },
);

test(
    "a family opens in the index and only the selected child joins the sidebar",
    real,
    async () => {
        const parent = await newSession(app);
        const kids = [await newSession(app), await newSession(app)];

        // Started by the parent, as a linked session is (`team`).
        await app.harness.commit(async (tx) => {
            const sessions = (await tx.doc(SessionsDoc)).items;

            for (const kid of kids) {
                sessions[String(kid)]!.linkedFrom = { id: Number(parent) };
            }
        }, BACKGROUND_CONTEXT);

        await fresh();
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(!document.querySelector(${JSON.stringify(row(kids[0]!))}))`,
            ),
            true,
        );
        await page.click({ selector: row(parent) + " .session-fold" });
        await page.waitFor({ selector: ".family-explorer .session-row" });
        assert.equal(
            await inPage<number>(
                'return document.querySelectorAll(".family-explorer .session-row").length',
            ),
            2,
        );
        const child = '.family-explorer .session-row[data-id="' + kids[0] + '"] .session';

        await page.click({ selector: child });
        await page.waitFor({ selector: ".family-context .lead-route" });
        await page.waitFor({ selector: row(kids[0]!) });
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(!document.querySelector(${JSON.stringify(row(kids[1]!))}))`,
            ),
            true,
        );
    },
);

test(
    "dragging the sidebar's edge changes nothing on the page's root until it ends",
    real,
    async () => {
        await fresh();
        const edge = await inPage<{ x: number; y: number; to: number; width: number }>(`
        const box = document.querySelector(".sidebar .resize-handle").getBoundingClientRect();
        const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
        window.rootChanges = 0;
        new MutationObserver((records) => (window.rootChanges += records.length)).observe(
            document.documentElement, { attributeFilter: ["style", "class"] });
        return JSON.stringify({ x: box.left + 4, y: box.top + box.height / 2,
            to: Math.round(box.left + 64 - sidebar.left), width: Math.round(sidebar.width) });
    `);
        const at = (dx: number) => ({ x: edge.x + dx, y: edge.y });
        const sidebar = () =>
            inPage<{ changes: number; width: number; root: string }>(`return JSON.stringify({
            changes: window.rootChanges,
            width: Math.round(document.querySelector(".sidebar").getBoundingClientRect().width),
            root: document.documentElement.style.getPropertyValue("--sidebar-w"),
        })`);

        // A variable or class on the root would restyle every element, every row, at each move.
        await page.input([
            { type: "mouse", action: "down", ...at(0) },
            ...[20, 40, 60].map((dx) => ({
                type: "mouse",
                action: "move",
                ...at(dx),
                pressed: true,
            })),
        ]);
        assert.deepEqual(await sidebar(), { changes: 0, width: edge.to, root: `${edge.width}px` });
        await page.input([{ type: "mouse", action: "up", ...at(60) }]);
        assert.equal((await sidebar()).root, `${edge.to}px`, "the root takes the width once");
        // Let go outside the page: the next move, with no button down, ends the drag.
        const now = await inPage<{ x: number; y: number }>(`
            const box = document.querySelector(".sidebar .resize-handle").getBoundingClientRect();
            return JSON.stringify({ x: box.left + 4, y: box.top + box.height / 2 });
        `);
        const veiled = () =>
            inPage<boolean>(`return String(!!document.querySelector(".resize-veil"))`);

        await page.input([
            { type: "mouse", action: "down", ...now },
            { type: "mouse", action: "move", x: now.x - 30, y: now.y, pressed: true },
        ]);
        assert.equal(await veiled(), true, "dragging");
        await page.input([{ type: "mouse", action: "move", x: now.x - 40, y: now.y }]);
        assert.equal(await veiled(), false, "the drag ended");
        await inPage(`(await import("/theme.js")).setPrefs({ sidebarWidth: 312 }); return "null"`);
    },
);

test("another tab opens where the list was scrolled", real, async () => {
    for (let count = 0; count < 30; count++) {
        await newSession(app);
    }

    await fresh();
    // A short window: a screenful is a few rows, and the list scrolls past them.
    await page.setViewport({ ...DESKTOP, height: 420 });
    const scrolled = (to = "") =>
        inPage<number>(
            `const list = document.querySelector(".sidebar .session-items"); ${to} return JSON.stringify(list.scrollTop)`,
        );

    await until(async () => (await scrolled("list.scrollTop = 600;")) === 600, "the list scrolled");
    await selectTab("Folders");
    assert.equal(await scrolled(), 600, "Folders");
    await selectTab("Recent");
    assert.equal(await scrolled(), 600, "Recent");
});

/** The labels of the open sheet's items, the sheet a long press opens. */
const sheetItems = () =>
    inPage<string[]>(`
        return JSON.stringify([...document.querySelectorAll(".sheet-host:not(.leaving) .list-item")]
            .map((each) => each.firstElementChild.textContent.trim()));
    `);

test(
    "rows draw no hover buttons at any pointer; the menu, a long press, and Shift+F10 give the actions",
    real,
    async () => {
        const buttons = () =>
            inPage<{ extra: number; rows: number }>(`
                const rows = [...document.querySelectorAll(${JSON.stringify(`${list} .session-row[data-id]`)})];

                return JSON.stringify({
                    rows: rows.length,
                    extra: document.querySelectorAll(
                        ".session-actions, .session-act, .session-ext-act, [data-part='session-read']",
                    ).length + rows.filter((each) => each.querySelectorAll("button:not(.session-fold)").length !== 1).length,
                });
            `);
        const wanted = ["Pin to the top", "Mark unread", "Archive"];

        // A mouse over the row, on the desktop.
        await fresh();
        const over = await inPage<{ x: number; y: number }>(`
            const box = document.querySelector(${JSON.stringify(row(active))}).getBoundingClientRect();

            return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        `);

        await page.hover(over);
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.deepEqual(
            { ...(await buttons()), rows: 0 },
            { extra: 0, rows: 0 },
            "a hovered row has its one button",
        );

        // Shift+F10 on a focused row: the menu, under the row, with every action.
        await page.evaluate(
            `document.querySelector(${JSON.stringify(`${row(active)} > .session`)}).focus()`,
        );
        await page.press("Shift+F10");
        let shown: Awaited<ReturnType<typeof menuShown>> = null;

        await until(async () => (shown = await menuShown()) !== null, "the menu from the keyboard");

        for (const label of wanted) {
            assert.ok(shown!.items.includes(label), `Shift+F10 offers ${label}: ${shown!.items}`);
        }

        // At the row's lower edge: below it, or above it when the menu does not fit under.
        const at = await inPage<{ edge: number; height: number; left: number }>(`
            const box = document.querySelector(${JSON.stringify(`${row(active)} > .session`)}).getBoundingClientRect();
            const menu = document.querySelector('[data-part="session-menu"]');

            return JSON.stringify({
                edge: Math.round(box.bottom),
                height: menu.offsetHeight,
                left: Math.round(box.left),
            });
        `);

        assert.ok(
            shown!.top === at.edge || shown!.top + at.height === at.edge,
            `at the row's lower edge: ${JSON.stringify({ ...at, top: shown!.top })}`,
        );
        assert.ok(shown!.left >= at.left, "at its left");
        await page.press("Escape");
        await settled({ sheet: null }, "closed");

        // A touch screen: the same row with no buttons, and the actions in the long press's sheet.
        await fresh(true);
        assert.equal((await buttons()).extra, 0, "no buttons on a phone's rows");
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(`${row(active)} > .session`)}) !== null)`,
                ),
            "the row, drawn",
        );
        // In view: a finger lands on what is at its point.
        await page.evaluate(
            `document.querySelector(${JSON.stringify(`${row(active)} > .session`)}).scrollIntoView({ block: "center" })`,
        );
        await finger(active, { ms: 1000 });
        await settled({ sheet: "session" }, "the long press's sheet");
        const items = await sheetItems();

        for (const label of wanted) {
            assert.ok(items.includes(label), `a long press offers ${label}: ${items}`);
        }

        await page.press("Escape");
        await settled({ sheet: null }, "closed");
    },
);

test(
    "a parent's count sits on the row's one line at every density, desktop and phone, and opens the family",
    real,
    async () => {
        const parent = await newSession(app);
        const lone = await newSession(app);
        const kids = 1234;

        await app.harness.commit(async (tx) => {
            const sessions = (await tx.doc(SessionsDoc)).items;
            const at = Date.now();

            sessions[String(parent)]!.title = "Parent of many";

            for (let at_ = 0; at_ < kids; at_++) {
                sessions[String(500000 + at_)] = {
                    title: `Linked ${at_}`,
                    cwd: "/linked",
                    createdAt: at,
                    updatedAt: at - 1000 - at_,
                    linkedFrom: { id: Number(parent) },
                };
            }
        }, BACKGROUND_CONTEXT);

        for (const mobile of [false, true]) {
            for (const density of ["comfortable", "compact", "tight"]) {
                await fresh(mobile);
                await page.evaluate(
                    `(await import("/theme.js")).setPrefs({ density: ${JSON.stringify(density)} })`,
                );
                await until(
                    async () =>
                        (await inPage<string>(
                            `return JSON.stringify(document.documentElement.dataset.density ?? "")`,
                        )) === density,
                    `${density} density`,
                );
                const what = `${mobile ? "390×844" : "desktop"}, ${density}`;
                const report = await inPage<{
                    count: string;
                    label: string | null;
                    inside: boolean;
                    height: number;
                    plain: number;
                    second: boolean;
                    words: boolean;
                    hit: number;
                    wide: number;
                    ring: string;
                }>(`
                    const row = document.querySelector(${JSON.stringify(row(parent))});
                    const plain = document.querySelector(${JSON.stringify(row(lone))});
                    const button = row.querySelector(".session-fold");
                    const label = button.querySelector(".family-browse-label");
                    const line = row.querySelector(":scope > .session").getBoundingClientRect();
                    const box = label.getBoundingClientRect();

                    return JSON.stringify({
                        count: button.textContent.trim(),
                        label: button.getAttribute("aria-label"),
                        inside: box.width > 0 && box.top >= line.top && box.bottom <= line.bottom &&
                            box.right <= line.right,
                        height: row.offsetHeight,
                        plain: plain.offsetHeight,
                        second: row.querySelector(".session-title.with-context, .session-hit") !== null,
                        words: /linked/i.test(row.textContent),
                        hit: Math.min(button.offsetWidth, button.offsetHeight),
                        wide: button.offsetWidth,
                        ring: getComputedStyle(label).outlineStyle,
                    });
                `);

                assert.equal(report.count, "1,234", `${what}: the count shows`);
                assert.equal(report.label, "Browse 1234 linked sessions", what);
                assert.ok(report.inside, `${what}: the count is inside the row's own line`);
                assert.equal(report.height, report.plain, `${what}: one line, as a plain row is`);
                assert.equal(report.second, false, `${what}: no second line`);
                assert.equal(report.words, false, `${what}: no "linked" words in the row`);
                assert.ok(report.wide >= 44, `${what}: 44px wide`);

                if (mobile) {
                    assert.ok(report.hit >= 44, `${what}: a 44px hit area for a finger`);
                }

                if (density === "tight" && !mobile) {
                    assert.equal(report.ring, "none", "no ring until it has the keyboard focus");
                }
            }
        }

        // A tap on it opens the family's index, as it always has.
        await fresh();
        await page.click({ selector: `${row(parent)} .session-fold` });
        await page.waitFor({ selector: ".family-explorer .session-row" });
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".family-range").textContent)`,
            ),
            "1–12 of 1,234",
        );
        await page.evaluate(`(await import("/theme.js")).setPrefs({ density: "comfortable" })`);
    },
);
