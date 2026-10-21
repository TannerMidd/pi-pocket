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
import { mkdtempSync, writeFileSync } from "node:fs";
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

before(async () => {
    if (chromium === undefined) {
        return;
    }

    writeFileSync(join(work, "README.md"), "# Hello\n\nA file to read.\n");
    writeFileSync(join(work, "web.env"), "PORT=3000\nHOST=127.0.0.1\n");
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

test("local Markdown file links use the viewer", real, async () => {
    const linked = await newSession(app);

    await say(
        app,
        linked,
        [
            "[web.env](web.env)",
            "[Website](https://example.com/web.env)",
            "[Unsafe](javascript:alert%281%29)",
            '<a href="https://example.com" data-path="web.env">Forged</a>',
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
    assert.equal(links["web.env"]?.target, null, "local links stay in the app");

    for (const label of ["Website", "Unsafe", "Forged"]) {
        assert.equal(links[label]?.path, null, `${label} stays outside the file viewer`);
    }

    assert.equal(links.Unsafe?.href, null, "unsafe schemes are still stripped");
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
});

test(
    "on a phone, an invite lasts as long as chosen, and the one it replaces ends",
    real,
    async () => {
        const code = () =>
            inPage<string | null>(
                `return JSON.stringify(document.querySelector(".invite-code-value")?.textContent.replace(/\\s/g, "") ?? null)`,
            );
        const status = async (invite: string | null) =>
            (await fetch(`${base}/join/${invite}`)).status;

        await fresh();
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "invite" })`);
        await until(async () => (await code()) !== null, "the first invite");
        const first = await code();

        await page.evaluate(
            `[...document.querySelectorAll(".sheet .segmented button")].find((each) => each.textContent.trim() === "1 week").click()`,
        );
        await until(async () => ![null, first].includes(await code()), "the week's invite");
        const week = await code();

        assert.equal(await status(week), 200);
        await until(async () => (await status(first)) === 410, "the 15 minutes' invite, ended");

        await tap('.sheet label.check input[type="checkbox"]');
        await until(async () => ![null, week].includes(await code()), "the owner's invite");
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
    },
);

/** A compacted view can keep recent entries whose ids also occur before its summary. */
async function compactedView(): Promise<void> {
    await fresh();
    await goTo(first);
    await until(
        async () =>
            await inPage<boolean>(`
                return JSON.stringify((await import("/store.js")).store.state.view.conversation?.id === ${first});
            `),
        "the session view",
    );
    await page.evaluate(`
        const { store, actions } = await import("/store.js");
        const retained = { id: 900001, kind: "user", text: "retained message", images: 0, at: Date.now() };
        const summary = { id: 900002, kind: "compaction", summary: "Earlier messages" };

        window.earlierEntries = [retained];
        actions.history = async () => window.earlierEntries;
        store.set({ view: { ...store.state.view,
            entries: new Map([[summary.id, summary], [retained.id, retained]]),
            order: [summary.id, retained.id],
        } });
    `);
    await until(
        async () =>
            await inPage<boolean>(`
                return JSON.stringify([...document.querySelectorAll(".transcript button")]
                    .some(each => each.textContent === "Show earlier messages"));
            `),
        "earlier history available",
    );
}

test("earlier history does not repeat a message kept after compaction", real, async () => {
    await compactedView();
    await page.evaluate(`
        [...document.querySelectorAll(".transcript button")]
            .find(each => each.textContent === "Show earlier messages").click();
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".history") !== null)`,
            ),
        "earlier history shown",
    );
    assert.equal(
        await inPage<number>(
            `return JSON.stringify(document.querySelectorAll("#entry-900001").length)`,
        ),
        1,
    );
});

test("a late earlier-history response stays out of another conversation", real, async () => {
    const other = await newSession(app);

    await compactedView();
    await page.evaluate(`
        (await import("/store.js")).actions.history = () => new Promise(resolve => window.finishHistory = resolve);
        [...document.querySelectorAll(".transcript button")]
            .find(each => each.textContent === "Show earlier messages").click();
    `);
    await goTo(other);
    await reach({ path: `/s/${other}` }, "the other conversation");
    await page.evaluate(`
        window.finishHistory(window.earlierEntries);
        await new Promise(resolve => requestAnimationFrame(resolve));
    `);
    assert.equal(
        await inPage<unknown>(
            `return JSON.stringify((await import("/store.js")).store.state.history)`,
        ),
        null,
    );
});

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
