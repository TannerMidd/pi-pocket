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

const summaries: string[] = [];

const holding = { summaries: false, release: () => {}, gate: Promise.resolve() };

function hold(): void {
    holding.gate = new Promise((resolve) => {
        holding.release = resolve;
    });
}

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

async function restartLater(minutes: number): Promise<void> {
    await app.close();
    ahead += minutes * 60_000;
    const offset = ahead;

    app = await openApp(model, dataDir, () => Date.now() + offset);
}

const runs = async (id: ConversationId, scheduleId: string) =>
    (await app.harness.snapshot(ScheduleDoc, id, context))?.items[scheduleId]?.runs ?? 0;

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

    await restartLater(21);
    await until(async () => (await runs(id, schedule.id)) === 1, "the first sending");
    await answered(id, 1);
    assert.equal(summaries.length, 0, "the first sending compacts nothing");

    await say(app, id, "why did the briefing say that?");

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

    assert.equal((await app.harness.snapshot(AgentDoc, id, context))?.compaction, undefined);

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

test("repeats that compact first, due at the same time, leave the settings as they were", async () => {
    const id = await newSession(app);

    await say(app, id, `old work: ${"x".repeat(4000)}`);
    const made = await Promise.all(
        ["A", "B", "C"].map((name) =>
            app.commands.schedule(id, owner(app), {
                when: `every 20m briefing ${name}`,
                zone: "UTC",
                compactBefore: true,
            }),
        ),
    );
    const sent = async (count: number) =>
        (await Promise.all(made.map((each) => runs(id, each.id)))).every((n) => n === count);

    await restartLater(21);
    await until(() => sent(1), "the first sendings");
    await until(() => !app.isBusy(id), "idle");

    for (const count of [2, 3]) {
        await say(app, id, "more work in between");
        await restartLater(20);
        await until(() => sent(count), "the next sendings");
        await until(() => !app.isBusy(id), "idle");
    }

    await until(async () => {
        const live = await app.harness.snapshot(LiveDoc, id, context);

        return !app.isBusy(id) && (live?.compactions?.length ?? 0) === 0;
    }, "idle again");
    assert.equal(await ownCompaction(id), undefined);
});
