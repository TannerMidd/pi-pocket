/**
 * When a failed model request may succeed later, and when: the quota and rate-limit errors of the providers that come
 * with Pi. Providers share no error code, so this reads the response's own status and limit headers first, then the
 * error's words. Sources for each format are in `test/usage-limits.test.ts`.
 */
import type { ProviderLimit } from "../provider-limits.ts";

/** Friendly reset times are rounded, and clocks differ: wait a little longer than the provider says. */
export const RESET_GRACE_MS = 60_000;
/** The longest wait this follows: a subscription's five-hour window. Longer limits stay manual. */
export const MAX_WAIT_MS = 5 * 60 * 60_000 + RESET_GRACE_MS;

export type Verdict =
    /** Do not continue by itself: a person must act (billing, sign-in, a long window, a request that cannot work). */
    | { kind: "skip"; reason: string }
    /** The provider said when: continue then. */
    | { kind: "reset"; at: number; from: "headers" | "message" }
    /** A limit, or an error with no cause given: try again after the owner's fixed delay. */
    | { kind: "retry"; limit: boolean };

const LONG_WINDOW =
    /weekly|per[_ -]?week|monthly|per[_ -]?month|daily|per[_ -]?day|PerDay|PerMonth|\b[TR]PD\b/i;
/** A five-hour or session window, even when the words also mention a balance for extra usage. */
const SHORT_WINDOW = /\b5[- ]?hours?\b|five[- ]hour|session limit|usage_limit_reached/i;
const BILLING =
    /insufficient_quota|usage_not_included|billing_error|billing_not_active|payment[_ ]required|insufficient[_ ]?(?:balance|credit|funds)|credit[_ ]balance|used all available credits|spend(?:ing)?[_ ]limit|enforced_spend_limit_reached|exceeded_current_quota|quota is insufficient|out of budget|arrearage|good standing|recharge|FreeUsageLimitError|ServiceQuotaExceeded|(?<![\w.])402(?![\w.])/i;
const STATUS_429 = /(?<![\w.])429(?![\w.])/;
const LIMIT =
    /rate[_ -]?limit|too many requests|usage[_ ]limit|limit (?:reached|exceeded)|quota|resource[_ ]exhausted|exhausted your capacity|throttl|GoUsageLimitError|subscription_sharing_usage_limit_exceeded|hit your .*limit|slow_down|overloaded/i;
const NO_RETRY: [RegExp, string][] = [
    [
        /(?<![\w.])40[13](?![\w.])|unauthori[sz]ed|forbidden|invalid[_ ]?api[_ ]?key|authentication|permission[_ ]denied|not signed in|(?:sign-?in|token) (?:has )?expired/i,
        "a sign-in or permission error",
    ],
    [
        /context[_ ]?(?:length|window)|maximum context|too many tokens|prompt is too long|input is too long|request too large|(?<![\w.])413(?![\w.])/i,
        "the request is too large",
    ],
    [/content[_ ]?filter|refus|safety|sensitive/i, "the provider refused the content"],
    [
        /(?<![\w.])(?:400|404|422)(?![\w.])|invalid[_ ]request|bad request|not found|unsupported/i,
        "the provider rejected the request",
    ],
];

/** Each unit of a written duration, in milliseconds. Longest names first, so "min" is not read as "m". */
const UNITS: [RegExp, number][] = [
    [/^(?:hours?|hrs?|h)$/i, 3_600_000],
    [/^(?:minutes?|mins?|m)$/i, 60_000],
    [/^(?:seconds?|secs?|s)$/i, 1000],
    [/^ms$/i, 1],
];
const AMOUNT = /(\d+(?:\.\d+)?)\s*(ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;

/** "2h34m12s", "1 hour 5 minutes", "53.016s", "~93 min": in milliseconds, or undefined. */
export function durationMs(text: string): number | undefined {
    let total = 0;
    let found = false;

    for (const [, amount, unit] of text.matchAll(AMOUNT)) {
        const size = UNITS.find(([name]) => name.test(unit ?? ""))?.[1];

        if (size !== undefined) {
            total += Number(amount) * size;
            found = true;
        }
    }

    return found ? total : undefined;
}

/** Unix seconds or milliseconds. */
const epoch = (value: number) => (value >= 1e12 ? value : value * 1000);

/** A date and time with its zone: one without a zone could be hours off, so it does not count. */
function zoned(text: string): number | undefined {
    return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? Date.parse(text) : undefined;
}

/** A reset time in a `retry-after`-like header: seconds, an HTTP date, or Go's "1m30s". */
function headerTime(value: string | undefined, at: number): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (/^\d+(?:\.\d+)?$/.test(value)) {
        return at + Number(value) * 1000;
    }

    const duration = durationMs(value);

    return duration !== undefined && /^[\d.hms ]+$/i.test(value)
        ? at + duration
        : Date.parse(value) || undefined;
}

/** What the response's own limit headers say: a long window blocked, or when the binding limit resets. */
function fromHeaders(limit: ProviderLimit): { long: boolean; at?: number; limited: boolean } {
    const headers = limit.headers;
    const codexBlocked = ["primary", "secondary"].filter(
        (window) => Number(headers[`x-codex-${window}-used-percent`]) >= 100,
    );
    const anthropicBlocked = headers["anthropic-ratelimit-unified-5h-status"] === "rejected";
    const long =
        headers["anthropic-ratelimit-unified-7d-status"] === "rejected" ||
        codexBlocked.some((window) => Number(headers[`x-codex-${window}-window-minutes`]) > 300);
    const resets: (number | undefined)[] = [];

    for (const window of codexBlocked) {
        const absolute = headers[`x-codex-${window}-reset-at`];

        resets.push(
            absolute !== undefined
                ? epoch(Number(absolute))
                : headerTime(headers[`x-codex-${window}-reset-after-seconds`], limit.at),
        );
    }

    if (anthropicBlocked) {
        const value = headers["anthropic-ratelimit-unified-5h-reset"] ?? "";

        resets.push(/^\d+$/.test(value) ? epoch(Number(value)) : Date.parse(value));
    }

    if (limit.status === 429 && resets.length === 0) {
        const ms = headers["retry-after-ms"];

        resets.push(ms === undefined ? undefined : limit.at + Number(ms));
        resets.push(headerTime(headers["retry-after"], limit.at));

        for (const name of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
            resets.push(headerTime(headers[name], limit.at));
        }

        const reset = headers["x-ratelimit-reset"];

        if (reset !== undefined && /^\d+(?:\.\d+)?$/.test(reset)) {
            // Epoch seconds, or seconds from now.
            resets.push(
                Number(reset) > 1e9 ? epoch(Number(reset)) : limit.at + Number(reset) * 1000,
            );
        }
    }

    const times = resets.filter((at): at is number => at !== undefined && Number.isFinite(at));

    return {
        long,
        limited: limit.status === 429 || codexBlocked.length > 0 || anthropicBlocked,
        ...(times.length === 0 ? {} : { at: Math.max(...times) }),
    };
}

/** When the error's words say the limit resets, or undefined. */
export function fromMessage(error: string, now: number): number | undefined {
    const absolute = /["']?resets?_at["']?\s*[:=]\s*["']?(\d{9,13}(?:\.\d+)?)/i.exec(error);

    if (absolute !== null) {
        return epoch(Number(absolute[1]));
    }

    const seconds =
        /["']?(?:resets?_in_seconds|resets?_after_seconds|retry_after(?:_seconds)?)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i.exec(
            error,
        );

    if (seconds !== null) {
        return now + Number(seconds[1]) * 1000;
    }

    const delay = /["']?(?:retryDelay|quotaResetDelay)["']?\s*:\s*"([\d.]+m?s)"/i.exec(error);

    if (delay !== null) {
        return now + (durationMs(delay[1] ?? "") ?? 0);
    }

    const iso =
        /(?:resets?|retry|try again|regain access|available)\b[^\n]{0,40}?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s?(?:Z|UTC|[+-]\d{2}:?\d{2}))/i.exec(
            error,
        );

    if (iso !== null) {
        const at = zoned((iso[1] ?? "").replace(/\s?UTC$/i, "Z").replace(" ", "T"));

        if (at !== undefined && Number.isFinite(at)) {
            return at;
        }
    }

    const relative =
        /(?:try again|retry|resets?|available again|wait)\s+(?:in|after)\s*~?\s*((?:\d+(?:\.\d+)?\s*(?:ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i.exec(
            error,
        );
    const ms = relative === null ? undefined : durationMs(relative[1] ?? "");

    return ms === undefined ? undefined : now + ms;
}

/**
 * What to do about a failed model request: `error` is its message, `limit` its own response's status and limit
 * headers when the provider's API reports them (`host.responseLimits`).
 */
export function classify(error: string, limit: ProviderLimit | undefined, now: number): Verdict {
    const headers = limit === undefined ? undefined : fromHeaders(limit);

    if (headers?.long === true || LONG_WINDOW.test(error)) {
        return { kind: "skip", reason: "a daily, weekly, or monthly limit" };
    }

    const short = SHORT_WINDOW.test(error);

    if (!short && BILLING.test(error)) {
        return { kind: "skip", reason: "a billing or credit limit" };
    }

    const limited =
        short || headers?.limited === true || STATUS_429.test(error) || LIMIT.test(error);

    if (!limited) {
        const why = NO_RETRY.find(([words]) => words.test(error));

        if (why !== undefined) {
            return { kind: "skip", reason: why[1] };
        }
    }

    const said =
        headers?.at === undefined
            ? fromMessage(error, now)
            : Math.max(headers.at, fromMessage(error, now) ?? 0);

    if (said === undefined) {
        return { kind: "retry", limit: limited };
    }

    const at = Math.max(said, now) + RESET_GRACE_MS;

    if (at - now > MAX_WAIT_MS) {
        return { kind: "skip", reason: "a reset more than five hours away" };
    }

    return { kind: "reset", at, from: headers?.at === undefined ? "message" : "headers" };
}
