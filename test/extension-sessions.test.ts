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

const row = (id: ConversationId) => app.sessions().find((session) => session.id === Number(id));

test("start makes a top-level session in the given folder, with the given title, model, and thinking", async () => {
    const id = await source();
    const cwd = join(root, "ordinary-folder");

    mkdirSync(cwd);
    await app.allowSubagentModel(owner(app), "faux/faux-2", false);
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
});

test("a message is sent once, as an ordinary input from the person", async () => {
    const id = await source();
    const { session } = await app.extensionSessions.start(
        id,
        { title: "Noted", message: "look here" },
        "noted",
    );

    await until(
        async () => (await modelTexts(app, session)).some((text) => text.includes("look here")),
        "the message",
    );
    const texts = await modelTexts(app, session);
    const own = texts.filter((text) => text.includes("look here"));

    assert.equal(own.length, 1);
    assert.equal(own[0]?.includes("[via "), false);
    assert.equal(own[0]?.includes("<linked-session-message>"), false);
    assert.equal(
        (await app.extensionSessions.start(id, { message: "look here" }, "noted")).session,
        session,
    );
    assert.equal(
        (await modelTexts(app, session)).filter((text) => text.includes("look here")).length,
        1,
    );
});

test("a repeat with the same key returns the same session and does not send the message again", async () => {
    const id = await source();
    const request = { title: "Once", cwd: work, message: "only once" };
    const { session } = await app.extensionSessions.start(id, request, "once");
    const count = app.sessions().length;

    await until(
        async () => (await modelTexts(app, session)).some((text) => text.includes("only once")),
        "the first",
    );
    assert.equal((await app.extensionSessions.start(id, request, "once")).session, session);
    assert.equal(app.sessions().length, count);
    assert.equal(
        (await modelTexts(app, session)).filter((text) => text.includes("only once")).length,
        1,
    );
});

test("two starts at once with the same key make one session", async () => {
    const id = await source();
    const count = app.sessions().length;
    const request = { title: "Raced", cwd: work, message: "once between them" };
    const [first, second] = await Promise.all([
        app.extensionSessions.start(id, request, "raced"),
        app.extensionSessions.start(id, request, "raced"),
    ]);

    assert.equal(first.session, second.session);
    assert.equal(app.sessions().length, count + 1);
    await until(
        async () =>
            (await modelTexts(app, first.session)).some((text) =>
                text.includes("once between them"),
            ),
        "the one message",
    );
    assert.equal(
        (await modelTexts(app, first.session)).filter((text) => text.includes("once between them"))
            .length,
        1,
    );
});

test("an unknown model, or a folder that does not exist, is refused and leaves no session", async () => {
    const id = await source();
    const count = app.sessions().length;
    const file = join(root, "ordinary-file");

    writeFileSync(file, "file");

    for (const request of [
        { model: "faux/missing" },
        { model: "no-such" },
        { cwd: join(root, "missing-ordinary") },
        { cwd: file },
    ]) {
        await assert.rejects(
            app.extensionSessions.start(id, request, crypto.randomUUID()),
            /not available|isn't there|not a folder|provider\/modelId/,
        );
        assert.equal(app.sessions().length, count);
    }
});

test("a source past its spend limit, an invited person, and a PiP source are refused", async () => {
    const id = await source();
    const count = app.sessions().length;
    const invited = app.config.addUser("Invited", "guest", [String(id)]).user;

    const { submissionId } = await app.commands.submit(id, invited, {
        text: "mine",
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
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

    await assert.rejects(
        app.extensionSessions.start(pip, { title: "No" }, "pip"),
        /Pi works for someone/,
    );
    assert.equal(app.sessions().length, count);
});

test("the new session can itself start a linked session", async () => {
    const id = await source();
    const { session } = await app.extensionSessions.start(
        id,
        { title: "Top", message: "begin" },
        "top",
    );

    await until(
        async () => (await modelTexts(app, session)).some((text) => text.includes("begin")),
        "its message",
    );
    const { session: linked } = await app.linkedSessions.start(
        session,
        { title: "Child", message: "a task" },
        "child",
    );

    assert.equal(app.sessionMeta(session)?.linkedFrom, undefined);
    assert.equal(app.sessionMeta(linked)?.linkedFrom?.id, Number(session));
    assert.equal(row(linked)?.linkedFrom?.id, Number(session));
});
