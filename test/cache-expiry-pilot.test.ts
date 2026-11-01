// Native Anthropic adapter, intercepted fetch, and a fake clock. No provider receives these requests.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    type Api,
    type Model,
    normalizeContext,
    type SimpleStreamOptions,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { installRequestShaping, type PocketApp } from "../src/server/app.ts";
import {
    assessCacheContext,
    CacheExpiryPilot,
    cacheTtlMs,
    type CacheAssessment,
} from "../src/server/cache-expiry-pilot.ts";
import type { ModelRequestShaper } from "../src/server/host.ts";

const MODEL: Model<"anthropic-messages"> = {
    id: "synthetic-claude",
    name: "Synthetic Claude",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 8192,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    promptCache: { short: 300, long: 3600 },
};
const context = normalizeContext({
    messages: [
        {
            role: "system",
            content: "private system text",
            timestamp: 0,
            toolsAdded: [
                {
                    name: "inspect",
                    description: "Inspect a file",
                    parameters: { type: "object", properties: {} },
                },
            ],
        },
        { role: "user", content: "private message text", timestamp: 0 },
    ],
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });

    return { promise, resolve };
};

function rig() {
    let now = 1_000_000;
    let mapping: number | undefined = 7;
    let read = 50_000;
    let write = 0;
    let hold: Promise<void> | undefined;
    const logs: Record<string, unknown>[] = [];
    const bodies: unknown[] = [];
    const assessed: number[] = [];
    const shapers: ModelRequestShaper[] = [];
    const timers = new Map<ReturnType<typeof setTimeout>, { at: number; fn: () => void }>();
    let assessment: () => Promise<CacheAssessment> = async () => ({ reason: "test candidate" });
    const pilot = new CacheExpiryPilot({
        now: () => now,
        conversationOf: async () => mapping,
        assess: async (id, model) => {
            assert.equal(model, MODEL);
            assessed.push(id);

            return assessment();
        },
        log: (line) => logs.push(JSON.parse(line.slice("[cache-expiry-pilot] ".length))),
        setTimer: (fn, ms) => {
            const timer = {} as ReturnType<typeof setTimeout>;

            timers.set(timer, { at: now + ms, fn });

            return timer;
        },
        clearTimer: (timer) => {
            timers.delete(timer);
        },
    });
    const models = {
        streamSimple(model: Model<Api>, ctx: TranscriptContext, options?: SimpleStreamOptions) {
            return streamSimple(model as Model<"anthropic-messages">, ctx, options);
        },
    };

    const fetch: typeof globalThis.fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));

        const cachedRead = read;
        const cachedWrite = write;

        await hold;

        const events = [
            {
                type: "message_start",
                message: {
                    id: "synthetic",
                    type: "message",
                    role: "assistant",
                    model: MODEL.id,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: {
                        input_tokens: 100,
                        output_tokens: 0,
                        cache_read_input_tokens: cachedRead,
                        cache_creation_input_tokens: cachedWrite,
                    },
                },
            },
            {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
            },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
            { type: "content_block_stop", index: 0 },
            {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
        ];

        return new Response(
            events
                .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                .join(""),
            { status: 200, headers: { "content-type": "text/event-stream" } },
        );
    };

    pilot.install(models);
    installRequestShaping(models, shapers, () => {});

    return {
        pilot,
        logs,
        bodies,
        assessed,
        timers,
        shapers,
        now: () => now,
        setNow: (value: number) => {
            now = value;
        },
        setMapping: (value: number | undefined) => {
            mapping = value;
        },
        setUsage: (r: number, w = 0) => {
            read = r;
            write = w;
        },
        hold: (promise?: Promise<void>) => {
            hold = promise;
        },
        assess: (fn: () => Promise<CacheAssessment>) => {
            assessment = fn;
        },
        send: async (
            options: SimpleStreamOptions = {},
            model: Model<Api> = MODEL,
            requestContext: TranscriptContext = context,
        ) => {
            const message = await models
                .streamSimple(model, requestContext, {
                    apiKey: "synthetic-not-a-key",
                    fetch,
                    sessionId: "private-provider-session",
                    cacheRetention: "short",
                    maxRetries: 0,
                    ...options,
                })
                .result();

            await flush();

            return message;
        },
        fire: async (at?: number) => {
            const [timer, pending] = timers.entries().next().value!;

            assert.ok(pending, "one timer is pending");
            timers.delete(timer);
            now = at ?? pending.at;
            pending.fn();
            await flush();
        },
    };
}

for (const [retention, ttlMs] of [
    ["short", 300_000],
    ["long", 3_600_000],
] as const) {
    test(`${retention}: actual adapter payload and cache usage establish one inferred deadline`, async (t) => {
        const r = rig();

        t.after(() => r.pilot.close());
        await r.send({ cacheRetention: retention });
        assert.equal(r.timers.size, 1);
        assert.equal(r.logs[0]!.ttlMs, ttlMs);
        assert.equal(r.logs[0]!.estimatedExpiresAt, 1_000_000 + ttlMs);
        assert.equal(r.logs[0]!.decisionAt, 1_000_000 + ttlMs * 0.9);
        await r.fire();
        assert.deepEqual(r.assessed, [7]);
        assert.equal(r.logs[1]!.action, "observe-only");
        assert.equal(r.timers.size, 0, "a decision never rearms itself");
        assert.equal(r.bodies.length, 1, "the pilot never sends or warms");
        assert.doesNotMatch(
            JSON.stringify(r.logs),
            /private|synthetic-not-a-key|system text|message text/,
        );
    });
}

test("cache writes establish a deadline; zero cache usage and disabled caching do not", async (t) => {
    const r = rig();

    t.after(() => r.pilot.close());
    r.setUsage(0, 50_000);
    await r.send();
    assert.equal(r.timers.size, 1);
    r.setUsage(0);
    await r.send();
    assert.equal(
        r.timers.size,
        0,
        "even an unsupported new request invalidates the old observation",
    );
    r.setUsage(50_000);
    await r.send({ cacheRetention: "none" });
    assert.equal(r.timers.size, 0);
});

test("a scripted summary probe preserves the original wire prefix through the public payload hook", async (t) => {
    const r = rig();

    t.after(() => r.pilot.close());

    const answer = await r.send();
    const original = r.bodies[0] as Record<string, unknown> & { messages: unknown[] };

    assert.ok(Array.isArray(original.tools) && original.tools.length > 0);

    const summaryContext = normalizeContext({
        messages: [
            ...context.messages,
            answer,
            { role: "user", content: "Write a factual handoff summary.", timestamp: 1 },
        ],
    });

    await r.send(
        {
            maxTokens: 4096,
            onPayload: (payload) => {
                const next = payload as typeof original;

                return {
                    ...original,
                    max_tokens: 4096,
                    // Preserve even the old cache-control markers; append only the new suffix.
                    messages: [
                        ...original.messages,
                        ...next.messages.slice(original.messages.length),
                    ],
                };
            },
        },
        MODEL,
        summaryContext,
    );

    const summary = r.bodies[1] as typeof original;

    assert.equal(summary.messages.length, original.messages.length + 2);
    assert.deepEqual(
        {
            ...summary,
            messages: summary.messages.slice(0, original.messages.length),
            max_tokens: original.max_tokens,
        },
        original,
    );
    assert.equal(r.bodies.length, 2, "only the 2 explicitly requested synthetic calls occur");
    assert.equal(
        r.logs[1]!.cacheRead,
        50_000,
        "synthetic usage, not evidence of a provider cache hit",
    );
});

test("the final shaper, not the retention option, determines the observed TTL", async (t) => {
    const r = rig();

    t.after(() => r.pilot.close());
    r.shapers.push((payload) =>
        JSON.parse(JSON.stringify(payload).replaceAll('"ttl":"1h"', '"ttl":"5m"')),
    );
    await r.send({ cacheRetention: "long" });
    assert.equal(r.logs[0]!.ttlMs, 300_000);
    assert.equal(cacheTtlMs(MODEL, r.bodies[0]), 300_000);
});

test("unknown providers, proxies, metadata and TTLs never create speculative timers", async (t) => {
    const r = rig();

    t.after(() => r.pilot.close());

    for (const model of [
        { ...MODEL, baseUrl: "https://proxy.example.test" },
        { ...MODEL, baseUrl: "not a URL" },
        { ...MODEL, promptCache: undefined },
        { ...MODEL, promptCache: { short: 301, long: 3600 } },
        { ...MODEL, api: "openai-responses" } as Model<Api>,
    ]) {
        await r.send({}, model);
        assert.equal(r.timers.size, 0);
    }

    r.shapers.push((payload) =>
        JSON.parse(JSON.stringify(payload).replaceAll('"ephemeral"', '"unknown"')),
    );
    await r.send();
    assert.equal(r.timers.size, 0);
});

test("a system-only cache cannot establish a conversation deadline; mixed TTLs choose the shortest", () => {
    const payload = {
        model: MODEL.id,
        system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };

    assert.equal(cacheTtlMs(MODEL, payload), undefined);
    Object.assign(payload.messages[0]!.content[0]!, { cache_control: { type: "ephemeral" } });
    assert.equal(cacheTtlMs(MODEL, payload), 300_000);
    assert.equal(cacheTtlMs(MODEL, { ...payload, model: "changed-model" }), undefined);
    Object.assign(payload.messages[0]!.content[0]!, {
        cache_control: { type: "ephemeral", ttl: "2h" },
    });
    assert.equal(cacheTtlMs(MODEL, payload), undefined);
});

test("a newer request refreshes the estimate; an older response cannot replace it", async (t) => {
    const r = rig();
    const barrier = deferred();

    t.after(() => r.pilot.close());
    r.hold(barrier.promise);

    const old = r.send({ cacheRetention: "long" });

    await flush();
    r.hold();
    r.setNow(1_010_000);
    await r.send();
    barrier.resolve();
    await old;
    assert.equal(r.logs.length, 1);
    assert.equal(r.logs[0]!.startedAt, 1_010_000);
    assert.equal(r.logs[0]!.ttlMs, 300_000);
    assert.equal(r.timers.size, 1);
});

test("the conversation identity is captured while its run still exists", async (t) => {
    const r = rig();
    const barrier = deferred();

    t.after(() => r.pilot.close());
    r.hold(barrier.promise);

    const pending = r.send();

    await flush();
    r.setMapping(undefined);
    barrier.resolve();
    await pending;
    assert.equal(r.logs[0]!.conversationId, 7);
});

test("late responses and suspended or backwards clocks never cause catch-up work", async (t) => {
    const r = rig();
    const barrier = deferred();

    t.after(() => r.pilot.close());
    r.hold(barrier.promise);

    const pending = r.send();

    await flush();
    r.setNow(1_280_000);
    barrier.resolve();
    await pending;
    assert.equal(r.timers.size, 0);
    r.hold();
    await r.send();
    await r.fire(r.now() + 400_000);
    assert.equal(r.assessed.length, 0);
    await r.send();
    await r.fire(r.now() - 10_000);
    assert.equal(r.assessed.length, 0);
    assert.equal(r.timers.size, 0);
});

test("close and restart discard observations; an in-flight response cannot rearm them", async () => {
    const r = rig();
    const barrier = deferred();

    r.hold(barrier.promise);

    const pending = r.send();

    await flush();
    r.pilot.close();
    barrier.resolve();
    await pending;
    assert.equal(r.timers.size, 0);
    assert.equal(r.logs.length, 0);

    const restarted = rig();

    assert.equal(restarted.timers.size, 0);
    restarted.pilot.close();
});

test("a new request, shutdown or missed deadline invalidates an asynchronous assessment", async (t) => {
    for (const action of ["request", "close", "late"] as const) {
        const r = rig();
        const barrier = deferred();

        t.after(() => r.pilot.close());
        r.assess(async () => {
            await barrier.promise;

            return { reason: "test candidate" };
        });
        await r.send();
        await r.fire();

        if (action === "request") {
            await r.send();
        } else if (action === "close") {
            r.pilot.close();
        } else {
            r.setNow(r.now() + 30_000);
        }

        barrier.resolve();
        await flush();
        assert.equal(r.logs.filter((log) => log.event === "decision").length, 0);
    }
});

test("aborted requests never arm; assessment failures do not retry", async (t) => {
    const r = rig();
    const abort = new AbortController();

    t.after(() => r.pilot.close());
    abort.abort();
    await r.send({ signal: abort.signal });
    assert.equal(r.timers.size, 0);
    r.assess(async () => {
        throw new Error("private failure detail");
    });
    await r.send();
    await r.fire();
    assert.equal(r.timers.size, 0);
    assert.equal(r.logs.at(-1)!.reason, "assessment failed");
    assert.doesNotMatch(JSON.stringify(r.logs), /private failure detail/);
});

function assessmentApp() {
    let policy = { enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_384 };
    let budget = false;
    let busy = false;
    let model = { provider: MODEL.provider, modelId: MODEL.id };
    let lastPolicyModel: unknown;
    let head: { id: number; kind: string } | undefined;
    const message = {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input: 100_000, output: 1, cacheRead: 0, cacheWrite: 0 },
    };
    const view = {
        get head() {
            return head;
        },
        entries: [{ id: 1 }],
        contributions: [[message]],
        messages: [message],
    };
    const app = {
        sessionMeta: () => ({}),
        pip: { ownerOf: () => undefined },
        parentOf: () => undefined,
        isBusy: () => busy,
        isCompacting: () => false,
        config: { compactIdleHours: 1 },
        agentState: async () => ({ model }),
        settings: {
            getCompactionSettings: (activeModel: unknown) => {
                lastPolicyModel = activeModel;

                return policy;
            },
        },
        spend: { heldBack: () => (budget ? "limited" : undefined) },
        conversation: async () => ({ context: async () => view }),
    };

    return {
        app: app as unknown as PocketApp,
        assess: () => assessCacheContext(app as unknown as PocketApp, 7 as ConversationId, MODEL),
        policy: (value: typeof policy) => {
            policy = value;
        },
        budget: (value: boolean) => {
            budget = value;
        },
        busy: (value: boolean) => {
            busy = value;
        },
        model: (value: typeof model) => {
            model = value;
        },
        policyModel: () => lastPolicyModel,
        compacted: () => {
            head = { id: 0, kind: "pi.compaction" };
        },
    };
}

test("assessment uses the public getter with the active model and honors effective overrides", async () => {
    const r = assessmentApp();
    const candidate = await r.assess();

    assert.match(candidate.reason, /^context candidate/);
    assert.equal(r.policyModel(), MODEL);
    r.policy({ enabled: true, keepRecentTokens: 100_000, reserveTokens: 12_000 });

    const small = await r.assess();

    assert.match(small.reason, /^too little/);
    assert.equal(small.reserveTokens, 12_000);
    r.policy({ enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_384 });
    r.compacted();
    assert.match(
        (await r.assess()).reason,
        /^too little/,
        "no repeated candidate without regrowth",
    );
    r.policy({ enabled: false, keepRecentTokens: 1, reserveTokens: 1 });
    assert.match((await r.assess()).reason, /disabled/);
});

test("real in-memory Pi settings resolve model overrides without reading private fields", async () => {
    const r = assessmentApp();

    r.app.settings = SettingsManager.inMemory({
        compaction: {
            keepRecentTokens: 90_000,
            reserveTokens: 16_384,
            modelOverrides: {
                [`${MODEL.provider}/${MODEL.id}`]: {
                    keepRecentTokens: 50_000,
                    reserveTokens: 12_000,
                },
            },
        },
    });

    const result = await r.assess();

    assert.equal(result.keepRecentTokens, 50_000);
    assert.equal(result.reserveTokens, 12_000);
    assert.match(result.reason, /^context candidate/);
});

test("busy, disabled, changed-model and budget-limited conversations are not candidates", async () => {
    const r = assessmentApp();

    r.busy(true);
    assert.equal((await r.assess()).reason, "conversation busy");
    r.busy(false);
    r.app.config.compactIdleHours = 0;
    assert.match((await r.assess()).reason, /disabled/);
    r.app.config.compactIdleHours = 1;
    r.model({ provider: MODEL.provider, modelId: "other" });
    assert.equal((await r.assess()).reason, "model changed");
    r.model({ provider: MODEL.provider, modelId: MODEL.id });
    r.budget(true);
    assert.equal((await r.assess()).reason, "budget limit");
});
