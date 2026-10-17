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
    recordCost,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
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

    // Their model fails: Pi hears they failed, and the board says they need you.
    if (subagent?.startsWith("broken")) {
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Bad request" });
    }

    if (subagent?.startsWith("slow") && role !== "toolResult") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], {
            stopReason: "toolUse",
        });
    }

    if (subagent !== undefined) {
        return fauxAssistantMessage([fauxText(`${subagent}: all good`)]);
    }

    if (text === "many") {
        return fauxAssistantMessage(
            Array.from({ length: 15 }, (_, index) =>
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: `slow-${index + 1}`,
                    message: `Check part ${index + 1} of the checkout branch and report what fails.`,
                }),
            ),
            { stopReason: "toolUse" },
        );
    }

    const breaking = /^break (\S+)$/.exec(text);

    if (breaking !== null) {
        return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "spawn", name: breaking[1]!, message: "Look." })],
            { stopReason: "toolUse" },
        );
    }

    if (text === "one more") {
        return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "spawn", name: "extra", message: "One more." })],
            { stopReason: "toolUse" },
        );
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
/** The scripted model: it has a number of answers, which the tests in this file come close to using up. */
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

test(
    "the bar says what works and what each does now; Stop stops one; done, it can be put away",
    real,
    async () => {
        const id = await started(0);

        // Folded: the counts, and what the one working does, from its peek.
        await says(".agents-count", /^1 working · 1 done$/);
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
        await says(".agents-count", /^1 stopped · 1 done$/, 15_000);
        await says(".agent-row.stopped .agent-name", /^slow$/);
        // The subagent itself: its run ended (the parent had not been working since it started them).
        const slow = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.slow!;

        assert.equal(app.isBusy(slow.conversationId), false, "the subagent stopped");
        // The stopped one's report goes to Pi first; then the bar can be put away.
        await see(
            `return JSON.stringify(document.querySelector('[aria-label="Put the subagents bar away"]') !== null)`,
            "the way to put it away",
            15_000,
        );
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
    "a child opened directly returns to its main session above the input on desktop and mobile",
    real,
    async () => {
        const id = await newSession(app);
        const title = ("Checkout investigation · " + "a long main-session title ".repeat(6))
            .slice(0, 110)
            .trim();

        parentSleep = 0;
        await app.commands.updateSession(id, owner(app), { title });
        await app.commands.submit(id, owner(app), { text: "one more", requestId: `child-${id}` });
        await until(async () => {
            const doc = await app.harness.snapshot(SubagentsDoc, id, context);

            return !!doc?.agents.extra && !app.isBusy(doc.agents.extra.conversationId);
        }, "the child answered");

        const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.extra!
            .conversationId;
        const other = await newSession(app);
        const label = `Back to main session: ${title}`;
        const long = Array.from({ length: 100 }, (_, index) => `Checkout detail ${index + 1}`).join(
            "\n",
        );

        await app.commands.submit(child, owner(app), { text: long, requestId: `long-${child}` });
        await until(async () => !app.isBusy(child), "the long message answered");

        const measure = async () => {
            await frames();

            return inPage<{
                top: number;
                height: number;
                visible: boolean;
                inputVisible: boolean;
                scrolls: boolean;
                scrolled: number;
            }>(
                `const button = document.querySelector(".parent-session");
                const scroller = document.querySelector(".scroller");
                const box = button.getBoundingClientRect();
                const input = document.querySelector(".composer textarea").getBoundingClientRect();

                return JSON.stringify({
                    top: box.top,
                    height: box.height,
                    visible: box.top >= scroller.getBoundingClientRect().bottom - 1 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth,
                    inputVisible: input.height > 0 && input.top >= box.bottom && input.bottom <= innerHeight,
                    scrolls: scroller.scrollHeight > scroller.clientHeight,
                    scrolled: scroller.scrollTop,
                });`,
            );
        };

        try {
            for (const viewport of [
                VIEWPORTS.mobile,
                { width: 320, height: 400, scale: 1, mobile: true },
                VIEWPORTS.desktop,
            ]) {
                await page.setViewport(viewport);
                // Previous history points elsewhere: this action must follow the parent relationship.
                await page.navigate(`${base}/s/${other}`);
                await see(
                    `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
                    "the unrelated session",
                );
                assert.equal(
                    await textOf(".parent-session"),
                    null,
                    "ordinary sessions have no return button",
                );
                await page.navigate(`${base}/s/${child}`);
                await see(
                    `return JSON.stringify(document.querySelector(".parent-session")?.getAttribute("aria-label") === ${JSON.stringify(label)})`,
                    "the return button names the main session",
                );
                await says(".scroller", /Checkout detail 100/);
                assert.equal(await textOf(".title-sub"), `subagent of ${title}`);
                assert.equal(
                    await inPage<number>(
                        `return JSON.stringify(document.querySelectorAll('.topbar [aria-label^="Back to main session"], .transcript .breadcrumb').length)`,
                    ),
                    0,
                    "no duplicate return controls above the conversation",
                );
                await settled();
                await page.scroll(undefined, 100000);
                await see(
                    `return JSON.stringify(document.querySelector(".scroller").scrollTop > 0)`,
                    "the long conversation scrolled",
                );
                const before = await measure();

                assert.ok(before.height >= 44, "the button has a large click target");
                assert.ok(
                    before.visible && before.inputVisible && before.scrolls,
                    "both navigation and input fit outside long content",
                );
                await page.scroll(undefined, -100000);
                await see(
                    `return JSON.stringify(document.querySelector(".scroller").scrollTop < ${before.scrolled})`,
                    "the conversation scrolled back",
                );
                assert.equal(
                    (await measure()).top,
                    before.top,
                    "scrolling does not move the return button",
                );
                await settled();
                await page.click({ selector: ".parent-session" });
                await see(
                    `return JSON.stringify(location.pathname === "/s/${id}" && document.querySelector(".title-main")?.textContent === ${JSON.stringify(title)} && document.querySelector(".composer textarea") !== null)`,
                    "the main session opened",
                );
                assert.equal(
                    await textOf(".parent-session"),
                    null,
                    "the main session has no return button",
                );
            }

            const { user, token } = app.config.addUser("Return-navigation viewer", "viewer");
            const viewer = await browsers.open(3);

            try {
                await viewer.setViewport(VIEWPORTS.mobile);
                await viewer.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
                await viewer.navigate(`${base}/s/${child}`);
                await until(
                    async () =>
                        JSON.parse(
                            await viewer.evaluate(
                                `return JSON.stringify(document.querySelector(".view-only") !== null && document.querySelector(".parent-session")?.getAttribute("aria-label") === ${JSON.stringify(label)})`,
                            ),
                        ),
                    "the viewer has the same return action",
                );
                await settled();
                await viewer.click({ selector: ".parent-session" });
                await until(
                    async () =>
                        JSON.parse(
                            await viewer.evaluate(
                                `return JSON.stringify(location.pathname === "/s/${id}" && document.querySelector(".title-main")?.textContent === ${JSON.stringify(title)} && document.querySelector(".view-only") !== null)`,
                            ),
                        ),
                    "the viewer returned to the main session",
                );
            } finally {
                await browsers.close(3);
                app.config.removeUser(user.id);
            }
        } finally {
            await app.commands.abort(id, owner(app));
            await page.setViewport(VIEWPORTS.mobile);
        }
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
            "[subagent gamma failed: Bad request]",
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
            ["alpha", "beta", "gamma"],
        );
        assert.match(cards[1]!.text, /no closing bracket/);
        assert.equal(
            await textOf(".report.failed .report-why"),
            "Bad request",
            "a failed one says why",
        );
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
                ) === "1 working · 1 done",
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
        // The viewer's dock shares its room as everyone's does: the unfolded list shows a whole row.
        const measured = await dock(viewer);

        assert.ok(
            measured.list >= measured.agentRow && measured.whole,
            `the viewer's list: ${measured.list}px`,
        );
    } finally {
        await browsers.close(2);
        app.config.removeUser(user.id);
        await app.commands.abort(id, owner(app));
    }
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

test(
    "put away, the bar counts only what came after; unfolded, it stays unfolded in its own session only",
    real,
    async () => {
        const first = await started(0);

        await until(
            async () =>
                (await app.harness.snapshot(SubagentsDoc, first, context))?.agents.slow !==
                undefined,
            "slow at work",
        );
        const slow = (await app.harness.snapshot(SubagentsDoc, first, context))!.agents.slow!;

        await until(() => app.isBusy(slow.conversationId), "slow busy");
        await (await app.harness.conversation(slow.conversationId, context))!.abort(context);
        await says(".agents-count", /^1 stopped · 1 done$/, 15_000);
        // The stopped one's report goes to Pi first; then the bar can be put away.
        await see(
            `return JSON.stringify(document.querySelector('[aria-label="Put the subagents bar away"]') !== null)`,
            "the way to put it away",
            15_000,
        );
        await settled();
        await page.click({ label: "Put the subagents bar away" });
        await see(
            `return JSON.stringify(document.querySelector(".agents-bar") === null)`,
            "put away",
        );
        await app.commands.submit(first, owner(app), {
            text: "one more",
            requestId: `more-${first}`,
        });
        await says(".agents-count", /^1 subagent done$/, 15_000);

        // Unfolded here, then another session with subagents: there it starts folded.
        await settled();
        await page.click({ selector: ".agents-summary" });
        await see(
            `return JSON.stringify(document.querySelector(".agents-list") !== null)`,
            "unfolded",
        );
        // Another session with subagents, opened from inside the app, as a person goes to it.
        parentSleep = 0;
        const second = await newSession(app);

        await app.commands.submit(second, owner(app), {
            text: "orchestrate",
            requestId: `go-${second}`,
        });
        await page.evaluate(`(await import("/store.js")).navigate(${Number(second)})`);
        await see(
            `return JSON.stringify(location.pathname === "/s/${Number(second)}" && document.querySelector(".agents-bar") !== null)`,
            "the other session's bar",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".agents-list") === null)`,
            ),
            true,
            "folded in the other session",
        );
    },
);

/** Wait for the layout to settle: a fitted dock is set after a render, and after a size change, a frame later. */
const frames = (on = page) =>
    on.evaluate(
        `await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );

type Dock = {
    /** The dock's share of the room it and the conversation have together. */
    share: number;
    capped: boolean;
    floor: number;
    conversation: number;
    /** Nothing in the dock reaches under the message box, and the dock does not scroll: no bar is cut. */
    whole: boolean;
    list: number;
    agentRow: number;
    queue: number;
    queueRow: number;
    queueScrolls: boolean;
    listScrolls: boolean;
    queueShown: boolean;
    count: string | null;
    lastInView: boolean;
};

/** The dock and the conversation as they show. */
const dock = async (on = page): Promise<Dock> => {
    const measure = async () => {
        await frames(on);

        return on.evaluate(`
            const rect = (element) => element?.getBoundingClientRect();
            const dock = document.querySelector(".dock");
            const scroller = document.querySelector(".scroller");
            const composer = rect(document.querySelector(".composer, .view-only"));
            const list = document.querySelector(".agents-list");
            const queue = document.querySelector(".inbox");
            const count = document.querySelector(".inbox-count");
            const rows = [...document.querySelectorAll(".transcript > *")].filter((row) => rect(row).height > 0);
            const last = rect(rows.at(-1));
            const shown = (element) => element !== null && getComputedStyle(element).visibility !== "hidden" && rect(element).height > 0;

            return JSON.stringify({
                share: rect(dock).height / (rect(dock).height + rect(scroller).height),
                capped: dock.dataset.capped === "on",
                // What the conversation always keeps: a quarter of the room it shares with the dock, up to 5rem.
                floor: Math.min(
                    0.25 * (rect(dock).height + rect(scroller).height),
                    5 * parseFloat(getComputedStyle(document.documentElement).fontSize),
                ),
                conversation: Math.round(rect(scroller).height),
                whole:
                    dock.scrollHeight <= dock.clientHeight + 1 &&
                    [...dock.children].every((child) => rect(child).bottom <= composer.top + 1),
                list: Math.round(rect(list)?.height ?? 0),
                agentRow: Math.round(rect(list?.querySelector(".agent-row"))?.height ?? 0),
                queue: Math.round(shown(queue) ? rect(queue).height : 0),
                queueRow: Math.round(rect(queue?.querySelector(".queued"))?.height ?? 0),
                queueScrolls:
                    queue !== null &&
                    getComputedStyle(queue).overflowY !== "visible" &&
                    queue.scrollHeight > queue.clientHeight + 1,
                listScrolls: list !== null && list.scrollHeight > list.clientHeight + 1,
                queueShown: shown(queue),
                count: shown(count) ? count.textContent.trim() : null,
                lastInView: last !== undefined && last.bottom <= rect(scroller).bottom + 1 && last.bottom > rect(scroller).top,
            });
        `);
    };

    // As it settles: the dock fits itself a frame after what changed it, later on a busy machine.
    let last = await measure();

    for (let tries = 0; tries < 10; tries++) {
        const now = await measure();

        if (now === last) {
            break;
        }

        last = now;
    }

    return JSON.parse(last) as Dock;
};

/** A session at `size`, with 15 slow subagents at work and `queued` steers waiting; `before` sets up more. */
async function crowded(
    size: { width: number; height: number; scale: number; mobile: boolean },
    queued: number,
    folder?: string,
    before?: (id: ConversationId) => Promise<void>,
): Promise<ConversationId> {
    parentSleep = 30;
    const id = await newSession(app, folder);

    await page.setViewport(size);
    await page.navigate(`${base}/s/${id}`);
    await see(
        `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
        "the session",
    );
    await app.commands.submit(id, owner(app), { text: "many", requestId: `many-${id}` });
    await says(".agents-count", /^15 subagents working$/, 15_000);
    // The parent at its long sleep, so what is sent now waits in its queue, whatever `before` turns on (plan mode would
    // block a sleep that had not started yet).
    await until(
        async () =>
            ((await app.harness.snapshot(LiveDoc, id, context))?.tools ?? []).some(
                (tool) => tool.name === "bash" && tool.status === "running",
            ),
        "the parent at work",
    );
    await before?.(id);

    for (let index = 0; index < queued; index++) {
        await app.commands.submit(id, owner(app), {
            text: `Steer ${index + 1}: also look at the refunds path and the tax rounding.`,
            requestId: `crowd-${id}-${index}`,
            mode: "steer",
        });
    }

    await see(
        `return JSON.stringify(document.querySelectorAll(".queued").length === ${queued})`,
        "the queue",
    );

    return id;
}

/** Unfold the subagents bar, and wait for its rows. */
async function unfold(): Promise<void> {
    await settled();
    await page.click({ selector: ".agents-summary" });
    await see(
        `return JSON.stringify(document.querySelectorAll(".agent-row").length > 0)`,
        "the rows",
    );
}

const SMALL_PHONE = { width: 375, height: 667, scale: 2, mobile: true };
const SIDEWAYS = { width: 844, height: 390, scale: 2, mobile: true };

for (const [label, size] of [
    ["a phone", VIEWPORTS.mobile],
    ["a small phone", SMALL_PHONE],
] as const) {
    test(
        `on ${label}, many subagents and a long queue leave the conversation most of the room, folded or not`,
        real,
        async () => {
            const id = await crowded(size, 12);
            const folded = await dock();

            await unfold();
            const open = await dock();

            for (const [state, measured] of [
                ["folded", folded],
                ["unfolded", open],
            ] as const) {
                assert.ok(measured.share <= 0.46, `${state}: the dock takes ${measured.share}`);
                assert.ok(measured.whole, `${state}: nothing is cut`);
                assert.ok(measured.lastInView, `${state}: the newest message stays in view`);
                assert.ok(
                    measured.queueShown && measured.queueScrolls,
                    `${state}: the queue shows, and scrolls`,
                );
                assert.equal(
                    measured.count,
                    "12 messages waiting for Pi",
                    `${state}: how many wait`,
                );
            }

            assert.ok(
                open.list >= open.agentRow && open.listScrolls,
                "unfolded, the list shows a row and scrolls",
            );
            assert.ok(open.queue >= open.queueRow, "the queue keeps a row");
            await app.commands.abort(id, owner(app));
            await page.setViewport(VIEWPORTS.mobile);
        },
    );
}

test(
    "with every bar there too, the bars show whole and the unfolded list still shows a row",
    real,
    async () => {
        for (const size of [
            VIEWPORTS.mobile,
            { width: 390, height: 560, scale: 2, mobile: true },
            { width: 390, height: 480, scale: 2, mobile: true },
            SIDEWAYS,
        ]) {
            // A project with skills of its own, undecided: the trust bar asks.
            const project = realpathSync(mkdtempSync(join(root, "dock-bars-")));

            mkdirSync(join(project, ".git"));
            mkdirSync(join(project, ".agents", "skills", "deploy"), { recursive: true });
            writeFileSync(
                join(project, ".agents", "skills", "deploy", "SKILL.md"),
                "---\nname: deploy\ndescription: Deploy.\n---\nSteps.\n",
            );
            const id = await crowded(size, 5, project, async (session) => {
                await app.commands.setPlan(session, owner(app), true);
                await app.commands.setGoal(session, owner(app), "false");
            });

            await see(
                `return JSON.stringify(["plan-bar", "goal-bar", "agents-bar", "trust-bar"].every((name) => document.querySelector("." + name) !== null))`,
                "every bar",
            );
            const folded = await dock();

            await unfold();
            const open = await dock();
            const at = `${size.width}x${size.height}`;

            // Where even one line each is too much (a phone on its side), the dock stops and scrolls, and the conversation
            // keeps a quarter of the room; elsewhere, nothing in the dock is cut.
            const sideways = size === SIDEWAYS || size.height === 480;

            for (const [state, measured] of [
                ["folded", folded],
                ["unfolded", open],
            ] as const) {
                assert.ok(sideways || measured.whole, `${at} ${state}: the bars show whole`);
                assert.ok(
                    measured.conversation >= measured.floor - 1,
                    `${at} ${state}: the conversation keeps ${measured.conversation}px, at least ${measured.floor}`,
                );
            }

            assert.ok(folded.queueShown, `${at}: folded, the queue shows`);
            assert.ok(
                open.list >= open.agentRow,
                `${at}: unfolded, the list shows a whole row (${open.list}px)`,
            );
            assert.ok(
                open.queueShown || open.count === "5 messages waiting for Pi",
                `${at}: the queue, or how many wait`,
            );
            assert.ok(open.lastInView, `${at}: the newest message stays in view`);
            await app.commands.abort(id, owner(app));
        }

        await page.setViewport(VIEWPORTS.mobile);
    },
);

test("one waiting message shows whole, with no count and no scrolling", real, async () => {
    const id = await crowded(VIEWPORTS.mobile, 1);
    const measured = await dock();

    assert.deepEqual(
        {
            shown: measured.queueShown,
            scrolls: measured.queueScrolls,
            count: measured.count,
            whole: measured.whole,
        },
        { shown: true, scrolls: false, count: null, whole: true },
    );
    await app.commands.abort(id, owner(app));
});

test(
    "on a phone on its side, the unfolded list takes the room, and the queue folds to how many wait",
    real,
    async () => {
        const id = await crowded(SIDEWAYS, 1);

        assert.ok((await dock()).queueShown, "folded, the queue shows");
        await unfold();
        const open = await dock();

        assert.ok(open.list >= open.agentRow, `the list shows a whole row: ${open.list}px`);
        assert.deepEqual(
            { queue: open.queueShown, count: open.count, whole: open.whole },
            { queue: false, count: "1 message waiting for Pi", whole: true },
        );
        await settled();
        await page.click({ selector: ".agents-summary" });
        await see(
            `return JSON.stringify(document.querySelector(".agents-list") === null)`,
            "folded again",
        );
        const again = await dock();

        assert.deepEqual(
            { queue: again.queueShown, count: again.count },
            { queue: true, count: null },
            "the queue comes back",
        );
        await app.commands.abort(id, owner(app));
        await page.setViewport(VIEWPORTS.mobile);
    },
);

test(
    "where the dock must scroll, an unfolded list comes into sight, and folding it puts the dock back",
    real,
    async () => {
        const project = realpathSync(mkdtempSync(join(root, "dock-scrolls-")));

        mkdirSync(join(project, ".git"));
        mkdirSync(join(project, ".agents", "skills", "deploy"), { recursive: true });
        writeFileSync(
            join(project, ".agents", "skills", "deploy", "SKILL.md"),
            "---\nname: deploy\ndescription: Deploy.\n---\nSteps.\n",
        );
        const id = await crowded(
            { width: 390, height: 400, scale: 2, mobile: true },
            5,
            project,
            async (session) => {
                await app.commands.setPlan(session, owner(app), true);
                await app.commands.setGoal(session, owner(app), "false");
            },
        );

        /** Where the dock is scrolled, and what of it is in its window. */
        const seen = async () => {
            await frames();

            return JSON.parse(
                await page.evaluate(`
                const dock = document.querySelector(".dock");
                const window = dock.getBoundingClientRect();
                const inSight = (selector) => {
                    const element = document.querySelector(selector);
                    const box = element?.getBoundingClientRect();

                    return box !== undefined && box.height > 0 && box.top >= window.top - 1 && box.bottom <= window.bottom + 1;
                };

                return JSON.stringify({
                    capped: dock.dataset.capped === "on",
                    scrolls: dock.scrollHeight > dock.clientHeight + 1,
                    top: Math.round(dock.scrollTop),
                    list: inSight(".agents-list"),
                    count: inSight(".inbox-count"),
                    queue: inSight(".inbox"),
                });
            `),
            ) as {
                capped: boolean;
                scrolls: boolean;
                top: number;
                list: boolean;
                count: boolean;
                queue: boolean;
            };
        };

        const before = await seen();

        assert.deepEqual(
            {
                capped: before.capped,
                scrolls: before.scrolls,
                count: before.count,
                queue: before.queue,
            },
            { capped: true, scrolls: true, count: true, queue: true },
            "the dock scrolls, from its top: how many wait, and the queue",
        );
        // The reader's own place in the dock holds through a render, which measures the dock again.
        await page.evaluate(`document.querySelector(".dock").scrollTop = 12`);
        await page.evaluate(`(await import("/store.js")).store.set({})`);
        assert.equal((await seen()).top, 12, "the reader's place in the dock holds");
        // Unfolded from there, and folded again, with taps as a finger gives them (the test browser's own click scrolls
        // its target into view first): the dock goes back to there.
        await settled();
        await page.evaluate(`document.querySelector(".agents-summary").click()`);
        await see(
            `return JSON.stringify(document.querySelectorAll(".agent-row").length > 0)`,
            "the rows",
        );
        const open = await seen();

        assert.ok(open.list && open.top > 12, "the unfolded list is brought into sight");
        await settled();
        await page.evaluate(`document.querySelector(".agents-summary").click()`);
        await see(
            `return JSON.stringify(document.querySelector(".agents-list") === null)`,
            "folded again",
        );
        const after = await seen();

        assert.deepEqual(
            { top: after.top, queue: after.queue },
            { top: 12, queue: true },
            "folded again, the dock is back where the reader had it",
        );
        await app.commands.abort(id, owner(app));
        await page.setViewport(VIEWPORTS.mobile);
    },
);

test(
    "a finger scrolling the queue or the subagents list scrolls them, and does not open the places",
    real,
    async () => {
        // Fresh answers: those before have used up most of them.
        model.setResponses(Array.from({ length: 200 }, () => route));
        const id = await crowded(VIEWPORTS.mobile, 12);

        await unfold();

        /** A finger on the middle of `selector`, moving up `by` pixels, then let go: is a sheet open after it? */
        const swipeUp = async (selector: string, by: number) => {
            await settled();
            await page.evaluate(`
            const target = document.querySelector(${JSON.stringify(selector)});
            const box = target.getBoundingClientRect();
            const x = box.left + box.width / 2;
            const y = box.top + box.height / 2;
            const touch = (at) => new Touch({ identifier: 1, target, clientX: x, clientY: at });
            const fire = (type, at) =>
                target.dispatchEvent(
                    new TouchEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        touches: type === "touchend" ? [] : [touch(at)],
                        changedTouches: [touch(at)],
                    }),
                );

            fire("touchstart", y);

            for (let moved = 10; moved <= ${by}; moved += 10) {
                fire("touchmove", y - moved);
            }

            fire("touchend", y - ${by});
        `);
            await settled();

            return inPage<string | null>(
                `return JSON.stringify((await import("/store.js")).store.state.sheet?.type ?? null)`,
            );
        };

        assert.equal(
            await swipeUp(".agents-list .agent-row", 120),
            null,
            "the list scrolls, no places",
        );
        assert.equal(await swipeUp(".inbox .queued", 120), null, "the queue scrolls, no places");
        // Up from the message box itself still opens them.
        assert.equal(
            await swipeUp(".composer .model-chip", 80),
            "places",
            "the places, from the box",
        );
        await page.evaluate(`history.back()`);
        await see(
            `return JSON.stringify((await import("/store.js")).store.state.sheet === null)`,
            "the places closed",
        );
        await app.commands.abort(id, owner(app));
        await page.setViewport(VIEWPORTS.mobile);
    },
);

test(
    "past a spend limit, the bar says the reports wait, with Raise it for the owner; raised, they go",
    real,
    async () => {
        const id = await newSession(app);

        await page.setViewport(VIEWPORTS.mobile);
        await page.navigate(`${base}/s/${id}`);
        await see(
            `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
            "the session",
        );
        // Spent past a limit; Pi is asked anyway, as a report or a schedule asks it, and starts its subagents.
        await recordCost(app, id, 2);
        await app.spend.setSessionBudget(owner(app), id, 1);
        parentSleep = 0;
        await (await app.harness.conversation(id, context))!.submit(
            { type: "input", content: "orchestrate", requestId: `held-${id}` },
            context,
        );
        await says(
            ".agents-held",
            /^Reports wait: this session reached its \$1\.00 spend limit\. ?Raise it$/,
            20_000,
        );

        // The owner's way to raise it: the Spend sheet.

        await settled();

        await page.click({ selector: ".agents-held button" });

        await see(
            `return JSON.stringify((await import("/store.js")).store.state.sheet?.type === "spend")`,

            "the Spend sheet",
        );

        await page.evaluate(`history.back()`);

        await app.spend.setSessionBudget(owner(app), id, null);
        await see(
            `return JSON.stringify(document.querySelector(".agents-held") === null)`,
            "the line gone once raised",
            15_000,
        );
        await app.commands.abort(id, owner(app));
    },
);

test(
    "the board: the rail opens it with every count; arrows move the focus, Enter opens the square focused, Esc closes it",
    real,
    async () => {
        const id = await started(0);

        await says(".agents-count", /^1 working · 1 done$/, 15_000);
        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/s/${id}`);
        await see(
            `return JSON.stringify(document.querySelector(".rail-agents") !== null)`,
            "the rail",
        );
        await page.click({ selector: ".rail-agents" });
        // Every session's count, this one's and those before it in this file.
        await says(".board-sub", /^\d+ in \d+ sessions?$/);
        const row = `[...document.querySelectorAll(".board-row")].find((each) => each.querySelector(".board-cells .board-cell[data-agent]") && [...each.querySelectorAll(".board-cell")].length === 2)`;

        await see(
            `return JSON.stringify(${row}?.querySelector(".board-summary")?.textContent.trim() === "1 working · 1 done")`,
            "the session's counts",
        );

        // Focus on the first square; the arrow takes the focus, and the selection, to the next.
        await page.evaluate(`${row}.querySelector(".board-cell").focus()`);
        await page.press("ArrowRight");
        const focused = await inPage<{ agent: string | null; selected: boolean }>(`
        const cell = document.activeElement;

        return JSON.stringify({ agent: cell?.getAttribute("data-agent") ?? null, selected: cell?.getAttribute("aria-pressed") === "true" });
    `);

        assert.ok(
            focused.agent !== null && focused.selected,
            `the focus went with the selection: ${JSON.stringify(focused)}`,
        );
        // Enter opens the square that has the focus.
        await page.press("Enter");
        await see(
            `return JSON.stringify(location.pathname === "/s/${focused.agent}" && document.querySelector(".board") === null)`,
            "the subagent it focused, open",
        );

        // Again (past the step back that closing it took), and Esc closes it.

        await settled();

        await page.click({ selector: ".rail-agents" });
        await see(
            `return JSON.stringify(document.querySelector(".board") !== null)`,
            "the board again",
        );
        await page.press("Escape");
        await see(
            `return JSON.stringify(document.querySelector(".board") === null)`,
            "closed by Esc",
        );
        await app.commands.abort(id, owner(app));
        await page.setViewport(VIEWPORTS.mobile);
    },
);

test(
    "the board on a phone: stopped ones say stopped, and a swipe right goes back",
    real,
    async () => {
        const id = await started(0);
        const slow = async () =>
            (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.slow;

        await until(
            async () => (await slow()) !== undefined && app.isBusy((await slow())!.conversationId),
            "slow at work",
        );
        await app.commands.abort((await slow())!.conversationId, owner(app));
        await says(".agents-count", /^1 stopped · 1 done$/, 15_000);
        await page.evaluate(`(await import("/store.js")).store.set({ board: true })`);
        await see(
            `return JSON.stringify(document.querySelector(".board.phone") !== null)`,
            "the board, at phone size",
        );
        await see(
            `return JSON.stringify([...document.querySelectorAll(".board-summary")].some((each) => each.textContent.trim() === "1 stopped · 1 done"))`,
            "stopped apart from done",
        );
        await settled();
        await page.evaluate(`
        const target = document.querySelector(".board-list");
        const touch = (x) => new Touch({ identifier: 1, target, clientX: x, clientY: 400 });
        const fire = (type, x) =>
            target.dispatchEvent(
                new TouchEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    touches: type === "touchend" ? [] : [touch(x)],
                    changedTouches: [touch(x)],
                }),
            );

        fire("touchstart", 80);

        for (let x = 100; x <= 260; x += 20) {
            fire("touchmove", x);
        }

        fire("touchend", 260);
    `);
        await see(
            `return JSON.stringify(document.querySelector(".board") === null)`,
            "back from the board",
        );
    },
);

/** A session at `size` whose subagent `name` fails, once Pi has heard so. */
async function failed(
    size: { width: number; height: number; scale: number; mobile: boolean },
    name: string,
): Promise<{ id: ConversationId; agent: ConversationId }> {
    const id = await newSession(app);

    await page.setViewport(size);
    await page.navigate(`${base}/s/${id}`);
    await see(
        `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
        "the session",
    );
    await app.commands.submit(id, owner(app), { text: `break ${name}`, requestId: `b-${name}` });
    await until(
        async () =>
            (await app.harness.snapshot(SubagentsDoc, id, context))?.agents[name]?.failed ===
                true && !app.isBusy(id),
        `${name} failed, and Pi idle`,
        15_000,
    );

    return {
        id,
        agent: (await app.harness.snapshot(SubagentsDoc, id, context))!.agents[name]!
            .conversationId,
    };
}

/**
 * Whether the rail, the session's row, and the board's Needs you say a failure needs you, and how many failures of the
 * session the session list says nobody has dealt with.
 */
const trouble = (id: ConversationId) =>
    inPage<{ rail: boolean; row: boolean; needs: string[]; failing: number }>(`
        const counts = (await import("/store.js")).store.state.sessions.find((each) => each.id === ${Number(id)})?.subagents ?? {};

        return JSON.stringify({
            rail: document.querySelector(".rail-agents .rail-trouble") !== null,
            row: document.querySelector('.session-row[data-id="${id}"] .session-fork.failed') !== null,
            needs: [...document.querySelectorAll(".board-need .board-need-main b")].map((each) => each.textContent),
            failing: (counts.failed ?? 0) - (counts.dealt ?? 0),
        });
    `);

test(
    "the board: a failed subagent needs you until it is dismissed, and stays dismissed after a reload",
    real,
    async () => {
        // Fresh answers: those before have used up most of them.
        model.setResponses(Array.from({ length: 200 }, () => route));
        const { id } = await failed(VIEWPORTS.desktop, "broken-desk");

        await see(
            `return JSON.stringify(document.querySelector('.session-row[data-id="${id}"] .session-fork.failed') !== null && document.querySelector(".rail-agents .rail-trouble") !== null)`,
            "the session's row and the rail say it failed",
        );
        await settled();
        await page.click({ selector: ".rail-agents" });
        await see(
            `return JSON.stringify([...document.querySelectorAll(".board-need")].some((each) => each.textContent.includes("broken-desk")))`,
            "Needs you lists it",
        );
        await page.evaluate(
            `[...document.querySelectorAll(".board-need")].find((each) => each.textContent.includes("broken-desk")).click()`,
        );
        await says(".board-detail .board-detail-name", /^broken-desk$/);
        await settled();
        await page.click({ selector: ".board-detail .board-dismiss" });
        await see(
            `return JSON.stringify(document.querySelector(".board-detail-state")?.textContent.trim() === "Failed · dismissed" && document.querySelector(".board-dismiss") === null)`,
            "dismissed, and still failed",
        );
        assert.deepEqual(
            await trouble(id),
            { rail: false, row: false, needs: [], failing: 0 },
            "nothing says it needs you",
        );

        // After a reload, still: the session list and the board come from the server.
        await page.reload();
        await see(
            `return JSON.stringify(document.querySelector('.session-row[data-id="${id}"]') !== null)`,
            "the session list again",
        );
        await settled();
        await page.click({ selector: ".rail-agents" });
        await see(
            `return JSON.stringify(document.querySelector(".board-cell.failed") !== null)`,
            "its square on the board",
        );
        assert.deepEqual(await trouble(id), { rail: false, row: false, needs: [], failing: 0 });
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector(".board-cell.failed").textContent.trim())`,
            ),
            "",
            "its square has no ! now",
        );
        await page.press("Escape");
        await page.setViewport(VIEWPORTS.mobile);
    },
);

test(
    "the board on a phone: Dismiss in the bar at the bottom; a failure opened from the board is seen",
    real,
    async () => {
        const first = await failed(VIEWPORTS.mobile, "broken-phone");
        const second = await failed(VIEWPORTS.mobile, "broken-seen");

        await page.evaluate(`(await import("/store.js")).store.set({ board: true })`);
        await see(
            `return JSON.stringify(document.querySelector(".board.phone") !== null && document.querySelectorAll(".board-need").length === 2)`,
            "both in Needs you, at phone size",
        );
        await settled();
        await page.evaluate(
            `[...document.querySelectorAll(".board-need")].find((each) => each.textContent.includes("broken-phone")).click()`,
        );
        await says(".board-bar .board-detail-name", /^broken-phone$/);
        const size = await inPage<{ w: number; h: number }>(
            `const r = document.querySelector(".board-bar .board-dismiss").getBoundingClientRect(); return JSON.stringify({ w: r.width, h: r.height })`,
        );

        assert.ok(size.h >= 36, `Dismiss takes a thumb: ${JSON.stringify(size)}`);
        await settled();
        await page.click({ selector: ".board-bar .board-dismiss" });
        await see(
            `return JSON.stringify([...document.querySelectorAll(".board-need")].map((each) => each.querySelector("b").textContent).join() === "broken-seen")`,
            "only the other one needs you",
        );

        // The other, opened from the board: seen there, it needs nobody either.
        await page.evaluate(
            `[...document.querySelectorAll(".board-need")].find((each) => each.textContent.includes("broken-seen")).click()`,
        );
        await settled();
        await page.click({ selector: ".board-bar .button.primary" });
        await see(
            `return JSON.stringify(location.pathname === "/s/${Number(second.agent)}")`,
            "the subagent open",
        );
        await until(
            async () =>
                (await app.harness.snapshot(SubagentsDoc, second.id, context))?.agents[
                    "broken-seen"
                ]?.dealtAt !== undefined,
            "its failure seen",
        );
        await page.reload();
        await see(
            `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
            "the subagent again",
        );
        await page.evaluate(`(await import("/store.js")).store.set({ board: true })`);
        await see(
            `return JSON.stringify(document.querySelectorAll(".board-cell.failed").length >= 2)`,
            "their squares",
        );

        // At phone size the board takes the session list's place: the list's counts say it.
        for (const { id } of [first, second]) {
            assert.deepEqual(await trouble(id), { rail: false, row: false, needs: [], failing: 0 });
        }
    },
);

test(
    "a failure opened from its row in the subagents bar is seen: it needs nobody, on the server and in the app",
    real,
    async () => {
        const { id, agent } = await failed(VIEWPORTS.desktop, "broken-row");
        const row = `.agent-row.failed[data-peek="${Number(agent)}"] .agent-open`;

        await see(
            `return JSON.stringify(document.querySelector('.session-row[data-id="${id}"] .session-fork.failed') !== null && document.querySelector(".rail-agents .rail-trouble") !== null)`,
            "the session's row and the rail say it failed",
        );
        await settled();
        await page.click({ selector: ".agents-bar .agents-summary" });
        await see(
            `return JSON.stringify(document.querySelector(${JSON.stringify(row)}) !== null)`,
            "its row in the bar",
        );
        await settled();
        await page.click({ selector: row });
        await see(
            `return JSON.stringify(location.pathname === "/s/${Number(agent)}")`,
            "the subagent open",
        );
        await until(
            async () =>
                (await app.harness.snapshot(SubagentsDoc, id, context))?.agents["broken-row"]
                    ?.dealtAt !== undefined,
            "its failure seen",
        );
        await see(
            `return JSON.stringify(document.querySelector('.session-row[data-id="${id}"] .session-fork.failed') === null && document.querySelector(".rail-agents .rail-trouble") === null)`,
            "the session's row and the rail clear",
        );
        assert.deepEqual(await trouble(id), { rail: false, row: false, needs: [], failing: 0 });
        await page.setViewport(VIEWPORTS.mobile);
    },
);

test(
    "a failure opened from the session menu's Subagents list is seen, as from anywhere else",
    real,
    async () => {
        const { id, agent } = await failed(VIEWPORTS.desktop, "broken-menu");

        await see(
            `return JSON.stringify(document.querySelector('.session-row[data-id="${id}"] .session-fork.failed') !== null)`,
            "the session's row says it failed",
        );
        await page.evaluate(
            `(await import("/store.js")).openSheet({ type: "menu" }); return "true"`,
        );
        await see(
            `return JSON.stringify([...document.querySelectorAll(".sheet .list-item")].some((each) => each.textContent.includes("broken-menu")))`,
            "the menu lists it",
        );
        await settled();
        await page.evaluate(
            `[...document.querySelectorAll(".sheet .list-item")].find((each) => each.textContent.includes("broken-menu")).click(); return "true"`,
        );
        await see(
            `return JSON.stringify(location.pathname === "/s/${Number(agent)}")`,
            "the subagent open",
        );
        await until(
            async () =>
                (await app.harness.snapshot(SubagentsDoc, id, context))?.agents["broken-menu"]
                    ?.dealtAt !== undefined,
            "its failure seen",
        );
        await see(
            `return JSON.stringify(document.querySelector('.session-row[data-id="${id}"] .session-fork.failed') === null && document.querySelector(".rail-agents .rail-trouble") === null)`,
            "the session's row and the rail clear",
        );
        await page.setViewport(VIEWPORTS.mobile);
    },
);

test(
    "Dismiss is off while it is asked, and says so when the subagent failed again since",
    real,
    async () => {
        const { id } = await failed(VIEWPORTS.desktop, "broken-late");
        const button = ".board-detail .board-dismiss";
        const disabled = () =>
            inPage<boolean | null>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(button)})?.disabled ?? null)`,
            );

        // Its requests wait to be let go. Stale, one names a failure older than the server's, as a board that has not
        // shown the newer one yet does.
        await page.evaluate(`
            const fetched = window.fetch;

            window.held = [];
            window.stale = true;
            window.fetch = async (input, init) => {
                if (/\\/dismiss$/.test(String(input))) {
                    const at = JSON.parse(init.body).at - (window.stale ? 1 : 0);

                    await new Promise((resolve) => window.held.push(resolve));

                    return fetched(input, { ...init, body: JSON.stringify({ at }) });
                }

                return fetched(input, init);
            };

            return "true";
        `);
        const letGo = () =>
            page.evaluate(`window.held.splice(0).forEach((resolve) => resolve()); return "true"`);

        await settled();
        await page.click({ selector: ".rail-agents" });
        await see(
            `return JSON.stringify([...document.querySelectorAll(".board-need")].some((each) => each.textContent.includes("broken-late")))`,
            "Needs you lists it",
        );
        await page.evaluate(
            `[...document.querySelectorAll(".board-need")].find((each) => each.textContent.includes("broken-late")).click()`,
        );
        await says(".board-detail .board-detail-name", /^broken-late$/);
        await settled();

        // Refused, as it failed again since: it says so, and Dismiss is on again.
        await page.click({ selector: button });
        assert.equal(await disabled(), true, "off while it is asked");
        await letGo();
        await see(
            `return JSON.stringify([...document.querySelectorAll(".notice")].some((notice) => notice.textContent.includes("Not dismissed: broken-late failed again since.")))`,
            "the notice that says so",
        );
        assert.equal(await disabled(), false, "on again");
        assert.equal(
            (await app.harness.snapshot(SubagentsDoc, id, context))?.agents["broken-late"]?.dealtAt,
            undefined,
        );

        // Dismissed: off until the board shows it.
        await page.evaluate(`window.stale = false; return "true"`);
        await page.click({ selector: button });
        assert.equal(await disabled(), true, "off while it is asked");
        await letGo();
        await see(
            `return JSON.stringify(document.querySelector(".board-detail-state")?.textContent.trim() === "Failed · dismissed" && document.querySelector(${JSON.stringify(button)}) === null)`,
            "dismissed",
        );
        await page.press("Escape");
        await page.setViewport(VIEWPORTS.mobile);
    },
);

test(
    "the activity line keeps a right-to-left subagent name in its quotes, before the clock",
    real,
    async () => {
        // Its name ends in Hebrew letters, which would take the closing quote and the clock into their run.
        const name = "broken-שרת";
        const { id, agent } = await failed(VIEWPORTS.desktop, name);
        const at = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents[name]!
            .answeredAt!;

        await app.commands.dismissSubagent(agent, owner(app), at);
        await page.navigate(`${base}/s/${id}?chat=1`);
        await see(
            `return JSON.stringify([...document.querySelectorAll(".chat-event")].some((each) => each.textContent.includes("dealt with")))`,
            "the activity line",
        );

        // Where each part is on screen, left to right: the name's Hebrew letters, the closing quote, the clock.
        const where = await inPage<{ hebrew: number; quote: [number, number]; clock: number }>(`
            const line = [...document.querySelectorAll(".chat-event")].find((each) => each.textContent.includes("dealt with"));
            const texts = [];
            const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);

            while (walk.nextNode()) {
                texts.push(walk.currentNode);
            }

            const box = (node, from, to) => {
                const range = document.createRange();

                range.setStart(node, from);
                range.setEnd(node, to);

                return [...range.getClientRects()];
            };
            const said = texts.find((each) => each.data.includes("שרת"));
            const letters = box(said, said.data.indexOf("שרת"), said.data.indexOf("שרת") + 3);
            const quote = box(said, said.data.indexOf("”"), said.data.indexOf("”") + 1)[0];
            const clock = texts.at(-1);
            const digits = box(clock, 0, clock.data.length);

            return JSON.stringify({
                hebrew: Math.max(...letters.map((each) => each.right)),
                quote: [quote.left, quote.right],
                clock: Math.min(...digits.map((each) => each.left)),
            });
        `);

        assert.ok(
            where.quote[0] >= where.hebrew - 0.5,
            `the quote after the name: ${JSON.stringify(where)}`,
        );
        assert.ok(
            where.clock >= where.quote[1] - 0.5,
            `the clock after the quote: ${JSON.stringify(where)}`,
        );
        await page.press("Escape");
        await page.setViewport(VIEWPORTS.mobile);
    },
);
