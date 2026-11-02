import assert from "node:assert/strict";
import { test } from "node:test";
import {
    normalizeContext,
    type Api,
    type Model,
    type SimpleStreamOptions,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installRequestShaping } from "../src/server/app.ts";

const model = {
    provider: "mistral",
    api: "openai-completions",
    baseUrl: "https://api.mistral.ai/v1",
    id: "mistral-test",
    name: "Mistral test",
    reasoning: false,
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-completions">;

test("the Mistral adapter sends the key in the final wire payload", async () => {
    let body: Record<string, unknown> | undefined;
    const models = {
        streamSimple(
            current: Model<Api>,
            context: TranscriptContext,
            options?: SimpleStreamOptions,
        ) {
            return streamSimple(current as Model<"openai-completions">, context, options);
        },
    };

    installRequestShaping(models, [], () => {});
    await models
        .streamSimple(
            model,
            normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }),
            {
                sessionId: "session-one",
                cacheRetention: "short",
                apiKey: "synthetic",
                fetch: async (_url, init) => {
                    body = JSON.parse(String(init?.body));

                    return new Response("synthetic failure", { status: 400 });
                },
            },
        )
        .result();
    assert.match(String(body?.prompt_cache_key), /^[a-f0-9]{64}$/);
});

test("Mistral chat requests get a stable session key without overriding a caller", async () => {
    let seen: SimpleStreamOptions | undefined;
    const models = {
        streamSimple: ((_model: unknown, _context: unknown, options?: SimpleStreamOptions) => {
            seen = options;
        }) as ModelRuntime["streamSimple"],
    };

    installRequestShaping(models, [], () => {});

    async function shape(current: typeof model, options: SimpleStreamOptions) {
        seen = undefined;
        models.streamSimple(current, {} as never, options);

        return (seen as SimpleStreamOptions | undefined)?.onPayload?.({ messages: [] }, current);
    }

    const first = (await shape(model, { sessionId: "session-one" })) as Record<string, unknown>;
    const second = (await shape(model, { sessionId: "session-one" })) as Record<string, unknown>;
    const other = (await shape(model, { sessionId: "session-two" })) as Record<string, unknown>;

    assert.match(String(first.prompt_cache_key), /^[a-f0-9]{64}$/);
    assert.deepEqual(first, second);
    assert.notEqual(first.prompt_cache_key, other.prompt_cache_key);
    assert.deepEqual(
        await shape(model, {
            sessionId: "session-one",
            onPayload: () => ({ prompt_cache_key: "caller" }),
        }),
        { prompt_cache_key: "caller" },
    );
    assert.equal(
        await shape(model, { sessionId: "session-one", cacheRetention: "none" }),
        undefined,
    );
    assert.equal(await shape(model, {}), undefined);
    assert.equal(
        await shape(
            { ...model, baseUrl: "https://api.mistral.ai.evil.test" },
            { sessionId: "session-one" },
        ),
        undefined,
    );
    assert.equal(
        await shape({ ...model, provider: "other" }, { sessionId: "session-one" }),
        undefined,
    );
});
