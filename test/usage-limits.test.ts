// How auto-resume reads the quota and rate-limit errors of the providers that come with Pi. Each example is a real
// error, from the source named beside it, as pi-ai passes it on: no request goes to a provider.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    classify,
    durationMs,
    MAX_WAIT_MS,
    RESET_GRACE_MS,
    type Verdict,
} from "../src/server/extensions/_usage-limits.ts";
import { parseDelay } from "../src/server/extensions/auto-resume.ts";

const now = 1_800_000_000_000;
const minute = 60_000;
const resetIn = (ms: number): Verdict => ({
    kind: "reset",
    at: now + ms + RESET_GRACE_MS,
    from: "message",
});
const headers = (status: number, values: Record<string, string>) => ({
    at: now,
    status,
    headers: values,
});

const skip = (error: string, limit?: Parameters<typeof classify>[1]) => {
    const verdict = classify(error, limit, now);

    assert.equal(verdict.kind, "skip", `${error}: ${JSON.stringify(verdict)}`);
};

const retry = (error: string, limit = true) =>
    assert.deepEqual(classify(error, undefined, now), { kind: "retry", limit }, error);

test("OpenAI and Azure: a rate limit waits for retry-after; quota and billing errors stay manual", () => {
    // https://developers.openai.com/cookbook/examples/how_to_handle_rate_limits/
    const rate =
        "429 Rate limit reached for default-codex in organization org-x on requests per min. Limit: 20.000000 / min. Current: 24.000000 / min.";

    retry(rate);
    assert.deepEqual(classify(rate, headers(429, { "retry-after": "20" }), now), {
        kind: "reset",
        at: now + 20_000 + RESET_GRACE_MS,
        from: "headers",
    });
    skip(
        '429 {"error": {"message": "You exceeded your current quota, please check your plan and billing details.", "type": "insufficient_quota", "code": "insufficient_quota"}}',
    );
    // https://help.openai.com/en/articles/5955604-troubleshooting-api-rate-limits-and-429-errors
    skip(
        '429 {"error": {"code": "organization_spend_limit_exceeded", "type": "insufficient_quota"}}',
    );
    // https://learn.microsoft.com/en-us/microsoft-cloud/dev/dev-proxy/concepts/azure-openai-429-token-rate-limit
    assert.deepEqual(
        classify("429 Rate limit is exceeded.", headers(429, { "retry-after-ms": "1500" }), now),
        {
            kind: "reset",
            at: now + 1500 + RESET_GRACE_MS,
            from: "headers",
        },
    );
    // https://learn.microsoft.com/en-us/answers/questions/1693832/azure-openai-error-429-request-below-rate-limit
    skip(
        '{"error":{"code":"429","message":"Rate limit is exceeded. Try again in 86400 seconds."}}',
    );
});

test("Codex with Sign in with ChatGPT: the five-hour window resets from its headers or words", () => {
    // pi-ai's own words for `usage_limit_reached` (openai-codex-responses.js, parseErrorResponse).
    assert.deepEqual(
        classify(
            "You have hit your ChatGPT usage limit (plus plan). Try again in ~93 min.",
            undefined,
            now,
        ),
        resetIn(93 * minute),
    );
    // https://github.com/router-for-me/CLIProxyAPI/issues/1666
    assert.deepEqual(
        classify(
            '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1800003600,"resets_in_seconds":3600}}',
            undefined,
            now,
        ),
        resetIn(3_600_000),
    );
    assert.deepEqual(
        classify(
            "You have hit your ChatGPT usage limit.",
            headers(429, {
                "x-codex-primary-used-percent": "100",
                "x-codex-primary-window-minutes": "300",
                "x-codex-primary-reset-after-seconds": "600",
            }),
            now,
        ),
        { kind: "reset", at: now + 600_000 + RESET_GRACE_MS, from: "headers" },
    );
    // The weekly window: a five-hour wake-up would be refused again.
    skip(
        "You have hit your ChatGPT usage limit.",
        headers(429, {
            "x-codex-secondary-used-percent": "100",
            "x-codex-secondary-window-minutes": "10080",
            "x-codex-secondary-reset-after-seconds": "200000",
        }),
    );
    skip('{"error":{"type":"usage_not_included","message":"Upgrade to use Codex"}}');
    // A limit with no time: the owner's fixed delay.
    retry("You have hit your ChatGPT usage limit.");
});

test("Anthropic: rate limits and the subscription window resume; spend caps, credit, and 7 days do not", () => {
    // https://platform.claude.com/docs/en/api/errors
    const rate =
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}';

    assert.deepEqual(classify(rate, headers(429, { "retry-after": "40" }), now), {
        kind: "reset",
        at: now + 40_000 + RESET_GRACE_MS,
        from: "headers",
    });
    // https://platform.claude.com/docs/en/api/rate-limits (unified subscription headers)
    assert.deepEqual(
        classify(
            rate,
            headers(429, {
                "anthropic-ratelimit-unified-5h-status": "rejected",
                "anthropic-ratelimit-unified-5h-reset": String((now + 2 * 3_600_000) / 1000),
            }),
            now,
        ),
        { kind: "reset", at: now + 2 * 3_600_000 + RESET_GRACE_MS, from: "headers" },
    );
    skip(
        rate,
        headers(429, {
            "anthropic-ratelimit-unified-5h-status": "rejected",
            "anthropic-ratelimit-unified-7d-status": "rejected",
        }),
    );
    // https://platform.claude.com/docs/en/api/rate-limits
    skip(
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits: your organization has crossed its monthly API usage threshold. You will regain access on 2026-09-01 at 00:00 UTC.","details":{"error_code":"enforced_spend_limit_reached"}}}',
    );
    // https://github.com/anthropics/anthropic-sdk-typescript/issues/618
    skip(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
    );
    retry('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
});

test("Google Gemini and Vertex: RetryInfo's delay is the reset; a daily quota or prepay stays manual", () => {
    // https://github.com/googleapis/python-genai/issues/1875
    assert.deepEqual(
        classify(
            '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. Please retry in 53.016342224s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"53s"}]}}',
            undefined,
            now,
        ),
        resetIn(53_000),
    );
    // https://github.com/google/syzkaller/issues/6573
    skip(
        "429 You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_model_per_day, limit: 0",
    );
    // https://ai.google.dev/gemini-api/docs/api-errors
    skip('{"error":{"code":402,"message":"Prepay balance depleted","status":"payment_required"}}');
});

test("Mistral, Bedrock, and OpenAI-compatible providers", () => {
    // https://docs.mistral.ai/resources/error-glossary
    retry(
        'Mistral API error (429): {"object":"error","message":"Requests rate limit exceeded","type":"rate_limit_error"}',
    );
    skip('Mistral API error (402): {"object":"error","message":"Payment required"}');
    // https://repost.aws/knowledge-center/bedrock-throttling-error
    retry("ThrottlingException: Too many tokens, please wait before trying again.");
    // https://docs.aws.amazon.com/botocore/latest/reference/services/bedrock-runtime/client/exceptions/ServiceQuotaExceededException.html
    skip(
        "ServiceQuotaExceededException: Your request exceeds the service quota for your account. You can resubmit your request later.",
    );
    // https://openrouter.ai/docs/api_reference/limits
    assert.deepEqual(
        classify(
            '429 {"error":{"code":429,"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded"}}}',
            headers(429, { "retry-after": "120" }),
            now,
        ),
        { kind: "reset", at: now + 120_000 + RESET_GRACE_MS, from: "headers" },
    );
    skip(
        '403 {"error":{"code":403,"message":"Org member budget limit exceeded (weekly limit). Contact your org admin.","metadata":{"resets_at":"2026-10-12T00:00:00.000Z"}}}',
    );
    skip(
        '402 {"error":{"code":402,"message":"Insufficient credits. Add more using https://openrouter.ai/credits"}}',
    );
    // https://github.com/Aider-AI/aider/issues/3265
    assert.deepEqual(
        classify(
            '429 {"error":{"message":"Rate limit reached for model `gemma2-9b-it` on tokens per minute (TPM): Limit 15000, Used 11972, Requested 4351. Please try again in 5.289s.","type":"tokens","code":"rate_limit_exceeded"}}',
            undefined,
            now,
        ),
        resetIn(5289),
    );
    skip(
        '429 {"error":{"message":"Rate limit reached for model `llama` on tokens per day (TPD): Limit 500000. Please try again in 7m12s.","code":"rate_limit_exceeded"}}',
    );
    // https://github.com/continuedev/continue/issues/10373
    skip(
        "429 Your team has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.",
    );
    // https://api-docs.deepseek.com/quick_start/error_codes
    skip("402 Insufficient Balance");
    retry(
        '429 {"error":{"message":"Rate Limit Reached","type":"rate_limit_error","code":"rate_limit_reached"}}',
    );
    // https://github.com/charmbracelet/crush/issues/3024 (Fireworks)
    retry(
        '429 {"error":{"type":"invalid_request_error","message":"rate limit exceeded, please try again later"}}',
    );
});

test("Coding plans: OpenCode Go, Z.ai, Kimi, MiniMax, Qwen, and Xiaomi MiMo", () => {
    // https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/retry.ts
    assert.deepEqual(
        classify(
            "429 GoUsageLimitError: 5-hour usage limit reached. It will reset in 3 hours. To continue using this model now, enable usage from your available balance",
            undefined,
            now,
        ),
        resetIn(3 * 3_600_000),
    );
    skip("429 GoUsageLimitError: Weekly usage limit reached. It will reset in 4 days.");
    skip("429 FreeUsageLimitError: Free limit reached");
    // https://docs.z.ai/api-reference/api-code: a time without a zone could be hours off, so it does not count.
    retry(
        '429 {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-10-22 18:00:00"}}',
    );
    retry(
        '429 {"error":{"code":"1308","message":"Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2026-10-22 18:00:00."}}',
    );
    skip(
        '429 {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-27 00:00:00"}}',
    );
    skip(
        '429 {"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}',
    );
    // https://platform.kimi.ai/docs/api/errors
    retry(
        '429 {"error":{"type":"rate_limit_reached_error","message":"Organization-level RPM limit reached"}}',
    );
    skip(
        '429 {"error":{"type":"rate_limit_reached_error","message":"Organization-level TPD limit reached"}}',
    );
    skip(
        '429 {"error":{"type":"exceeded_current_quota_error","message":"Token quota is insufficient"}}',
    );
    // https://platform.minimax.io/docs/api-reference/errorcode
    retry('{"base_resp":{"status_code":2056,"status_msg":"usage limit exceeded"}}');
    skip('{"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}');
    // https://www.alibabacloud.com/help/en/model-studio/error-code
    retry(
        '429 {"code":"Throttling.RateQuota","message":"Requests rate limit exceeded, please try again later."}',
    );
    skip(
        '400 {"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}',
    );
    // https://mimo.mi.com/docs/en-US/api/guidance/error-codes
    retry("429 Too Many Requests");
    skip("402 Insufficient Balance");
});

test("errors with no cause retry after the fixed delay; requests that cannot work never do", () => {
    retry("fetch failed", false);
    retry("An unknown error occurred", false);
    retry("Provider returned an error stop reason", false);
    skip("401 Unauthorized");
    skip(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens"}}',
    );
    skip("Provider finish_reason: content_filter");
    skip('400 {"error":{"message":"Invalid request: unknown parameter"}}');
});

test("a reset time must be close and certain to count", () => {
    // Already past: try at once, after the grace.
    assert.deepEqual(classify('{"resets_at":1799999000}', undefined, now), {
        kind: "reset",
        at: now + RESET_GRACE_MS,
        from: "message",
    });
    assert.equal(
        classify("usage limit reached. Try again in 6 hours.", undefined, now).kind,
        "skip",
    );
    assert.ok(MAX_WAIT_MS > 5 * 3_600_000);
    assert.deepEqual(
        classify(
            "rate limit reached, resets at 2027-01-15T10:00:00Z",
            undefined,
            Date.parse("2027-01-15T09:00:00Z"),
        ),
        { kind: "reset", at: Date.parse("2027-01-15T10:00:00Z") + RESET_GRACE_MS, from: "message" },
    );
});

test("durations and delays", () => {
    assert.equal(durationMs("2h34m12s"), (2 * 3600 + 34 * 60 + 12) * 1000);
    assert.equal(durationMs("1 hour 5 minutes"), 65 * minute);
    assert.equal(durationMs("53.5s"), 53_500);
    assert.equal(durationMs("soon"), undefined);
    assert.equal(parseDelay("45m"), 45);
    assert.equal(parseDelay("1h"), 60);
    assert.equal(parseDelay("1 h 30 min"), 90);
    assert.equal(parseDelay("90"), 90);
    assert.equal(parseDelay("5m"), undefined);
    assert.equal(parseDelay("6h"), undefined);
});
