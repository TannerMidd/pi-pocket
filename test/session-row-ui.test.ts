// Session-row actions in a dedicated headless browser, with isolated app data and a scripted model.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
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

async function selectTab(name: "Recent" | "Folders" | "Archived"): Promise<void> {
    const index = await inPage<number>(`
        const tabs = [...document.querySelectorAll(${JSON.stringify(`${list} .session-tabs [role="tab"]`)})];
        return JSON.stringify(tabs.findIndex((tab) => tab.textContent.trim() === ${JSON.stringify(name)}));
    `);

    assert.ok(index >= 0, `${name} tab exists in the current list`);
    await page.click({ selector: `${list} .session-tabs [role="tab"]:nth-of-type(${index + 1})` });
    await until(
        async () =>
            await inPage<boolean>(`
                const tab = document.querySelector(${JSON.stringify(`${list} .session-tabs [aria-selected="true"]`)});
                return JSON.stringify(tab?.textContent.trim() === ${JSON.stringify(name)});
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
    await click(`${row(one)} [aria-label="Mark unread"]`);
    await marked([one], "marked: stored, a dot, and a bold title");
    await click(`${row(one)} [aria-label="Mark read"]`);
    await marked([], "read again from the row");

    // A tap on the row opens it.
    await click(`${row(one)} [aria-label="Mark unread"]`);
    await marked([one], "marked again");
    await click(`${row(one)} > .session`);
    await until(async () => (await touched()).path === `/s/${one}`, "opened");
    await marked([], "opening it read it");
});
