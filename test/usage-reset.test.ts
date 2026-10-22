import assert from "node:assert/strict";
import { test } from "node:test";
import { usageResetAt } from "../src/server/usage-reset.ts";

const now = 1_700_000_000_000;
const minute = 60_000;
const usage = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";

test("Codex's friendly reset guidance and token-sharing JSON give bounded reset times with grace", () => {
    assert.equal(usageResetAt(usage, "openai-codex", undefined, now), now + 43 * minute);
    assert.equal(
        usageResetAt(
            `{"error":{"code":"subscription_sharing_usage_limit_exceeded","resets_at":${(now + 9 * minute) / 1000}}}`,
            "openai",
            undefined,
            now,
        ),
        now + 10 * minute,
    );
    assert.equal(
        usageResetAt(
            "You have hit your ChatGPT usage limit. Try again in ~0 min.",
            "openai-codex",
            undefined,
            now,
        ),
        now + minute,
    );
});

test("an exhausted Codex five-hour window uses the exact fresh response headers", () => {
    const limit = {
        at: now - 1000,
        status: 429,
        headers: {
            "x-codex-primary-used-percent": "100",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-after-seconds": "600",
        },
    };

    assert.equal(
        usageResetAt("Usage refused", "openai-codex", limit, now),
        now - 1000 + 11 * minute,
    );
    assert.equal(
        usageResetAt(
            usage,
            "openai-codex",
            {
                ...limit,
                headers: {
                    ...limit.headers,
                    "x-codex-primary-reset-at": String((now + 20 * minute) / 1000),
                },
            },
            now,
        ),
        now + 21 * minute,
    );
    assert.equal(
        usageResetAt("Usage refused", "openai-codex", { ...limit, at: now - 61_000 }, now),
        undefined,
    );
    assert.equal(
        usageResetAt("Usage refused", "openai-codex", { ...limit, status: 200 }, now),
        undefined,
    );
});

test("Anthropic native five-hour rejection uses its unified reset but not a blocked weekly window", () => {
    const limit = {
        at: now,
        status: 429,
        headers: {
            "anthropic-ratelimit-unified-5h-status": "rejected",
            "anthropic-ratelimit-unified-5h-reset": String((now + 10 * minute) / 1000),
        },
    };

    assert.equal(usageResetAt("Rate limit exceeded", "anthropic", limit, now), now + 11 * minute);
    assert.equal(
        usageResetAt(
            "Rate limit exceeded",
            "anthropic",
            {
                ...limit,
                headers: {
                    ...limit.headers,
                    "anthropic-ratelimit-unified-5h-reset": new Date(
                        now + 10 * minute,
                    ).toISOString(),
                },
            },
            now,
        ),
        now + 11 * minute,
    );
    assert.equal(
        usageResetAt(
            "Rate limit exceeded",
            "anthropic",
            {
                ...limit,
                headers: { ...limit.headers, "anthropic-ratelimit-unified-7d-status": "rejected" },
            },
            now,
        ),
        undefined,
    );
});

test("unknown, ordinary throttling, billing, stale, and long-window resets never guess a five-hour wait", () => {
    for (const error of [
        "You have hit your ChatGPT usage limit.",
        "429 Too many requests. Try again in ~3 min.",
        "Network error",
        "usage_limit_reached: billing payment required. Try again in ~3 min.",
        "usage_not_included. Try again in ~3 min.",
        "You have hit your ChatGPT usage limit. Try again in ~10080 min.",
        `usage_limit_reached: {"resets_at":${(now - minute) / 1000}}`,
    ]) {
        assert.equal(usageResetAt(error, "openai-codex", undefined, now), undefined, error);
    }

    assert.equal(
        usageResetAt(
            usage,
            "openai-codex",
            {
                at: now,
                status: 429,
                headers: {
                    "x-codex-secondary-used-percent": "100",
                    "x-codex-secondary-window-minutes": "10080",
                    "x-codex-secondary-reset-at": String((now + minute) / 1000),
                },
            },
            now,
        ),
        undefined,
    );
});
