/**
 * The rate limits providers report on Pi's own requests: each provider's latest rate-limit headers, and when one last
 * refused a request for a limit (429). Providers such as Mistral, and Sign in with ChatGPT token sharing, have no usage
 * endpoint: these headers are all they say. Kept in memory and in `provider-limits.json` in the data folder, so the
 * usage dashboard has them after a restart. Only limit headers are kept, never cookies, ids, or anything else.
 * A separate in-memory weak map correlates terminal assistant messages to their own response headers for auto-resume.
 */
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ProviderLimit = {
    /** When the latest response came. */
    at: number;
    status: number;
    /** Its rate-limit headers, by lower-case name. */
    headers: Record<string, string>;
    /** The latest response that refused a request for a limit. */
    limited?: { at: number; headers: Record<string, string> };
};

/** Header names that carry limits: `x-ratelimit-*`, `anthropic-ratelimit-*`, quotas, and Codex's used percents. */
const LIMIT_HEADER = /ratelimit|rate-limit|quota|^x-codex-(primary|secondary)-|^retry-after$/;
const MAX_HEADERS = 40;
const MAX_VALUE = 200;
const WRITE_AFTER_MS = 2000;

/** The limit headers of a response, and nothing else. */
export function limitHeaders(headers: Record<string, string>): Record<string, string> {
    const kept: Record<string, string> = {};

    for (const [name, value] of Object.entries(headers)) {
        const key = name.toLowerCase();

        if (Object.keys(kept).length >= MAX_HEADERS) {
            break;
        }

        if (
            LIMIT_HEADER.test(key) &&
            typeof value === "string" &&
            value.length <= MAX_VALUE &&
            /^[\w .:+\-/,=;]*$/.test(value)
        ) {
            kept[key] = value;
        }
    }

    return kept;
}

export class ProviderLimits {
    readonly #path: string;
    readonly #now: () => number;
    #limits: Record<string, ProviderLimit> = {};
    readonly #responses = new WeakMap<AssistantMessage, ProviderLimit>();
    #timer: NodeJS.Timeout | undefined;

    constructor(dataDir: string, now: () => number = Date.now) {
        this.#path = join(dataDir, "provider-limits.json");
        this.#now = now;

        try {
            const stored = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;

            if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
                this.#limits = stored as Record<string, ProviderLimit>;
            }
        } catch {
            // None yet, or unreadable: start empty.
        }
    }

    /** Each provider's latest limits. */
    all(): Readonly<Record<string, ProviderLimit>> {
        return structuredClone(this.#limits);
    }

    /** Request-specific correlation stays in memory: no conversation IDs or messages go into the header file. */
    forResponse(message: AssistantMessage): ProviderLimit | undefined {
        const limit = this.#responses.get(message);

        return limit === undefined ? undefined : structuredClone(limit);
    }

    correlate(message: AssistantMessage, limit: ProviderLimit): void {
        this.#responses.set(message, limit);
    }

    record(
        provider: string,
        response: { status: number; headers: Record<string, string> },
    ): ProviderLimit {
        const at = this.#now();
        const headers = limitHeaders(response.headers);
        const previous = this.#limits[provider];
        const next: ProviderLimit = { at, status: response.status, headers };

        if (response.status === 429) {
            next.limited = { at, headers };
        } else if (previous?.limited !== undefined) {
            next.limited = previous.limited;
        }

        this.#limits[provider] = next;
        this.#timer ??= setTimeout(() => void this.#write(), WRITE_AFTER_MS);
        this.#timer.unref?.();

        return next;
    }

    /** Write what is pending now, as the server closes. */
    async flush(): Promise<void> {
        if (this.#timer !== undefined) {
            clearTimeout(this.#timer);
            await this.#write();
        }
    }

    async #write(): Promise<void> {
        this.#timer = undefined;
        const temporary = `${this.#path}.tmp`;

        try {
            await writeFile(temporary, JSON.stringify(this.#limits), { mode: 0o600 });
            await rename(temporary, this.#path);
        } catch {
            // Only the dashboard after a restart misses them.
        }
    }
}

/**
 * pi-ai's own HTTP APIs, which report each response. Others get no callback: an extension's provider may refuse one
 * (Claude Bridge does, across its worker boundary), and a virtual model routes to a provider not known yet.
 */
const REPORTING_APIS = new Set([
    "anthropic-messages",
    "azure-openai-responses",
    "bedrock-converse-stream",
    "mistral-conversations",
    "openai-codex-responses",
    "openai-completions",
    "openai-responses",
    "pi-messages",
]);

/** Record the limits of every response Pi's model runtime gets: runs, compactions, and titles all stream through it. */
export function recordResponses(models: ModelRuntime, limits: ProviderLimits): void {
    const stream = models.streamSimple.bind(models);

    models.streamSimple = (model, context, options) => {
        if (!REPORTING_APIS.has(model.api)) {
            return stream(model, context, options);
        }

        let responseLimit: ProviderLimit | undefined;
        const events = stream(model, context, {
            ...options,
            onResponse: async (response, routed) => {
                try {
                    responseLimit = limits.record(routed.provider, response);
                } catch {
                    // Recording never fails a request.
                }

                await options?.onResponse?.(response, routed);
            },
        });

        // Registered before the caller awaits the terminal message, so its generation hook sees only this stream's
        // headers, even if another chat or title request has already overwritten the provider-wide dashboard sample.
        if (typeof events.result === "function") {
            void events.result().then(
                (message) => {
                    if (responseLimit !== undefined) {
                        limits.correlate(message, responseLimit);
                    }
                },
                () => {},
            );
        }

        return events;
    };
}
