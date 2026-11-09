/**
 * Pi's compaction settings for Pi Durable, with each model's own thresholds: Pi's `compaction.modelOverrides`, keyed
 * by `provider/modelId`, resolved by Pi itself (its checks, project over user settings). Where Pi's settings give no
 * `reserveTokens`, each model gets room for its summary (`summaryReserve`).
 */
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
    type CompactionPolicy,
    type CompactionSettings,
    DEFAULT_COMPACTION_POLICY,
} from "@earendil-works/pi-durable";
import { describe } from "./errors.ts";

/** What `summaryReserve` reads of a model. */
export type ReserveModel = {
    readonly provider: string;
    readonly id: string;
    readonly contextWindow: number;
    readonly maxTokens: number;
};

/**
 * The most free context kept by default. Pi Durable's summary budget is then 26,214 tokens: room for a long session's
 * summary (about 16,000 tokens of output, thinking included, in the session that showed the fault), without compacting
 * much earlier than before.
 */
export const RESERVE_LIMIT = 32_768;

/**
 * The free context kept for a model when Pi's settings give none. Pi Durable writes a summary in at most 80% of it
 * (`maxTokens = 0.8 × reserveTokens`), and that budget holds the model's thinking as well as the summary. Its default,
 * 16,384, gives 13,107 tokens, and a long session's summary grows past that: each one folds in the one before, so a
 * session whose summary hits the limit can no longer compact, and every run after fails. This keeps room for all the
 * output the model can write, up to `RESERVE_LIMIT` and a quarter of its context window, and never less than Pi
 * Durable's default.
 */
export function summaryReserve(model: ReserveModel): number {
    const fallback = DEFAULT_COMPACTION_POLICY.reserveTokens;
    const output = model.maxTokens > 0 ? Math.ceil(model.maxTokens / 0.8) : RESERVE_LIMIT;
    const quarter = model.contextWindow > 0 ? Math.floor(model.contextWindow / 4) : fallback;

    return Math.max(fallback, Math.min(output, RESERVE_LIMIT, quarter));
}

/** The model names that Pi's settings (user and project, merged) give compaction values of their own. */
function overridden(settings: SettingsManager): string[] {
    return Object.keys(settings.getSettings().compaction?.modelOverrides ?? {});
}

const FIELDS = ["reserveTokens", "keepRecentTokens"] as const;

const whole = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Pi's general values; one that Pi refuses is left out, not all of them. */
function readGeneral(
    settings: SettingsManager,
    once: (message: string) => void,
): Partial<CompactionPolicy> {
    try {
        return settings.getCompactionSettings();
    } catch {
        const general: Partial<CompactionPolicy> = { enabled: settings.getCompactionEnabled() };

        for (const field of FIELDS) {
            try {
                general[field] =
                    field === "reserveTokens"
                        ? settings.getCompactionReserveTokens()
                        : settings.getCompactionKeepRecentTokens();
            } catch (error) {
                once(`Pi's compaction.${field} is left out: ${describe(error)}`);
            }
        }

        return general;
    }
}

/**
 * What Pi Durable compacts by, read afresh at each call: Pi's settings, and for each model with values of its own,
 * those. A value Pi refuses is left out and reported once through `warn`, so the others still count: a general value
 * falls back to Pi Durable's own, and an override that is refused (not a whole number, or a name with no provider) goes
 * whole.
 */
export function compactionReader(
    settings: SettingsManager,
    warn: (message: string) => void,
    models: () => Iterable<ReserveModel> = () => [],
): () => CompactionSettings {
    const warned = new Set<string>();

    const once = (message: string) => {
        if (!warned.has(message)) {
            warned.add(message);
            warn(message);
        }
    };

    return () => {
        const general = readGeneral(settings, once);
        const modelOverrides: Record<string, Partial<CompactionPolicy>> = {};

        for (const name of overridden(settings)) {
            try {
                const slash = name.indexOf("/");
                const entry = settings.getSettings().compaction?.modelOverrides?.[name];

                if (slash <= 0) {
                    throw new Error("the name must be provider/modelId");
                }

                if (typeof entry !== "object" || entry === null) {
                    throw new Error("expected an object");
                }

                const own: Partial<CompactionPolicy> = {};

                for (const field of FIELDS) {
                    const value = entry[field] ?? general[field];

                    if (value === undefined) {
                        continue;
                    }

                    if (!whole(value)) {
                        throw new Error(
                            `${field} ${JSON.stringify(value)} is not a non-negative integer`,
                        );
                    }

                    own[field] = value;
                }

                modelOverrides[name] = own;
            } catch (error) {
                once(
                    `Pi's compaction.modelOverrides[${JSON.stringify(name)}] is left out: ${describe(error)}`,
                );
            }
        }

        // No reserve set in Pi's settings: each model gets room for its summary. One the owner gave its own keeps it.
        if (settings.getSettings().compaction?.reserveTokens === undefined) {
            for (const model of models()) {
                const name = `${model.provider}/${model.id}`;
                const own = modelOverrides[name];

                if (own === undefined) {
                    modelOverrides[name] = { reserveTokens: summaryReserve(model) };
                } else if (
                    settings.getSettings().compaction?.modelOverrides?.[name]?.reserveTokens ===
                    undefined
                ) {
                    own.reserveTokens = summaryReserve(model);
                }
            }
        }

        return Object.keys(modelOverrides).length === 0 ? general : { ...general, modelOverrides };
    };
}
