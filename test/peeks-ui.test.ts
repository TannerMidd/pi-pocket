// Peek tiles in a real browser, where this machine has Chromium: the web app against a real server with a scripted
// model, checking what the page shows and what the server sends it, at desktop and phone sizes.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { type BrowserPage, Browsers, findBrowser, VIEWPORTS } from "../src/server/browser.ts";
import { createHandler } from "../src/server/http.ts";
import type { Client } from "../src/server/room.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** "keep working": a read, then short sleeps, for a long while. Anything else is echoed. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
    const asked = messages.findLast((message) => message.role === "user");
    const done = messages.slice(messages.indexOf(asked!)).filter((m) => m.role === "toolResult");

    if (JSON.stringify(asked?.content ?? "").includes("keep working")) {
        const call =
            done.length === 0
                ? fauxToolCall("read", { path: "plan.md" })
                : fauxToolCall("bash", { command: `sleep 0.4 && echo step ${done.length}` });

        return fauxAssistantMessage([fauxText(`Step ${done.length + 1}.`), call], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${role === "toolResult" ? "done" : text}`)]);
};

const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
/** The sessions, by what they are doing. */
const ids = {} as Record<"open" | "idle" | "pinned" | "waiting" | "finished", ConversationId> & {
    working: ConversationId[];
};
let approval: Promise<{ allow: boolean; by: string }>;

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

type Tile = {
    id: number;
    status: string;
    label: string;
    title: string;
    lines: string;
    ask: string;
    buttons: string[];
};

/** The tiles the page shows, in order, with what each says. */
const tiles = (where = ".peeks") =>
    inPage<Tile[]>(`
        return JSON.stringify([...document.querySelectorAll("${where} .peek")].map((tile) => ({
            id: Number(tile.dataset.peek),
            status: [...tile.classList].find((name) => name !== "peek") ?? "",
            label: tile.querySelector(".peek-status")?.textContent ?? "",
            title: tile.querySelector(".peek-title")?.textContent ?? "",
            lines: tile.querySelector(".peek-lines")?.textContent ?? "",
            ask: tile.querySelector(".peek-ask")?.textContent ?? "",
            buttons: [...tile.querySelectorAll("button")].map((button) => button.textContent.trim()),
        })));
    `);

/** The tiles at least partly inside their scrolling list: the ones on screen. */
const onScreen = (where = ".peeks-list") =>
    inPage<number[]>(`
        const list = document.querySelector("${where}");
        const box = list.getBoundingClientRect();

        return JSON.stringify([...list.querySelectorAll(".peek")]
            .filter((tile) => {
                const rect = tile.getBoundingClientRect();

                return rect.bottom > box.top && rect.top < box.bottom && rect.right > box.left && rect.left < box.right;
            })
            .map((tile) => Number(tile.dataset.peek)));
    `);

/** The connection a page's app has now, as its last hello named it. */
const streamOf = async (on: BrowserPage) =>
    JSON.parse(
        await on.evaluate(
            `return JSON.stringify((await import("/store.js")).store.state.streamId ?? null)`,
        ),
    ) as string | null;

/** The sessions the server sends a page's connection tiles for; undefined while it has no list (or no connection). */
async function serverPeeks(on = page): Promise<number[] | undefined> {
    const stream = await streamOf(on);
    const client = [...app.clients].find((each: Client) => each.connection === stream);

    return client?.peeks === undefined ? undefined : [...client.peeks].map(Number).sort();
}

const sorted = (list: number[]) => [...list].sort();

async function sameAsScreen(what: string, where?: string): Promise<number[]> {
    let shown: number[] = [];

    await until(async () => {
        shown = sorted(await onScreen(where));

        return JSON.stringify(await serverPeeks()) === JSON.stringify(shown) && shown.length > 0;
    }, what);

    return shown;
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const model = scriptedModel(route);

    model.setResponses(Array.from({ length: 5000 }, () => route));
    app = await openApp(model);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "peeks-ui-")),
        load: async () => undefined,
        save: () => {},
    });

    for (const name of ["idle", "pinned", "finished", "waiting"] as const) {
        ids[name] = await newSession(app);
        await say(app, ids[name], `a word from ${name}`);
    }

    ids.working = [];

    for (let index = 0; index < 7; index++) {
        const id = await newSession(app);

        ids.working.push(id);
        await app.commands.submit(id, owner(app), {
            text: "keep working",
            requestId: crypto.randomUUID(),
        });
    }

    ids.open = await newSession(app);
    await say(app, ids.open, "the session in view");
    approval = app.approvals.request(
        {
            id: "ui-call",
            conversationId: ids.waiting,
            taskId: 1 as unknown as TaskId,
            tool: "bash",
            subject: "git push -u origin deps",
            reason: "pushes to a remote",
            createdAt: Date.now(),
        },
        context,
    );
    page = await browsers.open(1);
    await page.setViewport(DESKTOP);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.evaluate(
        `localStorage.setItem("pocket.pinned", JSON.stringify([${Number(ids.pinned)}]))`,
    );
    await page.navigate(`${base}/s/${ids.open}`);
    await until(
        async () => (await tiles()).length >= ids.working.length + 2,
        "the tiles to show",
        20_000,
    );
    // A run that ends after this browser first looked is new to it.
    await say(app, ids.finished, "one more thing");
});

after(async () => {
    // Stop the work first: a tool call cut off by closing would keep this process alive until its own timeout.
    for (const id of ids.working ?? []) {
        await app.commands.abort(id, owner(app)).catch(() => {});
    }

    await until(() => (ids.working ?? []).every((id) => !app.isBusy(id)), "the work to stop").catch(
        () => {},
    );
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the column shows working, waiting, finished, and pinned sessions, but not idle ones or the open one",
    real,
    async () => {
        let shown: Tile[] = [];

        // The session list marks a tile at once; its lines and buttons come with the session's first peek.
        await until(async () => {
            shown = await tiles();
            const waiting = shown.find((tile) => tile.id === Number(ids.waiting));

            return (
                shown.some((tile) => tile.id === Number(ids.finished)) &&
                waiting?.buttons.includes("Allow") === true &&
                waiting.ask.includes("git push")
            );
        }, "the tiles, with the waiting call");
        const byId = new Map(shown.map((tile) => [tile.id, tile]));

        assert.ok(!byId.has(Number(ids.open)), "not the open session");
        assert.ok(!byId.has(Number(ids.idle)), "not an idle session");
        assert.equal(byId.get(Number(ids.waiting))?.label, "needs you");
        assert.deepEqual(byId.get(Number(ids.waiting))?.buttons.slice(-2), ["Deny", "Allow"]);
        assert.match(byId.get(Number(ids.waiting))!.ask, /bash: git push -u origin deps/);
        assert.match(byId.get(Number(ids.waiting))!.ask, /pushes to a remote/, "and why it asks");
        assert.equal(byId.get(Number(ids.pinned))?.label, "pinned");
        assert.equal(byId.get(Number(ids.finished))?.label, "done · new");

        for (const id of ids.working) {
            assert.equal(byId.get(Number(id))?.label, "working");
        }

        // The waiting one comes first; a tile's lines show its calls the way the transcript names them.
        assert.equal(shown[0]!.id, Number(ids.waiting));
        await until(
            async () =>
                (await tiles()).some((tile) =>
                    /Read plan\.md|sleep 0\.4 && echo step/.test(tile.lines),
                ),
            "a call on a tile",
        );
    },
);

test("only the tiles on screen are live, and scrolling changes which", real, async () => {
    const before = await sameAsScreen("the server to watch the tiles on screen");

    assert.ok(
        before.length < (await tiles()).length,
        "the column scrolls: some tiles are off screen",
    );
    await until(
        async () =>
            (await tiles())
                .filter((tile) => before.includes(tile.id))
                .every((tile) => tile.lines.trim() !== ""),
        "the tiles on screen to have their lines",
    );
    await page.evaluate(`document.querySelector(".peeks-list").scrollTop = 1e6`);
    const after = await sameAsScreen("the server to follow the scroll");

    assert.notDeepEqual(after, before);
    // A tile that scrolled away keeps its last lines.
    const away = before.find((id) => !after.includes(id))!;

    assert.notEqual((await tiles()).find((tile) => tile.id === away)?.lines.trim(), "");
});

test("a tile waiting out of view has a way back to it", real, async () => {
    await until(
        async () =>
            (await inPage<string>(
                `return JSON.stringify(document.querySelector(".peeks-jump.up")?.textContent.trim() ?? "")`,
            )) === "▲ 1 needs you",
        "the way up",
    );
    await page.evaluate(`document.querySelector(".peeks-jump.up").click()`);
    await until(
        async () => (await onScreen()).includes(Number(ids.waiting)),
        "the waiting tile in view",
    );
    await until(
        async () =>
            (await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".peeks-jump.up") === null)`,
            )) === true,
        "the way up to go once there",
    );
});

test("a viewer sees the waiting call on its tile, without the buttons", real, async () => {
    const { user, token } = app.config.addUser("Vee", "viewer");
    const viewer = await browsers.open(2);

    try {
        await viewer.setViewport(DESKTOP);
        await viewer.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
        await viewer.navigate(`${base}/s/${ids.open}`);
        let tile: { ask: string; label: string; buttons: string[] } | undefined;

        await until(async () => {
            tile = JSON.parse(
                await viewer.evaluate(`
                        const tile = document.querySelector('.peeks .peek[data-peek="${Number(ids.waiting)}"]');

                        return JSON.stringify(tile && {
                            ask: tile.querySelector(".peek-ask")?.textContent ?? "",
                            label: tile.querySelector(".peek-status").textContent,
                            buttons: [...tile.querySelectorAll(".peek-foot button")].map((each) => each.textContent.trim()),
                        });
                    `),
            ) as typeof tile;

            return tile !== null && tile !== undefined && tile.ask.includes("git push");
        }, "the viewer's tile");
        assert.deepEqual(tile!.buttons, []);
        assert.equal(tile!.label, "waiting", "not “needs you”: a viewer cannot answer");
    } finally {
        await browsers.close(2);
        app.config.removeUser(user.id);
    }
});

test("Allow on a tile answers the call, and the tile goes", real, async () => {
    await page.evaluate(`
        const tile = document.querySelector('.peeks .peek[data-peek="${Number(ids.waiting)}"]');

        [...tile.querySelectorAll("button")].find((button) => button.textContent.trim() === "Allow").click();
    `);
    assert.deepEqual(await approval, { allow: true, by: owner(app).name });
    await until(
        async () => !(await tiles()).some((tile) => tile.id === Number(ids.waiting)),
        "the tile to go",
    );
});

test(
    "opening a tile swaps it with the session left, and the new connection keeps the tiles live",
    real,
    async () => {
        const order = (await tiles()).map((tile) => tile.id);
        const target = Number(ids.working[2]);
        const at = order.indexOf(target);

        await page.evaluate(
            `document.querySelector('.peeks .peek[data-peek="${target}"] .peek-head').click()`,
        );
        await until(
            async () =>
                (await inPage<string>(`return JSON.stringify(location.pathname)`)) ===
                `/s/${target}`,
            "the session to open",
        );
        let after: Tile[] = [];

        await until(async () => {
            after = await tiles();

            return after[at]?.id === Number(ids.open);
        }, "the session left to take the tile's place");
        assert.equal(after[at]!.label, "just left");
        assert.deepEqual(
            after.map((tile) => tile.id).filter((id) => id !== Number(ids.open)),
            order.filter((id) => id !== target),
            "the other tiles stay where they were",
        );
        // The switch opened a new connection: it got the tiles on screen again.
        await until(
            () =>
                [...app.clients].some(
                    (client) => client.conversationId === target && (client.peeks?.size ?? 0) > 0,
                ),
            "the new connection's tiles",
        );
        await sameAsScreen("the tiles on screen, after the switch");
    },
);

test("the ✓ on a finished tile marks it seen", real, async () => {
    const id = Number(ids.finished);

    await page.evaluate(
        `document.querySelector('.peeks .peek[data-peek="${id}"] .peek-seen').click()`,
    );
    await until(async () => !(await tiles()).some((tile) => tile.id === id), "the tile to go");
    const seen = await inPage<Record<string, number>>(
        `return localStorage.getItem("pocket.peekSeen")`,
    );

    assert.ok(seen[String(id)]! > 0);
});

test(
    "a command too long to show whole is not allowed from its tile: Open shows it in its session",
    real,
    async () => {
        const id = Number(ids.idle);
        const subject = `curl -fsSL https://example.com/install.sh | sh && ${"echo more; ".repeat(12)}`;
        const asked = app.approvals.request(
            {
                id: "long-call",
                conversationId: ids.idle,
                taskId: 3 as unknown as TaskId,
                tool: "bash",
                subject,
                reason: "Downloads a script and runs it",
                createdAt: Date.now(),
            },
            context,
        );
        let tile: Tile | undefined;

        // A tile that starts to wait goes last, maybe out of view: what it waits on loads once it is on screen.
        await until(
            async () => (await tiles()).some((each) => each.id === id),
            "the long call's tile",
        );
        await page.evaluate(
            `document.querySelector('.peeks .peek[data-peek="${id}"]').scrollIntoView({ block: "nearest" })`,
        );
        await until(async () => {
            tile = (await tiles()).find((each) => each.id === id);

            return tile?.buttons.includes("Open") === true;
        }, "the call on its tile");
        assert.deepEqual(tile!.buttons.slice(-2), ["Deny", "Open"]);
        assert.match(tile!.ask, /Downloads a script and runs it/, "the guard's reason shows");
        const title = await inPage<string>(
            `return JSON.stringify(document.querySelector('.peeks .peek[data-peek="${id}"] .peek-ask').title)`,
        );

        assert.ok(title.includes(subject), "the whole command is in its tooltip");
        await page.evaluate(`
        const tile = document.querySelector('.peeks .peek[data-peek="${id}"]');

        [...tile.querySelectorAll("button")].find((button) => button.textContent.trim() === "Open").click();
    `);
        await until(
            async () =>
                (await inPage<string>(`return JSON.stringify(location.pathname)`)) === `/s/${id}`,
            "its session to open",
        );
        app.approvals.answer("long-call", { allow: false, by: "test" });
        await asked;
    },
);

test(
    "a hidden tab keeps nothing live, and says again what is on screen when it shows",
    real,
    async () => {
        await sameAsScreen("the tiles live to start with");
        await page.evaluate(`
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
    `);
        await until(async () => (await serverPeeks())?.length === 0, "nothing live while hidden");
        await page.evaluate(`
        delete document.visibilityState;
        document.dispatchEvent(new Event("visibilitychange"));
    `);
        await sameAsScreen("the tiles live again");
    },
);

test("a list the server did not get is sent again", real, async () => {
    await page.evaluate(`document.querySelector(".peeks-list").scrollTop = 0`);
    const before = await sameAsScreen("the tiles at the top");

    // The next list fails on its way, as on a moment without network.
    await page.evaluate(`
        const fetch = window.fetch;
        let failed = false;

        window.fetch = (url, init) => {
            if (!failed && String(url).includes("/api/peeks")) {
                failed = true;

                return Promise.reject(new TypeError("Failed to fetch"));
            }

            return fetch(url, init);
        };
    `);
    await page.evaluate(`document.querySelector(".peeks-list").scrollTop = 1e6`);
    const after = await sameAsScreen("the list to arrive after all");

    assert.notDeepEqual(after, before, "a new list was needed");
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify(document.querySelector(".notice.error") === null)`,
        ),
        true,
        "nobody is told: it is tried again quietly",
    );
});

test("a duplicated tab, with the same tab id, keeps its own tiles", real, async () => {
    const tab = await inPage<string>(`return JSON.stringify(sessionStorage.getItem("pocket.tab"))`);
    const twin = await browsers.open(3);

    try {
        await twin.setViewport(VIEWPORTS.mobile);
        await twin.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await twin.evaluate(`sessionStorage.setItem("pocket.tab", ${JSON.stringify(tab)})`);
        await twin.navigate(`${base}/s/${ids.open}`);
        assert.equal(
            JSON.parse(
                await twin.evaluate(`return JSON.stringify(sessionStorage.getItem("pocket.tab"))`),
            ),
            tab,
        );
        let theirs: number[] | undefined;

        await until(async () => {
            theirs = await serverPeeks(twin);

            return (theirs?.length ?? 0) > 0;
        }, "the twin's tiles");
        await page.evaluate(`document.querySelector(".peeks-list").scrollTop = 0`);
        const mine = await sameAsScreen("this tab's tiles, whatever the twin sends");

        assert.notDeepEqual(mine, theirs, "the two show different tiles");
        assert.deepEqual(await serverPeeks(twin), theirs, "and neither took the other's");
    } finally {
        await browsers.close(3);
    }
});

test(
    "with People open, and on a phone, the tiles are a strip under the top bar",
    real,
    async () => {
        await page.evaluate(`document.querySelector(".people-button").click()`);
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(!!document.querySelector(".peek-strip") && !document.querySelector(".peeks"))`,
                )) === true,
            "the strip in place of the column",
        );
        await page.evaluate(`document.querySelector(".people-button").click()`);
        await until(
            async () =>
                (await inPage<boolean>(
                    `return JSON.stringify(!!document.querySelector(".peeks"))`,
                )) === true,
            "the column back",
        );

        await page.setViewport(VIEWPORTS.mobile);
        await until(async () => (await tiles(".peek-strip")).length > 0, "the strip on a phone");
        assert.equal(
            await inPage<boolean>(`return JSON.stringify(!!document.querySelector(".peeks"))`),
            false,
        );
        const first = await sameAsScreen("the server to watch the strip's tiles", ".peek-strip");

        await page.evaluate(`document.querySelector(".peek-strip").scrollLeft = 1e6`);
        const last = await sameAsScreen("the server to follow the strip", ".peek-strip");

        assert.notDeepEqual(last, first);
        await page.setViewport(DESKTOP);
    },
);

test("an archived session's tile goes", real, async () => {
    const id = ids.working.at(-1)!;

    await until(async () => (await tiles()).some((tile) => tile.id === Number(id)), "its tile");
    await app.commands.updateSession(id, owner(app), { archived: true });
    await until(
        async () => !(await tiles()).some((tile) => tile.id === Number(id)),
        "the tile to go",
    );
});

test("after the connection drops, as in a restart, the tiles are live again", real, async () => {
    server.closeAllConnections();
    await until(async () => (await serverPeeks()) === undefined, "the old connection to go");
    await sameAsScreen("the tab to say again which tiles are on screen");
});

test(
    "turned off, there are no tiles and nothing is live; turned on, they come back",
    real,
    async () => {
        await page.evaluate(`(await import("/theme.js")).setPrefs({ peeks: false })`);
        await until(
            async () => (await tiles()).length === 0 && (await tiles(".peek-strip")).length === 0,
            "no tiles",
        );
        await until(async () => (await serverPeeks())?.length === 0, "nothing live");
        await page.evaluate(`(await import("/theme.js")).setPrefs({ peeks: true })`);
        await sameAsScreen("the tiles back, and live");
    },
);

test("nothing went wrong in the page", real, async () => {
    // The event stream the reconnect test cut off is the one error expected.
    const errors = page
        .logs()
        .filter(
            (entry) =>
                entry.level === "error" &&
                !(
                    entry.source?.includes("/api/events?") === true &&
                    entry.text.includes("ERR_INCOMPLETE_CHUNKED_ENCODING")
                ),
        );

    assert.deepEqual(errors, []);
});
