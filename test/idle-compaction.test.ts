// A session idle for over an hour is compacted before its next message goes out, as Claude Code does.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";

let clock = Date.now();
let app: App;

before(async () => {
    app = await openApp(scriptedModel(), undefined, () => clock);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** The entry the conversation's context starts from: it changes when the context is compacted. */
const head = async (id: Parameters<typeof say>[1]) =>
    (await (await app.harness.conversation(id, context))!.context(context)).head?.id;

test("a message after an idle hour compacts first; a prompt one does not", async () => {
    const id = await newSession(app);

    // Big enough to be worth a summary.
    await say(app, id, "x".repeat(80_000));
    clock += 30 * 60 * 1000;

    const before = await head(id);

    await say(app, id, "still here");
    assert.equal(await head(id), before, "a half hour is not a pause");

    clock += 61 * 60 * 1000;
    await say(app, id, "back again");
    assert.notEqual(await head(id), before, "an idle hour compacts the context");
});

test("a small context is left as it is", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");
    clock += 2 * 60 * 60 * 1000;
    const before = await head(id);

    await say(app, id, "hello again");
    assert.equal(await head(id), before);
});

test("the owner's idle hours decide; Off, or compaction off, never compacts first", async () => {
    const id = await newSession(app);

    await say(app, id, "x".repeat(80_000));
    // Past Pi's own compaction of a big first message.
    await say(app, id, "settle");
    clock = (app.sessionMeta(id)?.updatedAt ?? app.now()) + 2 * 60 * 60 * 1000;
    app.config.compactIdleHours = 5;

    const before = await head(id);

    await say(app, id, "two hours, limit five");
    assert.equal(await head(id), before, "two idle hours are no pause when five are chosen");

    app.config.compactIdleHours = 0;
    clock = (app.sessionMeta(id)?.updatedAt ?? app.now()) + 13 * 60 * 60 * 1000;
    await say(app, id, "a long night");
    assert.equal(await head(id), before, "Off never compacts first");
    app.config.compactIdleHours = 1;
});

test("the request after idle compaction ends with the person's message", async () => {
    let now = Date.now();
    const requests: string[][] = [];
    const isolated = await openApp(
        scriptedModel((context) => {
            requests.push(context.messages.map((message) => message.role));

            return fauxAssistantMessage([fauxText("answer")]);
        }),
        join(root, "anthropic-idle-compaction"),
        () => now,
    );

    try {
        const id = await newSession(isolated);

        for (let i = 0; i < 3; i++) {
            await say(isolated, id, `${i}: ${"x".repeat(40_000)}`);
        }

        const conversation = await isolated.conversation(id);
        const before = (await conversation.context(context)).head?.id;

        now += 61 * 60 * 1000;
        await say(isolated, id, "back again");
        assert.notEqual((await conversation.context(context)).head?.id, before);
        assert.equal(requests.at(-1)?.at(-1), "user");
    } finally {
        await isolated.close();
    }
});

test("a sent message after an idle pause waits for compaction before completing", async () => {
    const id = await newSession(app);

    await say(app, id, "x".repeat(80_000));
    clock += 61 * 60 * 1000;

    const before = await head(id);

    // Submit message via app.commands.submit directly (same endpoint as composer POST).
    // In synchronous compaction mode, submit compacts context first before admitting and running the message.
    const result = await app.commands.submit(id, owner(app), {
        text: "sent after idle pause",
        requestId: crypto.randomUUID(),
    });

    assert.ok(result.submissionId, "submit resolved with a submission ID");

    // Wait for the full run to complete.
    await app.harness.waitForIdle(context);
    assert.notEqual(await head(id), before, "compaction completed with the message run");
});

test("retried requests return existing submission without duplicate compaction", async () => {
    const id = await newSession(app);

    await say(app, id, "x".repeat(80_000));
    clock += 61 * 60 * 1000;

    const reqId = crypto.randomUUID();
    const first = await app.commands.submit(id, owner(app), {
        text: "first attempt",
        requestId: reqId,
    });

    await app.harness.waitForIdle(context);
    const headAfterFirst = await head(id);

    // Same requestId retried: should return existing submission and not compact again.
    const second = await app.commands.submit(id, owner(app), {
        text: "first attempt",
        requestId: reqId,
    });

    assert.equal(second.submissionId, first.submissionId, "retry gets same submission");
    assert.equal(await head(id), headAfterFirst, "retry does not compact again");
});

test("interrupt mode does not trigger idle compaction", async () => {
    const id = await newSession(app);

    await say(app, id, "x".repeat(80_000));
    clock += 61 * 60 * 1000;
    const before = await head(id);

    // Send an interrupt request.
    await app.commands.submit(id, owner(app), {
        text: "stop now",
        mode: "interrupt",
        requestId: crypto.randomUUID(),
    });

    await app.harness.waitForIdle(context);
    // Head should remain unchanged because interrupt must not run idle compaction.
    assert.equal(await head(id), before, "interrupt does not compact context");
});

test("concurrent submissions on an idle session share a single compaction", async () => {
    let compactionCount = 0;
    const id = await newSession(app);

    await say(app, id, "x".repeat(80_000));
    clock += 61 * 60 * 1000;

    const before = await head(id);

    // Spy on harness conversation compact method by intercepting conversation() in app
    const origConversation = app.conversation.bind(app);

    app.conversation = async (convId: Parameters<typeof origConversation>[0]) => {
        const conv = await origConversation(convId);

        if (convId === id) {
            const origCompact = conv.compact.bind(conv);

            conv.compact = async (entry, ctx) => {
                compactionCount++;

                return origCompact(entry, ctx);
            };
        }

        return conv;
    };

    try {
        // Fire two concurrent submissions before either has awaited or finished compaction.
        const [sub1, sub2] = await Promise.all([
            app.commands.submit(id, owner(app), {
                text: "concurrent message 1",
                requestId: crypto.randomUUID(),
            }),
            app.commands.submit(id, owner(app), {
                text: "concurrent message 2",
                requestId: crypto.randomUUID(),
            }),
        ]);

        assert.ok(sub1.submissionId, "first message admitted");
        assert.ok(sub2.submissionId, "second message admitted");
        assert.notEqual(sub1.submissionId, sub2.submissionId, "distinct submissions");
        assert.equal(compactionCount, 1, "exactly one compaction was called");

        await app.harness.waitForIdle(context);

        const afterHead = await head(id);

        assert.notEqual(afterHead, before, "context was compacted");
    } finally {
        app.conversation = origConversation;
    }
});

test("interrupt mode stops active compaction and admits the interrupt message", async () => {
    const id = await newSession(app);

    await say(app, id, "x".repeat(80_000));
    clock += 61 * 60 * 1000;

    const conv = await app.conversation(id);
    // Start an active compaction
    const taskId = await conv.compact(undefined, context);

    assert.equal(app.isCompacting(id), true, "compaction is active");

    // Submit an interrupt message
    const res = await app.commands.submit(id, owner(app), {
        text: "stop",
        mode: "interrupt",
        requestId: crypto.randomUUID(),
    });

    assert.ok(res.submissionId, "interrupt submission admitted");

    // Verify compaction task was aborted by the interrupt
    const taskRecord = await app.harness.getTask(taskId, context);

    assert.equal(taskRecord?.state.status, "terminal", "compaction terminated");
    assert.equal(taskRecord?.state.outcome?.status, "aborted", "compaction aborted");

    await app.harness.waitForIdle(context);
});
