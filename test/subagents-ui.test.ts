// The subagents bar in a real browser at phone size where this machine has Chromium: it says what works, Stop stops
// one, and a person's message that looks like a report stays theirs.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
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
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { SubagentsDoc } from "../src/server/docs.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/** "quick" answers at once; "slow" runs a long `sleep` first. The parent sleeps for `parentSleep` after starting them. */
let parentSleep = 0;

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text } = lastText(request as never);
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (subagent?.startsWith("slow") && role !== "toolResult") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], {
            stopReason: "toolUse",
        });
    }

    if (subagent !== undefined) {
        return fauxAssistantMessage([fauxText(`${subagent}: all good`)]);
    }

    if (text === "orchestrate") {
        return fauxAssistantMessage(
            ["quick", "slow"].map((name) =>
                fauxToolCall("subagent", {
                    action: "spawn",
                    name,
                    message: `Check ${name}, please.`,
                }),
            ),
            { stopReason: "toolUse" },
        );
    }

    if (role === "toolResult" && text.includes("Started") && parentSleep > 0) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: `sleep ${parentSleep}` })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText("noted")]);
};

let app: App;
let model: ReturnType<typeof scriptedModel>;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string, timeoutMs?: number) =>
    until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

/** The text of the first element `selector` finds, or null. */
const textOf = (selector: string) =>
    inPage<string | null>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.textContent.replace(/\\s+/g, " ").trim() ?? null)`,
    );

/** Wait until the first `selector` says something that `pattern` matches. */
const says = (selector: string, pattern: RegExp, timeoutMs?: number) =>
    until(
        async () => pattern.test((await textOf(selector)) ?? ""),
        `${selector} to say ${pattern}`,
        timeoutMs,
    );

/** Past what slides in, as a person's next tap is (`back.js` lets go of a tap that lands on something just moved). */
const settled = () => new Promise((resolve) => setTimeout(resolve, 450));

/** A session at phone size whose parent starts "quick" and "slow". */
async function started(sleep: number): Promise<ConversationId> {
    parentSleep = sleep;
    const id = await newSession(app);

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await see(
        `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
        "the session",
    );
    await app.commands.submit(id, owner(app), { text: "orchestrate", requestId: `go-${id}` });

    return id;
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    model = scriptedModel(route);
    app = await openApp(model);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "subagents-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("the bar says what works; Stop stops one", real, async () => {
    const id = await started(0);

    await says(".agents-count", /^1 working · 1 done$/);
    // The top bar's count unfolds it: a row each.
    await settled();
    await page.click({ selector: '.topbar [title="Subagents working"]' });
    await see(
        `return JSON.stringify(document.querySelectorAll(".agent-row").length === 2)`,
        "a row each",
    );
    await settled();
    await page.click({ label: "Stop slow" });
    await says(".agents-count", /^1 stopped · 1 done$/, 15_000);
    // The subagent itself: its run ended (the parent had not been working since it started them).
    const slow = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.slow!;

    assert.equal(app.isBusy(slow.conversationId), false, "the subagent stopped");
});

test(
    "a person's message that looks like a report is theirs: a steer in the queue, a message in the conversation",
    real,
    async () => {
        const id = await started(6);
        const lookalike = "[subagent zed answered, no reply needed] this is my own message";

        await says(".queued-mode", /^Report/);
        await app.commands.submit(id, owner(app), {
            text: lookalike,
            requestId: `own-${id}`,
            mode: "steer",
        });
        await see(
            `return JSON.stringify([...document.querySelectorAll(".queued")].some((row) => row.textContent.includes("this is my own message") && row.querySelector(".queued-mode").textContent.trim().startsWith("Steer")))`,
            "the look-alike as a steer",
        );
        // Once Pi has it, it shows as the person's message, not as a report card.
        await see(
            `return JSON.stringify([...document.querySelectorAll(".prompt")].some((prompt) => prompt.textContent.includes("this is my own message")))`,
            "the look-alike as a message",
            20_000,
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll(".report-name")].some((name) => name.textContent === "zed"))`,
            ),
            false,
        );
    },
);
