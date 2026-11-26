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
    const click = (selector: string) =>
        page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

    await fresh();
    // A row has no buttons of its own: the mark comes from the menu that a right-click opens.
    await menuOpens(one, "the row's menu");
    await menuChoose("Mark unread");
    await marked([one], "marked: stored, a dot, and a bold title");
    await menuOpens(one, "the row's menu again");
    await menuChoose("Mark read");
    await marked([], "read again from the menu");

    // A tap on the row opens it.
    await menuOpens(one, "the menu, a third time");
    await menuChoose("Mark unread");
    await marked([one], "marked again");
    await click(`${row(one)} > .session`);
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

/** `kids` as sessions that `parent` started, as Agent Teams records them. */
async function linkTo(parent: ConversationId, kids: ConversationId[]): Promise<void> {
    await app.harness.commit(async (tx) => {
        const sessions = (await tx.doc(SessionsDoc)).items;

        for (const kid of kids) {
            sessions[String(kid)]!.linkedFrom = { id: Number(parent) };
        }
    }, BACKGROUND_CONTEXT);
}

/** No fold chosen yet in this browser, so every session with linked ones starts folded, as a new browser shows it. */
async function noFoldsChosen(): Promise<void> {
    await page.evaluate(`localStorage.removeItem("pocket.foldedLinked"); return "null"`);
}

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
    "a fold hides linked sessions at once, from the list and the numbers, but never above the open one",
    real,
    async () => {
        const parent = await newSession(app);
        const kids = [await newSession(app), await newSession(app)];

        await linkTo(parent, kids);

        const shown = async () =>
            await inPage<{
                kids: number;
                expanded: string | null;
                numbered: number;
                rows: number;
                tag: string;
            }>(`
            const fold = document.querySelector(${JSON.stringify(`${row(parent)} .session-fold`)});
            return JSON.stringify({
                kids: ${JSON.stringify(kids.map((kid) => row(kid)))}.filter((each) => document.querySelector(each)).length,
                expanded: fold?.getAttribute("aria-expanded") ?? null,
                numbered: document.querySelectorAll(${JSON.stringify(`${list} .session-num`)}).length,
                rows: document.querySelectorAll(${JSON.stringify(`${list} .session-row`)}).length,
                tag: fold?.textContent.trim() ?? "",
            });
        `);
        const click = (selector: string) =>
            page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

        // This browser has folded nothing yet: linked sessions start folded, and the tag says how many.
        await noFoldsChosen();
        await fresh();
        await until(async () => (await shown()).kids === 0, "the linked sessions folded at first");
        assert.equal(
            (await shown()).tag,
            "Linked 2",
            "the row says how many, and nothing is hidden silently",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(`${row(parent)} .session-fold`)})).textTransform)`,
            ),
            "uppercase",
            "LINKED n, in small caps",
        );

        // Shown: the linked sessions are in the list, and in the numbers Alt+1…9 use.
        await click(`${row(parent)} .session-fold`);
        await until(async () => (await shown()).kids === 2, "a tap shows them");
        const open = await shown();

        assert.equal(open.expanded, "true");
        assert.equal(
            open.numbered,
            Math.min(9, open.rows),
            "the numbers follow the rows that show",
        );

        // Folded again: gone from the list and the numbers, with nothing else changing.
        await click(`${row(parent)} .session-fold`);
        await until(async () => (await shown()).kids === 0, "the fold hides them");
        const folded = await shown();

        assert.equal(folded.expanded, "false");
        assert.equal(
            folded.numbered,
            Math.min(9, folded.rows),
            "the numbers follow the rows that show",
        );

        // Open one of them: its parent's fold opens, and its button is off. The open one is the list's card.
        await page.navigate(`${base}/s/${kids[0]}`);
        await until(
            async () => (await shown()).kids === 1,
            "the other linked session, still under its parent",
        );
        assert.equal((await shown()).expanded, "true");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(`${row(parent)} .session-fold`)}).disabled)`,
            ),
            true,
            "the fold above the open session is off",
        );

        // Back home, the fold is as it was, and unfolding shows them.
        await fresh();
        await until(async () => (await shown()).kids === 0, "folded again away from it");
        await click(`${row(parent)} .session-fold`);
        await until(async () => (await shown()).kids === 2, "unfolded");
    },
);

test("the labeled rail is 80px wide, with 50px items and 20px marks", real, async () => {
    await fresh();
    const rail = await inPage<Record<string, number>>(`
        const box = (selector) => document.querySelector(selector).getBoundingClientRect();
        const style = (selector) => getComputedStyle(document.querySelector(selector));
        return JSON.stringify({
            width: Math.round(box(".desktop-rail").width),
            item: Math.round(parseFloat(style(".desktop-rail .rail-place").minHeight)),
            icon: Math.round(box(".desktop-rail .rail-place .icon").width),
            label: Math.round(parseFloat(style(".desktop-rail .rail-label").fontSize)),
            brand: Math.round(box(".rail-brand").width),
            gap: Math.round(parseFloat(style(".desktop-rail").rowGap)),
        });
    `);

    assert.deepEqual(rail, { width: 80, item: 50, icon: 20, label: 12, brand: 44, gap: 6 });
});

test(
    "a row is one line, with no line to a linked session and no buttons of its own",
    real,
    async () => {
        await fresh();
        const row = await inPage<{
            height: number;
            clamp: string;
            wrap: string;
            branches: number;
            acts: number;
            time: number;
        }>(`
        const button = document.querySelector(${JSON.stringify(`${list} .session-row > .session`)});
        const title = button.querySelector(".session-title");
        const side = button.querySelector(".session-time");

        return JSON.stringify({
            height: Math.round(button.getBoundingClientRect().height),
            clamp: getComputedStyle(title).webkitLineClamp,
            wrap: getComputedStyle(title).whiteSpace,
            branches: document.querySelectorAll(${JSON.stringify(`${list} .session-branches`)}).length,
            acts: document.querySelectorAll(${JSON.stringify(`${list} .session-act, ${list} .session-actions`)}).length,
            time: Math.round(parseFloat(getComputedStyle(side).fontSize)),
        });
    `);

        assert.equal(row.height, 30, "30px, one line");
        assert.equal(row.clamp, "none", "no two-line clamp");
        assert.equal(row.wrap, "nowrap", "the title runs on one line");
        assert.equal(row.branches, 0, "no connector lines");
        assert.equal(row.acts, 0, "no hover buttons");
        assert.ok(row.time > 0, "the time still shows on the row's right");
    },
);

test("a row's actions are its right-click menu, also after a hover", real, async () => {
    await fresh();
    await page.hover({ selector: `${row(active)} > .session` });

    assert.equal(
        await inPage<number>(
            `return JSON.stringify(document.querySelectorAll(${JSON.stringify(`${list} .session-act`)}).length)`,
        ),
        0,
        "a hover adds no button",
    );
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(`${row(active)} .session-time`)})).visibility)`,
        ),
        "visible",
        "the time keeps its place",
    );

    const { shown } = await menuOpens(active, "the row's menu");

    for (const label of ["Archive", "Pin to the top", "Mark unread", "Select"]) {
        assert.ok(
            shown.items.includes(label),
            `the menu offers ${label}: ${shown.items.join(", ")}`,
        );
    }

    await page.press("Escape");
    await settled({ sheet: null }, "closed");
});

test(
    "the open session is the list's card, and its linked sessions open in place under it",
    real,
    async () => {
        const parent = await newSession(app);
        const kids = [await newSession(app), await newSession(app)];

        await linkTo(parent, kids);
        await page.navigate(`${base}/s/${parent}`);

        const card = () =>
            inPage<{
                id: string | null;
                title: string;
                eyebrow: string;
                linked: number;
                expanded: boolean | null;
                rows: string[];
                inList: number;
                kidRows: number;
            }>(`
            const card = document.querySelector(".sidebar .session-current");
            const rows = [...document.querySelectorAll(".sidebar .session-row")];
            const list = card?.querySelector('[data-part="session-current-panel"]');

            return JSON.stringify({
                id: card?.dataset.id ?? null,
                title: card?.querySelector(".current-title")?.textContent.trim() ?? "",
                eyebrow: card?.querySelector(".current-eyebrow")?.textContent.replace(/\\s+/g, " ").trim() ?? "",
                linked: card?.querySelectorAll(".current-linked-row").length ?? 0,
                expanded: card?.querySelector(".current-link-toggle")?.getAttribute("aria-expanded") === "true",
                rows: list && !list.hidden ? [...list.querySelectorAll(".current-linked-row")].map((each) => each.dataset.id) : [],
                inList: rows.filter((each) => ${JSON.stringify(kids.map(String))}.includes(each.dataset.id)).length,
                kidRows: rows.filter((each) => each.dataset.id === ${JSON.stringify(String(parent))}).length,
            });
        `);

        await until(async () => (await card()).id === String(parent), "the open session's card");
        const first = await card();

        assert.equal(first.inList, 0, "its linked sessions are not rows below it");
        assert.equal(first.kidRows, 0, "the open session is not a row too");
        assert.match(first.eyebrow, /·\s*\w+\s*·/, "the card's folder, status, and age");
        assert.equal(first.expanded, false, "its linked sessions start folded");
        assert.deepEqual(first.rows, [], "so none of them shows");

        await page.click({ selector: ".sidebar .current-link-toggle" });
        await until(
            async () => (await card()).rows.length === 2,
            "the linked sessions open in place",
        );
        assert.equal((await card()).expanded, true);

        await page.click({ selector: ".sidebar .current-link-toggle" });
        await until(async () => (await card()).rows.length === 0, "and close again");
    },
);

test(
    "a linked session that is open says which session started it, and the strip opens it",
    real,
    async () => {
        const parent = await newSession(app);
        const kid = await newSession(app);

        await linkTo(parent, [kid]);
        await page.navigate(`${base}/s/${kid}`);

        const strip = () =>
            inPage<{ text: string; title: string }>(`
            const parent = document.querySelector(".sidebar .session-current-parent");

            return JSON.stringify({
                text: parent?.querySelector(".current-parent-label")?.textContent.trim() ?? "",
                title: parent?.querySelector(".current-parent-name")?.textContent.trim() ?? "",
            });
        `);

        await until(async () => (await strip()).text !== "", "the strip above the card");
        assert.equal((await strip()).text, "From", "FROM, in small caps");

        const title = await inPage<string>(
            `return JSON.stringify((await import("/store.js")).store.state.sessions.find((each) => each.id === ${Number(parent)}).title || "New session")`,
        );

        assert.equal((await strip()).title, title, "the session that started it");

        await page.click({ selector: ".sidebar .current-parent-link" });
        await until(async () => (await touched()).path === `/s/${parent}`, "the parent, opened");
    },
);

test("on a phone, rows are a thumb's height, and the rail is a bottom bar", real, async () => {
    await fresh(true);
    const phone = await inPage<{
        rows: number;
        heights: number[];
        acts: number;
        items: number;
        smallest: number;
        bottom: number;
    }>(`
        const box = (el) => el.getBoundingClientRect();
        const rows = [...document.querySelectorAll(".home-list .session-row > .session")];
        const items = [...document.querySelectorAll(".mobile-rail .rail-place")].filter(
            (el) => el.getClientRects().length,
        );

        return JSON.stringify({
            rows: rows.length,
            heights: [...new Set(rows.map((el) => Math.round(box(el).height)))],
            acts: document.querySelectorAll(".home-list .session-act").length,
            items: items.length,
            smallest: Math.min(...items.map((el) => Math.round(box(el).height))),
            bottom: Math.round(box(items[0]).bottom),
        });
    `);

    assert.ok(phone.rows > 0, "the list, on a phone");
    assert.deepEqual(phone.heights, [44], "a thumb's height, one line");
    assert.equal(phone.acts, 0, "no buttons of its own");
    assert.equal(phone.items, 4, "the four destinations");
    assert.ok(phone.smallest >= 44, "each a thumb's target");
    assert.ok(phone.bottom > VIEWPORTS.mobile.height - 16, "in a bar at the screen's foot");

    // The drawer over a session shows the same card, and its linked sessions open there too.
    const parent = await newSession(app);
    const kid = await newSession(app);

    await linkTo(parent, [kid]);
    await page.navigate(`${base}/s/${parent}`);
    await until(
        async () =>
            (await inPage<number>(
                `return JSON.stringify(document.querySelectorAll(".home-list .session-current").length)`,
            )) === 0,
        "no list beside the session",
    );
    await page.evaluate(`(await import("/store.js")).store.set({ drawer: true }); return "null"`);
    await until(
        async () =>
            (await inPage<number>(
                `return JSON.stringify(document.querySelectorAll(".drawer .session-current").length)`,
            )) === 1,
        "the card, in the drawer",
    );
    // The drawer may still be sliding in: a tap on its own element, where a pointer would miss it meanwhile.
    await page.evaluate(
        `document.querySelector(".drawer .current-link-toggle").click(); return "null"`,
    );
    await until(
        async () =>
            await inPage<boolean>(
                `const toggle = document.querySelector(".drawer .current-link-toggle");
                return JSON.stringify(toggle?.getAttribute("aria-expanded") === "true")`,
            ),
        "its linked session, shown in place",
    );
    assert.equal(
        await inPage<number>(
            `const panel = document.querySelector('.drawer [data-part="session-current-panel"]');
            return JSON.stringify(Math.round(panel.querySelector(".current-linked-row").getBoundingClientRect().height))`,
        ),
        44,
        "and a thumb's height there",
    );
});

test("Priority has no card: what waits for you comes first", real, async () => {
    await fresh();
    assert.equal(
        await inPage<number>(
            `return JSON.stringify(document.querySelectorAll(".sidebar .session-current").length)`,
        ),
        0,
        "the list, with no session open",
    );

    await page.navigate(`${base}/s/${active}`);
    await until(
        async () =>
            (await inPage<number>(
                `return JSON.stringify(document.querySelectorAll(".sidebar .session-current").length)`,
            )) === 1,
        "the open session's card, on Recent",
    );

    await selectTab("Priority");
    assert.equal(
        await inPage<number>(
            `return JSON.stringify(document.querySelectorAll(".sidebar .session-current").length)`,
        ),
        0,
        "no card over the needs you come first",
    );
    await selectTab("Recent");
});

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
