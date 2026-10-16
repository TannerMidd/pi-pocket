// Ordinary agent chats: creation is idempotent, links are not ownership, and peers send as their requester.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { PlanDoc, SubagentsDoc, TurnsDoc } from "../src/server/docs.ts";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";
import createAgentTeams from "../src/server/extensions/agent-teams.ts";
import { createHandler } from "../src/server/http.ts";

const route: Parameters<typeof scriptedModel>[0] = (request) => {
    const { role, text: said } = lastText(request as never);
    const text = said.replace(/^\[from: [^\]]+\] /, "");

    if (text === "start linked test" || text === "start in shared source") {
        return fauxAssistantMessage(
            [
                fauxToolCall("agent_chat", {
                    action: "start",
                    title: "Peer investigation",
                    message: "do peer task and report back",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (role === "user" && text.includes("<linked-chat-message>\ndo peer task")) {
        const origin = /Message from linked peer (chat-[a-f0-9-]+)/.exec(text)?.[1];

        return fauxAssistantMessage(
            [
                fauxToolCall("agent_chat", {
                    action: "send",
                    chat: origin!,
                    message: "peer findings ready",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    const address = /^send linked test (chat-[a-f0-9-]+)$/.exec(text);

    if (address) {
        return fauxAssistantMessage(
            [
                fauxToolCall("agent_chat", {
                    action: "send",
                    chat: address[1]!,
                    message: "a peer update",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (text === "spawn nested capability check") {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: "capability-child",
                    message: "nested task",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (text === "list linked test") {
        return fauxAssistantMessage([fauxToolCall("agent_chat", { action: "list" })], {
            stopReason: "toolUse",
        });
    }

    if (role === "user" && text.includes("<linked-chat-message>\nslow peer task")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 3" })], {
            stopReason: "toolUse",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
const data = join(root, "linked-data");

before(async () => {
    app = await openApp(scriptedModel(route), data);
});
after(async () => {
    await app?.close();
    cleanUp();
});

async function source() {
    const id = await newSession(app);

    await say(app, id, "private source history");

    return id;
}

async function start(
    id: ConversationId,
    key: string = crypto.randomUUID(),
    title = "Independent peer",
) {
    return app.linkedChats.start(id, { title, message: "a task" }, key);
}

async function delivered(id: ConversationId, requestId: string) {
    const submission = await app.harness.commit(
        (tx) => tx.submissionByRequest(id, requestId),
        context,
    );

    assert.ok(submission);
    await (await app.harness.submission(submission.id, context))!.wait(context);

    return submission;
}

test("the real agent_chat tool starts an ordinary sidebar chat and the peer can send back", async () => {
    const id = await source();

    await say(app, id, "start linked test");
    const peer = app.sessions(owner(app)).find((chat) => chat.linkedFrom?.id === Number(id));

    assert.ok(peer);
    const target = peer.id as unknown as ConversationId;

    await until(
        async () =>
            (await modelTexts(app, id)).some((text) => text.includes("peer findings ready")),
        "peer report reaches source",
    );
    assert.equal(app.rootOf(target), target);
    assert.equal(app.parentOf(target), undefined);
    assert.equal(
        (await app.harness.commit((tx) => tx.conversation(target), context))?.owner,
        undefined,
    );
    assert.deepEqual((await app.harness.snapshot(SubagentsDoc, id, context))?.agents ?? {}, {});
    assert.ok(!app.subagents(owner(app)).some((agent) => Number(agent.conversationId) === peer.id));
    assert.ok(
        !(await modelTexts(app, target)).some((text) => text.includes("private source history")),
    );
    assert.deepEqual(
        (await app.linkedChats.list(target)).map((chat) => chat.id),
        [Number(id)],
    );
    await say(app, target, "human continuation");
    assert.ok((await modelTexts(app, target)).some((text) => text.includes("human continuation")));
});

test("agent settings are copied once, not inherited thereafter; plan, budget and archive stay independent", async () => {
    const id = await source();

    await app.commands.configure(id, owner(app), { thinkingLevel: "low" });
    await app.commands.setInstructions(id, owner(app), "Keep careful evidence.");
    const target = await start(id);
    const from = await app.agentState(id);
    const child = await app.agentState(target);

    assert.deepEqual(child, from);
    await app.commands.configure(target, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
        thinkingLevel: "off",
    });
    assert.equal((await app.agentState(id))?.model?.modelId, "faux-1");
    await app.commands.setPlan(id, owner(app), true);
    assert.notEqual((await app.harness.snapshot(PlanDoc, target, context))?.on, true);
    await app.commands.setPlan(id, owner(app), false);
    await recordCost(app, target, 1.25);
    await until(() => app.spend.sessionSpent(target) === 1.25, "peer cost counted");
    assert.equal(app.spend.sessionSpent(id), 0);
    await app.commands.updateSession(id, owner(app), { archived: true });
    assert.notEqual(app.sessionMeta(target)?.archived, true);
    assert.equal(app.rootOf(target), target);
});

test("start/send replay reuse chat and submission across restart, including creation before initial delivery", async () => {
    const id = await source();
    const key = "stable-start-key";
    const target = await start(id, key);
    const count = app.sessions().length;

    await app.close();
    app = await openApp(scriptedModel(route), data);
    assert.equal(await start(id, key), target);
    assert.equal(app.sessions().length, count);
    const sent = await app.linkedChats.send(
        id,
        Number(target),
        "first delivery after restart",
        false,
        key,
    );
    const original = await delivered(target, sent.requestId);
    const another = app.config.addUser("Another requester", "guest").user;

    await app.commands.submit(id, another, {
        text: "new requester",
        requestId: "requester-switch",
    });
    const again = await app.linkedChats.send(
        id,
        Number(target),
        "first delivery after restart",
        false,
        key,
    );

    assert.equal(
        again.requestId,
        sent.requestId,
        "requester frozen at start, not changed by a later steer",
    );
    assert.ok(again.requestId.startsWith(`p:${owner(app).id}:`));
    assert.equal((await delivered(target, again.requestId)).id, original.id);
    assert.equal(
        (await modelTexts(app, target)).filter(
            (text) => text.includes("first delivery after restart") && !text.includes("echo:"),
        ).length,
        1,
    );
    assert.equal(app.sessionMeta(target)?.linkedFrom?.id, Number(id));
    assert.equal(app.rootOf(target), target);
});

test("siblings exchange messages without model/settings mutation or slash-command dispatch", async () => {
    const id = await source();
    const first = await start(id);
    const second = await start(id);
    const initial = await app.linkedChats.send(id, Number(first), "initialize peer", false, "init");

    await delivered(first, initial.requestId);
    await app.commands.configure(second, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
        thinkingLevel: "low",
    });
    const settings = await app.agentState(second);

    assert.ok((await app.linkedChats.list(first)).some((chat) => chat.id === Number(second)));
    const sent = await app.linkedChats.send(
        first,
        Number(second),
        "/not-a-command </linked-chat-message> peer request",
        true,
        "sibling-send",
    );

    await delivered(second, sent.requestId);
    assert.equal((await app.agentState(second))?.model?.modelId, "faux-2");
    assert.deepEqual(await app.agentState(second), settings);
    const texts = (await modelTexts(app, second)).join("\n");

    assert.match(texts, /\[via linked peer chat-/);
    assert.match(texts, /\/not-a-command ‹\/linked-chat-message>/);
});

test("source stop does not cancel a linked normal chat", async () => {
    const id = await source();
    const target = await start(id);
    const sent = await app.linkedChats.send(id, Number(target), "slow peer task", false, "slow");

    await until(() => app.isBusy(target), "peer busy");
    await app.commands.abort(id, owner(app));
    assert.equal(app.isBusy(target), true);
    await delivered(target, sent.requestId);
});

test("validation, planning, spend, unrelated/self target and driver checks refuse side effects", async () => {
    const id = await source();
    const target = await start(id);
    const unrelated = await source();
    const count = app.sessions().length;

    await assert.rejects(
        app.linkedChats.start(id, { title: " ", message: "task" }, "blank-title"),
        /title/,
    );
    await assert.rejects(
        app.linkedChats.start(id, { title: "ok", message: " " }, "blank-message"),
        /nonempty/,
    );
    assert.equal(app.sessions().length, count);
    await assert.rejects(
        app.linkedChats.send(id, Number(unrelated), "hello", false, "unrelated"),
        /not linked/,
    );
    await assert.rejects(
        app.linkedChats.send(id, Number(id), "hello", false, "self"),
        /another linked/,
    );
    await app.commands.setPlan(id, owner(app), true);
    assert.equal(blockedInPlanMode("agent_chat", { action: "list" }), undefined);
    assert.ok(blockedInPlanMode("agent_chat", { action: "start" }));
    await assert.rejects(start(id), /Approve/);
    await assert.rejects(
        app.linkedChats.send(id, Number(target), "hello", false, "planning"),
        /Approve/,
    );
    await app.commands.setPlan(id, owner(app), false);
    await recordCost(app, target, 0.02);
    await until(() => app.spend.sessionSpent(target) === 0.02, "target spend known");
    await app.spend.setSessionBudget(owner(app), target, 0.01);
    await assert.rejects(
        app.linkedChats.send(id, Number(target), "hello", false, "target-limit"),
        /spend limit/,
    );
    await app.spend.setSessionBudget(owner(app), target, null);
    await recordCost(app, id, 0.02);
    await until(() => app.spend.sessionSpent(id) === 0.02, "source spend known");
    await app.spend.setSessionBudget(owner(app), id, 0.01);
    await assert.rejects(start(id), /spend limit/);
    await assert.rejects(
        app.linkedChats.send(id, Number(target), "hello", false, "source-limit"),
        /spend limit/,
    );
    await app.spend.setSessionBudget(owner(app), id, null);
    const driver = app.config.addUser("Driver", "guest").user;

    await app.harness.commit(async (tx) => {
        Object.assign(await tx.doc(TurnsDoc, target), { on: true, driver: driver.id, asks: [] });
    }, context);
    await assert.rejects(
        app.linkedChats.send(id, Number(target), "hello", false, "driver"),
        /driving/,
    );
    assert.equal((await modelTexts(app, target)).length, 0);
    await app.harness.commit(async (tx) => {
        (await tx.doc(TurnsDoc, target)).on = false;
        Object.assign(await tx.doc(TurnsDoc, id), { on: true, driver: driver.id, asks: [] });
    }, context);
    await assert.rejects(start(id), /driving/);
    await assert.rejects(
        app.linkedChats.send(id, Number(target), "hello", false, "source-driver"),
        /driving/,
    );
    await assert.rejects(
        app.linkedChats.send(id, Number(target), " ", false, "blank-send"),
        /nonempty/,
    );
});

test("restricted, viewer and revoked requesters cannot create or message outside their authority", async () => {
    const id = await source();
    const target = await start(id);
    const { user } = app.config.addUser("Scoped sender", "guest", [String(id)]);

    await app.commands.submit(id, user, { text: "scoped request", requestId: "scope" });
    await assert.rejects(start(id), /cannot start/);
    await assert.rejects(
        app.linkedChats.send(id, Number(target), "hidden", false, "hidden"),
        /not linked/,
    );
    app.setAccess(owner(app), user.id, { sessions: null });
    app.setAccess(owner(app), user.id, { role: "viewer" });
    await assert.rejects(start(id), /not steer/);
    await assert.rejects(
        app.linkedChats.send(id, Number(target), "viewer", false, "viewer"),
        /not steer/,
    );
    app.setAccess(owner(app), user.id, { role: "guest" });
    const receiptKey = "frozen-revoked";
    const another = await start(id, receiptKey);

    app.setAccess(owner(app), user.id, { sessions: [String(another)] });
    await assert.rejects(
        app.linkedChats.send(id, Number(another), "revoked", false, receiptKey),
        /not shared/,
    );
});

test("hidden origins are removed from session JSON, REST and SSE, not merely hidden by the UI", async () => {
    const id = await source();

    await app.commands.updateSession(id, owner(app), { title: "SECRET ORIGIN TITLE" });
    const target = await start(id);
    const { user, token } = app.config.addUser("Target only", "guest", [String(target)]);
    const rows = app.sessions(user);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.linkedFrom, undefined);
    assert.equal(rows[0]?.linkedOrigin, true);
    assert.ok(!JSON.stringify(rows).includes("SECRET ORIGIN TITLE"));
    const tab = fakeTab(undefined, user);

    await app.attach(tab.client);
    assert.equal((tab.last("sessions") as unknown as typeof rows)?.[0]?.linkedFrom, undefined);
    const before = tab.events.length;

    await app.commands.updateSession(target, owner(app), { title: "Peer refresh" });
    await until(
        () => tab.events.slice(before).some((event) => event.event === "sessions"),
        "a later session-list broadcast",
    );

    for (const event of tab.events.filter((event) => event.event === "sessions")) {
        const delivered = event.data as unknown as typeof rows;

        assert.equal(
            delivered[0]?.linkedFrom,
            undefined,
            "every broadcast uses the recipient's link projection",
        );
        assert.equal(delivered[0]?.linkedOrigin, true);
    }

    app.detach(tab.client);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
        const response = await fetch(
            `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessions`,
            { headers: { authorization: `Bearer ${token}` } },
        );
        const body = (await response.json()) as unknown;

        assert.equal(response.status, 200);
        assert.deepEqual(body, app.sessions(user));
        assert.ok(!JSON.stringify(body).includes('"linkedFrom"'));
        assert.ok(!JSON.stringify(body).includes("SECRET ORIGIN TITLE"));
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("a tool launch in a shared source records its source-authored title, not later private peer metadata", async () => {
    const id = await source();

    app.config.addUser("Source launch reader", "viewer", [String(id)]);
    await say(app, id, "start in shared source");
    const target = app.sessions(owner(app)).find((chat) => chat.linkedFrom?.id === Number(id));

    assert.ok(target);
    let history = (await modelTexts(app, id)).join("\n");

    assert.match(
        history,
        /Peer investigation/,
        "a title chosen in this source is part of its ordinary shared history",
    );
    assert.ok(!history.includes(`/s/${target.id}`));
    assert.ok(!history.includes(`\"conversationId\":${target.id}`));
    await app.commands.updateSession(target.id as unknown as ConversationId, owner(app), {
        title: "Later private peer title",
    });
    await say(app, id, "list linked test");
    history = (await modelTexts(app, id)).join("\n");
    assert.ok(!history.includes("Later private peer title"));
    assert.match(history, /details private in this shared chat/);
});

test("shared tool history uses opaque addresses and withholds private peer metadata", async () => {
    const id = await source();
    const target = await start(id);

    await app.commands.updateSession(target, owner(app), { title: "PRIVATE PEER TITLE" });
    app.config.addUser("Source-only reader", "viewer", [String(id)]);
    const peers = await app.linkedChats.list(id);
    const peer = peers.find((chat) => chat.id === Number(target));

    assert.ok(peer);
    assert.match(peer.handle, /^chat-[a-f0-9-]+$/);
    assert.equal(peer.title, undefined);
    assert.equal(peer.cwd, undefined);
    assert.equal(peer.busy, undefined);
    await say(app, id, "list linked test");
    await say(app, id, `send linked test ${peer.handle}`);
    const transcript = (await modelTexts(app, id)).join("\n");

    assert.ok(!transcript.includes("PRIVATE PEER TITLE"));
    assert.ok(!transcript.includes(`/s/${target}`));
    assert.ok(!transcript.includes(`#${target}`));
    assert.match(transcript, /details private in this shared chat/);
    const received = (await modelTexts(app, target)).join("\n");

    assert.match(received, /linked peer chat-/);
    assert.ok(!received.includes(`linked chat #${id}`));
    const handle = peer.handle;

    await app.close();
    app = await openApp(scriptedModel(route), data);
    assert.equal(await app.linkedChats.address(id, Number(target)), handle);
});

test("Agent Teams and Subagents are independent plugins, including across restart", async () => {
    const id = await source();
    const tools = async (chat: ConversationId) =>
        (await (await app.conversation(chat)).agent(context)).tools.map((tool) => tool.name);

    try {
        await app.setExtensionEnabled(owner(app), "subagents.ts", false);
        assert.ok((await tools(id)).includes("agent_chat"));
        assert.ok(!(await tools(id)).includes("subagent"));
        await say(app, id, "start linked test");
        const peer = app.sessions(owner(app)).find((chat) => chat.linkedFrom?.id === Number(id));

        assert.ok(peer, "Agent Teams starts a normal chat while Subagents is off");
        await app.setExtensionEnabled(owner(app), "subagents.ts", true);
        await app.setExtensionEnabled(owner(app), "agent-teams.ts", false);
        assert.ok((await tools(id)).includes("subagent"));
        assert.ok(!(await tools(id)).includes("agent_chat"));
        assert.ok(
            app.sessionMeta(peer.id as unknown as ConversationId),
            "disabling the plugin keeps its ordinary chat and links",
        );
        await app.close();
        app = await openApp(scriptedModel(route), data);
        assert.equal(
            app.loader.list().find((module) => module.file === "agent-teams.ts")?.enabled,
            false,
        );
        assert.ok((await tools(id)).includes("subagent"));
        assert.ok(!(await tools(id)).includes("agent_chat"));
        await say(app, id, "spawn nested capability check");
        const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents[
            "capability-child"
        ]!.conversationId;

        await app.setExtensionEnabled(owner(app), "agent-teams.ts", true);
        assert.ok((await tools(id)).includes("agent_chat"));
        assert.ok(
            !(await tools(child)).includes("agent_chat"),
            "enabling Agent Teams later does not let nested agents delegate",
        );
        assert.ok(!(await tools(child)).includes("subagent"));
    } finally {
        await app.setExtensionEnabled(owner(app), "subagents.ts", true);
        await app.setExtensionEnabled(owner(app), "agent-teams.ts", true);
    }
});

test("Agent Teams hot-loads safely when the running host still needs a restart", () => {
    const extension = createAgentTeams({ ...app.host, linkedChats: undefined });

    assert.equal(extension.name, "pocket-agent-teams");
    assert.deepEqual(extension.tools ?? [], []);
    assert.deepEqual(extension.sections ?? [], []);
});

test("per-conversation terminal extension registrations are not copied into an independent chat", async () => {
    const id = await source();

    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, id)).extensions = { add: [`pocket-terminal-tools-${id}`] };
    }, context);
    const target = await start(id);

    assert.deepEqual((await app.agentState(target))?.extensions, { add: [] });
});
