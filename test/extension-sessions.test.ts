// Ordinary sessions an extension starts (`extension-sessions.ts`): a top-level session, like New session, made once
// for a key, with the checks of the person Pi works for applied before anything is made.
import {
    type App,
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";

let app: App;

before(async () => {
    const model = scriptedModel();

    // Before the app copies the provider: a change after that never reaches the model it starts sessions on.
    Object.assign(
        model.models.find((each) => each.id === "faux-2")!,
        { reasoning: true },
    );
    app = await openApp(model);
});
after(async () => {
    await app?.close();
    cleanUp();
});

/** A session with someone Pi works for: the start acts as them. */
async function source() {
    const id = await newSession(app);

    await say(app, id, "hello");

    return id;
}

/** `person` writes in `id`, and Pi answers: Pi then works for them there. */
async function writes(id: ConversationId, person: User, text: string) {
    const { submissionId } = await app.commands.submit(id, person, {
        text,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

/** The messages in `id` that have `words`, without the scripted model's echo of them. */
const told = async (id: ConversationId, words: string) =>
    (await modelTexts(app, id)).filter((text) => text.includes(words) && !text.includes("echo: "));

const row = (id: ConversationId) => app.sessions().find((session) => session.id === Number(id));

test("start makes a top-level session in the given folder, with the given title, model, and thinking", async () => {
    const id = await source();
    const cwd = join(root, "ordinary-folder");

    mkdirSync(cwd);
    // A list for subagents without faux-2: it does not apply here.
    await app.allowSubagentModel(owner(app), "faux/faux-1", true);
    const { session } = await app.extensionSessions.start(
        id,
        { title: "Project", cwd, model: "faux/faux-2", thinking: "high" },
        "placed",
    );
    const listed = row(session);
    const agent = await app.agentState(session);

    assert.equal(app.cwdOf(session), cwd);
    assert.equal(agent?.cwd, cwd);
    assert.equal(agent?.model?.modelId, "faux-2");
    assert.equal(agent?.thinkingLevel, "high");
    assert.equal(listed?.title, "Project");
    assert.equal(listed?.linkedFrom, undefined);
    assert.equal(app.sessionMeta(session)?.linkedFrom, undefined);
    assert.equal(app.cwdOf(id), work);
    await app.setSubagentModels(owner(app), []);

    // No model named: lowered to a level that the default model (faux-1, no reasoning) has.
    const plain = await app.extensionSessions.start(id, { thinking: "xhigh" }, "plain");

    assert.equal((await app.agentState(plain.session))?.thinkingLevel, "off");
});

test("a message is sent as an ordinary input from the person", async () => {
    const id = await source();
    const { session } = await app.extensionSessions.start(
        id,
        { title: "Noted", message: "look here" },
        "noted",
    );

    await until(async () => (await told(session, "look here")).length > 0, "the message");
    const own = await told(session, "look here");

    assert.equal(own.length, 1);
    assert.equal(own[0]?.includes("[via "), false);
    assert.equal(own[0]?.includes("<linked-session-message>"), false);
});

test("a repeat returns the first session, as the first person, though a check now refuses", async () => {
    const id = await source();
    const request = { title: "Once", cwd: work, message: "only once" };
    const { session } = await app.extensionSessions.start(id, request, "once");
    const count = app.sessions().length;

    await until(async () => (await told(session, "only once")).length > 0, "the first");
    // Someone else is now the person Pi works for there, and the source is past its spend limit.
    await writes(id, app.config.addUser("Later", "guest").user, "mine now");
    await recordCost(app, id, 0.02);
    await until(() => app.spend.sessionSpent(id) === 0.02, "the spend");
    await app.spend.setSessionBudget(owner(app), id, 0.01);
    assert.equal((await app.extensionSessions.start(id, request, "once")).session, session);
    assert.equal(app.sessions().length, count);
    assert.equal((await told(session, "only once")).length, 1);
});

test("two starts at once with the same key make one session and send its message once", async () => {
    const id = await source();
    const count = app.sessions().length;
    const request = { title: "Raced", cwd: work, message: "once between them" };
    const other = app.config.addUser("Racer", "guest").user;
    const requesterOf = app.attribution.requesterOf.bind(app.attribution);
    let reads = 0;

    // Someone else writes between the two calls: the second one reads them as the requester.
    app.attribution.requesterOf = (source) => (reads++ === 1 ? other.id : requesterOf(source));
    const [first, second] = await Promise.all([
        app.extensionSessions.start(id, request, "raced"),
        app.extensionSessions.start(id, request, "raced"),
    ]).finally(() => (app.attribution.requesterOf = requesterOf));

    assert.equal(first.session, second.session);
    assert.equal(app.sessions().length, count + 1);
    await until(async () => (await told(first.session, "between")).length > 0, "the message");
    // A second message would run after the first: wait until nothing runs.
    await until(() => !app.isBusy(first.session), "the session at rest");
    assert.equal((await told(first.session, "between")).length, 1);
});

test("an unknown model, a missing folder, or a first message submit refuses leaves no session", async () => {
    const id = await source();
    const count = app.sessions().length;
    const file = join(root, "ordinary-file");

    writeFileSync(file, "file");

    for (const request of [
        { model: "faux/missing" },
        { model: "no-such" },
        { cwd: join(root, "missing-ordinary") },
        { cwd: file },
        { message: "  " },
    ]) {
        await assert.rejects(
            app.extensionSessions.start(id, request, crypto.randomUUID()),
            /not available|isn't there|not a folder|provider\/modelId|empty/,
        );
        assert.equal(app.sessions().length, count);
    }

    const last = app.config.lastModel;

    // No model a new session gets: `Commands.submit` would refuse the message after the session is made.
    app.config.lastModel = undefined;
    await assert.rejects(
        app.extensionSessions.start(id, { message: "hi" }, "none"),
        /Pick a model/,
    );
    app.config.lastModel = last;
    assert.equal(app.sessions().length, count);
});

test("a source past its spend limit, an invited person, and a PiP source are refused", async () => {
    const id = await source();
    const count = app.sessions().length;
    const invited = app.config.addUser("Invited", "guest", [String(id)]).user;

    await writes(id, invited, "mine");
    await assert.rejects(
        app.extensionSessions.start(id, { title: "No" }, "invited"),
        /one session/,
    );
    assert.equal(app.sessions().length, count);

    await say(app, id, "the owner writes again");
    await recordCost(app, id, 0.02);
    await until(() => app.spend.sessionSpent(id) === 0.02, "the spend");
    await app.spend.setSessionBudget(owner(app), id, 0.01);
    await assert.rejects(app.extensionSessions.start(id, { title: "No" }, "spent"), /spend limit/);
    assert.equal(app.sessions().length, count);
    await app.spend.setSessionBudget(owner(app), id, null);

    const pip = await app.pip.ensure(owner(app));

    // Its person wrote there, so Pi works for someone: PiP itself is refused.
    await writes(pip, owner(app), "from my PiP");
    await assert.rejects(
        app.extensionSessions.start(pip, { title: "No" }, "pip"),
        /Pi works for someone/,
    );
    assert.equal(app.sessions().length, count);
});

test("a key also given to linkedSessions.start starts its own ordinary session", async () => {
    const id = await source();
    const linked = await app.linkedSessions.start(id, { message: "a task" }, "shared");
    const { session } = await app.extensionSessions.start(id, { title: "Own" }, "shared");

    assert.notEqual(session, linked.session);
    assert.equal(app.sessionMeta(session)?.linkedFrom, undefined);
});
