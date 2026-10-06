// Done when: Pi keeps going until a check passes, counting each answer's check once, and gives up after five.
import {
    type App,
    cleanUp,
    context,
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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { ChatDoc, GoalDoc } from "../src/server/docs.ts";

/** Told that the check fails, the model writes the file the check looks for; anything else it just answers. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("wrote it")]);
    }

    if (/^\[goal\] `(printf x >> runs.txt; )?test -f done.txt`/.test(text)) {
        return fauxAssistantMessage(
            [fauxToolCall("write", { path: "done.txt", content: "done\n" })],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(`answered: ${text.slice(0, 40)}`)]);
};

const model = scriptedModel(route);
let app: App;

before(async () => {
    app = await openApp(model);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** A session in a folder of its own, so a check's file belongs to one test. */
async function sessionIn(name: string): Promise<ConversationId> {
    const folder = join(root, name);

    mkdirSync(folder, { recursive: true });

    return newSession(app, folder);
}

async function sayAndSettle(id: ConversationId, text: string): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

async function goalMessages(id: ConversationId): Promise<string[]> {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        200,
        undefined,
        context,
    );

    return page.items
        .filter((entry) => entry.kind === "pi.user")
        .map((entry) => JSON.stringify(entry.model))
        .filter((text) => text.includes("[goal] "))
        .reverse();
}

test("Pi keeps going until the check passes, and the goal says it is met", async () => {
    const id = await sessionIn("met");

    await app.commands.setGoal(id, owner(app), "test -f done.txt");
    await sayAndSettle(id, "finish the job");
    const told = await goalMessages(id);

    assert.equal(told.length, 1, "one failed check, then the file was written");
    assert.match(
        told[0]!,
        /\[goal\] `test -f done.txt` still fails \(exit code 1, check 1 of 5\)\. It printed nothing\./,
    );
    const goal = (await app.harness.snapshot(GoalDoc, id, context))?.goal;

    assert.equal(goal?.status, "met");
    assert.equal(goal?.tries, 2);
    assert.equal(goal?.last?.passed, true);
    const chat = (await app.harness.snapshot(ChatDoc, id, context))!.messages.map(
        (message) => message.text,
    );

    assert.deepEqual(chat, ["set a goal: keep going until `test -f done.txt` passes"]);
    await app.commands.clearGoal(id, owner(app));
    assert.equal((await app.harness.snapshot(GoalDoc, id, context))?.goal, undefined);
});

test("after the last check fails, Pi stops trying", async () => {
    const id = await sessionIn("gave-up");

    await app.commands.setGoal(id, owner(app), "echo still broken; exit 3");
    await sayAndSettle(id, "try your best");
    const told = await goalMessages(id);

    assert.equal(
        told.length,
        4,
        "five checks: four failures that keep Pi going, and the last one that ends it",
    );
    assert.match(
        told[3]!,
        /exit code 3, check 4 of 5\)\. The end of its output:\\n\\n```\\nstill broken\\n```/,
    );
    const goal = (await app.harness.snapshot(GoalDoc, id, context))?.goal;

    assert.equal(goal?.status, "gave-up");
    assert.equal(goal?.tries, 5);
    // A new message does not start the checks again: the goal is over until someone sets it again.
    await sayAndSettle(id, "one more thing");
    assert.equal((await goalMessages(id)).length, 4);
    await app.commands.clearGoal(id, owner(app));
});

// A restart while the hook runs replays it, and it records the same answer's check again.
test("an answer's check counts once, however often it is recorded, and only for the goal it checked", async () => {
    const id = await sessionIn("counted");

    await app.goals.set(id, owner(app).id, "false");
    const failed = { passed: false, code: 1, tail: "" };
    const first = await app.goals.record(id, 101 as unknown as TaskId, "false", failed);
    const again = await app.goals.record(id, 101 as unknown as TaskId, "false", failed);

    assert.equal(first?.tries, 1);
    assert.equal(again?.tries, 1);
    assert.equal(
        await app.goals.record(id, 102 as unknown as TaskId, "something else", failed),
        undefined,
        "a check of an older goal does not count",
    );
    await app.goals.clear(id);
});

test("in plan mode the check waits, and approving the plan lets Pi work toward the goal", async () => {
    const id = await sessionIn("planned");

    await app.commands.setGoal(id, owner(app), "test -f done.txt");
    await app.commands.setPlan(id, owner(app), true);
    await sayAndSettle(id, "plan the job");
    assert.deepEqual(await goalMessages(id), []);
    assert.equal(
        (await app.harness.snapshot(GoalDoc, id, context))?.goal?.tries,
        0,
        "no check ran",
    );
    const { submissionId } = await app.commands.approvePlan(id, owner(app));

    await (await app.harness.submission(submissionId, context))!.wait(context);
    assert.equal((await app.harness.snapshot(GoalDoc, id, context))?.goal?.status, "met");
});

test("a check cut off by a restart does not run again: Pi hears so, and its next answer is checked", async () => {
    const id = await sessionIn("cut-off");
    const runs = join(root, "cut-off", "runs.txt");

    // Each run of the check leaves a mark.
    await app.commands.setGoal(id, owner(app), "printf x >> runs.txt; test -f done.txt");
    const run = app.goals.run;

    // The server stops while the check runs: it ran, but its result was never stored.
    app.goals.run = async (conversationId, command, context) => {
        await run.call(app.goals, conversationId, command, context);

        return awaitWithContext(new Promise<never>(() => {}), context);
    };

    await app.commands.submit(id, owner(app), { text: "finish the job", requestId: "cut-off" });
    await until(() => existsSync(runs), "the check to run");
    await app.close();
    app = await openApp(model);
    await until(
        async () => (await app.harness.snapshot(GoalDoc, id, context))?.goal?.status === "met",
        "the goal to be met",
    );
    assert.equal(
        readFileSync(runs, "utf8"),
        "xx",
        "once when cut off, once after Pi's next answer",
    );
    const told = await goalMessages(id);

    assert.equal(told.length, 1);
    assert.match(
        told[0]!,
        /\[goal\] `printf x >> runs.txt; test -f done.txt` was cut off by a server restart \(check 1 of 5\)\. Whether it passes is not known/,
    );
    assert.equal((await app.harness.snapshot(GoalDoc, id, context))?.goal?.tries, 2);
});

test("past a spend limit Pi takes no more rounds toward the goal", async () => {
    const id = await sessionIn("limited");

    await app.spend.setSessionBudget(owner(app), id, 1);
    await app.commands.setGoal(id, owner(app), "test -f done.txt");
    // The answer's cost puts the session past its limit by the time its check fails.
    const run = app.goals.run;

    app.goals.run = async (...args) => {
        await recordCost(app, id, 2);

        return run.apply(app.goals, args);
    };

    // Spend also stops runs that cross a limit (spend.test.ts); held back here, only the goal's own check is at work.
    const conversation = app.conversation;

    app.conversation = async (cid) =>
        new Proxy(await conversation.call(app, cid), {
            get: (found, key) => {
                if (key === "abort") {
                    return async () => {};
                }

                const value: unknown = Reflect.get(found, key, found);

                return typeof value === "function" ? value.bind(found) : value;
            },
        });

    try {
        await sayAndSettle(id, "finish the job");
    } finally {
        app.goals.run = run;
        app.conversation = conversation;
    }

    assert.deepEqual(await goalMessages(id), [], "Pi was not sent on");
    const goal = (await app.harness.snapshot(GoalDoc, id, context))?.goal;

    assert.equal(goal?.tries, 1);
    assert.equal(goal?.status, "working", "the goal stays, for when the limit is raised");
});

test("goals need the right to drive, a session, their extension, and Lancet Guard's leave", async () => {
    const id = await sessionIn("rules");
    const viewer = app.config.addUser("Vee", "viewer").user;

    await assert.rejects(app.commands.setGoal(id, viewer, "npm test"), { status: 403 });
    await assert.rejects(app.commands.setGoal(id, owner(app), " "), { status: 400 });
    const other = await app.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
    );

    await assert.rejects(app.commands.setGoal(other.id, owner(app), "npm test"), {
        status: 400,
        message: /Only sessions/,
    });
    await app.setExtensionEnabled(owner(app), "goals.ts", false);

    try {
        await assert.rejects(app.commands.setGoal(id, owner(app), "npm test"), {
            status: 409,
            message: /turned off in Extensions/,
        });
    } finally {
        await app.setExtensionEnabled(owner(app), "goals.ts", true);
    }

    // With the guard on, a check it would ask about cannot run unasked after every answer.
    const enabled = app.loader.enabled;
    const judge = app.guard.judge;

    app.loader.enabled = (file: string) => file === "guard.ts" || enabled.call(app.loader, file);
    app.guard.judge = async (_tool, args) =>
        ({
            subject: String(args.command),
            decision: { action: "ask", reason: "deletes files", source: "rules", terminate: false },
        }) as never;

    try {
        await assert.rejects(app.commands.setGoal(id, owner(app), "rm -rf build && npm test"), {
            status: 403,
            message: /Lancet Guard does not allow this check to run unasked: deletes files/,
        });
    } finally {
        app.loader.enabled = enabled;
        app.guard.judge = judge;
    }
});
