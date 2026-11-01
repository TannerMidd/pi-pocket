/**
 * Pi's compaction settings for Pi Durable, with each model's own thresholds: Pi's `compaction.modelOverrides`, keyed
 * by `provider/modelId`, resolved by Pi itself (its checks, project over user settings).
 */
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CompactionPolicy, CompactionSettings } from "@earendil-works/pi-durable";
import { describe } from "./errors.ts";

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

        return Object.keys(modelOverrides).length === 0 ? general : { ...general, modelOverrides };
    };
}
