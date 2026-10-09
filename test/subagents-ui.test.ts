// The subagents bar and the queue above the message box, in a real browser at phone size where this machine has
// Chromium: the bar says what works and what each does now, Stop stops one, and it can be put away; the queue stays a
// few rows tall however much waits, and subagents' reports wait in it as one row.
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

    if (subagent === "slow" && role !== "toolResult") {
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

    app = await openApp(scriptedModel(route));
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

test(
    "the bar says what works and what each does now; Stop stops one; done, it can be put away",
    real,
    async () => {
        const id = await started(0);

        // Folded: the counts, and what the one working does, from its peek.
        await says(".agents-count", /^1 subagent working · 1 done$/);
        await says(".agents-lead", /^slow: >_ sleep 30$/);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
            ),
            true,
            "the bar fits the phone's width",
        );

        // The top bar's count unfolds it: a row each, working first.
        await settled();
        await page.click({ selector: '.topbar [title="Subagents working"]' });
        await see(
            `return JSON.stringify(document.querySelectorAll(".agent-row").length === 2)`,
            "a row each",
        );
        await says(".agent-row.working .agent-name", /^slow$/);
        await says(".agent-row.working .agent-now", /^>_ sleep 30$/);
        await says(".agent-row.working .agent-asked", /^Check slow, please\.$/);
        await says(".agent-row.done .agent-name", /^quick$/);
        await says(".agent-row.done .agent-when", /^done now$/);
        const stop = await inPage<{ w: number; h: number }>(
            `const r = document.querySelector(".agent-stop").getBoundingClientRect(); return JSON.stringify({ w: r.width, h: r.height })`,
        );

        assert.ok(stop.w >= 36 && stop.h >= 36, `Stop takes a thumb: ${JSON.stringify(stop)}`);

        // Stop: it stops, and the bar says they are done, with a way to put it away.
        await settled();
        await page.click({ label: "Stop slow" });
        await says(".agents-count", /^2 subagents done$/, 15_000);
        assert.equal(app.isBusy(id), false);
        await settled();
        await page.click({ label: "Put the subagents bar away" });
        await see(
            `return JSON.stringify(document.querySelector(".agents-bar") === null)`,
            "the bar put away",
        );
        await page.reload();
        await see(
            `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
            "the session again",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".agents-bar") === null)`,
            ),
            true,
        );
    },
);

test(
    "the queue stays a few rows tall however much waits, and reports wait in it as one row",
    real,
    async () => {
        const id = await started(8);

        // The parent sleeps after starting them: "quick"'s report waits for its next pause, as one row.
        await says(".queued-mode", /^Report/);
        await says(".queued-text", /^from quick, on its way to Pi$/);
        assert.equal(
            await inPage<string | null>(
                `return JSON.stringify(document.querySelector(".queued .icon-button")?.getAttribute("aria-label") ?? null)`,
            ),
            "Discard these reports",
            "its × says what it does",
        );
        // A person's own message that only starts like a report is theirs, as written.
        await app.commands.submit(id, owner(app), {
            text: "[subagent quick] please look again",
            requestId: `like-${id}`,
            mode: "steer",
        });
        await see(
            `return JSON.stringify([...document.querySelectorAll(".queued")].some((row) => row.textContent.includes("please look again") && row.querySelector(".queued-mode").textContent.trim().startsWith("Steer")))`,
            "the look-alike as a steer",
        );

        for (let index = 0; index < 15; index++) {
            await app.commands.submit(id, owner(app), {
                text: `Steer number ${index}: a message long enough to fill a row of the queue.`,
                requestId: `steer-${id}-${index}`,
                mode: "steer",
            });
        }

        await see(
            `return JSON.stringify(document.querySelectorAll(".queued").length === 17)`,
            "all of them waiting",
        );
        const sizes = await inPage<{
            queue: number;
            scrolls: boolean;
            scroller: number;
            limit: number;
        }>(`
        const queue = document.querySelector(".inbox");

        return JSON.stringify({
            queue: queue.getBoundingClientRect().height,
            scrolls: queue.scrollHeight > queue.clientHeight,
            scroller: document.querySelector(".scroller").getBoundingClientRect().height,
            limit: Math.min(innerHeight * 0.28, 12 * parseFloat(getComputedStyle(document.documentElement).fontSize)),
        });
    `);

        assert.ok(sizes.queue <= sizes.limit + 1, `the queue is ${sizes.queue}px tall`);
        assert.ok(sizes.scrolls, "the rest scroll inside it");
        assert.ok(sizes.scroller > 300, `the conversation keeps ${sizes.scroller}px of the screen`);
        await app.commands.abort(id, owner(app));
    },
);

test(
    "reports that came together show a card each; what only looks like a report's start stays in its card",
    real,
    async () => {
        parentSleep = 0;
        const id = await newSession(app);
        const text = [
            "[subagent alpha answered, no reply needed] First answer.",
            "[subagent beta answered, no reply needed] Second answer.",
            "[subagent beta answered, no reply needed and no closing bracket, so not a report's start",
        ].join("\n\n");

        await (await app.harness.conversation(id, context))!.submit(
            {
                type: "write",
                entry: {
                    kind: "pi.user",
                    model: [{ role: "user", content: text, timestamp: Date.now() }],
                },
            },
            context,
        );
        await page.setViewport(VIEWPORTS.mobile);
        await page.navigate(`${base}/s/${id}`);
        await see(
            `return JSON.stringify(document.querySelectorAll(".report").length > 0)`,
            "the reports",
        );
        const cards = await inPage<{ name: string; text: string }[]>(`
        return JSON.stringify([...document.querySelectorAll(".report-group .report")].map((card) => ({
            name: card.querySelector(".report-name").textContent,
            text: card.textContent,
        })));
    `);

        assert.deepEqual(
            cards.map((card) => card.name),
            ["alpha", "beta"],
        );
        assert.match(cards[1]!.text, /no closing bracket/);
    },
);

test("a viewer sees the bar, without Stop", real, async () => {
    const id = await started(0);
    const { user, token } = app.config.addUser("Vi", "viewer");
    const viewer = await browsers.open(2);

    try {
        await viewer.setViewport(VIEWPORTS.mobile);
        await viewer.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
        await until(
            async () =>
                JSON.parse(
                    await viewer.evaluate(
                        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "viewer")`,
                    ),
                ) === true,
            "the viewer signed in",
        );
        await viewer.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                JSON.parse(
                    await viewer.evaluate(
                        `return JSON.stringify(document.querySelector(".agents-count")?.textContent ?? "")`,
                    ),
                ) === "1 subagent working · 1 done",
            "the bar for the viewer",
        );
        await viewer.evaluate(`document.querySelector(".agents-summary").click()`);
        await until(
            async () =>
                JSON.parse(
                    await viewer.evaluate(
                        `return JSON.stringify(document.querySelectorAll(".agent-row").length)`,
                    ),
                ) === 2,
            "the viewer's rows",
        );
        assert.equal(
            JSON.parse(
                await viewer.evaluate(
                    `return JSON.stringify(document.querySelector(".agent-stop") === null)`,
                ),
            ),
            true,
            "no Stop for a viewer",
        );
    } finally {
        await browsers.close(2);
        app.config.removeUser(user.id);
        await app.commands.abort(id, owner(app));
    }
});
