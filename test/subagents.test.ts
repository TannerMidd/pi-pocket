// Subagents' reports: they reach a working parent at its next pause, all those waiting together as one message, each
// once, without a turn of the parent's per report; a restart, a withdrawn batch, or a stale courier loses none. And
// what the subagents bar is told about each subagent, and its live peek.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
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
    const { role, text } = lastText(request as never);
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
