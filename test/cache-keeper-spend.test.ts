// The real keeper's accounting wiring, on isolated data and scripted streams. No paid provider is used.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    recordCost,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
    type Api,
    type AssistantMessage,
    createAssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, ProviderDoc, UsageDoc } from "@earendil-works/pi-durable";

const usage = {
    input: 10,
    output: 1,
    cacheRead: 50_000,
    cacheWrite: 0,
    totalTokens: 50_011,
    cost: { input: 0, output: 0.001, cacheRead: 0.014, cacheWrite: 0, total: 0.015 },
};
const model = {
    id: "warm",
    provider: "test",
    api: "anthropic-messages",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    // An 11-second TTL refreshes 10 seconds early, so this test waits only 1 second.
    promptCache: { short: 11 },
} as Model<Api>;

after(cleanUp);

test("warm usage counts in the session and captured person's spend, including a late aborted response", async () => {
    const app = await openApp(
        scriptedModel(() =>
            fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], {
                stopReason: "toolUse",
            }),
        ),
    );
    const alex = app.config.addUser("Alex", "guest").user;
    const bea = app.config.addUser("Bea", "guest").user;
    let finish: ((message: AssistantMessage) => void) | undefined;
    let calls = 0;
    let id: ConversationId;

    try {
        id = await newSession(app);

        await app.commands.submit(id, alex, { text: "work", requestId: crypto.randomUUID() });
        await until(
            async () =>
                (await app.harness.snapshot(ProviderDoc, id, context))?.sessionId !== undefined,
            "the provider identity",
        );
        const sessionId = (await app.harness.snapshot(ProviderDoc, id, context))!.sessionId;
        const models = {
            streamSimple(_model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) {
                const stream = createAssistantMessageEventStream();
                const message = {
                    role: "assistant",
                    content: [],
                    api: model.api,
                    provider: model.provider,
                    model: model.id,
                    usage,
                    stopReason: "toolUse",
                    timestamp: Date.now(),
                } as AssistantMessage;

                calls++;

                queueMicrotask(async () => {
                    await options?.onPayload?.(
                        { model: model.id, max_tokens: options.maxTokens },
                        model,
                    );

                    if (options?.maxTokens === 1) {
                        finish = (result) =>
                            stream.push({ type: "done", reason: "stop", message: result });
                    } else {
                        stream.push({ type: "done", reason: "toolUse", message });
                    }
                });

                return stream;
            },
        };

        app.cacheKeeper.installPayloadObserver(models);
        app.cacheKeeper.install(models);
        await models.streamSimple(model, {}, { sessionId }).result();
        await until(() => calls === 2, "a warm request", 4000);
        finish!({
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "stop",
            timestamp: Date.now(),
        });
        await until(() => app.spend.personSpent(alex.id) === 0.015, "the first warm's cost");
        await until(() => calls === 3, "a second warm request", 4000);
        await recordCost(app, id, 0.25);
        await (await app.conversation(id)).abort(context);
        await until(() => !app.isBusy(id), "the old run to stop");
        await app.commands.submit(id, bea, { text: "another run", requestId: crypto.randomUUID() });
        await until(() => app.attribution.requesterOf(id) === bea.id, "the new payer");
        finish!({
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "aborted",
            timestamp: Date.now(),
        });
        await until(
            () => Math.abs(app.spend.personSpent(alex.id) - 0.28) < 1e-12,
            "the warm to be charged to Alex",
        );
        const totals = await app.harness.snapshot(UsageDoc, id, context);

        assert.equal(totals?.models["test/warm"]?.cacheRead, 100_000);
        assert.equal(totals?.models["test/warm"]?.cost.total, 0.03);
        assert.ok(Math.abs(app.spend.sessionSpent(id) - 0.28) < 1e-12);
        assert.equal(app.spend.personSpent(bea.id), 0);
        assert.equal(app.spend.personSpent(owner(app).id), 0);
    } finally {
        await app.close();
    }

    const restarted = await openApp(scriptedModel());

    try {
        assert.ok(Math.abs(restarted.spend.personSpent(alex.id) - 0.28) < 1e-12);
        assert.equal(
            restarted.spend.personSpent(bea.id),
            0,
            "the warm is not charged again after restart",
        );
        assert.ok(Math.abs(restarted.spend.sessionSpent(id!) - 0.28) < 1e-12);
        assert.equal(restarted.cacheKeeper.status().warming, 0, "restart replays no warm requests");
    } finally {
        await restarted.close();
    }
});

test("the keeper sends no warm after its payer reaches a spend limit", async () => {
    const app = await openApp(
        scriptedModel(() =>
            fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], {
                stopReason: "toolUse",
            }),
        ),
    );
    const alex = app.config.addUser("Limited", "guest").user;

    try {
        const id = await newSession(app);

        await app.commands.submit(id, alex, { text: "work", requestId: crypto.randomUUID() });
        await until(
            async () =>
                (await app.harness.snapshot(ProviderDoc, id, context))?.sessionId !== undefined,
            "the provider identity",
        );
        const sessionId = (await app.harness.snapshot(ProviderDoc, id, context))!.sessionId;
        let calls = 0;
        const models = {
            streamSimple(_model: Model<Api>, _context: unknown, options?: SimpleStreamOptions) {
                const stream = createAssistantMessageEventStream();
                const message = {
                    role: "assistant",
                    content: [],
                    api: model.api,
                    provider: model.provider,
                    model: model.id,
                    usage,
                    stopReason: "toolUse",
                    timestamp: Date.now(),
                } as AssistantMessage;

                calls++;
                queueMicrotask(async () => {
                    await options?.onPayload?.(
                        { model: model.id, max_tokens: options.maxTokens },
                        model,
                    );
                    stream.push({ type: "done", reason: "toolUse", message });
                });

                return stream;
            },
        };

        app.cacheKeeper.installPayloadObserver(models);
        app.cacheKeeper.install(models);
        await models.streamSimple(model, {}, { sessionId }).result();
        await until(() => app.cacheKeeper.status().warming === 1, "a pending warm");
        // Change the current limit without stopping the run first. The keeper must check it at send time.
        alex.budget = 0;
        await until(() => app.cacheKeeper.status().warming === 0, "the budget check", 4000);
        assert.equal(calls, 1, "only the real request was sent");
    } finally {
        await app.close();
    }
});
