// Getting around on a phone, in a real browser where this machine has Chromium: back closes what opened last (a sheet,
// the Files tile, a file in it, the sheet the menu opened) before it leaves a session, and leaving a session goes back
// to the list, or to the session before.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let first: ConversationId;
let second: ConversationId;
/** A session whose reply has a table and a code block. */
let rich: ConversationId;
/** A conversation taller than the screen, to scroll up in and come back down from. */
let long: ConversationId;

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

type Where = {
    path: string;
    layers: number;
    sheet: string | null;
    files: boolean;
    file: string | null;
};

/** Where the app is: its address, how many layers its history entry stands for, and what is open. */
const where = () =>
    inPage<Where>(`
        const { store } = await import("/store.js");

        return JSON.stringify({
            path: location.pathname,
            layers: history.state?.pocket?.layers ?? 0,
            sheet: store.state.sheet?.type ?? null,
            files: document.querySelector(".files-tile:not(.leaving)") !== null,
            file: document.querySelector(".ft-view:not(.leaving) .ft-view-name")?.textContent ?? null,
        });
    `);

/** Wait until the app is where `expected` says, in the fields it names. */
async function reach(expected: Partial<Where>, what: string): Promise<void> {
    let last: Where | undefined;

    try {
        await until(async () => {
            last = await where();

            return Object.entries(expected).every(
                ([key, value]) => last![key as keyof Where] === value,
            );
        }, what);
    } catch {
        assert.fail(`${what}: the app is at ${JSON.stringify(last)}`);
    }
}

/** Back, as a phone's back gesture or button does it. */
const back = () => page.evaluate(`history.back()`);

const tap = async (selector: string) => {
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`,
            )) === true,
        selector,
    );
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
};

const row = (id: ConversationId) => `.home-list .session-row[data-id="${id}"] .session`;

/** The session list, freshly loaded at phone size with no panel open: each test starts from here. */
async function fresh(): Promise<void> {
    await page.setViewport(VIEWPORTS.mobile);
    await page.evaluate(`
        for (const key of Object.keys(sessionStorage)) {
            if (/^pocket\.(files|browser)/.test(key)) {
                sessionStorage.removeItem(key);
            }
        }
    `);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(first))}) !== null)`,
            )) === true,
        "the session list",
        20_000,
    );
}

/** Go to a session from inside the app, as a peek tile or a subagent's link does. */
const goTo = (id: ConversationId) =>
    page.evaluate(`(await import("/store.js")).navigate(${Number(id)})`);

/** Past a route's slide (back.js sets `data-route` while it runs): the screen rests where a finger finds it. */
const slid = () =>
    until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.documentElement.dataset.route === undefined)`,
            )) === true,
        "the slide's end",
    );

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, "README.md"), "# Hello\n\nA file to read.\n");
    writeFileSync(join(work, "src", "main.ts"), "export const answer = 42;\n");
    // A repository with a change, for Changes and the branch in the status line.
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", work, "-c", "user.name=T", "-c", "user.email=t@t.t", ...args]);

    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "Start");
    writeFileSync(join(work, "README.md"), "# Hello\n\nA file to read, changed.\n");
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "mobile-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    first = await newSession(app);
    second = await newSession(app);
    rich = await newSession(app);
    await say(
        app,
        rich,
        [
            "A table, and some code:",
            "",
            "| File | Lines | What changes |",
            "| --- | --- | --- |",
            "| src/components/Header.tsx | 3 | the dark class on the header, with a rather long description |",
            "",
            "```ts",
            "export const toggle = (theme: string) => (theme === 'dark' ? 'light' : 'dark');",
            "```",
        ].join("\n"),
    );
    long = await newSession(app);

    for (let turn = 1; turn <= 6; turn++) {
        await say(
            app,
            long,
            Array.from({ length: 20 }, (_, line) => `- Turn ${turn}, line ${line + 1}`).join("\n"),
        );
    }

    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(first))}) !== null)`,
            )) === true,
        "the session list",
        20_000,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("a session opened from the list: back goes back to the list", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}`, layers: 0 }, "the session");
    await back();
    await reach({ path: "/" }, "the list");
});

test("back closes the open file, then the Files tile, then leaves the session", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}` }, "the session");
    await tap('.topbar [aria-label="Files"]');
    await reach({ files: true, layers: 1 }, "the Files tile");
    await tap('.ft-row[data-path$="/README.md"]');
    await reach({ file: "README.md", layers: 2 }, "the file, over the tree");

    await back();
    await reach({ files: true, file: null, layers: 1 }, "back to the tree");
    await back();
    await reach({ files: false, layers: 0, path: `/s/${first}` }, "back to the conversation");
    await back();
    await reach({ path: "/" }, "back to the list");
});

test("a reload keeps the steps back: the file, then the tile", real, async () => {
    await fresh();
    await tap(row(first));
    await tap('.topbar [aria-label="Files"]');
    await tap('.ft-row[data-path$="/README.md"]');
    await reach({ file: "README.md", layers: 2 }, "the file");
    await page.reload({ wait: true });
    await reach({ file: "README.md", layers: 2 }, "the file again, after the reload");

    await back();
    await reach({ files: true, file: null, layers: 1 }, "back to the tree");
    await back();
    await reach({ files: false, layers: 0 }, "back to the conversation");
    await back();
    await reach({ path: "/" }, "back to the list");
});

test("a sheet the menu opened goes back to the menu, then to the conversation", real, async () => {
    await fresh();
    await tap(row(first));
    await tap('.topbar [aria-label="Menu"]');
    await reach({ sheet: "menu", layers: 1 }, "the menu");
    await tap('.place[data-place="find"]');
    await reach({ sheet: "find", layers: 2 }, "find, from the menu's tiles");

    await back();
    await reach({ sheet: "menu", layers: 1 }, "back to the menu");
    await back();
    await reach({ sheet: null, layers: 0, path: `/s/${first}` }, "back to the conversation");
});

test("a sheet closed with a tap takes its step back with it", real, async () => {
    await fresh();
    await tap(row(first));
    await tap('.topbar [aria-label="Menu"]');
    await reach({ sheet: "menu", layers: 1 }, "the menu");
    await tap('.sheet-head [aria-label="Close"]');
    await reach({ sheet: null, layers: 0 }, "the menu closed, and its step gone");
    await back();
    await reach({ path: "/" }, "back leaves for the list, not into the menu");
});

test("a sheet dragged down far enough closes; a short drag springs back", real, async () => {
    await fresh();
    await tap(row(first));
    await tap('.topbar [aria-label="Menu"]');
    await reach({ sheet: "menu", layers: 1 }, "the menu");

    const drag = (to: number) =>
        page.evaluate(`
            const head = document.querySelector(".sheet-head");
            const from = head.getBoundingClientRect().top + 10;
            const touch = (y) => new Touch({ identifier: 1, target: head, clientX: 200, clientY: y });
            const fire = (type, y) =>
                head.dispatchEvent(
                    new TouchEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        touches: type === "touchend" ? [] : [touch(y)],
                        changedTouches: [touch(y)],
                    }),
                );

            fire("touchstart", from);

            for (let step = 1; step <= 10; step++) {
                fire("touchmove", from + (${to} * step) / 10);
                await new Promise((resolve) => setTimeout(resolve, 30));
            }

            fire("touchend", from + ${to});
        `);

    await drag(40);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await reach({ sheet: "menu", layers: 1 }, "still open after a short drag");
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".sheet").style.transform)`,
        ),
        "",
        "back in place",
    );

    await drag(400);
    await reach({ sheet: null, layers: 0, path: `/s/${first}` }, "closed by the long drag");
});

test(
    "from one session to another, back returns to the first; the top bar's back goes to the list",
    real,
    async () => {
        await fresh();
        await tap(row(first));
        await reach({ path: `/s/${first}` }, "the first session");
        await goTo(second);
        await reach({ path: `/s/${second}`, layers: 0 }, "the second session");
        await back();
        await reach({ path: `/s/${first}` }, "back to the first");

        await goTo(second);
        await reach({ path: `/s/${second}` }, "the second again");
        await tap(".topbar-back");
        await reach({ path: "/" }, "the list, past both sessions");
        assert.equal(
            await inPage<number>(`return JSON.stringify(history.state.pocket.back)`),
            0,
            "the list's own entry",
        );
    },
);

test(
    "a session picked in the drawer replaces the drawer's step: back returns to the session before",
    real,
    async () => {
        await fresh();
        await tap(row(first));
        await reach({ path: `/s/${first}`, layers: 0 }, "the first session");
        await page.evaluate(`(await import("/store.js")).store.set({ drawer: true })`);
        await reach({ layers: 1 }, "the drawer");
        await tap(`.drawer .session-row[data-id="${second}"] .session`);
        await reach({ path: `/s/${second}`, layers: 0 }, "the second session, the drawer gone");
        // A moment later, still there: the drawer's step coming off does not take the app back with it.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await reach({ path: `/s/${second}`, layers: 0 }, "still the second session");
        assert.equal(
            await inPage<number>(
                `return JSON.stringify((await import("/store.js")).store.state.conversationId)`,
            ),
            Number(second),
        );

        await back();
        await reach({ path: `/s/${first}`, layers: 0 }, "back to the first, not into the drawer");
        await back();
        await reach({ path: "/" }, "then the list");
    },
);

test("on a phone the top bar keeps only the buttons with something to say", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}` }, "the session");
    const shown = await inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".topbar button")]
                .filter((button) => getComputedStyle(button).display !== "none")
                .map((button) => button.getAttribute("aria-label")),
        );
    `);

    assert.ok(shown.includes("Back to sessions"), `the way back: ${shown}`);
    assert.ok(shown.includes("Files"), `Files: ${shown}`);
    assert.ok(shown.includes("Menu"), `the menu: ${shown}`);
    assert.ok(!shown.includes("Artifacts"), `no artifacts yet: ${shown}`);
});

test("a session opened straight away gets the list under it at the first tap", real, async () => {
    await fresh();
    await page.navigate(`${base}/s/${second}`);
    await reach({ path: `/s/${second}` }, "the session");
    assert.equal(
        await inPage<boolean>(`return JSON.stringify(history.state.pocket.listUnder)`),
        true,
        "not before anyone touched the page",
    );
    await tap(".scroller");
    await until(
        async () =>
            (await inPage<number>(`return JSON.stringify(history.state.pocket.back)`)) === 1,
        "the list under it",
    );
    await back();
    await reach({ path: "/" }, "back to the list, not out of the app");
});

test("a file opened from Changes goes back to Changes", real, async () => {
    await fresh();
    await page.evaluate(`(await import("/files-panel.js")).setFilesOpen(false)`);
    await tap(row(first));
    await tap('.topbar [aria-label="Files"]');
    await reach({ files: true, layers: 1 }, "the Files tile");
    // A path tapped in the Changes tab, as a line number there opens the file.
    await page.evaluate(`
        const { store } = await import("/store.js");
        const { openFile } = await import("/ui.js");

        store.set({ filesTab: "changes" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        openFile("README.md:2");
    `);
    await reach({ file: "README.md", layers: 2 }, "the file, from Changes");
    await back();
    await reach({ file: null, layers: 1 }, "back from the file");
    assert.equal(
        await inPage<string>(
            `return JSON.stringify((await import("/store.js")).store.state.filesTab)`,
        ),
        "changes",
        "on Changes again",
    );
});

test("Escape closes a sheet and takes its step back", real, async () => {
    await fresh();
    await tap(row(first));
    await tap('.topbar [aria-label="Menu"]');
    await reach({ sheet: "menu", layers: 1 }, "the menu");
    await page.press("Escape");
    await reach({ sheet: null, layers: 0, path: `/s/${first}` }, "closed, its step gone");
});

test("forward onto a closed sheet does not open it again", real, async () => {
    await fresh();
    await tap(row(first));
    await tap('.topbar [aria-label="Menu"]');
    await reach({ sheet: "menu", layers: 1 }, "the menu");
    await back();
    await reach({ sheet: null, layers: 0 }, "closed by back");
    await page.evaluate(`history.forward()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await reach(
        { sheet: null, layers: 0, path: `/s/${first}` },
        "still closed, history back in step",
    );
});

test("panels docked beside the conversation are not steps back", real, async () => {
    await fresh();
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    await tap(`.sidebar .session-row[data-id="${first}"] .session`);
    await reach({ path: `/s/${first}` }, "the session");
    await tap('.topbar [aria-label="Files"]');
    await reach({ files: true }, "the Files tile, docked");
    await tap('.ft-row[data-path$="/README.md"]');
    await reach({ file: "README.md" }, "the file");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await reach({ layers: 0 }, "no steps for them");
    await page.evaluate(`(await import("/files-panel.js")).setFilesOpen(false)`);
});

test(
    "between phone and desktop widths the Files tile still slides in as a screen",
    real,
    async () => {
        await fresh();
        await page.setViewport({ width: 1000, height: 800, scale: 1, mobile: false });
        await tap(`.sidebar .session-row[data-id="${first}"] .session`);
        await reach({ path: `/s/${first}` }, "the session");
        await tap('.topbar [aria-label="Files"]');
        await reach({ files: true, layers: 1 }, "the tile, covering the conversation");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(getComputedStyle(document.querySelector(".files-tile")).animationName)`,
            ),
            "push-in",
        );
        await back();
        await reach({ files: false, layers: 0 }, "closed by back");
    },
);

/** A finger on the element `at` names, moving through `points` (from its corner), then let go. */
const swipe = async (at: string, points: [number, number][]) => {
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(at)}) !== null)`,
            )) === true,
        at,
    );
    // From where it rests: mid-slide, the points would land off to the side, at the screen's edge.
    await slid();
    await page.evaluate(`
        const target = document.querySelector(${JSON.stringify(at)});
        const box = target.getBoundingClientRect();
        const points = ${JSON.stringify(points)}.map(([x, y]) => [box.left + x, box.top + y]);
        const touch = ([x, y]) => new Touch({ identifier: 1, target, clientX: x, clientY: y });
        const fire = (type, point) =>
            target.dispatchEvent(
                new TouchEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    touches: type === "touchend" ? [] : [touch(point)],
                    changedTouches: [touch(point)],
                }),
            );

        fire("touchstart", points[0]);

        for (const point of points.slice(1)) {
            fire("touchmove", point);
            await new Promise((resolve) => setTimeout(resolve, 16));
        }

        fire("touchend", points.at(-1));
    `);
};

/** A sideways swipe from `from`, `by` pixels in all, in ten steps. */
const sideways = (from: number, by: number, y = 200): [number, number][] =>
    Array.from({ length: 11 }, (_, step) => [from + (by * step) / 10, y]);

test("the places, a thumb away: the button beside the message box, then a tile", real, async () => {
    await fresh();
    await tap(row(first));
    await tap(".composer-row .places-button");
    await reach({ sheet: "places", layers: 1 }, "the places");
    assert.ok(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector(".sheet").getBoundingClientRect().top > innerHeight / 2)`,
        ),
        "a short sheet, in the bottom half",
    );
    await tap('.place[data-place="files"]');
    await reach({ sheet: null, files: true, layers: 1 }, "the Files tile in the sheet's place");
    await back();
    await reach({ files: false, layers: 0, path: `/s/${first}` }, "back to the conversation");
});

test("swipe up from the message box for the places", real, async () => {
    await fresh();
    await tap(row(first));
    await swipe(".model-chip", [
        [20, 10],
        [21, 0],
        [22, -20],
        [22, -50],
        [22, -70],
    ]);
    await reach({ sheet: "places", layers: 1 }, "the places");
    await back();
    await reach({ sheet: null, layers: 0 }, "closed");
});

test("on the conversation, swipe left for Files and right to go back", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}` }, "the session");

    await swipe(".pane > .scroller", sideways(300, -40));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await reach({ files: false, layers: 0 }, "a short swipe does nothing");

    await swipe(".pane > .scroller", sideways(300, -160));
    await reach({ files: true, layers: 1 }, "the Files tile");
    await tap('.ft-row[data-path$="/README.md"]');
    await reach({ file: "README.md", layers: 2 }, "a file");

    await swipe(".files-tile", sideways(80, 170));
    await reach({ files: true, file: null, layers: 1 }, "swiped back to the tree");
    await swipe(".files-tile", sideways(80, 170));
    await reach({ files: false, layers: 0 }, "swiped back to the conversation");
    await swipe(".pane > .scroller", sideways(80, 170));
    await reach({ path: "/" }, "swiped back to the list");
});

/** How wide and tall a control is to a finger: from its middle, as far as a tap still reaches it. */
const hitArea = (selector: string) =>
    inPage<{ w: number; h: number } | null>(`
        const e = document.querySelector(${JSON.stringify(selector)});

        if (!e) {
            return JSON.stringify(null);
        }

        e.scrollIntoView({ block: "center" });
        const r = e.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        const own = (px, py) => {
            const at = document.elementFromPoint(px, py);

            return at !== null && (at === e || e.contains(at));
        };
        const reach = (dx, dy) => {
            let n = 0;

            while (n < 40 && own(x + dx * (n + 1), y + dy * (n + 1))) {
                n++;
            }

            return n;
        };

        return JSON.stringify({ w: reach(-1, 0) + reach(1, 0) + 1, h: reach(0, -1) + reach(0, 1) + 1 });
    `);

test("a quick second tap does not land on what just slid in", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}`, layers: 0 }, "the session");
    await new Promise((resolve) => setTimeout(resolve, 400));
    // A double tap on the places button: the second lands where a tile (or the scrim) has just come.
    await page.click({ selector: ".composer-row .places-button" }, { count: 2 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await reach({ sheet: "places", layers: 1 }, "one places sheet, and nothing it opened");
    // A double tap on a tile: Files opens, and the second tap opens nothing in it.
    await page.click({ selector: '.place[data-place="files"]' }, { count: 2 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await reach({ sheet: null, files: true, file: null, layers: 1 }, "Files, nothing opened in it");
    await back();
    await reach({ files: false, layers: 0 }, "closed");
});

test("a tap right after something moved on its own is not held back", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}`, layers: 0 }, "the session");
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Another session opens with no tap (as a reply's link or the server opens one), and the person taps Files at once.
    await goTo(second);
    await page.click({ selector: '.topbar [aria-label="Files"]' });
    await reach({ path: `/s/${second}`, files: true, layers: 1 }, "Files, from the tap");
    await back();
    await reach({ files: false, layers: 0 }, "closed");
});

test("on a phone, nothing that slides in makes the page wider than the screen", real, async () => {
    /** Watches the page's width every frame from now on; `widest()` says the most it reached. */
    const watch = () =>
        page.evaluate(`
            window.widest = innerWidth;
            const tick = () => {
                window.widest = Math.max(window.widest, innerWidth, document.documentElement.scrollWidth);
                requestAnimationFrame(tick);
            };

            requestAnimationFrame(tick);
        `);
    const widest = () => inPage<number>(`return JSON.stringify(window.widest)`);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

    await fresh();
    await watch();
    await tap(row(first));
    await reach({ path: `/s/${first}` }, "the session");
    await settle();
    assert.equal(await widest(), 390, "a session sliding in");
    // A swipe right, held: the conversation leans after the finger, and springs back when it lifts where it began.
    await slid();
    await page.evaluate(`
        const target = document.querySelector(".pane > .scroller");
        const box = target.getBoundingClientRect();
        const finger = (x) => new Touch({ identifier: 1, target, clientX: box.left + x, clientY: box.top + 200 });
        const fire = (type, x) =>
            target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [finger(x)], changedTouches: [finger(x)] }));

        fire("touchstart", 80);

        for (let step = 1; step <= 10; step++) {
            fire("touchmove", 80 + step * 15);
            await new Promise((resolve) => setTimeout(resolve, 30));
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
        fire("touchmove", 80);
        fire("touchend", 80);
    `);
    await settle();
    assert.equal(await widest(), 390, "a swipe's lean");
    await reach({ path: `/s/${first}`, layers: 0 }, "still the session");
    await tap('.topbar [aria-label="Files"]');
    await reach({ files: true }, "Files");
    await settle();
    assert.equal(await widest(), 390, "Files sliding in");
    await back();
    await reach({ files: false }, "Files closed");
    await page.evaluate(`(await import("/store.js")).store.set({ drawer: true })`);
    await settle();
    assert.equal(await widest(), 390, "the drawer sliding in");
    await back();
    await settle();
    await back();
    await reach({ path: "/" }, "the list");
    await settle();
    assert.equal(await widest(), 390, "the list sliding back");
});

test("a swipe follows its own finger, not another on the glass", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}` }, "the session");
    // Swipes wait for the conversation's view, at rest: mid-slide, its middle is still off to the right.
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".composer") !== null)`,
            )) === true,
        "the conversation",
    );
    await slid();
    // Finger 1 swipes left; finger 2 rests low on the screen, first in the event's list of touches.
    await page.evaluate(`
        const target = document.querySelector(".pane > .scroller");
        const box = target.getBoundingClientRect();
        const finger = (x) => new Touch({ identifier: 1, target, clientX: box.left + x, clientY: box.top + 200 });
        const thumb = new Touch({ identifier: 2, target, clientX: box.left + 60, clientY: box.top + 500 });
        const fire = (type, touches, changed) =>
            target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches: changed }));

        fire("touchstart", [finger(300)], [finger(300)]);

        for (let step = 1; step <= 10; step++) {
            fire("touchmove", [thumb, finger(300 - step * 16)], [finger(300 - step * 16)]);
            await new Promise((resolve) => setTimeout(resolve, 16));
        }

        fire("touchend", [thumb], [finger(140)]);
    `);
    await reach({ files: true, layers: 1 }, "Files, from the finger that swiped");
    await back();
    await reach({ files: false, layers: 0 }, "closed");
});

test(
    "on a phone, a reply's table keeps readable columns, and scrolls sideways instead",
    real,
    async () => {
        await fresh();
        await goTo(rich);
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".md table") !== null)`,
                )) === true,
            "the table",
        );
        const table = await inPage<{ narrowest: number; scrolls: boolean }>(`
        const table = document.querySelector(".md table");
        const widths = [...table.querySelectorAll("th")].map((th) => th.getBoundingClientRect().width);

        return JSON.stringify({ narrowest: Math.min(...widths), scrolls: table.scrollWidth > table.clientWidth });
    `);

        assert.ok(
            table.narrowest >= 60,
            `no column crushed to a few letters: ${table.narrowest}px`,
        );
        assert.ok(table.scrolls, "the table scrolls sideways instead");
    },
);

test("on a phone, the controls are thumb-sized", real, async () => {
    await fresh();
    await goTo(rich);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".code-head .copy") !== null)`,
            )) === true,
        "the reply",
    );
    // Measured where it rests, past the conversation's slide in.
    await slid();

    for (const selector of [
        ".topbar-back",
        '.topbar [aria-label="Files"]',
        ".composer-row .places-button",
        ".composer-row .model-chip",
        ".code-head .copy",
        ".answer-actions > button",
        ".status-line .branch",
    ]) {
        const area = await hitArea(selector);

        assert.ok(area, `${selector} shows`);
        assert.ok(
            area.w >= 36 && area.h >= 36,
            `${selector} takes a thumb: ${JSON.stringify(area)}`,
        );
    }

    // The message box is one target: a tap on its edge, off the one line of text, or on the room beside Send, still
    // goes to the text.
    for (const [where, point] of [
        ["its edge", `const box = document.querySelector(".composer").getBoundingClientRect();`],
        [
            "beside Send",
            `const box = document.querySelector(".composer-row .grow").getBoundingClientRect();`,
        ],
    ]) {
        await page.evaluate(`document.activeElement?.blur()`);
        const at = await inPage<{ x: number; y: number }>(`
            ${point}

            return JSON.stringify({ x: box.x + box.width / 2, y: ${where === "its edge" ? "box.y + 4" : "box.y + box.height / 2"} });
        `);

        await page.click(at);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.activeElement === document.querySelector(".composer textarea"))`,
            ),
            true,
            `a tap on ${where} gives the text the focus`,
        );
    }

    await page.evaluate(`document.activeElement?.blur()`);

    // A reaction keeps its chip's look; the tap it takes reaches past it, unseen.
    await tap(".answer-actions .reaction.add");
    await tap(".reaction-picker button");
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".answer-actions > .reaction:not(.add)") !== null)`,
            )) === true,
        "the reaction",
    );
    const chip = await inPage<number>(
        `return JSON.stringify(document.querySelector(".answer-actions > .reaction:not(.add)").getBoundingClientRect().height)`,
    );
    const reaction = await hitArea(".answer-actions > .reaction:not(.add)");

    assert.ok(chip <= 30, `the chip keeps its size: ${chip}px tall`);
    assert.ok(reaction && reaction.h >= 36, `it takes a thumb: ${JSON.stringify(reaction)}`);
});

test(
    "on a phone, Files' bar is out of reach under a file, and a diff's header keeps the name readable",
    real,
    async () => {
        await fresh();
        await tap(row(first));
        await tap('.topbar [aria-label="Files"]');
        await reach({ files: true }, "Files");
        await tap('.ft-row[data-path$="/README.md"]');
        await reach({ file: "README.md" }, "the file");
        // Past the file's slide in, when the bar under it goes.
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(getComputedStyle(document.querySelector(".files-bar")).visibility)`,
            ),
            "hidden",
        );
        await back();
        await reach({ file: null }, "the tree");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(getComputedStyle(document.querySelector(".files-bar")).visibility)`,
            ),
            "visible",
        );
        await tap('.files-tabs [role="tab"]:nth-child(2)');
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".dr-file .dv-name") !== null)`,
                )) === true,
            "the change",
        );
        const name = await inPage<{ shown: number; whole: number }>(`
        const name = document.querySelector(".dr-file .dv-name");

        return JSON.stringify({ shown: name.clientWidth, whole: name.scrollWidth });
    `);

        assert.ok(name.shown >= name.whole, `the name is not cut short: ${JSON.stringify(name)}`);

        // The branch stays in sight beside the folder, which gives way, and takes its own tap: on a big phone too, where
        // the counts share its line.
        for (const width of [390, 430]) {
            await page.setViewport({ ...VIEWPORTS.mobile, width, height: 932 });
            assert.equal(
                await inPage<boolean>(`
                    const branch = document.querySelector(".dr-branch");
                    const r = branch.getBoundingClientRect();
                    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);

                    return JSON.stringify(r.right <= branch.closest(".dr-where").getBoundingClientRect().right + 1 && branch.contains(at));
                `),
                true,
                `the branch shows, and takes a tap, ${width}px wide`,
            );
        }

        await page.setViewport(VIEWPORTS.mobile);
        // Its label hides on a phone; the checkbox alone still takes a thumb.
        const viewed = await hitArea(".dr-file .dv-viewed");

        assert.ok(
            viewed && viewed.w >= 40 && viewed.h >= 36,
            `Viewed takes a thumb: ${JSON.stringify(viewed)}`,
        );
        await back();
        await reach({ files: false, layers: 0 }, "closed");
    },
);

test("the way to the bottom goes to the bottom, and scrolling works after it", real, async () => {
    const where = () =>
        inPage<{ gap: number; top: number; jump: boolean; overflow: string; coarse: boolean }>(`
            const scroller = document.querySelector(".pane > .scroller");

            return JSON.stringify({
                gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
                top: scroller.scrollTop,
                jump: document.querySelector(".jump") !== null,
                overflow: scroller.style.overflowY,
                coarse: matchMedia("(pointer: coarse)").matches,
            });
        `);

    await fresh();
    await goTo(long);
    await slid();
    await until(async () => (await where()).top > 0, "the conversation, at its bottom");
    assert.equal((await where()).coarse, true, "a touch screen, where a scroller glides");

    // Up to the top, as a thumb would: the way back down shows.
    await page.evaluate(`document.querySelector(".pane > .scroller").scrollTop = 0`);
    await until(async () => (await where()).jump, "the way to the bottom");
    await tap(".jump");
    await until(async () => {
        const now = await where();

        return now.gap < 2 && !now.jump && now.overflow === "";
    }, "the bottom, with scrolling back on");

    // It stays there, and the conversation still scrolls by hand.
    await page.evaluate(`document.querySelector(".pane > .scroller").scrollTop = 0`);
    await until(async () => (await where()).top === 0, "scrolled up by hand");
    await back();
    await reach({ path: "/" }, "the list");
});

test(
    "while a finger is on the conversation, a change under it does not move it; after, it stays at the bottom",
    real,
    async () => {
        const gap = () =>
            inPage<number>(`
            const scroller = document.querySelector(".pane > .scroller");

            return JSON.stringify(Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight));
        `);
        const finger = (type: "touchstart" | "touchend") =>
            page.evaluate(`
            const scroller = document.querySelector(".pane > .scroller");
            const touch = new Touch({ identifier: 1, target: scroller, clientX: 200, clientY: 300 });

            scroller.dispatchEvent(
                new TouchEvent("${type}", {
                    bubbles: true,
                    touches: ${type === "touchstart" ? "[touch]" : "[]"},
                    changedTouches: [touch],
                }),
            );
        `);
        // The message box grows, as with a long draft: the conversation above it gets shorter.
        const box = (px: number) =>
            page.evaluate(
                `document.querySelector(".composer textarea").style.minHeight = "${px}px"`,
            );

        await fresh();
        await goTo(long);
        await slid();
        await until(async () => (await gap()) < 2, "the bottom");
        // A few frames for the resize to be seen, as it is before the next paint: the conversation stays put.
        const frames = () =>
            page.evaluate(
                `await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))`,
            );

        await finger("touchstart");
        await box(160);
        await frames();
        assert.ok((await gap()) > 40, "left where the finger holds it");
        await finger("touchend");
        await page.evaluate(`
        const scroller = document.querySelector(".pane > .scroller");

        scroller.scrollTop = scroller.scrollHeight;
    `);
        await until(async () => (await gap()) < 2, "the bottom again");
        // Past any glide: a change keeps it at the bottom, as before.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await box(260);
        await frames();
        assert.ok((await gap()) < 2, "kept at the bottom");
        await box(0);
        await back();
        await reach({ path: "/" }, "the list");
    },
);

test(
    "on a phone, an invite lasts as long as chosen, and the one it replaces ends",
    real,
    async () => {
        const code = () =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector(".invite-code-value")?.textContent.replace(/\\s/g, "") ?? null)`,
            );
        const help = () =>
            inPage<string>(
                `return JSON.stringify(document.querySelector(".sheet p.muted").textContent)`,
            );
        const status = async (invite: string | null) =>
            (await fetch(`${base}/join/${invite}`)).status;

        await fresh();
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "invite" })`);
        await until(async () => (await code()) !== null, "the first invite");
        const first = await code();

        assert.match(await help(), /expires in 15 minutes/);
        await page.evaluate(
            `[...document.querySelectorAll(".sheet .segmented button")].find((each) => each.textContent.trim() === "1 week").click()`,
        );
        await until(async () => ![null, first].includes(await code()), "the week's invite");
        const week = await code();

        assert.match(await help(), /expires in a week/);
        assert.equal(await status(week), 200);
        await until(async () => (await status(first)) === 410, "the 15 minutes' invite, ended");

        // An owner invite always lasts 15 minutes: nothing to choose.
        await tap('.sheet label.check input[type="checkbox"]');
        await until(async () => ![null, week].includes(await code()), "the owner's invite");
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll(".sheet .label")].some((each) => each.textContent === "Expires after"))`,
            ),
            false,
        );
        assert.match(await help(), /expires in 15 minutes/);
        await until(async () => (await status(week)) === 410, "the week's invite, ended");
        await tap('.sheet label.check input[type="checkbox"]');
        await until(async () => (await code()) !== null, "a guest's invite again");
        const steer = await code();

        // Not for a frame does the sheet show an invite made for other settings: View only shows no Steer invite.
        await page.evaluate(`
            window.frames = [];
            const watch = () => {
                const on = document.querySelector(".sheet .segmented .on")?.textContent.trim();
                const code = document.querySelector(".invite-code-value")?.textContent.replace(/\\s/g, "");

                window.frames.push([on, code ?? null]);

                if (window.frames.length < 60) {
                    requestAnimationFrame(watch);
                }
            };

            requestAnimationFrame(watch);
            [...document.querySelectorAll(".sheet .segmented button")].find((each) => each.textContent.trim() === "View only").click();
        `);
        await until(async () => ![null, steer].includes(await code()), "the view-only invite");
        const frames = await inPage<[string, string | null][]>(
            `return JSON.stringify(window.frames)`,
        );

        assert.ok(
            !frames.some(([on, shown]) => on === "View only" && shown === steer),
            "no frame shows the Steer invite under View only",
        );
        const viewOnly = await code();

        // New invite makes another and leaves the one before working; closing leaves the last one working.
        await tap(".sheet .button.wide:last-of-type");
        await until(async () => ![null, viewOnly].includes(await code()), "another invite");
        const another = await code();

        assert.equal(await status(viewOnly), 200, "the one before New invite still works");
        await back();
        await reach({ sheet: null, layers: 0 }, "closed");
        assert.equal(await status(another), 200, "the last one shown still works");

        // An invite that cannot be made says so, and New invite tries again. (A sheet opened again while it still slides
        // away is the same sheet: wait until it is gone.)
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".sheet") === null)`,
                )) === true,
            "the sheet, gone",
        );
        await page.evaluate(`
            window.realFetch = window.fetch;
            window.fetch = (url, ...rest) =>
                String(url).endsWith("/api/invite") ? Promise.reject(new TypeError("offline")) : window.realFetch(url, ...rest);
        `);
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "invite" })`);
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".sheet")?.textContent.includes("Tap New invite to try again") === true)`,
                )) === true,
            "the way to try again",
        );
        await page.evaluate(`window.fetch = window.realFetch`);
        await tap(".sheet .button.wide:last-of-type");
        await until(async () => (await code()) !== null, "the invite, at the second try");
        await back();
        await reach({ sheet: null, layers: 0 }, "closed");
    },
);
