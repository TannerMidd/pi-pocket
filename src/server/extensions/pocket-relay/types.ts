/**
 * The relay's connector API: what a connector (built in, or from a drop-in through `web.use("pocket-relay")`) gives,
 * and what the relay gives it. Types only: a drop-in copies the shapes it needs (docs/extensions/relay.md).
 */

/** A field the owner fills in for one connector of this kind. A `secret` field never leaves the server. */
export interface RelayField {
    /** Letters, digits, and _, starting with a letter. */
    name: string;
    label: string;
    type: "text" | "secret" | "number" | "boolean" | "choice" | "textarea";
    description?: string;
    placeholder?: string;
    default?: string | number | boolean;
    required?: boolean;
    /** A secret of several lines (headers): the form shows a masked text area. */
    multiline?: boolean;
    min?: number;
    max?: number;
    choices?: { value: string; label: string }[];
}

export type RelayValues = Readonly<Record<string, string | number | boolean | undefined>>;

/** Who wrote a message, as the service says. `id` is what the owner lists as trusted. */
export interface RelayAuthor {
    id: string;
    name: string;
    /** A bot or a service's own post: the relay drops these, so it never hears itself. */
    bot?: boolean;
}

/** One thing that came: a chat message, a feed's item, an API's record. */
export interface RelayEvent {
    /** Unique in this connector, and the same when it comes again: the relay delivers each id once. */
    id: string;
    text: string;
    author: RelayAuthor;
    /** Where it came (a channel, a chat, a room): a reply goes there. */
    channel?: string;
    /** The channel's name, for Pi to read. */
    channelName?: string;
    /** A thread a reply goes into, when the service has threads. */
    thread?: string;
    /** It names the connector's own account (a mention), or it came in a direct message. */
    mentioned?: boolean;
    /** A link to it, when it has one. */
    url?: string;
    /** When it was sent, in ms since 1970. */
    at?: number;
    /** Attachments as one-line descriptions (a name, a type, a size): never their content. */
    attachments?: string[];
}

/** What a connector's code gets while it runs. */
export interface RelayContext {
    /** The connector's fields, secrets too, as the owner set them. */
    readonly values: RelayValues;
    /** What it saved last (`save`), across reloads and restarts: a cursor, a sequence. Empty at first. */
    readonly state: Readonly<Record<string, unknown>>;
    /** Keep `state` (JSON, 64 KB at most) for the next run. Replaces what was saved. */
    save(state: Record<string, unknown>): void;
    /**
     * Hand events to the relay. When the promise resolves, they are stored and will reach the session (unless a
     * filter drops them): save a cursor after it. It rejects only when the relay stops.
     */
    emit(events: readonly RelayEvent[]): Promise<void>;
    /** Aborted when the connector stops: disabled, edited, removed, or its module reloads. */
    readonly signal: AbortSignal;
    /** One short line in the connector's status (connected, resuming, …). No secrets. */
    status(text: string): void;
    /** A line in the server's log, with the connector's name. No secrets. */
    log(text: string): void;
    /** Wait `ms`, or less when the connector stops. */
    sleep(ms: number): Promise<void>;
}

/** What a reply sends: Pi's text, and where it goes. */
export interface RelayReply {
    text: string;
    /** The event it answers, when Pi named one: its channel and thread are the reply's. */
    to?: RelayEvent;
    /** Where it goes: the event's channel, else the connector's default. */
    channel?: string;
    thread?: string;
    /** The same for a call that runs again: a connector that can, sends it once (a Discord nonce, say). */
    key: string;
}

/** A connector: a kind of connection that the owner can add as many of as they want. */
export interface RelayConnector {
    /** Lowercase letters, digits, and `-`: `discord`, `my-service`. Unique among connectors. */
    kind: string;
    label: string;
    description?: string;
    fields: readonly RelayField[];
    /** It can tell mentions (`RelayEvent.mentioned`): the owner can then take only those. */
    mentions?: boolean;
    /**
     * poll: `poll` is called every `interval` seconds (the owner's `interval` field when the connector has one).
     * stream: `run` keeps a connection; the relay calls it again, with backoff, when it ends or throws.
     */
    shape: "poll" | "stream";
    /** Seconds between polls when the owner did not set one. Default 60; 10 at least. */
    interval?: number;
    /** Check the fields before they are saved: return a problem in words for the owner, or nothing. */
    check?(values: RelayValues): string | undefined;
    poll?(context: RelayContext): Promise<void>;
    run?(context: RelayContext): Promise<void>;
    /**
     * The service sends a reply once for its key (Discord's nonce, Matrix's transaction id): after a restart cut off a
     * send, the relay sends it again. Without it, the relay does not, so a reply is never shown twice.
     */
    idempotentReply?: boolean;
    /** Send a reply. Without it, the connector only listens. Returns the id the service gave it, if any. */
    reply?(
        context: Pick<RelayContext, "values" | "signal" | "log">,
        reply: RelayReply,
    ): Promise<{ id?: string } | void>;
}

/**
 * An error a connector throws to say how long to wait: `retryAfter` ms (a rate limit), or `fatal` (a bad token: the
 * connector stops until the owner edits it). Any other error backs off, longer each time.
 */
export class RelayError extends Error {
    readonly retryAfter: number | undefined;
    readonly fatal: boolean;

    constructor(message: string, options: { retryAfter?: number; fatal?: boolean } = {}) {
        super(message);
        this.retryAfter = options.retryAfter;
        this.fatal = options.fatal === true;
    }
}

/** A `RelayError`, or an error with the same fields from a drop-in that has its own class. */
export function relayErrorOf(error: unknown): { retryAfter?: number; fatal: boolean } {
    if (error === null || typeof error !== "object") {
        return { fatal: false };
    }

    const { retryAfter, fatal } = error as { retryAfter?: unknown; fatal?: unknown };

    return {
        ...(typeof retryAfter === "number" && Number.isFinite(retryAfter) ? { retryAfter } : {}),
        fatal: fatal === true,
    };
}
