// Getting around on a phone, in a real browser where this machine has Chromium: back closes what opened last (a sheet,
// the Files tile, a file in it, the sheet the menu opened) before it leaves a session, and leaving a session goes back
// to the list, or to the session before.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
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

/** Open the Files tile from the menu's tiles, where the top bar keeps it while it is closed. */
async function openFiles(): Promise<void> {
    await tap('.topbar [aria-label="Menu"]');
    await reach({ sheet: "menu" }, "the menu");
    await tap('.place[data-place="files"]');
}

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
    writeFileSync(join(work, "web.env"), "PORT=3000\nHOST=127.0.0.1\n");
    writeFileSync(join(work, "magpie.service"), "[Service]\nExecStart=/usr/bin/magpie\n");
    mkdirSync(join(work, "docs"), { recursive: true });
    writeFileSync(join(work, "docs", "guide.md"), "# Guide\n\n[The code](../src/main.ts:1)\n");
    // A repository with a change, for Changes and the branch in the top bar.
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
    await openFiles();
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

test(
    "local Markdown file links use the viewer, line numbers, and its back stack",
    real,
    async () => {
        const linked = await newSession(app);
        const startup = `${join(work, "magpie.service")}:2`;

        await say(
            app,
            linked,
            [
                "[web.env](web.env)",
                `[**Startup**](${startup})`,
                "[Line](README.md:3)",
                "[Encoded](src%2Fmain.ts)",
                "[Home](~/notes.md)",
                "[Relative](./README.md)",
                "[Website](https://example.com/web.env)",
                "[Network](//example.com/web.env)",
                "[Session](/s/12)",
                "[Image API](/api/c/1/file?path=web.env)",
                "[Fragment](#web.env)",
                "[Unsafe](javascript:alert%281%29)",
                '<a href="https://example.com" data-path="web.env">Forged</a>',
                "`web.env`",
                "```\nweb.env\n```",
            ].join("\n\n"),
        );
        await fresh();
        await goTo(linked);
        await reach({ path: `/s/${linked}` }, "the reply with file links");
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.reply .md a[data-path="web.env"]') !== null)`,
                )) === true,
            "the rendered links",
        );
        const links = await inPage<
            Record<string, { path: string | null; target: string | null; href: string | null }>
        >(`
        return JSON.stringify(Object.fromEntries(
            [...document.querySelectorAll(".reply .md a")].map((link) => [link.textContent, {
                path: link.getAttribute("data-path"),
                target: link.getAttribute("target"),
                href: link.getAttribute("href"),
            }]),
        ));
    `);

        assert.equal(links["web.env"]?.path, "web.env");
        assert.equal(links.Startup?.path, startup);
        assert.equal(
            links.Line?.path,
            "./README.md:3",
            "a bare filename with a line survives sanitizing",
        );
        assert.equal(links.Encoded?.path, "src/main.ts");
        assert.equal(links.Home?.path, "~/notes.md");
        assert.equal(links.Relative?.path, "./README.md");
        assert.equal(links["web.env"]?.target, null, "local links stay in the app");

        for (const label of [
            "Website",
            "Network",
            "Session",
            "Image API",
            "Fragment",
            "Unsafe",
            "Forged",
        ]) {
            assert.equal(links[label]?.path, null, `${label} stays outside the file viewer`);
        }

        assert.equal(links.Website?.target, "_blank");
        assert.equal(links.Unsafe?.href, null, "unsafe schemes are still stripped");
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelectorAll(".reply .md code[data-path]").length)`,
            ),
            1,
            "inline paths still work, code blocks stay code",
        );
        await page.evaluate(`document.querySelector('.reply .md a[data-path="web.env"]').focus()`);
        await page.press("Enter");
        await reach({ sheet: "file", layers: 1 }, "the file opened by keyboard");
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".file-viewer")?.textContent.includes("PORT=3000") === true)`,
                )) === true,
            "the environment file contents",
        );
        await back();
        await reach({ sheet: null, layers: 0, path: `/s/${linked}` }, "back to the reply");
        await tap(".reply .md a[data-path] strong");
        await reach({ sheet: "file", layers: 1 }, "the startup configuration");
        await until(
            async () =>
                (
                    await inPage<string>(
                        `return JSON.stringify(document.querySelector('.file-line.on[data-line="2"]')?.textContent ?? "")`,
                    )
                ).includes("ExecStart=/usr/bin/magpie"),
            "the startup line",
        );
        await back();
        await reach({ sheet: null, layers: 0 }, "back from the startup configuration");
        await tap('.reply .md a[data-path="./README.md:3"]');
        await reach({ sheet: "file", layers: 1 }, "the bare filename with a line");
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector('.file-line.on[data-line="3"]') !== null)`,
                )) === true,
            "line three",
        );
        await back();
        await reach({ sheet: null, layers: 0 }, "back from line three");
        // Text selected elsewhere neither holds the link back nor lets it leave the app.
        await page.evaluate(`
            const range = document.createRange();

            range.selectNodeContents(document.querySelector(".reply .md code[data-path]"));
            getSelection().removeAllRanges();
            getSelection().addRange(range);
        `);
        await tap('.reply .md a[data-path="web.env"]');
        await reach(
            { sheet: "file", layers: 1, path: `/s/${linked}` },
            "the file, with a selection elsewhere",
        );
        await back();
        await reach({ sheet: null, layers: 0 }, "back from the file");
        await page.evaluate(`getSelection().removeAllRanges()`);
        // A link in a Markdown file names a file beside it, not in the session's folder.
        await page.evaluate(`(await import("/ui.js")).openFile("docs/guide.md")`);
        await reach({ sheet: "file", layers: 1 }, "the guide");
        await tap('.file-viewer .md a[data-path$="/src/main.ts:1"]');
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".file-viewer")?.textContent.includes("answer = 42") === true)`,
                )) === true,
            "the file the guide links to",
        );
        await reach({ sheet: "file", layers: 2 }, "the linked file, a step above the guide");
        await back();
        await reach({ sheet: "file", layers: 1 }, "back to the guide");
        await back();
        await reach({ sheet: null, layers: 0, path: `/s/${linked}` }, "back from the guide");
        await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
        await openFiles();
        await reach({ files: true }, "the docked Files tile");
        await tap('.reply .md a[data-path="web.env"]');
        await reach(
            { file: "web.env", sheet: null, layers: 0 },
            "the linked file in the Files tile",
        );
        await page.evaluate(`(await import("/files-panel.js")).setFilesOpen(false)`);
    },
);

test("a reload keeps the steps back: the file, then the tile", real, async () => {
    await fresh();
    await tap(row(first));
    await openFiles();
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
    // The folder's change shows once it is read.
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".changes-button") !== null)`,
            )) === true,
        "the changes",
    );
    const shown = await inPage<string[]>(`
        return JSON.stringify(
            [...document.querySelectorAll(".topbar button")]
                .filter((button) => getComputedStyle(button).display !== "none")
                .map((button) => button.getAttribute("aria-label")),
        );
    `);

    assert.ok(shown.includes("Back to sessions"), `the way back: ${shown}`);
    assert.ok(
        shown.some((label) => label?.startsWith("Changes: 1 file")),
        `what changed: ${shown}`,
    );
    assert.ok(shown.includes("Menu"), `the menu: ${shown}`);
    assert.ok(!shown.includes("Files"), `Files, in the menu while closed: ${shown}`);
    assert.ok(!shown.includes("Artifacts"), `no artifacts yet: ${shown}`);
    assert.match(
        await inPage<string>(
            `return JSON.stringify(document.querySelector(".topbar .title-sub").textContent)`,
        ),
        /work.*⎇ main/,
        "the folder and the branch under the title",
    );
});

test(
    "the branch in the top bar opens the branch picker in one tap, the title the menu",
    real,
    async () => {
        await fresh();
        await tap(row(first));
        await reach({ path: `/s/${first}` }, "the session");
        await slid();
        await page.click({ selector: ".topbar button.title-branch" });
        await reach({ sheet: "branch", layers: 1 }, "the branch picker");
        // Past its slide in.
        await new Promise((resolve) => setTimeout(resolve, 450));
        const placed = await inPage<{ down: boolean; gap: number }>(`
            const menu = document.querySelector(".pop-menu");
            const branch = document.querySelector(".topbar button.title-branch");

            return JSON.stringify({
                down: menu.classList.contains("down"),
                gap: menu.getBoundingClientRect().top - branch.getBoundingClientRect().bottom,
            });
        `);

        assert.ok(placed.down, "a menu down from the branch");
        assert.ok(Math.abs(placed.gap - 6) < 2, `just under it: ${placed.gap}px`);
        await back();
        await reach({ sheet: null, layers: 0 }, "closed");
        // Past the moment a tap right after a layer closes is held back.
        await new Promise((resolve) => setTimeout(resolve, 400));
        await page.click({ selector: ".topbar .title-main" });
        await reach({ sheet: "menu", layers: 1 }, "the menu, from the title");
        await back();
        await reach({ sheet: null, layers: 0 }, "closed again");
    },
);

// With a mouse: a touch screen's line under the title is a thumb tall whatever it holds.
test("while a session loads, its title stays where it will be", real, async () => {
    await fresh();
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${first}`);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".topbar .title-sub")?.textContent.includes("main") === true)`,
            )) === true,
        "the folder and branch under the title",
    );
    // Before the server answers, the view is empty, as `navigate` leaves it: no folder or branch under the title yet.
    const tops = await inPage<{ loaded: number; loading: number; sub: string }>(`
        const { store } = await import("/store.js");
        const top = () => document.querySelector(".topbar .title-main").getBoundingClientRect().top;
        const painted = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        // Past what pops and rises in as the page opens (not what loops for ever).
        await Promise.all(
            document
                .getAnimations()
                .filter((each) => each.effect?.getComputedTiming().endTime !== Infinity)
                .map((each) => each.finished.catch(() => {})),
        );
        const loaded = top();

        store.set({ view: { ...store.state.view, conversation: null, agent: null, branch: null } });
        await painted();

        return JSON.stringify({
            loaded,
            loading: top(),
            sub: document.querySelector(".topbar .title-sub").textContent.trim(),
        });
    `);

    assert.equal(tops.sub, "", "nothing under the title while it loads");
    assert.equal(tops.loading, tops.loaded, "the title does not move");
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
    await openFiles();
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
    await openFiles();
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
        await openFiles();
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
    // Another session opens with no tap (as a reply's link or the server opens one), and the person taps the menu at once.
    await goTo(second);
    await page.click({ selector: '.topbar [aria-label="Menu"]' });
    await reach({ path: `/s/${second}`, sheet: "menu", layers: 1 }, "the menu, from the tap");
    await back();
    await reach({ sheet: null, layers: 0 }, "closed");
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
    await openFiles();
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

// Issue #63: a short update written a line at a time, as Pi's terminal shows it, not run together into one paragraph.
test(
    "a reply keeps its single line breaks; a Markdown file's hard-wrapped lines stay one paragraph",
    real,
    async () => {
        const updates = await newSession(app);
        // Outside the session's repository: a file there would be one more change for the tests after this one.
        const wrapped = join(root, "wrapped.md");

        await say(
            app,
            updates,
            [
                "✅ Checks pass.",
                "📌 [The guide](docs/guide.md) · `src/main.ts`",
                "👉 Approve it?",
                "",
                "A paragraph of its own.",
            ].join("\n"),
        );
        writeFileSync(
            wrapped,
            "# Wrapped\n\nA paragraph wrapped\nat a narrow column,\nas files often are.\n\nAnother.\n",
        );
        await fresh();
        await goTo(updates);
        await reach({ path: `/s/${updates}` }, "the reply");
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".reply .md")?.textContent.includes("of its own") === true)`,
                )) === true,
            "the reply, rendered",
        );
        const paragraphs = (selector: string) =>
            inPage<string[]>(`
                return JSON.stringify(
                    [...document.querySelectorAll(${JSON.stringify(selector)})].map((p) => p.innerText),
                );
            `);
        const reply = await paragraphs(".reply .md p");

        assert.equal(reply.length, 2, `two paragraphs: ${JSON.stringify(reply)}`);
        assert.match(
            reply[0]!,
            /✅ Checks pass\.\n📌 The guide · src\/main\.ts\n👉 Approve it\?$/,
            "each line on its own line",
        );
        assert.equal(reply[1], "A paragraph of its own.");
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelectorAll('.reply .md a[data-path="docs/guide.md"], .reply .md code[data-path="src/main.ts"]').length)`,
            ),
            2,
            "the link and the path on those lines still open files",
        );

        await page.evaluate(`(await import("/ui.js")).openFile(${JSON.stringify(wrapped)})`);
        await reach({ sheet: "file", layers: 1 }, "the Markdown file");
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".file-viewer .md p") !== null)`,
                )) === true,
            "the file, rendered",
        );
        assert.deepEqual(await paragraphs(".file-viewer .md p"), [
            "A paragraph wrapped at a narrow column, as files often are.",
            "Another.",
        ]);
        await back();
        await reach({ sheet: null, layers: 0 }, "back to the reply");
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
    // Measured where it rests, past the conversation's slide in, with something to send (an empty box's Send takes no
    // taps: they go to the text).
    await slid();
    const draft = (text: string) =>
        page.evaluate(`
            const box = document.querySelector(".composer textarea");

            box.value = ${JSON.stringify(text)};
            box.dispatchEvent(new Event("input", { bubbles: true }));
        `);

    await draft("x");

    for (const selector of [
        ".topbar-back",
        ".topbar button.title-branch",
        ".changes-button",
        '.topbar [aria-label="Menu"]',
        ".composer-row .places-button",
        ".composer-row .attach-button",
        ".composer-row .model-chip",
        ".composer-row .send-button",
        ".code-head .copy",
        ".answer-actions > button",
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
    await draft("");

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
    "the message box starts one line tall, on a phone and a desktop, and grows with its text",
    real,
    async () => {
        await fresh();
        await goTo(first);
        await slid();
        // How many lines tall the box is: its height less its padding, in its own line height.
        const lines = (text: string) =>
            inPage<number>(`
            const box = document.querySelector(".composer textarea");

            box.value = ${JSON.stringify(text)};
            box.dispatchEvent(new Event("input", { bubbles: true }));
            // The box fits its text once the app has drawn it.
            await new Promise((resolve) => setTimeout(resolve, 100));
            const style = getComputedStyle(box);
            const inside = box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);

            return JSON.stringify(Math.round(inside / parseFloat(style.lineHeight)));
        `);

        try {
            for (const viewport of [
                VIEWPORTS.mobile,
                { width: 1440, height: 900, scale: 1, mobile: false },
            ]) {
                const at = `${viewport.width}px wide`;

                await page.setViewport(viewport);
                assert.equal(await lines(""), 1, `empty, one line, ${at}`);
                assert.equal(await lines("one"), 1, `one line of text, one line, ${at}`);
                assert.equal(
                    await lines("one\ntwo\nthree"),
                    3,
                    `three lines of text, three, ${at}`,
                );
                assert.equal(await lines(""), 1, `emptied, one line again, ${at}`);
            }
        } finally {
            await page.setViewport(VIEWPORTS.mobile);
        }
    },
);

test(
    "on a phone, Files' bar is out of reach under a file, and a diff's header keeps the name readable",
    real,
    async () => {
        await fresh();
        await tap(row(first));
        await openFiles();
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

/** PiP closed and forgotten in this tab, so the tests after start without it. */
async function noPip(): Promise<void> {
    await page.evaluate(`
        (await import("/pip.js")).closePip();
        sessionStorage.removeItem("pocket.pip");
        localStorage.removeItem("pocket.pip.draft");
    `);
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".pip-panel") === null)`,
            )) === true,
        "PiP's panel, gone",
    );
}

test(
    "on a desktop, Alt+A opens PiP once, for the keys typed next, below the top bar; Esc gives the focus back",
    real,
    async () => {
        await fresh();
        await page.setViewport(VIEWPORTS.desktop);
        await tap(`.sidebar .session-row[data-id="${first}"] .session`);
        await reach({ path: `/s/${first}` }, "the session");
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
                )) === true,
            "the session's message box",
        );
        await page.evaluate(`
            localStorage.removeItem("pocket.pip.draft");
            window.pipOpens = 0;
            const fetched = window.fetch;
            window.fetch = (url, init) => {
                if (String(url) === "/api/pip" && JSON.parse(init.body).on === true) {
                    window.pipOpens++;
                }

                return fetched(url, init);
            };
            document.querySelector(".composer textarea").focus();
        `);

        // The words right after the shortcut, before anything had time to draw.
        await page.input([
            { type: "key", key: "a", modifiers: 1 },
            { type: "text", text: "hi pip" },
        ]);
        const typed = () =>
            inPage<{ pip: string | null; session: string | null; focused: string | null }>(`
                return JSON.stringify({
                    pip: document.querySelector(".pip-composer textarea")?.value ?? null,
                    session: document.querySelector(".composer textarea")?.value ?? null,
                    focused: document.activeElement?.closest(".pip-composer") ? "pip"
                        : document.activeElement?.closest(".composer") ? "session" : null,
                });
            `);

        assert.deepEqual(await typed(), { pip: "hi pip", session: "", focused: "pip" });
        // Past its opening animation, where it takes its whole size.
        await new Promise((resolve) => setTimeout(resolve, 400));
        // What the top bar says of its edge is where it is, once the pane has popped in.
        assert.equal(
            await inPage<number>(`
                const said = parseFloat(document.documentElement.style.getPropertyValue("--topbar-h"));
                const top = document.querySelector(".topbar").getBoundingClientRect().bottom;

                return JSON.stringify(Math.round(said) - Math.round(top));
            `),
            0,
            "--topbar-h matches the top bar's real edge",
        );

        // The top bar's buttons are not under PiP's window: the menu, Changes.
        const covered = await inPage<string[]>(`
            const buttons = [...document.querySelectorAll(".topbar button")];

            return JSON.stringify(
                buttons
                    .filter((button) => {
                        const box = button.getBoundingClientRect();
                        const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);

                        return box.width > 0 && at?.closest(".pip-panel") !== null;
                    })
                    .map((button) => button.getAttribute("aria-label") ?? button.className),
            );
        `);

        assert.ok(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.topbar [aria-label="Menu"]') !== null && document.querySelector(".topbar .changes-button") !== null)`,
            ),
            "the top bar shows the menu and Changes",
        );
        assert.deepEqual(covered, [], "no top bar button is under PiP's window");
        assert.equal(await inPage<number>(`return JSON.stringify(window.pipOpens)`), 1);

        await page.press("Escape");
        await until(
            async () => (await typed()).focused === "session",
            "the focus back in the session's box",
        );
        await noPip();
    },
);

/** Where PiP's window is: its gaps to the screen's bottom and right edges, its top, and the top bar's bottom. */
type Place = {
    bottom: number;
    right: number;
    left: number;
    top: number;
    width: number;
    screen: number;
    topbar: number;
};

async function pipPlace(): Promise<Place> {
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".pip-panel:not(.leaving)") !== null)`,
            )) === true,
        "PiP's window",
    );
    // Past its opening animation, where it takes its whole size.
    await new Promise((resolve) => setTimeout(resolve, 450));

    return inPage<Place>(`
        const box = document.querySelector(".pip-panel").getBoundingClientRect();

        return JSON.stringify({
            bottom: Math.round(innerHeight - box.bottom),
            right: Math.round(innerWidth - box.right),
            left: Math.round(box.left),
            top: Math.round(box.top),
            width: Math.round(box.width),
            screen: innerWidth,
            topbar: Math.round(document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0),
        });
    `);
}

/** The session's message box holding `text`, as typing leaves it. */
const typeInBox = (text: string) =>
    page.evaluate(`
        const box = document.querySelector(".composer textarea");

        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ${JSON.stringify(text)});
        box.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 300));
    `);

test(
    "PiP's window stays in the bottom right corner at every size, however tall the message box grows; on a phone it is a sheet on the bottom edge",
    real,
    async () => {
        await fresh();
        await tap(row(first));
        await reach({ path: `/s/${first}` }, "the session");

        for (const [width, height] of [
            [1280, 800],
            [1920, 1080],
            [1024, 700],
            [844, 390],
        ] as const) {
            const size = `${width}x${height}`;

            await page.setViewport({ width, height, scale: 1, mobile: false });
            await until(
                async () =>
                    (await inPage<boolean>(
                        `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
                    )) === true,
                "the session's message box",
            );
            await page.evaluate(`(await import("/pip.js")).openPip()`);
            const place = await pipPlace();

            // Anchored: the same small gap to the bottom and the right edge, whatever the session shows.
            assert.equal(
                place.bottom,
                place.right,
                `${size}: as far from the bottom as from the right`,
            );
            assert.ok(
                place.bottom >= 0 && place.bottom <= 24,
                `${size}: on the bottom edge (${place.bottom}px up)`,
            );
            assert.ok(place.top >= place.topbar, `${size}: below the top bar`);
            // A message box that grows does not move it.
            await typeInBox("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");
            assert.deepEqual(
                await pipPlace(),
                place,
                `${size}: where it was with a tall message box`,
            );
            await typeInBox("");
            await noPip();
        }

        // Over the session list too: the same corner.
        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/`);
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(${JSON.stringify(row(first))}) !== null)`,
                )) === true,
            "the session list",
        );
        await page.evaluate(`(await import("/pip.js")).openPip()`);
        const home = await pipPlace();

        assert.equal(
            home.bottom,
            home.right,
            "the session list: as far from the bottom as from the right",
        );
        assert.ok(home.bottom <= 24, "the session list: on the bottom edge");
        await noPip();

        // On a phone: a sheet across the whole width, on the bottom edge.
        await fresh();
        await tap(row(first));
        await reach({ path: `/s/${first}` }, "the session");
        await page.evaluate(`(await import("/pip.js")).openPip()`);
        const phone = await pipPlace();

        assert.deepEqual(
            { bottom: phone.bottom, left: phone.left, width: phone.width },
            { bottom: 0, left: 0, width: phone.screen },
            "a phone's sheet",
        );
        await noPip();
    },
);

test(
    "PiP's header fits Compact, Start fresh, and how full its context is at every size; Compact summarizes it",
    real,
    async () => {
        const pip = await app.pip.ensure(owner(app));

        await app.commands.configure(pip, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
            thinkingLevel: "off",
        });
        await say(app, pip, "hello pip");
        await say(app, pip, "and again");

        for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile, VIEWPORTS.tablet]) {
            await fresh();
            await page.setViewport(viewport);
            await page.evaluate(`(await import("/pip.js")).openPip()`);
            await until(
                async () =>
                    (await inPage<boolean>(
                        `return JSON.stringify(document.querySelector(".pip-head .pip-context") !== null)`,
                    )) === true,
                "how full PiP's context is",
                20_000,
            );
            // Past its opening animation, where it takes its whole size.
            await new Promise((resolve) => setTimeout(resolve, 450));
            const head = await inPage<{
                fits: boolean;
                buttons: { label: string; width: number; height: number; inside: boolean }[];
                context: string;
                meter: boolean;
                overlaps: boolean;
            }>(`
                const head = document.querySelector(".pip-head");
                const box = head.getBoundingClientRect();
                const parts = [...head.querySelectorAll(".pip-context, .icon-button")].map((each) =>
                    each.getBoundingClientRect(),
                );

                return JSON.stringify({
                    fits: head.scrollWidth <= head.clientWidth,
                    buttons: [...head.querySelectorAll(".icon-button")].map((button) => {
                        const rect = button.getBoundingClientRect();

                        return {
                            label: button.getAttribute("aria-label"),
                            width: rect.width,
                            height: rect.height,
                            inside: rect.left >= box.left && rect.right <= box.right,
                        };
                    }),
                    context: head.querySelector(".pip-context").textContent.replace(/\\s+/g, ""),
                    meter: head.querySelector(".pip-context .meter > span") !== null,
                    overlaps: parts.some((one, index) =>
                        parts.slice(index + 1).some((two) => one.right > two.left + 0.5 && two.right > one.left + 0.5),
                    ),
                });
            `);
            const size = `${viewport.width}x${viewport.height}`;

            assert.equal(head.fits, true, `${size}: nothing runs past the header`);
            assert.equal(head.overlaps, false, `${size}: nothing over anything else`);
            assert.deepEqual(
                head.buttons.map((button) => button.label),
                ["Compact", "Start fresh", "Open as a conversation", "Close PiP"],
            );

            for (const button of head.buttons) {
                assert.ok(
                    button.width >= 40 && button.height >= 40 && button.inside,
                    `${size}: ${button.label} is a whole 40px target (${JSON.stringify(button)})`,
                );
            }

            assert.match(head.context, /^\d+%$/, `${size}: how full, as a share`);
            assert.ok(head.meter);
            await noPip();
        }

        // Compact, by hand: compaction keeps only the newest few messages as they are, so these two have one to summarize.
        const settings = app.settings.getCompactionSettings;

        app.settings.getCompactionSettings = () => ({
            enabled: true,
            reserveTokens: 16_384,
            keepRecentTokens: 10,
        });

        try {
            await fresh();
            await page.setViewport(VIEWPORTS.desktop);
            await page.evaluate(`(await import("/pip.js")).openPip()`);
            await tap('.pip-head [aria-label="Compact"]:not([disabled])');
            await until(
                async () =>
                    (await inPage<boolean>(`
                        return JSON.stringify([...document.querySelectorAll(".pip-body .pip-event")].some(
                            (event) => event.textContent.includes("Earlier messages summarized"),
                        ));
                    `)) === true,
                "the summary, in the panel",
            );
            await until(
                async () =>
                    (await inPage<boolean>(`
                        const { store } = await import("/store.js");

                        return JSON.stringify(store.state.notices.some((notice) => notice.message === "PiP's context compacted."));
                    `)) === true,
                "the notice that it is done",
            );
            // Estimated now, until PiP's next answer measures it.
            assert.match(
                await inPage<string>(
                    `return JSON.stringify(document.querySelector(".pip-head .pip-context").textContent.replace(/\\s+/g, ""))`,
                ),
                /^~\d+%$/,
            );
            await noPip();
        } finally {
            app.settings.getCompactionSettings = settings;
        }
    },
);

test(
    "on a phone, PiP dragged down closes, and the app behind it is not left dimmed",
    real,
    async () => {
        await fresh();
        await tap(row(first));
        await reach({ path: `/s/${first}` }, "the session");
        await page.evaluate(`(await import("/pip.js")).openPip()`);
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".pip-panel:not(.leaving)") !== null)`,
                )) === true,
            "PiP's sheet",
        );
        // Past its opening animation.
        await new Promise((resolve) => setTimeout(resolve, 400));
        await page.evaluate(`
        const head = document.querySelector(".pip-head");
        const panel = document.querySelector(".pip-panel");
        const from = head.getBoundingClientRect().top + 10;
        const to = panel.offsetHeight * 0.6;
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
            fire("touchmove", from + (to * step) / 10);
            await new Promise((resolve) => setTimeout(resolve, 30));
        }

        fire("touchend", from + to);
    `);
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".pip-panel") === null)`,
                )) === true,
            "PiP closed by the drag",
        );
        assert.deepEqual(
            await inPage<{ inline: string; shown: string }>(`
            const layout = document.querySelector(".layout");

            return JSON.stringify({ inline: layout.style.opacity, shown: getComputedStyle(layout).opacity });
        `),
            { inline: "", shown: "1" },
        );
        await noPip();
    },
);

test(
    "PiP's panel says when a call of PiP's waits for approval, and leads to it",
    real,
    async () => {
        await fresh();
        await page.setViewport(VIEWPORTS.desktop);
        await page.evaluate(`(await import("/pip.js")).openPip()`);
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".pip-panel .pip-loading") === null)`,
                )) === true,
            "PiP, awake",
            20_000,
        );
        // As the server sends it while the guard holds one of PiP's calls.
        const pip = await inPage<number>(`
        const { store } = await import("/store.js");

        store.set((state) => ({
            pipView: { ...state.pipView, approvals: [{ id: "a1", tool: "session_start", subject: "", reason: "" }] },
        }));

        return JSON.stringify(store.state.pip.id);
    `);

        await until(
            async () =>
                (
                    await inPage<string | null>(
                        `return JSON.stringify(document.querySelector(".pip-approval")?.textContent ?? null)`,
                    )
                )?.includes("waits for your approval: session_start") === true,
            "the line about the approval",
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".pip-status").textContent.trim())`,
            ),
            "needs you",
        );
        await tap(".pip-approval .button");
        await reach({ path: `/s/${pip}` }, "PiP's conversation, where the call can be allowed");
        await noPip();
    },
);

test(
    "/pip with words that cannot be sent leaves them in PiP's box, after its draft",
    real,
    async () => {
        await fresh();
        await page.setViewport(VIEWPORTS.desktop);
        await page.evaluate(`
        localStorage.setItem("pocket.pip.draft", "a draft");
        const fetched = window.fetch;
        window.fetch = (url, init) =>
            String(url).endsWith("/submit") ? Promise.reject(new TypeError("offline")) : fetched(url, init);
        (await import("/pip.js")).askPip("hello pip");
    `);
        await until(
            async () =>
                (await inPage<string | null>(
                    `return JSON.stringify(document.querySelector(".pip-composer textarea")?.value ?? null)`,
                )) === "a draft\n\nhello pip",
            "the words, back in PiP's box after the draft",
        );
        await noPip();
    },
);
