/** Published cache lifetimes and prices, with a short-lived index of Pi's model list. */
import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Cache lifetimes in minutes that makers publish and Pi's list leaves out, by bare model id, as written in their docs
 * (2026-11-02): OpenAI's default tier keeps a prompt at least 30 minutes. xAI publishes none for Grok.
 */
const PUBLISHED_LIFETIMES: readonly [RegExp, number][] = [[/^gpt-/, 30]];

/**
 * The cache tier a request asks for: its `cacheRetention`, else Pi's `PI_CACHE_RETENTION` (the request's `env`, then
 * the server's). Without options: the tier requests use by default.
 */
export function cacheTier(options?: {
    cacheRetention?: string;
    env?: Record<string, string | undefined>;
}): "none" | "short" | "long" {
    if (options?.cacheRetention === "none") {
        return "none";
    }

    return options?.cacheRetention === "long" ||
        (options?.cacheRetention === undefined &&
            (options?.env?.PI_CACHE_RETENTION ?? process.env.PI_CACHE_RETENTION) === "long")
        ? "long"
        : "short";
}

/** The tier used for cache facts; no cache counts as short. Without options, use the request default. */
export function factsTier(options?: Parameters<typeof cacheTier>[0]): "short" | "long" {
    return cacheTier(options) === "long" ? "long" : "short";
}

/** Providers that make the models they list: their published prices win over a reseller's or a cloud's. */
const MAKERS = new Set(["anthropic", "openai", "xai", "google", "mistral", "deepseek"]);

/** The last part of a model id, which a reseller's id (`cc/claude-opus-5-5`) shares with the maker's. */
const bareId = (id: string) => id.slice(id.lastIndexOf("/") + 1).toLowerCase();

/** A cache lifetime in minutes a maker publishes for this model, when Pi's list has none. */
export function publishedLifetime(id: string): number | undefined {
    const bare = bareId(id);

    return PUBLISHED_LIFETIMES.find(([pattern]) => pattern.test(bare))?.[1];
}

/** What a cache write costs per million tokens for its lifetime. */
function writePrice(model: Model<Api>, seconds: number | undefined): number {
    const { input, cacheWrite } = model.cost;
    const hourWrite = model.api === "anthropic-messages" && (seconds ?? 0) >= 3600;

    return hourWrite ? input * 2 : cacheWrite > 0 ? cacheWrite : input;
}

/**
 * The worst prompt price per million tokens for a refresh: a cache miss at the request's tier, or at `lifetime` seconds
 * when the cache is known to live that long (an owner's lifetime for a model Pi lists none for).
 */
export function missPrice(
    model: Model<Api>,
    options?: Parameters<typeof cacheTier>[0],
    lifetime?: number,
): number {
    const tier = cacheTier(options);
    const seconds = lifetime ?? (tier === "none" ? undefined : model.promptCache?.[tier]);

    return Math.max(writePrice(model, seconds), model.cost.cacheRead);
}

/**
 * A model's published cache prices per million tokens, for Break-even's stop only: the read, and what a miss costs (the
 * write). Anthropic's 1-hour write is twice the input price, where Pi's price is the 5-minute write; a maker with no
 * write price (OpenAI, xAI) charges the plain input price. Undefined: not published.
 */
export function cachePrices(
    model: Model<Api>,
    seconds: number | undefined,
    read = model.cost.cacheRead,
): { read: number; write: number } | undefined {
    if (read <= 0 || model.cost.input <= 0) {
        return undefined;
    }

    return { read, write: writePrice(model, seconds) };
}

/** Pi's models with published cache prices, by bare id. */
export class PublishedPrices {
    readonly #models: () => Model<Api>[];
    /** Pi's models with published cache prices, by bare id; built again a minute later, as model lists change rarely. */
    #publishedIndex: { at: number; byId: Map<string, Model<Api>> } | undefined;

    constructor(models: () => Model<Api>[]) {
        this.#models = models;
    }

    /** The model Pi lists with published cache prices under the same bare id as `id`: the maker's, first. */
    lookup(id: string): Model<Api> | undefined {
        const now = Date.now();

        if (this.#publishedIndex === undefined || now - this.#publishedIndex.at > 60_000) {
            const byId = new Map<string, Model<Api>>();

            for (const model of this.#models()) {
                const key = bareId(model.id);
                const known = byId.get(key);

                // The maker's own listing wins over a cloud's (Bedrock, Vertex), whose ids and prices differ.
                if (
                    cachePrices(model, undefined) !== undefined &&
                    (known === undefined ||
                        (MAKERS.has(model.provider) && known.provider !== model.provider))
                ) {
                    byId.set(key, model);
                }
            }

            this.#publishedIndex = { at: now, byId };
        }

        return this.#publishedIndex.byId.get(bareId(id));
    }
}
