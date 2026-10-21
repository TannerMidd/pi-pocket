// Linked sessions (`linked-sessions.ts`): a repeat acts once, a link shares nothing, and the checks of whom Pi works for
// apply before anything is made or sent.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    modelTexts,
    newSession,
    openApp,
    owner,
    recordCost,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
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

    // Twenty messages between the team's sessions with no person writing: no more until one does.
    await app.harness.commit(async (tx) => {
        (await tx.doc(LinkedSessionRelayDoc, id)).sent = 20;
    }, context);
    await refused(/without a person/);

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

test("a session that started others shows what counts against its limit: theirs too", async () => {
    const id = await source();
    const { session: child } = await start(id);

    await app.spend.setSessionBudget(owner(app), id, 1);
    await recordCost(app, id, 0.25);
    await recordCost(app, child, 0.5);

    const row = app.spend.summary(owner(app)).sessions.find((each) => each.id === Number(id));

    assert.equal(row?.spent, 0.75);
});
