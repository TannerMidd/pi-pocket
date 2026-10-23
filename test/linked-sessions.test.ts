// Linked sessions (`linked-sessions.ts`): a repeat acts once, a link shares nothing, and the checks of whom Pi works for
// apply before anything is made or sent.
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
    root,
    recordCost,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LinkedSessionCallsDoc, LinkedSessionRelayDoc, TurnsDoc } from "../src/server/docs.ts";

let app: App;

before(async () => {
    const model = scriptedModel();

    // A model that thinks, so a linked session's thinking level has room to go too high.
    Object.assign(
        model.models.find((each) => each.id === "faux-1")!,
        { reasoning: true },
    );
    app = await openApp(model);
});
after(async () => {
    await app?.close();
    cleanUp();
});

/** A session with someone Pi works for: linked sessions act as them. */
async function source() {
    const id = await newSession(app);

    await say(app, id, "hello");

    return id;
}

const start = (id: ConversationId, key: string = crypto.randomUUID(), model?: string) =>
    app.linkedSessions.start(id, { title: "Linked", message: "a task", model }, key);
const send = (id: ConversationId, to: string, key: string = crypto.randomUUID()) =>
    app.linkedSessions.send(id, { to, message: "a message" }, key);
const sent = async (id: ConversationId) =>
    (await modelTexts(app, id)).filter(
        (text) => text.includes("<linked-session-message>") && !text.includes("echo:"),
    ).length;

test("linked sessions can work in another folder without moving the source", async () => {
    const id = await source();
    const original = app.cwdOf(id);
    const cwd = join(root, "specialist-repository");

    mkdirSync(cwd);
    const request = { message: "Work in the specialist repository", cwd };
    const { session } = await app.linkedSessions.start(id, request, "other-folder");

    assert.equal(app.cwdOf(session), cwd);
    assert.equal((await app.agentState(session))?.cwd, cwd);
    assert.equal(app.cwdOf(id), original);
    assert.equal((await app.linkedSessions.start(id, request, "other-folder")).session, session);
    const inherited = await start(id);

    assert.equal(app.cwdOf(inherited.session), original);
});

test("the first linked request loads the destination's project instructions and runs tools there", async () => {
    const origin = join(root, "context-source");
    const destination = join(root, "context-destination");

    mkdirSync(origin);
    mkdirSync(destination);
    writeFileSync(join(origin, "AGENTS.md"), "SOURCE_PROJECT_ONLY: Instructions for the source.");
    writeFileSync(
        join(destination, "AGENTS.md"),
        "DESTINATION_PROJECT_ONLY: Instructions for the destination.",
    );
    let firstRequest = "";
    const model = scriptedModel((request) => {
        const { text, role } = lastText(request as never);

        if (role === "user" && text.includes("RUN_DIRECTORY_PROBE")) {
            firstRequest ||= JSON.stringify(request);

            return fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText("Done.")]);
    });
    const isolated = await openApp(model, join(root, "context-data"));

    try {
        const source = await newSession(isolated, origin);

        await say(isolated, source, "Hello");
        const { session } = await isolated.linkedSessions.start(
            source,
            { cwd: destination, message: "RUN_DIRECTORY_PROBE" },
            "context-and-tools",
        );

        await until(() => !isolated.isBusy(session), "the directory probe to finish");
        assert.match(firstRequest, /DESTINATION_PROJECT_ONLY/);
        assert.doesNotMatch(firstRequest, /SOURCE_PROJECT_ONLY/);
        const view = await (await isolated.harness.conversation(session, context))!.context(
            context,
        );
        const result = view.messages.find((message) => message.role === "toolResult");

        assert(result && result.role === "toolResult", "the first turn ran its shell tool");
        assert.equal(result.isError, false);
        assert.equal(
            result.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("")
                .trim(),
            destination,
        );
        assert.equal(isolated.cwdOf(source), origin);
    } finally {
        await isolated.close();
    }
});

test("a blank working directory starts the linked session in the source's folder", async () => {
    const id = await source();

    for (const cwd of ["", "   "]) {
        const { session } = await app.linkedSessions.start(
            id,
            { message: "a task", cwd },
            crypto.randomUUID(),
        );

        assert.equal(app.cwdOf(session), app.cwdOf(id), `cwd ${JSON.stringify(cwd)}`);
    }
});

test("an invalid working directory creates no linked session", async () => {
    const id = await source();
    const file = join(root, "not-a-directory");

    writeFileSync(file, "file");
    const count = app.sessions().length;

    for (const cwd of [join(root, "missing-directory"), file]) {
        await assert.rejects(
            app.linkedSessions.start(id, { message: "a task", cwd }, crypto.randomUUID()),
            /isn't there|not a folder/,
        );
        assert.equal(app.sessions().length, count);
    }
});

test("a repeated start or send makes one session or one message", async () => {
    const id = await source();
    const { session: target, address } = await app.linkedSessions.start(
        id,
        { message: "a task", thinking: "high" },
        "start-key",
    );
    const count = app.sessions().length;

    // Never thinking harder than the session that started it, which is at "off".
    assert.equal((await app.agentState(target))?.thinkingLevel, "off");

    assert.equal((await start(id, "start-key")).session, target);
    assert.equal(app.sessions().length, count);
    await send(id, address, "send-key");
    await send(id, address, "send-key");
    await until(async () => (await sent(target)) > 1, "the messages");
    assert.equal(await sent(target), 2);
});

test("someone who cannot see the origin learns nothing of it and cannot reach it", async () => {
    const id = await source();

    await app.commands.updateSession(id, owner(app), { title: "Secret origin" });
    const { session: target } = await start(id);
    const { user } = app.config.addUser("Target only", "guest", [String(target)]);
    // Someone who sees the linked session but not the origin: the origin's name stays out of the list Pi gets.
    const [origin] = await app.linkedSessions.list(target);

    assert.ok(origin !== undefined && origin.title === undefined && origin.cwd === undefined);
    const tab = fakeTab(undefined, user);

    await app.attach(tab.client);
    // A later change goes out in a broadcast, which must be this person's own list too.
    await app.commands.updateSession(target, owner(app), { title: "Renamed" });
    const lists = () => tab.events.filter((each) => each.event === "sessions");

    await until(() => lists().length > 1, "a list");
    app.detach(tab.client);

    for (const list of [app.sessions(user), ...lists().map((each) => each.data)]) {
        assert.ok(!JSON.stringify(list).includes("Secret origin"));
        assert.ok(!JSON.stringify(list).includes(`"id":${Number(id)}`));
    }

    const { submissionId } = await app.commands.submit(target, user, {
        text: "hello",
        requestId: "guest",
    });

    // With Pi working for them in the linked session, its peers are out of reach.
    await (await app.harness.submission(submissionId, context))!.wait(context);
    assert.deepEqual(await app.linkedSessions.list(target), []);
    await assert.rejects(send(target, origin.address), /not linked/);
});

test("linked sessions exchange more than 10 turns, and no message count stops them", async () => {
    const id = await source();
    const { session: target, address } = await start(id);

    await until(async () => (await sent(target)) === 1, "the first message");
    const [origin] = await app.linkedSessions.list(target);

    // 12 turns each way: 25 messages with the first, past the 20 that stopped a team before 0.19.0.
    for (let turn = 0; turn < 12; turn++) {
        await send(target, origin!.address);
        await send(id, address);
    }

    await until(
        async () => (await sent(target)) === 13 && (await sent(id)) === 12,
        "every message of the exchange",
    );
    assert.equal((await app.harness.snapshot(LinkedSessionRelayDoc, id, context))?.sent, 25);

    // A count stored by an older Pi Pocket, at its old limit, stops nothing either.
    await app.harness.commit(async (tx) => {
        (await tx.doc(LinkedSessionRelayDoc, id)).sent = 20;
    }, context);
    await send(id, address);
    await start(id);
    await until(async () => (await sent(target)) === 14, "the message past the old limit");
});

test("a start or send is refused in plan mode, past a spend limit, or without the turn", async () => {
    const id = await source();
    const { session: target, address } = await start(id);
    const count = app.sessions().length;

    await until(async () => (await sent(target)) === 1, "the first message");
    await assert.rejects(start(target), /cannot start/);

    const refused = async (why: RegExp) => {
        await assert.rejects(start(id), why);
        await assert.rejects(send(id, address), why);
        assert.equal(app.sessions().length, count);
        assert.equal(await sent(target), 1);
    };

    await app.commands.setPlan(id, owner(app), true);
    await refused(/plan mode/);
    await app.commands.setPlan(id, owner(app), false);

    // What the linked session spent counts against the budget of the session that started it.
    await recordCost(app, target, 0.02);
    await until(() => app.spend.sessionSpent(target) === 0.02, "the spend");
    await app.spend.setSessionBudget(owner(app), id, 0.01);
    await refused(/spend limit/);
    await app.spend.setSessionBudget(owner(app), id, null);

    const driver = app.config.addUser("Driver", "guest").user;

    await app.harness.commit(async (tx) => {
        Object.assign(await tx.doc(TurnsDoc, id), { on: true, driver: driver.id, asks: [] });
    }, context);
    await refused(/driving/);
});

test("an unavailable model creates no session", async (t) => {
    const id = await source();
    const count = app.sessions().length;
    const key = "unavailable";

    // A model that is neither the session's own nor on the owner's list for subagents is refused.
    await assert.rejects(start(id, key, "faux/faux-2"), /not allowed/);
    await app.allowSubagentModel(owner(app), "faux/faux-2", true);
    t.mock.method(app.providers, "problem", async () => "its sign-in expired");
    await assert.rejects(start(id, key, "faux/faux-2"), /sign-in expired/);
    assert.equal(app.sessions().length, count);

    const token = createHash("sha256").update(`${id}:${key}`).digest("hex");

    assert.equal(
        (await app.harness.snapshot(LinkedSessionCallsDoc, id, context))?.items[token],
        undefined,
    );
});

test("with a list, a linked session runs only on a listed model: the source's if listed, else one must be named", async () => {
    const id = await source();
    const modelOf = async (session: ConversationId) =>
        (await app.agentState(session))?.model?.modelId;
    const me = owner(app);

    try {
        // No list: the source's model, and no other.
        await app.setSubagentModels(me, []);
        assert.equal(await modelOf((await start(id)).session), "faux-1");
        await assert.rejects(start(id, "no-list", "faux/faux-2"), /not allowed[^]*Do not pick/);

        // The source's model is listed: left out, it stays.
        await app.setSubagentModels(me, ["faux/faux-2", "faux/faux-1"]);
        assert.equal(await modelOf((await start(id)).session), "faux-1");
        assert.equal(await modelOf((await start(id, "named", "faux/faux-2")).session), "faux-2");

        // Not listed: a model must be named, from the list; the source's own model is refused when named.
        await app.setSubagentModels(me, ["faux/faux-2"]);
        const count = app.sessions().length;

        await assert.rejects(start(id, "none"), /A model is required[^]*faux\/faux-2/);
        await assert.rejects(start(id, "own", "faux/faux-1"), /not allowed[^]*never use another/);
        // A blank name is none; a name that is no model is off the list, and the fix is to choose.
        await assert.rejects(start(id, "blank", "  "), /A model is required[^]*faux\/faux-2/);
        await assert.rejects(
            start(id, "typo", "faux/nonesuch"),
            /not allowed[^]*never use another/,
        );
        assert.equal(app.sessions().length, count, "the refused starts made nothing");
        assert.equal(await modelOf((await start(id, "chosen", "faux/faux-2")).session), "faux-2");
    } finally {
        await app.setSubagentModels(me, []);
    }
});

test("with a list, a message goes only to a linked session that runs on a listed model", async () => {
    const id = await source();
    const me = owner(app);

    try {
        await app.setSubagentModels(me, ["faux/faux-1"]);
        const { session, address } = await start(id);

        await send(id, address, "taken-once");
        // The owner takes the list away from the model it runs on: no more work for it from another session.
        await app.setSubagentModels(me, ["faux/faux-2"]);
        await assert.rejects(send(id, address), /not one of the models the owner allows/);
        assert.equal((await app.agentState(session))?.model?.modelId, "faux-1");
        // A replay of the send already taken finds it, whatever the list is now.
        await send(id, address, "taken-once");

        // No list again: as before.
        await app.setSubagentModels(me, []);
        await send(id, address);
    } finally {
        await app.setSubagentModels(me, []);
    }
});

test("with a list, a linked session replies to the session that started it, whatever that one runs on", async () => {
    const id = await source();
    const me = owner(app);

    try {
        // The source runs on faux-1, which is not listed: it starts a worker on the listed faux-2.
        await app.setSubagentModels(me, ["faux/faux-2"]);
        const { session: worker, address } = await start(id, "worker", "faux/faux-2");

        await until(async () => (await sent(worker)) === 1, "the worker's first message");
        const [origin] = await app.linkedSessions.list(worker);

        // The worker's report goes back to its source.
        await send(worker, origin!.address);
        await until(async () => (await sent(id)) === 1, "the reply at the source");
        // Work still goes only to listed models: the source still sends to its worker.
        await send(id, address);
    } finally {
        await app.setSubagentModels(me, []);
    }
});

test("one session starts 12 linked sessions, and no count refuses one", async () => {
    const id = await source();

    // Past the 10 that one session could start before 0.19.0.
    for (let each = 0; each < 12; each++) {
        await start(id);
    }

    const started = app.sessions().filter((session) => session.linkedFrom?.id === Number(id));

    assert.equal(started.length, 12);
    assert.equal(new Set(started.map((session) => session.id)).size, 12);
});

test("a session that started others shows what counts against its limit: theirs too", async () => {
    const id = await source();
    const { session: child } = await start(id);

    await app.spend.setSessionBudget(owner(app), id, 1);
    await recordCost(app, id, 0.25);
    await recordCost(app, child, 0.5);

    const row = app.spend.summary(owner(app)).sessions.find((each) => each.id === Number(id));

    assert.equal(row?.spent, 0.75);
});
