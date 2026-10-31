// Use the real Anthropic adapter and intercept fetch. A changed final payload must never reach the wire.
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
import type { ModelRequestShaper } from "../src/server/host.ts";
import { installRequestShaping } from "../src/server/app.ts";
import { CacheKeeper } from "../src/server/cache-keeper.ts";

const model: Model<"anthropic-messages"> = {
    id: "synthetic-claude",
    name: "Synthetic Claude",
    provider: "anthropic",
    api: "anthropic-messages",
    reasoning: true,
    input: ["text"],
    baseUrl: "http://127.0.0.43:9940",
    contextWindow: 200_000,
    maxTokens: 8192,
    compat: { forceAdaptiveThinking: true },
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    promptCache: { short: 300, long: 3600 },
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const change of ["added", "removed", "changed", "unchanged"] as const) {
    test(`the final payload guard handles a shaper ${change} during a tool wait`, async (t) => {
        let now = 0;
        let text = "original shaped system";
        let recorded = 0;
        const bodies: Record<string, unknown>[] = [];
        const timers = new Map<ReturnType<typeof setTimeout>, { at: number; fn: () => void }>();
        const shape: ModelRequestShaper = (payload) => ({
            ...(payload as object),
            system: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
        });
        const shapers: ModelRequestShaper[] = change === "added" ? [] : [shape];
        const keeper = new CacheKeeper({
            now: () => now,
            disabled: () => false,
            conversationOf: async () => 1,
            isRunning: () => true,
            accountFor: () => ({
                check: () => true,
                recordUsage: async () => {
                    recorded++;
                },
            }),
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
            streamSimple(m: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
                return streamSimple(m as Model<"anthropic-messages">, context, options);
            },
        };

        const fetch: typeof globalThis.fetch = async (_url, init) => {
            bodies.push(JSON.parse(String(init?.body)));

            const events = [
                {
                    type: "message_start",
                    message: {
                        id: "synthetic",
                        type: "message",
                        role: "assistant",
                        model: model.id,
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: {
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_read_input_tokens: 50_000,
                            cache_creation_input_tokens: 0,
                        },
                    },
                },
                {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "tool_use", id: "call", name: "wait", input: {} },
                },
                {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "input_json_delta", partial_json: "{}" },
                },
                { type: "content_block_stop", index: 0 },
                {
                    type: "message_delta",
                    delta: { stop_reason: "tool_use", stop_sequence: null },
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

        t.after(() => keeper.close());
        keeper.installPayloadObserver(models);
        installRequestShaping(models, shapers, () => {});
        keeper.install(models);

        const context = normalizeContext({
            messages: [
                {
                    role: "system",
                    content: "initial system",
                    toolsAdded: [
                        {
                            name: "wait",
                            description: "Wait",
                            parameters: { type: "object", properties: {} },
                        },
                    ],
                    timestamp: 0,
                },
                { role: "user", content: "work", timestamp: 0 },
            ],
        });
        const result = await models
            .streamSimple(model, context, {
                apiKey: "synthetic-not-a-key",
                fetch,
                sessionId: "payload-guard",
                reasoning: "high",
                cacheRetention: "short",
            })
            .result();

        await flush();
        assert.equal(result.stopReason, "toolUse");
        assert.equal(bodies.length, 1);
        assert.equal(timers.size, 1);

        if (change === "added") {
            shapers.push(shape);
        } else if (change === "removed") {
            shapers.splice(0);
        } else if (change === "changed") {
            // No lifecycle change: a stateful shaper changes its output.
            text = "changed shaped system";
        }

        const [handle, timer] = [...timers][0]!;

        timers.delete(handle);
        now = timer.at;
        timer.fn();

        for (
            let i = 0;
            i < 100 && (change === "unchanged" ? recorded === 0 : keeper.status().warming !== 0);
            i++
        ) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        if (change === "unchanged") {
            assert.equal(bodies.length, 2, "The unchanged shaper must still send a warm.");
            assert.equal(bodies[1]!.max_tokens, 1);
            const withoutCap = ({ max_tokens: _cap, ...rest }: Record<string, unknown>) => rest;

            assert.deepEqual(withoutCap(bodies[0]!), withoutCap(bodies[1]!));
            assert.equal(recorded, 1);
            assert.equal(keeper.status().warms, 1);
            assert.equal(timers.size, 1);
        } else {
            // Let the adapter return its synthetic error after the guard throws.
            await flush();
            assert.equal(bodies.length, 1, "The changed warm must never reach intercepted fetch.");
            assert.equal(recorded, 0, "An unsent warm must not enter the spend ledger.");
            assert.deepEqual(keeper.status(), { warming: 0, warms: 0, spent: 0 });
            assert.equal(timers.size, 0);
        }
    });
}
