/** Observation-only cache expiry pilot. It never sends a request or changes a conversation. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PocketApp } from "./app.ts";
import { contextTokens, tokensSinceCompaction } from "./pip-compact.ts";

/** Only native Anthropic requests with explicit conversation breakpoints have a pilot deadline. */
export function cacheTtlMs(model: Model<Api>, payload: unknown): number | undefined {
    if (model.api !== "anthropic-messages") {
        return undefined;
    }

    try {
        if (new URL(model.baseUrl).origin !== "https://api.anthropic.com") {
            return undefined;
        }
    } catch {
        return undefined;
    }

    const request = record(payload);
    const messages = request?.messages;

    if (request?.model !== model.id || !Array.isArray(messages) || messages.length === 0) {
        return undefined;
    }

    const content = record(messages.at(-1))?.content;

    // A cached system alone does not establish a conversation cache deadline.
    if (!Array.isArray(content) || record(content.at(-1))?.cache_control === undefined) {
        return undefined;
    }

    const blocks = [
        request,
        ...(Array.isArray(request.system) ? request.system : []),
        ...(Array.isArray(request.tools) ? request.tools : []),
        ...messages.flatMap((message) => {
            const parts = record(message)?.content;

            return Array.isArray(parts) ? parts : [];
        }),
    ];
    const lifetimes: number[] = [];

    for (const block of blocks) {
        const control = record(block)?.cache_control;

        if (control === undefined) {
            continue;
        }

        const value = record(control);
        const ttl = value?.ttl ?? "5m";
        const seconds = ttl === "5m" ? 300 : ttl === "1h" ? 3600 : undefined;
        const advertised = model.promptCache?.[ttl === "1h" ? "long" : "short"];

        if (value?.type !== "ephemeral" || seconds === undefined || advertised !== seconds) {
            return undefined;
        }

        lifetimes.push(seconds * 1000);
    }

    // Mixed lifetimes use the earliest possible expiry, not the system prompt's longer lifetime.
    return lifetimes.length === 0 ? undefined : Math.min(...lifetimes);
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

export type CacheAssessment = {
    reason: string;
    contextTokens?: number;
    keepRecentTokens?: number;
    reserveTokens?: number;
};

/** Inspect effective policy and current context without creating a compaction task. */
export async function assessCacheContext(
    app: PocketApp,
    id: ConversationId,
    model: Model<Api>,
): Promise<CacheAssessment> {
    if (
        app.sessionMeta(id) === undefined ||
        app.pip.ownerOf(id) !== undefined ||
        app.parentOf(id) !== undefined
    ) {
        return { reason: "unsupported conversation" };
    }

    if (app.isBusy(id) || app.isCompacting(id)) {
        return { reason: "conversation busy" };
    }

    if (app.config.compactIdleHours === 0) {
        return { reason: "idle compaction disabled" };
    }

    const state = await app.agentState(id);

    if (state?.model?.provider !== model.provider || state.model.modelId !== model.id) {
        return { reason: "model changed" };
    }

    const policy = app.settings.getCompactionSettings(model);

    if (
        !policy.enabled ||
        policy.keepRecentTokens === undefined ||
        policy.reserveTokens === undefined
    ) {
        return { reason: "compaction disabled or policy unknown" };
    }

    if (app.spend.heldBack(id) !== undefined) {
        return { reason: "budget limit" };
    }

    const view = await (await app.conversation(id)).context(BACKGROUND_CONTEXT);
    const tokens = contextTokens(view);
    const enough = tokens > policy.keepRecentTokens + 4096 && tokensSinceCompaction(view) >= 4096;

    return {
        reason: enough
            ? "context candidate; economics and prefix reuse still need verification"
            : "too little removable context or regrowth",
        contextTokens: tokens,
        keepRecentTokens: policy.keepRecentTokens,
        reserveTokens: policy.reserveTokens,
    };
}

type Deps = {
    conversationOf: (sessionId: string) => Promise<number | undefined>;
    assess: (id: number, model: Model<Api>) => Promise<CacheAssessment>;
    log: (line: string) => void;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};
type Entry = {
    startedAt: number;
    conversation: Promise<number | undefined>;
    ttlMs?: number;
    timer?: ReturnType<typeof setTimeout>;
};

export class CacheExpiryPilot {
    readonly #deps: Required<Deps>;
    readonly #entries = new Map<string, Entry>();
    #closed = false;

    constructor(deps: Deps) {
        this.#deps = {
            now: Date.now,
            setTimer: (fn, ms) => {
                const timer = setTimeout(fn, ms);

                timer.unref();

                return timer;
            },
            clearTimer: clearTimeout,
            ...deps,
        };
    }

    /** Install innermost, before request shaping, to inspect the final adapter payload. */
    install(models: Pick<ModelRuntime, "streamSimple">): void {
        const underlying = models.streamSimple.bind(models);

        models.streamSimple = (model, context, options) => {
            const key = options?.sessionId;

            if (this.#closed || key === undefined) {
                return underlying(model, context, options);
            }

            this.#drop(key);

            const entry: Entry = {
                startedAt: this.#deps.now(),
                // Resolve while the run still owns its provider session, not after the run ends.
                conversation: this.#deps.conversationOf(key).catch(() => undefined),
            };

            this.#entries.set(key, entry);

            const stream = underlying(model, context, {
                ...options,
                onPayload: async (payload, payloadModel) => {
                    const shaped = await options?.onPayload?.(payload, payloadModel);

                    entry.ttlMs = cacheTtlMs(payloadModel, shaped ?? payload);

                    return shaped;
                },
            });

            void stream
                .result()
                .then(
                    (message) => this.#observe(key, entry, model, message),
                    () => this.#skip(key, entry, "request failed"),
                )
                .catch(() => this.#skip(key, entry, "observation failed"));

            return stream;
        };
    }

    close(): void {
        this.#closed = true;

        for (const key of this.#entries.keys()) {
            this.#drop(key);
        }
    }

    #drop(key: string): void {
        const entry = this.#entries.get(key);

        if (entry?.timer !== undefined) {
            this.#deps.clearTimer(entry.timer);
        }

        this.#entries.delete(key);
    }

    #skip(key: string, entry: Entry, reason: string): void {
        if (this.#closed || this.#entries.get(key) !== entry) {
            return;
        }

        this.#drop(key);
        this.#log({ event: "skipped", reason });
    }

    #log(value: object): void {
        this.#deps.log(`[cache-expiry-pilot] ${JSON.stringify(value)}`);
    }

    async #observe(
        key: string,
        entry: Entry,
        model: Model<Api>,
        message: AssistantMessage,
    ): Promise<void> {
        const id = await entry.conversation;

        if (this.#closed || this.#entries.get(key) !== entry) {
            return;
        }

        const { input, output, cacheRead, cacheWrite } = message.usage;
        const usageValid = [input, output, cacheRead, cacheWrite].every(
            (tokens) => Number.isFinite(tokens) && tokens >= 0,
        );

        if (
            id === undefined ||
            entry.ttlMs === undefined ||
            !usageValid ||
            cacheRead + cacheWrite <= 0 ||
            message.stopReason === "error" ||
            message.stopReason === "aborted"
        ) {
            return this.#skip(key, entry, "no supported, successful cache observation");
        }

        const estimatedExpiresAt = entry.startedAt + entry.ttlMs;
        const decisionAt = entry.startedAt + entry.ttlMs * 0.9;

        if (this.#deps.now() >= decisionAt) {
            return this.#skip(key, entry, "response arrived after the decision deadline");
        }

        const evidence = {
            conversationId: id,
            provider: model.provider,
            model: model.id,
            startedAt: entry.startedAt,
            ttlMs: entry.ttlMs,
            estimatedExpiresAt,
            decisionAt,
            cacheRead,
            cacheWrite,
            input,
            output,
            expiry: "inferred, not guaranteed",
            coverage: "reported cached input; full conversation coverage is unverified",
        };

        this.#log({ event: "observed", ...evidence });
        entry.timer = this.#deps.setTimer(() => {
            void (async () => {
                if (this.#closed || this.#entries.get(key) !== entry) {
                    return;
                }

                // A late timer must not become a cold catch-up job after sleep or suspension.
                const latest = decisionAt + (estimatedExpiresAt - decisionAt) / 2;

                if (this.#deps.now() > latest || this.#deps.now() < decisionAt) {
                    return this.#skip(key, entry, "missed decision window or clock changed");
                }

                const assessment = await this.#deps.assess(id, model);

                if (this.#closed || this.#entries.get(key) !== entry) {
                    return;
                }

                if (this.#deps.now() > latest || this.#deps.now() < decisionAt) {
                    return this.#skip(key, entry, "assessment missed the decision window");
                }

                this.#drop(key);
                this.#log({
                    event: "decision",
                    ...evidence,
                    ...assessment,
                    action: "observe-only",
                    economics: "not validated; no savings claim or spend authorization",
                });
            })().catch(() => this.#skip(key, entry, "assessment failed"));
        }, decisionAt - this.#deps.now());
    }
}
