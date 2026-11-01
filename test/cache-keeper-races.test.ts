// Controlled requests and a fake clock expose cache keeper races without provider calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    type Api,
    type AssistantMessage,
    createAssistantMessageEventStream,
    type Model,
    normalizeContext,
    type SimpleStreamOptions,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
    CacheKeeper,
    type KeeperDeps,
    MAX_AGE_MS,
    refreshDelayMs,
} from "../src/server/cache-keeper.ts";

const model = {
    id: "cache-keeper-races",
    provider: "anthropic",
    api: "anthropic-messages",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    promptCache: { short: 300, long: 3600 },
} as unknown as Model<Api>;
const REFRESH_MS = refreshDelayMs(300_000)!;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type Call = {
    context: TranscriptContext;
    options: SimpleStreamOptions | undefined;
    settled: boolean;
    finish: (stopReason: "toolUse" | "stop" | "aborted") => void;
    fail: () => void;
};

function rig(deps: KeeperDeps = {}) {
    let now = 1_000_000;
    const timers = new Map<ReturnType<typeof setTimeout>, { at: number; fn: () => void }>();
    const calls: Call[] = [];
    const models = {
        streamSimple(
            current: Model<Api>,
            request: TranscriptContext,
            options?: SimpleStreamOptions,
        ) {
            const stream = createAssistantMessageEventStream();
            const result = Promise.withResolvers<AssistantMessage>();
            const reply = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
                role: "assistant",
                api: current.api,
                provider: current.provider,
                model: current.id,
                content:
                    stopReason === "toolUse"
                        ? [{ type: "toolCall", id: "tool", name: "wait", arguments: {} }]
                        : [],
                stopReason,
                timestamp: now,
                usage: {
                    input: 0,
                    output: 1,
                    cacheRead: 50_000,
                    cacheWrite: 0,
                    totalTokens: 50_001,
                    cost: { input: 0, output: 0, cacheRead: 0.015, cacheWrite: 0, total: 0.015 },
                },
            });
            const call: Call = {
                context: request,
                options,
                settled: false,
                finish(stopReason) {
                    if (call.settled) {
                        return;
                    }

                    call.settled = true;

                    const message = reply(stopReason);

                    if (stopReason === "aborted") {
                        stream.push({ type: "error", reason: "aborted", error: message });
                    } else {
                        stream.push({ type: "done", reason: stopReason, message });
                    }

                    stream.end(message);
                    result.resolve(message);
                },
                fail() {
                    if (call.settled) {
                        return;
                    }

                    call.settled = true;

                    const message = reply("error");

                    stream.push({ type: "error", reason: "error", error: message });
                    stream.end(message);
                    result.reject(new Error("The old warm failed after its replacement started."));
                },
            };

            const payload = options?.onPayload?.(
                { model: current.id, messages: request.messages, max_tokens: options.maxTokens },
                current,
            );

            // Keep real event streams, but permit a controlled rejection from result().
            stream.result = async () => {
                await payload;

                return result.promise;
            };

            calls.push(call);

            return stream;
        },
    };
    const keeper = new CacheKeeper({
        now: () => now,
        disabled: () => false,
        conversationOf: async () => 1,
        isRunning: () => true,
        setTimer: (fn, ms) => {
            const handle = {} as ReturnType<typeof setTimeout>;

            timers.set(handle, { at: now + ms, fn });

            return handle;
        },
        clearTimer: (handle) => {
            timers.delete(handle);
        },
        ...deps,
    });

    keeper.installPayloadObserver(models);
    keeper.install(models);

    const send = (text: string) => {
        const request = normalizeContext({
            messages: [{ role: "user", content: text, timestamp: now }],
        });

        models.streamSimple(model, request, { sessionId: "same-session", cacheRetention: "short" });

        return calls.at(-1)!;
    };

    const advance = async (ms: number) => {
        const target = now + ms;

        for (;;) {
            const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];

            if (next === undefined || next[1].at > target) {
                break;
            }

            timers.delete(next[0]);
            now = next[1].at;
            next[1].fn();
            await flush();
        }

        now = target;
        await flush();
    };

    const close = async () => {
        // A future close() can await active warms. Settle them after cancellation, before awaiting it.
        const closing = keeper.close();

        for (const call of calls) {
            call.finish("stop");
        }

        await closing;
        await flush();
    };

    return { keeper, calls, send, advance, close };
}

test("an older request that settles last must not replace the newest replay context", async (t) => {
    const r = rig();

    t.after(r.close);

    const older = r.send("older request");
    const newer = r.send("newer request");

    newer.finish("toolUse");
    await flush();
    older.finish("toolUse");
    await flush();
    await r.advance(REFRESH_MS);

    assert.equal(r.calls.length, 3, "Only one warm must start for the newest request.");
    assert.strictEqual(
        r.calls[2]!.context,
        newer.context,
        "A late older completion must not replace the newest replay context.",
    );
});

test("a rejected obsolete warm must not remove the replacement entry", async (t) => {
    const r = rig();

    t.after(r.close);
    r.send("first request").finish("toolUse");
    await flush();
    await r.advance(REFRESH_MS);

    const oldWarm = r.calls[1]!;

    assert.ok(oldWarm.options?.signal, "A warm must have its own abort signal.");

    const replacement = r.send("replacement request");

    assert.equal(oldWarm.options.signal.aborted, true, "The replacement must cancel the old warm.");
    replacement.finish("toolUse");
    await flush();
    assert.equal(r.keeper.status().warming, 1, "The replacement entry must be active.");
    oldWarm.fail();
    await flush();
    assert.equal(
        r.keeper.status().warming,
        1,
        "An obsolete warm rejection must not remove the replacement entry.",
    );
    await r.advance(REFRESH_MS);
    assert.equal(r.calls.length, 4, "The replacement entry must still send its warm.");
    assert.strictEqual(r.calls[3]!.context, replacement.context);
});

test("the age deadline must abort a pending warm at 30 minutes without waiting for its result", async (t) => {
    const r = rig();

    t.after(r.close);
    r.send("long tool wait").finish("toolUse");
    await flush();
    await r.advance(REFRESH_MS);

    const warm = r.calls[1]!;

    assert.ok(warm.options?.signal, "A warm must have its own abort signal.");
    await r.advance(MAX_AGE_MS - REFRESH_MS - 1);
    assert.equal(warm.options.signal.aborted, false, "The warm can remain active before the cap.");
    await r.advance(1);
    assert.equal(warm.settled, false, "The provider result must still be pending at the cap.");
    assert.equal(
        warm.options.signal.aborted,
        true,
        "The independent age deadline must abort the warm exactly at the cap.",
    );
    assert.equal(r.keeper.status().warming, 0, "The expired entry must be removed.");
    warm.finish("stop");
    await flush();
    await r.advance(REFRESH_MS);
    assert.equal(r.calls.length, 2, "A late provider result must not restart the expired entry.");
});

for (const endedConversation of [1, 99]) {
    test(`run end ${endedConversation} must discard an unresolved entry before it captures a new payer`, async (t) => {
        const lookup = Promise.withResolvers<number | undefined>();
        const captures: string[] = [];
        const charges: string[] = [];
        let payer = "Alex";
        const r = rig({
            conversationOf: () => lookup.promise,
            // A new run can already be busy when the old request's lookup returns.
            isRunning: () => true,
            accountFor: () => {
                const captured = payer;

                captures.push(captured);

                return {
                    check: () => true,
                    recordUsage: async () => {
                        charges.push(captured);
                    },
                };
            },
        });

        t.after(r.close);
        r.send("Alex's old request").finish("toolUse");
        await flush();
        assert.equal(
            r.keeper.status().warming,
            1,
            "The entry must wait for its conversation lookup.",
        );
        r.keeper.runEnded(endedConversation);
        payer = "Bea";
        lookup.resolve(1);
        await flush();
        assert.deepEqual(captures, [], "The old lookup must not capture the new run's payer.");
        assert.equal(r.keeper.status().warming, 0, "The unresolved entry must remain removed.");
        await r.advance(REFRESH_MS);
        assert.equal(r.calls.length, 1, "The old request must send no warm after the run ends.");
        assert.deepEqual(charges, [], "Neither payer must receive a charge from the old entry.");
    });
}

test("close must wait for an aborted response and its captured-payer usage write", async (t) => {
    const allowWrite = Promise.withResolvers<void>();
    const stored: { payer: string; cost: number; stopReason: AssistantMessage["stopReason"] }[] =
        [];
    let payer = "Alex";
    let recording = false;
    let closed = false;
    const r = rig({
        accountFor: () => {
            const captured = payer;

            return {
                check: () => true,
                recordUsage: async (message) => {
                    recording = true;
                    await allowWrite.promise;
                    stored.push({
                        payer: captured,
                        cost: message.usage.cost.total,
                        stopReason: message.stopReason,
                    });
                },
            };
        },
    });

    t.after(async () => {
        // Release both controlled waits even when an assertion fails.
        allowWrite.resolve();
        await r.close();
    });
    r.send("Alex's request").finish("toolUse");
    await flush();
    await r.advance(REFRESH_MS);

    const warm = r.calls[1]!;

    assert.ok(warm.options?.signal, "The active warm must have an abort signal.");
    payer = "Bea";

    const closing = r.keeper.close().then(() => {
        closed = true;
    });

    await flush();
    assert.equal(warm.options.signal.aborted, true, "Shutdown must abort the active warm.");
    assert.equal(closed, false, "Shutdown must wait for the provider's late response.");
    assert.equal(recording, false);
    warm.finish("aborted");
    await flush();
    assert.equal(recording, true, "The late aborted response must reach the usage recorder.");
    assert.deepEqual(stored, [], "The usage write must still be pending.");
    assert.equal(closed, false, "Shutdown must also wait for the usage write to finish.");
    allowWrite.resolve();
    await closing;
    assert.equal(closed, true);
    assert.deepEqual(stored, [{ payer: "Alex", cost: 0.015, stopReason: "aborted" }]);
    await r.advance(MAX_AGE_MS);
    assert.equal(r.calls.length, 2, "Shutdown must leave no timer that can send another warm.");
    assert.equal(stored.length, 1, "The late response must be recorded exactly once.");
});
