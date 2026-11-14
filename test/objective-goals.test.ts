import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";

const evaluatorMarker = "[Pi Pocket Goal Evaluator]";

function isEvaluator(request: Pick<Context, "messages">): boolean {
    return request.messages.some(
        (message) =>
            message.role === "system" && JSON.stringify(message.content).includes(evaluatorMarker),
    );
}

function verdict(decision: "continue" | "met" | "blocked", reason: string) {
    return fauxAssistantMessage(JSON.stringify({ verdict: decision, reason }));
}

async function session(app: App): Promise<ConversationId> {
    const id = await newSession(app);

    await app.commands.updateSession(id, owner(app), { title: "Objective Goal fixture" });

    return id;
}

async function goal(app: App, id: ConversationId, args: string): Promise<string> {
    const result = await app.objectiveGoals.command(id, owner(app), args, crypto.randomUUID());

    return result.message;
}

async function waitForIdle(app: App, id: ConversationId): Promise<void> {
    await (await app.conversation(id)).waitForIdle(context);
}

after(cleanUp);

test("the goal endpoint starts work once per request, evaluates independently, and remembers completion", async (t) => {
    const work: string[] = [];
    const evaluations: string[] = [];
    const model = scriptedModel((request) => {
        const { text } = lastText(request);

        if (isEvaluator(request)) {
            evaluations.push(text);

            return evaluations.length === 1
                ? verdict("continue", "Round two evidence is still missing.")
                : verdict("met", "Both rounds produced evidence.");
        }

        work.push(JSON.stringify(request.messages));

        return fauxAssistantMessage(`Artifact evidence from round ${work.length}.`);
    });
    const data = join(root, "objective-goal-completion");
    let app = await openApp(model, data);

    t.after(() => app.close());
    const id = await session(app);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    assert.ok(address !== null && typeof address !== "string");
    const requestId = crypto.randomUUID();
    const sendGoal = (token: string) =>
        fetch(`http://127.0.0.1:${address.port}/api/c/${id}/objective-goal`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                "x-pocket": "1",
            },
            body: JSON.stringify({ args: "Gather evidence from both rounds.", requestId }),
        });
    const viewerToken = app.config.addUser("Read-only viewer", "viewer").token;

    assert.equal((await sendGoal(viewerToken)).status, 403);
    assert.equal((await sendGoal(app.config.ownerToken)).status, 200);
    await until(() => evaluations.length >= 2, "the two independent goal evaluations");
    await waitForIdle(app, id);

    assert.equal(work.length, 2);
    assert.match(work[0]!, /Gather evidence from both rounds/);
    assert.match(evaluations[0]!, /Artifact evidence from round 1/);
    assert.match(evaluations[1]!, /Artifact evidence from round 2/);
    assert.doesNotMatch((await modelTexts(app, id)).join("\n"), /\\?"verdict\\?":/);
    assert.match(await goal(app, id, "status"), /Completed/);
    await assert.rejects(goal(app, id, "edit An unverified objective."), { status: 409 });
    assert.match(await goal(app, id, "status"), /Objective: Gather evidence from both rounds\./);
    assert.equal((await sendGoal(app.config.ownerToken)).status, 200);
    await waitForIdle(app, id);
    assert.equal(work.length, 2);

    await app.close();
    app = await openApp(model, data);
    assert.match(await goal(app, id, "status"), /Completed/);
    assert.equal(evaluations.length, 2);
});

test("pause stops an in-flight evaluator from continuing, and resume and clear work", async (t) => {
    let work = 0;
    let evaluations = 0;
    const firstEvaluation = Promise.withResolvers<void>();
    const model = scriptedModel(async (request) => {
        if (!isEvaluator(request)) {
            work++;

            return fauxAssistantMessage("Checked fixture evidence.");
        }

        evaluations++;

        if (evaluations === 1) {
            await firstEvaluation.promise;

            return verdict("continue", "Do another check.");
        }

        return verdict("met", "Evidence confirmed.");
    });
    const app = await openApp(model, join(root, "objective-goal-pause"));

    t.after(() => app.close());
    const id = await session(app);
    let pausedTokens = 0;

    try {
        await goal(app, id, "Verify the goal fixture.");
        await until(() => evaluations === 1, "the first evaluator to start");
        await goal(app, id, "pause");
        const paused = await goal(app, id, "status");

        assert.match(paused, /Paused/);
        pausedTokens = Number(/^Tokens: (\d+)/m.exec(paused)?.[1]);
        assert.ok(Number.isSafeInteger(pausedTokens));
    } finally {
        firstEvaluation.resolve();
    }

    await waitForIdle(app, id);
    assert.equal(work, 1);
    const settled = await goal(app, id, "status");
    const settledTokens = Number(/^Tokens: (\d+)/m.exec(settled)?.[1]);

    assert.ok(settledTokens > pausedTokens, "the paused goal still pays for its evaluator");
    await goal(app, id, `budget ${settledTokens}`);
    await assert.rejects(goal(app, id, "resume"), { status: 409 });
    await goal(app, id, "budget off");

    await goal(app, id, "resume");
    await until(() => evaluations >= 2, "the resumed goal to be evaluated");
    await waitForIdle(app, id);
    assert.equal(work, 2);
    assert.match(await goal(app, id, "status"), /Completed/);

    await goal(app, id, "clear");
    assert.doesNotMatch(await goal(app, id, "status"), /Verify the goal fixture/);
    await say(app, id, "Ordinary chat after clearing the goal.");
    await waitForIdle(app, id);
    assert.equal(evaluations, 2);
});

test("editing an active goal queues work for the revision and ignores a stale successful verdict", async (t) => {
    const gate = Promise.withResolvers<void>();
    const objectives: string[] = [];
    let work = 0;
    const model = scriptedModel(async (request) => {
        if (!isEvaluator(request)) {
            work++;

            return fauxAssistantMessage("The worker reported evidence.");
        }

        const { objective } = JSON.parse(lastText(request).text) as { objective: string };

        objectives.push(objective);

        if (objectives.length === 1) {
            await gate.promise;
        }

        return verdict("met", "Evidence confirmed.");
    });
    const app = await openApp(model, join(root, "objective-goal-edit"));

    t.after(() => app.close());
    const id = await session(app);

    try {
        await goal(app, id, "Verify the original fixture.");
        await until(() => objectives.length === 1, "the original objective's evaluator");
        assert.match(await goal(app, id, "edit Verify the revised fixture."), /Active/);
    } finally {
        gate.resolve();
    }

    await waitForIdle(app, id);
    assert.deepEqual(objectives, ["Verify the original fixture.", "Verify the revised fixture."]);
    assert.equal(work, 2);
    assert.match(
        await goal(app, id, "status"),
        /Completed\nObjective: Verify the revised fixture\./,
    );
});

test("changing judges preserves the in-flight verdict and uses the new model for the next turn", async (t) => {
    const gate = Promise.withResolvers<void>();
    const judges: string[] = [];
    const model = scriptedModel(async (request, _options, _state, model) => {
        if (!isEvaluator(request)) {
            return fauxAssistantMessage("The worker reported evidence.");
        }

        judges.push(model.id);

        if (judges.length === 1) {
            await gate.promise;

            return verdict("continue", "A second check is needed.");
        }

        return verdict("met", "Evidence confirmed.");
    });
    const app = await openApp(model, join(root, "objective-goal-judge"));

    t.after(() => app.close());
    const id = await session(app);

    try {
        await goal(app, id, "Verify the fixture twice.");
        await until(() => judges.length === 1, "the original judge to start");
        await goal(app, id, "judge faux/faux-2");
    } finally {
        gate.resolve();
    }

    await waitForIdle(app, id);
    assert.deepEqual(judges, ["faux-1", "faux-2"]);
    assert.match(await goal(app, id, "status"), /Completed/);
});

test("resuming a paused goal during its old evaluation queues a new turn", async (t) => {
    const gate = Promise.withResolvers<void>();
    let evaluations = 0;
    const model = scriptedModel(async (request) => {
        if (!isEvaluator(request)) {
            return fauxAssistantMessage("The worker reported evidence.");
        }

        evaluations++;

        if (evaluations === 1) {
            await gate.promise;
        }

        return verdict("met", "Evidence confirmed.");
    });
    const app = await openApp(model, join(root, "objective-goal-resume-in-flight"));

    t.after(() => app.close());
    const id = await session(app);

    try {
        await goal(app, id, "Verify the fixture after resuming.");
        await until(() => evaluations === 1, "the first evaluation to start");
        await goal(app, id, "pause");
        assert.match(await goal(app, id, "resume"), /Active/);
    } finally {
        gate.resolve();
    }

    await waitForIdle(app, id);
    assert.equal(evaluations, 2);
    assert.match(await goal(app, id, "status"), /Completed/);
});

test("an evaluation interrupted by a server restart waits for an explicit resume", async (t) => {
    let evaluations = 0;
    const interrupted = Promise.withResolvers<void>();
    const model = scriptedModel(async (request) => {
        if (!isEvaluator(request)) {
            return fauxAssistantMessage("A work turn finished.");
        }

        evaluations++;

        if (evaluations === 1) {
            await interrupted.promise;
        }

        return verdict("met", "The fixture evidence meets the goal.");
    });
    const data = join(root, "objective-goal-restart");
    let app = await openApp(model, data);

    t.after(async () => {
        interrupted.resolve();
        await app.close();
    });
    const id = await session(app);

    await goal(app, id, "Finish the restart fixture.");
    await until(() => evaluations === 1, "the evaluation to start before restart");
    await app.close();
    interrupted.resolve();
    app = await openApp(model, data);

    await until(
        async () => /Paused/.test(await goal(app, id, "status")),
        "the interrupted goal to pause",
    );
    await waitForIdle(app, id);
    assert.equal(evaluations, 1, "recovery must not resubmit the interrupted evaluation");

    await goal(app, id, "resume");
    await until(() => evaluations >= 2, "a fresh evaluation after resume");
    await waitForIdle(app, id);
    assert.equal(evaluations, 2);
    assert.match(await goal(app, id, "status"), /Completed/);
});

test("a queued user message takes precedence over the evaluator's continuation", async (t) => {
    const work: string[] = [];
    let evaluations = 0;
    const firstEvaluation = Promise.withResolvers<void>();
    const model = scriptedModel(async (request) => {
        if (!isEvaluator(request)) {
            work.push(lastText(request).text);

            return fauxAssistantMessage("Checked the evidence.");
        }

        evaluations++;

        if (evaluations === 1) {
            await firstEvaluation.promise;

            return verdict("continue", "An automatic continuation could run.");
        }

        return verdict("met", "The human supplied the missing evidence.");
    });
    const app = await openApp(model, join(root, "objective-goal-queued-user"));

    t.after(() => app.close());
    const id = await session(app);

    try {
        await goal(app, id, "Confirm the evidence from the human.");
        await until(
            () => evaluations === 1,
            "the evaluator to start before sending a user message",
        );
        await app.commands.submit(id, owner(app), {
            text: "Human update: the fixture is present.",
            mode: "followUp",
            requestId: crypto.randomUUID(),
        });
    } finally {
        firstEvaluation.resolve();
    }

    await until(() => evaluations >= 2, "the queued user message to be evaluated");
    await waitForIdle(app, id);
    assert.equal(work.length, 2);
    assert.match(work[1]!, /Human update: the fixture is present/);
    assert.equal(evaluations, 2);
    assert.match(await goal(app, id, "status"), /Completed/);
});

test("a goal stays active without evaluation until the user approves the plan", async (t) => {
    let work = 0;
    let evaluations = 0;
    const model = scriptedModel((request) => {
        if (isEvaluator(request)) {
            evaluations++;

            return verdict("met", "Verified after plan approval.");
        }

        work++;

        return fauxAssistantMessage("Here is the evidence for the plan fixture.");
    });
    const app = await openApp(model, join(root, "objective-goal-plan"));

    t.after(() => app.close());
    const id = await session(app);

    await app.commands.setPlan(id, owner(app), true);
    await goal(app, id, "Finish the plan fixture when approved.");
    await until(() => work > 0, "the planning turn to start");
    await waitForIdle(app, id);
    assert.equal(evaluations, 0);
    assert.match(await goal(app, id, "status"), /Active/);

    await app.commands.approvePlan(id, owner(app));
    await until(() => evaluations > 0, "the approved plan to be evaluated");
    await waitForIdle(app, id);
    assert.equal(evaluations, 1);
    assert.match(await goal(app, id, "status"), /Completed/);
});

test("ordinary sessions never call the evaluator and a blocked verdict stops a goal", async (t) => {
    let evaluations = 0;
    const model = scriptedModel((request) => {
        if (isEvaluator(request)) {
            evaluations++;

            return verdict("blocked", "The requested file is missing.");
        }

        return fauxAssistantMessage("I need the missing fixture file.");
    });
    const app = await openApp(model, join(root, "objective-goal-blocked"));

    t.after(() => app.close());

    const ordinary = await session(app);

    await say(app, ordinary, "Reply once to this message.");
    await waitForIdle(app, ordinary);
    assert.equal(evaluations, 0);

    const id = await session(app);

    await goal(app, id, "Inspect the requested fixture file.");
    await until(() => evaluations > 0, "the blocked verdict");
    await waitForIdle(app, id);
    assert.equal(evaluations, 1);
    assert.match(await goal(app, id, "status"), /Blocked/);
});

test("a verdict accepts a single JSON fence with a valid object", async (t) => {
    const valid = { verdict: "met", reason: "The fixture produced the required evidence." };
    const fenced = ["```json", JSON.stringify(valid), "```"].join("\r\n");
    const cases = [
        { reply: `\n${fenced}\n`, status: /Completed/ },
        { reply: `The verdict follows.\n${fenced}`, status: /Paused/ },
        { reply: `${fenced}\n${fenced}`, status: /Paused/ },
        {
            reply: `\`\`\`json\n${JSON.stringify({ ...valid, extra: true })}\n\`\`\``,
            status: /Paused/,
        },
        { reply: "```json\n{verdict: met}\n```", status: /Paused/ },
    ];
    let reply = "";
    const model = scriptedModel((request) =>
        fauxAssistantMessage(isEvaluator(request) ? reply : "I checked the fixture."),
    );
    const app = await openApp(model, join(root, "objective-goal-fenced-verdict"));

    t.after(() => app.close());

    for (const example of cases) {
        reply = example.reply;

        const id = await session(app);

        await goal(app, id, "Verify the fixture evidence.");
        await waitForIdle(app, id);
        assert.match(await goal(app, id, "status"), example.status, example.reply);
    }
});

test("a goal that does not use tools cannot keep repeating without progress", async (t) => {
    let work = 0;
    const model = scriptedModel((request) => {
        if (isEvaluator(request)) {
            return verdict("continue", "No additional evidence yet.");
        }

        work++;

        return fauxAssistantMessage("Nothing has changed.");
    });
    const app = await openApp(model, join(root, "objective-goal-no-progress"));

    t.after(() => app.close());
    const id = await session(app);

    await goal(app, id, "Prove that the fixture changed.");
    await until(() => work > 0, "the goal to start");
    await waitForIdle(app, id);
    assert.ok(work > 1 && work <= 4, `expected at most four work turns, got ${work}`);
    assert.match(await goal(app, id, "status"), /Blocked/);
});

test("a spent token budget stops automatic continuation", async (t) => {
    let work = 0;
    const model = scriptedModel((request) => {
        if (isEvaluator(request)) {
            return verdict("continue", "The work requires more tokens.");
        }

        work++;

        return fauxAssistantMessage("This response consumes more than one token.");
    });
    const app = await openApp(model, join(root, "objective-goal-budget"));

    t.after(() => app.close());
    const id = await session(app);

    await goal(app, id, "--budget 1 Finish the budget fixture.");
    await until(() => work > 0, "the budgeted goal to start");
    await waitForIdle(app, id);
    assert.equal(work, 1);
    assert.match(await goal(app, id, "status"), /Budget reached/);
});

test("a paid evaluator charges its guest once and prevents work beyond the guest's spend limit", async (t) => {
    let work = 0;
    const model = scriptedModel((request) => {
        if (isEvaluator(request)) {
            return verdict("continue", "The goal still needs work.");
        }

        work++;

        return fauxAssistantMessage("I have started checking.");
    });
    const data = join(root, "objective-goal-evaluator-spend");
    let app = await openApp(model, data);

    t.after(() => app.close());
    const id = await session(app);
    const guest = app.config.addUser("Goal payer", "guest").user;
    const complete = app.models.completeSimple.bind(app.models);

    app.spend.setPersonBudget(owner(app), guest.id, 0.5);

    app.models.completeSimple = async (...args) => {
        const response = await complete(...args);

        if (!isEvaluator(args[1])) {
            return response;
        }

        return {
            ...response,
            usage: {
                ...response.usage,
                cost: { ...response.usage.cost, output: 0.75, total: 0.75 },
            },
        };
    };

    await app.objectiveGoals.command(id, guest, "Verify the spend fixture.", crypto.randomUUID());
    await waitForIdle(app, id);

    assert.equal(work, 1);
    assert.match(await goal(app, id, "status"), /Paused[\s\S]*spend limit/);
    assert.equal(app.spend.personSpent(guest.id), 0.75);
    assert.equal(app.spend.sessionSpent(id), 0.75);
    await app.close();
    app = await openApp(model, data);
    assert.equal(app.spend.personSpent(guest.id), 0.75);
    assert.equal(app.spend.sessionSpent(id), 0.75);
});

test("a final worker answer that reaches the session spend limit skips the evaluator", async (t) => {
    let evaluations = 0;
    const model = scriptedModel((request) => {
        if (isEvaluator(request)) {
            evaluations++;

            return verdict("continue", "The goal still needs work.");
        }

        return fauxAssistantMessage("Ordinary response.");
    });
    const app = await openApp(model, join(root, "objective-goal-worker-spend"));

    t.after(() => app.close());
    const id = await session(app);
    const streamSimple = app.models.streamSimple.bind(app.models);

    await app.spend.setSessionBudget(owner(app), id, 0.5);

    app.models.streamSimple = (...args) => {
        const [selected, request] = args;

        if (
            isEvaluator(request) ||
            !lastText(request).text.includes("the projected spend fixture")
        ) {
            return streamSimple(...args);
        }

        const answer = fauxAssistantMessage("This work used the session budget.");
        const stream = createAssistantMessageEventStream();

        queueMicrotask(() =>
            stream.push({
                type: "done",
                reason: "stop",
                message: {
                    ...answer,
                    api: selected.api,
                    provider: selected.provider,
                    model: selected.id,
                    usage: {
                        ...answer.usage,
                        cost: { ...answer.usage.cost, output: 0.5, total: 0.5 },
                    },
                },
            }),
        );

        return stream;
    };

    await goal(app, id, "Verify the projected spend fixture.");
    await waitForIdle(app, id);

    assert.equal(app.spend.sessionSpent(id), 0.5, "the worker answer hit the session budget");
    assert.equal(evaluations, 0, "no extra model call may begin at the limit");
    assert.match(await goal(app, id, "status"), /Paused[\s\S]*spend limit/);
});
