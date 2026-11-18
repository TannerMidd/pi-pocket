// A repeat set to compact first: before each sending, everything before its last message is summarized, so a run
// starts on the last run and what was said since. Its first sending has nothing before to keep; one without the
// setting compacts nothing; a session at work sends without compacting; a restart while it compacts sends once; and
// the conversation's own compaction settings are as they were after, also when the schedule is stopped meanwhile.
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
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { ScheduleDoc } from "../src/server/docs.ts";

/** The requests Pi Durable's summaries were written from. */
const summaries: string[] = [];

/** What holds answers until a test lets them go: summaries while `summaries` is on, and messages that say "hold". */
const holding = { summaries: false, release: () => {}, gate: Promise.resolve() };

function hold(): void {
    holding.gate = new Promise((resolve) => {
        holding.release = resolve;
    });
}

/** Wait for the gate, or for the request to be aborted (a restart closes the app). */
async function held(signal: AbortSignal | undefined, answer: string) {
    const aborted = new Promise<"aborted">((resolve) =>
        signal?.addEventListener("abort", () => resolve("aborted"), { once: true }),
    );

    return (await Promise.race([holding.gate, aborted])) === "aborted"
        ? fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "aborted" })
        : fauxAssistantMessage([fauxText(answer)]);
}

const route: FauxResponseStep = (request, options) => {
    const messages = (request as { messages: Message[] }).messages;
    const system = JSON.stringify(messages.filter((message) => message.role === "system"));
    const { text } = lastText(request as never);

    if (system.includes("context summarization assistant")) {
        summaries.push(text);

        return holding.summaries
            ? held(options?.signal, "SUMMARY of the old runs")
            : fauxAssistantMessage([fauxText("SUMMARY of the old runs")]);
    }

    if (text.includes("hold")) {
        return held(options?.signal, "held, then done");
    }

    return fauxAssistantMessage([fauxText(`echo: ${text.slice(0, 200)}`)]);
};

const model = scriptedModel(route);
const dataDir = join(root, "data");
let app: App;
let ahead = 0;

before(async () => {
    app = await openApp(model, dataDir);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Restart the server with its clock `minutes` further ahead. */
async function restartLater(minutes: number): Promise<void> {
    await app.close();
    ahead += minutes * 60_000;
    const offset = ahead;

    app = await openApp(model, dataDir, () => Date.now() + offset);
}

const runs = async (id: ConversationId, scheduleId: string) =>
    (await app.harness.snapshot(ScheduleDoc, id, context))?.items[scheduleId]?.runs ?? 0;

/** The model context as entries: their kind and the text of their first message. */
async function contextOf(id: ConversationId): Promise<{ kind: string; text: string }[]> {
    const view = await (await app.harness.conversation(id, context))!.context(context);

    return view.entries.map((entry) => ({
        kind: entry.kind,
        text: JSON.stringify(entry.model ?? (entry.data as unknown) ?? ""),
    }));
}

/** How many briefings went out in all, also those a compaction summarized. */
async function briefings(id: ConversationId): Promise<number> {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        500,
        undefined,
        context,
    );

    return page.items.filter(
        (entry) =>
            entry.kind === "pi.user" &&
            JSON.stringify(entry.model).includes("[scheduled] briefing"),
    ).length;
}

const ownCompaction = async (id: ConversationId) =>
    (await app.harness.snapshot(AgentDoc, id, context))?.compaction;

/** A session with some old work and a repeat set to compact first, after its first sending. */
async function afterFirstBriefing(): Promise<{ id: ConversationId; scheduleId: string }> {
    const id = await newSession(app);

    await say(app, id, `old work: ${"x".repeat(4000)}`);
    const schedule = await app.commands.schedule(id, owner(app), {
        when: "every 20m briefing",
        zone: "UTC",
        compactBefore: true,
    });

    await restartLater(21);
    await until(async () => (await runs(id, schedule.id)) === 1, "the first sending");
    await answered(id, 1);

    return { id, scheduleId: schedule.id };
}

/** Wait until the scheduled message number `count` was answered. */
async function answered(id: ConversationId, count: number): Promise<void> {
    await until(async () => {
        const entries = await contextOf(id);
        const at = entries.findLastIndex(
            (entry) => entry.kind === "pi.user" && entry.text.includes("[scheduled] briefing"),
        );
        const all = (await app.harness.conversation(id, context))!.entries(
            {},
            500,
            undefined,
            context,
        );
        const sent = (await all).items.filter(
            (entry) =>
                entry.kind === "pi.user" &&
                JSON.stringify(entry.model).includes("[scheduled] briefing"),
        ).length;

        return (
            sent === count &&
            at >= 0 &&
            entries.slice(at + 1).some((entry) => entry.kind === "pi.assistant") &&
            !app.isBusy(id)
        );
    }, `the briefing number ${count} to be answered`);
}

test("a repeat set to compact first keeps its last run and what came since, and summarizes the rest", async () => {
    const id = await newSession(app);

    await say(app, id, `old work: ${"x".repeat(4000)}`);
    await say(app, id, "more old work");
    const schedule = await app.commands.schedule(id, owner(app), {
        when: "every 20m briefing",
        zone: "UTC",
        compactBefore: true,
    });

    assert.equal(schedule.compactBefore, true);

    // The first sending: no run before it, nothing compacted.
    await restartLater(21);
    await until(async () => (await runs(id, schedule.id)) === 1, "the first sending");
    await answered(id, 1);
    assert.equal(summaries.length, 0, "the first sending compacts nothing");

    // Asked after the run, to debug it: this stays too.
    await say(app, id, "why did the briefing say that?");

    // The second sending: everything before the first briefing is summarized.
    await restartLater(20);
    await until(async () => (await runs(id, schedule.id)) === 2, "the second sending");
    await answered(id, 2);
    assert.equal(summaries.length, 1, "one summary");
    assert.match(summaries[0]!, /old work/);
    assert.doesNotMatch(summaries[0]!, /\[scheduled\] briefing/, "the last run is not summarized");

    const entries = await contextOf(id);

    assert.equal(entries[0]?.kind, "pi.compaction");
    assert.match(
        entries[1]?.text ?? "",
        /\[scheduled\] briefing/,
        "kept from the last briefing on",
    );
    assert.ok(entries.some((entry) => entry.text.includes("why did the briefing say that?")));
    assert.ok(!entries.some((entry) => entry.text.includes("more old work")));
    assert.equal(
        entries.filter(
            (entry) => entry.kind === "pi.user" && entry.text.includes("[scheduled] briefing"),
        ).length,
        2,
        "the last briefing and the new one",
    );

    // The conversation's own compaction settings are as they were: none.
    assert.equal((await app.harness.snapshot(AgentDoc, id, context))?.compaction, undefined);

    // Without the setting, the next sending compacts nothing.
    await app.commands.updateSchedule(id, owner(app), schedule.id, {
        text: "briefing",
        every: { minutes: 20 },
        compactBefore: false,
    });
    assert.equal(
        (await app.harness.snapshot(ScheduleDoc, id, context))?.items[schedule.id]?.compactBefore,
        undefined,
    );
    await restartLater(21);
    await until(async () => (await runs(id, schedule.id)) === 3, "the third sending");
    await answered(id, 3);
    assert.equal(summaries.length, 1, "no summary without the setting");
    await app.commands.cancelSchedule(id, owner(app), schedule.id);
});

test("only true or false turns compacting first on or off", async () => {
    const id = await newSession(app);

    await assert.rejects(
        app.commands.schedule(id, owner(app), {
            when: "every 20m briefing",
            compactBefore: "yes",
        }),
        /compactBefore must be true or false/,
    );
});

test("a session at work when the time comes gets its message without compacting first", async () => {
    const { id, scheduleId } = await afterFirstBriefing();
    const before = summaries.length;

    hold();
    void app.commands.submit(id, owner(app), { text: "hold this", requestId: crypto.randomUUID() });
    await until(() => app.isBusy(id), "the session to be at work");

    // After the restart its run goes on, held again: the schedule finds it in the live document.
    await restartLater(20);
    await until(async () => (await runs(id, scheduleId)) === 2, "the second sending");
    assert.equal(summaries.length, before, "no summary while the session works");
    assert.equal(await ownCompaction(id), undefined);
    holding.release();
    await answered(id, 2);
    assert.equal(summaries.length, before);
    await app.commands.cancelSchedule(id, owner(app), scheduleId);
});

test("a restart while it compacts sends once, after the summary; a stop while it compacts restores the settings", async () => {
    const { id, scheduleId } = await afterFirstBriefing();

    holding.summaries = true;
    hold();
    await restartLater(20);
    await until(async () => (await ownCompaction(id)) !== undefined, "the cut to be set");
    await until(
        async () =>
            ((await app.harness.snapshot(LiveDoc, id, context))?.compactions?.length ?? 0) > 0,
        "the compaction to run",
    );

    // A restart in the middle: the schedule waits for the same compaction, and nothing goes out before it is done.
    await restartLater(0);
    assert.equal(await runs(id, scheduleId), 1);
    assert.equal(await briefings(id), 1);
    holding.summaries = false;
    holding.release();
    await until(async () => (await runs(id, scheduleId)) === 2, "the second sending");
    await answered(id, 2);
    assert.equal(await briefings(id), 2, "never twice");
    assert.equal((await contextOf(id))[0]?.kind, "pi.compaction");
    assert.equal(await ownCompaction(id), undefined);

    // Stopped while it compacts: the conversation gets its own settings back, and nothing more goes out.
    holding.summaries = true;
    hold();
    await restartLater(20);
    await until(async () => (await ownCompaction(id)) !== undefined, "the cut to be set again");
    await app.commands.cancelSchedule(id, owner(app), scheduleId);
    await until(async () => (await ownCompaction(id)) === undefined, "the settings to be restored");
    holding.summaries = false;
    holding.release();
    await until(
        async () =>
            ((await app.harness.snapshot(LiveDoc, id, context))?.compactions?.length ?? 0) === 0,
        "the compaction to end",
    );
    assert.equal(await briefings(id), 2, "a stopped schedule sends nothing");
});
