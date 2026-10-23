/** Supported web operations, provider options, and validation shared with the settings sheet. */

export type SearchTier = "quick" | "standard" | "deep";
export type WebOperation = "search" | "extract" | "crawl" | "research";
export interface SearchRoute {
    provider: string;
    mode?: string;
}
export type TierRouting = Record<SearchTier, SearchRoute[]>;
export type ProviderSettings = Record<string, Record<string, string | number | boolean | string[]>>;

export const SEARCH_MODES: Record<string, string[]> = {
    tavily: ["ultra-fast", "fast", "basic", "advanced"],
    exa: ["lite", "auto", "deep-lite", "deep"],
    brave: [],
    serper: [],
    openai: [],
    duckduckgo: [],
};
export const CAPABILITIES: Record<string, WebOperation[]> = {
    tavily: ["search", "extract", "crawl", "research"],
    exa: ["search", "extract"],
    brave: ["search"],
    serper: ["search"],
    openai: ["search"],
    duckduckgo: ["search"],
    direct: ["extract"],
};
export const DEFAULT_TIERS: TierRouting = {
    quick: [
        { provider: "brave" },
        { provider: "exa", mode: "lite" },
        { provider: "tavily", mode: "fast" },
        { provider: "duckduckgo" },
    ],
    standard: [
        { provider: "exa", mode: "auto" },
        { provider: "tavily", mode: "basic" },
        { provider: "brave" },
        { provider: "duckduckgo" },
    ],
    deep: [
        { provider: "exa", mode: "deep" },
        { provider: "tavily", mode: "advanced" },
    ],
};

interface SettingField {
    key: string;
    label: string;
    type: "select" | "number" | "boolean" | "domains";
    default: string | number | boolean | string[];
    options?: string[];
    min?: number;
    max?: number;
    operation: WebOperation;
}

export const SETTING_FIELDS: Record<string, SettingField[]> = {
    exa: [
        {
            key: "mode",
            label: "Default search mode",
            type: "select",
            default: "auto",
            options: SEARCH_MODES.exa,
            operation: "search",
        },
        {
            key: "content",
            label: "Search content",
            type: "select",
            default: "text",
            options: ["text", "highlights"],
            operation: "search",
        },
        {
            key: "maxCharacters",
            label: "Characters per search result",
            type: "number",
            default: 1200,
            min: 100,
            max: 20000,
            operation: "search",
        },
        {
            key: "includeDomains",
            label: "Include domains (comma separated)",
            type: "domains",
            default: [],
            operation: "search",
        },
        {
            key: "excludeDomains",
            label: "Exclude domains (comma separated)",
            type: "domains",
            default: [],
            operation: "search",
        },
    ],
    tavily: [
        {
            key: "mode",
            label: "Default search depth",
            type: "select",
            default: "basic",
            options: SEARCH_MODES.tavily,
            operation: "search",
        },
        {
            key: "topic",
            label: "Search topic",
            type: "select",
            default: "general",
            options: ["general", "news", "finance"],
            operation: "search",
        },
        {
            key: "timeRange",
            label: "Search time range",
            type: "select",
            default: "any",
            options: ["any", "day", "week", "month", "year"],
            operation: "search",
        },
        {
            key: "includeAnswer",
            label: "Include search answer",
            type: "boolean",
            default: true,
            operation: "search",
        },
        {
            key: "includeDomains",
            label: "Include domains (comma separated)",
            type: "domains",
            default: [],
            operation: "search",
        },
        {
            key: "excludeDomains",
            label: "Exclude domains (comma separated)",
            type: "domains",
            default: [],
            operation: "search",
        },
        {
            key: "extractDepth",
            label: "Extraction depth (also used by crawl)",
            type: "select",
            default: "basic",
            options: ["basic", "advanced"],
            operation: "extract",
        },
        {
            key: "format",
            label: "Extraction format (also used by crawl)",
            type: "select",
            default: "markdown",
            options: ["markdown", "text"],
            operation: "extract",
        },
        {
            key: "timeout",
            label: "Extract / crawl timeout (seconds)",
            type: "number",
            default: 60,
            min: 1,
            max: 150,
            operation: "extract",
        },
        {
            key: "maxDepth",
            label: "Crawl depth",
            type: "number",
            default: 1,
            min: 1,
            max: 5,
            operation: "crawl",
        },
        {
            key: "maxBreadth",
            label: "Crawl breadth",
            type: "number",
            default: 10,
            min: 1,
            max: 100,
            operation: "crawl",
        },
        {
            key: "pageLimit",
            label: "Maximum crawl pages",
            type: "number",
            default: 10,
            min: 1,
            max: 100,
            operation: "crawl",
        },
        {
            key: "allowExternal",
            label: "Follow external domains",
            type: "boolean",
            default: false,
            operation: "crawl",
        },
        {
            key: "researchModel",
            label: "Research model",
            type: "select",
            default: "mini",
            options: ["mini", "pro", "auto"],
            operation: "research",
        },
    ],
};

export function settingsFor(settings: ProviderSettings | undefined, provider: string) {
    return {
        ...Object.fromEntries((SETTING_FIELDS[provider] ?? []).map((f) => [f.key, f.default])),
        ...settings?.[provider],
    };
}

export function invalidWeb(message: string): never {
    throw Object.assign(new Error(message), { status: 400 });
}

export function validateMode(provider: string, mode?: string) {
    if (
        !Object.hasOwn(SEARCH_MODES, provider) ||
        (mode !== undefined && !SEARCH_MODES[provider]!.includes(mode))
    ) {
        invalidWeb(`Unsupported search provider/mode: ${provider}/${mode ?? "default"}`);
    }
}

export function webNumber(
    value: unknown,
    min: number,
    max: number,
    label: string,
): asserts value is number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        invalidWeb(`${label} must be an integer from ${min} to ${max}`);
    }
}

export function validateWebSettings(config: {
    enabled?: boolean;
    provider?: string;
    maxResults?: number;
    tierRouting?: TierRouting;
    extractOrder?: string[];
    providerSettings?: ProviderSettings;
    operations?: Record<string, WebOperation[]>;
    searchRouting?: { providers?: string[] };
}) {
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
        invalidWeb("enabled must be a boolean");
    }

    if (config.provider !== undefined) {
        validateMode(config.provider);
    }

    if (config.maxResults !== undefined) {
        webNumber(config.maxResults, 1, 20, "Result count");
    }

    if (config.searchRouting?.providers !== undefined) {
        if (
            !Array.isArray(config.searchRouting.providers) ||
            config.searchRouting.providers.length > 20
        ) {
            invalidWeb("Invalid legacy provider order");
        }

        config.searchRouting.providers.forEach((p) => validateMode(p));
    }

    if (config.tierRouting !== undefined) {
        for (const tier of ["quick", "standard", "deep"] as const) {
            const routes = config.tierRouting?.[tier];

            if (!Array.isArray(routes) || routes.length < 1 || routes.length > 20) {
                invalidWeb(`${tier} needs between 1 and 20 routes`);
            }

            for (const route of routes) {
                if (!route || typeof route.provider !== "string") {
                    invalidWeb("Invalid search route");
                }

                validateMode(route.provider, route.mode);
            }
        }
    }

    if (
        config.extractOrder !== undefined &&
        (!Array.isArray(config.extractOrder) ||
            config.extractOrder.length < 1 ||
            config.extractOrder.length > 3 ||
            config.extractOrder.some(
                (p) => !Object.hasOwn(CAPABILITIES, p) || !CAPABILITIES[p]?.includes("extract"),
            ) ||
            new Set(config.extractOrder).size !== config.extractOrder.length)
    ) {
        invalidWeb("Extraction order must contain unique direct, tavily, or exa entries");
    }

    if (config.operations !== undefined) {
        if (
            !config.operations ||
            typeof config.operations !== "object" ||
            Array.isArray(config.operations)
        ) {
            invalidWeb("Invalid operations");
        }

        for (const [provider, ops] of Object.entries(config.operations)) {
            if (
                !Array.isArray(ops) ||
                !Object.hasOwn(CAPABILITIES, provider) ||
                ops.some((op) => !CAPABILITIES[provider]!.includes(op))
            ) {
                invalidWeb(`Invalid operations for ${provider}`);
            }
        }
    }

    if (config.providerSettings !== undefined) {
        if (
            !config.providerSettings ||
            typeof config.providerSettings !== "object" ||
            Array.isArray(config.providerSettings)
        ) {
            invalidWeb("Invalid provider settings");
        }

        for (const [provider, settings] of Object.entries(config.providerSettings)) {
            if (
                !Object.hasOwn(SETTING_FIELDS, provider) ||
                !settings ||
                typeof settings !== "object" ||
                Array.isArray(settings)
            ) {
                invalidWeb(`Invalid settings for ${provider}`);
            }

            for (const [key, value] of Object.entries(settings)) {
                const field = SETTING_FIELDS[provider]!.find((f) => f.key === key);

                if (!field) {
                    invalidWeb(`Unknown option ${provider}.${key}`);
                }

                if (field.type === "number") {
                    webNumber(value, field.min!, field.max!, field.label);
                } else if (field.type === "select" && !field.options!.includes(value as string)) {
                    invalidWeb(`Invalid ${provider}.${key}`);
                } else if (field.type === "boolean" && typeof value !== "boolean") {
                    invalidWeb(`Invalid ${provider}.${key}`);
                } else if (
                    field.type === "domains" &&
                    (!Array.isArray(value) ||
                        value.length > 100 ||
                        value.some((v) => typeof v !== "string" || !v.trim() || v.length > 253))
                ) {
                    invalidWeb(`Invalid ${provider}.${key}`);
                }
            }
        }
    }
}
