import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { limitHeaders, ProviderLimits, recordResponses } from "../src/server/provider-limits.ts";

after(cleanUp);

test("only limit headers are kept: never cookies, credentials, ids, or odd values", () => {
    assert.deepEqual(
        limitHeaders({
            "X-RateLimit-Limit-Tokens-Minute": "500000",
            "x-ratelimit-remaining-tokens-minute": "499983",
            "anthropic-ratelimit-unified-5h-utilization": "0.25",
            "x-codex-primary-used-percent": "40",
            "retry-after": "30",
            "set-cookie": "session=secret",
            authorization: "Bearer secret",
            "x-request-id": "abc",
            "x-ratelimit-note": "<script>",
            "x-ratelimit-long": "9".repeat(500),
        }),
        {
            "x-ratelimit-limit-tokens-minute": "500000",
            "x-ratelimit-remaining-tokens-minute": "499983",
            "anthropic-ratelimit-unified-5h-utilization": "0.25",
            "x-codex-primary-used-percent": "40",
            "retry-after": "30",
        },
    );
});

test("every streamed request records its response, and the caller's own callback still runs", async () => {
    const limits = new ProviderLimits();
    const seen: number[] = [];
    let streamed: { onResponse?: (...args: never[]) => unknown } | undefined;
    const models = {
        streamSimple(_model: unknown, _context: unknown, options: typeof streamed) {
            streamed = options;

            return "stream";
        },
    } as unknown as ModelRuntime;

    recordResponses(models, limits);
    // An extension's provider, such as Claude Bridge, refuses request callbacks: it gets none.
    models.streamSimple({ provider: "claude-bridge", api: "claude-bridge" } as never, {
        messages: [],
    });
    assert.equal(streamed, undefined);
    const result = models.streamSimple(
        { provider: "mistral", api: "mistral-conversations" } as never,
        { messages: [] },
        {
            onResponse: (response) => {
                seen.push(response.status);
            },
        },
    );

    assert.equal(result, "stream" as never);
    await (streamed!.onResponse as (...args: unknown[]) => Promise<void>)(
        { status: 429, headers: { "x-ratelimit-remaining-req-minute": "0" } },
        { provider: "mistral" },
    );
    assert.deepEqual(seen, [429]);
});

test("concurrent streams correlate their own response headers, never another chat's provider-wide sample", async () => {
    const now = 1_700_000_000_000;
    const limits = new ProviderLimits(() => now);
    const callbacks: ((
        response: { status: number; headers: Record<string, string> },
        model: { provider: string },
    ) => Promise<void>)[] = [];
    const resolvers: ((message: AssistantMessage) => void)[] = [];
    const models = {
        streamSimple(
            _model: unknown,
            _context: unknown,
            options: { onResponse: (typeof callbacks)[number] },
        ) {
            callbacks.push(options.onResponse);
            const result = new Promise<AssistantMessage>((resolve) => resolvers.push(resolve));

            return { result: () => result };
        },
    } as unknown as ModelRuntime;

    recordResponses(models, limits);
    const first = models.streamSimple(
        { provider: "openai-codex", api: "openai-codex-responses" } as never,
        { messages: [] },
    );
    const second = models.streamSimple(
        { provider: "openai-codex", api: "openai-codex-responses" } as never,
        { messages: [] },
    );
    const response = (seconds: number) => ({
        status: 429,
        headers: {
            "x-codex-primary-used-percent": "100",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-after-seconds": String(seconds),
        },
    });

    await callbacks[0]!(response(600), { provider: "openai-codex" });
    await callbacks[1]!(response(60), { provider: "openai-codex" });
    const a = fauxAssistantMessage([], { stopReason: "error", errorMessage: "Usage refused" });
    const b = fauxAssistantMessage([], { stopReason: "error", errorMessage: "Usage refused" });

    resolvers[1]!(b);
    resolvers[0]!(a);
    await Promise.all([first.result(), second.result()]);
    assert.equal(limits.forResponse(a)?.headers["x-codex-primary-reset-after-seconds"], "600");
    assert.equal(limits.forResponse(b)?.headers["x-codex-primary-reset-after-seconds"], "60");
    const unrelated = fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Usage refused",
    });

    assert.equal(limits.forResponse(unrelated), undefined);
});
