/**
 * The rate limits providers report on Pi's own requests: the status and limit headers of the response behind each
 * terminal assistant message, kept in memory for `host.responseLimits`. Only limit headers are kept, never cookies,
 * ids, or anything else, and no conversation or message is stored with them.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ProviderLimit = {
    /** When the response came. */
    at: number;
    status: number;
    /** Its rate-limit headers, by lower-case name. */
    headers: Record<string, string>;
};

/** Header names that carry limits: `x-ratelimit-*`, `anthropic-ratelimit-*`, quotas, and Codex's used percents. */
const LIMIT_HEADER = /ratelimit|rate-limit|quota|^x-codex-(primary|secondary)-|^retry-after(-ms)?$/;
const MAX_HEADERS = 40;
const MAX_VALUE = 200;

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
    readonly #now: () => number;
    readonly #responses = new WeakMap<AssistantMessage, ProviderLimit>();

    constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    /** The limits of the response that ended in `message`, when its API reported it. */
    forResponse(message: AssistantMessage): ProviderLimit | undefined {
        const limit = this.#responses.get(message);

        return limit === undefined ? undefined : structuredClone(limit);
    }

    correlate(message: AssistantMessage, limit: ProviderLimit): void {
        this.#responses.set(message, limit);
    }

    record(response: { status: number; headers: Record<string, string> }): ProviderLimit {
        return {
            at: this.#now(),
            status: response.status,
            headers: limitHeaders(response.headers),
        };
    }
}

/**
 * pi-ai's own HTTP APIs, which report each response. Others get no callback: an extension's provider may refuse one
 * across a worker boundary, and a virtual model routes to a provider not known yet.
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
                    responseLimit = limits.record(response);
                } catch {
                    // Recording never fails a request.
                }

                await options?.onResponse?.(response, routed);
            },
        });

        // Registered before the caller awaits the terminal message, so its generation hook sees only this stream's
        // headers, even while other chats' requests to the same provider run.
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
