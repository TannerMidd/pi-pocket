// Session-row actions in a dedicated headless browser, with isolated app data and a scripted model.
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
let archived: ConversationId;
let folderSessions: ConversationId[];
const longFolder = "a-directory-with-a-name-long-enough-to-ellipsis-in-the-session-sidebar";

let list = ".sidebar";
const row = (id: ConversationId) => `${list} .session-row[data-id="${id}"]`;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function focused(selector: string): Promise<boolean> {
    return await inPage<boolean>(
        `return JSON.stringify(document.activeElement?.matches(${JSON.stringify(selector)}) ?? false)`,
    );
}

/** Use real Tab input, so the main button gets keyboard focus without hovering the row. */
async function tabTo(selector: string): Promise<void> {
    for (let step = 0; step < 40; step++) {
        await page.press("Tab");

        if (await focused(selector)) {
            return;
        }
    }

    assert.fail(`Tab did not reach ${selector}`);
}

type Appearance = {
    actions: string[];
    opacity: number[];
    transforms: string[];
    display: string;
    sideOpacity: number;
    reserved: number;
    sideWidth: number;
    titleRight: number;
    actionLeft: number;
    outlineStyle: string;
    outlineWidth: number;
    outlineOffset: number;
};

const appearance = (id: ConversationId) =>
    inPage<Appearance>(`
        const row = document.querySelector(${JSON.stringify(row(id))});
        const buttons = [...row.querySelectorAll(".session-act")];
        const side = row.querySelector(".session-side");
        const style = getComputedStyle(side);
        const outline = getComputedStyle(row.querySelector(".session"));

        return JSON.stringify({
            actions: buttons.map((button) => button.getAttribute("aria-label")),
            opacity: buttons.map((button) => Number(getComputedStyle(button).opacity)),
            transforms: buttons.map((button) => getComputedStyle(button).transform),
            display: getComputedStyle(row.querySelector(".session-actions")).display,
            sideOpacity: Number(style.opacity),
            reserved: parseFloat(style.minWidth) || 0,
            sideWidth: side.getBoundingClientRect().width,
            titleRight: row.querySelector(".session-title").getBoundingClientRect().right,
            actionLeft: buttons[0].getBoundingClientRect().left,
            outlineStyle: outline.outlineStyle,
            outlineWidth: parseFloat(outline.outlineWidth),
            outlineOffset: parseFloat(outline.outlineOffset),
        });
    `);

/** Wait for the CSS transitions too, then check the space the controls need. */
async function shown(id: ConversationId, actions: string[]): Promise<void> {
    await until(async () => {
        const now = await appearance(id);

        return (
            now.opacity.every((opacity) => opacity === 1) &&
            now.transforms.every((transform) => transform === "none") &&
            now.sideOpacity === 0
        );
    }, "actions shown, metadata hidden");
    const now = await appearance(id);
    const reserved = actions.length === 1 ? 26 : actions.length === 3 ? 86 : 56;

    assert.deepEqual(now.actions, actions);
    assert.deepEqual(
        now.transforms,
        actions.map(() => "none"),
    );
    assert.equal(now.reserved, reserved);
    assert.ok(now.sideWidth >= reserved, "metadata reserves the controls' width");
    assert.ok(now.titleRight <= now.actionLeft, "the title does not run underneath the controls");
}

async function hidden(id: ConversationId): Promise<void> {
    await until(async () => {
        const now = await appearance(id);

        return now.opacity.every((opacity) => opacity === 0) && now.sideOpacity === 1;
    }, "actions hidden, metadata restored");
    assert.equal((await appearance(id)).reserved, 0);
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

/** Check the painted outline against every scrolling/folding ancestor, not just its offset. */
async function insetOutline(selector: string): Promise<void> {
    assert.ok(await focused(selector), "real keyboard input focused the requested control");
    const outline = await inPage<{
        visible: boolean;
        style: string;
        width: number;
        offset: number;
        clipped: string[];
    }>(`
        const button = document.querySelector(${JSON.stringify(selector)});
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        const width = parseFloat(style.outlineWidth);
        const offset = parseFloat(style.outlineOffset);
        const outside = width + offset;
        const clipped = [];

        for (let parent = button.parentElement; parent; parent = parent.parentElement) {
            const bounds = parent.getBoundingClientRect();
            const css = getComputedStyle(parent);
            const clips = (value) => ["hidden", "auto", "scroll", "clip"].includes(value);

            if ((clips(css.overflowX) && (rect.left - outside < bounds.left - 0.5 || rect.right + outside > bounds.right + 0.5)) ||
                (clips(css.overflowY) && (rect.top - outside < bounds.top - 0.5 || rect.bottom + outside > bounds.bottom + 0.5))) {
                clipped.push(parent.className);
            }
        }

        return JSON.stringify({ visible: button.matches(":focus-visible"), style: style.outlineStyle, width, offset, clipped });
    `);

    assert.equal(outline.visible, true);
    assert.equal(outline.style, "solid");
    assert.ok(outline.width > 0, "keyboard focus has a visible outline");
    assert.ok(outline.offset + outline.width <= 0, "the complete outline is inset");
    assert.deepEqual(outline.clipped, [], "no folding or scrolling ancestor clips the outline");

    if (selector.includes(".group-head")) {
        await until(async () => {
            const colors = await inPage<[number[], number[]]>(`
                const style = getComputedStyle(document.querySelector(${JSON.stringify(selector)}));
                const context = new OffscreenCanvas(1, 1).getContext("2d");
                return JSON.stringify([style.color, style.getPropertyValue("--text").trim()].map((color) => {
                    context.fillStyle = color;
                    context.fillRect(0, 0, 1, 1);
                    return [...context.getImageData(0, 0, 1, 1).data];
                }));
            `);

            return colors[0].every((channel, index) => channel === colors[1][index]);
        }, "keyboard-focused group label transitions to the readable theme text color");
    }
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
    archived = await newSession(app);
    await app.commands.updateSession(archived, owner(app), { archived: true });
    const cwd = join(root, longFolder);

    mkdirSync(cwd);
    folderSessions = [await newSession(app, cwd), await newSession(app, cwd)];
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

test(
    "keyboard focus on a session reveals Archive and Pin; tabbing keeps them shown",
    real,
    async () => {
        await fresh();
        await hidden(active);
        await tabTo(`${row(active)} > .session`);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(active))}).matches(":hover"))`,
            ),
            false,
            "keyboard focus alone, not hover",
        );
        await shown(active, ["Archive", "Pin", "Mark unread"]);
        const outline = await appearance(active);

        assert.equal(outline.outlineStyle, "solid");
        assert.ok(outline.outlineWidth > 0, "the focused row has an outline");
        assert.ok(
            outline.outlineOffset + outline.outlineWidth <= 0,
            "the outline stays inside the row rather than being clipped by the folding group",
        );
        await page.press("Tab");
        assert.ok(await focused(`${row(active)} [aria-label="Archive"]`));
        await shown(active, ["Archive", "Pin", "Mark unread"]);
        await page.press("Tab");
        assert.ok(await focused(`${row(active)} [aria-label="Pin"]`));
        await shown(active, ["Archive", "Pin", "Mark unread"]);
        await page.press("Tab");
        assert.ok(await focused(`${row(active)} [aria-label="Mark unread"]`));
        await shown(active, ["Archive", "Pin", "Mark unread"]);
        await page.press("Tab");
        await hidden(active);

        // Hover still reveals the same controls, and leaving still restores metadata.
        await page.hover({ selector: `${row(active)} > .session` });
        await shown(active, ["Archive", "Pin", "Mark unread"]);
        await page.hover({ x: 1, y: 1 });
        await hidden(active);
    },
);

test("a click opens a session without leaving its row's actions shown", real, async () => {
    await fresh();
    await page.click({ selector: `${row(active)} > .session` });
    await page.hover({ x: 1, y: 1 });
    // The session's message box takes the focus once it shows.
    await until(() => focused(".composer textarea"), "the message box took the focus");
    await hidden(active);
    // A click on the open session's row keeps the focus there: still no actions. Past the moment after the click that
    // opened it, when the next click is held back (`back.js`).
    await new Promise((resolve) => setTimeout(resolve, 450));
    await page.click({ selector: `${row(active)} > .session` });
    await page.hover({ x: 1, y: 1 });
    assert.ok(await focused(`${row(active)} > .session`), "the click left focus on the row");
    await hidden(active);
});

test("an archived row reserves only one action's space on keyboard focus", real, async () => {
    await fresh();
    await selectTab("Archived");
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(archived))}) !== null)`,
            ),
        "the archived row",
    );
    await page.hover({ x: 1, y: 1 });
    await hidden(archived);
    await tabTo(`${row(archived)} > .session`);
    await shown(archived, ["Unarchive"]);
    await page.press("Tab");
    assert.ok(await focused(`${row(archived)} [aria-label="Unarchive"]`));
    await shown(archived, ["Unarchive"]);
    await page.press("Tab");
    await hidden(archived);
});

for (const mobile of [false, true]) {
    test(
        `Today header has an unclipped Tab focus outline on ${mobile ? "mobile" : "desktop"}`,
        real,
        async () => {
            await fresh(mobile);
            const header = `${list} .session-group:first-child > .group-head`;

            assert.equal(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(header)}).querySelector(".group-name").textContent.trim())`,
                ),
                "Today",
            );
            await tabTo(header);
            await insetOutline(header);
        },
    );
}

async function toggleFocusedGroup(header: string): Promise<void> {
    for (const key of ["Enter", "Space"]) {
        for (const expanded of [false, true]) {
            await page.press(key);
            await until(
                async () =>
                    await inPage<boolean>(`
                const header = document.querySelector(${JSON.stringify(header)});
                const group = header.closest(".session-group");
                const height = group.querySelector(".group-body").getBoundingClientRect().height;
                return JSON.stringify(header.getAttribute("aria-expanded") === ${JSON.stringify(String(expanded))} &&
                    group.classList.contains("closed") === ${!expanded} && ${expanded ? "height > 34" : "height === 0"});
            `),
                `${key} ${expanded ? "expands" : "collapses"} the group`,
            );
            await insetOutline(header);
        }
    }
}

test(
    "Today group collapses and expands with Enter and Space while retaining focus",
    real,
    async () => {
        await fresh();
        const header = `${list} .session-group:first-child > .group-head`;

        await tabTo(header);
        await toggleFocusedGroup(header);
        await page.press("Tab");
        assert.ok(
            await focused(`${list} .session-group:first-child .session-row:first-child > .session`),
        );
    },
);

test(
    "Folders groups long directory names with inset keyboard focus and retained toggle focus",
    real,
    async () => {
        await fresh();
        await selectTab("Folders");
        const header = `${list} .session-group:has(.session-row[data-id="${folderSessions[0]}"]) > .group-head`;
        const grouping = await inPage<{
            count: number;
            ids: string[];
            name: string;
            ellipsis: boolean;
        }>(`
        const header = document.querySelector(${JSON.stringify(header)});
        const group = header.closest(".session-group");
        const name = header.querySelector(".last");
        return JSON.stringify({
            count: document.querySelectorAll(${JSON.stringify(`${list} .session-group`)}).length,
            ids: [...group.querySelectorAll(".session-row")].map((row) => row.dataset.id),
            name: name.textContent,
            ellipsis: name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === "ellipsis",
        });
    `);

        assert.equal(grouping.count, 2, "distinct working directories form separate groups");
        assert.deepEqual(grouping.ids.sort(), folderSessions.map(String).sort());
        assert.equal(grouping.name, longFolder);
        assert.equal(
            grouping.ellipsis,
            true,
            "the long directory name is constrained instead of overflowing",
        );
        await page.hover({ x: 1, y: 1 });
        await tabTo(header);
        await insetOutline(header);
        await toggleFocusedGroup(header);
    },
);

for (const tab of ["Recent", "Folders"] as const) {
    test(
        `${tab} first and last rows have unclipped keyboard outlines in every group`,
        real,
        async () => {
            await fresh();
            await selectTab(tab);
            await page.hover({ x: 1, y: 1 });
            const boundaries = await inPage<ConversationId[]>(`
            const groups = [...document.querySelectorAll(${JSON.stringify(`${list} .session-group`)})];
            return JSON.stringify(groups.flatMap((group) => {
                const rows = [...group.querySelectorAll(".session-row")];
                return [...new Set([Number(rows[0].dataset.id), Number(rows.at(-1).dataset.id)])];
            }));
        `);

            assert.equal(boundaries.length, tab === "Folders" ? 3 : 2);

            for (const id of boundaries) {
                await tabTo(`${row(id)} > .session`);
                await shown(id, ["Archive", "Pin", "Mark unread"]);
                await until(
                    async () =>
                        await inPage<boolean>(
                            `return JSON.stringify(getComputedStyle(document.querySelector(${JSON.stringify(row(id))})).transform === "none")`,
                        ),
                    "row entrance animation finished",
                );
                await insetOutline(`${row(id)} > .session`);
            }
        },
    );
}

for (const tab of ["Recent", "Folders"] as const) {
    test(
        `${tab} collapsed groups skip hidden rows and actions in both Tab directions`,
        real,
        async () => {
            await fresh();
            await selectTab(tab);
            await page.hover({ x: 1, y: 1 });
            const header = `${list} .session-group:first-child > .group-head`;
            const next =
                tab === "Folders"
                    ? `${list} .session-group:nth-child(2) > .group-head`
                    : ".splash-actions > button:first-child";

            await tabTo(header);
            await page.press("Enter");
            await until(
                async () =>
                    await inPage<boolean>(`
                    const header = document.querySelector(${JSON.stringify(header)});
                    return JSON.stringify(header.getAttribute("aria-expanded") === "false" &&
                        header.closest(".session-group").querySelector(".group-body").inert);
                `),
                "collapsed contents are inert",
            );
            assert.ok(await focused(header), "collapsing retains focus on the header");
            await page.press("Tab");
            assert.ok(await focused(next), "Tab skips every hidden row and its action buttons");
            await page.press("Shift+Tab");
            assert.ok(await focused(header), "Shift+Tab skips hidden contents back to the header");
            await insetOutline(header);
            await page.press("Space");
            await until(
                async () =>
                    await inPage<boolean>(`
                    const header = document.querySelector(${JSON.stringify(header)});
                    return JSON.stringify(header.getAttribute("aria-expanded") === "true" &&
                        !header.closest(".session-group").querySelector(".group-body").inert);
                `),
                "expanded contents are no longer inert",
            );
            await page.press("Tab");
            assert.ok(
                await focused(
                    `${list} .session-group:first-child .session-row:first-child > .session`,
                ),
                "expanding restores the first row to the tab order",
            );
        },
    );
}

test(
    "touch screens keep actions out of layout and tab order, even when the row has focus",
    real,
    async () => {
        await fresh(true);
        assert.equal(
            await inPage<boolean>(`return JSON.stringify(matchMedia("(hover: none)").matches)`),
            true,
        );
        await tabTo(`${row(active)} > .session`);
        await hidden(active);
        assert.equal((await appearance(active)).display, "none");
        await page.press("Tab");
        assert.equal(await focused(`${row(active)} .session-act`), false);
        await page.hover({ selector: `${row(active)} > .session` });
        await hidden(active);
        assert.equal((await appearance(active)).display, "none");
    },
);

type Touched = {
    sheet: string | null;
    items: string[];
    path: string;
    layers: number;
    selected: number[];
    pinned: number[];
};

/** What a finger left: the sheet open and what it offers, where the app is, and the rows selected and pinned. */
const touched = () =>
    inPage<Touched>(`
        const { store } = await import("/store.js");

        return JSON.stringify({
            sheet: store.state.sheet?.type ?? null,
            items: [...document.querySelectorAll(".sheet-host:not(.leaving) .list-item > span:first-child")]
                .map((label) => label.textContent.trim()),
            path: location.pathname,
            layers: history.state?.pocket?.layers ?? 0,
            selected: [...document.querySelectorAll(${JSON.stringify(`${list} .session-row.selected`)})]
                .map((each) => Number(each.dataset.id)),
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
 * on whatever is there by then. Says whether the row showed the press, and its background then and before.
 */
const finger = (id: ConversationId, { ms, dy = 0 }: { ms: number; dy?: number }) =>
    inPage<{ pressed: boolean; before: string; during: string }>(`
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
        const before = getComputedStyle(button).backgroundColor;

        fire("pointerdown");
        await wait(Math.min(250, ${ms} / 2));
        const pressed = button.closest(".session-row").classList.contains("pressing");
        const during = getComputedStyle(button).backgroundColor;

        if (${dy} !== 0) {
            fire("pointermove", y + ${dy});
        }

        await wait(${ms} - Math.min(250, ${ms} / 2));
        fire("pointerup", y + ${dy});
        document
            .elementFromPoint(x, y + ${dy})
            .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: y + ${dy} }));

        return JSON.stringify({ pressed, before, during });
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

        // Held: the row shows the press, then its actions open; the lift's click, on the scrim now under it, does not
        // close them or open the session.
        const held = await finger(active, { ms: 600 });

        assert.equal(held.pressed, true, "the row shows the press while it is held");
        assert.notEqual(held.during, held.before, "the press is visible");
        await settled(
            {
                sheet: "session",
                items: ["Pin to the top", "Mark unread", "Archive", "Select"],
                path: "/",
            },
            "the row's actions, open",
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        await settled({ sheet: "session", path: "/", layers: 1 }, "still open after the lift");
        await choose("Pin to the top");
        await settled({ sheet: null, pinned: [Number(active)] }, "pinned, and the sheet closed");
        await finger(active, { ms: 600 });
        await settled(
            { sheet: "session", items: ["Unpin from the top", "Mark unread", "Archive", "Select"] },
            "the pinned row offers Unpin",
        );
        await choose("Unpin from the top");
        await settled({ sheet: null, pinned: [] }, "unpinned");

        // A finger that moves is scrolling or dragging: no press, no actions.
        const scrolled = await finger(active, { ms: 600, dy: 30 });

        assert.equal(scrolled.pressed, true, "the press shows until the finger moves");
        await new Promise((resolve) => setTimeout(resolve, 200));
        await settled({ sheet: null, path: "/" }, "no actions after a scroll");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".session-row.pressing") !== null)`,
            ),
            false,
            "the press is let go",
        );

        // An archived row only comes back.
        await selectTab("Archived");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(row(archived))}) !== null)`,
                ),
            "the archived row",
        );
        await finger(archived, { ms: 600 });
        await settled(
            { sheet: "session", items: ["Unarchive", "Select"] },
            "an archived row's actions",
        );
        // Past the moment after the lift, when what moves is taken to be under the finger and the next click is held back.
        await new Promise((resolve) => setTimeout(resolve, 450));
        await page.press("Escape");
        await settled({ sheet: null }, "closed");
        await selectTab("Recent");

        // A quick tap opens the session, as it always has.
        await finger(active, { ms: 80 });
        await settled({ sheet: null, path: `/s/${active}` }, "the session, opened by a tap");
    },
);

test(
    "touch screens: Select in a held row's actions starts a selection that taps add to, and back lets go",
    real,
    async () => {
        const [one, two] = folderSessions as [ConversationId, ConversationId];

        await fresh(true);
        await finger(one, { ms: 600 });
        await settled({ sheet: "session" }, "the row's actions");
        await choose("Select");
        await settled({ sheet: null, selected: [one].map(Number), layers: 1 }, "one selected");

        // Taps select rows now, and let them go, instead of opening them.
        await finger(two, { ms: 80 });
        await settled({ selected: [two, one].map(Number), path: "/" }, "a tap adds a row");
        await finger(two, { ms: 80 });
        await settled({ selected: [one].map(Number), path: "/" }, "a second tap lets it go");
        await finger(active, { ms: 80 });
        await settled({ selected: [one, active].map(Number), path: "/" }, "another row added");

        const bar = await inPage<{ text: string[]; sizes: [number, number][] }>(`
            const bar = document.querySelector(${JSON.stringify(`${list} .select-bar`)});

            return JSON.stringify({
                text: [...bar.querySelectorAll(".select-count, button")].map(
                    (each) => each.getAttribute("aria-label") ?? each.textContent.trim(),
                ),
                sizes: [...bar.querySelectorAll("button")].map((button) => {
                    const box = button.getBoundingClientRect();

                    return [Math.round(box.width), Math.round(box.height)];
                }),
            });
        `);

        assert.deepEqual(bar.text, ["2 selected", "Archive", "Pin", "Clear the selection"]);
        assert.ok(
            bar.sizes.every(([width, height]) => width >= 36 && height >= 36),
            `the bar's buttons take a thumb: ${JSON.stringify(bar.sizes)}`,
        );

        // Back lets go of the selection, and stays on the list; then a tap opens a session again.
        await page.evaluate(`history.back()`);
        await settled({ selected: [], layers: 0, path: "/" }, "back let go of the selection");
        await finger(two, { ms: 80 });
        await settled({ path: `/s/${two}` }, "a tap opens a session again");
    },
);

test(
    "touch screens: a held row's actions archive it, and an archived one's bring it back",
    real,
    async () => {
        const two = folderSessions[1]!;
        const archivedNow = () =>
            inPage<boolean>(`
            const { store } = await import("/store.js");

            return JSON.stringify(store.state.sessions.find((each) => each.id === ${Number(two)})?.archived === true);
        `);

        await fresh(true);
        await finger(two, { ms: 600 });
        await settled({ sheet: "session" }, "the row's actions");
        await choose("Archive");
        await until(archivedNow, "archived");
        await settled({ sheet: null, path: "/" }, "the sheet closed, on the list");
        await new Promise((resolve) => setTimeout(resolve, 450));
        await selectTab("Archived");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(row(two))}) !== null)`,
                ),
            "the row in Archived",
        );
        await finger(two, { ms: 600 });
        await settled({ sheet: "session", items: ["Unarchive", "Select"] }, "its actions");
        await choose("Unarchive");
        await until(async () => !(await archivedNow()), "back from the archive");
    },
);

/** A finger dragged left from a row, as the drawer's drag-to-close hears it (touch events, which stay with the row). */
const dragLeft = (id: ConversationId) =>
    page.evaluate(`
        const target = document.querySelector(${JSON.stringify(`${row(id)} > .session`)});
        const box = target.getBoundingClientRect();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        const touch = (at) => new Touch({ identifier: 3, target, clientX: at, clientY: y });
        const fire = (type, at) =>
            target.dispatchEvent(
                new TouchEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    touches: type === "touchend" ? [] : [touch(at)],
                    changedTouches: [touch(at)],
                }),
            );

        fire("touchstart", x);

        for (let step = 1; step <= 10; step++) {
            fire("touchmove", x - step * 20);
            await new Promise((resolve) => setTimeout(resolve, 30));
        }

        fire("touchend", x - 200);
    `);

const drawerOpen = () =>
    inPage<boolean>(
        `return JSON.stringify((await import("/store.js")).store.state.drawer === true && document.querySelector(".drawer") !== null)`,
    );

test(
    "touch screens: in the drawer, a row's actions open over it, its drag waits, and Select selects there",
    real,
    async () => {
        const [one, two] = folderSessions as [ConversationId, ConversationId];

        await fresh(true);
        await finger(active, { ms: 80 });
        await settled({ path: `/s/${active}` }, "a session open");
        await page.evaluate(`(await import("/store.js")).store.set({ drawer: true })`);
        list = ".drawer";
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(row(one))}) !== null)`,
                ),
            "the drawer's rows",
        );
        await new Promise((resolve) => setTimeout(resolve, 450));

        // The open session's row shows the press too, over its own fill.
        const open = await finger(active, { ms: 600 });

        assert.equal(open.pressed, true);
        assert.notEqual(open.during, open.before, "the press shows on the open session's row");
        await settled({ sheet: "session", layers: 2 }, "its actions, over the drawer");
        await page.press("Escape");
        await settled({ sheet: null, layers: 1 }, "closed, the drawer still open");

        await finger(one, { ms: 600 });
        await settled({ sheet: "session", layers: 2 }, "a row's actions, over the drawer");
        // The finger that opened them slides left: the drawer under them stays.
        await dragLeft(one);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(await drawerOpen(), true, "the drawer stays under the sheet");
        await choose("Select");
        await settled(
            { sheet: null, selected: [Number(one)], layers: 2, path: `/s/${active}` },
            "selected in the drawer",
        );
        assert.equal(await drawerOpen(), true, "the drawer stays for the selection");
        await finger(two, { ms: 80 });
        await settled({ selected: [two, one].map(Number), path: `/s/${active}` }, "a tap adds");

        // Back lets go of the selection first, then the drawer drags closed again.
        await page.evaluate(`history.back()`);
        await settled({ selected: [], layers: 1 }, "back let go of the selection");
        assert.equal(await drawerOpen(), true, "the drawer is still open");
        await new Promise((resolve) => setTimeout(resolve, 450));
        await dragLeft(one);
        await until(async () => !(await drawerOpen()), "the drawer, dragged closed");
    },
);

/** What this browser marked unread, and which rows show it. */
const marks = () =>
    inPage<{ stored: number[]; dots: number[]; bold: number[] }>(`
        const rows = [...document.querySelectorAll(${JSON.stringify(`${list} .session-row`)})];

        return JSON.stringify({
            stored: JSON.parse(localStorage.getItem("pocket.unread") ?? "[]"),
            dots: rows.filter((each) => each.querySelector(".unread-dot")).map((each) => Number(each.dataset.id)),
            bold: rows
                .filter((each) => getComputedStyle(each.querySelector(".session-title")).fontWeight === "700")
                .map((each) => Number(each.dataset.id)),
        });
    `);

async function marked(ids: ConversationId[], what: string): Promise<void> {
    const want = JSON.stringify({
        stored: ids.map(Number),
        dots: ids.map(Number),
        bold: ids.map(Number),
    });
    let last = "";

    try {
        await until(async () => (last = JSON.stringify(await marks())) === want, what);
    } catch {
        assert.fail(`${what}: ${last}`);
    }
}

test("a session marked unread shows it until it is opened, however it opens", real, async () => {
    const [one, two] = folderSessions as [ConversationId, ConversationId];
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

    // Back to it.
    await click(`${row(two)} > .session`);
    await until(async () => (await touched()).path === `/s/${two}`, "the other one");
    await click(`${row(one)} [aria-label="Mark unread"]`);
    await marked([one], "marked from the other session");
    await page.evaluate("history.back()");
    await until(async () => (await touched()).path === `/s/${one}`, "back to it");
    await marked([], "back read it");

    // A link, or a notification, opens it with the page.
    await click(`${row(two)} [aria-label="Mark unread"]`);
    await marked([two], "the other one marked");
    await page.navigate(`${base}/s/${two}`);
    await until(async () => (await touched()).path === `/s/${two}`, "loaded with it open");
    await marked([], "a page load read it");
});

test("touch screens: a finger held on a row marks it unread, and read again", real, async () => {
    await fresh(true);
    await finger(active, { ms: 600 });
    await settled({ sheet: "session" }, "the row's actions");
    await choose("Mark unread");
    await settled({ sheet: null, path: "/" }, "closed, still on the list");
    await marked([active], "marked");
    await finger(active, { ms: 600 });
    await settled(
        { sheet: "session", items: ["Pin to the top", "Mark read", "Archive", "Select"] },
        "a marked row offers Mark read",
    );
    await choose("Mark read");
    await marked([], "read again");
});

test(
    "touch screens: a selected row that is archived leaves the selection, and taps open sessions again",
    real,
    async () => {
        const [one, two] = folderSessions as [ConversationId, ConversationId];

        await fresh(true);
        await finger(one, { ms: 600 });
        await settled({ sheet: "session" }, "the row's actions");
        await choose("Select");
        await settled({ sheet: null, selected: [Number(one)], layers: 1 }, "one selected");
        await finger(one, { ms: 600 });
        await settled({ sheet: "session" }, "its actions again");
        await choose("Archive");
        await settled({ sheet: null, selected: [], layers: 0 }, "archived, out of view");
        await finger(two, { ms: 80 });
        await settled({ path: `/s/${two}`, selected: [] }, "a tap opens a session");
        await page.evaluate(
            `await (await import("/store.js")).actions.updateSession(${Number(one)}, { archived: false })`,
        );
    },
);
