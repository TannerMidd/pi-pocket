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
