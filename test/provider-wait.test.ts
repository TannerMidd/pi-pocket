import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, type Classified } from "../src/server/limits.ts";

const now = Date.parse("2026-10-22T12:00:00Z");
const minute = 60_000;
const hour = 3_600_000;
const cases: {
    name: string;
    message: string;
    status?: number;
    headers?: Record<string, string>;
    reset?: number;
    subscription?: boolean;
    long?: boolean;
    other?: boolean;
    scope?: "account" | "model";
}[] = [
    // Fixture sources and exact provider errors are reused from usage-limits.test.ts.
    {
        name: "OpenAI 429 rate limit",
        message:
            "429 Rate limit reached for default-codex in organization org-x on requests per min. Limit: 20.000000 / min. Current: 24.000000 / min.",
        status: 429,
    },
    {
        name: "Azure retry-after-ms",
        message: "429 Rate limit is exceeded.",
        status: 429,
        headers: { "retry-after-ms": "1500" },
        reset: 1500,
    },
    {
        name: "OpenAI insufficient_quota",
        message:
            '429 {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
        status: 429,
        other: true,
    },
    {
        name: "legacy Codex five-hour limit",
        message: "You have hit your ChatGPT usage limit (plus plan). Try again in ~93 min.",
        reset: 93 * minute,
    },
    {
        name: "Codex weekly used 100 without reset",
        message: "You have hit your ChatGPT usage limit.",
        status: 429,
        headers: {
            "x-codex-secondary-used-percent": "100",
            "x-codex-secondary-window-minutes": "10080",
        },
        other: true,
    },
    {
        name: "Anthropic rate limit",
        message:
            '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}',
        status: 429,
    },
    {
        name: "Anthropic rejected 5h without reset",
        message:
            '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}',
        status: 429,
        headers: { "anthropic-ratelimit-unified-5h-status": "rejected" },
        subscription: true,
    },
    {
        name: "Anthropic model five-hour cap without reset",
        message: "429 rate_limit_error",
        status: 429,
        headers: {
            "anthropic-ratelimit-unified-5h-status": "rejected",
            "anthropic-ratelimit-unified-representative-claim": "five_hour_opus",
        },
        subscription: true,
        scope: "model",
    },
    {
        name: "Anthropic five-hour cap uses Retry-After when the named reset is missing",
        message: "429 rate_limit_error",
        status: 429,
        headers: {
            "anthropic-ratelimit-unified-5h-status": "rejected",
            "retry-after": "60",
        },
        reset: 60_000,
        scope: "account",
    },
    {
        name: "Anthropic rejected weekly without reset",
        message:
            '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}',
        status: 429,
        headers: { "anthropic-ratelimit-unified-7d-status": "rejected" },
        other: true,
    },
    {
        name: "Google RetryInfo despite billing-help prose",
        message:
            '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. Please retry in 53.016342224s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"53s"}]}}',
        reset: 53_000,
    },
    {
        name: "Google Gemini compact reset",
        message:
            '429 {"error":{"code":429,"message":"You have exhausted your capacity on this model. Your quota will reset after 2h34m12s.","status":"RESOURCE_EXHAUSTED"}}',
        reset: 2 * hour + 34 * minute + 12_000,
    },
    {
        name: "Google daily quota",
        message:
            "429 You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_model_per_day, limit: 0",
        status: 429,
        other: true,
    },
    {
        name: "Mistral rate limit",
        message:
            'Mistral API error (429): {"object":"error","message":"Requests rate limit exceeded","type":"rate_limit_error"}',
        status: 429,
    },
    {
        name: "Bedrock throttling",
        message: "ThrottlingException: Too many tokens, please wait before trying again.",
    },
    {
        name: "OpenRouter rate limit",
        message:
            '429 {"error":{"code":429,"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded"}}}',
        status: 429,
    },
    {
        name: "OpenRouter weekly spend cap",
        message:
            '403 {"error":{"code":403,"message":"Org member budget limit exceeded (weekly limit). Contact your org admin.","metadata":{"resets_at":"2026-10-12T00:00:00.000Z"}}}',
        status: 403,
        other: true,
    },
    {
        name: "Groq transient rate limit",
        message:
            '429 {"error":{"message":"Rate limit reached for model `gemma2-9b-it` on tokens per minute (TPM): Limit 15000, Used 11972, Requested 4351. Please try again in 5.289s.","type":"tokens","code":"rate_limit_exceeded"}}',
        status: 429,
        reset: 5289,
    },
    {
        name: "DeepSeek insufficient balance",
        message: "402 Insufficient Balance",
        status: 402,
        other: true,
    },
    {
        name: "Fireworks rate limit",
        message:
            '429 {"error":{"type":"invalid_request_error","message":"rate limit exceeded, please try again later"}}',
        status: 429,
    },
    {
        name: "OpenCode Go reset in 3 hours",
        message:
            "429 GoUsageLimitError: 5-hour usage limit reached. It will reset in 3 hours. To continue using this model now, enable usage from your available balance",
        status: 429,
        reset: 3 * hour,
    },
    {
        name: "OpenCode weekly",
        message: "429 GoUsageLimitError: Weekly usage limit reached. It will reset in 4 days.",
        status: 429,
        long: true,
    },
    {
        name: "FreeUsageLimitError",
        message: "429 FreeUsageLimitError: Free limit reached",
        status: 429,
        other: true,
    },
    {
        name: "Z.ai 1308 unknown timezone",
        message:
            '429 {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-10-22 18:00:00"}}',
        status: 429,
        subscription: true,
    },
    {
        name: "Z.ai 1308 extra usage with balance",
        message:
            '429 {"error":{"code":"1308","message":"Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2026-10-22 18:00:00."}}',
        status: 429,
        subscription: true,
    },
    {
        name: "Z.ai 1113 insufficient balance",
        message:
            '429 {"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}',
        status: 429,
        other: true,
    },
    {
        name: "Kimi RPM",
        message:
            '429 {"error":{"type":"rate_limit_reached_error","message":"Organization-level RPM limit reached"}}',
        status: 429,
    },
    {
        name: "Kimi TPD",
        message:
            '429 {"error":{"type":"rate_limit_reached_error","message":"Organization-level TPD limit reached"}}',
        status: 429,
        other: true,
    },
    {
        name: "MiniMax usage limit",
        message: '{"base_resp":{"status_code":2056,"status_msg":"usage limit exceeded"}}',
        subscription: true,
    },
    {
        name: "MiniMax insufficient balance",
        message: '{"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}',
        other: true,
    },
    {
        name: "Qwen throttling",
        message:
            '429 {"code":"Throttling.RateQuota","message":"Requests rate limit exceeded, please try again later."}',
        status: 429,
    },
    { name: "Xiaomi MiMo too many requests", message: "429 Too Many Requests", status: 429 },
    {
        name: "billing 402",
        message: '402 {"error":{"message":"Payment required"}}',
        status: 402,
        other: true,
    },
    {
        name: "organization spend cap",
        message:
            '429 {"error":{"code":"organization_spend_limit_exceeded","type":"insufficient_quota"}}',
        status: 429,
        other: true,
    },
    {
        name: "workspace cap",
        message: "subscription_sharing_workplace_individual_usage_limit_exceeded",
        status: 429,
        other: true,
    },
    { name: "invalid auth", message: "401 Unauthorized", status: 401, other: true },
    { name: "context overflow", message: "prompt is too long", other: true },
];

for (const fixture of cases) {
    test("built-in classifier: " + fixture.name, () => {
        const verdict: Classified = classify({
            provider: "test",
            message: fixture.message,
            now,
            ...(fixture.status === undefined
                ? {}
                : { facts: { status: fixture.status, headers: fixture.headers ?? {} } }),
            ...(fixture.name === "context overflow" ? { contextOverflow: true } : {}),
        });

        assert.equal(
            verdict.type === "other",
            fixture.other ?? false,
            fixture.name + ": " + JSON.stringify(verdict),
        );

        if (verdict.type !== "limit") {
            return;
        }

        if (fixture.scope !== undefined) {
            assert.equal(verdict.scope, fixture.scope, fixture.name);
        }

        if (fixture.reset !== undefined) {
            assert.equal(verdict.resetAt, now + fixture.reset, fixture.name);
        } else if (fixture.subscription) {
            assert.equal(verdict.subscription, true, fixture.name);
            assert.equal(verdict.backoff, true, fixture.name);
        } else if (fixture.long) {
            assert.equal(verdict.long, true, fixture.name);
        } else {
            assert.equal(verdict.backoff, true, fixture.name);
        }
    });
}
