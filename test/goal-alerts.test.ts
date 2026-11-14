// What the end of a run pushes about a goal: a stop nobody asked for asks for a person, an active goal
// holds "Pi finished" back while it waits for what continues it, and everything else stays as it was.
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
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ObjectiveGoalDoc } from "../src/server/objective-goals.ts";
import { SubagentsDoc } from "../src/server/docs.ts";
import type { EmbedderMessage } from "../src/server/push.ts";

/** How long `runChanged` waits before it pushes: tests let that pass, or watch it not fire. */
const DONE_DELAY_MS = 3000;

/** Every embedder notification, with Web Push out of reach in tests: embedders on, `notifyEmbedders` recorded. */
function embedders(app: App): { userId: string; message: EmbedderMessage }[] {
    const sent: { userId: string; message: EmbedderMessage }[] = [];

    app.hasEmbedders = () => true;

    app.notifyEmbedders = (userId: string, message: EmbedderMessage) => {
        sent.push({ userId, message });

        return 1;
    };

    return sent;
}

/** The stored goal's own type, taken from the document's definition: no local copy of it to drift. */
type StoredGoal = NonNullable<
    ReturnType<(typeof ObjectiveGoalDoc)["definition"]["initial"]>["goal"]
>;

/** A stored goal as `#pushDone` reads it, with the fields the goal work sets. */
async function setGoal(
    app: App,
    id: ConversationId,
    goal: Pick<StoredGoal, "status"> & Partial<StoredGoal>,
): Promise<void> {
    await app.harness.commit(async (tx) => {
        const doc = await tx.doc(ObjectiveGoalDoc, id);

        doc.goal = {
            revision: crypto.randomUUID(),
            objective: "Keep the fixture working.",
            budget: null,
            turns: 1,
            emptyTurns: 0,
            tokens: 0,
            tokenBase: 0,
            startEntry: 1,
            lastEvidence: 1,
            activeMs: 1_000,
            ...goal,
        };
    }, context);
}

/** Give the pushed alert the moment `runChanged` waits for, and a little more. */
const quietFor = () => new Promise<void>((resolve) => setTimeout(resolve, DONE_DELAY_MS + 500));

async function session(app: App, title: string): Promise<ConversationId> {
    const id = await newSession(app);

    await app.commands.updateSession(id, owner(app), { title });

    return id;
}

after(cleanUp);

test("a goal that stopped by itself asks for a person, with its reason, also with no answer to show", async (t) => {
    const app = await openApp(scriptedModel(), join(root, "goal-alerts-attention"));

    t.after(() => app.close());
    const blocked = await session(app, "Blocked fixture");

    await say(app, blocked, "Some work toward the objective.");
    // A start a restart left without a run: no answer exists, and the alert goes out anyway.
    const orphan = await session(app, "Orphan fixture");
    // Goals stored before `needsAttention` existed: a block or a reached budget was always an automatic stop.
    const oldBlocked = await session(app, "Old block fixture");
    const oldBudget = await session(app, "Old budget fixture");
    const sent = embedders(app);

    await setGoal(app, blocked, {
        status: "blocked",
        reason: "A choice of approach is needed.",
        needsAttention: true,
    });
    await setGoal(app, orphan, {
        status: "paused",
        reason: "The server restarted during evaluation. Resume the goal to continue.",
        needsAttention: true,
    });
    await setGoal(app, oldBlocked, {
        status: "blocked",
        reason: "Validation P6 needs Word installed.",
    });
    await setGoal(app, oldBudget, {
        status: "budget",
        reason: "The goal's token budget was reached.",
    });

    for (const id of [blocked, orphan, oldBlocked, oldBudget]) {
        app.alerts.runChanged(id, false);
    }

    await until(() => sent.length >= 4, "the four goal alerts");

    const of = (id: ConversationId) =>
        sent.find((each) => each.message.tag === `done-${String(id)}`);
    const first = of(blocked);
    const second = of(orphan);
    const third = of(oldBlocked);
    const fourth = of(oldBudget);

    assert.ok(first && second && third && fourth);
    assert.equal(first.userId, owner(app).id);
    assert.equal(first.message.title, "Goal needs you · Blocked fixture");
    assert.equal(first.message.body, "A choice of approach is needed.");
    assert.equal(first.message.urgency, "high");
    assert.equal(first.message.url, `/s/${String(blocked)}`);
    assert.equal(second.message.title, "Goal needs you · Orphan fixture");
    assert.match(second.message.body, /server restarted during evaluation/);
    assert.equal(third.message.title, "Goal needs you · Old block fixture");
    assert.equal(third.message.body, "Validation P6 needs Word installed.");
    assert.equal(third.message.urgency, "high");
    assert.equal(fourth.message.title, "Goal needs you · Old budget fixture");
    assert.equal(fourth.message.body, "The goal's token budget was reached.");
});

test("the end of a run is what schedules a goal alert", async (t) => {
    const app = await openApp(scriptedModel(), join(root, "goal-alerts-wiring"));

    t.after(() => app.close());
    const id = await session(app, "Budget fixture");
    const sent = embedders(app);

    await setGoal(app, id, {
        status: "budget",
        reason: "The goal's token budget was reached.",
        needsAttention: true,
    });
    await say(app, id, "One more round");
    await until(() => sent.length > 0, "the alert the run's end scheduled");

    assert.equal(sent[0]!.message.title, "Goal needs you · Budget fixture");
    assert.equal(sent[0]!.message.body, "The goal's token budget was reached.");
    assert.equal(sent[0]!.message.urgency, "high");
});

test("an active goal waiting on a busy subagent sends no 'Pi finished' and stays active", async (t) => {
    // The subagent's run holds on this gate, so it stays busy — the goal's driver — until the test lets it go.
    let open: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
        open = resolve;
    });
    const model = scriptedModel((request) => {
        const { text } = lastText(request);

        return text.includes("Hold this answer.")
            ? held.then(() => fauxAssistantMessage(`echo: ${text}`))
            : fauxAssistantMessage(`echo: ${text}`);
    });

    const app = await openApp(model, join(root, "goal-alerts-active"));

    t.after(() => app.close());
    const parent = await session(app, "Waiting fixture");

    await say(app, parent, "Some work toward the objective.");
    const child = await newSession(app);
    const { submissionId } = await app.commands.submit(child, owner(app), {
        text: "Hold this answer.",
        requestId: crypto.randomUUID(),
    });

    await until(() => app.isBusy(child), "the subagent's run to be busy");
    // The parent's goal waits on that subagent, as one it dispatched does.
    await app.harness.commit(async (tx) => {
        const doc = await tx.doc(SubagentsDoc, parent);

        doc.agents.hold = { conversationId: child, reported: [] };
    }, context);
    const sent = embedders(app);

    await setGoal(app, parent, { status: "active" });
    app.alerts.runChanged(parent, false);
    await quietFor();

    assert.equal(sent.length, 0);
    // Still active: the busy subagent is what the goal waits for, not a stall to pause over.
    assert.equal(
        (await app.harness.snapshot(ObjectiveGoalDoc, parent, context))?.goal?.status,
        "active",
    );
    // Let the held run finish, so the app closes with nothing left running.
    open!();
    await (await app.harness.submission(submissionId, context))!.wait(context);
});

test("a completed goal and a pause someone asked for stay 'Pi finished'", async (t) => {
    const app = await openApp(scriptedModel(), join(root, "goal-alerts-ordinary"));

    t.after(() => app.close());
    const done = await session(app, "Completed fixture");
    const halted = await session(app, "Halted fixture");

    await say(app, done, "All the evidence is in.");
    await say(app, halted, "Work in progress.");
    const sent = embedders(app);

    await setGoal(app, done, { status: "completed", reason: "Both rounds produced evidence." });
    await setGoal(app, halted, { status: "paused", reason: "Paused by the user." });
    app.alerts.runChanged(done, false);
    app.alerts.runChanged(halted, false);
    await until(() => sent.length >= 2, "the two ordinary alerts");

    const of = (id: ConversationId) =>
        sent.find((each) => each.message.tag === `done-${String(id)}`);
    const first = of(done);
    const second = of(halted);

    assert.ok(first && second);
    assert.equal(first.message.title, "Pi finished · Completed fixture");
    assert.equal(first.message.urgency, "normal");
    assert.match(first.message.body, /^echo: /);
    assert.equal(second.message.title, "Pi finished · Halted fixture");
    assert.equal(second.message.urgency, "normal");
});

test("sessions without a goal keep 'Pi finished', and failures keep their error title", async (t) => {
    const app = await openApp(scriptedModel(), join(root, "goal-alerts-plain"));

    t.after(() => app.close());
    const finished = await session(app, "Plain fixture");
    const failed = await session(app, "Failed fixture");

    await say(app, finished, "Plain answer.");
    const sent = embedders(app);

    app.alerts.runChanged(finished, false);
    app.alerts.runChanged(failed, false, "The model request failed.");
    await until(() => sent.length >= 2, "the two plain alerts");

    const of = (id: ConversationId) =>
        sent.find((each) => each.message.tag === `done-${String(id)}`);
    const done = of(finished);
    const error = of(failed);

    assert.ok(done && error);
    assert.equal(done.message.title, "Pi finished · Plain fixture");
    assert.equal(done.message.urgency, "normal");
    assert.match(done.message.body, /^echo: /);
    assert.equal(error.message.title, "Pi stopped with an error · Failed fixture");
    assert.equal(error.message.body, "The model request failed.");
    assert.equal(error.message.urgency, "high");
});

test("a goal alert reaches its participants unless they turned 'done' off, are watching, or PiP reports it", async (t) => {
    const app = await openApp(scriptedModel(), join(root, "goal-alerts-people"));

    t.after(() => app.close());
    const id = await session(app, "People fixture");

    await say(app, id, "The owner's round.");
    const second = app.config.addUser("Second hand", "guest", [String(id)]).user;
    const third = app.config.addUser("Third hand", "guest", [String(id)]).user;

    // Submissions make them authors, so they take part and are told.
    for (const user of [second, third]) {
        const { submissionId } = await app.commands.submit(id, user, {
            text: `A round from ${user.name}.`,
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(submissionId, context))!.wait(context);
    }

    const sent = embedders(app);

    await setGoal(app, id, {
        status: "blocked",
        reason: "A decision is needed.",
        needsAttention: true,
    });
    // The owner turned "done" off, the second hand is watching, and their PiP reports to the third.
    app.pushStore!.setPrefs(owner(app).id, { done: false });
    app.watching = (userId: string) => userId === second.id;
    app.pip.reportsOn = async (_id: ConversationId, userId: string) => userId === third.id;
    app.alerts.runChanged(id, false);
    await quietFor();

    assert.equal(sent.length, 0);

    // Nothing of that holds anyone back anymore: all three participants are told.
    app.pushStore!.setPrefs(owner(app).id, { done: true });
    app.watching = () => false;
    app.pip.reportsOn = async () => false;
    app.alerts.runChanged(id, false);
    await until(() => sent.length >= 3, "the alert to every participant");

    assert.deepEqual(
        sent.map((each) => each.userId).sort(),
        [owner(app).id, second.id, third.id].sort(),
    );
    assert.ok(sent.every((each) => each.message.title === "Goal needs you · People fixture"));
});
