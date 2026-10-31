/**
 * Provider limits, read from a failed model request: is this a limit a run can wait out, and when does it clear?
 * `classify` takes what a failed request left (its error text, and the status and headers the request's `fetch` saw)
 * and gives one verdict. Nothing here waits, stores, or sends: `limit-gate.ts` does that.
 *
 * What each provider sends is listed in docs/design/rate-limit-wait.md. Only the error text is certain to reach this
 * code; headers come from the recording fetch (`recordResponses`) for the adapters that take one.
 */

/** The headers worth keeping from a response: limits and times, never a key or a token. */
const KEPT_HEADER =
    /^(retry-after(-ms)?|anthropic-ratelimit-.+|x-ratelimit-.+|x-codex-.+|x-should-retry)$/;

/** What a failed request's response said: its status, and only the headers that tell about limits, by lowercase name. */
export type ResponseFacts = { status: number; headers: Record<string, string> };

/** The facts of a response: its status and the limit headers. Anything else is dropped here. */
export function responseFacts(
    status: number,
    headers: { forEach(each: (value: string, name: string) => void): void },
): ResponseFacts {
    const kept: Record<string, string> = {};

    headers.forEach((value, name) => {
        const lower = name.toLowerCase();

        if (KEPT_HEADER.test(lower)) {
            kept[lower] = value.slice(0, 200);
        }
    });

    return { status, headers: kept };
}

export type Scope =
    /** The whole sign-in: one canary serves every model of the provider. */
    | "account"
    /** One model: another model of the provider may still answer. */
    | "model";

/** Where a reset time came from. */
export type Source = "header" | "body" | "text";

export type Classified =
    /** Not a limit, or one that waiting does not clear (a sign-in, billing, a bad request): the error goes on as it is. */
    | { type: "other"; why: string }
    /** A limit. `resetAt` (epoch ms) when its end is known; otherwise `backoff`: only trying again tells. */
    | {
          type: "limit";
          scope: Scope;
          resetAt?: number;
          source?: Source;
          backoff: boolean;
          /** An unknown-reset subscription limit uses the owner's full wait budget, not the overload budget. */
          subscription?: true;
          /** A window of days (Claude's 7-day, a Codex window over 300 minutes): not waited for, failed with its reset. */
          long?: true;
          reason: string;
      };

export type LimitInput = {
    provider: string;
    /** `AssistantMessage.errorMessage`. */
    message: string;
    facts?: ResponseFacts | undefined;
    now: number;
    /** The caller's own check for a context that does not fit (`isContextOverflow`): never a limit. */
    contextOverflow?: boolean;
};

const REASON_CHARS = 300;

/** A sign-in that failed or expired, or a request that is refused: a person must act. */
const SIGN_IN =
    /OAuth (?:refresh|auth derivation) failed|\b40[13]\b|unauthori[sz]ed|invalid[ _-]?(?:x-)?api[ _-]?key|authentication[ _-]?(?:error|failed)|permission[ _-]?denied|forbidden/i;

/**
 * Money: a balance, a budget, or a plan that must be topped up. Waiting does not fix it. Only words that ask for money:
 * "in good standing" alone says all is well, and "recharge" alone can be part of a model's name.
 */
const BILLING =
    /insufficient[ _-]?(?:quota|credits?|funds|balance)|out of budget|quota exceeded|credit[ _-]?balance|used all available credits|spend(?:ing)?[ _-]?limit|enforced_spend_limit_reached|exceeded_current_quota|quota is insufficient|arrearage|not in good standing|please recharge|recharge your account|FreeUsageLimitError|ServiceQuotaExceeded|usage_not_included|\b402\b|payment[ _-]?required|billing/i;

/** A request the provider refuses for what it says, not for load. */
const REFUSED =
    /\b400\b|\b404\b|invalid[ _-](?:request|argument)|not[ _-]found|content[ _-]filter|does not exist|unsupported/i;

/** Limits of an account's plan: the sign-in, not the model. An unknown reset uses bounded subscription retries. */
const USAGE =
    /GoUsageLimitError|Monthly usage limit reached|usage_limit_reached|subscription_sharing_usage_limit_exceeded|usage[ _-]limit|session limit|available balance/i;
const LONG_WINDOW =
    /weekly|per[_ -]?week|monthly|per[_ -]?month|daily|per[_ -]?day|PerDay|PerMonth|seven_day|7[- ]day|\b[TR]PD\b/i;
const SHORT_WINDOW = /\b5[- ]?hours?\b|five[- ]hour|session limit/i;

/** Words that say the provider is loaded or rate limiting, whatever else the text holds. */
const LOAD = /overloaded|rate[ _.-]?limit|too many requests|resource[ _-]?exhausted/i;

/** Load and rate: tried again, these clear soon. */
const TRANSIENT =
    /overloaded|server[ _-]busy|servers are currently busy|high demand|at capacity|rate[ _.-]?limit|too many requests|\b(?:429|500|502|503|504|520|524|529)\b|service[ _-]?(?:is[ _-])?(?:temporarily[ _-])?unavailable|server[ _-]?error|internal[ _-]?error|retry delay|resource[ _-]?exhausted|throttl|slow_down|exhausted your capacity/i;

const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504, 520, 524, 529]);

/**
 * The usage limits that providers send as a 429, or as a 403 with a reset time: only these shapes (not any "usage
 * limit" in a text) let a 403 wait.
 */
const USAGE_SHAPE =
    /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage_limit_reached|subscription_sharing_usage_limit_exceeded|subscription sharing usage limit/i;

/**
 * Whether a response's status can be a failure that clears with time: a timeout, a rate limit, a server that failed
 * (not one that does not implement the request), or a conflict (only with a reset time in a header: see `classify`).
 * Any other status is a refusal that waiting does not change.
 */
function statusWaits(status: number): boolean {
    return (
        status === 408 ||
        status === 409 ||
        status === 429 ||
        (status >= 500 && status < 600 && status !== 501 && status !== 505)
    );
}

const UNITS: Record<string, number> = {
    ms: 1,
    millisecond: 1,
    milliseconds: 1,
    s: 1000,
    sec: 1000,
    secs: 1000,
    second: 1000,
    seconds: 1000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    hrs: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
};

/** A duration as a provider writes it, in milliseconds: `34s`, `6m0s`, `1h2m3.5s`, `20ms`, `~5 min`. */
export function durationMs(text: string): number | undefined {
    let total = 0;
    let found = false;

    for (const part of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|[a-z]+)/gi)) {
        const unit = UNITS[part[2]!.toLowerCase()];

        if (unit === undefined) {
            return undefined;
        }

        total += Number(part[1]) * unit;
        found = true;
    }

    return found ? Math.round(total) : undefined;
}

/** A moment as a number of seconds (or milliseconds, from 1e11 on) since 1970, in milliseconds. */
function epochMs(value: number): number {
    return value < 1e11 ? value * 1000 : value;
}

/** A moment from a header or a body: epoch seconds or milliseconds, or a date. */
function moment(value: string | number | undefined): number | undefined {
    if (value === undefined || value === "") {
        return undefined;
    }

    const number = typeof value === "number" ? value : Number(value);

    if (Number.isFinite(number)) {
        return epochMs(number);
    }

    if (!/(?:Z|[+-]\d{2}:?\d{2}|\bUTC|\bGMT)$/i.test(String(value))) {
        return undefined;
    }

    const parsed = Date.parse(String(value));

    return Number.isNaN(parsed) ? undefined : parsed;
}

/** `Retry-After`: seconds, or a date. */
function retryAfter(headers: Record<string, string>, now: number): number | undefined {
    const ms = headers["retry-after-ms"];

    if (ms !== undefined && Number.isFinite(Number(ms))) {
        return now + Number(ms);
    }

    const value = headers["retry-after"];

    if (value === undefined || value === "") {
        return undefined;
    }

    const seconds = Number(value);

    if (Number.isFinite(seconds)) {
        return now + seconds * 1000;
    }

    const date = Date.parse(value);

    return Number.isNaN(date) ? undefined : date;
}

/** The reset a response's headers tell, if any, and the scope it speaks for. */
function fromHeaders(
    headers: Record<string, string>,
    now: number,
): { resetAt?: number; account: boolean; model: boolean; long?: true } {
    // Claude subscription: windows that cover the sign-in. A claim for one model's cap (seven_day_opus) is the model's.
    const unified = headers["anthropic-ratelimit-unified-status"];
    const claim = headers["anthropic-ratelimit-unified-representative-claim"] ?? "";

    // The windows by name: a rejected 5-hour window waits for its reset; a rejected 7-day window is days away.
    const week = headers["anthropic-ratelimit-unified-7d-status"] === "rejected";
    const hours5 = headers["anthropic-ratelimit-unified-5h-status"] === "rejected";

    if (week || hours5) {
        const named = headers[`anthropic-ratelimit-unified-${week ? "7d" : "5h"}-reset`];
        const reset =
            moment(named) ??
            moment(headers["anthropic-ratelimit-unified-reset"]) ??
            retryAfter(headers, now);

        return {
            ...(reset === undefined ? {} : { resetAt: reset }),
            account: !/opus|sonnet|haiku/i.test(claim),
            model: /opus|sonnet|haiku/i.test(claim),
            ...(week ? { long: true as const } : {}),
        };
    }

    if (unified !== undefined || headers["anthropic-ratelimit-unified-reset"] !== undefined) {
        const rejected = unified === undefined || unified === "rejected";
        const reset =
            moment(headers["anthropic-ratelimit-unified-reset"]) ?? retryAfter(headers, now);

        if (rejected) {
            return {
                ...(reset === undefined ? {} : { resetAt: reset }),
                account: !/opus|sonnet|haiku/i.test(claim),
                model: /opus|sonnet|haiku/i.test(claim),
            };
        }
    }

    // ChatGPT sign-in (Codex): a window is full at 100 percent; the later of two full windows decides, and a full
    // window of more than 300 minutes is a weekly limit.
    const codex: number[] = [];
    let full = false;
    let long = false;

    for (const window of ["primary", "secondary"]) {
        const used = Number(headers[`x-codex-${window}-used-percent`]);
        const at = moment(headers[`x-codex-${window}-reset-at`]);
        const after = Number(headers[`x-codex-${window}-reset-after-seconds`]);

        if (used >= 100) {
            full = true;
            long ||= Number(headers[`x-codex-${window}-window-minutes`]) > 300;

            if (at !== undefined) {
                codex.push(at);
            } else if (Number.isFinite(after)) {
                codex.push(now + after * 1000);
            }
        }
    }

    if (full) {
        const reset = codex.length > 0 ? Math.max(...codex) : retryAfter(headers, now);

        return {
            ...(reset === undefined ? {} : { resetAt: reset }),
            account: true,
            model: false,
            ...(long ? { long: true as const } : {}),
        };
    }

    const wait = retryAfter(headers, now);

    // `x-ratelimit-reset-*` (OpenAI: durations) and `anthropic-ratelimit-*-reset` (dates): the exhausted ones decide, or
    // the soonest when none says: trying early costs a rejected request.
    const resets: { at: number; empty: boolean }[] = [];

    for (const [name, value] of Object.entries(headers)) {
        const open = /^x-ratelimit-reset-(.+)$/.exec(name);
        const dated = /^anthropic-ratelimit-(?!unified)(.+)-reset$/.exec(name);
        const what = open?.[1] ?? dated?.[1];

        if (what === undefined) {
            continue;
        }

        const at = open !== null ? (durationMs(value) ?? NaN) + now : moment(value);
        const remaining =
            headers[`x-ratelimit-remaining-${what}`] ??
            headers[`anthropic-ratelimit-${what}-remaining`];

        if (at !== undefined && Number.isFinite(at)) {
            resets.push({ at, empty: remaining !== undefined && Number(remaining) <= 0 });
        }
    }

    const empty = resets.filter((each) => each.empty).map((each) => each.at);
    const fromLimits =
        empty.length > 0
            ? Math.max(...empty)
            : resets.length > 0
              ? Math.min(...resets.map((each) => each.at))
              : undefined;
    const chosen = wait ?? fromLimits;

    return { ...(chosen === undefined ? {} : { resetAt: chosen }), account: false, model: false };
}

/** The reset an error's text tells: `Try again in ~5 min`, `retryDelay: "34s"`, a body's `resets_at`. */
function fromText(message: string, now: number): number | undefined {
    const body = /"?resets_in_seconds"?\s*[:=]\s*(\d+(?:\.\d+)?)/i.exec(message);

    if (body !== null) {
        return now + Number(body[1]) * 1000;
    }

    const at = /"?resets_at"?\s*[:=]\s*("[^"]+"|\d+)/i.exec(message);

    if (at !== null) {
        const time = moment(at[1]!.replaceAll('"', ""));

        if (time !== undefined) {
            return time;
        }
    }

    const again =
        /(?:retry[ _]?delay|quotaResetDelay)"?\s*[:=]?\s*"?((?:\d+(?:\.\d+)?\s*[a-z]+\s*)+)/i.exec(
            message,
        ) ??
        /(?:try|retry)(?:ing)?(?: your request)?(?: again)? (?:in|after)\s*~?\s*((?:\d+(?:\.\d+)?\s*[a-z]+\s*)+)/i.exec(
            message,
        ) ??
        /resets? (?:in|after)\s*~?\s*((?:\d+(?:\.\d+)?\s*[a-z]+\s*)+)/i.exec(message) ??
        /requested (\d+(?:\.\d+)?\s*s) retry delay/i.exec(message);

    if (again !== null) {
        const delay = durationMs(again[1]!);

        if (delay !== undefined) {
            return now + delay;
        }
    }

    const dated =
        /resets? (?:at|on)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(
            message,
        );

    return dated === null ? undefined : moment(dated[1]);
}

function cut(message: string): string {
    const line = message.replace(/\s+/g, " ").trim();

    return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS - 1)}…` : line;
}

/**
 * Whether a failed request hit a limit that clears with time, and when. A limit with a known end gives `resetAt`;
 * one without, that only load explains (a 429, an overload), is `backoff`. A plan's usage limit with no known end is
 * not waited for (there is nothing to wait until). Everything that a person must fix, or that is no limit, is `other`:
 * the error goes on to Pi Durable as it is.
 */
export function classify(input: LimitInput): Classified {
    const { message, facts, now } = input;
    // A successful HTTP stream can still end with a provider error event: its text decides, not HTTP 200.
    const status =
        facts?.status !== undefined && facts.status >= 200 && facts.status < 300
            ? undefined
            : facts?.status;

    if (input.contextOverflow === true) {
        return { type: "other", why: "context overflow" };
    }

    // A known status decides first, whatever the text says: a 400 that names a "rate_limit" parameter is a bad request.
    // The one other status that may wait is a 403 in a usage limit's own shape (the reset time is checked below).
    const usageShape = USAGE_SHAPE.test(message);

    if (status !== undefined && !statusWaits(status) && !(status === 403 && usageShape)) {
        return { type: "other", why: `HTTP ${status}` };
    }

    if ((SIGN_IN.test(message) && !(status === 403 && usageShape)) || status === 401) {
        return { type: "other", why: "sign-in or permission" };
    }

    // Google's quota errors include generic billing-help prose; Z.ai names the price of EXTRA usage, not the plan.
    let billingMessage = message.replace(/please check your plan and billing details\.?/gi, "");

    if (SHORT_WINDOW.test(message)) {
        billingMessage = billingMessage.replace(/insufficient balance for extra usage\.?/gi, "");
    }

    if (BILLING.test(billingMessage) || status === 402) {
        return { type: "other", why: "billing" };
    }

    // ChatGPT Business caps require the workspace admin, even if a 429 also carries a retry time.
    if (/subscription_sharing_workplace_individual_usage_limit_exceeded/i.test(message)) {
        return { type: "other", why: "workspace usage limit" };
    }

    // With no status (Google, Vertex, Bedrock), a refusal in the text is one, unless the text also names a rate limit
    // or an overload: "contents exceed 500 tokens" holds a number that looks like a 5xx.
    if (status === undefined && REFUSED.test(message) && !LOAD.test(message)) {
        return { type: "other", why: "refused" };
    }

    const headers = facts?.headers ?? {};
    const fromHeader = fromHeaders(headers, now);

    // A conflict is a refusal of this request, not of load: it waits only when the response itself says when to try
    // again (a header). Pi Durable's own short retries still cover a conflict that clears at once.
    if (status === 409 && fromHeader.resetAt === undefined) {
        return { type: "other", why: "HTTP 409" };
    }

    const usage = USAGE.test(message) || fromHeader.account || fromHeader.model;
    const transient =
        (status !== undefined && TRANSIENT_STATUS.has(status)) ||
        // A conflict that says when to try again (checked above) is a wait.
        status === 409 ||
        TRANSIENT.test(message);

    if (!usage && !transient) {
        return {
            type: "other",
            why:
                REFUSED.test(message) || (status !== undefined && status < 500)
                    ? "refused"
                    : "not a limit",
        };
    }

    // A time the response gave wins over one in the text. One already past tells only that it is soon.
    const source: Source | undefined = fromHeader.resetAt !== undefined ? "header" : undefined;
    const text = source === undefined ? fromText(message, now) : undefined;
    const found = fromHeader.resetAt ?? text;
    const scope: Scope = usage && !fromHeader.model ? "account" : "model";
    const reason = cut(message);
    const long = fromHeader.long || LONG_WINDOW.test(message);

    if (found !== undefined) {
        return {
            type: "limit",
            scope,
            resetAt: Math.max(found, now),
            source: source ?? (/"?resets_(?:at|in_seconds)"?/i.test(message) ? "body" : "text"),
            backoff: false,
            ...(long ? { long: true as const } : {}),
            reason,
        };
    }

    if (long) {
        return { type: "other", why: "usage limit of days" };
    }

    if (usage) {
        return { type: "limit", scope, backoff: true, subscription: true, reason };
    }

    return { type: "limit", scope, backoff: true, reason };
}
