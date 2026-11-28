/**
 * Provider usage: how much of each provider's limits is left, as its last response said, or as fetched on demand for
 * subscription providers when the owner opens the Usage panel. Response limit headers (`limits.ts` keeps only those)
 * are read into windows (a 5-hour window, requests per minute), and the newest of each provider is kept in memory,
 * with the time of the response. On-demand refreshes query read-only subscription usage endpoints with a per-provider
 * cooldown and single-flight deduplication so repeated clicks never spam upstream.
 *
 * Only the owner sees it (`PocketApp.usageFor`): the same people who may open the Providers sheet.
 */
import { responseFacts } from "./limits.ts";

/** A window is low under this many percent left. */
export const LOW_AT = 15;

/** Minimum interval between on-demand live usage fetches per provider. */
export const USAGE_REFRESH_COOLDOWN_MS = 60_000;

/** Upper bound for an upstream Retry-After cooldown on an on-demand usage check. */
const USAGE_REFRESH_MAX_RETRY_MS = 10 * 60_000;

/** Timeout for an upstream on-demand usage check. */
const USAGE_REFRESH_TIMEOUT_MS = 10_000;

/** Maximum bytes read from an upstream usage JSON body. */
const MAX_USAGE_BODY_BYTES = 64 * 1024;

/** Subscription providers with read-only usage endpoints that can be checked on demand. */
const REFRESHABLE_SUBSCRIPTIONS = new Set(["anthropic", "openai-codex", "openai"]);

/** Anthropic OAuth usage endpoint and client headers matching pi-ai's OAuth transport. */
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const ANTHROPIC_USER_AGENT = "claude-cli/2.1.322";

/** ChatGPT/Codex OAuth usage endpoint and JWT claim path matching pi-ai's Codex transport. */
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_JWT_CLAIM = "https://api.openai.com/auth";

/** Whether a provider's subscription usage can be fetched on demand without making a model call. */
export function canRefreshUsage(providerId: string, kind: UsageProvider["kind"]): boolean {
    return kind === "subscription" && REFRESHABLE_SUBSCRIPTIONS.has(providerId);
}

export type WindowState = "ok" | "low" | "limited";

export type UsageWindow = {
    /** Stable inside one provider: `5h`, `7d`, `requests`, `tokens`. */
    id: string;
    /** The short name the status line uses: `5h`, `7d`. Empty when the window's length is not known. */
    tag: string;
    /** `5-hour window`, `Weekly window`, `Requests per minute`. */
    label: string;
    /** Percent left, 0 to 100, rounded. Absent when the provider said only that the window is open. */
    left?: number;
    /** Less than one percent is left, but not none: `left` is 0 and the window is not limited. Shown as `<1%`. */
    tiny?: true;
    /** `1,260 of 2,000 left`, for windows that count. */
    detail?: string;
    /** When the window resets, as epoch milliseconds on the server's clock. */
    resetAt?: number;
    /** Model family substring when a window applies only to one model tier (e.g. `"sonnet"`, `"opus"`). */
    model?: string;
    state: WindowState;
};

/** The headers `limits.ts` keeps (lower case), and the status of the response. */
export type UsageFacts = { status: number; headers: Record<string, string> };

const LIMITED_STATUS = /^(rejected|limited|exhausted|blocked|denied)$/i;

/** A time as epoch milliseconds: epoch seconds or milliseconds, or an RFC 3339 date. Undefined when it is neither. */
function timeOf(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const text = value.trim();

    if (/^\d+(\.\d+)?$/.test(text)) {
        const number = Number(text);

        // Seconds until about the year 33658; milliseconds are far above that.
        return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
    }

    const parsed = Date.parse(text);

    return Number.isNaN(parsed) ? undefined : parsed;
}

/** A duration such as `6m0s`, `1.5s`, `20ms`, or plain seconds, in milliseconds. */
function durationOf(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const text = value.trim();

    if (/^\d+(\.\d+)?$/.test(text)) {
        return Math.round(Number(text) * 1000);
    }

    const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)];

    if (parts.length === 0 || parts.map((part) => part[0]).join("") !== text) {
        return undefined;
    }

    const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

    return Math.round(
        parts.reduce((sum, part) => sum + Number(part[1]) * unit[part[2] as keyof typeof unit], 0),
    );
}

function numberOf(value: string | undefined): number | undefined {
    if (value === undefined || value.trim() === "") {
        return undefined;
    }

    const number = Number(value);

    return Number.isFinite(number) && number >= 0 ? number : undefined;
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const count = (value: number): string => {
    if (value >= 1_000_000) {
        return `${Number((value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1))}M`;
    }

    if (value >= 100_000) {
        return `${Math.round(value / 1000)}k`;
    }

    return Math.round(value).toLocaleString("en-US");
};

/** The window's name from its length in minutes: `{ tag: "5h", label: "5-hour window" }`. */
export function windowName(minutes: number): { tag: string; label: string } {
    if (minutes >= 10_080 && minutes % 10_080 === 0) {
        const weeks = minutes / 10_080;

        return weeks === 1
            ? { tag: "7d", label: "Weekly window" }
            : { tag: `${weeks * 7}d`, label: `${weeks}-week window` };
    }

    if (minutes >= 1440 && minutes % 1440 === 0) {
        const days = minutes / 1440;

        return days === 1
            ? { tag: "1d", label: "Daily window" }
            : { tag: `${days}d`, label: `${days}-day window` };
    }

    if (minutes >= 60 && minutes % 60 === 0) {
        return { tag: `${minutes / 60}h`, label: `${minutes / 60}-hour window` };
    }

    return { tag: `${minutes}m`, label: `${minutes}-minute window` };
}

/**
 * What a window shows from the raw percent left (before rounding): a window is limited only when it is exhausted (`exhausted`,
 * decided by the caller from the raw numbers), never because the rounded percent is 0. Less than one percent left is `tiny`.
 */
function measure(
    raw: number | undefined,
    exhausted: boolean,
): { left?: number; tiny?: true; state: WindowState } {
    const left = raw === undefined ? undefined : clampPercent(raw);
    const tiny = !exhausted && left === 0 ? ({ tiny: true } as const) : {};
    const state: WindowState = exhausted
        ? "limited"
        : left !== undefined && left < LOW_AT
          ? "low"
          : "ok";

    return { ...(left === undefined ? {} : { left }), ...tiny, state };
}

/** Anthropic's subscription: `anthropic-ratelimit-unified-5h-utilization`, `-status`, `-reset`, and the same for `7d`. */
function unifiedWindows(headers: Record<string, string>): UsageWindow[] {
    const ids = new Set<string>();

    for (const name of Object.keys(headers)) {
        const match =
            /^anthropic-ratelimit-unified-(\d+[hd][a-z0-9_]*)-(utilization|remaining|status|reset)$/.exec(
                name,
            );

        if (match?.[1] !== undefined) {
            ids.add(match[1]);
        }
    }

    const windows: UsageWindow[] = [];

    for (const id of [...ids].sort()) {
        const get = (part: string) => headers[`anthropic-ratelimit-unified-${id}-${part}`];
        const utilization = numberOf(get("utilization"));
        const remaining = numberOf(get("remaining"));
        // A fraction, as Claude Code reads it: 0.59 is 59 percent used.
        const raw =
            utilization !== undefined
                ? (1 - Math.min(1, utilization)) * 100
                : remaining !== undefined
                  ? Math.min(1, remaining) * 100
                  : undefined;
        const blocked = LIMITED_STATUS.test(get("status") ?? "");
        const exhausted =
            blocked || (utilization !== undefined && utilization >= 1) || remaining === 0;

        if (raw === undefined && !blocked) {
            continue;
        }

        const resetAt = timeOf(get("reset"));
        const length = /^(\d+)([hd])/.exec(id);
        const minutes =
            length === null ? undefined : Number(length[1]) * (length[2] === "d" ? 1440 : 60);
        const name = minutes === undefined ? { tag: id, label: id } : windowName(minutes);

        windows.push({
            id,
            tag: name.tag,
            label: name.label,
            ...(raw === undefined ? { left: 0 } : {}),
            ...measure(raw, exhausted),
            ...(resetAt === undefined ? {} : { resetAt }),
        });
    }

    return windows;
}

/** ChatGPT's sign-in: `x-codex-primary-used-percent`, `-window-minutes`, `-reset-at`, `-reset-after-seconds`, and `secondary`. */
function codexWindows(headers: Record<string, string>, at: number): UsageWindow[] {
    const windows: UsageWindow[] = [];

    for (const which of ["primary", "secondary"] as const) {
        const used = numberOf(headers[`x-codex-${which}-used-percent`]);

        if (used === undefined) {
            continue;
        }

        const raw = 100 - Math.min(100, used);
        const minutes = numberOf(headers[`x-codex-${which}-window-minutes`]);
        const after = numberOf(headers[`x-codex-${which}-reset-after-seconds`]);
        const resetAt =
            timeOf(headers[`x-codex-${which}-reset-at`]) ??
            (after === undefined ? undefined : at + Math.round(after * 1000));
        const name =
            minutes !== undefined && minutes > 0
                ? windowName(Math.round(minutes))
                : { tag: "", label: which === "primary" ? "Primary window" : "Secondary window" };

        windows.push({
            id: which,
            tag: name.tag,
            label: name.label,
            ...measure(raw, used >= 100),
            ...(resetAt === undefined ? {} : { resetAt }),
        });
    }

    return windows;
}

/** What a counted limit is called. */
const COUNTED = [
    { part: "requests", name: "Requests", id: "requests", tag: "req" },
    { part: "tokens", name: "Tokens", id: "tokens", tag: "tok" },
    { part: "input-tokens", name: "Input tokens", id: "input-tokens", tag: "in" },
    { part: "output-tokens", name: "Output tokens", id: "output-tokens", tag: "out" },
] as const;

/**
 * Counted limits: `x-ratelimit-limit-requests`, `-remaining-requests`, `-reset-requests` (a duration), the same for
 * tokens, and Anthropic's API `anthropic-ratelimit-requests-limit`, `-remaining`, `-reset` (a date). A counted window
 * is a minute long when the provider says it resets within two minutes, and Anthropic's always are.
 */
function countedWindows(headers: Record<string, string>, at: number): UsageWindow[] {
    const windows: UsageWindow[] = [];

    for (const each of COUNTED) {
        for (const family of ["anthropic", "openai"] as const) {
            const limit = numberOf(
                headers[
                    family === "anthropic"
                        ? `anthropic-ratelimit-${each.part}-limit`
                        : `x-ratelimit-limit-${each.part}`
                ],
            );
            const remaining = numberOf(
                headers[
                    family === "anthropic"
                        ? `anthropic-ratelimit-${each.part}-remaining`
                        : `x-ratelimit-remaining-${each.part}`
                ],
            );
            const reset =
                headers[
                    family === "anthropic"
                        ? `anthropic-ratelimit-${each.part}-reset`
                        : `x-ratelimit-reset-${each.part}`
                ];

            if (remaining === undefined || (limit === undefined && remaining > 0)) {
                continue;
            }

            const resetAt =
                family === "anthropic"
                    ? timeOf(reset)
                    : (() => {
                          const after = durationOf(reset);

                          return after === undefined ? timeOf(reset) : at + after;
                      })();
            const raw =
                limit !== undefined && limit > 0 ? (Math.min(remaining, limit) / limit) * 100 : 0;
            const minute =
                family === "anthropic" || (resetAt !== undefined && resetAt - at <= 120_000);

            // One family only: Anthropic's API sends both its own and none of the other's.
            if (windows.some((window) => window.id === each.id)) {
                continue;
            }

            windows.push({
                id: each.id,
                tag: each.tag,
                label: minute ? `${each.name} per minute` : each.name,
                ...measure(raw, remaining <= 0),
                ...(limit === undefined || limit <= 0
                    ? {}
                    : { detail: `${count(remaining)} of ${count(limit)} left` }),
                ...(resetAt === undefined ? {} : { resetAt }),
            });
        }
    }

    return windows;
}

/** One limit of a provider that sends `x-ratelimit-limit`, `-remaining`, `-reset` with no kind (OpenRouter). */
function plainWindow(headers: Record<string, string>, at: number): UsageWindow[] {
    const limit = numberOf(headers["x-ratelimit-limit"]);
    const remaining = numberOf(headers["x-ratelimit-remaining"]);

    if (limit === undefined || limit <= 0 || remaining === undefined) {
        return [];
    }

    const reset = headers["x-ratelimit-reset"];
    const after = /^\d{9,}/.test(reset ?? "") ? undefined : durationOf(reset);
    const resetAt = after === undefined ? timeOf(reset) : at + after;
    const raw = (Math.min(remaining, limit) / limit) * 100;

    return [
        {
            id: "requests",
            tag: "req",
            label: "Requests",
            ...measure(raw, remaining <= 0),
            detail: `${count(remaining)} of ${count(limit)} left`,
            ...(resetAt === undefined ? {} : { resetAt }),
        },
    ];
}

/** Read a response's limit headers into windows. Empty when the response says nothing about usage. */
export function parseUsage(facts: UsageFacts, at: number): UsageWindow[] {
    const headers = facts.headers;
    const windows = [
        ...unifiedWindows(headers),
        ...codexWindows(headers, at),
        ...countedWindows(headers, at),
        ...plainWindow(headers, at),
    ];

    // A refusal with a wait and nothing else to say: the provider has no more for now.
    if (
        (facts.status === 429 || facts.status === 529) &&
        !windows.some((window) => window.state === "limited")
    ) {
        const millis = numberOf(headers["retry-after-ms"]);
        const seconds = numberOf(headers["retry-after"]);
        const ms = millis ?? (seconds === undefined ? undefined : seconds * 1000);

        if (ms !== undefined && ms > 0) {
            windows.push({
                id: "retry",
                tag: "",
                label: "Rate limit",
                left: 0,
                resetAt: at + Math.round(ms),
                state: "limited",
            });
        }
    }

    return windows;
}

type Entry = {
    windows: UsageWindow[];
    /** When the response that gave these came. */
    at: number;
    /** A response came and said nothing about usage. */
    silent: boolean;
};

export type UsageProvider = {
    id: string;
    name: string;
    /** A sign-in with a plan, or a key. */
    kind: "subscription" | "key";
    /** `reported`: windows from a response. `no-data`: no response since the server started. `not-reported`: responses with no usage headers. */
    status: "reported" | "no-data" | "not-reported";
    /** When the response that the windows come from came. */
    asOf?: number;
    windows: UsageWindow[];
    /** True when the owner can check live subscription usage on demand without a model call. */
    refreshable?: true;
    /** The limit gate holds the whole account's requests: when it tries next, and why in fixed words. */
    held?: UsageHold;
    /** The limit gate holds single models only (another model of the provider may still answer). */
    modelHolds?: (UsageHold & { modelId: string })[];
};

export type UsageHold = { until: number; reason: string };

export type UsageSnapshot = { at: number; providers: UsageProvider[] };

export type UsageRefreshResult = UsageSnapshot & {
    refreshed: string[];
    cooldownMs: number;
    failed: string[];
};

export type UsageDeps = {
    now?: () => number;
    /** Something changed: tell the owner's tabs (throttled by the caller). */
    changed: () => void;
};

/** Parse Anthropic's `GET /api/oauth/usage` JSON body into usage windows (`utilization` is 0–100%). */
export function parseAnthropicUsage(body: unknown): UsageWindow[] {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return [];
    }

    const record = body as Record<string, unknown>;
    const specs: readonly {
        key: string;
        id: string;
        tag: string;
        label: string;
        model?: string;
    }[] = [
        { key: "five_hour", id: "5h", tag: "5h", label: "5-hour window" },
        { key: "seven_day", id: "7d", tag: "7d", label: "Weekly window" },
        {
            key: "seven_day_sonnet",
            id: "7d_sonnet",
            tag: "7d",
            label: "Weekly window (Sonnet)",
            model: "sonnet",
        },
        {
            key: "seven_day_opus",
            id: "7d_opus",
            tag: "7d",
            label: "Weekly window (Opus)",
            model: "opus",
        },
    ];
    const windows: UsageWindow[] = [];

    for (const spec of specs) {
        const entry = record[spec.key];

        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            continue;
        }

        const rawUtil = (entry as Record<string, unknown>).utilization;

        if (typeof rawUtil !== "number" || !Number.isFinite(rawUtil) || rawUtil < 0) {
            continue;
        }

        const resetsAt = (entry as Record<string, unknown>).resets_at;
        const resetAt = typeof resetsAt === "string" ? timeOf(resetsAt) : undefined;
        const raw = 100 - Math.min(100, rawUtil);

        windows.push({
            id: spec.id,
            tag: spec.tag,
            label: spec.label,
            ...measure(raw, rawUtil >= 100),
            ...(resetAt === undefined ? {} : { resetAt }),
            ...(spec.model === undefined ? {} : { model: spec.model }),
        });
    }

    return windows;
}

/** Parse ChatGPT/Codex's `GET /backend-api/wham/usage` JSON body into usage windows. */
export function parseCodexUsage(body: unknown, at: number): UsageWindow[] {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return [];
    }

    const rateLimit = (body as Record<string, unknown>).rate_limit;

    if (typeof rateLimit !== "object" || rateLimit === null || Array.isArray(rateLimit)) {
        return [];
    }

    const limitObj = rateLimit as Record<string, unknown>;
    const rawWindows: {
        which: "primary" | "secondary";
        used: number;
        minutes?: number;
        resetAt?: number;
    }[] = [];

    for (const which of ["primary", "secondary"] as const) {
        const entry = limitObj[`${which}_window`];

        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            continue;
        }

        const obj = entry as Record<string, unknown>;
        const used = obj.used_percent;

        if (typeof used !== "number" || !Number.isFinite(used) || used < 0) {
            continue;
        }

        const windowSec = obj.limit_window_seconds;
        const minutes =
            typeof windowSec === "number" && Number.isFinite(windowSec) && windowSec > 0
                ? Math.round(windowSec / 60)
                : undefined;
        const resetSec = obj.reset_at;
        const afterSec = obj.reset_after_seconds;
        const resetAt =
            typeof resetSec === "number" && Number.isFinite(resetSec) && resetSec > 0
                ? timeOf(String(resetSec))
                : typeof afterSec === "number" && Number.isFinite(afterSec) && afterSec > 0
                  ? at + Math.round(afterSec * 1000)
                  : undefined;

        rawWindows.push({ which, used, minutes, resetAt });
    }

    const anyExhausted = rawWindows.some((each) => each.used >= 100);
    const overallLimited = limitObj.limit_reached === true || limitObj.allowed === false;

    return rawWindows.map((each, index) => {
        const name =
            each.minutes === undefined
                ? {
                      tag: each.which === "primary" ? "5h" : "7d",
                      label: each.which === "primary" ? "Primary window" : "Secondary window",
                  }
                : windowName(each.minutes);
        const exhausted = each.used >= 100 || (!anyExhausted && overallLimited && index === 0);

        return {
            id: each.minutes === undefined ? each.which : name.tag,
            tag: name.tag,
            label: name.label,
            ...measure(100 - Math.min(100, each.used), exhausted),
            ...(each.resetAt === undefined ? {} : { resetAt: each.resetAt }),
        };
    });
}

/** Extract `chatgpt_account_id` from an OpenAI OAuth JWT payload without logging or throwing. */
export function extractJwtAccountId(token: string): string | undefined {
    const parts = token.split(".");

    if (parts.length !== 3) {
        return undefined;
    }

    try {
        const decoded = Buffer.from(parts[1]!, "base64url").toString("utf8");
        const payload = JSON.parse(decoded) as Record<string, unknown>;
        const claim = payload?.[CODEX_JWT_CLAIM];

        if (typeof claim !== "object" || claim === null) {
            return undefined;
        }

        const id = (claim as Record<string, unknown>).chatgpt_account_id;

        return typeof id === "string" && id.trim() !== "" ? id : undefined;
    } catch {
        return undefined;
    }
}

/** Read at most `limit` UTF-8 bytes from a fetch response; undefined when oversized. */
async function readBoundedText(response: Response, limit: number): Promise<string | undefined> {
    const declared = numberOf(response.headers.get("content-length") ?? undefined);

    if (declared !== undefined && declared > limit) {
        await response.body?.cancel().catch(() => {});

        return undefined;
    }

    if (response.body === null) {
        const text = await response.text();

        return Buffer.byteLength(text, "utf8") <= limit ? text : undefined;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            total += value.byteLength;

            if (total > limit) {
                await reader.cancel().catch(() => {});

                return undefined;
            }

            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    return Buffer.concat(chunks).toString("utf8");
}

function retryAfterMs(headers: Headers, baseCooldownMs: number): number {
    const millis = numberOf(headers.get("retry-after-ms") ?? undefined);
    const seconds = numberOf(headers.get("retry-after") ?? undefined);
    const ms = millis ?? (seconds === undefined ? undefined : seconds * 1000);

    if (ms === undefined || ms <= baseCooldownMs) {
        return baseCooldownMs;
    }

    return Math.min(USAGE_REFRESH_MAX_RETRY_MS, Math.round(ms));
}

export type UsageRefresherDeps = {
    store: UsageStore;
    getToken: (providerId: string, signal: AbortSignal) => Promise<string | undefined>;
    fetch?: typeof fetch;
    now?: () => number;
    cooldownMs?: number;
};

type SingleRefreshOutcome =
    { status: "refreshed" } | { status: "cooldown"; remainingMs: number } | { status: "failed" };

/**
 * Fetches live subscription usage on demand with per-provider cooldowns and single-flight deduplication so repeated
 * clicks never spam upstream endpoints.
 */
export class UsageRefresher {
    readonly #deps: UsageRefresherDeps;
    readonly #fetch: typeof fetch;
    readonly #now: () => number;
    readonly #cooldownMs: number;
    readonly #cooldownUntil = new Map<string, number>();
    readonly #epoch = new Map<string, number>();
    readonly #inFlight = new Map<string, Promise<SingleRefreshOutcome>>();
    readonly #controllers = new Map<string, AbortController>();

    constructor(deps: UsageRefresherDeps) {
        this.#deps = deps;
        this.#fetch = deps.fetch ?? globalThis.fetch;
        this.#now = deps.now ?? Date.now;
        this.#cooldownMs = deps.cooldownMs ?? USAGE_REFRESH_COOLDOWN_MS;
    }

    /** Clear a provider's cooldown and invalidate any in-flight request (e.g. after sign-in or sign-out). */
    forget(providerId: string): void {
        this.#epoch.set(providerId, (this.#epoch.get(providerId) ?? 0) + 1);
        this.#cooldownUntil.delete(providerId);
        this.#inFlight.delete(providerId);
        this.#controllers.get(providerId)?.abort();
        this.#controllers.delete(providerId);
    }

    /** Refresh one or more refreshable subscription providers, honoring cooldowns and deduplicating concurrent calls. */
    async refresh(
        providerIds: readonly string[],
        signal?: AbortSignal,
    ): Promise<{ refreshed: string[]; cooldownMs: number; failed: string[] }> {
        const unique = [...new Set(providerIds)].filter((id) => REFRESHABLE_SUBSCRIPTIONS.has(id));
        const refreshed: string[] = [];
        const failed: string[] = [];
        let cooldownMs = 0;

        await Promise.all(
            unique.map(async (providerId) => {
                const outcome = await this.#refreshOne(providerId, signal);

                if (outcome.status === "refreshed") {
                    refreshed.push(providerId);
                } else if (outcome.status === "cooldown") {
                    cooldownMs = Math.max(cooldownMs, outcome.remainingMs);
                } else {
                    failed.push(providerId);
                }
            }),
        );

        return { refreshed, cooldownMs, failed };
    }

    #refreshOne(providerId: string, signal?: AbortSignal): Promise<SingleRefreshOutcome> {
        const running = this.#inFlight.get(providerId);

        if (running !== undefined) {
            return running;
        }

        const now = this.#now();
        const until = this.#cooldownUntil.get(providerId) ?? 0;

        if (now < until) {
            return Promise.resolve({ status: "cooldown", remainingMs: until - now });
        }

        const epoch = this.#epoch.get(providerId) ?? 0;
        const controller = new AbortController();
        const work = this.#fetchProvider(providerId, epoch, controller, signal).finally(() => {
            if (this.#inFlight.get(providerId) === work) {
                this.#inFlight.delete(providerId);
            }

            if (this.#controllers.get(providerId) === controller) {
                this.#controllers.delete(providerId);
            }
        });

        this.#controllers.set(providerId, controller);
        this.#inFlight.set(providerId, work);

        return work;
    }

    async #fetchProvider(
        providerId: string,
        epoch: number,
        controller: AbortController,
        signal?: AbortSignal,
    ): Promise<SingleRefreshOutcome> {
        const stale = () => (this.#epoch.get(providerId) ?? 0) !== epoch;
        const timeout = AbortSignal.timeout(USAGE_REFRESH_TIMEOUT_MS);
        const signals =
            signal === undefined
                ? [controller.signal, timeout]
                : [controller.signal, signal, timeout];
        const combined = AbortSignal.any(signals);
        const startedAt = this.#now();

        this.#cooldownUntil.set(providerId, startedAt + this.#cooldownMs);

        try {
            const token = await this.#deps.getToken(providerId, combined);

            if (stale() || token === undefined || token.trim() === "") {
                return { status: "failed" };
            }

            const isAnthropic = providerId === "anthropic";
            const url = isAnthropic ? ANTHROPIC_USAGE_URL : CODEX_USAGE_URL;
            const headers: Record<string, string> = isAnthropic
                ? {
                      Authorization: `Bearer ${token}`,
                      "anthropic-beta": ANTHROPIC_OAUTH_BETA,
                      Accept: "application/json",
                      "User-Agent": ANTHROPIC_USER_AGENT,
                      "x-app": "cli",
                  }
                : {
                      Authorization: `Bearer ${token}`,
                      Accept: "application/json",
                      originator: "pi",
                  };

            if (!isAnthropic) {
                const accountId = extractJwtAccountId(token);

                if (accountId !== undefined) {
                    headers["chatgpt-account-id"] = accountId;
                }
            }

            const response = await this.#fetch(url, {
                method: "GET",
                headers,
                redirect: "error",
                signal: combined,
            });
            const at = this.#now();

            if (stale()) {
                await response.body?.cancel().catch(() => {});

                return { status: "failed" };
            }

            if (response.status === 429) {
                const waitMs = retryAfterMs(response.headers, this.#cooldownMs);

                this.#cooldownUntil.set(providerId, at + waitMs);
                await response.body?.cancel().catch(() => {});

                return { status: "failed" };
            }

            if (!response.ok) {
                await response.body?.cancel().catch(() => {});

                return { status: "failed" };
            }

            const text = await readBoundedText(response, MAX_USAGE_BODY_BYTES);

            if (stale()) {
                return { status: "failed" };
            }

            let windows: UsageWindow[] = [];

            if (text !== undefined) {
                try {
                    const parsed: unknown = JSON.parse(text);

                    windows = isAnthropic
                        ? parseAnthropicUsage(parsed)
                        : parseCodexUsage(parsed, at);
                } catch {
                    windows = [];
                }
            }

            if (windows.length === 0) {
                windows = parseUsage(responseFacts(response.status, response.headers), at);
            }

            if (stale() || windows.length === 0) {
                return { status: "failed" };
            }

            this.#deps.store.recordWindows(providerId, windows, at);

            return { status: "refreshed" };
        } catch {
            return { status: "failed" };
        }
    }
}

/** What each provider's newest response said about its limits. In memory only: a restart starts empty. */
export class UsageStore {
    readonly #entries = new Map<string, Entry>();
    readonly #deps: UsageDeps;
    readonly #now: () => number;

    constructor(deps: UsageDeps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    /** A response of this provider's came. Responses that say nothing and are server errors count for nothing. */
    record(provider: string, facts: UsageFacts, at: number = this.#now()): void {
        const windows = parseUsage(facts, at);
        const before = this.#entries.get(provider);

        if (windows.length === 0) {
            // A server error says nothing about whether the provider reports usage.
            if (facts.status >= 500 || before !== undefined) {
                return;
            }

            this.#entries.set(provider, { windows: [], at, silent: true });
            this.#deps.changed();

            return;
        }

        this.#entries.set(provider, { windows, at, silent: false });

        if (JSON.stringify(before?.windows) !== JSON.stringify(windows) || before?.silent) {
            this.#deps.changed();
        }
    }

    /** Record windows obtained directly from an on-demand subscription usage check, always updating `asOf`. */
    recordWindows(provider: string, windows: UsageWindow[], at: number = this.#now()): void {
        if (windows.length === 0) {
            return;
        }

        this.#entries.set(provider, { windows, at, silent: false });
        this.#deps.changed();
    }

    /** A sign-in or sign-out: the numbers were another account's. */
    forget(provider: string): void {
        if (this.#entries.delete(provider)) {
            this.#deps.changed();
        }
    }

    /** What is known of one provider now, `held` being what the limit gate says. */
    view(
        provider: {
            id: string;
            name: string;
            kind: UsageProvider["kind"];
            refreshable?: true;
        },
        held?: UsageProvider["held"],
        modelHolds: NonNullable<UsageProvider["modelHolds"]> = [],
    ): UsageProvider {
        const entry = this.#entries.get(provider.id);

        return {
            ...provider,
            status: entry === undefined ? "no-data" : entry.silent ? "not-reported" : "reported",
            ...(entry === undefined || entry.silent ? {} : { asOf: entry.at }),
            windows: entry?.windows ?? [],
            ...(held === undefined ? {} : { held }),
            ...(modelHolds.length === 0 ? {} : { modelHolds }),
        };
    }

    /** The ids of the providers that sent a response since the server started. */
    seen(): string[] {
        return [...this.#entries.keys()];
    }
}
