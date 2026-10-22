/** Recognize subscription usage exhaustion and a provider-supplied reset, never a guessed five-hour wait. */
import type { ProviderLimit } from "./provider-limits.ts";

const FIVE_HOURS_MS = 5 * 60 * 60_000;
const RESET_GRACE_MS = 60_000;
const USAGE_LIMIT =
    /you have hit your (?:chatgpt )?usage limit|usage_limit_reached|subscription_sharing_usage_limit_exceeded|(?:5[- ]?hour|session) (?:usage )?limit/i;
const BILLING_LIMIT = /insufficient_quota|usage_not_included|billing|payment|out of budget/i;

function future(value: number, now: number): number | undefined {
    if (!Number.isFinite(value) || value < now || value - now > FIVE_HOURS_MS + RESET_GRACE_MS) {
        return undefined;
    }

    return value + RESET_GRACE_MS;
}

/** A native Codex/ChatGPT or Anthropic five-hour usage reset; ordinary 429s and unknown times stay manual. */
export function usageResetAt(
    error: string,
    provider: string,
    limit: ProviderLimit | undefined,
    now: number,
): number | undefined {
    if (BILLING_LIMIT.test(error)) {
        return undefined;
    }

    const headers =
        limit?.status === 429 && limit.at <= now && now - limit.at < 60_000 ? limit.headers : {};
    const anthropicBlocked = headers["anthropic-ratelimit-unified-5h-status"] === "rejected";
    const codexBlocked = ["primary", "secondary"].filter(
        (window) => Number(headers[`x-codex-${window}-used-percent`]) >= 100,
    );

    if (!USAGE_LIMIT.test(error) && !anthropicBlocked && codexBlocked.length === 0) {
        return undefined;
    }

    // An exhausted longer window means a five-hour wake-up would still be refused.
    if (
        codexBlocked.some((window) => Number(headers[`x-codex-${window}-window-minutes`]) > 300) ||
        headers["anthropic-ratelimit-unified-7d-status"] === "rejected"
    ) {
        return undefined;
    }

    const resets: number[] = [];

    if (provider === "openai-codex") {
        for (const window of codexBlocked) {
            if (Number(headers[`x-codex-${window}-window-minutes`]) !== 300) {
                continue;
            }

            const absolute = headers[`x-codex-${window}-reset-at`];
            const relative = headers[`x-codex-${window}-reset-after-seconds`];
            const at =
                absolute !== undefined
                    ? Number(absolute) * 1000
                    : relative !== undefined
                      ? limit!.at + Number(relative) * 1000
                      : NaN;

            if (Number.isFinite(at)) {
                resets.push(at);
            }
        }
    }

    if (provider === "anthropic" && anthropicBlocked) {
        const value = headers["anthropic-ratelimit-unified-5h-reset"];
        const numeric = value === undefined ? NaN : Number(value);
        const at = Number.isFinite(numeric)
            ? numeric * 1000
            : value === undefined
              ? NaN
              : Date.parse(value);

        if (Number.isFinite(at)) {
            resets.push(at);
        }
    }

    if (resets.length > 0) {
        return future(Math.max(...resets), now);
    }

    // Codex formats the JSON error's resets_at as "Try again in ~N min.". Token sharing may retain the JSON.
    if (USAGE_LIMIT.test(error)) {
        const epoch = /["']?resets_at["']?\s*:\s*(\d+(?:\.\d+)?)/i.exec(error);

        if (epoch !== null) {
            return future(Number(epoch[1]) * 1000, now);
        }

        const minutes = /try again in\s*~?\s*(\d+(?:\.\d+)?)\s*min(?:utes?)?\b/i.exec(error);

        if (minutes !== null) {
            return future(now + Number(minutes[1]) * 60_000, now);
        }
    }

    return undefined;
}
