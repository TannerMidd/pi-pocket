// The cache keeper with fake streams and a fake clock: when it warms, when it stops, and what it never does.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    type Api,
    createAssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { CacheKeeper, decide, MAX_AGE_MS, refreshDelayMs } from "../src/server/cache-keeper.ts";

// Claude Sonnet prices per million tokens, with a 5 minute cache.
const COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const model = {
    id: "m",
    provider: "anthropic",
    api: "anthropic-messages",
    cost: COST,
    promptCache: { short: 300, long: 3600 },
} as unknown as Model<Api>;
const usage = {
    input: 10,
    output: 5,
    cacheRead: 50_000,
    cacheWrite: 0,
    totalTokens: 50_015,
    cost: { input: 0, output: 0, cacheRead: 0.015, cacheWrite: 0, total: 0.015 },
};

/** A model runtime plus a clock. `timers` are the keeper's pending timers; `advance` fires the next one. */
function rig(disabled = false) {
    let now = 1_000_000;
    let off = disabled;
    const timers: { at: number; fn: () => void }[] = [];
    let failNext = false;
    const ended = new Set<number>();
    const calls: { maxTokens?: number; maxRetries?: number }[] = [];
    let stopReason = "stop";
    const models = {
        streamSimple(m: Model<Api>, _c: unknown, options?: SimpleStreamOptions) {
            const stream = createAssistantMessageEventStream();

            calls.push({
                ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
                ...(options?.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
            });
            const message = {
                role: "assistant",
                content: [],
                api: m.api,
                provider: m.provider,
                model: m.id,
                usage,
                stopReason: failNext && options?.maxTokens === 1 ? "error" : stopReason,
                timestamp: now,
            };

            queueMicrotask(async () => {
                await options?.onPayload?.({ model: m.id, max_tokens: options.maxTokens }, m);
                stream.push({ type: "done", reason: "stop", message } as never);
            });

            return stream;
        },
    };
    const keeper = new CacheKeeper({
        now: () => now,
        conversationOf: async (sessionId) => ({ a: 1, b: 2, s: 3 })[sessionId],
        isRunning: (id) => !ended.has(id),
        disabled: () => off,
        setTimer: ((fn: () => void, ms: number) => {
            const t = { at: now + ms, fn };

            timers.push(t);

            return t as never;
        }) as never,
        clearTimer: ((t: { fn: () => void }) => {
            const i = timers.indexOf(t as never);

            if (i >= 0) {
                timers.splice(i, 1);
            }
        }) as never,
    });

    keeper.installPayloadObserver(models);
    keeper.install(models);

    const send = async (
        sessionId: string | undefined,
        stop: string,
        cacheRetention: "short" | "long" | "none" = "short",
        signal?: AbortSignal,
    ) => {
        stopReason = stop;
        await models
            .streamSimple(model, { messages: [] } as never, {
                ...(sessionId === undefined ? {} : { sessionId }),
                cacheRetention,
                ...(signal === undefined ? {} : { signal }),
            })
            .result();
        await new Promise((r) => setImmediate(r));
    };

    const advance = async () => {
        const next = timers.sort((a, b) => a.at - b.at)[0];

        assert.ok(next, "a timer is pending");
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.fn();
        await new Promise((r) => setTimeout(r, 5));
    };

    return {
        keeper,
        send,
        advance,
        calls,
        timers,
        setNow: (t: number) => {
            now = t;
        },
        now: () => now,
        setOff: (v: boolean) => {
            off = v;
        },
        failWarm: () => {
            failNext = true;
        },
        endRun: (id: number) => {
            ended.add(id);
        },
    };
}

test("break-even: a 5m write costs 12.5x a read, so a 0.9 hazard pays and a 0.05 one does not", () => {
    const at = (hazard: number) =>
        decide({ promptTokens: 50_000, rates: COST, writeRate: COST.cacheWrite, hazard }).action;

    assert.equal(at(0.05), "stop");
    assert.equal(at(0.9), "warm");
});

test("a small prompt is not worth a warm: the output token costs more than the saving", () => {
    assert.equal(
        decide({ promptTokens: 1, rates: COST, writeRate: COST.cacheWrite, hazard: 0.9 }).action,
        "stop",
    );
});

test("refresh delay is 90% of the lifetime, 10 seconds early at least", () => {
    assert.equal(refreshDelayMs(300_000), 270_000);
    assert.equal(refreshDelayMs(5_000), undefined);
});

test("a request that ended in a tool call is warmed, with a one-token cap and no retries", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    assert.equal(r.timers.length, 1);
    await r.advance();
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls[1]?.maxTokens, 1);
    assert.equal(r.calls[1]?.maxRetries, 0);
    assert.equal(r.keeper.status().warms, 1);
    assert.equal(r.timers.length, 1, "the next refresh is scheduled");
});

test("a finished answer is not warmed: an idle session costs about what it saves", async () => {
    const r = rig();

    await r.send("s", "stop");
    assert.equal(r.timers.length, 0);
});

test("a warm is not a real request: it never starts a warm of its own beyond the next refresh", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    await r.advance();
    await r.advance();
    assert.equal(r.timers.length, 1, "one pending refresh, not one per warm");
    assert.equal(r.keeper.status().warming, 1);
});

test("a new real request replaces the pending warm", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    await r.send("s", "toolUse");
    assert.equal(r.timers.length, 1, "one timer for the newest request, not two");
});

test("the run ending (a finished answer) stops the warm of its last tool call", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    await r.send("s", "stop");
    assert.equal(r.timers.length, 0);
});

test("a request that does not use the cache leaves the pending warm alone", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    await r.send("s", "stop", "none");
    assert.equal(r.timers.length, 1);
});

test("turned off: no warm starts, and a pending one is dropped when it fires", async () => {
    const off = rig(true);

    await off.send("s", "toolUse");
    assert.equal(off.timers.length, 0);

    const r = rig();

    await r.send("s", "toolUse");
    r.setOff(true);
    await r.advance();
    assert.equal(r.calls.length, 1, "only the real request");
    assert.equal(r.timers.length, 0);
});

test("a timer that fires long after its due time sends nothing", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    const timer = r.timers[0];

    assert.ok(timer);
    r.setNow(timer.at + 120_000); // slept through the refresh window; the entry is expired
    r.timers.splice(0, 1);
    timer.fn();
    await new Promise((x) => setTimeout(x, 5));
    assert.equal(r.calls.length, 1, "only the real request");
});

test("the age cap ends warming from the real request, not from the last warm", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    const start = r.now();

    for (let i = 0; i < 40 && r.timers.length > 0; i++) {
        await r.advance();
    }

    assert.ok(r.now() - start < MAX_AGE_MS + 300_000, "it stopped near the cap");
    assert.equal(r.timers.length, 0);
    assert.ok(r.keeper.status().warms >= 5, "it did warm up to the cap");
});

test("close cancels every pending warm", async () => {
    const r = rig();

    await r.send("a", "toolUse");
    await r.send("b", "toolUse");
    assert.equal(r.timers.length, 2);
    r.keeper.close();
    assert.equal(r.timers.length, 0);
});

test("a request with no session id is never warmed", async () => {
    const r = rig();

    await r.send(undefined, "toolUse");
    assert.equal(r.timers.length, 0);
});

test("a warm that ends in an error stops warming that session", async () => {
    const r = rig();

    await r.send("s", "toolUse");
    r.failWarm();
    await r.advance();
    assert.equal(r.timers.length, 0);
    assert.equal(r.keeper.status().warms, 1, "a failed response can still report billable usage");
});

test("a request that ends after close starts no new warm", async () => {
    const r = rig();

    r.keeper.close();
    await r.send("s", "toolUse");
    assert.equal(r.timers.length, 0);
});

test("the end of a run stops its warm and leaves the warm of another conversation", async () => {
    const r = rig();

    await r.send("a", "toolUse");
    await r.send("b", "toolUse");
    await new Promise((x) => setImmediate(x)); // the conversation of each session is found
    r.keeper.runEnded(1);
    assert.equal(r.timers.length, 1);
    r.keeper.runEnded(2);
    assert.equal(r.timers.length, 0);
});

test("a signal that aborts after the request, as Durable's does when an invocation ends, does not stop the warm", async () => {
    const r = rig();
    const abort = new AbortController();

    await r.send("s", "toolUse", "short", abort.signal);
    abort.abort(new Error("invocation has ended"));
    assert.equal(r.timers.length, 1);
    await r.advance();
    assert.equal(r.keeper.status().warms, 1);
});

test("a one hour cache is never warmed: a 30 minute tool wait does not outlive it", async () => {
    const r = rig();

    await r.send("s", "toolUse", "long");
    assert.equal(r.timers.length, 0);
});

test("a tool that waits for a person is bounded by the cap: about six warms, not more", async () => {
    const r = rig();

    await r.send("s", "toolUse");

    for (let i = 0; i < 40 && r.timers.length > 0; i++) {
        await r.advance();
    }

    assert.ok(
        r.keeper.status().warms >= 5 && r.keeper.status().warms <= 7,
        "30 minutes at 270 s is 6 or 7 warms",
    );
});

test("a run that ended before the conversation lookup came back stops the warm", async () => {
    const r = rig();

    r.endRun(3); // session "s" is conversation 3; its run is over when the lookup returns
    await r.send("s", "toolUse");
    await new Promise((x) => setImmediate(x));
    assert.equal(r.timers.length, 0);
});
