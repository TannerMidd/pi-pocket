// Subagents' reports: they reach a working parent at its next pause, all those waiting together as one message, each
// once, without a turn of the parent's per report; a restart, a withdrawn batch, or a stale courier loses none. And
// what the subagents bar is told about each subagent, and its live peek; and what the session list and the subagents
// board are told about every session's. Past a spend limit, reports wait, and go once it is raised.
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
import { after, before, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, InboxDoc, type TaskId } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";

/** What the parent does: the subagents it starts, then how many rounds of `sleep` it works through. */
let plan = { spawn: [] as string[], rounds: 0, sleep: 0.2 };
/** Subagents that run a `sleep` of so many seconds before they answer; and ones whose model fails. */
let slow: Record<string, number> = {};
let failing = new Set<string>();
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
        if (failing.has(subagent)) {
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
    const tab = fakeTab(id, owner(app));
    let most = 0;
    let reporting = false;

    await app.attach(tab.client);
    await until(
        async () => {
            most = Math.max(most, await queued(id));
            reporting ||= ((tab.field("subagents") ?? []) as { reporting?: boolean }[]).some(
                (agent) => agent.reporting === true,
            );

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
    // The bar said whose reports were on their way while they were, and says none are now.
    assert.ok(reporting, "the view said a report was on its way");
    await until(
        () =>
            ((tab.field("subagents") ?? []) as { reporting?: boolean }[]).every(
                (agent) => agent.reporting !== true,
            ),
        "no report on its way",
    );
    app.detach(tab.client);
});

test("a report reaches an idle parent at once, and the parent answers it", async () => {
    const id = await orchestrate({ spawn: ["solo"], rounds: 0, sleep: 0 });

    await until(async () => (await delivered(id)).solo === 1 && !app.isBusy(id), "the report");
    const messages = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;

    assert.match(JSON.stringify(messages.at(-1)), /noted/);
});

test("a person who withdraws waiting reports does not hold back later ones", async () => {
    slow = { later: 1 };
    const id = await orchestrate({ spawn: ["first", "later"], rounds: 1, sleep: 2.5 });

    // The first report waits in the queue while the parent sleeps; withdraw it.
    await until(async () => (await queued(id)) === 1, "the first report waiting");
    const item = (await app.harness.snapshot(InboxDoc, id, context))!.items[0]!;

    await app.commands.withdraw(id, owner(app), Number(item.id));
    await until(
        async () => (await delivered(id)).later === 1 && !app.isBusy(id),
        "the later report",
        15_000,
    );
    assert.equal((await delivered(id)).first, undefined);
    slow = {};
});

test("a courier that is gone does not strand reports: the next report starts another", async () => {
    const id = await newSession(app);

    await app.harness.commit(async (tx) => {
        (await tx.doc(SubagentsDoc, id)).courier = 999_999 as never;
    }, context);
    plan = { spawn: ["x", "y"], rounds: 0, sleep: 0 };
    rounds = 0;
    await app.commands.submit(id, owner(app), { text: "orchestrate", requestId: "stale" });
    await until(async () => {
        const got = await delivered(id);

        return got.x === 1 && got.y === 1 && !app.isBusy(id);
    }, "both reports");
});

test("a report a reporter from before 0.12 sent itself, before a restart cut it off, is not sent again", async () => {
    slow = { early: 2 };
    const id = await orchestrate({ spawn: ["early"], rounds: 0, sleep: 0 });
    let reporter: TaskId | undefined;

    await until(async () => {
        const graph = await app.harness.taskGraph(context);

        try {
            reporter = Object.values(graph.value.tasks).find(
                (node) => node.kind === "pocket.subagent-reporter" && node.conversationId === id,
            )?.id;
        } finally {
            graph.dispose();
        }

        return reporter !== undefined;
    }, "the reporter");
    // As 0.11's reporter sent it, under its own request, before it ended: the new one must see it went already.
    await (await app.harness.conversation(id, context))!.submit(
        {
            type: "input",
            content: "[subagent early answered, no reply needed] result of early",
            whenBusy: "followUp",
            requestId: `subagent-report:${reporter}`,
        },
        context,
    );
    await until(
        async () => {
            const graph = await app.harness.taskGraph(context);

            try {
                return graph.value.tasks[reporter!] === undefined && !app.isBusy(id);
            } finally {
                graph.dispose();
            }
        },
        "the reporter, done",
        15_000,
    );
    // Long enough for a courier's gather and send, had the report gone to the outbox too.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.deepEqual(await delivered(id), { early: 1 });
    assert.equal(await queued(id), 0);
    slow = {};
});

test("reports waiting in the parent's queue across a restart arrive once", async () => {
    const data = join(root, "subagents-restart");
    let first: App | undefined = await openApp(scriptedModel(route), data);
    const id = await orchestrate({ spawn: names(3, "r"), rounds: 1, sleep: 3 }, first);

    try {
        await until(async () => (await queued(id, first)) === 1, "the reports waiting");
        await first.close();
        first = undefined;
        // The parent's `sleep` was cut off: it does not run again, and the parent goes on from there.
        app = await openApp(scriptedModel(route), data);
        await until(
            async () => Object.keys(await delivered(id)).length === 3 && !app.isBusy(id),
            "the reports after the restart",
            20_000,
        );
        assert.deepEqual(await delivered(id), { r0: 1, r1: 1, r2: 1 });
    } finally {
        await first?.close();
        await app.close();
        app = await openApp(scriptedModel(route), join(root, "subagents-data"));
    }
});

test("the view tells the subagents bar what each was asked, when it answered, and which failed", async () => {
    failing = new Set(["broken"]);
    const id = await orchestrate({ spawn: ["fine", "broken"], rounds: 0, sleep: 0 });
    const tab = fakeTab(id, owner(app));

    try {
        await app.attach(tab.client);
        await until(
            async () => {
                const agents = (tab.field("subagents") ?? []) as { answeredAt?: number }[];

                return (
                    agents.length === 2 && agents.every((agent) => agent.answeredAt !== undefined)
                );
            },
            "both answers in the view",
            20_000,
        );
        const agents = tab.field("subagents") as {
            name: string;
            asked?: string;
            askedAt?: number;
            failed?: boolean;
            busy: boolean;
        }[];
        const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent]));

        assert.equal(byName.fine?.asked, "Check fine, please.");
        assert.equal(typeof byName.fine?.askedAt, "number");
        assert.equal(byName.fine?.failed, undefined);
        assert.equal(byName.broken?.failed, true);
        assert.match(String((byName.broken as { error?: string }).error), /Bad request/);
        assert.match(JSON.stringify(await delivered(id)), /"broken":1/);
        // Pi is told why, too.
        assert.match(await parentText(id), /\[subagent broken failed: [^\]]*Bad request[^\]]*\]/);
    } finally {
        app.detach(tab.client);
        failing = new Set();
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

test("reports that arrive while a batch waits in the queue join it: Pi gets them in one message", async () => {
    slow = { later: 0.6, last: 1.2 };
    const id = await orchestrate({ spawn: ["first", "later", "last"], rounds: 1, sleep: 3 });

    const names = async () => {
        const items = (await app.harness.snapshot(InboxDoc, id, context))?.items ?? [];

        return items.map((item) =>
            [...JSON.stringify(item).matchAll(/\[subagent (\S+) answered/g)].map(
                (match) => match[1],
            ),
        );
    };

    // While the parent sleeps, the queue holds one message, and it grows to all three.
    await until(
        async () => JSON.stringify(await names()) === '[["first","later","last"]]',
        "one row with all three",
        8_000,
    );
    await until(
        async () => Object.keys(await delivered(id)).length === 3 && !app.isBusy(id),
        "the reports",
        15_000,
    );
    assert.deepEqual(await delivered(id), { first: 1, later: 1, last: 1 }, "each once");
    const messages = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;
    const carrying = messages.filter(
        (message) =>
            message.role === "user" && JSON.stringify(message.content).includes("[subagent "),
    );

    assert.equal(carrying.length, 1, "in one message");
    slow = {};
});

test("a subagent that is stopped says so: Pi is told it will not answer", async () => {
    slow = { halted: 20 };
    const id = await orchestrate({ spawn: ["halted"], rounds: 0, sleep: 0 });
    const tab = fakeTab(id, owner(app));

    try {
        await app.attach(tab.client);
        await until(async () => {
            const child = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.halted;

            return child !== undefined && app.isBusy(child.conversationId);
        }, "the subagent at work");
        const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.halted!;

        await (await app.harness.conversation(child.conversationId, context))!.abort(context);
        await until(async () => (await delivered(id)).halted === 1, "its report");
        assert.match(
            await parentText(id),
            /\[subagent halted failed: stopped before it answered\]/,
        );
        await until(
            () =>
                ((tab.field("subagents") ?? []) as { name: string; stopped?: boolean }[]).some(
                    (agent) => agent.name === "halted" && agent.stopped === true,
                ),
            "the bar told it stopped",
        );
    } finally {
        app.detach(tab.client);
        slow = {};
    }
});

test("an idle parent gets reports that finish a moment apart in one message", async () => {
    slow = { s1: 0.1, s2: 0.3, s3: 0.5, s4: 0.7, s5: 0.9, s6: 1.1 };
    const id = await orchestrate({ spawn: Object.keys(slow), rounds: 0, sleep: 0 });

    await until(
        async () => Object.keys(await delivered(id)).length === 6 && !app.isBusy(id),
        "the six reports",
        15_000,
    );
    const messages = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;
    const carrying = messages.filter(
        (message) =>
            message.role === "user" && JSON.stringify(message.content).includes("[subagent "),
    );

    assert.equal(carrying.length, 1, "in one message, so Pi answers them once");
    slow = {};
});

test("the session list counts each session's subagents by state, and an open board gets every one", async () => {
    slow = { busy: 20, asks: 20, halts: 20 };
    failing = new Set(["broken"]);
    const id = await orchestrate({
        spawn: ["busy", "asks", "halts", "broken", "fine"],
        rounds: 0,
        sleep: 0,
    });
    const other = await newSession(app);
    const guest = app.config.addUser("Elsewhere", "guest", [String(other)]);
    const tab = fakeTab(undefined, owner(app));
    const outsider = fakeTab(undefined, guest.user);
    const records = async () =>
        (await app.harness.snapshot(SubagentsDoc, id, context))?.agents ?? {};
    const counts = () => app.sessions().find((each) => each.id === Number(id))?.subagents;

    type Entry = {
        id: number;
        name: string;
        busy: boolean;
        waiting?: boolean;
        approval?: { tool: string; subject: string };
        failed?: boolean;
        stopped?: boolean;
        error?: string;
    };
    const board = (of = tab) => (of.last("subagents") ?? []) as unknown as Entry[];

    try {
        await until(
            async () => {
                const agents = await records();

                return (
                    ["busy", "asks", "halts"].every(
                        (name) =>
                            agents[name] !== undefined && app.isBusy(agents[name].conversationId),
                    ) &&
                    agents.broken?.answeredAt !== undefined &&
                    agents.fine?.answeredAt !== undefined
                );
            },
            "three at work, two answered",
            20_000,
        );
        const agents = await records();

        await (await app.harness.conversation(agents.halts!.conversationId, context))!.abort(
            context,
        );
        void app.approvals
            .request(
                {
                    id: "board-ask",
                    conversationId: agents.asks!.conversationId,
                    taskId: 1 as never,
                    callId: "board-call",
                    tool: "bash",
                    subject: "git push",
                    reason: "risky",
                    createdAt: Date.now(),
                },
                context,
            )
            .catch(() => {});
        await until(
            () =>
                isDeepStrictEqual(counts(), {
                    working: 1,
                    waiting: 1,
                    stopped: 1,
                    failed: 1,
                    done: 1,
                }),
            "the counts in the session list",
            20_000,
        );
        assert.equal(
            app.sessions().find((each) => each.id === Number(other))?.subagents,
            undefined,
        );

        await app.attach(tab.client);
        await app.attach(outsider.client);
        app.setBoard(owner(app), tab.client.connection, true);
        app.setBoard(guest.user, outsider.client.connection, true);
        const mine = board().filter((entry) => entry.id === Number(id));
        const byName = Object.fromEntries(mine.map((entry) => [entry.name, entry]));

        assert.equal(mine.length, 5);
        assert.equal(byName.busy?.busy, true);
        assert.equal(byName.busy?.waiting, undefined);
        assert.equal(byName.asks?.waiting, true);
        assert.deepEqual(byName.asks?.approval, { tool: "bash", subject: "git push" });
        assert.equal(byName.halts?.stopped, true);
        assert.equal(byName.broken?.failed, true);
        assert.match(String(byName.broken?.error), /Bad request/);
        assert.equal(byName.fine?.busy, false);
        assert.equal(byName.fine?.failed, undefined);
        // Someone invited to another session sees none of these.
        assert.deepEqual(board(outsider), []);

        // While the board shows, each change comes with the session list.
        app.approvals.answer("board-ask", { allow: false, by: "test" });
        await until(
            () =>
                board().some(
                    (entry) => entry.name === "asks" && entry.id === Number(id) && !entry.waiting,
                ),
            "the board told the approval went",
        );

        // Closed, it gets no more.
        app.setBoard(owner(app), tab.client.connection, false);
        const sent = tab.events.filter((each) => each.event === "subagents").length;
        const lists = tab.events.filter((each) => each.event === "sessions").length;

        await (await app.harness.conversation(agents.busy!.conversationId, context))!.abort(
            context,
        );
        await until(
            () => tab.events.filter((each) => each.event === "sessions").length > lists,
            "the next session list",
        );
        assert.equal(tab.events.filter((each) => each.event === "subagents").length, sent);

        // Archived, a session's subagents leave the board once none works there.
        await (await app.harness.conversation(agents.asks!.conversationId, context))!.abort(
            context,
        );
        await until(
            () => app.subagents().every((entry) => entry.id !== Number(id) || !entry.busy),
            "nothing at work",
            20_000,
        );
        await app.commands.updateSession(id, owner(app), { archived: true });
        assert.equal(
            app.subagents().some((entry) => entry.id === Number(id)),
            false,
        );
    } finally {
        app.detach(tab.client);
        app.detach(outsider.client);
        app.config.removeUser(guest.user.id);
        slow = {};
        failing = new Set();
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

test("the board keeps a session's newest finished subagents, and every one that needs looking at", async () => {
    const id = await newSession(app);
    const old = Date.now() - 86_400_000;

    // Thirty done long ago, and one that failed: as a session that has run many.
    await app.harness.commit(async (tx) => {
        const doc = await tx.doc(SubagentsDoc, id);

        doc.agents = {
            ...Object.fromEntries(
                Array.from({ length: 30 }, (_, index) => [
                    `done-${index}`,
                    {
                        conversationId: (900_000 + index) as never,
                        reported: [],
                        asked: "Look.",
                        askedAt: old + index * 1000,
                        answeredAt: old + index * 1000 + 500,
                        failed: false,
                    },
                ]),
            ),
            broke: {
                conversationId: 900_100 as never,
                reported: [],
                asked: "Look.",
                askedAt: old,
                answeredAt: old + 100,
                failed: true,
                error: "Bad request",
            },
        };
    }, context);
    await until(
        () =>
            isDeepStrictEqual(app.sessions().find((each) => each.id === Number(id))?.subagents, {
                done: 30,
                failed: 1,
            }),
        "the session list counts them all",
    );
    const shown = app.subagents().filter((each) => each.id === Number(id));
    const done = shown.filter((each) => each.name.startsWith("done-")).map((each) => each.name);

    assert.equal(shown.length, 25);
    assert.ok(
        shown.some((each) => each.name === "broke"),
        "the one that failed always shows",
    );
    // The newest 24: the last 24 made.
    assert.deepEqual(
        done.sort(),
        Array.from({ length: 24 }, (_, index) => `done-${index + 6}`).sort(),
    );
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

test("reports waiting in the parent's queue when a spend limit stops it wait again, and go once the limit is raised", async () => {
    const id = await orchestrate({ spawn: ["queued-a", "queued-b"], rounds: 1, sleep: 8 });

    await until(
        async () => (await queued(id)) === 1,
        "the reports waiting in the busy parent's queue",
        15_000,
    );
    // Past the limit while it works: the run is stopped, and its queue withdrawn with it.
    await app.spend.setSessionBudget(owner(app), id, 1);
    await recordCost(app, id, 2);
    await until(() => !app.isBusy(id), "the parent stopped", 15_000);
    await until(async () => (await held(id)).why !== undefined, "the reports held back", 15_000);
    assert.equal((await held(id)).waiting, 2);
    assert.equal(await queued(id), 0);
    assert.deepEqual(await delivered(id), {});

    await app.spend.setSessionBudget(owner(app), id, null);
    await until(
        async () => {
            const got = await delivered(id);

            return got["queued-a"] === 1 && got["queued-b"] === 1 && !app.isBusy(id);
        },
        "both reports, after the raise",
        15_000,
    );
    assert.deepEqual(await delivered(id), { "queued-a": 1, "queued-b": 1 });
    assert.deepEqual(await held(id), { why: undefined, waiting: 0 });
});

test("reports a spend limit holds back still wait after a restart, and go once it is raised", async () => {
    const data = join(root, "subagents-held-restart");
    let first: App | undefined = await openApp(scriptedModel(route), data);

    // It answers once the limit is there.
    slow = { "kept-back": 3 };
    const id = await orchestrate({ spawn: ["kept-back"], rounds: 0, sleep: 0 }, first);
    const heldOn = async (on: App) => (await on.harness.snapshot(SubagentsDoc, id, context))?.held;

    try {
        await until(() => !first!.isBusy(id), "the parent idle");
        await recordCost(first, id, 2);
        await first.spend.setSessionBudget(owner(first), id, 1);
        // Before the report: the courier finds the limit when it comes.
        await until(async () => (await heldOn(first!)) !== undefined, "held back", 15_000);
        await first.close();
        first = undefined;
        await app.close();
        app = await openApp(scriptedModel(route), data);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.deepEqual(await delivered(id), {}, "nothing went at the restart");
        assert.match(String(await heldOn(app)), /spend limit/);
        await app.spend.setSessionBudget(owner(app), id, 5);
        await until(
            async () => (await delivered(id))["kept-back"] === 1 && !app.isBusy(id),
            "the report, after the raise",
            15_000,
        );
        assert.equal(await heldOn(app), undefined);
    } finally {
        slow = {};
        await first?.close();
        // Closed already if the test failed after it stepped aside.
        await app.close().catch(() => {});
        app = await openApp(scriptedModel(route), join(root, "subagents-data"));
    }
});

test("in a server older than the subagents module (one reloaded into it), reports still go, unheld", async () => {
    const host = app.host as Partial<typeof app.host>;
    const { heldBack, onLimitsChanged } = host;

    // As a server started before the module's change has it: the module reloads, the server's own part waits.
    delete host.heldBack;
    delete host.onLimitsChanged;
    await app.loader.reload("subagents.ts");

    try {
        const id = await orchestrate({ spawn: ["older"], rounds: 0, sleep: 0 });

        await until(
            async () => (await delivered(id)).older === 1 && !app.isBusy(id),
            "the report",
            15_000,
        );
    } finally {
        host.heldBack = heldBack;
        host.onLimitsChanged = onLimitsChanged;
        await app.loader.reload("subagents.ts");
    }
});

test("a courier that meets something unexpected says so once, waits, and goes on: the report is not stranded", async () => {
    const tab = fakeTab(undefined, owner(app));
    const heldBack = app.spend.heldBack.bind(app.spend);
    let failures = 0;

    await app.attach(tab.client);

    app.spend.heldBack = (...args) => {
        if (failures < 2) {
            failures++;

            throw new Error("the spend count is not ready");
        }

        return heldBack(...args);
    };

    try {
        const id = await orchestrate({ spawn: ["unlucky"], rounds: 0, sleep: 0 });

        await until(
            async () => (await delivered(id)).unlucky === 1 && !app.isBusy(id),
            "the report, after the courier tried again",
            20_000,
        );
        assert.equal(failures, 2);
        assert.equal(
            tab.events.filter(
                (each) =>
                    each.event === "notice" &&
                    String(each.data.message).includes("the spend count is not ready"),
            ).length,
            1,
            "said once",
        );
    } finally {
        app.spend.heldBack = heldBack;
    }
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

test("a person's Stop takes the reports in the queue with it, as it takes every message waiting there", async () => {
    const id = await orchestrate({ spawn: ["dropped"], rounds: 1, sleep: 8 });

    await until(
        async () => (await queued(id)) === 1,
        "the report in the busy parent's queue",
        15_000,
    );
    await app.commands.abort(id, owner(app));
    await until(() => !app.isBusy(id), "stopped");
    await until(
        async () => (await app.harness.snapshot(SubagentsDoc, id, context))?.courier === undefined,
        "the courier done",
        15_000,
    );
    assert.deepEqual(await delivered(id), {});
    assert.deepEqual(await held(id), { why: undefined, waiting: 0 });
});

test("a batch an earlier courier sent, and that was taken out of the queue before Pi had it, goes once the limit is raised", async () => {
    slow = { late: 2 };
    const id = await orchestrate({ spawn: ["late"], rounds: 1, sleep: 8 });

    try {
        // An earlier courier's batch, sent and then taken out of the queue, and the courier gone: as a fault leaves it.
        await until(() => app.isBusy(id), "the parent at work");
        const parent = (await app.harness.conversation(id, context))!;
        const ghost = await parent.submit(
            {
                type: "input",
                content: "[subagent ghost answered, no reply needed] ghost result",
                whenBusy: "steer",
                requestId: "subagent-reports:gone:1",
            },
            context,
        );

        await app.harness.abortSubmission(ghost.id, context, id);
        await app.harness.commit(async (tx) => {
            const state = await tx.doc(SubagentsDoc, id);

            state.courier = 999_999 as never;
            state.sending = {
                request: "subagent-reports:gone:1",
                reports: [
                    {
                        name: "ghost",
                        text: "[subagent ghost answered, no reply needed] ghost result",
                    },
                ],
            };
        }, context);
        // Past a limit now (which stops the parent and the subagent): the next report starts a courier, which holds.
        await app.spend.setSessionBudget(owner(app), id, 1);
        await recordCost(app, id, 2);
        await until(async () => (await held(id)).why !== undefined, "held back", 15_000);
        assert.equal(
            (await held(id)).waiting,
            2,
            "the earlier batch waits again, with the new report",
        );
        assert.deepEqual(await delivered(id), {});

        await app.spend.setSessionBudget(owner(app), id, null);
        await until(
            async () => {
                const got = await delivered(id);

                return got.ghost === 1 && got.late === 1 && !app.isBusy(id);
            },
            "both, after the raise",
            15_000,
        );
        assert.deepEqual(await delivered(id), { ghost: 1, late: 1 });
    } finally {
        slow = {};
    }
});

test("past a person's spend limit, reports their work led to wait, saying whose limit, and go once it is raised", async () => {
    const payer = app.config.addUser("Paying", "guest");

    try {
        slow = { theirs: 2 };
        plan = { spawn: ["theirs"], rounds: 0, sleep: 0 };
        rounds = 0;
        const id = await newSession(app);

        await app.commands.submit(id, payer.user, { text: "orchestrate", requestId: `paid-${id}` });
        await until(
            async () =>
                (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.theirs !==
                    undefined && !app.isBusy(id),
            "the subagent at work, the parent idle",
        );
        await recordCost(app, id, 2);
        app.spend.setPersonBudget(owner(app), payer.user.id, 1);
        await until(async () => (await held(id)).why !== undefined, "held back", 15_000);
        assert.match(String((await held(id)).why), /^Paying reached their \$1\.00 spend limit$/);
        assert.deepEqual(await delivered(id), {});

        app.spend.setPersonBudget(owner(app), payer.user.id, null);
        await until(
            async () => (await delivered(id)).theirs === 1 && !app.isBusy(id),
            "the report, after the raise",
            15_000,
        );
    } finally {
        slow = {};
        app.config.removeUser(payer.user.id);
    }
});
