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
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
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
    app.approvals.request(
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
        async () => (await inPage<boolean>(`return JSON.stringify(${SWITCH} !== null)`)) === true,
        "the app, with the tiles switch",
        20_000,
    );
});

/** The top bar's switch for peek tiles. */
const SWITCH = `document.querySelector('.topbar [aria-label="Peek tiles"]')`;
const pressed = async () =>
    inPage<string | null>(`return JSON.stringify(${SWITCH}?.getAttribute("aria-pressed") ?? null)`);
const altP = () =>
    page.evaluate(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", code: "KeyP", altKey: true, bubbles: true }))`,
    );

test("the top bar's switch turns them on, and Alt+P off and on again", real, async () => {
    await page.evaluate(`${SWITCH}.click()`);
    assert.equal(await pressed(), "true");
    await until(
        async () => (await tiles()).length >= ids.working.length + 2,
        "the tiles to show",
        20_000,
    );
    await sameAsScreen("the tiles on screen, live");

    await altP();
    await until(async () => (await tiles()).length === 0, "the column to slide away");
    assert.equal(await pressed(), "false");
    await until(async () => (await serverPeeks())?.length === 0, "nothing live");
    await altP();
    await until(async () => (await tiles()).length >= ids.working.length + 2, "the tiles back");
    await sameAsScreen("the tiles live again");
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
