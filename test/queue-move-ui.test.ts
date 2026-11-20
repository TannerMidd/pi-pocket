import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, mock, test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false };
const box = ".composer textarea";
const card = ".inbox .queued";
const move = `${card} .queued-actions button:nth-child(2)`;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base: string;
const moves = new Map<string, number>();

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(
        scriptedModel((request) => {
            const { text } = lastText(request as never);

            return text === "Start Bash"
                ? fauxAssistantMessage(
                      [
                          fauxToolCall("bash", {
                              command:
                                  "touch bash-started; while [ ! -f release-bash ]; do sleep 0.1; done",
                              timeout: 30,
                          }),
                      ],
                      { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
        }),
    );
    const listen = { host: "127.0.0.1", port: 0 };
    const handler = createHandler({ app, listen, restart: () => {} });

    server = createServer((request, response) => {
        const path = request.url;

        if (request.method === "POST" && path?.endsWith("/move")) {
            response.once("finish", () => moves.set(path, response.statusCode));
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, listen.host, resolve));
    base = `http://${listen.host}:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "queue-move-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 808, height: 555, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

function textOf(selector: string): Promise<string> {
    return page.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? ""`,
    );
}

async function send(text: string): Promise<void> {
    await page.type({ selector: box }, text);
    await until(
        async () =>
            (await page.evaluate(
                `!!document.querySelector('.composer button[aria-label="Send"]:enabled')`,
            )) === "true",
        "the Send button to enable",
    );
    await page.press("Enter");
}

/** Send a Steer from the message box while a real Bash tool waits. The test decides when Bash finishes. */
async function startSteer(t: TestContext) {
    const cwd = mkdtempSync(join(work, "queue-"));
    const id = await newSession(app, cwd);
    const releaseBash = () => writeFileSync(join(cwd, "release-bash"), "");

    t.after(releaseBash);
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            (await page.evaluate(`!!document.querySelector(${JSON.stringify(box)})`)) === "true",
        "the message box",
    );
    await send("Start Bash");
    await until(() => existsSync(join(cwd, "bash-started")), "Bash to start");
    await until(async () => (await textOf(".scroller")).includes("bash"), "Bash in the browser");
    await send("Please wait for the answer");
    await until(
        async () => (await textOf(`${card} .queued-mode`)).startsWith("Steer"),
        "a Steer card",
    );
    assert.equal((await page.click({ selector: `${card} .queued-text` })).covered, undefined);
    await until(async () => (await textOf(move)) === "Move to queue", "the Move to queue button");

    return { id, releaseBash, path: `/api/c/${id}/move` };
}

/** Delay the tab's view events, not its HTTP requests or the queue changes on the server. */
function delayViews(t: TestContext, id: ConversationId): () => void {
    const client = [...app.clients].find((client) => client.conversationId === id);

    assert.ok(client, "the browser's event stream");
    const send = client.send.bind(client);
    const pending: (() => void)[] = [];
    const delayed = mock.method(client, "send", (event: string, data: unknown) => {
        if (event === "view") {
            pending.push(() => send(event, data));
        } else {
            send(event, data);
        }
    });
    let holding = true;

    const release = () => {
        if (!holding) {
            return;
        }

        holding = false;
        delayed.mock.restore();

        for (const deliver of pending) {
            deliver();
        }
    };

    t.after(release);

    return release;
}

const inbox = async (id: ConversationId) =>
    (await app.harness.snapshot(InboxDoc, id, context))?.items ?? [];

test(
    "a successful move to Queue shows on the card before the view update arrives",
    real,
    async (t) => {
        const { id, releaseBash, path } = await startSteer(t);
        const releaseViews = delayViews(t, id);

        assert.equal((await page.click({ selector: move })).covered, undefined);
        assert.equal(moves.get(path), 200);
        assert.equal((await inbox(id))[0]?.mode, "followUp");
        assert.equal(app.isBusy(id), true);
        await until(
            async () => (await textOf(`${card} .queued-mode`)).startsWith("Queue"),
            "the Queue label with view events still delayed",
            2500,
        );
        assert.equal(await textOf(move), "Steer now");
        releaseViews();
        releaseBash();
        await until(() => !app.isBusy(id), "Pi to finish both messages");
        await until(
            async () => (await textOf(".scroller")).includes("echo: Please wait for the answer"),
            "the queued message's answer",
        );
        assert.equal(await textOf(card), "");
    },
);

test("a move from a stale card says when the Steer has already gone to Pi", real, async (t) => {
    const { id, releaseBash, path } = await startSteer(t);
    const releaseViews = delayViews(t, id);

    releaseBash();
    await until(
        async () => (await inbox(id)).length === 0,
        "Pi to take the Steer at the tool boundary",
    );
    assert.equal((await page.click({ selector: move })).covered, undefined);
    assert.equal(moves.get(path), 409);
    await until(
        async () =>
            (await textOf(".notice.error .notice-text")) === "That message has already gone to Pi.",
        "the failed move's reason",
    );
    releaseViews();
    await until(async () => (await textOf(card)) === "", "the sent card to leave the queue");
    await until(() => !app.isBusy(id), "Pi to finish answering");
});
