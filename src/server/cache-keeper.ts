/**
 * The cache keeper replays the last model request with one output token before its prompt cache expires.
 * Tool waits warm by default when the expected savings exceed the cost, within a 30-minute age cap.
 * Keep warm is off by default: the owner's idle policy chooses its interval, time, and caps.
 * Idle entries and completed session spend are saved, so warming can continue after a restart.
 * A real request replaces its entry; run and session changes stop or reconsider it.
 * `install` wraps `models.streamSimple`; warm requests bypass observation as real requests.
 * The final payload observer allows only output-cap fields to differ on a replay.
 * `PI_POCKET_CACHE_KEEPER=off` turns both modes off.
 * See docs/architecture.md, "Prompt cache keeper", for decisions, limits, storage, and lifecycle.
 */
import { createHash } from "node:crypto";
import { types } from "node:util";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    IDLE_FAILURES,
    type IdlePlan,
    type IdlePolicy,
    idlePlan,
    type ModelFacts,
} from "./idle-plan.ts";
import { type IdleRecord, type IdleStore, savedOptions } from "./keep-warm-store.ts";
import { cacheTier, factsTier, missPrice } from "./model-cache-facts.ts";
import { noWait } from "./limit-gate.ts";
import type {
    Api,
    AssistantMessage,
    AssistantMessageEventStream,
    Model,
    SimpleStreamOptions,
    TranscriptContext,
} from "@earendil-works/pi-ai";

type StreamSimple = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

const FINAL_PAYLOAD = Symbol("cache-keeper-final-payload");

type ObservedOptions = SimpleStreamOptions & { [FINAL_PAYLOAD]?: (payload: unknown) => void };

// Older TypeScript libraries do not yet declare Node's raw-JSON support.
const isRawJSON = (JSON as JSON & { isRawJSON?: (value: unknown) => value is { rawJSON: string } })
    .isRawJSON;
const OUTPUT_CAPS = new Set([
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "maxTokens",
]);
const NESTED_OUTPUT_CAPS = new Map([
    ["options", "maxTokens"],
    ["config", "maxOutputTokens"],
    ["inferenceConfig", "maxTokens"],
    ["generationConfig", "maxOutputTokens"],
]);

/** Hash the JSON sent to the provider. Only provider output-cap fields may differ on a warm. */
export function payloadHash(payload: unknown): string {
    let root: object | undefined;
    let first = true;
    // `toJSON` runs before the replacer; stringify keeps its wire semantics without a parse round trip.
    const json = JSON.stringify(payload, function (key, value: unknown) {
        const top = first;

        first = false;

        if (isRawJSON?.(value)) {
            // Normalize an already-encoded primitive, not a stringify/parse round trip of the payload.
            return JSON.parse(value.rawJSON) as unknown;
        }

        if (
            value === null ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            (types.isBoxedPrimitive(value) && !types.isSymbolObject(value))
        ) {
            return value;
        }

        // Only the root and its immediate children can contain an ignored output cap. No deep path copies.
        const cap = this === root ? NESTED_OUTPUT_CAPS.get(key) : undefined;
        // No prototype: `__proto__` is an ordinary JSON key.
        const sorted = Object.create(null) as Record<string, unknown>;

        for (const name of Object.keys(value).sort()) {
            if (!(top && OUTPUT_CAPS.has(name)) && name !== cap) {
                sorted[name] = (value as Record<string, unknown>)[name];
            }
        }

        if (top) {
            root = sorted;
        }

        return sorted;
    });

    return createHash("sha256").update(json).digest("hex");
}

/** Refresh at 90% of the lifetime, and never closer than 10 seconds to its end. */
export function refreshDelayMs(ttlMs: number): number | undefined {
    return ttlMs <= 10_000
        ? undefined
        : Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/** Warming never goes on past this long after the real request that started it. */
export const MAX_AGE_MS = 30 * 60_000;
/** Chance of a real request in the next interval after a tool call: the run goes on when the tool ends. */
export const TOOL_HAZARD = 0.9;

export type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type Decision = {
    action: "warm" | "stop";
    warmCost: number;
    missCost: number;
    hazard: number;
    expectedSavings: number;
};

/** Dollars. `rates` are per million tokens, as `Model.cost` is. */
export function decide(input: {
    promptTokens: number;
    rates: Rates;
    /** What a cache write costs per million tokens for the tier in use (the 1h tier costs more than the 5m tier). */
    writeRate: number;
    hazard: number;
}): Decision {
    const { promptTokens, rates, writeRate, hazard } = input;
    const warmCost = (promptTokens * rates.cacheRead + rates.output) / 1e6;
    const missCost = (promptTokens * (writeRate - rates.cacheRead)) / 1e6;
    const expectedSavings = hazard * missCost - warmCost;

    return {
        action: expectedSavings > 0 ? "warm" : "stop",
        warmCost,
        missCost,
        hazard,
        expectedSavings,
    };
}

/** Whether a one-token replay leaves the cache entry alone: budget-based thinking would change `budget_tokens`. */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
    if (!options?.reasoning || model.api !== "anthropic-messages") {
        return true;
    }

    return (
        (model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking ===
        true
    );
}

/** The model's cache lifetime for the tier in use, as its `promptCache` says; undefined when not known or not cached. */
function ttlMsOf(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
    const retention = cacheTier(options);

    if (retention === "none") {
        return undefined;
    }

    const seconds = model.promptCache?.[retention];

    return seconds === undefined ? undefined : seconds * 1000;
}

/** `provider/modelId`, the name the owner's per-model values use. */
export function specOf(model: { provider: string; id: string }): string {
    return `${model.provider}/${model.id}`;
}

/** The request's options as a replay may repeat them: its abort signal and telemetry belong to the real request. */
function replayOptions(options: SimpleStreamOptions): SimpleStreamOptions {
    const {
        signal: _signal,
        telemetry: _telemetry,
        ...rest
    } = options as SimpleStreamOptions & { telemetry?: unknown };

    return rest;
}

/** How long one idle refresh may take before it is given up. */
const IDLE_DEADLINE_MS = 5 * 60_000;
/** A refresh that erred is tried again this much later, while the cache lives. */
const IDLE_RETRY_MS = 30_000;

type IdleState = IdlePlan & { failures: number };

type Entry = {
    /** `tool`: a run waits on a tool. `parked`: the run's last request, kept until the run ends. `idle`: kept warm. */
    kind: "tool" | "parked" | "idle";
    model: Model<Api>;
    context: TranscriptContext;
    options: SimpleStreamOptions;
    promptTokens: number;
    ttlMs?: number;
    payloadHash?: string;
    /** The observed final payload, released as soon as its hash is needed. */
    payload?: { value: unknown };
    /** The conversation this session belongs to, once known. */
    conversationId?: number;
    warms: number;
    spent: number;
    /** When the real request ended; the tool-wait age cap counts from here, not from a refresh. */
    endedAt: number;
    /** The last time a request read or wrote this cache entry. */
    lastTouch: number;
    /** When the next refresh should go out; a refresh later than the slack after it would pay a full rewrite. */
    dueAt: number;
    timer?: ReturnType<typeof setTimeout>;
    /** The refresh on its way: only that refresh clears it, so no second one goes out beside it, even once parked. */
    abort?: AbortController;
    deadline?: ReturnType<typeof setTimeout>;
    account?: WarmAccount;
    idle?: IdleState;
    /**
     * The idle stretch a parked entry was warmed in (since, failures; `warms` and `spent` stay on the entry): turned
     * on again, or given a longer limit, it goes on from here, so its limits do not start over.
     */
    stretch?: { since: number; failures: number };
    /** Dropped at shutdown but kept on disk: a refresh on its way still saves what it counted. */
    keptSaved?: boolean;
};

/** A real request on its way: `seq` orders it against stops (`forget`), and the lookup fills in its conversation. */
type PendingRequest = { seq: number; conversationId?: number; payload?: { value: unknown } };

type WarmAccount = {
    /** Check the captured payer's current spend limits immediately before each warm; `idle` allows a run that ended. */
    check: (idle: boolean) => boolean;
    /** Count even failed, aborted, or superseded responses when the provider reports usage. */
    recordUsage: (message: AssistantMessage) => Promise<void>;
};

export type KeeperStatus = { warming: number; warms: number; spent: number };
/** One conversation's idle warming, for the app. */
export type IdleStatus =
    | {
          warm: true;
          nextAt: number;
          until?: number;
          refreshes: number;
          /** The refreshes this stretch may have: Break-even's break-even, or the owner's cap. */
          maxRefreshes: number;
          spent: number;
      }
    | { warm: false; stopped?: string };

export type KeeperDeps = {
    now?: () => number;
    /** Hash the final payload for comparison or persistence. */
    payloadHash?: (payload: unknown) => string;
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    log?: (line: string) => void;
    /** The conversation that sends requests under a provider session id, so `runEnded` can find its warm. */
    conversationOf?: (sessionId: string) => Promise<number | undefined>;
    /** Whether a conversation is in a run now. */
    isRunning?: (conversationId: number) => boolean;
    /** Capture who pays for this run, with its spend check and usage recorder. */
    accountFor?: (conversationId: number) => WarmAccount | undefined;
    /** True turns the keeper off. Read at each decision. */
    disabled?: () => boolean;
    /** Whether, and how, a conversation is kept warm once its run ends; undefined: it is not. */
    idlePolicy?: (conversationId: number) => IdlePolicy | undefined;
    /** Whether this conversation can ever use keep warm, regardless of its current settings. */
    warmable?: (conversationId: number) => boolean;
    /** What is known of a model (`provider/modelId`): its cache lifetime and published cache prices. */
    modelFacts?: (spec: string, tier?: "short" | "long") => ModelFacts;
    /** A model by provider and id, to warm a saved entry after a restart. */
    modelOf?: (provider: string, modelId: string) => Model<Api> | undefined;
    /** Where idle entries are kept between restarts. */
    store?: IdleStore;
    /** Idle warming of a conversation started, refreshed, or stopped (`idleStatus` says why it stopped). */
    changed?: (conversationId: number) => void;
};

/** Completed spend and in-flight reservations for each session's idle stretch. */
class SessionBudget {
    readonly #sessions = new Map<number, { spent: number; reserved: number }>();

    used(session: number): number {
        const budget = this.#sessions.get(session);

        return budget === undefined ? 0 : budget.spent + budget.reserved;
    }

    reserve(session: number, amount: number): void {
        const budget = this.#sessions.get(session) ?? { spent: 0, reserved: 0 };

        budget.reserved += amount;
        this.#sessions.set(session, budget);
    }

    settle(session: number, reserved: number, actual: number): void {
        const budget = this.#sessions.get(session) ?? { spent: 0, reserved: 0 };

        budget.reserved = Math.max(0, budget.reserved - reserved);
        budget.spent += actual;
        this.#sessions.set(session, budget);
    }

    clear(session: number): boolean {
        const budget = this.#sessions.get(session);

        if (budget === undefined) {
            return false;
        }

        // An aborted refresh can still return usage. Keep its reservation until it settles.
        if (budget.reserved > 0) {
            if (budget.spent === 0) {
                return false;
            }

            budget.spent = 0;
        } else {
            this.#sessions.delete(session);
        }

        return true;
    }

    /** Keep only the sessions `keep` names, or with a refresh on its way: the others have no stretch to cap. */
    retain(keep: Set<number>): void {
        for (const [session, budget] of this.#sessions) {
            if (!keep.has(session) && budget.reserved === 0) {
                this.#sessions.delete(session);
            }
        }
    }

    *entries(): IterableIterator<[number, number]> {
        for (const [session, budget] of this.#sessions) {
            yield [session, budget.spent];
        }
    }

    load(budgets: Record<string, number>): void {
        for (const [session, spent] of Object.entries(budgets)) {
            const id = Number(session);

            if (Number.isSafeInteger(id) && !this.#sessions.has(id)) {
                this.#sessions.set(id, { spent, reserved: 0 });
            }
        }
    }
}

export class CacheKeeper {
    readonly #deps: KeeperDeps &
        Required<
            Pick<KeeperDeps, "now" | "payloadHash" | "setTimer" | "clearTimer" | "log" | "disabled">
        >;
    readonly #entries = new Map<string, Entry>();
    readonly #requests = new Map<string, PendingRequest>();
    readonly #pending = new Set<Promise<void>>();
    /** Why idle warming last stopped, by conversation, while nothing warms it. */
    readonly #stopped = new Map<number, string>();
    readonly #budgets = new SessionBudget();
    /** Counts requests and stops, so that each can tell which came first. */
    #seq = 0;
    /**
     * When each conversation's cache last stopped counting (`forget`: another model or context, archived; `runStarted`):
     * a request that began before it, or an entry saved before the restart, is never kept warm.
     */
    readonly #invalidated = new Map<number, number>();
    #underlying: StreamSimple | undefined;
    #closed = false;
    #warms = 0;
    #spent = 0;

    constructor(deps: KeeperDeps = {}) {
        this.#deps = {
            now: Date.now,
            payloadHash,
            setTimer: (fn, ms) => {
                const timer = setTimeout(fn, ms);

                timer.unref();

                return timer;
            },
            clearTimer: clearTimeout,
            log: () => {},
            disabled: () => process.env.PI_POCKET_CACHE_KEEPER === "off",
            ...deps,
        };
    }

    status(): KeeperStatus {
        let warming = 0;

        for (const entry of this.#entries.values()) {
            if (entry.kind !== "parked") {
                warming++;
            }
        }

        return { warming, warms: this.#warms, spent: this.#spent };
    }

    /** Idle warming now: how many conversations, and their refreshes and spend in this stretch. */
    idleSummary(): { warm: number; refreshes: number; spent: number } {
        let warm = 0;
        let refreshes = 0;
        let spent = 0;

        for (const entry of this.#entries.values()) {
            if (entry.kind === "idle") {
                warm++;
                refreshes += entry.warms;
                spent += entry.spent;
            }
        }

        return { warm, refreshes, spent };
    }

    /** One conversation's idle warming: when the next refresh goes out, or why it last stopped. */
    idleStatus(conversationId: number): IdleStatus {
        for (const entry of this.#entries.values()) {
            if (entry.kind === "idle" && entry.conversationId === conversationId && entry.idle) {
                return {
                    warm: true,
                    nextAt: entry.dueAt,
                    ...(entry.idle.until === undefined ? {} : { until: entry.idle.until }),
                    refreshes: entry.warms,
                    maxRefreshes: entry.idle.maxRefreshes,
                    spent: entry.spent,
                };
            }
        }

        const stopped = this.#stopped.get(conversationId);

        return stopped === undefined ? { warm: false } : { warm: false, stopped };
    }

    /** Shutdown: no warm goes out after this. Idle entries stay saved, so the next start goes on warming them. */
    async close(): Promise<void> {
        this.#closed = true;
        this.#requests.clear();

        for (const key of [...this.#entries.keys()]) {
            this.#drop(key, undefined, true);
        }

        // Keep the usage listener and storage open until aborted responses have been counted.
        await Promise.allSettled([...this.#pending]);
        await this.#deps.store?.flush();
    }

    /** Install before request shaping, so this callback sees its final output at the adapter boundary. */
    installPayloadObserver(models: { streamSimple: StreamSimple }): void {
        const underlying = models.streamSimple.bind(models);

        models.streamSimple = (model, context, options) => {
            const observe = (options as ObservedOptions | undefined)?.[FINAL_PAYLOAD];

            if (observe === undefined) {
                return underlying(model, context, options);
            }

            return underlying(model, context, {
                ...options,
                onPayload: async (payload, payloadModel) => {
                    const shaped = await options?.onPayload?.(payload, payloadModel);

                    observe(shaped === undefined ? payload : shaped);

                    return shaped;
                },
            });
        };
    }

    install(models: { streamSimple: StreamSimple }): void {
        const underlying = models.streamSimple.bind(models);

        this.#underlying = underlying;
        models.streamSimple = (model, context, options) =>
            this.#stream(underlying, model, context, options);
    }

    #stream(
        underlying: StreamSimple,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
    ): AssistantMessageEventStream {
        const key = options?.sessionId;
        // The owner or the maker's docs may know a lifetime for a model whose `promptCache` says nothing.
        const known =
            ttlMsOf(model, options) !== undefined ||
            this.#deps.modelFacts?.(specOf(model)).lifetimeMs !== undefined;

        // Uncached calls (a compaction's, a model with no known lifetime) leave an existing entry alone.
        if (key === undefined || cacheTier(options) === "none" || !known) {
            return underlying(model, context, options);
        }

        const eligible = !this.#closed && !this.#deps.disabled() && isReplayable(model, options);
        const request: PendingRequest = { seq: ++this.#seq };
        const observed: ObservedOptions = {
            ...options,
            [FINAL_PAYLOAD]: (payload) => {
                request.payload = { value: payload };
            },
        };
        const stream = underlying(model, context, eligible ? observed : options);

        // A real request that writes the cache replaces the entry, so stop warming the old one.
        this.#drop(key);
        this.#requests.set(key, request);
        void this.#deps.conversationOf?.(key).then(
            (id) => {
                if (id !== undefined) {
                    request.conversationId = id;
                }
            },
            () => {},
        );
        void stream.result().then(
            (message) => {
                if (this.#requests.get(key) !== request) {
                    return;
                }

                this.#requests.delete(key);
                this.#onSettled(key, model, context, options, message, request);
            },
            () => {
                if (this.#requests.get(key) === request) {
                    this.#requests.delete(key);
                }
            },
        );

        return stream;
    }

    /** Whether a request that began at `seq` still counts for this conversation: no stop came after it began. */
    #current(conversationId: number, seq: number): boolean {
        return (this.#invalidated.get(conversationId) ?? 0) < seq;
    }

    #invalidate(conversationId: number): void {
        this.#invalidated.set(conversationId, ++this.#seq);
    }

    #onSettled(
        key: string,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
        message: AssistantMessage,
        request: PendingRequest,
    ): void {
        const finished =
            message.stopReason === "toolUse" ||
            message.stopReason === "stop" ||
            message.stopReason === "length";

        if (!finished || options === undefined || request.payload === undefined) {
            return;
        }

        if (this.#closed || this.#deps.disabled() || !isReplayable(model, options)) {
            return;
        }

        if (
            request.conversationId !== undefined &&
            !this.#current(request.conversationId, request.seq)
        ) {
            return;
        }

        const ttlMs = ttlMsOf(model, options);
        const usage = message.usage;
        const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        const delay = ttlMs === undefined ? undefined : refreshDelayMs(ttlMs);

        if (promptTokens === 0) {
            return;
        }

        // A tool wait is warmed when its first refresh falls inside the cap: a longer cache outlives any wait it allows.
        const tool = message.stopReason === "toolUse" && delay !== undefined && delay < MAX_AGE_MS;

        // The run's last request is parked for keep warm when the app has it, even for a session that is Off now: the
        // session can be turned on after its run ended, while the cache lives. `#toIdle` asks for the policy then.
        if (!tool && this.#deps.idlePolicy === undefined) {
            return;
        }

        const now = this.#deps.now();
        const entry: Entry = {
            kind: tool ? "tool" : "parked",
            model,
            context,
            options,
            promptTokens,
            ...(ttlMs === undefined ? {} : { ttlMs }),
            payload: request.payload,
            ...(request.conversationId === undefined
                ? {}
                : { conversationId: request.conversationId }),
            endedAt: now,
            lastTouch: now,
            dueAt: now + (delay ?? 0),
            warms: 0,
            spent: 0,
        };

        this.#entries.set(key, entry);

        if (tool) {
            this.#schedule(key, entry, delay);
        }

        const known = (id: number) => {
            // A stop came for this conversation while the request was on its way: its cache is not the one used next.
            if (!this.#current(id, request.seq)) {
                return this.#drop(key);
            }

            entry.conversationId = id;
            entry.account = this.#deps.accountFor?.(id);

            // The run ended before the lookup came back: its end was missed.
            if (this.#deps.isRunning?.(id) === false) {
                this.#toIdle(key, entry);
            }
        };

        if (entry.conversationId !== undefined) {
            known(entry.conversationId);

            return;
        }

        // Which conversation it is, so that the run's end can stop it. A tool wait still warms when this is not known.
        void this.#deps.conversationOf?.(key).then(
            (id) => {
                if (id !== undefined && this.#entries.get(key) === entry) {
                    known(id);
                }
            },
            () => {},
        );
    }

    /** A run ended or was stopped: no request follows its last tool call. Its last request may be kept warm. */
    runEnded(conversationId: number): void {
        // An unresolved lookup cannot prove which run owns the request. Discard it rather than charge a later run.
        for (const [key, request] of this.#requests) {
            if (request.conversationId === undefined || request.conversationId === conversationId) {
                this.#requests.delete(key);
            }
        }

        for (const [key, entry] of [...this.#entries]) {
            if (
                entry.kind !== "idle" &&
                (entry.conversationId === undefined || entry.conversationId === conversationId)
            ) {
                this.#toIdle(key, entry);
            }
        }
    }

    /**
     * A run started: its own requests take over the cache, so the idle warming stops, with nothing to report. A request
     * of this run is parked with no timer until the run ends; one parked with a timer is the run before's, kept while Off.
     */
    runStarted(conversationId: number): void {
        this.#stopped.delete(conversationId);

        // A request kept from the run before (warm, or parked while Off) is not the one the new run continues from.
        for (const [key, entry] of [...this.#entries]) {
            if (
                (entry.kind === "idle" || (entry.kind === "parked" && entry.timer !== undefined)) &&
                entry.conversationId === conversationId
            ) {
                this.#drop(key);
            }
        }

        // A session's new run ends its idle stretch: the next one starts its cost cap from nothing.
        if (this.#budgets.clear(conversationId)) {
            this.#saveBudgets();
        }
    }

    /**
     * Stop warming a conversation: its next request differs (another model, a compaction, New context), it was
     * archived, or its session no longer wants it.
     */
    forget(conversationId: number, reason: string): void {
        this.#invalidate(conversationId);

        for (const [key, entry] of [...this.#entries]) {
            if (entry.conversationId === conversationId) {
                this.#drop(key, entry.kind === "idle" ? reason : undefined);
            }
        }
    }

    /**
     * The owner's settings or a session's choice changed: each idle entry follows them now. One turned off is parked,
     * not dropped, while its cache lives, so turning it on again picks it up; a parked one the change allows again is
     * kept warm from now. Off is then the choice, so no stop is reported for it.
     */
    reconsider(conversations?: ReadonlySet<ConversationId>): void {
        for (const [key, entry] of [...this.#entries]) {
            if (
                conversations !== undefined &&
                (entry.conversationId === undefined ||
                    !conversations.has(entry.conversationId as ConversationId))
            ) {
                continue;
            }

            if (entry.kind === "parked") {
                if (
                    entry.conversationId !== undefined &&
                    this.#deps.isRunning?.(entry.conversationId) !== true
                ) {
                    this.#toIdle(key, entry);
                }

                continue;
            }

            if (entry.kind !== "idle" || entry.idle === undefined) {
                continue;
            }

            const plan = this.#plan(entry, entry.idle.since);

            if (plan === undefined) {
                this.#park(key, entry);
                continue;
            }

            // Break-even and Off have no deadline: one left from a time limit must not stay.
            delete entry.idle.until;
            Object.assign(entry.idle, plan);

            // A refresh on its way plans the next itself.
            if (entry.abort === undefined) {
                this.#scheduleIdle(key, entry);
            }

            this.#deps.changed?.(entry.conversationId!);
        }
    }

    /** Go on warming the idle entries saved before a restart, while their caches live. */
    async restore(): Promise<void> {
        const store = this.#deps.store;

        if (store === undefined) {
            return;
        }

        const began = ++this.#seq;
        const [budgets, records] = await Promise.all([store.loadBudgets(), store.load()]);

        this.#budgets.load(budgets);

        for (const record of records) {
            // The provider session id must still be this conversation's: a record never warms another's context.
            const owner = await this.#deps.conversationOf?.(record.key).catch(() => undefined);
            const model = this.#deps.modelOf?.(record.provider, record.modelId);

            if (
                owner !== record.conversationId ||
                // Another model, a new context, or archiving came while the saved entries were loading.
                !this.#current(record.conversationId, began) ||
                this.#closed ||
                this.#deps.disabled() ||
                model === undefined ||
                // Its run goes on after the restart: that run's requests touch the cache.
                this.#deps.isRunning?.(record.conversationId) === true ||
                this.#entries.has(record.key)
            ) {
                if (!this.#entries.has(record.key)) {
                    store.delete(record.key);
                }

                continue;
            }

            const entry: Entry = {
                kind: "parked",
                model,
                context: { messages: record.messages } as unknown as TranscriptContext,
                options: record.options as SimpleStreamOptions,
                promptTokens: record.promptTokens,
                ...(record.ttlMs === undefined ? {} : { ttlMs: record.ttlMs }),
                payloadHash: record.payloadHash,
                conversationId: record.conversationId,
                endedAt: record.since,
                lastTouch: record.lastTouch,
                dueAt: record.lastTouch,
                warms: record.warms,
                spent: record.spent,
                account: this.#deps.accountFor?.(record.conversationId),
            };

            this.#entries.set(record.key, entry);
            this.#toIdle(record.key, entry, { since: record.since, failures: record.failures });

            // With no saved budget for its session (a missing or damaged file), its own spend still counts.
            const session = entry.idle?.session;

            if (session !== undefined && budgets[String(session)] === undefined) {
                this.#budgets.settle(session, 0, record.spent);
            }
        }

        // A session with nothing left to warm has no stretch to cap: a new run would clear it anyway.
        const sessions = new Set<number>();

        for (const entry of this.#entries.values()) {
            if (entry.kind === "idle" && entry.idle !== undefined) {
                sessions.add(entry.idle.session);
            }
        }

        this.#budgets.retain(sessions);
        this.#saveBudgets();
    }

    /**
     * How an entry is kept warm now, from the owner's settings and the session's choice: how often, how long its cache
     * lives, and when it stops. Undefined: it is not kept warm (off, or nothing says how often to refresh it).
     */
    #plan(entry: Entry, since: number): IdlePlan | undefined {
        const policy =
            entry.conversationId === undefined || this.#closed || this.#deps.disabled()
                ? undefined
                : this.#deps.idlePolicy?.(entry.conversationId);

        return policy === undefined
            ? undefined
            : idlePlan(
                  policy,
                  this.#deps.modelFacts?.(specOf(entry.model), factsTier(entry.options)) ?? {},
                  entry.ttlMs,
                  since,
              );
    }

    /**
     * Stop refreshing an entry but keep its request while its cache lives: keep warm was turned off, a limit stopped it,
     * or its run ended while Off. Turning it on, or a longer limit, picks it up again with the stretch it had. Its saved
     * copy goes. `reason`: why it stopped, for the session's view (Off is a choice and has none).
     */
    #park(key: string, entry: Entry, reason?: string): void {
        // Hashed once, when the run ends, so a parked entry holds no copy of the provider payload for its cache's life.
        if (this.#payloadHash(entry) === undefined) {
            return this.#drop(key);
        }

        const lifeMs = entry.idle?.lifeMs;
        const wasIdle = entry.kind === "idle";
        const stopped =
            entry.conversationId === undefined
                ? undefined
                : this.#stopped.get(entry.conversationId);

        if (entry.timer !== undefined) {
            this.#deps.clearTimer(entry.timer);
            entry.timer = undefined;
        }

        // A refresh on its way keeps its deadline: one that never settles still ends the entry, as it would unparked.
        if (entry.abort === undefined && entry.deadline !== undefined) {
            this.#deps.clearTimer(entry.deadline);
            entry.deadline = undefined;
        }

        entry.abort?.abort();

        if (entry.idle !== undefined) {
            entry.stretch = { since: entry.idle.since, failures: entry.idle.failures };
            this.#deps.store?.delete(key);
        }

        entry.kind = "parked";
        entry.idle = undefined;

        if (entry.conversationId !== undefined) {
            if (reason === undefined) {
                this.#stopped.delete(entry.conversationId);
            } else {
                this.#stopped.set(entry.conversationId, reason);
            }
        }

        const life =
            lifeMs ??
            this.#deps.modelFacts?.(specOf(entry.model), factsTier(entry.options)).lifetimeMs ??
            entry.ttlMs ??
            MAX_AGE_MS;

        entry.timer = this.#deps.setTimer(
            () => {
                if (this.#entries.get(key) === entry && entry.kind === "parked") {
                    this.#drop(key);
                }
            },
            Math.max(1, entry.lastTouch + life - this.#deps.now()),
        );

        if (entry.conversationId !== undefined && (wasIdle || stopped !== reason)) {
            this.#deps.changed?.(entry.conversationId);
        }
    }

    /** Plan the next idle refresh, `everyMs` after a request last touched the cache. */
    #scheduleIdle(key: string, entry: Entry): void {
        this.#schedule(
            key,
            entry,
            Math.max(1, entry.lastTouch + entry.idle!.everyMs - this.#deps.now()),
        );
    }

    /** The run is over: keep its last request warm when the owner wants that, else stop. */
    #toIdle(key: string, entry: Entry, restored?: { since: number; failures: number }): void {
        const conversationId = entry.conversationId;
        const now = this.#deps.now();
        // A parked entry picked up again goes on with its stretch, as a restored one does.
        const saved = restored ?? entry.stretch;
        const plan = this.#plan(entry, saved?.since ?? now);

        // A saved entry that is not warmed again is deleted, so the next start does not find it.
        const stop = (reason?: string) => {
            this.#drop(key, reason);

            if (restored !== undefined) {
                this.#deps.store?.delete(key);
            }
        };

        if (conversationId === undefined) {
            return stop();
        }

        // Off for this session now: kept as it is while its cache lives, in case it is turned on. Off is a choice, so a
        // limit's old stop is not shown. A saved entry is not loaded again only to be parked, and a conversation that can
        // never be kept warm (PiP's, or no session's) keeps nothing.
        if (plan === undefined) {
            return restored === undefined &&
                this.#deps.idlePolicy !== undefined &&
                this.#deps.warmable?.(conversationId) !== false &&
                !this.#closed &&
                !this.#deps.disabled()
                ? this.#park(key, entry)
                : stop();
        }

        const idle: IdleState = { ...plan, failures: saved?.failures ?? 0 };

        // The cache is gone already (a long restart, or turned on again too late): a refresh would only write it again.
        if (now >= entry.lastTouch + idle.lifeMs - 10_000) {
            return stop(restored === undefined ? undefined : "the cache expired during a restart");
        }

        if (saved === undefined) {
            entry.warms = 0;
            entry.spent = 0;
        }

        // Limits that would stop it at once (the old limit came back) leave it parked with its reason.
        const stopNow =
            entry.stretch === undefined ? undefined : this.#limitStop({ ...entry, idle }, now);

        if (stopNow !== undefined) {
            return this.#park(key, entry, stopNow);
        }

        entry.kind = "idle";
        entry.idle = idle;
        entry.stretch = undefined;
        entry.account ??= this.#deps.accountFor?.(conversationId);
        this.#stopped.delete(conversationId);

        // A refresh on its way (a tool wait's, or one parked on its way) plans the next itself when it settles; the
        // parked entry's expiry goes.
        if (entry.abort === undefined) {
            this.#scheduleIdle(key, entry);
        } else if (entry.timer !== undefined) {
            this.#deps.clearTimer(entry.timer);
            entry.timer = undefined;
        }

        this.#save(key, entry, restored === undefined);
        this.#deps.changed?.(conversationId);
    }

    #saveBudgets(): void {
        this.#deps.store?.saveBudgets(Object.fromEntries(this.#budgets.entries()));
    }

    /** Hash once on demand, then release the observed payload even when it cannot be serialized. */
    #payloadHash(entry: Entry): string | undefined {
        const payload = entry.payload;

        if (payload !== undefined) {
            delete entry.payload;

            try {
                entry.payloadHash = this.#deps.payloadHash(payload.value);
            } catch {
                // A payload we cannot compare can serve the real request, but must never be warmed.
            }
        }

        return entry.payloadHash;
    }

    #save(key: string, entry: Entry, withContext: boolean): void {
        const store = this.#deps.store;

        if (store === undefined || entry.idle === undefined || entry.conversationId === undefined) {
            return;
        }

        const fingerprint = this.#payloadHash(entry);

        if (fingerprint === undefined) {
            this.#drop(key);

            return;
        }

        store.save(
            {
                version: 1,
                key,
                conversationId: entry.conversationId,
                provider: entry.model.provider,
                modelId: entry.model.id,
                messages: withContext ? entry.context.messages : [],
                // Only what JSON keeps: a replay that differs because of a lost field fails the payload check.
                options: savedOptions(
                    JSON.parse(JSON.stringify(replayOptions(entry.options))) as Record<
                        string,
                        unknown
                    >,
                ),
                promptTokens: entry.promptTokens,
                ...(entry.ttlMs === undefined ? {} : { ttlMs: entry.ttlMs }),
                payloadHash: fingerprint,
                lastTouch: entry.lastTouch,
                since: entry.idle.since,
                warms: entry.warms,
                spent: entry.spent,
                failures: entry.idle.failures,
            } satisfies IdleRecord,
            withContext,
        );
    }

    #schedule(key: string, entry: Entry, delay: number | undefined): void {
        const wait = delay ?? 0;
        const now = this.#deps.now();
        const cap =
            entry.kind === "idle"
                ? entry.idle?.until === undefined
                    ? wait
                    : Math.max(0, entry.idle.until - now)
                : Math.max(0, entry.endedAt + MAX_AGE_MS - now);

        // One timer per entry: a new plan replaces the one before.
        if (entry.timer !== undefined) {
            this.#deps.clearTimer(entry.timer);
        }

        entry.dueAt = now + wait;
        entry.timer = this.#deps.setTimer(
            () => {
                const pending = this.#tick(key, entry);

                this.#pending.add(pending);
                void pending.finally(() => this.#pending.delete(pending));
            },
            Math.min(wait, cap),
        );
    }

    #decision(entry: Entry): Decision {
        // Only the 5m tier is ever warmed during a tool wait (see `#onSettled`), at the model's `cacheWrite` price.
        const writeRate = entry.model.cost.cacheWrite || entry.model.cost.input;

        return decide({
            promptTokens: entry.promptTokens,
            rates: entry.model.cost,
            writeRate,
            hazard: TOOL_HAZARD,
        });
    }

    /** A cache miss for the full prompt and one output token, in dollars, at the lifetime the entry is warmed for. */
    #idleWorst(entry: Entry): number {
        const seconds = entry.idle === undefined ? undefined : entry.idle.lifeMs / 1000;
        // The replay keeps the request's own cache tier, so an owner's shorter lifetime never lowers its miss price.
        const price = Math.max(
            missPrice(entry.model, entry.options),
            missPrice(entry.model, entry.options, seconds),
        );

        return (entry.promptTokens * price + entry.model.cost.output) / 1_000_000;
    }

    /** Why an idle entry may not refresh now; undefined: it may. */
    #idleStop(entry: Entry, now: number): { reason?: string; park: boolean } | undefined {
        const idle = entry.idle!;
        const slack = Math.max((idle.lifeMs - idle.everyMs) / 2, 60_000);

        // Its cache may be gone already: nothing is left to pick up again.
        if (now > entry.dueAt + slack || now >= entry.lastTouch + idle.lifeMs) {
            return {
                reason: "the refresh came too late (the server was busy or asleep)",
                park: false,
            };
        }

        // Off is a choice: kept for turning on again, with no stop to show.
        if (
            entry.conversationId === undefined ||
            this.#deps.idlePolicy?.(entry.conversationId) === undefined
        ) {
            return { park: true };
        }

        const limit = this.#limitStop(entry, now);

        return limit === undefined ? undefined : { reason: limit, park: true };
    }

    /**
     * Which of the owner's limits stops an idle entry now; undefined: none. Each may change (a longer time, a higher
     * cap, a raised spend limit), so the entry is parked and picked up when one does.
     */
    #limitStop(entry: Entry, now: number): string | undefined {
        const idle = entry.idle!;

        if (idle.until !== undefined && now >= idle.until) {
            return "the time limit was reached";
        }

        if (entry.warms >= idle.maxRefreshes) {
            return idle.breakEven
                ? "Break-even: more refreshes would cost more than writing the cache again"
                : "the refresh cap was reached";
        }

        // The session's whole idle stretch counts (its subagents' too, stopped entries, and refreshes in flight), and the
        // next refresh at its worst: a cache that is gone is written again in full. So the cap is never passed.
        if (
            idle.maxCost > 0 &&
            this.#budgets.used(idle.session) + this.#idleWorst(entry) > idle.maxCost
        ) {
            return "the cost cap was reached";
        }

        if (
            (this.#deps.accountFor !== undefined && entry.account === undefined) ||
            entry.account?.check(true) === false
        ) {
            return "a spend limit was reached";
        }

        return undefined;
    }

    async #tick(key: string, entry: Entry): Promise<void> {
        if (this.#entries.get(key) !== entry) {
            return;
        }

        const now = this.#deps.now();
        const idle = entry.kind === "idle" ? entry.idle : undefined;
        // An idle entry's stop is reported; a tool wait's is not. A run can end while this refresh is on its way.
        const why = (reason: string) => (entry.kind === "idle" ? reason : undefined);

        if (this.#deps.disabled()) {
            return this.#drop(key, why("turned off"));
        }

        let delay = 0;
        let reserved = 0;

        if (idle !== undefined) {
            const stop = this.#idleStop(entry, now);

            if (stop !== undefined) {
                return stop.park
                    ? this.#park(key, entry, stop.reason)
                    : this.#drop(key, stop.reason);
            }

            reserved = this.#idleWorst(entry);
            this.#budgets.reserve(idle.session, reserved);
        } else {
            delay = refreshDelayMs(entry.ttlMs!) as number;
            // A timer that fired late (the machine slept) would send its refresh after the entry expired.
            const slack = (entry.ttlMs! - delay) / 2;

            if (now - entry.endedAt >= MAX_AGE_MS || now > entry.dueAt + slack) {
                return this.#drop(key);
            }

            if (
                this.#decision(entry).action === "stop" ||
                (this.#deps.accountFor !== undefined && entry.account === undefined) ||
                entry.account?.check(false) === false
            ) {
                return this.#drop(key);
            }
        }

        let actual = 0;
        const abort = new AbortController();
        // Parked while it was on its way (and maybe turned on again): its abort is no failure of the refresh.
        const interrupted = () => abort.signal.aborted && this.#entries.get(key) === entry;

        try {
            entry.abort = abort;
            entry.deadline = this.#deps.setTimer(
                () => {
                    if (this.#entries.get(key) === entry) {
                        this.#drop(key, why("a refresh did not finish"));
                    }
                },
                idle === undefined ? entry.endedAt + MAX_AGE_MS - now : IDLE_DEADLINE_MS,
            );

            let rejected = true;
            const options: ObservedOptions = {
                ...replayOptions(entry.options),
                maxTokens: 1,
                maxRetries: 0,
                signal: abort.signal,
                [FINAL_PAYLOAD]: (payload) => {
                    rejected = true;
                    abort.signal.throwIfAborted();

                    // The last moment before it is sent: an idle session archived or turned off meanwhile is not refreshed.
                    if (
                        entry.kind === "idle" &&
                        (entry.conversationId === undefined ||
                            this.#deps.idlePolicy?.(entry.conversationId) === undefined)
                    ) {
                        if (this.#entries.get(key) === entry) {
                            this.#park(key, entry);
                        }

                        throw new Error("Keep warm was turned off for this session.");
                    }

                    let matches = false;

                    try {
                        matches = this.#payloadHash(entry) === this.#deps.payloadHash(payload);
                    } catch {
                        // Fail closed when the shaped payload no longer has a comparable JSON representation.
                    }

                    if (!matches) {
                        if (this.#entries.get(key) === entry) {
                            this.#drop(
                                key,
                                why("the request changed, so it could not be repeated"),
                            );
                        }

                        // This callback runs after all shapers, outside their error handlers, before transmission.
                        throw new Error("The warm payload differs from the cached request.");
                    }

                    rejected = false;
                },
            };

            // `noWait`: a warm request that meets a limit fails; it must not queue behind the limit gate.
            const stream = (this.#underlying as StreamSimple)(
                entry.model,
                entry.context,
                noWait(options),
            );
            const message = await stream.result();

            // Parked while it was on its way (turned off, or the payload hook found it Off): it stays parked.
            if (rejected) {
                if (interrupted()) {
                    return this.#resumeAfter(key, entry, abort);
                }

                if (this.#entries.get(key) === entry && entry.kind !== "parked") {
                    this.#drop(key, why("a refresh could not be sent"));
                }

                return;
            }

            // A request can cost money even when a new request or Stop superseded it.
            actual = message.usage.cost.total;
            await entry.account?.recordUsage(message);
            this.#warms++;
            this.#spent += message.usage.cost.total;
            entry.warms++;
            entry.spent += message.usage.cost.total;

            if (this.#entries.get(key) !== entry) {
                // Shutdown came while it was on its way: the next start must count this refresh against the caps.
                if (entry.keptSaved === true) {
                    this.#save(key, entry, false);
                }

                return;
            }

            const failed = message.stopReason === "error" || message.stopReason === "aborted";

            // Parked while it was on its way, and maybe turned on again: a refresh that read the cache keeps it alive
            // from now.
            if (interrupted()) {
                return this.#resumeAfter(
                    key,
                    entry,
                    abort,
                    !failed && message.usage.cacheRead > 0,
                    now,
                );
            }

            entry.abort = undefined;

            // The run ended while a tool-wait refresh was on its way: it counts as the entry's first idle refresh.
            if (entry.kind === "idle") {
                return this.#idleAfter(key, entry, entry.idle!, message, failed);
            }

            if (failed) {
                return this.#drop(key);
            }

            // The refresh read the cache, so it lives from now: keep warm, when the run ends, counts from here.
            entry.lastTouch = now;

            return this.#schedule(key, entry, delay);
        } catch (error) {
            this.#deps.log(
                `Cache keeper stopped for a session: ${error instanceof Error ? error.message : String(error)}`,
            );

            if (interrupted()) {
                this.#resumeAfter(key, entry, abort);
            } else if (this.#entries.get(key) === entry && entry.kind !== "parked") {
                this.#drop(key, why("a refresh failed"));
            }
        } finally {
            if (entry.abort === abort) {
                entry.abort = undefined;
            }

            const session = idle?.session ?? entry.idle?.session;

            if (session !== undefined) {
                this.#budgets.settle(session, reserved, actual);
                this.#saveBudgets();
            }

            if (entry.deadline !== undefined) {
                this.#deps.clearTimer(entry.deadline);
                entry.deadline = undefined;
            }
        }
    }

    /**
     * A refresh that was parked on its way has settled (`touched`: it read the cache at `now`). An entry turned on again
     * meanwhile plans its next refresh; one still parked expires from the new touch.
     */
    #resumeAfter(
        key: string,
        entry: Entry,
        abort: AbortController,
        touched = false,
        now = 0,
    ): void {
        if (entry.abort === abort) {
            entry.abort = undefined;
        }

        if (touched) {
            entry.lastTouch = now;
        }

        if (entry.kind === "idle") {
            this.#scheduleIdle(key, entry);
            this.#save(key, entry, false);
            this.#deps.changed?.(entry.conversationId!);
        } else if (touched && entry.kind === "parked") {
            this.#park(key, entry, this.#stopped.get(entry.conversationId!));
        }
    }

    /** After an idle refresh: count a failure (an error, or a cache write: the cache was gone), and plan the next. */
    #idleAfter(
        key: string,
        entry: Entry,
        idle: IdleState,
        message: AssistantMessage,
        failed: boolean,
    ): void {
        const now = this.#deps.now();
        const usage = message.usage;
        // It read nothing of a prompt it was billed for: the cache had expired, so this interval is too long for the
        // model. Anthropic reports the write; OpenAI and xAI bill the miss as plain input. No usage at all says nothing.
        const rewrote = !failed && usage.cacheRead === 0 && usage.cacheWrite + usage.input > 0;

        if (!failed && !rewrote) {
            idle.failures = 0;
            entry.lastTouch = now;
            this.#schedule(key, entry, idle.everyMs);
            this.#save(key, entry, false);
            this.#deps.changed?.(entry.conversationId!);

            return;
        }

        idle.failures++;

        if (idle.failures >= IDLE_FAILURES) {
            return this.#drop(
                key,
                rewrote
                    ? `the cache was already gone ${String(idle.failures)} times in a row: refresh this model more often`
                    : `${String(idle.failures)} refreshes in a row failed`,
            );
        }

        if (rewrote) {
            // The write made a new cache entry: it lives from now.
            entry.lastTouch = now;
            this.#schedule(key, entry, idle.everyMs);
        } else if (entry.lastTouch + idle.lifeMs - now > 2 * IDLE_RETRY_MS) {
            this.#schedule(key, entry, IDLE_RETRY_MS);
        } else {
            return this.#drop(key, "a refresh failed and the cache ran out");
        }

        this.#save(key, entry, false);
        this.#deps.changed?.(entry.conversationId!);
    }

    /** Stop warming one entry. `reason` (idle only) is kept for the app; `keepSaved` leaves it for the next start. */
    #drop(key: string, reason?: string, keepSaved = false): void {
        const entry = this.#entries.get(key);

        if (entry === undefined) {
            return;
        }

        if (entry.timer !== undefined) {
            this.#deps.clearTimer(entry.timer);
        }

        if (entry.deadline !== undefined) {
            this.#deps.clearTimer(entry.deadline);
        }

        // A diagnostic only: production requests also count in the conversation's usage and spend.
        if (entry.warms > 0) {
            this.#deps.log(
                `Cache keeper: ${String(entry.warms)} warm requests for ${entry.kind === "idle" ? "an idle session" : "one tool wait"}, $${entry.spent.toFixed(4)}${reason === undefined ? "" : ` (${reason})`}.`,
            );
        }

        entry.abort?.abort();
        this.#entries.delete(key);

        if (keepSaved) {
            entry.keptSaved = true;
        }

        if (entry.kind === "idle" && !keepSaved) {
            this.#deps.store?.delete(key);

            if (entry.conversationId !== undefined) {
                if (reason !== undefined) {
                    this.#stopped.set(entry.conversationId, reason);
                }

                this.#deps.changed?.(entry.conversationId);
            }
        }
    }
}
