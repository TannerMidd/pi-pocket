/**
 * Web Access & Search manager for Pi Pocket.
 * Coordinates web search providers (Tavily, Exa, Brave, Serper, OpenAI, DuckDuckGo),
 * keeps its own API keys, settings, and request ledger below host.dataDir,
 * tests connectivity, and executes live searches and web fetches.
 */
import { join } from "node:path";
import type { Host, PublicFetchInit } from "../_pocket.d.ts";
import {
    CAPABILITIES,
    DEFAULT_TIERS,
    SEARCH_MODES,
    SETTING_FIELDS,
    invalidWeb,
    settingsFor,
    validateMode,
    validateWebSettings,
    webNumber,
    type ProviderSettings,
    type SearchRoute,
    type SearchTier,
    type TierRouting,
    type WebOperation,
} from "./settings.ts";
import {
    emptyWebUsage,
    incrementUsage,
    readWebFile,
    updateWebFile,
    type UsageCounter,
    type WebUsage,
} from "./storage.ts";

export interface SearchResult {
    title: string;
    url: string;
    content: string;
    publishedDate?: string;
}

export interface SearchResponse {
    provider: string;
    query: string;
    synthesis?: string;
    results: SearchResult[];
    tier?: SearchTier;
    mode?: string;
    attempts?: { provider: string; mode?: string; outcome: string }[];
}

export interface WebProviderDescriptor {
    id: string;
    name: string;
    description: string;
    website: string;
    apiKeyRequired: boolean;
    keyConfigured: boolean;
    keySource?: "extension" | "none";
    maskedKey?: string;
    connected?: boolean;
    latencyMs?: number;
    error?: string;
}

export interface WebSearchConfig {
    enabled?: boolean;
    provider?: string;
    searchRouting?: {
        providers?: string[];
        fallbackOn?: string[];
    };
    maxResults?: number;
    tierRouting?: TierRouting;
    extractOrder?: string[];
    providerSettings?: ProviderSettings;
    operations?: Record<string, WebOperation[]>;
    tavilyApiKey?: string;
    tavily?: { apiKey?: string; key?: string };
    exaApiKey?: string;
    exa?: { apiKey?: string; key?: string };
    braveApiKey?: string;
    brave?: { apiKey?: string; key?: string };
    serperApiKey?: string;
    serper?: { apiKey?: string; key?: string };
    openaiApiKey?: string;
    openai?: { apiKey?: string; key?: string };
}

export interface WebAccessState {
    enabled: boolean;
    primaryProvider: string;
    providerOrder: string[];
    maxResults: number;
    providers: WebProviderDescriptor[];
    tierRouting: TierRouting;
    tierRoutingEnabled: boolean;
    extractOrder: string[];
    providerSettings: ProviderSettings;
    operations: Record<string, WebOperation[]>;
    capabilities: typeof CAPABILITIES;
    searchModes: typeof SEARCH_MODES;
    settingFields: typeof SETTING_FIELDS;
    usage: WebUsage;
}

const PROVIDER_METADATA: Record<
    string,
    { name: string; description: string; website: string; apiKeyRequired: boolean }
> = {
    tavily: {
        name: "Tavily Search",
        description: "Optimized for LLMs with fast search, AI summaries, and direct answers.",
        website: "https://tavily.com",
        apiKeyRequired: true,
    },
    exa: {
        name: "Exa Neural Search",
        description: "Embeddings-based neural search with rich text snippets and highlights.",
        website: "https://exa.ai",
        apiKeyRequired: true,
    },
    brave: {
        name: "Brave Search",
        description: "Independent web search index with privacy focus and high rate limits.",
        website: "https://brave.com/search/api/",
        apiKeyRequired: true,
    },
    serper: {
        name: "Serper (Google Search)",
        description: "Google Search API for real-time web results, snippets, and knowledge graph.",
        website: "https://serper.dev",
        apiKeyRequired: true,
    },
    openai: {
        name: "OpenAI synthesis",
        description:
            "Model-generated answers using an OpenAI API key; does not search the live web.",
        website: "https://platform.openai.com",
        apiKeyRequired: true,
    },
    duckduckgo: {
        name: "DuckDuckGo (Free)",
        description: "Zero-configuration search without any API key or account.",
        website: "https://duckduckgo.com",
        apiKeyRequired: false,
    },
};

const ALL_PROVIDER_IDS = ["tavily", "exa", "brave", "serper", "openai", "duckduckgo"];

function maskKey(key: string): string {
    if (!key || key.length < 8) {
        return "••••••••";
    }

    const prefix = key.slice(0, 4);
    const suffix = key.slice(-4);

    return `${prefix}••••${suffix}`;
}

function cleanHtml(html: string): string {
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
        .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
        .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
}

export class WebAccessManager {
    readonly #configPath: string;
    readonly #host: Pick<Host, "fetchPublic">;
    readonly #alive = new AbortController();
    readonly #usagePath: string;
    #testCache = new Map<string, { ok: boolean; latencyMs?: number; error?: string; at: number }>();

    constructor(directory: string, host: Pick<Host, "fetchPublic">) {
        this.#configPath = join(directory, "web-search.json");
        this.#usagePath = join(directory, "web-usage.json");
        this.#host = host;
    }

    dispose(): void {
        this.#alive.abort();
    }

    async loadConfig(): Promise<WebSearchConfig> {
        return readWebFile(this.#configPath, {
            enabled: true,
            provider: "tavily",
            searchRouting: {
                providers: ["tavily", "exa", "brave", "serper", "openai", "duckduckgo"],
                fallbackOn: ["transient", "quota", "network", "invalid-response"],
            },
            maxResults: 5,
            tierRouting: DEFAULT_TIERS,
        });
    }

    async saveConfig(updates: Partial<WebSearchConfig>): Promise<WebSearchConfig> {
        validateWebSettings(updates);

        return updateWebFile(this.#configPath, await this.loadConfig(), (current) => {
            const routing = { ...current.searchRouting, ...updates.searchRouting };
            const settings = { ...current.providerSettings };

            for (const [provider, values] of Object.entries(updates.providerSettings ?? {})) {
                settings[provider] = { ...settings[provider], ...values };
            }

            Object.assign(current, updates, { searchRouting: routing, providerSettings: settings });
        });
    }

    async resolveKey(providerId: string): Promise<{ key?: string; source: "extension" | "none" }> {
        const config = await this.loadConfig();
        const value = (config as Record<string, unknown>)[`${providerId}ApiKey`];

        return typeof value === "string" && value.trim()
            ? { key: value.trim(), source: "extension" }
            : { source: "none" };
    }

    async getState(): Promise<WebAccessState> {
        const config = await this.loadConfig();
        const providers: WebProviderDescriptor[] = [];

        for (const id of ALL_PROVIDER_IDS) {
            const meta = PROVIDER_METADATA[id] ?? {
                name: id,
                description: "",
                website: "",
                apiKeyRequired: true,
            };
            const { key, source } = await this.resolveKey(id);
            const cached = this.#testCache.get(id);

            providers.push({
                id,
                name: meta.name,
                description: meta.description,
                website: meta.website,
                apiKeyRequired: meta.apiKeyRequired,
                keyConfigured: !meta.apiKeyRequired || Boolean(key),
                keySource: source,
                maskedKey: key ? maskKey(key) : undefined,
                connected: cached?.ok,
                latencyMs: cached?.latencyMs,
                error: cached?.error,
            });
        }

        const primary = config.provider || "tavily";
        const order = config.searchRouting?.providers?.length
            ? config.searchRouting.providers
            : ALL_PROVIDER_IDS;

        return {
            enabled: config.enabled ?? true,
            primaryProvider: primary,
            providerOrder: order,
            maxResults: config.maxResults ?? 5,
            providers,
            tierRouting: this.#tiers(config),
            tierRoutingEnabled: Boolean(config.tierRouting),
            extractOrder: config.extractOrder ?? ["direct", "tavily", "exa"],
            providerSettings: Object.fromEntries(
                Object.keys(SETTING_FIELDS).map((p) => [
                    p,
                    settingsFor(config.providerSettings, p),
                ]),
            ),
            operations: { ...CAPABILITIES, ...config.operations },
            capabilities: CAPABILITIES,
            searchModes: SEARCH_MODES,
            settingFields: SETTING_FIELDS,
            usage: await readWebFile(this.#usagePath, emptyWebUsage()),
        };
    }

    async setApiKey(providerId: string, apiKey: string): Promise<void> {
        validateMode(providerId);

        if (typeof apiKey !== "string") {
            invalidWeb("API key must be text");
        }

        const trimmed = apiKey.trim();
        const keyField = `${providerId}ApiKey`;

        await updateWebFile(this.#configPath, await this.loadConfig(), (config) => {
            if (trimmed) {
                (config as any)[keyField] = trimmed;
            } else {
                delete (config as any)[keyField];

                if ((config as any)[providerId]) {
                    delete (config as any)[providerId].apiKey;
                    delete (config as any)[providerId].key;
                }
            }
        });
        this.#testCache.delete(providerId);
    }

    async testConnection(
        providerId: string,
        explicitKey?: string,
    ): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
        validateMode(providerId);

        if (explicitKey !== undefined && typeof explicitKey !== "string") {
            invalidWeb("API key must be text");
        }

        const key =
            explicitKey !== undefined
                ? explicitKey.trim()
                : (await this.resolveKey(providerId)).key;
        const meta = PROVIDER_METADATA[providerId];

        if (meta?.apiKeyRequired && !key) {
            const res = {
                ok: false,
                error: `No API key configured for ${meta?.name || providerId}`,
            };

            this.#testCache.set(providerId, { ...res, at: Date.now() });

            return res;
        }

        const start = Date.now();
        const fetch = (url: string, init: PublicFetchInit) =>
            this.#request(
                { provider: providerId, operation: "test", mode: "connection", purpose: "test" },
                url,
                init,
                providerId !== "duckduckgo",
            );

        try {
            switch (providerId) {
                case "tavily": {
                    const res = await fetch("https://api.tavily.com/search", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            api_key: key,
                            query: "ping",
                            max_results: 1,
                            include_usage: true,
                        }),
                        signal: AbortSignal.timeout(8000),
                    });

                    if (!res.ok) {
                        const errText = await res.text().catch(() => "");

                        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
                    }

                    break;
                }

                case "exa": {
                    const res = await fetch("https://api.exa.ai/search", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "x-api-key": key! },
                        body: JSON.stringify({ query: "ping", numResults: 1 }),
                        signal: AbortSignal.timeout(8000),
                    });

                    if (!res.ok) {
                        const errText = await res.text().catch(() => "");

                        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
                    }

                    break;
                }

                case "brave": {
                    const res = await fetch(
                        "https://api.search.brave.com/res/v1/web/search?q=ping&count=1",
                        {
                            headers: {
                                Accept: "application/json",
                                "X-Subscription-Token": key!,
                            },
                            signal: AbortSignal.timeout(8000),
                        },
                    );

                    if (!res.ok) {
                        const errText = await res.text().catch(() => "");

                        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
                    }

                    break;
                }

                case "serper": {
                    const res = await fetch("https://google.serper.dev/search", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-API-KEY": key!,
                        },
                        body: JSON.stringify({ q: "ping", num: 1 }),
                        signal: AbortSignal.timeout(8000),
                    });

                    if (!res.ok) {
                        const errText = await res.text().catch(() => "");

                        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
                    }

                    break;
                }

                case "openai": {
                    const res = await fetch("https://api.openai.com/v1/models", {
                        headers: { Authorization: `Bearer ${key!}` },
                        signal: AbortSignal.timeout(8000),
                    });

                    if (!res.ok) {
                        const errText = await res.text().catch(() => "");

                        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
                    }

                    break;
                }

                case "duckduckgo": {
                    const res = await fetch("https://html.duckduckgo.com/html/?q=ping", {
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        },
                        signal: AbortSignal.timeout(8000),
                    });

                    if (!res.ok && res.status !== 200) {
                        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                    }

                    break;
                }

                default:
                    throw new Error(`Unknown provider: ${providerId}`);
            }

            const latencyMs = Date.now() - start;
            const outcome = { ok: true, latencyMs };

            this.#testCache.set(providerId, { ...outcome, at: Date.now() });

            return outcome;
        } catch (err: any) {
            const outcome = { ok: false, error: err.message || String(err) };

            this.#testCache.set(providerId, { ...outcome, at: Date.now() });

            return outcome;
        }
    }

    async search(
        query: string,
        preferredProvider?: string,
        requestedResults?: number,
        options: { tier?: SearchTier; mode?: string; purpose?: "tool" | "tester" } = {},
    ): Promise<SearchResponse> {
        const config = await this.loadConfig();

        if (typeof query !== "string" || !query.trim()) {
            invalidWeb("Search query cannot be empty");
        }

        const tier = options.tier ?? "standard";

        if (!["quick", "standard", "deep"].includes(tier)) {
            invalidWeb("Unknown search tier");
        }

        const max = requestedResults ?? config.maxResults ?? 5;

        webNumber(max, 1, 20, "Result count");
        const explicit = preferredProvider && preferredProvider !== "auto";

        if (explicit) {
            validateMode(preferredProvider, options.mode);
        } else if (options.mode !== undefined) {
            invalidWeb("A mode override requires an explicit provider");
        }

        const routes: SearchRoute[] = explicit
            ? [{ provider: preferredProvider, mode: options.mode }]
            : this.#tiers(config)[tier];
        const attempts: NonNullable<SearchResponse["attempts"]> = [];
        let sent = 0;

        for (const route of routes) {
            const pid = route.provider;
            const settings = settingsFor(config.providerSettings, pid);
            const mode = route.mode ?? (settings.mode as string | undefined);

            validateMode(pid, mode);
            const { key } = await this.resolveKey(pid);

            if (
                !this.#available(config, pid, "search") ||
                (PROVIDER_METADATA[pid]?.apiKeyRequired && !key)
            ) {
                attempts.push({ provider: pid, mode, outcome: "skipped: disabled or missing key" });
                continue;
            }

            try {
                const response = await this.#executeProviderSearch(
                    pid,
                    query.trim(),
                    max,
                    key,
                    mode,
                    settings,
                    options.purpose ?? "tool",
                    sent++ > 0,
                );

                if (response.results.length > 0 || response.synthesis) {
                    attempts.push({ provider: pid, mode, outcome: "success" });

                    return { ...response, mode, tier, attempts };
                }

                attempts.push({ provider: pid, mode, outcome: "empty results" });
            } catch (err: any) {
                if (err.name === "AbortError") {
                    throw err;
                }

                attempts.push({ provider: pid, mode, outcome: err.message || String(err) });
            }
        }

        throw new Error(
            `Web search exhausted ${tier} tier (no automatic escalation): ${attempts.map((a) => `${a.provider}/${a.mode ?? "default"}: ${a.outcome}`).join("; ")}`,
        );
    }

    async #executeProviderSearch(
        provider: string,
        query: string,
        maxResults: number,
        apiKey?: string,
        mode?: string,
        settings: ReturnType<typeof settingsFor> = {},
        purpose = "tool",
        fallback = false,
    ): Promise<SearchResponse> {
        const fetch = (url: string, init: PublicFetchInit) =>
            this.#request(
                { provider, operation: "search", mode: mode ?? "default", purpose },
                url,
                init,
                provider !== "duckduckgo",
                fallback,
            );

        switch (provider) {
            case "tavily": {
                const res = await fetch("https://api.tavily.com/search", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        api_key: apiKey,
                        query,
                        max_results: maxResults,
                        include_answer: settings.includeAnswer ?? true,
                        search_depth: mode ?? "basic",
                        topic: settings.topic ?? "general",
                        ...(settings.timeRange && settings.timeRange !== "any"
                            ? { time_range: settings.timeRange }
                            : {}),
                        include_domains: settings.includeDomains ?? [],
                        exclude_domains: settings.excludeDomains ?? [],
                        include_usage: true,
                        auto_parameters: false,
                    }),
                    signal: AbortSignal.timeout(15000),
                });

                if (!res.ok) {
                    throw new Error(`Tavily HTTP ${res.status}`);
                }

                const data = (await res.json()) as any;
                const results: SearchResult[] = (data.results || []).map((r: any) => ({
                    title: r.title || "Untitled",
                    url: r.url,
                    content: r.content || "",
                    publishedDate: r.published_date,
                }));

                return {
                    provider: "tavily",
                    query,
                    synthesis: data.answer,
                    results,
                };
            }

            case "exa": {
                const res = await fetch("https://api.exa.ai/search", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": apiKey!,
                    },
                    body: JSON.stringify({
                        query,
                        numResults: maxResults,
                        type: mode ?? "auto",
                        contents:
                            settings.content === "highlights"
                                ? { highlights: true }
                                : { text: { maxCharacters: settings.maxCharacters ?? 1200 } },
                        includeDomains: settings.includeDomains ?? [],
                        excludeDomains: settings.excludeDomains ?? [],
                    }),
                    signal: AbortSignal.timeout(mode?.startsWith("deep") ? 90000 : 15000),
                });

                if (!res.ok) {
                    throw new Error(`Exa HTTP ${res.status}`);
                }

                const data = (await res.json()) as any;
                const results: SearchResult[] = (data.results || []).map((r: any) => ({
                    title: r.title || "Untitled",
                    url: r.url,
                    content: r.text || r.highlights?.join("\n") || "",
                    publishedDate: r.publishedDate,
                }));

                return { provider: "exa", query, results };
            }

            case "brave": {
                const res = await fetch(
                    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
                    {
                        headers: {
                            Accept: "application/json",
                            "X-Subscription-Token": apiKey!,
                        },
                        signal: AbortSignal.timeout(15000),
                    },
                );

                if (!res.ok) {
                    throw new Error(`Brave HTTP ${res.status}`);
                }

                const data = (await res.json()) as any;
                const results: SearchResult[] = (data.web?.results || []).map((r: any) => ({
                    title: r.title || "Untitled",
                    url: r.url,
                    content: r.description || "",
                    publishedDate: r.page_age,
                }));

                return { provider: "brave", query, results };
            }

            case "serper": {
                const res = await fetch("https://google.serper.dev/search", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-API-KEY": apiKey!,
                    },
                    body: JSON.stringify({ q: query, num: maxResults }),
                    signal: AbortSignal.timeout(15000),
                });

                if (!res.ok) {
                    throw new Error(`Serper HTTP ${res.status}`);
                }

                const data = (await res.json()) as any;
                const results: SearchResult[] = (data.organic || []).map((r: any) => ({
                    title: r.title || "Untitled",
                    url: r.link,
                    content: r.snippet || "",
                    publishedDate: r.date,
                }));
                const synthesis = data.knowledgeGraph
                    ? `${data.knowledgeGraph.title || ""}: ${data.knowledgeGraph.description || ""}`.trim()
                    : undefined;

                return { provider: "serper", query, synthesis, results };
            }

            case "openai": {
                const res = await fetch("https://api.openai.com/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${apiKey!}`,
                    },
                    body: JSON.stringify({
                        model: "gpt-4o-mini",
                        messages: [
                            {
                                role: "system",
                                content:
                                    "You are a helpful assistant. Synthesize a concise answer with real-world knowledge for the query.",
                            },
                            { role: "user", content: query },
                        ],
                        max_tokens: 500,
                    }),
                    signal: AbortSignal.timeout(15000),
                });

                if (!res.ok) {
                    throw new Error(`OpenAI HTTP ${res.status}`);
                }

                const data = (await res.json()) as any;
                const answer = data.choices?.[0]?.message?.content || "";

                return {
                    provider: "openai",
                    query,
                    synthesis: answer,
                    results: [
                        {
                            title: `OpenAI Knowledge: ${query}`,
                            url: "https://platform.openai.com",
                            content: answer,
                        },
                    ],
                };
            }

            case "duckduckgo": {
                const res = await fetch(
                    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
                    {
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        },
                        signal: AbortSignal.timeout(15000),
                    },
                );

                if (!res.ok) {
                    throw new Error(`DuckDuckGo HTTP ${res.status}`);
                }

                const html = await res.text();
                const results: SearchResult[] = [];
                const blocks = html.split(/class="result__body/g).slice(1);

                for (const block of blocks.slice(0, maxResults)) {
                    const titleMatch = block.match(/<a class="result__url"[^>]*>(.*?)<\/a>/i);
                    const snippetMatch = block.match(/<a class="result__snippet[^>]*>(.*?)<\/a>/i);
                    const linkMatch = block.match(/href="([^"]+)"/i);

                    if (snippetMatch || titleMatch) {
                        let link = linkMatch && linkMatch[1] ? linkMatch[1] : "";

                        if (link && link.includes("uddg=")) {
                            try {
                                const urlParam = new URL(
                                    link,
                                    "https://duckduckgo.com",
                                ).searchParams.get("uddg");

                                if (urlParam) {
                                    link = decodeURIComponent(urlParam);
                                }
                            } catch {}
                        }

                        const titleText =
                            titleMatch && titleMatch[1] ? titleMatch[1] : "DuckDuckGo Result";
                        const snippetText = snippetMatch && snippetMatch[1] ? snippetMatch[1] : "";

                        results.push({
                            title: cleanHtml(titleText),
                            url: link || "https://duckduckgo.com",
                            content: cleanHtml(snippetText),
                        });
                    }
                }

                return { provider: "duckduckgo", query, results };
            }

            default:
                throw new Error(`Unknown provider: ${provider}`);
        }
    }

    #tiers(config: WebSearchConfig): TierRouting {
        const standard = [
            config.provider || "tavily",
            ...(config.searchRouting?.providers ?? ALL_PROVIDER_IDS),
        ]
            .filter((p, i, all) => all.indexOf(p) === i)
            .map((provider) => ({ provider }));

        return config.tierRouting ?? { ...DEFAULT_TIERS, standard };
    }

    #available(config: WebSearchConfig, provider: string, operation: WebOperation) {
        return (
            config.enabled !== false &&
            (config.operations?.[provider] ?? CAPABILITIES[provider] ?? []).includes(operation)
        );
    }

    async #request(
        info: Pick<UsageCounter, "provider" | "operation" | "mode" | "purpose">,
        url: string,
        init: PublicFetchInit,
        json = true,
        fallback = false,
    ): Promise<Response> {
        const date = new Date().toISOString().slice(0, 10);

        await updateWebFile(this.#usagePath, emptyWebUsage(), (usage) =>
            incrementUsage(
                usage,
                info,
                { requests: 1, unknown: 1, fallback: fallback ? 1 : 0 },
                date,
            ),
        );
        let received = false;

        try {
            const response = await this.#host.fetchPublic(url, {
                ...init,
                redirect: info.provider === "direct" ? "follow" : "error",
                timeoutMs: 180000,
                maxBytes: 10 * 1024 * 1024,
                signal: AbortSignal.any([
                    this.#alive.signal,
                    ...(init.signal ? [init.signal] : []),
                ]),
            });

            received = true;

            if (
                !response.ok &&
                info.operation !== "url-check" &&
                !(info.provider === "direct" && response.status >= 300 && response.status < 400)
            ) {
                throw new Error(`${info.provider} HTTP ${response.status}`);
            }

            const data = json ? ((await response.clone().json()) as any) : undefined;
            const credits = info.operation !== "research-status" ? data?.usage?.credits : undefined;
            const dollars = data?.costDollars?.total;

            await updateWebFile(this.#usagePath, emptyWebUsage(), (usage) =>
                incrementUsage(
                    usage,
                    info,
                    {
                        successes: 1,
                        unknown: -1,
                        ...(typeof credits === "number" && Number.isFinite(credits) && credits >= 0
                            ? { credits, creditReports: 1 }
                            : {}),
                        ...(typeof dollars === "number" && Number.isFinite(dollars) && dollars >= 0
                            ? { dollars, dollarReports: 1 }
                            : {}),
                    },
                    date,
                ),
            );

            return response;
        } catch (error: any) {
            await updateWebFile(this.#usagePath, emptyWebUsage(), (usage) =>
                incrementUsage(
                    usage,
                    info,
                    {
                        ...(received || String(error.code ?? "").startsWith("POCKET_")
                            ? { failures: 1, unknown: -1 }
                            : {}),
                    },
                    date,
                ),
            );

            if (error instanceof SyntaxError) {
                throw new Error(`${info.provider} returned invalid JSON`);
            }

            throw error;
        }
    }

    #publicUrl(url: string) {
        const parsed = new URL(url);

        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            invalidWeb("Only HTTP and HTTPS protocols are supported.");
        }

        if (parsed.username || parsed.password) {
            invalidWeb("URL credentials are not supported");
        }

        return parsed;
    }

    async fetchContent(
        url: string,
        maxChars = 20000,
        provider?: string,
    ): Promise<{ text: string; truncated: boolean; length: number; provider: string }> {
        const parsed = this.#publicUrl(url);

        webNumber(maxChars, 500, 200000, "Character limit");
        const config = await this.loadConfig();

        if (
            provider &&
            provider !== "auto" &&
            (!Object.hasOwn(CAPABILITIES, provider) || !CAPABILITIES[provider]?.includes("extract"))
        ) {
            invalidWeb("Unsupported extraction provider");
        }

        const order =
            provider && provider !== "auto"
                ? [provider]
                : (config.extractOrder ?? ["direct", "tavily", "exa"]);
        const errors: string[] = [];
        let sent = 0;

        for (const pid of order) {
            if (!this.#available(config, pid, "extract")) {
                errors.push(`${pid}: disabled`);
                continue;
            }

            const { key } = await this.resolveKey(pid);

            if (pid !== "direct" && !key) {
                errors.push(`${pid}: missing key`);
                continue;
            }

            const settings = settingsFor(config.providerSettings, pid);
            const info = {
                provider: pid,
                operation: "extract",
                mode: pid === "tavily" ? String(settings.extractDepth) : "text",
                purpose: "tool",
            };
            const fallback = sent++ > 0;

            try {
                let cleaned: string;

                if (pid === "direct") {
                    const response = await this.#request(
                        info,
                        parsed.toString(),
                        {
                            headers: { Accept: "text/html,text/plain;q=0.9" },
                            signal: AbortSignal.timeout(15000),
                        },
                        false,
                        fallback,
                    );

                    cleaned = cleanHtml(await response.text());
                } else {
                    await this.#checkPublicTarget(parsed.toString());
                    const tavily = pid === "tavily";
                    const response = await this.#request(
                        info,
                        tavily ? "https://api.tavily.com/extract" : "https://api.exa.ai/contents",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                ...(tavily
                                    ? { Authorization: `Bearer ${key}` }
                                    : { "x-api-key": key! }),
                            },
                            body: JSON.stringify(
                                tavily
                                    ? {
                                          urls: [url],
                                          extract_depth: settings.extractDepth,
                                          format: settings.format,
                                          timeout: settings.timeout,
                                          include_usage: true,
                                      }
                                    : { urls: [url], text: { maxCharacters: maxChars } },
                            ),
                            signal: AbortSignal.timeout(
                                tavily ? Number(settings.timeout) * 1000 + 5000 : 30000,
                            ),
                        },
                        true,
                        fallback,
                    );
                    const data = (await response.json()) as any;

                    cleaned = tavily ? data.results?.[0]?.raw_content : data.results?.[0]?.text;
                }

                if (typeof cleaned !== "string" || !cleaned.trim()) {
                    throw new Error("No readable content");
                }

                return {
                    text: cleaned.slice(0, maxChars),
                    truncated: cleaned.length > maxChars,
                    length: cleaned.length,
                    provider: pid,
                };
            } catch (error: any) {
                if (error.name === "AbortError" || String(error.code ?? "").startsWith("POCKET_")) {
                    throw error;
                }

                errors.push(`${pid}: ${error.message}`);
            }
        }

        throw new Error(`Extraction failed: ${errors.join("; ")}`);
    }

    async #tavilyOperation(
        operation: "crawl" | "research",
        body: Record<string, unknown>,
        mode: string,
    ) {
        const config = await this.loadConfig();

        if (!this.#available(config, "tavily", operation)) {
            invalidWeb(`Tavily ${operation} is disabled`);
        }

        const { key } = await this.resolveKey("tavily");

        if (!key) {
            invalidWeb("No API key configured for Tavily");
        }

        const settings = settingsFor(config.providerSettings, "tavily");
        const response = await this.#request(
            { provider: "tavily", operation, mode, purpose: "tool" },
            `https://api.tavily.com/${operation}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(
                    operation === "crawl" ? Number(settings.timeout) * 1000 + 5000 : 30000,
                ),
            },
        );

        return response.json() as Promise<any>;
    }

    async #checkPublicTarget(url: string) {
        const response = await this.#request(
            { provider: "direct", operation: "url-check", mode: "HEAD", purpose: "validation" },
            url,
            { method: "HEAD", signal: AbortSignal.timeout(15000) },
            false,
        );

        await response.body?.cancel();
    }

    async crawl(url: string, instructions?: string) {
        this.#publicUrl(url);

        if (instructions !== undefined && typeof instructions !== "string") {
            invalidWeb("Crawl instructions must be text");
        }

        const settings = settingsFor((await this.loadConfig()).providerSettings, "tavily");

        const config = await this.loadConfig();

        if (!this.#available(config, "tavily", "crawl")) {
            invalidWeb("Tavily crawl is disabled");
        }

        if (!(await this.resolveKey("tavily")).key) {
            invalidWeb("No API key configured for Tavily");
        }

        await this.#checkPublicTarget(url);

        return this.#tavilyOperation(
            "crawl",
            {
                url,
                instructions,
                max_depth: settings.maxDepth,
                max_breadth: settings.maxBreadth,
                limit: settings.pageLimit,
                allow_external: settings.allowExternal,
                extract_depth: settings.extractDepth,
                format: settings.format,
                timeout: settings.timeout,
                include_usage: true,
            },
            String(settings.extractDepth),
        );
    }

    async research(input: string, model?: string) {
        if (typeof input !== "string" || !input.trim()) {
            invalidWeb("Research question cannot be empty");
        }

        const settings = settingsFor((await this.loadConfig()).providerSettings, "tavily");
        const mode = model ?? String(settings.researchModel);

        if (!["mini", "pro", "auto"].includes(mode)) {
            invalidWeb("Unsupported research model");
        }

        let data: any;

        try {
            data = await this.#tavilyOperation(
                "research",
                { input, model: mode, stream: false },
                mode,
            );
        } catch (error: any) {
            throw new Error(
                `Research was not retried; submission may have reached Tavily. ${error.message}`,
            );
        }

        if (
            typeof data.request_id !== "string" ||
            !/^[\w-]{1,200}$/.test(data.request_id) ||
            Object.hasOwn(Object.prototype, data.request_id)
        ) {
            throw new Error("Research response had no valid job ID; do not automatically resubmit");
        }

        try {
            await updateWebFile(this.#usagePath, emptyWebUsage(), (usage) => {
                usage.jobs[data.request_id] = {
                    id: data.request_id,
                    mode,
                    status: data.status ?? "pending",
                    createdAt: new Date().toISOString(),
                    credits:
                        typeof data.usage?.credits === "number" &&
                        Number.isFinite(data.usage.credits) &&
                        data.usage.credits >= 0
                            ? data.usage.credits
                            : 0,
                    usageReported:
                        typeof data.usage?.credits === "number" &&
                        Number.isFinite(data.usage.credits) &&
                        data.usage.credits >= 0,
                };
            });
        } catch (error: any) {
            throw new Error(
                `Research job ${data.request_id} started but could not be saved: ${error.message}`,
            );
        }

        return { request_id: data.request_id, status: data.status, model: mode };
    }

    async researchStatus(id: string) {
        if (typeof id !== "string" || !/^[\w-]{1,200}$/.test(id)) {
            invalidWeb("Invalid research job ID");
        }

        const usage = await readWebFile(this.#usagePath, emptyWebUsage());
        const job = usage.jobs[id];

        if (!Object.hasOwn(usage.jobs, id) || !job) {
            invalidWeb("Unknown local research job");
        }

        const { key } = await this.resolveKey("tavily");

        if (!key) {
            invalidWeb("No API key configured for Tavily");
        }

        const info = {
            provider: "tavily",
            operation: "research-status",
            mode: job.mode,
            purpose: "tool",
        };
        const response = await this.#request(
            info,
            `https://api.tavily.com/research/${encodeURIComponent(id)}?include_usage=true`,
            {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(15000),
            },
        );
        const data = (await response.json()) as any;

        await updateWebFile(this.#usagePath, emptyWebUsage(), (current) => {
            const stored = current.jobs[id]!;
            const credits = data.usage?.credits;

            if (
                typeof credits === "number" &&
                credits >= stored.credits &&
                Number.isFinite(credits)
            ) {
                incrementUsage(
                    current,
                    { ...info, operation: "research" },
                    {
                        credits: credits - stored.credits,
                        creditReports: stored.usageReported ? 0 : 1,
                    },
                );
                stored.credits = credits;
                stored.usageReported = true;
            }

            stored.status = typeof data.status === "string" ? data.status : stored.status;
        });

        return data;
    }
}
