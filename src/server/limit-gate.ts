/**
 * The limit gate: a model request that hits a limit waits for it to clear, then goes on, inside the same stream. Pi
 * Durable sees one slow request, not a failure. `install` wraps `models.streamSimple` (as `timing.ts` does), outside
 * the timing wrapper, so each attempt is measured on its own.
 *
 * A request that fails before any content, with a limit `classify` (`limits.ts`) says clears with time, opens a gate
 * for the limit's key: the sign-in for a limit that covers the account, the model for one that does not. Every
 * request that meets a closed gate waits, until the reset time (or a backoff when there is none). Then ONE request, the
 * canary, goes out. That is the real request: one the provider rejects costs nothing. When it gets content, the gate
 * opens and the others leave one by one, a second or more apart.
 *
 * Nothing here stores a wait as the truth. A restart replays the generation's request, which meets the limit again
 * and waits again; `provider-limits.json` only keeps the gates, so each waiting session does not send one rejected
 * request first. A lost or damaged file means no limit is known.
 *
 * It never spends beyond that, chooses no other model, and gives up (`refusing`) rather than wait for a reset too far
 * away, so a limit that does not clear ends the run as it does without this.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
    type Api,
    type AssistantMessage,
    type AssistantMessageEvent,
    type AssistantMessageEventStream,
    createAssistantMessageEventStream,
    type FetchFunction,
    type Model,
    type SimpleStreamOptions,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { classify, type ResponseFacts, responseFacts, type Scope, type Source } from "./limits.ts";

/** The adapters that send their requests through `options.fetch`, so the status and headers of a failure can be seen. */
const RECORDS_FETCH = new Set([
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "mistral-conversations",
    "pi-messages",
]);

/** A request made with this in its options never waits: it fails as it would without the gate (titles, summaries). */
export const NO_WAIT = Symbol("pocket.noWait");

/** `options`, marked so that its request does not wait for a limit. */
export function noWait<const T extends object>(options: T): T {
    return { ...options, [NO_WAIT]: true };
}

export type LimitTuning = {
    /** The soonest a wait ends, so a reset of "now" cannot make a loop. */
    minWaitMs: number;
    /** Added to a known reset, so many sessions do not meet it at the same second: from, to. */
    resetJitterMs: [number, number];
    /** The waits when no time is known, in order; the last repeats. */
    backoffMs: number[];
    /** The longest total wait for overloads when no time is known. */
    maxBackoffMs: number;
    /** The retry interval for an unknown-reset subscription limit, within the owner's wait budget. */
    subscriptionBackoffMs: number;
    /** Between the sessions a gate lets go after its canary got content: from, to. */
    spacingMs: [number, number];
    /** How long a gate that gave up fails requests at once. */
    refuseMs: number;
    /** Tries of one gate before it gives up. */
    maxTries: number;
    /** A wait this long (or longer) is told to the people in the session: a push. */
    longWaitMs: number;
    /** A canary out this long with no content no longer holds the others: the next waiter may go too. */
    canaryStallMs: number;
};

export const DEFAULT_TUNING: LimitTuning = {
    minWaitMs: 5_000,
    resetJitterMs: [5_000, 30_000],
    backoffMs: [15_000, 30_000, 60_000, 120_000, 300_000, 600_000],
    maxBackoffMs: 30 * 60_000,
    subscriptionBackoffMs: 15 * 60_000,
    spacingMs: [1_000, 5_000],
    refuseMs: 5 * 60_000,
    maxTries: 40,
    longWaitMs: 10 * 60_000,
    canaryStallMs: 2 * 60_000,
};

/** What a gate shows to the people whose runs wait at it. */
export type WaitView = {
    /** The gate's key: the same for every session that waits on it. */
    key: string;
    provider: string;
    /** The model, for a limit that is the model's. */
    modelId?: string;
    scope: Scope;
    /** `reset`: until a known time. `backoff`: no time is known. */
    kind: "reset" | "backoff";
    since: number;
    /** When the next request goes out (the canary). */
    until: number;
    /** The time the provider gave, when it gave one. */
    resetAt?: number;
    reason: string;
    tries: number;
    /** The canary is out now. */
    probing: boolean;
    /** The gate gave up: its requests fail at once, until `until`. */
    refusing?: true;
};

type Waiter = {
    sessionId?: string;
    conversationId?: number;
    provider: string;
    modelId: string;
    signal?: AbortSignal | undefined;
    /** When this waiter may leave, after the gate opened. */
    releaseAt?: number;
    /** Ends the waiter's nap now. */
    poke?: () => void;
    told: boolean;
    /**
     * When this request first met a limit, and how many limit failures it has had since: kept across every gate it
     * moves through, so a limit that changes scope does not start its wait again.
     */
    since?: number;
    tries: number;
    /** The gate this request is in the set of. */
    at?: Gate | undefined;
};

type Gate = {
    key: string;
    scope: Scope;
    provider: string;
    modelId?: string;
    kind: "reset" | "backoff";
    since: number;
    until: number;
    resetAt?: number;
    source?: Source;
    subscription?: true;
    reason: string;
    tries: number;
    state: "waiting" | "probing" | "refusing";
    /** What a request meeting a refusing gate fails with, and its second part (the reason it gave up). */
    refusal?: string;
    refusalWhy?: string;
    canary?: Waiter;
    /** When the canary went. */
    canarySince?: number;
    /** Sent by a person (Retry now), and when: a try each 30 seconds at most, and a failed one counts toward no cap. */
    manual?: boolean;
    manualAt?: number;
    waiters: Set<Waiter>;
    timer?: NodeJS.Timeout;
};

/** The least time between two manual tries of one gate. */
const MANUAL_GAP_MS = 30_000;

/** What the app gives the gate. */
export type GateDeps = {
    /** Hours to wait for a known reset at most; 0 turns the gate off. */
    hours: () => number;
    /**
     * How many sign-ins and sign-outs here the provider has had since this start. Only compared within one request: a
     * failure of a request sent before one is about the account that is gone, so it opens no gate.
     */
    epoch: (provider: string) => number;
    /** The conversation whose generation makes a request with this session id, if it is known. */
    conversationOf: (sessionId: string) => Promise<number | undefined> | number | undefined;
    /** A wait began, changed, or ended: tell the tabs. */
    changed: () => void;
    /** A wait of `longWaitMs` or more began for this conversation. */
    started?: (conversationId: number, view: WaitView) => void;
    log: (line: string) => void;
    /** Where the gates are kept between runs. */
    file?: string;
    tuning?: Partial<LimitTuning>;
    now?: () => number;
    random?: () => number;
};

type StreamSimple = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

const ZERO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Whether a stop signal fired (a function, so that a check after an await is not narrowed away). */
function isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

/**
 * What a gate tells everyone who waits at it, and the tabs and pushes: fixed wording by kind, never the provider's own
 * text, which can hold ids of another person's organisation.
 */
function describeLimit(verdict: { scope: Scope; reason: string }, provider: string): string {
    const names: Record<string, string> = {
        anthropic: "Claude",
        "openai-codex": "ChatGPT",
        openai: "OpenAI",
        "opencode-go": "OpenCode Go",
        openrouter: "OpenRouter",
    };
    const name = names[provider] ?? provider;

    if (verdict.scope === "account") {
        return `${name}'s usage limit`;
    }

    return /overload|unavailable|busy|\b5\d\d\b/i.test(verdict.reason)
        ? `${name} is overloaded`
        : `${name}'s rate limit`;
}

/** A span as people read it: `2 h 10 min`, `45 s`. */
export function span(ms: number): string {
    if (!Number.isFinite(ms) || ms > 1e12) {
        return "a very long time";
    }

    const seconds = Math.max(0, Math.round(ms / 1000));

    if (seconds < 90) {
        return `${seconds} s`;
    }

    const minutes = Math.round(seconds / 60);

    if (minutes < 90) {
        return `${minutes} min`;
    }

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;

    if (hours < 48) {
        return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
    }

    const days = Math.floor(hours / 24);

    return `${days} d ${hours % 24} h`;
}

/** A moment as text, in brackets, or nothing when it is not one a date can hold (a provider's huge number). */
const when = (at: number) =>
    Number.isFinite(at) && Math.abs(at) <= 8.64e15
        ? ` (${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC)`
        : "";

function failure(
    model: Model<Api>,
    started: number,
    stopReason: "error" | "aborted",
    errorMessage: string,
): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason,
        errorMessage,
        timestamp: started,
    };
}

export class LimitGate {
    readonly #deps: GateDeps;
    readonly #tuning: LimitTuning;
    readonly #gates = new Map<string, Gate>();
    readonly #now: () => number;
    readonly #random: () => number;

    constructor(deps: GateDeps) {
        this.#deps = deps;
        this.#tuning = { ...DEFAULT_TUNING, ...deps.tuning };
        this.#now = deps.now ?? Date.now;
        this.#random = deps.random ?? Math.random;
        this.#load();
    }

    // ─── What the app asks ──────────────────────────────────────────────────

    /** Wrap the runtime's `streamSimple` in place. Call it after the timing wrapper, so it is the outermost. */
    install(models: { streamSimple: StreamSimple }): void {
        const underlying = models.streamSimple.bind(models);

        models.streamSimple = (model, context, options) => {
            const marked = options as (SimpleStreamOptions & { [NO_WAIT]?: true }) | undefined;

            if (marked?.[NO_WAIT] === true) {
                const { [NO_WAIT]: _marked, ...rest } = marked;

                return underlying(model, context, rest);
            }

            if (this.#deps.hours() <= 0) {
                return underlying(model, context, options);
            }

            return this.#stream(underlying, model, context, options);
        };
    }

    /** The wait a conversation's run is in, if it is in one (not one a gate refuses). */
    waitFor(conversationId: number): WaitView | undefined {
        for (const gate of this.#gates.values()) {
            if (gate.state === "refusing") {
                continue;
            }

            for (const waiter of gate.waiters) {
                if (waiter.conversationId === conversationId) {
                    return this.#view(gate);
                }
            }
        }

        return undefined;
    }

    /** Every conversation in a wait, with its wait. */
    waits(): { conversationId: number; view: WaitView }[] {
        const out: { conversationId: number; view: WaitView }[] = [];

        for (const gate of this.#gates.values()) {
            if (gate.state === "refusing") {
                continue;
            }

            for (const waiter of gate.waiters) {
                if (waiter.conversationId !== undefined) {
                    out.push({ conversationId: waiter.conversationId, view: this.#view(gate) });
                }
            }
        }

        return out;
    }

    /** Send the canary of the gate this conversation waits at now, rather than at its time. False: it is in no wait. */
    retryNow(conversationId: number): boolean {
        for (const gate of this.#gates.values()) {
            if (gate.state === "refusing") {
                continue;
            }

            for (const waiter of gate.waiters) {
                if (waiter.conversationId === conversationId) {
                    const now = this.#now();

                    // The gate is shared by every session of the account, and anyone who may steer one session can press
                    // this: one manual try each 30 seconds, and none while a canary is out.
                    if (
                        gate.state !== "waiting" ||
                        now - (gate.manualAt ?? -Infinity) < MANUAL_GAP_MS
                    ) {
                        return false;
                    }

                    gate.until = now;
                    gate.manualAt = now;
                    // Its failure is not the limit's: it counts toward no cap, so pressing cannot make the gate give up.
                    gate.manual = true;
                    this.#poke(gate);
                    this.#save();
                    this.#deps.changed();

                    return true;
                }
            }
        }

        return false;
    }

    /** A sign-in or a sign-out: what a provider's gates knew is about an account that is gone. Its waiters go on. */
    reset(provider: string): void {
        for (const gate of [...this.#gates.values()]) {
            if (gate.provider === provider) {
                this.#open(gate, false);
            }
        }
    }

    /** Waiting was turned off: every gate goes, and what waited at it goes on at once. */
    releaseAll(): void {
        for (const gate of [...this.#gates.values()]) {
            this.#open(gate, false);
        }
    }

    /**
     * The owner changed how long runs wait: each waiting gate's time is cut to its new deadline, and one past it gives up.
     */
    reconsider(): void {
        const now = this.#now();

        for (const gate of [...this.#gates.values()]) {
            const deadline = this.#deadline(gate);

            if (gate.state === "refusing") {
                continue;
            }

            if (now >= deadline) {
                // Nobody waits at it (a stopped wait, or a restart): it stays, and `#closed` lets one canary go.
                if (gate.waiters.size === 0) {
                    continue;
                }

                this.#giveUp(gate, `it did not clear in ${span(now - gate.since)}`);
            } else if (gate.until > deadline) {
                gate.until = deadline;
                this.#poke(gate);
                this.#save();
                this.#deps.changed();
            }
        }
    }

    /** The gates now, for tests and the owner's log. */
    gates(): WaitView[] {
        return [...this.#gates.values()].map((gate) => this.#view(gate));
    }

    /** Stop every timer. */
    close(): void {
        for (const gate of this.#gates.values()) {
            clearTimeout(gate.timer);
        }
    }

    // ─── The stream ─────────────────────────────────────────────────────────

    #stream(
        underlying: StreamSimple,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
    ): AssistantMessageEventStream {
        const out = createAssistantMessageEventStream();

        void this.#run(underlying, model, context, options, out).catch((error: unknown) => {
            const message = failure(model, this.#now(), "error", String(error));

            out.push({ type: "error", reason: "error", error: message });
            out.end(message);
        });

        return out;
    }

    async #run(
        underlying: StreamSimple,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
        out: AssistantMessageEventStream,
    ): Promise<void> {
        const signal = options?.signal;
        const started = this.#now();
        const waiter: Waiter = {
            ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            provider: model.provider,
            modelId: model.id,
            signal,
            told: false,
            tries: 0,
        };

        const end = (message: AssistantMessage) => {
            out.push(
                message.stopReason === "aborted"
                    ? { type: "error", reason: "aborted", error: message }
                    : { type: "error", reason: "error", error: message },
            );
            out.end(message);
        };

        try {
            for (;;) {
                if (isAborted(signal)) {
                    return end(failure(model, started, "aborted", "Request was aborted"));
                }

                const gate = this.#closed(model);
                let canary: Gate | undefined;

                if (gate !== undefined) {
                    const turn = await this.#wait(gate, waiter);

                    if (turn === "aborted") {
                        return end(failure(model, started, "aborted", "Request was aborted"));
                    }

                    if (turn === "refuse") {
                        return end(failure(model, started, "error", gate.refusal ?? gate.reason));
                    }

                    if (turn === "go") {
                        continue;
                    }

                    canary = gate;
                }

                const epoch = this.#deps.epoch(model.provider);
                // The canary's first content opens its gate, while the answer still streams: the others need not wait for
                // the end of a long one.
                const attempt = await this.#attempt(
                    underlying,
                    model,
                    context,
                    options,
                    out,
                    () => {
                        if (canary !== undefined) {
                            this.#open(canary, true);
                        }
                    },
                );

                // However the attempt ended, the gate its request held as canary is settled by now or by `#leave`: none
                // stays probing with a canary that cannot finish it.
                if (attempt.type === "done") {
                    this.#leave(waiter);

                    return;
                }

                // The attempt failed before any content, and the failure is not an abort.
                const verdict = classify({
                    provider: model.provider,
                    message: attempt.message.errorMessage ?? "",
                    facts: attempt.facts,
                    now: this.#now(),
                    contextOverflow: isContextOverflow(attempt.message),
                });

                if (verdict.type === "other" || isAborted(signal)) {
                    this.#leave(waiter);
                    this.#flush(attempt, out);

                    return;
                }

                // Signed in or out meanwhile: the limit is the old account's. Try again with the new one.
                if (this.#deps.epoch(model.provider) !== epoch) {
                    this.#leave(waiter);

                    continue;
                }

                const gated = this.#limited(model, verdict, waiter, canary);

                this.#leave(waiter);

                if (gated.state === "refusing") {
                    // Gave up: this request fails with what the gate says.
                    this.#flush(attempt, out, `${verdict.reason} ${gated.refusalWhy}`);

                    return;
                }
            }
        } finally {
            this.#leave(waiter);
        }
    }

    /**
     * One request, forwarded as it comes. Its first events (the empty `start`) are held until content shows, so that a
     * failure leaves nothing behind it: the consumer then sees one request. `done`: the stream ended (content, or an
     * error after it, or an abort). `failed`: an error before any content.
     */
    async #attempt(
        underlying: StreamSimple,
        model: Model<Api>,
        context: TranscriptContext,
        options: SimpleStreamOptions | undefined,
        out: AssistantMessageEventStream,
        onContent: () => void,
    ): Promise<
        | { type: "done"; content: boolean }
        | {
              type: "failed";
              message: AssistantMessage;
              held: AssistantMessageEvent[];
              facts: ResponseFacts | undefined;
          }
    > {
        let facts: ResponseFacts | undefined;
        const base: FetchFunction | undefined = options?.fetch;

        const recording: FetchFunction = async (input, init) => {
            const response = await (base ?? globalThis.fetch)(input, init);

            facts = responseFacts(response.status, response.headers);

            return response;
        };

        // Only the adapters that take a fetch get ours: the Google ones refuse any other than the global one.
        const stream = underlying(
            model,
            context,
            RECORDS_FETCH.has(model.api) ? { ...options, fetch: recording } : options,
        );
        const held: AssistantMessageEvent[] = [];
        let flowing = false;
        let terminal: AssistantMessage | undefined;

        try {
            for await (const event of stream) {
                if (event.type === "error") {
                    terminal = event.error;

                    // Before content, a failure is held back: the gate decides whether the consumer ever sees it.
                    if (flowing || terminal.stopReason === "aborted") {
                        out.push(event);
                    }
                } else if (event.type === "done") {
                    terminal = event.message;

                    if (!flowing) {
                        flowing = true;
                        onContent();
                    }

                    for (const earlier of held.splice(0)) {
                        out.push(earlier);
                    }

                    out.push(event);
                } else if (flowing) {
                    out.push(event);
                } else if (event.partial.content.length === 0) {
                    held.push(event);
                } else {
                    flowing = true;
                    onContent();

                    for (const earlier of held.splice(0)) {
                        out.push(earlier);
                    }

                    out.push(event);
                }
            }

            terminal ??= await stream.result();
        } catch (error) {
            terminal = failure(model, this.#now(), "error", String(error));
        }

        if (flowing || terminal.stopReason !== "error") {
            out.end(terminal);

            return { type: "done", content: flowing };
        }

        return { type: "failed", message: terminal, held, facts };
    }

    /** End the consumer's stream with a failed attempt as it was, or with `text` in place of its error. */
    #flush(
        attempt: { message: AssistantMessage; held: AssistantMessageEvent[] },
        out: AssistantMessageEventStream,
        text?: string,
    ): void {
        const message =
            text === undefined ? attempt.message : { ...attempt.message, errorMessage: text };

        for (const event of attempt.held) {
            out.push(event);
        }

        out.push({ type: "error", reason: "error", error: message });
        out.end(message);
    }

    // ─── Gates ──────────────────────────────────────────────────────────────

    // The key has no sign-in in it: a token changes at each renewal, and a counter starts again at each start, so
    // neither could name the account across a wait or a restart. A sign-in or sign-out here drops the provider's
    // gates (`reset`), and `#run` ignores a failure of a request sent before one.
    #accountKey(provider: string): string {
        return provider;
    }

    #modelKey(provider: string, modelId: string): string {
        return `${provider}/${modelId}`;
    }

    /** When a wait that began at `since` must end: the owner's maximum for a known reset, less for load with no time. */
    #deadline(gate: Gate): number {
        const maxReset = this.#deps.hours() * 3_600_000;

        return (
            gate.since +
            (gate.kind === "reset" || gate.subscription
                ? maxReset
                : Math.min(this.#tuning.maxBackoffMs, maxReset))
        );
    }

    /** The closed gate a request for this model meets: its account's first, then its model's. */
    #closed(model: Model<Api>): Gate | undefined {
        const keys = [this.#accountKey(model.provider), this.#modelKey(model.provider, model.id)];

        for (const key of keys) {
            const gate = this.#gates.get(key);

            if (gate === undefined) {
                continue;
            }

            // A gate nobody waits at, past its deadline (stopped waits, or one kept from before a restart): the limit may
            // have cleared long ago, so it does not refuse. It lets one request go as canary now, and keeps its first
            // time: a canary that meets the limit again finds the deadline passed and gives up, so it is no new wait.
            if (
                gate.waiters.size === 0 &&
                gate.state === "waiting" &&
                this.#now() >= this.#deadline(gate)
            ) {
                gate.until = Math.min(gate.until, this.#now());
            }

            return gate;
        }

        return undefined;
    }

    /**
     * A request failed on a limit: open the gate of its key (or move it on), and say when the next try is. A gate that
     * gives up (`refusing`) says no wait is worth it.
     */
    #limited(
        model: Model<Api>,
        verdict: Extract<ReturnType<typeof classify>, { type: "limit" }>,
        waiter: Waiter,
        held: Gate | undefined,
    ): Gate {
        const tuning = this.#tuning;
        const now = this.#now();

        waiter.since ??= now;

        const key =
            verdict.scope === "account"
                ? this.#accountKey(model.provider)
                : this.#modelKey(model.provider, model.id);
        // The gate this request held as canary: its failure settles that gate, whichever scope it now reads.
        const owned = held?.canary === waiter ? held : undefined;

        // The scope moved (an overload, then a plan's usage limit): the old gate closes now, and its waiters go on
        // to the new one. It must not stay probing with a canary that is no longer there.
        if (owned !== undefined && owned.key !== key) {
            this.#open(owned, true);
        }

        // A try a person sent (Retry now) counts toward no cap: pressing it cannot make the shared gate give up.
        const manual = owned?.manual === true;

        if (!manual) {
            waiter.tries++;
        }

        if (owned !== undefined) {
            delete owned.manual;
        }

        let gate = this.#gates.get(key);

        // A failure of a request that was out before the gate closed (or before this canary went) says nothing about
        // the canary: it must not free the canary or move the state. It can only move the time on, when its reset is
        // later, and only to a time within the deadline.
        if (gate !== undefined && gate !== owned) {
            if (verdict.subscription) {
                gate.subscription = true;
                this.#save();
            }

            if (gate.state !== "refusing" && verdict.resetAt !== undefined) {
                const jitter =
                    tuning.resetJitterMs[0] +
                    this.#random() * (tuning.resetJitterMs[1] - tuning.resetJitterMs[0]);
                const later = Math.max(verdict.resetAt + jitter, now + tuning.minWaitMs);
                const far = this.#tooFar(verdict, gate.since, later, now);

                // A window of days, or a reset past the longest wait: the account is blocked for good, whoever found it
                // first. The gate refuses now, and its waiters fail with the reset.
                if (far !== undefined) {
                    this.#giveUp(gate, far);

                    return gate;
                }

                if (later > gate.until) {
                    gate.until = later;
                    gate.kind = "reset";
                    gate.resetAt = verdict.resetAt;
                    gate.reason = describeLimit(verdict, model.provider);
                    this.#poke(gate);
                    this.#save();
                    this.#deps.changed();
                }
            }

            return gate;
        }

        if (gate === undefined) {
            gate = {
                key,
                scope: verdict.scope,
                provider: model.provider,
                ...(verdict.scope === "model" ? { modelId: model.id } : {}),
                kind: "backoff",
                // The wait is the request's as well as the gate's: a gate made as the scope moves takes the earlier time.
                since: Math.min(now, waiter.since, owned?.since ?? now),
                until: now,
                reason: describeLimit(verdict, model.provider),
                tries: 0,
                state: "waiting",
                waiters: new Set(),
            };
            this.#gates.set(key, gate);
            // The provider's own text can hold ids of someone else's organisation: only the owner's log has it.
            this.#deps.log(`Limit at ${key}: ${verdict.reason}`);
        }

        if (!manual) {
            gate.tries++;
        }

        gate.since = Math.min(gate.since, waiter.since);
        gate.reason = describeLimit(verdict, model.provider);
        gate.canary = undefined;

        if (verdict.subscription) {
            gate.subscription = true;
        }

        // One deadline for the whole wait, from when the gate closed: a reset after it, or a backoff that comes to it,
        // gives up. A new reset does not start the wait again.
        const maxReset = this.#deps.hours() * 3_600_000;
        let until: number;
        let why: string | undefined;

        if (verdict.resetAt !== undefined) {
            const jitter =
                tuning.resetJitterMs[0] +
                this.#random() * (tuning.resetJitterMs[1] - tuning.resetJitterMs[0]);

            until = Math.max(verdict.resetAt + jitter, now + tuning.minWaitMs);
            gate.kind = "reset";
            gate.resetAt = verdict.resetAt;

            if (verdict.source !== undefined) {
                gate.source = verdict.source;
            }

            why = this.#tooFar(verdict, gate.since, until, now);
        } else {
            const total = gate.subscription ? maxReset : Math.min(tuning.maxBackoffMs, maxReset);
            const deadline = gate.since + total;
            // No tries are counted yet when a manual try moved the scope: the first delay.
            const step = Math.max(0, Math.min(gate.tries - 1, tuning.backoffMs.length - 1));
            const delay =
                (gate.subscription ? tuning.subscriptionBackoffMs : tuning.backoffMs[step]!) *
                (0.8 + this.#random() * 0.4);

            // The last try is at the deadline, not after it.
            until = Math.min(now + Math.max(delay, tuning.minWaitMs), deadline);
            gate.kind = "backoff";
            delete gate.resetAt;
            delete gate.source;

            if (now >= deadline) {
                why = `it did not clear in ${span(now - gate.since)}`;
            }
        }

        if (
            why === undefined &&
            !gate.subscription &&
            Math.max(gate.tries, waiter.tries) > tuning.maxTries
        ) {
            why = `it did not clear after ${tuning.maxTries} tries`;
        }

        if (why !== undefined) {
            this.#giveUp(gate, why);

            return gate;
        }

        // Always a time: a number that is not one would end every nap at once.
        gate.until = Number.isFinite(until) ? until : now + tuning.minWaitMs;
        gate.state = "waiting";
        this.#poke(gate);
        this.#save();
        this.#deps.changed();

        return gate;
    }

    /**
     * Why a limit's reset is not waited for, if it is not: a window of days, or after the owner's longest wait, counted
     * from when the gate closed (`since`). Undefined: it can be waited for.
     */
    #tooFar(
        verdict: Extract<ReturnType<typeof classify>, { type: "limit" }>,
        since: number,
        until: number,
        now: number,
    ): string | undefined {
        if (verdict.resetAt === undefined) {
            return undefined;
        }

        const maxReset = this.#deps.hours() * 3_600_000;
        const resets = `it resets in ${span(verdict.resetAt - now)}${when(verdict.resetAt)}`;

        if (verdict.long) {
            return `${resets}, a limit of days that Pi Pocket does not wait for`;
        }

        return until > since + maxReset
            ? `${resets}, and Pi Pocket waits at most ${span(maxReset)}`
            : undefined;
    }

    /**
     * A gate that will not wait: its requests fail at once, with `why`, for a few minutes. What the others are told is
     * the gate's fixed wording, never the provider's own text (`#run` gives the request that met it its own).
     */
    #giveUp(gate: Gate, why: string): void {
        gate.state = "refusing";
        gate.refusalWhy = `Not waiting: ${why}.`;
        gate.refusal = `${gate.reason}. ${gate.refusalWhy}`;
        gate.canary = undefined;
        gate.until = this.#now() + this.#tuning.refuseMs;
        clearTimeout(gate.timer);
        gate.timer = setTimeout(() => this.#drop(gate), this.#tuning.refuseMs);
        gate.timer.unref();
        this.#deps.log(`Limit at ${gate.key}: ${gate.refusal}`);
        this.#poke(gate);
        this.#save();
        this.#deps.changed();
    }

    /** The canary got content, or a sign-in changed: the gate goes, and its waiters leave one by one. */
    #open(gate: Gate, spaced: boolean): void {
        if (this.#gates.get(gate.key) !== gate) {
            return;
        }

        const [from, to] = this.#tuning.spacingMs;
        let at = this.#now();

        for (const waiter of gate.waiters) {
            if (spaced && waiter !== gate.canary) {
                at += from + this.#random() * (to - from);
                waiter.releaseAt = at;
            }
        }

        this.#drop(gate);
    }

    /** The canary failed for another reason than a limit, or was stopped: the next waiter may try. */
    #free(gate: Gate, waiter: Waiter): void {
        if (gate.canary === waiter) {
            gate.canary = undefined;
            // The manual try it was ended some other way: the next, automatic one is not manual.
            delete gate.manual;

            // A gate that is gone has let its waiters go: waking them now would end their spacing.
            if (this.#gates.get(gate.key) !== gate) {
                return;
            }

            if (gate.state === "probing") {
                gate.state = "waiting";
            }

            this.#poke(gate);
            this.#deps.changed();
        }
    }

    /** Take a gate away, and wake whoever waits at it. */
    #drop(gate: Gate): void {
        clearTimeout(gate.timer);

        if (this.#gates.get(gate.key) === gate) {
            this.#gates.delete(gate.key);
        }

        this.#poke(gate);
        this.#save();
        this.#deps.changed();
    }

    #poke(gate: Gate): void {
        for (const waiter of gate.waiters) {
            waiter.poke?.();
        }
    }

    // ─── Waiting ────────────────────────────────────────────────────────────

    /**
     * Wait at `gate` until this request may go. `canary`: it is the one that goes first, to find out. `go`: the gate is
     * open or gone, look again. `refuse`: the gate gave up. `aborted`: the run was stopped.
     */
    async #wait(gate: Gate, waiter: Waiter): Promise<"canary" | "go" | "refuse" | "aborted"> {
        gate.waiters.add(waiter);
        waiter.at = gate;
        this.#tell(gate, waiter);

        let turn: "canary" | "go" | "refuse" | "aborted" | undefined;

        try {
            for (;;) {
                if (isAborted(waiter.signal)) {
                    return (turn = "aborted");
                }

                if (this.#gates.get(gate.key) !== gate) {
                    // Open: leave at the time the gate gave this request.
                    const left = (waiter.releaseAt ?? 0) - this.#now();

                    if (left > 0) {
                        await this.#nap(left, waiter);

                        if (isAborted(waiter.signal)) {
                            return (turn = "aborted");
                        }
                    }

                    delete waiter.releaseAt;

                    return (turn = "go");
                }

                if (gate.state === "refusing") {
                    return (turn = "refuse");
                }

                const left = gate.until - this.#now();

                if (left > 0) {
                    await this.#nap(left, waiter);

                    continue;
                }

                // Free, or out so long with no content that it no longer holds the others: this one goes.
                const stalled = (gate.canarySince ?? 0) + this.#tuning.canaryStallMs - this.#now();

                if (gate.canary === undefined || stalled <= 0) {
                    gate.canary = waiter;
                    gate.canarySince = this.#now();
                    gate.state = "probing";
                    this.#deps.changed();

                    return (turn = "canary");
                }

                // Someone else is finding out: look again when that ends, or when it has been out too long.
                await this.#nap(Math.min(30_000, stalled), waiter);
            }
        } finally {
            // The canary stays in the gate while its request is out: people see it probe.
            if (turn !== "canary") {
                this.#leave(waiter);
            }
        }
    }

    /** Sleep `ms`, until poked, or until the run is stopped. */
    #nap(ms: number, waiter: Waiter): Promise<void> {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                waiter.signal?.removeEventListener("abort", done);
                delete waiter.poke;
                resolve();
            };

            // A timer holds at most 2^31 - 1 ms: longer waits come round again (the callers look at the clock).
            const timer = setTimeout(done, Math.min(ms, 2 ** 31 - 1));

            timer.unref();
            waiter.poke = done;
            waiter.signal?.addEventListener("abort", done, { once: true });
        });
    }

    /** The request is no longer at its gate: it goes on, or is done. */
    #leave(waiter: Waiter): void {
        delete waiter.poke;

        const gate = waiter.at;

        if (gate === undefined) {
            return;
        }

        delete waiter.at;
        gate.waiters.delete(waiter);

        // Whatever the reason it leaves, a gate does not stay probing for a canary that is gone.
        this.#free(gate, waiter);

        this.#deps.changed();
    }

    /** Find the conversation of a waiting request, once, and tell the people of a long wait. */
    #tell(gate: Gate, waiter: Waiter): void {
        this.#deps.changed();

        if (waiter.told || waiter.sessionId === undefined) {
            return;
        }

        waiter.told = true;

        void Promise.resolve(this.#deps.conversationOf(waiter.sessionId)).then(
            (conversationId) => {
                if (conversationId === undefined) {
                    return;
                }

                waiter.conversationId = conversationId;
                this.#deps.changed();

                if (
                    gate.until - this.#now() >= this.#tuning.longWaitMs &&
                    gate.waiters.has(waiter)
                ) {
                    this.#deps.started?.(conversationId, this.#view(gate));
                }
            },
            () => {},
        );
    }

    #view(gate: Gate): WaitView {
        return {
            key: gate.key,
            provider: gate.provider,
            ...(gate.modelId === undefined ? {} : { modelId: gate.modelId }),
            scope: gate.scope,
            kind: gate.kind,
            since: gate.since,
            until: gate.until,
            ...(gate.resetAt === undefined ? {} : { resetAt: gate.resetAt }),
            reason: gate.reason,
            tries: gate.tries,
            probing: gate.state === "probing",
            ...(gate.state === "refusing" ? { refusing: true as const } : {}),
        };
    }

    // ─── The file ───────────────────────────────────────────────────────────

    #save(): void {
        const file = this.#deps.file;

        if (file === undefined) {
            return;
        }

        // A refusal is kept with its end (`until`), so a restart does not give the same limit a new wait.
        const gates = [...this.#gates.values()].map((gate) => ({
            state: gate.state === "refusing" ? "refusing" : "waiting",
            refusal: gate.refusal,
            key: gate.key,
            scope: gate.scope,
            provider: gate.provider,
            modelId: gate.modelId,
            kind: gate.kind,
            since: gate.since,
            until: gate.until,
            resetAt: gate.resetAt,
            source: gate.source,
            subscription: gate.subscription,
            reason: gate.reason,
            tries: gate.tries,
        }));

        try {
            writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, gates }), { mode: 0o600 });
            renameSync(`${file}.tmp`, file);
        } catch (error) {
            this.#deps.log(`Provider limits not saved: ${String(error)}`);
        }
    }

    /** Read the gates kept by the last run. A missing, unreadable, or odd file means no limit is known. */
    #load(): void {
        const file = this.#deps.file;

        if (file === undefined) {
            return;
        }

        let text: string;

        try {
            text = readFileSync(file, "utf8");
        } catch {
            return;
        }

        try {
            const saved = JSON.parse(text) as { version?: unknown; gates?: unknown };

            if (saved.version !== 1 || !Array.isArray(saved.gates)) {
                return;
            }

            const now = this.#now();

            for (const each of saved.gates.slice(0, 200) as Record<string, unknown>[]) {
                const gate = this.#restored(each, now);

                if (gate !== undefined) {
                    this.#gates.set(gate.key, gate);
                }
            }
        } catch (error) {
            this.#deps.log(`Provider limits file ignored: ${String(error)}`);
        }
    }

    #restored(each: Record<string, unknown>, now: number): Gate | undefined {
        const text = (value: unknown, max = 300) =>
            typeof value === "string" && value.length <= max ? value : undefined;
        const number = (value: unknown) =>
            typeof value === "number" && Number.isFinite(value) ? value : undefined;
        const key = text(each.key, 200);
        const provider = text(each.provider, 100);
        const since = number(each.since);
        const until = number(each.until);
        const tries = number(each.tries);

        if (
            key === undefined ||
            provider === undefined ||
            since === undefined ||
            until === undefined ||
            tries === undefined ||
            (each.scope !== "account" && each.scope !== "model") ||
            (each.kind !== "reset" && each.kind !== "backoff") ||
            // Waiting is off, or the file is from long ago (or from a clock that was wrong): it says nothing now.
            this.#deps.hours() <= 0 ||
            since > now + 60_000 ||
            since < now - 7 * 86_400_000 ||
            // No wait lasts more than a day: a time past that is a damaged or hostile file.
            until > since + 25 * 3_600_000
        ) {
            return undefined;
        }

        const modelId = text(each.modelId, 200);
        const resetAt = number(each.resetAt);

        // A key other than the one its scope gives (a file from another version) holds nothing.
        if (key !== (each.scope === "account" ? provider : `${provider}/${modelId ?? ""}`)) {
            return undefined;
        }

        const source = each.source === "header" || each.source === "body" || each.source === "text";
        const refusing = each.state === "refusing";

        // A refusal that ended while the server was down holds nothing.
        if (refusing && until <= now) {
            return undefined;
        }

        const gate: Gate = {
            key,
            scope: each.scope,
            provider,
            ...(modelId === undefined ? {} : { modelId }),
            kind: each.kind,
            since,
            until,
            ...(resetAt === undefined ? {} : { resetAt }),
            ...(source ? { source: each.source as Source } : {}),
            ...(each.subscription === true ? { subscription: true as const } : {}),
            reason: text(each.reason) ?? "",
            tries,
            state: refusing ? "refusing" : "waiting",
            waiters: new Set(),
        };

        if (refusing) {
            gate.refusal = text(each.refusal, 700) ?? gate.reason;
            gate.timer = setTimeout(() => this.#drop(gate), until - now);
            gate.timer.unref();
        } else if (now >= this.#deadline(gate)) {
            // The wait ran out while the server was down: the limit may have cleared. One request goes as canary at
            // once, and the first time is kept, so a canary that meets the limit again gives up (see `#closed`).
            gate.until = Math.min(gate.until, now);
        }

        return gate;
    }
}
