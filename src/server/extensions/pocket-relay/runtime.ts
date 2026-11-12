/**
 * The relay's runtime: the owner's connectors and what each has heard, kept in two 0600 files of the module's data
 * folder (`x.pocket-relay`, which Lancet Guard keeps Pi out of); a runner for each connector that is on, which polls or
 * keeps a stream, and backs off when it fails; and a queue for each, kept on disk, that delivers what came to the bound
 * session through `host.inbox`, once for each event id. Nothing here throws into the server: a connector's error is its
 * status.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { InboxApi } from "../../host.ts";
import {
    type RelayConnector,
    type RelayContext,
    type RelayEvent,
    type RelayField,
    type RelayValues,
    relayErrorOf,
} from "./types.ts";

/** A connector the owner added. `values` holds its fields, secrets too: it never leaves the server as it is. */
export interface ConnectorConfig {
    id: string;
    name: string;
    kind: string;
    enabled: boolean;
    /** The session it delivers to. */
    target: number;
    /** The person Pi works for on what it delivers: the owner who saved it. */
    by: string;
    instructions: string;
    /** The ids of the owner's own accounts on the service: Pi reads them as trusted. */
    ownerIds: string[];
    mentionOnly: boolean;
    perHour: number;
    perAuthor: number;
    values: Record<string, string | number | boolean>;
    createdAt: number;
    updatedAt: number;
}

/** An event the relay heard and keeps for replies: no text. */
interface Heard {
    id: string;
    channel?: string;
    thread?: string;
    author: string;
    at: number;
}

/** What one connector has heard and done, across restarts. */
interface ConnectorState {
    /** The connector's own (`RelayContext.state`): a cursor, a session. */
    own: Record<string, unknown>;
    /** Events stored and not delivered yet, oldest first. */
    pending: RelayEvent[];
    /** The latest events delivered, newest last: a reply finds its event here. */
    recent: Heard[];
    /** Replies sent, by key: a call that runs again does not send twice. */
    replies: Record<string, { at: number; id?: string }>;
    /** When each author's recent messages came, for the limit per author. */
    authors: Record<string, number[]>;
    delivered: number;
    dropped: number;
    lastError?: string;
    lastErrorAt?: number;
    lastEventAt?: number;
    /** A fatal error (a bad token): the connector waits until the owner edits it. */
    fatal?: string;
}

export type StatusState =
    "off" | "starting" | "running" | "waiting" | "failed" | "stopped" | "no-connector";

export interface Status {
    state: StatusState;
    text?: string;
    lastError?: string;
    lastErrorAt?: number;
    lastEventAt?: number;
    delivered: number;
    dropped: number;
    pending: number;
}

export const LIMITS = {
    name: 60,
    instructions: 2000,
    ownerIds: 20,
    ownerId: 100,
    connectors: 50,
    perHour: { min: 1, max: 600, default: 30 },
    perAuthor: { min: 1, max: 120, default: 10 },
} as const;
const MAX_PENDING = 200;
const MAX_RECENT = 200;
const MAX_REPLIES = 200;
const MAX_OWN_STATE = 64 * 1024;
const HOUR = 3_600_000;
const BACKOFF_MIN = 5_000;
const BACKOFF_MAX = 15 * 60_000;
/** A stream that ran this long before it ended was well: its backoff starts again. */
const STABLE = 60_000;
const DELIVERY_RETRY_MIN = 15_000;
const DELIVERY_RETRY_MAX = 10 * 60_000;
const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** What Pi does with a message when the owner gave no instructions. */
export const RELAY_INSTRUCTIONS =
    "A message came through the relay. Read it. Answer it when it asks something of you, or when the owner's instructions say so.";

const fresh = (): ConnectorState => ({
    own: {},
    pending: [],
    recent: [],
    replies: {},
    authors: {},
    delivered: 0,
    dropped: 0,
});

const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/** Errors as the owner reads them: one line, short, with every secret value of the connector taken out. */
export function scrub(text: string, secrets: readonly string[]): string {
    let out = text;

    for (const secret of secrets) {
        if (secret.length >= 4) {
            out = out.split(secret).join("[secret]");
        }
    }

    return out.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** A connector checked as it registers: a mistake throws at once, where its author sees it. */
export function checkConnector(connector: RelayConnector): RelayConnector {
    if (connector === null || typeof connector !== "object") {
        throw new Error("relay: a connector is an object");
    }

    if (typeof connector.kind !== "string" || !KIND.test(connector.kind)) {
        throw new Error("relay: a connector's kind is lowercase letters, digits, and -");
    }

    if (typeof connector.label !== "string" || connector.label.trim() === "") {
        throw new Error(`relay: connector ${connector.kind} needs a label`);
    }

    if (
        connector.shape === "poll"
            ? typeof connector.poll !== "function"
            : connector.shape === "stream"
              ? typeof connector.run !== "function"
              : true
    ) {
        throw new Error(
            `relay: connector ${connector.kind} is shape "poll" with poll(), or "stream" with run()`,
        );
    }

    if (!Array.isArray(connector.fields)) {
        throw new Error(`relay: connector ${connector.kind} needs a list of fields`);
    }

    const names = new Set<string>();

    for (const field of connector.fields) {
        if (typeof field?.name !== "string" || !FIELD.test(field.name) || names.has(field.name)) {
            throw new Error(
                `relay: connector ${connector.kind} has a field without a good name, or one twice`,
            );
        }

        names.add(field.name);
    }

    return connector;
}

/** The secret fields' values of a connector: what is hidden, and scrubbed out of errors. */
export function secretsOf(config: ConnectorConfig, fields: readonly RelayField[]): string[] {
    return fields
        .filter((field) => field.type === "secret")
        .map((field) => config.values[field.name])
        .filter((value): value is string => typeof value === "string" && value !== "");
}

/** A field's value as the connector reads it: the owner's, else its default. */
function valuesOf(config: ConnectorConfig, fields: readonly RelayField[]): RelayValues {
    const values: Record<string, string | number | boolean | undefined> = {};

    for (const field of fields) {
        values[field.name] = config.values[field.name] ?? field.default;
    }

    return Object.freeze(values);
}

/** A file written whole or not at all, readable by its user alone. */
async function save(path: string, data: unknown): Promise<void> {
    const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;

    await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => {});
}

function load<T>(path: string, empty: T): T {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
        return empty;
    }
}

/** Waits `ms`, or less when `signal` aborts. Never rejects. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();

            return;
        }

        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };

        const timer = setTimeout(done, Math.max(0, ms));

        signal.addEventListener("abort", done, { once: true });
    });
}

const backoff = (failures: number, min: number, max: number): number =>
    Math.min(max, min * 2 ** Math.max(0, failures - 1)) * (1 + Math.random() * 0.2);

export interface RelayOptions {
    /** The module's data folder: `<dataDir>/x.pocket-relay`. */
    folder: string;
    inbox: () => InboxApi | undefined;
    log: (line: string) => void;
    /** A connector's status changed. */
    onStatus: (id: string, status: Status) => void;
    /** Secret values to hide from what Pi and people read. Returns how to stop hiding them. */
    hide: (values: { value: string; label: string }[]) => () => void;
    now?: () => number;
}

/** One connector that is on: its loop, its delivery queue, and how to stop both. */
class Runner {
    readonly abort = new AbortController();
    readonly done: Promise<void>;
    text = "starting";
    state: StatusState = "starting";
    #wake: (() => void) | undefined;
    readonly relay: Relay;
    readonly config: ConnectorConfig;
    readonly connector: RelayConnector;

    constructor(relay: Relay, config: ConnectorConfig, connector: RelayConnector) {
        this.relay = relay;
        this.config = config;
        this.connector = connector;
        this.done = Promise.all([this.#loop(), this.#deliver()]).then(() => {});
    }

    get signal(): AbortSignal {
        return this.abort.signal;
    }

    /** Wake the delivery queue: something came. */
    wake(): void {
        this.#wake?.();
    }

    #set(state: StatusState, text: string): void {
        this.state = state;
        this.text = text;
        this.relay.changed(this.config.id);
    }

    #context(): RelayContext {
        const relay = this.relay;
        const id = this.config.id;
        const values = valuesOf(this.config, this.connector.fields);

        return {
            values,
            get state() {
                return relay.stateOf(id).own;
            },
            save: (own) => {
                if (this.signal.aborted) {
                    return;
                }

                const text = JSON.stringify(own ?? {});

                if (text.length > MAX_OWN_STATE) {
                    this.relay.log(`${this.config.name}: its state is too large to keep`);

                    return;
                }

                relay.stateOf(id).own = JSON.parse(text) as Record<string, unknown>;
                relay.persist();
            },
            emit: async (events) => {
                if (this.signal.aborted) {
                    throw new Error("The connector stopped.");
                }

                await relay.take(this, events);
            },
            signal: this.signal,
            status: (text) => {
                if (!this.signal.aborted) {
                    this.#set("running", relay.scrub(this.config, String(text)).slice(0, 120));
                }
            },
            log: (text) =>
                relay.log(`${this.config.name}: ${relay.scrub(this.config, String(text))}`),
            sleep: (ms) => sleep(ms, this.signal),
        };
    }

    async #loop(): Promise<void> {
        const connector = this.connector;
        const context = this.#context();
        let failures = 0;

        while (!this.signal.aborted) {
            const started = Date.now();

            try {
                if (connector.shape === "poll") {
                    if (this.state !== "running") {
                        this.#set("running", "polling");
                    }

                    await connector.poll!(context);
                    failures = 0;
                    const every = Number(context.values.interval ?? connector.interval ?? 60);

                    await sleep(
                        Math.max(10, Number.isFinite(every) ? every : 60) * 1000,
                        this.signal,
                    );
                } else {
                    this.#set("running", "connecting");
                    await connector.run!(context);

                    // A stream that ends by itself connects again soon; one that keeps ending backs off. One that ran
                    // a while was well: its next drop starts the backoff again.
                    if (Date.now() - started > STABLE) {
                        failures = 0;
                    }

                    failures += 1;
                    await sleep(backoff(failures, 1000, BACKOFF_MAX), this.signal);
                }
            } catch (error) {
                if (this.signal.aborted) {
                    break;
                }

                const { fatal, retryAfter } = relayErrorOf(error);
                const text = this.relay.scrub(this.config, message(error));

                this.relay.failed(this.config.id, text, fatal);

                if (fatal) {
                    this.#set("stopped", "stopped: edit the connector to try again");

                    return;
                }

                if (Date.now() - started > STABLE) {
                    failures = 0;
                }

                failures += 1;
                const wait = retryAfter ?? backoff(failures, BACKOFF_MIN, BACKOFF_MAX);

                this.#set("waiting", `retrying in ${Math.ceil(wait / 1000)} s`);
                await sleep(wait, this.signal);
            }
        }
    }

    async #deliver(): Promise<void> {
        let failures = 0;

        while (!this.signal.aborted) {
            const next = this.relay.stateOf(this.config.id).pending[0];

            if (next === undefined) {
                await new Promise<void>((resolve) => {
                    const done = () => {
                        this.signal.removeEventListener("abort", done);
                        this.#wake = undefined;
                        resolve();
                    };

                    this.#wake = done;
                    this.signal.addEventListener("abort", done, { once: true });
                });
                continue;
            }

            const result = await this.relay.deliver(this.config, next);

            if (result === "retry") {
                failures += 1;
                await sleep(backoff(failures, DELIVERY_RETRY_MIN, DELIVERY_RETRY_MAX), this.signal);
            } else {
                failures = 0;
            }
        }
    }
}

/** The relay: connectors registered by kind, the owner's connectors, and a runner for each that is on. */
export class Relay {
    readonly #options: RelayOptions;
    readonly #kinds = new Map<string, RelayConnector>();
    readonly #runners = new Map<string, Runner>();
    readonly #connectorsFile: string;
    readonly #stateFile: string;
    #configs: Record<string, ConnectorConfig>;
    #states: Record<string, ConnectorState>;
    #writing: Promise<void> = Promise.resolve();
    #dirty = false;
    #stopped = false;
    #unhide: () => void = () => {};

    constructor(options: RelayOptions) {
        this.#options = options;
        mkdirSync(options.folder, { recursive: true, mode: 0o700 });
        this.#connectorsFile = join(options.folder, "connectors.json");
        this.#stateFile = join(options.folder, "state.json");
        this.#configs = load(this.#connectorsFile, { connectors: {} }).connectors ?? {};
        this.#states = load(this.#stateFile, { connectors: {} }).connectors ?? {};
        this.#hide();
    }

    now(): number {
        return (this.#options.now ?? Date.now)();
    }

    log(line: string): void {
        this.#options.log(`relay: ${line}`);
    }

    /** Add a kind of connector. Returns how to remove it, which stops its connectors. */
    register(connector: RelayConnector): () => void {
        const checked = checkConnector(connector);

        if (this.#kinds.has(checked.kind)) {
            throw new Error(`relay: a connector of kind ${checked.kind} is registered already`);
        }

        this.#kinds.set(checked.kind, checked);
        this.#hide();
        this.#startKind(checked.kind);

        return () => {
            if (this.#kinds.get(checked.kind) !== checked) {
                return;
            }

            this.#kinds.delete(checked.kind);

            for (const config of Object.values(this.#configs)) {
                if (config.kind === checked.kind) {
                    void this.#stop(config.id).then(() => this.changed(config.id));
                }
            }
        };
    }

    kinds(): RelayConnector[] {
        return [...this.#kinds.values()];
    }

    kind(kind: string): RelayConnector | undefined {
        return this.#kinds.get(kind);
    }

    configs(): ConnectorConfig[] {
        return Object.values(this.#configs).sort((a, b) => a.createdAt - b.createdAt);
    }

    config(id: string): ConnectorConfig | undefined {
        return Object.hasOwn(this.#configs, id) ? this.#configs[id] : undefined;
    }

    stateOf(id: string): ConnectorState {
        if (!Object.hasOwn(this.#states, id)) {
            this.#states[id] = fresh();
        }

        return this.#states[id]!;
    }

    status(id: string): Status {
        const config = this.config(id);
        const state = this.stateOf(id);
        const runner = this.#runners.get(id);
        const counts = {
            delivered: state.delivered,
            dropped: state.dropped,
            pending: state.pending.length,
            ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
            ...(state.lastErrorAt === undefined ? {} : { lastErrorAt: state.lastErrorAt }),
            ...(state.lastEventAt === undefined ? {} : { lastEventAt: state.lastEventAt }),
        };

        if (config === undefined || !config.enabled) {
            return { state: "off", ...counts };
        }

        if (!this.#kinds.has(config.kind)) {
            return {
                state: "no-connector",
                text: `no ${config.kind} connector is loaded`,
                ...counts,
            };
        }

        if (state.fatal !== undefined && runner === undefined) {
            return {
                state: "stopped",
                text: "stopped: edit the connector to try again",
                ...counts,
            };
        }

        return { state: runner?.state ?? "starting", text: runner?.text ?? "starting", ...counts };
    }

    changed(id: string): void {
        if (!this.#stopped) {
            this.#options.onStatus(id, this.status(id));
        }
    }

    scrub(config: ConnectorConfig, text: string): string {
        const fields = this.#kinds.get(config.kind)?.fields ?? [];

        return scrub(text, secretsOf(config, fields));
    }

    failed(id: string, text: string, fatal: boolean): void {
        const state = this.stateOf(id);

        state.lastError = text;
        state.lastErrorAt = this.now();

        if (fatal) {
            state.fatal = text;
        }

        this.log(`${this.config(id)?.name ?? id}: ${text}`);
        this.persist();
        this.changed(id);
    }

    /** Keep both files soon; writes run one at a time, and the last state wins. */
    persist(): Promise<void> {
        this.#dirty = true;
        this.#writing = this.#writing.then(async () => {
            if (!this.#dirty) {
                return;
            }

            this.#dirty = false;

            try {
                await mkdir(this.#options.folder, { recursive: true, mode: 0o700 });
                await save(this.#connectorsFile, { version: 1, connectors: this.#configs });
                await save(this.#stateFile, { version: 1, connectors: this.#states });
            } catch (error) {
                this.log(`its files could not be written: ${message(error)}`);
            }
        });

        return this.#writing;
    }

    #hide(): void {
        const values = Object.values(this.#configs).flatMap((config) => {
            // A kind not loaded yet: hide every text value that looks like a key, to be safe.
            const fields =
                this.#kinds.get(config.kind)?.fields ??
                Object.keys(config.values).map((name) => ({
                    name,
                    label: name,
                    type: "secret" as const,
                }));

            return secretsOf(config, fields)
                .filter((value) => value.length >= 8)
                .map((value) => ({ value, label: `secret relay ${config.name}` }));
        });
        const unhide = this.#unhide;

        this.#unhide = this.#options.hide(values);
        unhide();
    }

    /** Store events a connector heard, filtered: when this resolves, they will be delivered. */
    async take(runner: Runner, events: readonly RelayEvent[]): Promise<void> {
        const config = runner.config;
        const state = this.stateOf(config.id);
        const now = this.now();
        let changed = false;

        for (const event of Array.isArray(events) ? events : []) {
            if (
                event === null ||
                typeof event !== "object" ||
                typeof event.id !== "string" ||
                event.id === "" ||
                typeof event.author?.id !== "string"
            ) {
                this.log(`${config.name}: an event without an id or an author was dropped`);
                continue;
            }

            // The service's bots and the connector's own account: never heard, so it never hears itself.
            if (event.author.bot === true) {
                continue;
            }

            if (
                config.mentionOnly &&
                runner.connector.mentions === true &&
                event.mentioned !== true
            ) {
                continue;
            }

            if (
                (typeof event.text !== "string" || event.text.trim() === "") &&
                (event.attachments ?? []).length === 0
            ) {
                continue;
            }

            if (
                state.pending.some((each) => each.id === event.id) ||
                state.recent.some((each) => each.id === event.id)
            ) {
                continue;
            }

            const trusted = config.ownerIds.includes(event.author.id);

            if (!trusted) {
                const times = (state.authors[event.author.id] ?? []).filter(
                    (at) => now - at < HOUR,
                );

                if (times.length >= config.perAuthor) {
                    state.dropped += 1;
                    state.lastError = `A message was dropped: its author sent more than ${config.perAuthor} in an hour.`;
                    state.lastErrorAt = now;
                    changed = true;
                    continue;
                }

                state.authors[event.author.id] = [...times, now];
            }

            if (state.pending.length >= MAX_PENDING) {
                state.pending.shift();
                state.dropped += 1;
            }

            state.pending.push(JSON.parse(JSON.stringify(event)) as RelayEvent);
            state.lastEventAt = now;
            changed = true;
        }

        for (const [author, times] of Object.entries(state.authors)) {
            if (times.every((at) => now - at >= HOUR)) {
                delete state.authors[author];
            }
        }

        if (changed) {
            await this.persist();
            runner.wake();
            this.changed(config.id);
        }
    }

    /** Deliver one pending event: `retry` when the session cannot take it now (it stays first in the queue). */
    async deliver(config: ConnectorConfig, event: RelayEvent): Promise<"done" | "retry"> {
        const state = this.stateOf(config.id);
        const inbox = this.#options.inbox();

        const finish = (outcome: "delivered" | "dropped") => {
            state.pending = state.pending.filter((each) => each.id !== event.id);

            if (outcome === "delivered") {
                state.delivered += 1;
                state.recent = [
                    ...state.recent,
                    {
                        id: event.id,
                        ...(event.channel === undefined ? {} : { channel: event.channel }),
                        ...(event.thread === undefined ? {} : { thread: event.thread }),
                        author: event.author.id,
                        at: this.now(),
                    },
                ].slice(-MAX_RECENT);
            } else {
                state.dropped += 1;
            }

            void this.persist();
            this.changed(config.id);

            return "done" as const;
        };

        if (inbox === undefined) {
            this.failed(
                config.id,
                "This server needs a restart before the relay can deliver.",
                false,
            );

            return "retry";
        }

        try {
            await inbox.deliver(config.target as unknown as ConversationId, {
                by: config.by,
                via: `relay ${config.name}`,
                instructions: this.instructions(config),
                tag: "relay-message",
                attributes: { connector: config.name, kind: config.kind },
                sender: {
                    name: String(event.author.name ?? event.author.id),
                    id: event.author.id,
                    trusted: config.ownerIds.includes(event.author.id),
                },
                payload: payloadOf(event),
                key: `relay-${config.id}-${event.id}`,
                limit: { bucket: `relay:${config.id}`, perHour: config.perHour },
            });

            return finish("delivered");
        } catch (error) {
            const status = (error as { status?: unknown }).status;

            if (status === 429) {
                this.failed(
                    config.id,
                    `A message was dropped: the connector sends ${config.perHour} an hour at most.`,
                    false,
                );

                return finish("dropped");
            }

            if (status === 400) {
                this.failed(config.id, `A message was dropped: ${message(error)}`, false);

                return finish("dropped");
            }

            // 410: the session is gone, or its person cannot reach it; 409 and 503: not now. It waits in the queue.
            this.failed(config.id, `Not delivered yet: ${message(error)}`, false);

            return "retry";
        }
    }

    /** The owner's instructions, then how to reply, which the relay writes (outside the fence). */
    instructions(config: ConnectorConfig): string {
        const kind = this.#kinds.get(config.kind);
        const own = config.instructions.trim() || RELAY_INSTRUCTIONS;

        return typeof kind?.reply === "function"
            ? `${own}\n\nTo answer, call relay_reply with connector "${config.name}" and reply_to set to the event id. Your answer goes to the people there: never put secrets or private data in it.`
            : `${own}\n\nThis connector only listens: there is no way to answer there.`;
    }

    /** The connectors that deliver to a session. */
    boundTo(target: number): ConnectorConfig[] {
        return this.configs().filter((config) => config.target === target);
    }

    /** Send a reply through a connector, once for `key`. Returns what to tell Pi. */
    async reply(
        config: ConnectorConfig,
        request: { text: string; replyTo?: string; key: string },
        signal: AbortSignal,
    ): Promise<string> {
        const connector = this.#kinds.get(config.kind);
        const state = this.stateOf(config.id);

        if (connector === undefined) {
            throw new Error(`No ${config.kind} connector is loaded now.`);
        }

        if (typeof connector.reply !== "function") {
            throw new Error(`The ${connector.label} connector only listens: it cannot reply.`);
        }

        if (Object.hasOwn(state.replies, request.key)) {
            return "Sent already.";
        }

        const heard =
            request.replyTo === undefined
                ? undefined
                : state.recent.find((each) => each.id === request.replyTo);

        if (request.replyTo !== undefined && heard === undefined) {
            throw new Error(
                `No recent event ${JSON.stringify(request.replyTo).slice(0, 80)} on connector "${config.name}": use the event id of a message that came.`,
            );
        }

        const to: RelayEvent | undefined =
            heard === undefined
                ? undefined
                : {
                      id: heard.id,
                      text: "",
                      author: { id: heard.author, name: heard.author },
                      ...(heard.channel === undefined ? {} : { channel: heard.channel }),
                      ...(heard.thread === undefined ? {} : { thread: heard.thread }),
                  };
        const values = valuesOf(config, connector.fields);
        let answer: { id?: string } | void;

        try {
            answer = await connector.reply(
                {
                    values,
                    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                    log: (text) => this.log(`${config.name}: ${this.scrub(config, String(text))}`),
                },
                {
                    text: request.text,
                    ...(to === undefined ? {} : { to }),
                    ...(to?.channel === undefined ? {} : { channel: to.channel }),
                    ...(to?.thread === undefined ? {} : { thread: to.thread }),
                    key: request.key,
                },
            );
        } catch (error) {
            throw new Error(this.scrub(config, message(error)));
        }

        const id = typeof answer?.id === "string" ? answer.id.slice(0, 100) : undefined;

        state.replies[request.key] = { at: this.now(), ...(id === undefined ? {} : { id }) };

        const keys = Object.keys(state.replies);

        for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REPLIES))) {
            delete state.replies[key];
        }

        await this.persist();

        return "Sent.";
    }

    /** Save a connector (new or edited) and start or stop it to match. */
    async put(config: ConnectorConfig): Promise<void> {
        const before = this.config(config.id);

        if (before === undefined && Object.keys(this.#configs).length >= LIMITS.connectors) {
            throw new Error(`The relay keeps ${LIMITS.connectors} connectors at most.`);
        }

        await this.#stop(config.id);
        this.#configs[config.id] = config;

        // An edit is the owner's answer to a fatal error: try again.
        delete this.stateOf(config.id).fatal;
        this.#hide();
        await this.persist();
        this.#start(config.id);
        this.changed(config.id);
    }

    async remove(id: string): Promise<boolean> {
        if (this.config(id) === undefined) {
            return false;
        }

        await this.#stop(id);
        delete this.#configs[id];
        delete this.#states[id];
        this.#hide();
        await this.persist();

        return true;
    }

    /** Start every connector that is on and has its kind. */
    start(): void {
        for (const config of this.configs()) {
            this.#start(config.id);
        }
    }

    #startKind(kind: string): void {
        for (const config of this.configs()) {
            if (config.kind === kind) {
                this.#start(config.id);
                this.changed(config.id);
            }
        }
    }

    #start(id: string): void {
        const config = this.config(id);
        const connector = config === undefined ? undefined : this.#kinds.get(config.kind);

        if (
            this.#stopped ||
            config === undefined ||
            connector === undefined ||
            !config.enabled ||
            this.#runners.has(id) ||
            this.stateOf(id).fatal !== undefined
        ) {
            return;
        }

        const runner = new Runner(this, config, connector);

        this.#runners.set(id, runner);
        void runner.done
            .catch((error: unknown) => {
                this.log(
                    `${config.name} ended with an error: ${this.scrub(config, message(error))}`,
                );
            })
            .finally(() => {
                if (this.#runners.get(id) === runner) {
                    this.#runners.delete(id);
                    this.changed(id);
                }
            });
    }

    async #stop(id: string): Promise<void> {
        const runner = this.#runners.get(id);

        if (runner === undefined) {
            return;
        }

        this.#runners.delete(id);
        runner.abort.abort();
        // A connector that does not stop when asked is not waited for long.
        await Promise.race([
            runner.done.catch(() => {}),
            sleep(3000, new AbortController().signal),
        ]);
    }

    /** Stop everything: the module goes. */
    async stop(): Promise<void> {
        this.#stopped = true;
        await Promise.all([...this.#runners.keys()].map((id) => this.#stop(id)));
        await this.persist();
        this.#unhide();
    }

    running(): number {
        return this.#runners.size;
    }
}

/** What Pi reads between the fence's tags: where it came from, then the text. */
export function payloadOf(event: RelayEvent): string {
    const lines = [
        `event: ${event.id}`,
        ...(event.channelName !== undefined || event.channel !== undefined
            ? [
                  `channel: ${[event.channelName, event.channel === undefined ? undefined : `(${event.channel})`].filter((part) => part !== undefined).join(" ")}`,
              ]
            : []),
        ...(event.thread === undefined ? [] : [`thread: ${event.thread}`]),
        ...(typeof event.at === "number" && Number.isFinite(event.at)
            ? [`sent: ${new Date(event.at).toISOString()}`]
            : []),
        ...(event.url === undefined ? [] : [`link: ${event.url}`]),
        ...(event.attachments === undefined || event.attachments.length === 0
            ? []
            : [
                  `attachments: ${event.attachments
                      .slice(0, 10)
                      .map((each) => String(each).replace(/\s+/g, " ").slice(0, 120))
                      .join("; ")}`,
              ]),
    ];
    const text = String(event.text ?? "").slice(0, 6000);

    return `${lines.join("\n")}\n\n${text === "" ? "(no text)" : text}`;
}
