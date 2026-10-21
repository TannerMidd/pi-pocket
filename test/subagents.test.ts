// Subagents' reports: they reach a working parent at its next pause, all those waiting together as one message, each
// once, without a turn of the parent's per report; a restart, a stopped courier, or a withdrawn queue loses none. Who
// sees a subagent's peek and the board. Past a spend limit, reports wait, and go once it is raised.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
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
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { dealtWith } from "../src/server/commands.ts";
import { SubagentsDoc } from "../src/server/docs.ts";

/** What the parent does: the subagents it starts, then how many rounds of `sleep` it works through. */
let plan = { spawn: [] as string[], rounds: 0, sleep: 0.2 };
/** Subagents that run a `sleep` of so many seconds before they answer. */
let slow: Record<string, number> = {};
/** Subagents whose model fails once their tool round comes back, so their run ends in error mid-flight. */
let lateFail = new Set<string>();
let parentCalls = 0;
let rounds = 0;

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxToolCall(name, args);

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: said } = lastText(request as never);
    // With more than one person on the server, a message starts with who sent it.
    const text = said.replace(/^\[from: [^\]]+\] /, "");
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (subagent !== undefined) {
        if (lateFail.has(subagent) && role === "toolResult") {
            return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Bad request" });
        }

        if (slow[subagent] !== undefined && role !== "toolResult") {
            return fauxAssistantMessage([call("bash", { command: `sleep ${slow[subagent]}` })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText(`result of ${subagent}`)]);
    }

    parentCalls++;

    if (text === "orchestrate") {
        return fauxAssistantMessage(
            plan.spawn.map((name) =>
                call("subagent", { action: "spawn", name, message: `Check ${name}, please.` }),
            ),
            { stopReason: "toolUse" },
        );
    }

    const nudge = /^nudge (\S+)$/.exec(text);

    if (nudge !== null) {
        return fauxAssistantMessage(
            [
                call("subagent", {
                    action: "send",
                    name: nudge[1]!,
                    message: "One more thing.",
                    followUp: true,
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (rounds < plan.rounds) {
        rounds++;

        return fauxAssistantMessage([call("bash", { command: `sleep ${plan.sleep}` })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? "done working" : "noted")]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "subagents-data"));
});

// What the scripted model does starts plain in every test, however the one before ended.
beforeEach(() => {
    slow = {};
    lateFail = new Set();
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Start a session whose parent follows `next`. */
async function orchestrate(next: typeof plan, on = app): Promise<ConversationId> {
    plan = next;
    rounds = 0;
    parentCalls = 0;
    const id = await newSession(on);

    await on.commands.submit(id, owner(on), { text: "orchestrate", requestId: `go-${id}` });

    return id;
}

/** How many times the parent's context has each subagent's answer, in the messages it got (not its prompt's guide). */
async function delivered(id: ConversationId, on = app): Promise<Record<string, number>> {
    const text = JSON.stringify(
        (await (await on.harness.conversation(id, context))!.context(context)).messages.filter(
            (message) => message.role === "user",
        ),
    );
    const counts: Record<string, number> = {};

    for (const match of text.matchAll(/\[subagent (\S+) (?:answered|failed)/g)) {
        counts[match[1]!] = (counts[match[1]!] ?? 0) + 1;
    }

    return counts;
}

/** The messages the parent got, as one text. */
const parentText = async (id: ConversationId, on = app) =>
    JSON.stringify(
        (await (await on.harness.conversation(id, context))!.context(context)).messages.filter(
            (message) => message.role === "user",
        ),
    );

const queued = async (id: ConversationId, on = app) =>
    (await on.harness.snapshot(InboxDoc, id, context))?.items.length ?? 0;

const names = (count: number, prefix = "a") =>
    Array.from({ length: count }, (_, index) => `${prefix}${index}`);

test("reports reach a working parent at its next pause, together, each once, at one extra turn at most", async () => {
    const spawned = names(12);
    const id = await orchestrate({ spawn: spawned, rounds: 8, sleep: 0.2 });
    let most = 0;

    await until(
        async () => {
            most = Math.max(most, await queued(id));

            return (
                !app.isBusy(id) &&
                Object.keys(await delivered(id)).length === spawned.length &&
                (await queued(id)) === 0
            );
        },
        "every report",
        20_000,
    );
    assert.deepEqual(
        await delivered(id),
        Object.fromEntries(spawned.map((name) => [name, 1])),
        "each once",
    );
    assert.ok(most <= 1, `the parent's queue held ${most} of them at once`);
    // The work is 10 requests: the first, one after the spawns, 8 rounds. One report a turn would make it 22.
    assert.ok(parentCalls <= 11, `the parent was asked ${parentCalls} times`);
    const doc = await app.harness.snapshot(SubagentsDoc, id, context);

    assert.equal(doc?.courier, undefined, "the courier is done");
    assert.deepEqual(doc?.outbox ?? [], []);
    assert.equal(doc?.sending, undefined);
});

test("a report reaches an idle parent at once, and the parent answers it", async () => {
    const id = await orchestrate({ spawn: ["solo"], rounds: 0, sleep: 0 });

    await until(async () => (await delivered(id)).solo === 1 && !app.isBusy(id), "the report");
    const messages = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;

    assert.match(JSON.stringify(messages.at(-1)), /noted/);
});

test("reports waiting in the parent's queue across a restart arrive once", async () => {
    const data = join(root, "subagents-restart");
    let first: App | undefined = await openApp(scriptedModel(route), data);
    const id = await orchestrate({ spawn: names(3, "r"), rounds: 1, sleep: 3 }, first);

    try {
        await until(async () => (await queued(id, first)) === 1, "the reports waiting");
        await first.close();
        first = undefined;
        // The parent's `sleep` was cut off: it does not run again, and the parent goes on from there. The shared
        // app steps aside meanwhile: one app per data folder in the process.
        await app.close();
        app = await openApp(scriptedModel(route), data);
        await until(
            async () => Object.keys(await delivered(id)).length === 3 && !app.isBusy(id),
            "the reports after the restart",
            20_000,
        );
        assert.deepEqual(await delivered(id), { r0: 1, r1: 1, r2: 1 });
    } finally {
        await first?.close();
        // Closed already if the test failed after it stepped aside.
        await app.close().catch(() => {});
        app = await openApp(scriptedModel(route), join(root, "subagents-data"));
    }
});

test("a tab gets a subagent's peek, as for a session's tile; someone who cannot see the session does not", async () => {
    slow = { peeked: 3 };
    const id = await orchestrate({ spawn: ["peeked"], rounds: 0, sleep: 0 });
    const tab = fakeTab(id, owner(app));
    const guest = app.config.addUser("Scoped", "guest", ["999999"]);
    const outsider = fakeTab(undefined, guest.user);

    try {
        await until(
            async () =>
                (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.peeked !==
                undefined,
            "the subagent",
        );
        const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.peeked!
            .conversationId;

        await app.attach(tab.client);
        await app.attach(outsider.client);
        app.setPeeks(owner(app), tab.client.connection, [child]);
        app.setPeeks(guest.user, outsider.client.connection, [child]);
        await until(
            () =>
                tab.events.some(
                    (each) =>
                        each.event === "peek" &&
                        each.data.conversationId === child &&
                        JSON.stringify(each.data.lines).includes("sleep 3"),
                ),
            "the subagent's call in its peek",
        );
        assert.equal(outsider.events.filter((each) => each.event === "peek").length, 0);
    } finally {
        app.setPeeks(owner(app), tab.client.connection, []);
        app.detach(tab.client);
        app.detach(outsider.client);
        app.config.removeUser(guest.user.id);
        slow = {};
    }
});

/** A batch a courier took and then stopped with (faulted, or aborted): left in `sending`, the courier gone. */
async function stranded(id: ConversationId, request: string, text: string): Promise<void> {
    await app.harness.commit(async (tx) => {
        const state = await tx.doc(SubagentsDoc, id);

        state.sending = { request, reports: [{ name: "lost", text }] };
        state.courier = 999_998 as never;
    }, context);
}

test("a batch a stopped courier left behind is delivered once, by the next one", async () => {
    const id = await newSession(app);

    await stranded(
        id,
        "subagent-reports:999998:1",
        "[subagent lost answered, no reply needed] found",
    );
    // The next use of the subagent tool starts a courier, which sends the batch left behind first.
    plan = { spawn: ["next"], rounds: 0, sleep: 0 };
    rounds = 0;
    await app.commands.submit(id, owner(app), { text: "orchestrate", requestId: "stranded" });
    await until(async () => {
        const got = await delivered(id);

        return got.lost === 1 && got.next === 1 && !app.isBusy(id);
    }, "the batch left behind, then the new report");
    assert.equal((await app.harness.snapshot(SubagentsDoc, id, context))?.sending, undefined);
});

test("a batch a stopped courier had sent already is not sent again", async () => {
    const id = await newSession(app);
    const request = "subagent-reports:999998:7";
    const text = "[subagent lost answered, no reply needed] found once";

    // It went out before the courier stopped: the parent has it.
    await (await app.harness.conversation(id, context))!.submit(
        { type: "input", content: text, whenBusy: "steer", requestId: request },
        context,
    );
    await until(async () => (await delivered(id)).lost === 1 && !app.isBusy(id), "the batch");
    await stranded(id, request, text);
    plan = { spawn: ["after"], rounds: 0, sleep: 0 };
    rounds = 0;
    await app.commands.submit(id, owner(app), { text: "orchestrate", requestId: "sent" });
    await until(async () => (await delivered(id)).after === 1 && !app.isBusy(id), "the new report");
    assert.equal((await delivered(id)).lost, 1, "under its request id, it went once");
    assert.equal((await app.harness.snapshot(SubagentsDoc, id, context))?.sending, undefined);
});

test("a subagent whose run fails while a follow-up waits reports it, instead of waiting for an answer none brings", async () => {
    slow = { strand: 4 };
    lateFail = new Set(["strand"]);
    const id = await orchestrate({ spawn: ["strand"], rounds: 0, sleep: 0 });

    try {
        await until(async () => {
            const child = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.strand;

            return child !== undefined && app.isBusy(child.conversationId);
        }, "the subagent at work");
        const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.strand!
            .conversationId;

        // A follow-up while it works waits in its inbox for the run that would place it. Its run ends in error
        // instead, and Pi Durable leaves that inbox alone: nothing places it, and nothing ends the wait.
        await app.commands.submit(id, owner(app), {
            text: "nudge strand",
            requestId: `nudge-${id}`,
        });
        await until(async () => (await queued(child)) === 1, "the follow-up queued");

        await until(
            async () => (await delivered(id)).strand === 2 && !app.isBusy(id),
            "both reports",
            25_000,
        );
        assert.match(await parentText(id), /\[subagent strand failed: [^\]]*Bad request[^\]]*\]/);
        assert.match(
            await parentText(id),
            /\[subagent strand failed: went idle without taking the message/,
        );
        assert.equal(await queued(child), 0);

        await until(async () => {
            const graph = await app.harness.taskGraph(context);

            try {
                return !Object.values(graph.value.tasks).some(
                    (node) =>
                        node.kind === "pocket.subagent-reporter" && node.conversationId === id,
                );
            } finally {
                graph.dispose();
            }
        }, "no reporter left waiting");
    } finally {
        slow = {};
        lateFail = new Set();
    }
});

test("an open board loses the subagents of a session no longer shared, at once", async () => {
    const shared = await orchestrate({ spawn: ["kept"], rounds: 0, sleep: 0 });

    // The plan is read when the model answers: the first one's, before the next session's.
    await until(() => app.subagents().some((each) => each.name === "kept"), "the first subagent");
    const unshared = await orchestrate({ spawn: ["hidden"], rounds: 0, sleep: 0 });
    const guest = app.config.addUser("Narrowed", "guest");
    const tab = fakeTab(undefined, guest.user);
    const names = () =>
        ((tab.last("subagents") ?? []) as unknown as { name: string }[])
            .map((entry) => entry.name)
            .filter((name) => name === "kept" || name === "hidden")
            .sort();

    // Both answered, their reports delivered, and the parents idle: nothing more would send the board on its own.
    try {
        await until(
            async () =>
                app
                    .subagents()
                    .filter((each) => ["kept", "hidden"].includes(each.name) && !each.busy)
                    .length === 2 &&
                !app.isBusy(shared) &&
                !app.isBusy(unshared) &&
                (await delivered(unshared)).hidden === 1,
            "both subagents done",
            15_000,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await app.attach(tab.client);
        app.setBoard(guest.user, tab.client.connection, true);
        assert.deepEqual(names(), ["hidden", "kept"]);
        app.setAccess(owner(app), guest.user.id, { sessions: [String(shared)] });
        // Nothing else changes on the server: the change of access alone sends the board again.
        await until(
            () => isDeepStrictEqual(names(), ["kept"]),
            "the board without the other session",
            2000,
        );
        assert.ok(unshared !== shared);
    } finally {
        // One person again, as the tests after expect: with more, messages say who sent them.
        app.config.removeUser(guest.user.id);
    }
});

test("a subagent's name cannot close its quotes in the activity line", () => {
    const line = (shown: string) => `dealt with the failure of subagent “\u2068${shown}\u2069”`;

    // Quote marks, and controls that turn text around or hide.
    assert.equal(dealtWith(`a"b“c”d'e«f»g‹h›i＂j`), line("abcdefghij"));
    assert.equal(dealtWith("a\u202eb\u200bc\u2066d\u2069e\u0007f"), line("abcdef"));
});

/** The subagents document of `id`: why its reports wait, if they do, and what waits. */
const held = async (id: ConversationId) => {
    const doc = await app.harness.snapshot(SubagentsDoc, id, context);

    return {
        why: doc?.held,
        waiting: (doc?.outbox ?? []).length + (doc?.sending?.reports.length ?? 0),
    };
};

test("past its spend limit, an idle parent starts no turn for a report: it waits, says why, and goes once the limit is raised", async () => {
    slow = { paid: 2 };
    const id = await orchestrate({ spawn: ["paid"], rounds: 0, sleep: 0 });

    await until(
        async () =>
            (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.paid !== undefined &&
            !app.isBusy(id),
        "the subagent at work, the parent idle",
    );
    // Spent past a limit set now: nothing runs to be stopped, but nothing new may start.
    await recordCost(app, id, 2);
    await app.spend.setSessionBudget(owner(app), id, 1);
    await until(() => app.spend.heldBack(id) !== undefined, "the limit reached");
    await until(async () => (await held(id)).why !== undefined, "the report held back", 15_000);
    assert.match(String((await held(id)).why), /this session reached its \$1\.00 spend limit/);
    // Longer than a courier gathers for an idle parent: still nothing reached Pi, and Pi did not start.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.deepEqual(await delivered(id), {});
    assert.equal(app.isBusy(id), false);
    assert.equal(await queued(id), 0);
    assert.equal((await held(id)).waiting, 1);

    // Raised: it goes at once, once, and Pi answers it.
    await app.spend.setSessionBudget(owner(app), id, null);
    await until(
        async () => (await delivered(id)).paid === 1 && !app.isBusy(id),
        "the report, after the raise",
        10_000,
    );
    assert.deepEqual(await held(id), { why: undefined, waiting: 0 });
    slow = {};
});

test("reports taken out of the queue by something other than a person go again, and reach Pi once", async () => {
    const id = await orchestrate({ spawn: ["again-a", "again-b"], rounds: 1, sleep: 8 });

    await until(
        async () => (await queued(id)) === 1,
        "the reports in the busy parent's queue",
        15_000,
    );
    // Not Stop: the run ends as Pi Durable ends it, which withdraws what waits. The courier sends them again; as
    // anything queued while a run ends, they go to Pi with the next message.
    await (await app.harness.conversation(id, context))!.abort(context);
    await until(
        async () => !app.isBusy(id) && (await queued(id)) === 1 && (await held(id)).waiting === 2,
        "sent again, waiting",
        15_000,
    );
    await app.commands.submit(id, owner(app), { text: "and then?", requestId: `next-${id}` });
    await until(
        async () => {
            const got = await delivered(id);

            return got["again-a"] === 1 && got["again-b"] === 1 && !app.isBusy(id);
        },
        "both reports, once",
        15_000,
    );
    assert.deepEqual(await delivered(id), { "again-a": 1, "again-b": 1 });
});
