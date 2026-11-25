// Undo from a prompt's sheet, in a real Chromium against an isolated server.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    offerSubagents,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { SubagentsDoc } from "../src/server/docs.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
};
const sheet = '[data-sheet="message"]:not([data-state="closing"])';
/** The sheet's row whose label starts with `start`, by its first span. */
const rowStarting = (start: string) =>
    `[...document.querySelectorAll('${sheet} .list-item')].find((el) => el.firstElementChild?.textContent.trim().startsWith(${JSON.stringify(start)}))`;
const undoButton = `${sheet} .message-minors button[aria-label="Undo"]`;
const retryButton = `${sheet} .message-minors button[aria-label="Retry"]`;
const composer = ".composer textarea";

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base: string;

const inPage = async <T>(expression: string): Promise<T> =>
    JSON.parse(await page.evaluate(`return JSON.stringify(${expression});`)) as T;
const selector = (css: string) => `document.querySelector(${JSON.stringify(css)})`;
/** `css` is a selector, or an expression (a `[...` list lookup) that finds the element. */
const find = (css: string) => (css.startsWith("[...") ? css : selector(css));
const shown = (css: string) => inPage<boolean>(`Boolean(${find(css)})`);
/** A shown button's hint when it is greyed out, null when it can be pressed: undefined when it is not there. */
const greyed = (css: string) =>
    inPage<string | null | undefined>(
        `((button) => button === null ? undefined : button.disabled ? button.lastElementChild.textContent.trim() : null)(${find(css)})`,
    );
const click = (css: string) => inPage<null>(`(${find(css)}.click(), null)`);
const notice = (text: string) =>
    inPage<boolean>(
        `[...document.querySelectorAll('[data-part="notice"]')].some((el) => el.textContent.includes(${JSON.stringify(text)}))`,
    );

async function open(id: ConversationId) {
    await page.navigate(`${base}/s/${id}`);
    await until(() => shown(composer), "the message box");
}

async function openPrompt(text: string) {
    const prompt = `[data-part="prompt"]`;
    const match = `[...document.querySelectorAll('${prompt}')].find((el) => el.textContent.includes(${JSON.stringify(text)}))`;

    await until(() => inPage<boolean>(`Boolean(${match})`), `the prompt ${text}`);
    await inPage<null>(`(${match}.click(), null)`);
    await until(
        () =>
            inPage<boolean>(
                `Boolean(${selector(sheet)}?.textContent.includes(${JSON.stringify(text)}))`,
            ),
        "the prompt's sheet",
    );
}

/** Wait for a fresh session to open with the draft in its box. */
async function draftInNewSession(id: ConversationId, text: string): Promise<ConversationId> {
    await until(
        () =>
            inPage<boolean>(
                `location.pathname !== "/s/${id}" && ${selector(composer)}?.value === ${JSON.stringify(text)}`,
            ),
        `a new session with the draft ${text}`,
    );

    return (await inPage<number>(
        `Number(location.pathname.split("/").at(-1))`,
    )) as unknown as ConversationId;
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(
        scriptedModel((request) => {
            const { text } = lastText(request as never);

            if (text === "start a helper") {
                return fauxAssistantMessage(
                    [fauxToolCall("subagent", { action: "spawn", name: "helper", message: "hi" })],
                    { stopReason: "toolUse" },
                );
            }

            if (text === "fail this one") {
                return fauxAssistantMessage([], {
                    stopReason: "error",
                    errorMessage: "Scripted request failed.",
                });
            }

            return text === "wait for me"
                ? fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 15" })], {
                      stopReason: "toolUse",
                  })
                : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
        }),
    );
    offerSubagents(app);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "undo-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 420, height: 860, scale: 1, mobile: true });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    await app?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    cleanUp();
});

test(
    "Undo is only on the latest idle prompt, restores the draft, and can step back again",
    real,
    async () => {
        const id = await newSession(app);
        const user = owner(app);
        const path = join(app.workspace.uploadDirectory(id), "upload-notes.txt");

        writeFileSync(path, "the notes");
        await say(app, id, "first prompt");
        await say(app, id, "second prompt", [
            { path, name: "notes.txt", mime: "text/plain", size: 9 },
        ]);
        await open(id);
        await openPrompt("first prompt");
        assert.equal(await shown(undoButton), false);
        await click(`${sheet} button[aria-label="Close"]`);
        await openPrompt("second prompt");
        assert.equal(await shown(undoButton), true);
        assert.equal(
            await inPage<boolean>(
                `${selector(undoButton)}.nextElementSibling?.getAttribute("aria-label") === "Copy text"`,
            ),
            true,
        );
        await click(`${sheet} button[aria-label="Close"]`);

        const { submissionId } = await app.commands.submit(id, user, {
            text: "wait for me",
            requestId: "run until Stop",
        });

        await until(() => shown('.composer button[aria-label="Stop"]'), "Pi to be working");
        await openPrompt("wait for me");
        // While Pi works it stays in its place, greyed out, and says why.
        assert.equal(await greyed(undoButton), "Pi is working");
        await app.commands.abort(id, user);
        await (await app.harness.submission(submissionId, context))!.wait(context);
        await until(
            async () => (await greyed(undoButton)) === null,
            "Undo to come back once Pi stops",
        );
        await click(undoButton);
        const fork = await draftInNewSession(id, "wait for me");

        assert.equal(app.sessionMeta(id)?.archived, true);
        await until(
            () => notice("Undid your last message. The original is archived."),
            "the Undo notice",
        );
        await openPrompt("second prompt");
        assert.equal(await shown(undoButton), true);
        await click(undoButton);
        const next = await draftInNewSession(fork, "second prompt");

        assert.equal(app.sessionMeta(fork)?.archived, true);
        assert.equal(app.sessionMeta(next)?.title, app.sessionMeta(id)?.title);
        await until(
            () => shown('.composer button[aria-label="Remove notes.txt"]'),
            "the restored attachment chip",
        );
    },
);

test("Undo reads Retry when Pi's answer failed, and puts the message back", real, async () => {
    const id = await newSession(app);

    await say(app, id, "this one works");
    await say(app, id, "fail this one");
    await open(id);
    await until(
        () => inPage<boolean>(`document.body.textContent.includes("Scripted request failed.")`),
        "the failed answer",
    );
    await openPrompt("this one works");
    assert.equal(await shown(retryButton), false, "an older prompt has neither");
    assert.equal(await shown(undoButton), false);
    await click(`${sheet} button[aria-label="Close"]`);
    await openPrompt("fail this one");
    assert.equal(await shown(retryButton), true);
    assert.equal(await shown(undoButton), false);
    await click(retryButton);
    await draftInNewSession(id, "fail this one");

    assert.equal(app.sessionMeta(id)?.archived, true);
    await until(
        () => notice("Your message is back in the box to send again. The original is archived."),
        "the Retry notice",
    );
    // The fork ends with an answer that went through: its newest prompt reads Undo again.
    await openPrompt("this one works");
    assert.equal(await shown(undoButton), true);
    assert.equal(await shown(retryButton), false);
});

test("In a subagent, the last message's Retry shows greyed out and says why", real, async () => {
    const id = await newSession(app);

    await say(app, id, "start a helper");
    const helperOf = async () =>
        (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.helper?.conversationId;

    await until(async () => (await helperOf()) !== undefined, "the subagent");
    const helper = (await helperOf())!;

    await until(async () => !app.isBusy(helper) && !app.isBusy(id), "the subagent to finish");
    await say(app, helper, "fail this one");
    await open(helper);
    await until(
        () => inPage<boolean>(`document.body.textContent.includes("Scripted request failed.")`),
        "the failed answer",
    );
    await openPrompt("fail this one");
    assert.equal(await greyed(retryButton), "Not in a subagent");
    assert.equal(await shown(undoButton), false);
    // Pressing it does nothing: the subagent's conversation stays open, with no new session.
    await click(retryButton);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await inPage<string>("location.pathname"), `/s/${helper}`);
});

test("Send again still forks without archiving, beside Undo", real, async () => {
    const id = await newSession(app);

    await say(app, id, "send me again");
    await open(id);
    await openPrompt("send me again");
    assert.equal(await shown(undoButton), true);
    await click(rowStarting("With "));
    await until(
        () => inPage<boolean>(`location.pathname !== "/s/${id}"`),
        "the sent-again session",
    );

    assert.equal(app.sessionMeta(id)?.archived, undefined);
    await until(
        () => inPage<boolean>(`document.body.textContent.includes("echo: send me again")`),
        "the sent-again answer",
    );
});
