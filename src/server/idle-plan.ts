/**
 * Keep warm's arithmetic, with no state: how often an idle session's cache is refreshed, where Break-even stops, and the plan
 * a cache keeper follows for one entry. The keeper (`cache-keeper.ts`) refreshes on a plan; the settings
 * (`keep-warm.ts`) and the settings window show the same plan, so both read it from here.
 */

/** What is known of one model for keep warm: the owner's values over Pi's. */
export type ModelFacts = {
    /** How long the cache lives, as the owner or the maker's docs say; else the model's `promptCache` counts. */
    lifetimeMs?: number;
    /** Prices per million tokens to read and write the cache, for where Break-even stops. Undefined: not known. */
    prices?: { read: number; write: number };
};

/** What the owner's settings and the session's choice allow for one conversation's idle warming. */
export type IdlePolicy = {
    /** The session the conversation belongs to (itself, or a subagent's session): the cost cap is the session's. */
    session: number;
    /** Hours to keep warm after the run ends, or "break-even": until the refreshes cost as much as one cache write. */
    hours: number | "break-even";
    /** Dollars at most for a session's idle stretch, its subagents' refreshes included; 0: no cost cap. */
    maxCost: number;
    /** Refreshes at most for each conversation's idle stretch (each has a cache of its own). */
    maxRefreshes: number;
    /** Percent of a model's cache lifetime between refreshes. */
    share: number;
};

/** How one entry is kept warm: how often, how long its cache lives, and when it stops. */
export type IdlePlan = {
    /** The session whose cost cap it counts against. */
    session: number;
    everyMs: number;
    /** How long the cache lives after a request touches it. */
    lifeMs: number;
    /** When the run ended: the time limit counts from here. */
    since: number;
    /** When a time limit ends it; undefined: none (Break-even). */
    until?: number;
    maxCost: number;
    maxRefreshes: number;
    /** Break-even, and `maxRefreshes` is its break-even, which comes before the owner's refresh cap. */
    breakEven: boolean;
};

/** Failed refreshes in a row that stop keeping a session warm. */
export const IDLE_FAILURES = 2;

/**
 * How often an idle session is refreshed: `share` percent of the model's cache lifetime, and at least 10 seconds before
 * it ends. Undefined: the lifetime is not known, so it is not kept warm.
 */
export function idleEveryMs(ttlMs: number | undefined, share: number): number | undefined {
    if (ttlMs === undefined) {
        return undefined;
    }

    const every = Math.floor(Math.min((ttlMs * share) / 100, ttlMs - 10_000));

    return every > 0 ? every : undefined;
}

/**
 * Refreshes that cost as much as one message without a cache: `write / read - 1`, the prices per token, as the next
 * message reads a warm cache too (one read more). The prompt's size cancels out. A session kept warm this long and no
 * longer pays at most about twice what letting it expire would.
 */
export function breakEvenRefreshes(prices: { read: number; write: number }): number {
    return prices.read > 0 && prices.write > 0
        ? Math.max(1, Math.floor(prices.write / prices.read) - 1)
        : 0;
}

/**
 * The plan for one entry whose run ended at `since`: `ttlMs` is the cache lifetime the model's request asked for, which
 * `facts.lifetimeMs` (the owner's or a maker's) replaces. Undefined: no lifetime is known, so it is not kept warm.
 */
export function idlePlan(
    policy: IdlePolicy,
    facts: ModelFacts,
    ttlMs: number | undefined,
    since: number,
): IdlePlan | undefined {
    const lifeMs = facts.lifetimeMs ?? ttlMs;
    const everyMs = idleEveryMs(lifeMs, policy.share);

    if (lifeMs === undefined || everyMs === undefined) {
        return undefined;
    }

    const base = { session: policy.session, everyMs, lifeMs, since, maxCost: policy.maxCost };

    if (policy.hours !== "break-even") {
        return {
            ...base,
            until: since + policy.hours * 3_600_000,
            maxRefreshes: policy.maxRefreshes,
            breakEven: false,
        };
    }

    // The prices say where keeping warm stops paying off; with none, the owner's refresh cap does.
    const breakEven =
        (facts.prices === undefined ? 0 : breakEvenRefreshes(facts.prices)) || Infinity;

    return {
        ...base,
        maxRefreshes: Math.min(policy.maxRefreshes, breakEven),
        breakEven: breakEven < policy.maxRefreshes,
    };
}
