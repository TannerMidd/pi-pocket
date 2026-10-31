import {
    type App,
    cleanUp,
    lastText,
    modelTexts,
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
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { BrowserError, Chromium } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** "risky please" calls a tool, which Lancet Guard asks about; everything else is echoed. */
const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    if (text === "ask me") {
        const options = [
            { label: "Postgres", description: "One server" },
            { label: "SQLite", description: "A file" },
        ];
        const questions = [{ header: "Database", question: "Which database?", options }];

        return fauxAssistantMessage([fauxToolCall("ask", { questions })], {
            stopReason: "toolUse",
        });
    }

    return text === "risky please"
        ? fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], {
              stopReason: "toolUse",
          })
        : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

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
    app = await openApp(scriptedModel(route));
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

/** How far the transcript is from its bottom, in pixels. */
const gap = () =>
    inPage<number>(`
        const scroller = document.querySelector(".pane > .scroller");

        return JSON.stringify(Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight));
    `);

/** Open the first session, with `count` rows of messages and answers, as the server would send them. */
async function openWithRows(count: number): Promise<void> {
    await fresh();
    await goTo(first);
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify((await import("/store.js")).store.state.view.conversation?.id === ${Number(first)})`,
            ),
        "the session's view",
    );
    await page.evaluate(`
        const { store } = await import("/store.js");
        const entries = Array.from({ length: ${count} }, (_, n) => ({ id: 920000 + n, kind: "assistant",
            stopReason: "stop", at: Date.now(),
            blocks: [{ type: "text", text: "Answer " + n + "\\n\\n" + "Words. ".repeat(40) }] }));

        store.set((state) => ({
            transcriptFrom: null,
            view: { ...state.view, entries: new Map(entries.map((entry) => [entry.id, entry])),
                order: entries.map((entry) => entry.id), live: { busy: false } },
        }));
        "shown";
    `);
}

test("the served SVG icon decodes as an image", real, async () => {
    const [width, height] = await inPage<[number, number]>(`
        const image = new Image();

        image.src = "/icon.svg";
        await image.decode();

        return JSON.stringify([image.naturalWidth, image.naturalHeight]);
    `);

    assert.ok(width > 0 && height > 0, "the icon has image dimensions");
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

test("completed replies show stored message times across providers", real, async () => {
    await fresh();
    await goTo(first);
    await until(
        () =>
            inPage<boolean>(`
                return JSON.stringify((await import("/store.js")).store.state.view.conversation?.id === ${first});
            `),
        "the session view",
    );
    const expected = await inPage<{ text: string; dateTime: string; title: string }[]>(`
        const { store } = await import("/store.js");
        const { fromServer } = await import("/seen.js");
        const today = new Date().setHours(10, 30, 0, 0);
        const earlier = new Date(2020, 0, 2, 10, 30).getTime();
        const entries = [
            { id: 900101, kind: "assistant", provider: "anthropic", stopReason: "stop", at: today,
                blocks: [{ type: "text", text: "Today's answer." }] },
            { id: 900102, kind: "assistant", provider: "openai", stopReason: "stop", at: earlier,
                blocks: [{ type: "text", text: "An older answer." }] },
            { id: 900103, kind: "assistant", provider: "google", stopReason: "stop",
                blocks: [{ type: "text", text: "An answer without a timestamp." }] },
            { id: 900104, kind: "assistant", provider: "anthropic", stopReason: "toolUse", at: today,
                blocks: [{ type: "text", text: "An intermediate step." }] },
            { id: 900105, kind: "assistant", provider: "custom", stopReason: "stop", at: today,
                blocks: [
                    { type: "text", text: "Before thinking." },
                    { type: "thinking", text: "Thinking." },
                    { type: "text", text: "After thinking." },
                ] },
        ];

        store.set({ view: { ...store.state.view,
            entries: new Map(entries.map(entry => [entry.id, entry])),
            order: entries.map(entry => entry.id),
        } });

        return JSON.stringify([today, earlier, today].map((at, index) => {
            const date = new Date(fromServer(at));
            const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

            return {
                text: index === 1
                    ? date.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time
                    : time,
                dateTime: date.toISOString(),
                title: date.toLocaleString(),
            };
        }));
    `);

    for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
        await page.setViewport(viewport);
        await until(
            () =>
                inPage<boolean>(`
                    return JSON.stringify(document.querySelectorAll(".reply").length === 6);
                `),
            "completed and intermediate replies rendered",
        );
        const shown = await inPage<typeof expected>(`
            return JSON.stringify([...document.querySelectorAll(".reply time")].map(time => ({
                text: time.textContent,
                dateTime: time.dateTime,
                title: time.title,
            })));
        `);

        assert.deepEqual(shown, expected, "one timestamp per completed answer with a stored time");
        assert.equal(
            await inPage<boolean>(`
                return JSON.stringify([...document.querySelectorAll(".reply time")].every(time => {
                    const bounds = time.getBoundingClientRect();

                    return bounds.width > 0 && bounds.right <= innerWidth && getComputedStyle(time).opacity === "1";
                }));
            `),
            true,
            "timestamps remain visible without hovering and fit the viewport",
        );
    }

    await page.evaluate(`(await import("/store.js")).openSheet({ type: "appearance" })`);
    await until(
        () =>
            inPage<boolean>(`
                return JSON.stringify(document.querySelector('.slot-layout[data-slot="reply"]') !== null);
            `),
        "reply layout controls",
    );

    try {
        assert.equal(
            await inPage<boolean>(`
                return JSON.stringify(document.querySelector('[aria-label="Show Message time"]') !== null);
            `),
            true,
            "message time is a configurable reply-slot item",
        );
        await tap('[aria-label="Show Message time"]');
        await until(
            () =>
                inPage<boolean>(`
                    return JSON.stringify(document.querySelectorAll(".reply time").length === 0);
                `),
            "message times hidden without hiding the reply actions",
        );
        assert.equal(
            await inPage<boolean>(`
                return JSON.stringify(document.querySelector(".reply .reaction-host") !== null);
            `),
            true,
        );
        await tap('[aria-label="Show Message time"]');
        await until(
            () =>
                inPage<boolean>(`
                    return JSON.stringify(document.querySelectorAll(".reply time").length === 3);
                `),
            "message times restored",
        );
        await tap('[aria-label="Move Message time later"]');
        await until(
            () =>
                inPage<boolean>(`
                    const actions = document.querySelector(".answer-actions");

                    return JSON.stringify(actions.firstElementChild.matches(".reaction-host") &&
                        actions.children[1].tagName === "TIME" &&
                        actions.lastElementChild.textContent.trim() === "More");
                `),
            "message time moved after React, with More still last",
        );
    } finally {
        await page.evaluate(`
            (await import("/slots.js")).resetSlot("reply");
            (await import("/store.js")).closeSheet();
        `);
    }
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

test("a long open group draws its newest steps, and shows the rest when asked", real, async () => {
    await fresh();
    await goTo(first);
    await until(
        async () =>
            await inPage<boolean>(`
                return JSON.stringify((await import("/store.js")).store.state.view.conversation?.id === ${first});
            `),
        "the session view",
    );
    // A person's message, then a run of Pi's alone: 30 answers that each call a tool, and a result for each.
    await page.evaluate(`
        const { store } = await import("/store.js");
        const entries = [{ id: 910000, kind: "user", text: "go", images: 0, at: Date.now() }];

        for (let n = 1; n <= 30; n++) {
            entries.push({ id: 910000 + n * 2, kind: "assistant", stopReason: "toolUse", at: Date.now(),
                blocks: [{ type: "toolCall", id: "call" + n, name: "bash", args: { command: "echo " + n } }] });
            entries.push({ id: 910001 + n * 2, kind: "toolResult", callId: "call" + n, text: String(n), at: Date.now() });
        }

        store.set({ view: { ...store.state.view,
            entries: new Map(entries.map((entry) => [entry.id, entry])),
            order: entries.map((entry) => entry.id),
        } });
    `);
    const timeline = () =>
        inPage<{ steps: number; earlier: string | null }>(`
            const timeline = document.querySelector(".transcript .activity.open .timeline");

            return JSON.stringify({
                steps: timeline?.querySelectorAll(":scope > :not(.timeline-earlier)").length ?? 0,
                earlier: timeline?.querySelector(".timeline-earlier")?.textContent.trim() ?? null,
            });
        `);

    await until(async () => (await timeline()).steps > 0, "the open group");
    assert.deepEqual(await timeline(), { steps: 24, earlier: "Show 6 earlier steps" });
    await tap(".transcript .timeline-earlier");
    await until(async () => (await timeline()).steps === 30, "all 30 steps");
    assert.equal((await timeline()).earlier, null);
});

test("Keep activity folded opens and folds groups already on screen", real, async () => {
    await fresh();
    await goTo(first);
    await until(
        async () =>
            await inPage<boolean>(`
                return JSON.stringify((await import("/store.js")).store.state.view.conversation?.id === ${first});
            `),
        "the session view",
    );
    // The newest turn: a person's message, then one call of Pi's and its result.
    await page.evaluate(`
        const { store } = await import("/store.js");
        const entries = [
            { id: 920000, kind: "user", text: "go", images: 0, at: Date.now() },
            { id: 920001, kind: "assistant", stopReason: "toolUse", at: Date.now(),
                blocks: [{ type: "toolCall", id: "fold1", name: "bash", args: { command: "echo 1" } }] },
            { id: 920002, kind: "toolResult", callId: "fold1", text: "1", at: Date.now() },
        ];

        store.set({ view: { ...store.state.view,
            entries: new Map(entries.map((entry) => [entry.id, entry])),
            order: entries.map((entry) => entry.id),
        } });
    `);
    const groupOpen = () =>
        inPage<boolean | null>(`
            const group = document.querySelector(".transcript .activity");

            return JSON.stringify(group === null ? null : group.classList.contains("open"));
        `);
    const fold = (on: boolean) =>
        page.evaluate(`(async () => {
            (await import("/theme.js")).setPrefs({ foldActivity: ${on} });
        })()`);

    await until(async () => (await groupOpen()) === true, "the group, open by default");

    try {
        // Without a redraw, the group keeps the state it was drawn with until a reload.
        await fold(true);
        await until(
            async () => (await groupOpen()) === false,
            "the group folds with the switch on",
        );
        await fold(false);
        await until(
            async () => (await groupOpen()) === true,
            "the group opens with the switch off",
        );
    } finally {
        await fold(false);
    }
});

test("an open activity group draws a thought step", real, async () => {
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
        const { store } = await import("/store.js");
        const blocks = [{ type: "thinking", text: "Hmm." },
            { type: "toolCall", id: "think1", name: "bash", args: { command: "echo 1" } }];
        const entries = [{ id: 930000, kind: "user", text: "go", images: 0, at: Date.now() },
            { id: 930001, kind: "assistant", stopReason: "toolUse", at: Date.now(), blocks },
            { id: 930002, kind: "toolResult", callId: "think1", text: "1", at: Date.now() }];

        store.set({ view: { ...store.state.view,
            entries: new Map(entries.map((entry) => [entry.id, entry])),
            order: entries.map((entry) => entry.id),
        } });
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(!!document.querySelector('.activity.open [data-part="thinking"]'))`,
            ),
        "the thought step in the open group",
    );
});

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
        // Awaited: a promise the script leaves behind can be collected before it settles, which fails the call.
        await (await import("/pip.js")).askPip("hello pip");
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

test(
    "a streamed update draws only the answer's last block, and not the session list",
    real,
    async () => {
        await fresh();
        // Wide, where the sidebar's list shows beside the session: a phone in a session draws no list at all.
        await page.setViewport(VIEWPORTS.desktop);
        await goTo(first);
        await reach({ path: `/s/${first}` }, "the session");
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify((await import("/store.js")).store.state.view.conversation?.id === ${Number(first)})`,
                )) === true,
            "its view",
        );
        const drawn = await inPage<{
            kept: boolean;
            text: string;
            quiet: number;
            same: number;
            listed: string[];
            image: string | null;
        }>(`
        const { h, options, render } = await import("preact");
        const { Markdown } = await import("/ui.js");
        const { store } = await import("/store.js");
        const settle = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
        const box = document.createElement("div");

        render(h(Markdown, { text: "First block.\\n\\n![x](a.png)\\n\\nSecond", cache: false }), box);
        const first = box.querySelector("p");

        render(h(Markdown, { text: "First block.\\n\\n![x](a.png)\\n\\nSecond, longer", cache: false }), box);
        let rows = [];
        const diffed = options.diffed;

        let quiet;
        let same;

        options.diffed = (vnode) => {
            if (vnode.type?.name === "SessionRow") {
                rows.push(vnode.props.session.title ?? "");
            }

            diffed?.(vnode);
        };

        try {
            store.set((state) => ({ view: { ...state.view } }));
            await settle();
            quiet = rows.length;
            // The same sessions in a new list: no row has anything new to show.
            store.set((state) => ({ sessions: [...state.sessions] }));
            await settle();
            same = rows.length - quiet;
            rows = [];
            // One session renamed: its row, and no other.
            store.set((state) => ({
                sessions: state.sessions.map((session) =>
                    session.id === ${Number(first)} ? { ...session, title: "Renamed here" } : session,
                ),
            }));
            await settle();
        } finally {
            options.diffed = diffed;
        }

        return JSON.stringify({ kept: box.querySelector("p") === first, text: box.textContent, quiet, same, listed: rows, image: box.querySelector("img")?.getAttribute("src") ?? null });
    `);

        assert.ok(drawn.kept, "the first block stays as it was drawn");
        assert.match(drawn.text, /Second, longer/, "the last block grows");
        assert.match(drawn.image ?? "", /^\/api\//, "an image path points at the server");
        assert.equal(drawn.quiet, 0, "a new view leaves the session list alone");
        assert.equal(drawn.same, 0, "the same sessions again draw no row");
        assert.deepEqual(drawn.listed, ["Renamed here"], "a changed session draws its row alone");
    },
);

test("a reconnect that brings the same data keeps it, and draws no session row", real, async () => {
    await fresh();

    const after = await inPage<{ same: string[]; rows: number }>(`
        const { options } = await import("preact");
        const { connect, store } = await import("/store.js");
        const settle = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
        const { browserModuleState } = await import("/extension-ui.js");
        // Extensions' browser modules load after the list shows, and each one that finishes draws every row again
        // (extensionsRev). A module goes on after that too: the Updates module asks the server for its status and
        // updates its menu entry whenever the answer comes, which under load is any time. That is theirs, not the
        // reconnect's, so the count below ignores a draw whose only new prop is extensionsRev.
        const loading = () => store.state.server.ui.some((each) => {
            const status = browserModuleState(each.module)?.status;

            return status !== "ready" && status !== "failed";
        });

        while (loading()) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        await settle();
        await settle();

        // Every row's props as they are now: draw them all once with a new extensionsRev, and keep what each row got.
        const baseline = new Map();
        const early = options.diffed;

        options.diffed = (vnode) => {
            if (vnode.type?.name === "SessionRow") {
                baseline.set(vnode.props.session.id, { ...vnode.props });
            }

            early?.(vnode);
        };
        store.set((state) => ({ extensionsRev: state.extensionsRev + 1 }));
        await settle();
        await settle();
        options.diffed = early;

        if (baseline.size === 0) {
            throw new Error("no session row drew for the baseline");
        }

        const keys = ["me", "models", "guard", "server", "themeList", "folderFavorites", "sessions"];
        const before = Object.fromEntries(keys.map((key) => [key, store.state[key]]));
        const stream = store.state.streamId;
        const Source = window.EventSource;
        let rows = 0;
        let received;
        const listed = new Promise((resolve) => (received = resolve));
        const diffed = options.diffed;

        options.diffed = (vnode) => {
            if (vnode.type?.name === "SessionRow") {
                const was = baseline.get(vnode.props.session.id);
                const props = Object.keys(vnode.props);

                // A draw counts unless extensionsRev is new and every other prop is the one it had.
                rows +=
                    was !== undefined &&
                    vnode.props.extensionsRev !== was.extensionsRev &&
                    props.every((key) => key === "extensionsRev" || vnode.props[key] === was[key])
                        ? 0
                        : 1;
            }

            diffed?.(vnode);
        };
        // The reconnect's own list must arrive before identity and draws are checked.
        window.EventSource = class extends Source {
            constructor(url) {
                super(url);
                this.addEventListener("sessions", received, { once: true });
            }
        };

        try {
            connect();
            await listed;
            await settle();
        } finally {
            window.EventSource = Source;
            options.diffed = diffed;
        }

        if (store.state.streamId === stream) {
            throw new Error("the reconnect did not receive a new stream");
        }

        return JSON.stringify({ same: keys.filter((key) => store.state[key] !== before[key]), rows });
    `);

    assert.deepEqual(after.same, [], "every equal value keeps its identity");
    assert.equal(after.rows, 0, "no session row draws again");
});

test("back to the list slides it in whole, and its rows do not rise in again", real, async () => {
    await fresh();
    await tap(row(first));
    await reach({ path: `/s/${first}` }, "the session");
    await page.evaluate(`
        window.listRoutes = [];
        window.listRouteObserver = new MutationObserver((records) => {
            window.listRoutes.push(...records.flatMap((record) =>
                [record.target.dataset.route, record.oldValue]));
        });
        window.listRouteObserver.observe(document.documentElement, {
            attributes: true, subtree: true, attributeFilter: ["data-route"], attributeOldValue: true,
        });
    `);
    await back();
    await reach({ path: "/" }, "back to the list");

    const shown = await inPage<{ rows: number; animating: number; slide: boolean }>(`
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const rows = [...document.querySelectorAll(".home-list .session-row")];

        window.listRouteObserver.disconnect();

        return JSON.stringify({
            rows: rows.length,
            animating: rows.filter((each) => each.classList.contains("arriving") || each.getAnimations().length).length,
            slide: window.listRoutes.includes("back"),
        });
    `);

    assert.ok(shown.rows > 0, "the list shows its rows");
    assert.equal(shown.animating, 0, "no row rises in again");
    assert.ok(shown.slide, "the list slides in from the left");
});

test(
    "the transcript stays at the bottom as an answer streams, and as a row grows",
    real,
    async () => {
        const frames = () => new Promise((resolve) => setTimeout(resolve, 300));

        await openWithRows(30);
        await until(async () => (await gap()) < 2, "the bottom, once the rows show");

        // Pi writes: the answer grows with no new entry, update after update.
        for (let n = 1; n <= 3; n++) {
            await page.evaluate(`
            const { store } = await import("/store.js");
            const text = "Streaming. ".repeat(${n * 60});

            store.set((state) => ({ view: { ...state.view, live: { busy: true,
                generation: { attempt: 0, message: { blocks: [{ type: "text", text }] } } } } }));
            "written";
        `);
            await frames();
            assert.ok((await gap()) < 2, `at the bottom after streamed update ${n}`);
        }

        // A row grows by itself, with no draw of the app (an image, a card that draws late).
        await page.evaluate(`
        const tall = document.createElement("div");

        tall.style.height = "400px";
        [...document.querySelectorAll(".transcript > *")].at(-1).append(tall);
    `);
        await frames();
        assert.ok((await gap()) < 2, "at the bottom after a row grew by itself");
    },
);

test("the sanitizer still takes out what is unsafe, every time", real, async () => {
    await openWithRows(2);

    const unsafe = [
        "<script>window.hit = 1</script>",
        '<img src="x" onerror="window.hit = 2">',
        '<a href=" JaVaScRiPt:window.hit = 3">a</a>',
        '<div data-part="approval" class="sheet" style="position:fixed" id="app">b</div>',
        "![shot](file:///tmp/shot.png)",
    ].join("\n\n");
    const drawn = await inPage<{ first: string; second: string }>(`
        const { h, render } = await import("preact");
        const { Markdown } = await import("/ui.js");
        const draw = () => {
            const box = document.createElement("div");

            render(h(Markdown, { text: ${JSON.stringify(unsafe)}, cache: false }), box);

            return box.innerHTML;
        };
        // Twice: the settings kept from the first draw give the same result.
        return JSON.stringify({ first: draw(), second: draw() });
    `);

    assert.equal(drawn.second, drawn.first, "the same result each time");

    for (const gone of ["<script", "onerror", "JaVaScRiPt", "data-part=", "position:fixed"]) {
        assert.ok(!drawn.first.includes(gone), `${gone} is taken out`);
    }

    assert.match(drawn.first, /<img[^>]+src="\/api\/c\/\d+\/file\?path=%2Ftmp%2Fshot\.png"/);
    assert.equal(await inPage<unknown>(`return JSON.stringify(window.hit ?? null)`), null);
});

// Issue #140: the circle that says how a call went keeps its own size while it waits for an approval.
test("a call's mark keeps its circle while it waits for an approval", real, async () => {
    // Lancet Guard is off by default; turn it on, asking about every call.
    await app.setExtensionEnabled(owner(app), "guard.ts", true);
    app.guard.judge = async (_tool, args) =>
        ({
            subject: String(args.command),
            decision: { action: "ask", reason: "risky", source: "test", terminate: false },
        }) as never;

    const one = await newSession(app);

    await fresh();
    await goTo(one);
    await app.commands.submit(one, owner(app), { text: "risky please", requestId: "mark-140" });

    const mark = () =>
        inPage<Record<string, string> | null>(`
            const mark = document.querySelector('[data-part~="tool-call"][data-state="waiting"] [data-part~="step-mark"]');
            const shape = mark && getComputedStyle(mark);

            return JSON.stringify(shape && { width: shape.width, height: shape.height,
                padding: shape.paddingTop, border: shape.borderTopWidth });
        `);

    await until(async () => (await mark()) !== null, "the call waiting", 20_000);
    assert.deepEqual(await mark(), {
        width: "19px",
        height: "19px",
        padding: "0px",
        border: "0px",
    });
});

test("Pi's question shows its answers as buttons a thumb can tap", real, async () => {
    // The test before fakes a guard that asks about every call.
    await app.setExtensionEnabled(owner(app), "guard.ts", false);
    const id = await newSession(app);
    const heights = `return JSON.stringify([...document.querySelectorAll("button.ask-option")].map((b) => b.offsetHeight))`;

    await fresh();
    await goTo(id);
    await app.commands.submit(id, owner(app), { text: "ask me", requestId: "ask-ui" });
    await until(async () => (await inPage<number[]>(heights)).length === 2, "the answers", 20_000);
    assert.ok((await inPage<number[]>(heights)).every((height) => height >= 44));
    await page.evaluate(`document.querySelectorAll("button.ask-option")[1].click()`);
    await page.evaluate(`document.querySelector(".approval.ask button[type=submit]").click()`);
    await until(
        async () => (await modelTexts(app, id)).join().includes("Database: SQLite"),
        "the answer",
    );
});

// Issue #131: a phone on its side with a notch. Another Chromium fakes the safe-area insets on its own page.
test(
    "with a notch, the rail, the top bar, and the message box clear it; with none, nothing moves",
    real,
    async (t) => {
        const WIDTH = 844;
        const NOTCH = 47;
        const chrome = await Chromium.launch(chromium!, mkdtempSync(join(root, "insets-")), []);

        t.after(() => chrome.kill());

        /** A signed-in page on its side with `inset` pixels at each side; `run` evaluates a function body in it. */
        async function visit(inset: number) {
            const { connection } = chrome;
            const { targetId } = await connection.send("Target.createTarget", {
                url: "about:blank",
            });
            const { sessionId } = await connection.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });
            const send = (method: string, params: Record<string, unknown> = {}) =>
                connection.send(method, params, sessionId);

            const run = async <T>(body: string): Promise<T> => {
                const answer = await send("Runtime.evaluate", {
                    expression: `(async () => { ${body} })().then((value) => JSON.stringify(value ?? null))`,
                    awaitPromise: true,
                    returnByValue: true,
                });

                return JSON.parse(answer.result.value as string) as T;
            };

            await send("Emulation.setDeviceMetricsOverride", {
                width: WIDTH,
                height: 390,
                deviceScaleFactor: 2,
                mobile: true,
            });
            await send("Emulation.setSafeAreaInsetsOverride", {
                insets: { top: 0, left: inset, bottom: 0, right: inset },
            });
            await send("Page.navigate", {
                url: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`,
            });
            await until(
                () =>
                    run<boolean>(`return !!document.querySelector(".home-list > .rail")`).catch(
                        () => false,
                    ),
                "the session list",
                20_000,
            );

            return run;
        }

        /** Where the visible elements that match `selector` start and end across the screen. */
        const edges = (run: Awaited<ReturnType<typeof visit>>, selector: string) =>
            run<{ left: number; right: number }[]>(`
            return [...document.querySelectorAll(${JSON.stringify(selector)})]
                .map((element) => element.getBoundingClientRect())
                .filter((box) => box.width > 0 && box.height > 0)
                .map((box) => ({ left: Math.round(box.left), right: Math.round(box.right) }));
        `);

        /** Open the session from the list, and wait for its bar, thread, and message box to rest. */
        const enter = async (run: Awaited<ReturnType<typeof visit>>) => {
            await run(`(await import("/store.js")).navigate(${Number(first)})`);
            await until(
                () =>
                    run<boolean>(`
                    return [".topbar", ".pane > .scroller", ".composer-wrap .composer"].every((each) => document.querySelector(each))
                        && document.getAnimations().every((each) => each.effect?.getComputedTiming().iterations === Infinity);
                `),
                "the conversation",
            );
        };

        try {
            const notched = await visit(NOTCH);

            /** Every element that matches is past the notch on both sides, and there is at least one. */
            const clear = async (selector: string) => {
                const found = await edges(notched, selector);

                assert.ok(found.length > 0, `${selector} shows`);
                assert.ok(
                    found.every((edge) => edge.left >= NOTCH && edge.right <= WIDTH - NOTCH),
                    `${selector} is in the notch: ${JSON.stringify(found)}`,
                );
            };

            await clear(".home-list > .rail button, .home-list > .rail .avatar");
            await enter(notched);
            await clear(".topbar button");
            await clear(".composer-wrap .composer");

            const plain = await visit(0);

            assert.deepEqual(await edges(plain, ".home-list > .rail"), [{ left: 0, right: 56 }]);
            await enter(plain);
            assert.deepEqual(
                await plain<string[]>(`
                const pad = (selector) => getComputedStyle(document.querySelector(selector)).paddingLeft;

                return [pad(".topbar"), pad(".pane > .scroller")];
            `),
                ["0px", "0px"],
            );
        } catch (error) {
            if (error instanceof BrowserError) {
                t.skip("this Chromium cannot fake safe-area insets");

                return;
            }

            throw error;
        }
    },
);

test(
    "Refresh in Changes reads the diffs on screen again, even when the file list is the same",
    real,
    async () => {
        await fresh();

        const requests = await inPage<{ before: number; after: number }>(`
        const { store } = await import("/store.js");
        const { DiffReview } = await import("/diff.js");
        const { h, render } = await import("preact");
        const box = document.createElement("div");
        const fetched = window.fetch;
        let diffs = 0;

        window.fetch = async (url, ...args) => {
            if (String(url).endsWith("/changes")) {
                return new Response(JSON.stringify({ repo: { root: "/tmp", head: "abc" }, more: 0, piOnly: [],
                    files: [{ path: "a.txt", kind: "modified", version: "5:1", added: 1, removed: 1 }] }));
            }

            if (String(url).includes("/changes/diff?")) {
                diffs++;

                return new Response("diff --git a/a.txt b/a.txt\\n--- a/a.txt\\n+++ b/a.txt\\n@@ -1 +1 @@\\n-old\\n+new\\n");
            }

            return fetched(url, ...args);
        };
        document.body.append(box);
        store.set({ conversationId: ${Number(first)} });
        render(h(DiffReview, { active: false }), box);
        store.subscribe(() => render(h(DiffReview, { active: false }), box));
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const before = diffs;

        box.querySelector('[aria-label="Refresh"]').click();
        await new Promise((resolve) => setTimeout(resolve, 700));
        window.fetch = fetched;

        return JSON.stringify({ before, after: diffs });
    `);

        assert.equal(requests.before, 1);
        assert.equal(requests.after, 2, "Refresh asks for the diff again");
    },
);
