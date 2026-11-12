/**
 * The relay's runtime. Its files are 0600, in `x.pocket-relay`, which Lancet Guard keeps Pi out of. Nothing here throws
 * into the server: a connector's error is its status.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
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
    target: number;
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

interface ConnectorState {
    /** `RelayContext.state`. */
    own: Record<string, unknown>;
    /** Oldest first. */
    pending: RelayEvent[];
    /** Newest last: a reply finds its event here. */
    recent: Heard[];
    /** Replies sent, by key: a call that runs again does not send twice. */
    replies: Record<string, { at: number; id?: string; sending?: boolean }>;
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
const MAX_REPLIES = 2000;
const MAX_OWN_STATE = 64 * 1024;
const HOUR = 3_600_000;
/** setTimeout's longest wait: a longer one fires at once. */
const TIMER_MAX = 2_147_483_647;
const RETRY_AFTER_MAX = 24 * HOUR;
const REPLY_LIFETIME = 7 * 24 * HOUR;
const BACKOFF_MIN = 5_000;
const BACKOFF_MAX = 15 * 60_000;
/** A stream that ran this long before it ended was well: its backoff starts again. */
const STABLE = 60_000;
const DELIVERY_RETRY_MIN = 15_000;
const DELIVERY_RETRY_MAX = 10 * 60_000;
const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

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

export function scrub(text: string, secrets: readonly string[]): string {
    let out = text;

    for (const secret of secrets) {
        if (secret.length >= 4) {
            out = out.split(secret).join("[secret]");
        }
    }

    return out.replace(/\s+/g, " ").trim().slice(0, 300);
}

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

/** Words before a credential, which would hide ordinary text. */
const SCHEME = /^(bearer|basic|bot|token|digest)$/i;

/** The longest secret value: what `host.hide` takes at most. */
export const MAX_SECRET = 4096;
/** The shortest value hidden: a shorter one would hide ordinary words. */
const MIN_SECRET = 4;

/** A value of lines (headers) gives each line's value and each long word too: a service may echo a header or token. */
export function secretsOf(config: ConnectorConfig, fields: readonly RelayField[]): string[] {
    const found = new Set<string>();

    for (const field of fields) {
        const value = field.type === "secret" ? config.values[field.name] : undefined;

        if (typeof value !== "string" || value.trim() === "") {
            continue;
        }

        found.add(value);

        for (const line of value.split(/\r?\n/)) {
            const part = (line.includes(":") ? line.slice(line.indexOf(":") + 1) : line).trim();

            found.add(part);

            const words = part.split(/\s+/);

            for (const [index, word] of words.entries()) {
                // A credential is the last word (after `Bearer`), or any long one.
                if (word.length >= 8 || (index === words.length - 1 && !SCHEME.test(word))) {
                    found.add(word);
                }
            }
        }
    }

    return [...found].filter((value) => value.length >= MIN_SECRET && value.length <= MAX_SECRET);
}

export function tooShort(value: string): boolean {
    return value.split(/\r?\n/).some((line) => {
        const part = (line.includes(":") ? line.slice(line.indexOf(":") + 1) : line).trim();
        const last = part.split(/\s+/).at(-1) ?? "";

        return (
            part !== "" &&
            (part.length < MIN_SECRET || (last.length < MIN_SECRET && !SCHEME.test(last)))
        );
    });
}

function valuesOf(config: ConnectorConfig, fields: readonly RelayField[]): RelayValues {
    const values: Record<string, string | number | boolean | undefined> = {};

    for (const field of fields) {
        values[field.name] = config.values[field.name] ?? field.default;
    }

    return Object.freeze(values);
}

/** The relays of each folder in this process that have not stopped: one module version's, then the next's. */
function aliveIn(folder: string): Set<Promise<void>> {
    const key = Symbol.for("pocket-relay.alive");
    const all = ((globalThis as Record<symbol, unknown>)[key] ??= new Map()) as Map<
        string,
        Set<Promise<void>>
    >;
    let alive = all.get(folder);

    if (alive === undefined) {
        alive = new Set();
        all.set(folder, alive);
    }

    return alive;
}

async function save(path: string, data: unknown): Promise<void> {
    const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;

    try {
        await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
        await rename(temporary, path);
    } catch (error) {
        await unlink(temporary).catch(() => {});

        throw error;
    }

    await chmod(path, 0o600).catch(() => {});
}

function load<T>(path: string, empty: T): T {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
        return empty;
    }
}

/** Never rejects. */
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

        const timer = setTimeout(done, Math.min(TIMER_MAX, Math.max(0, ms || 0)));

        signal.addEventListener("abort", done, { once: true });
    });
}

/** Never rejects, and leaves no timer. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
    const waited = new AbortController();

    await Promise.race([promise.catch(() => {}), sleep(ms, waited.signal)]);
    waited.abort();
}

const backoff = (failures: number, min: number, max: number): number =>
    Math.min(max, min * 2 ** Math.max(0, failures - 1)) * (1 + Math.random() * 0.2);

export interface RelayOptions {
    folder: string;
    inbox: () => InboxApi | undefined;
    log: (line: string) => void;
    onStatus: (id: string, status: Status) => void;
    hide: (values: { value: string; label: string }[]) => () => void;
    now?: () => number;
}

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
                // A service's retry-after is a floor, not the wait: one of 0, or 1 s each time, still backs off.
                const wait = Math.min(
                    RETRY_AFTER_MAX,
                    Math.max(
                        retryAfter ?? 0,
                        backoff(
                            failures,
                            retryAfter === undefined ? BACKOFF_MIN : 1000,
                            BACKOFF_MAX,
                        ),
                    ),
                );

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

export class Relay {
    readonly #options: RelayOptions;
    readonly #kinds = new Map<string, RelayConnector>();
    readonly #runners = new Map<string, Runner>();
    readonly #connectorsFile: string;
    readonly #stateFile: string;
    #configs: Record<string, ConnectorConfig> = {};
    #states: Record<string, ConnectorState> = {};
    #writing: Promise<void> = Promise.resolve();
    #dirty = false;
    #written = true;
    #loaded = false;
    readonly #replies = new AbortController();
    #stopped = false;
    /** The values hidden so far, and how to stop: an old value stays hidden until the relay stops, as core's do. */
    readonly #hidden = new Set<string>();
    readonly #unhides: (() => void)[] = [];
    /** Whether every secret is hidden: until it is, no connector runs and no reply goes. */
    #safe = true;
    /** Deliveries under way: a stop waits for them, so none outlives the relay. */
    readonly #delivering = new Set<Promise<unknown>>();
    /** After the last write at a stop: nothing writes the files again. */
    #closed = false;
    readonly #replying = new Map<string, Promise<string>>();
    /** Settles when this relay stops: the next one in the process waits for it before it reads the files. */
    readonly #ended: Promise<void>;
    #end: () => void = () => {};
    /**
     * Settles when the files are read and the connectors started. A module's new version loads before the old one's
     * cleanups run (`reload.ts`): it waits for every relay of this folder still running, so two never write the files.
     */
    readonly ready: Promise<void>;

    constructor(options: RelayOptions) {
        this.#options = options;
        mkdirSync(options.folder, { recursive: true, mode: 0o700 });
        this.#connectorsFile = join(options.folder, "connectors.json");
        this.#stateFile = join(options.folder, "state.json");
        this.#ended = new Promise<void>((resolve) => {
            this.#end = resolve;
        });

        const alive = aliveIn(options.folder);
        const before = [...alive];

        alive.add(this.#ended);
        void this.#ended.then(() => alive.delete(this.#ended));
        this.ready = Promise.all(before).then(() => {
            if (this.#stopped) {
                return;
            }

            this.#configs = load(this.#connectorsFile, { connectors: {} }).connectors ?? {};
            this.#states = load(this.#stateFile, { connectors: {} }).connectors ?? {};
            this.#loaded = true;
            this.#safe = this.#hide();
            this.start();
        });
    }

    now(): number {
        return (this.#options.now ?? Date.now)();
    }

    log(line: string): void {
        this.#options.log(`relay: ${line}`);
    }

    register(connector: RelayConnector): () => void {
        const checked = checkConnector(connector);

        if (this.#kinds.has(checked.kind)) {
            throw new Error(`relay: a connector of kind ${checked.kind} is registered already`);
        }

        this.#kinds.set(checked.kind, checked);
        this.#safe = this.#hide() && this.#safe;
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

        if (!this.#safe) {
            return { state: "failed", text: "its secrets cannot be hidden from Pi", ...counts };
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
        // Before its files are read, a relay has nothing of its own to keep, and must not write over them.
        if (!this.#loaded || this.#closed) {
            return this.#writing;
        }

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
                this.#written = true;
            } catch (error) {
                this.#written = false;
                this.log(`its files could not be written: ${message(error)}`);
            }
        });

        return this.#writing;
    }

    /** False when it failed: what was hidden before stays hidden. */
    #hide(configs: readonly ConnectorConfig[] = Object.values(this.#configs)): boolean {
        const values = configs.flatMap((config) => {
            const fields = this.#kinds.get(config.kind)?.fields;

            // A kind not loaded yet: hide each value that looks like a key, to be safe.
            return fields === undefined
                ? Object.values(config.values).filter(
                      (value): value is string =>
                          typeof value === "string" &&
                          value.length >= 12 &&
                          value.length <= MAX_SECRET &&
                          !/\s/.test(value) &&
                          !/^https?:/i.test(value),
                  )
                : secretsOf(config, fields);
        });
        const fresh = [...new Set(values)].filter((value) => !this.#hidden.has(value));

        if (fresh.length === 0) {
            return true;
        }

        try {
            this.#unhides.push(
                this.#options.hide(fresh.map((value) => ({ value, label: "secret relay" }))),
            );
        } catch (error) {
            this.log(`its secrets could not be hidden: ${message(error)}`);

            return false;
        }

        fresh.forEach((value) => this.#hidden.add(value));

        return true;
    }

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
                (Array.isArray(event.attachments) ? event.attachments : []).length === 0
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

            if (!trusted && runner.connector.authorLimit !== false) {
                const previous = Object.hasOwn(state.authors, event.author.id)
                    ? state.authors[event.author.id]!
                    : [];
                const times = previous.filter((at) => now - at < HOUR);

                if (times.length >= config.perAuthor) {
                    state.dropped += 1;
                    state.lastError = `A message was dropped: its author sent more than ${config.perAuthor} in an hour.`;
                    state.lastErrorAt = now;
                    changed = true;
                    continue;
                }

                Object.defineProperty(state.authors, event.author.id, {
                    value: [...times, now],
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
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

        // A write that failed before is tried again: what it held is not stored until one works.
        if (changed || !this.#written) {
            await this.persist();
            runner.wake();
            this.changed(config.id);
        }

        if (!this.#written) {
            throw new Error("The relay could not write its files, so the events are not stored.");
        }
    }

    /** `retry`: the session cannot take it now, and it stays first in the queue. */
    deliver(config: ConnectorConfig, event: RelayEvent): Promise<"done" | "retry"> {
        const delivering = this.#deliver(config, event);

        this.#delivering.add(delivering);
        void delivering.finally(() => this.#delivering.delete(delivering)).catch(() => {});

        return delivering;
    }

    async #deliver(config: ConnectorConfig, event: RelayEvent): Promise<"done" | "retry"> {
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

        let payload: string;

        // An event it cannot render (a connector's odd field) is dropped: tried again, it would hold up the queue.
        try {
            payload = payloadOf(event);
        } catch (error) {
            this.failed(
                config.id,
                `A message was dropped: ${this.scrub(config, message(error))}`,
                false,
            );

            return finish("dropped");
        }

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
                payload,
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

    instructions(config: ConnectorConfig): string {
        const kind = this.#kinds.get(config.kind);
        const own = config.instructions.trim() || RELAY_INSTRUCTIONS;

        return typeof kind?.reply === "function"
            ? `${own}\n\nTo answer, call relay_reply with connector "${config.name}" and reply_to set to the event id. Your answer goes to the people there: never put secrets or private data in it.`
            : `${own}\n\nThis connector only listens: there is no way to answer there.`;
    }

    boundTo(target: number): ConnectorConfig[] {
        return this.configs().filter((config) => config.target === target);
    }

    async reply(
        config: ConnectorConfig,
        request: { text: string; replyTo?: string; key: string },
        signal: AbortSignal,
    ): Promise<string> {
        await this.ready;

        const connector = this.#kinds.get(config.kind);

        if (connector === undefined) {
            throw new Error(`No ${config.kind} connector is loaded now.`);
        }

        if (typeof connector.reply !== "function") {
            throw new Error(`The ${connector.label} connector only listens: it cannot reply.`);
        }

        if (this.#stopped) {
            throw new Error("The relay is stopping. Try again in a moment.");
        }

        if (!this.#safe) {
            throw new Error("The relay could not hide its secrets from Pi, so it sends nothing.");
        }

        const running = this.#replying.get(request.key);

        if (running !== undefined) {
            return running;
        }

        const sending = this.#send(
            config,
            connector as RelayConnector & { reply: NonNullable<RelayConnector["reply"]> },
            request,
            signal,
        ).finally(() => this.#replying.delete(request.key));

        this.#replying.set(request.key, sending);

        return sending;
    }

    async #send(
        config: ConnectorConfig,
        connector: RelayConnector & { reply: NonNullable<RelayConnector["reply"]> },
        request: { text: string; replyTo?: string; key: string },
        signal: AbortSignal,
    ): Promise<string> {
        const state = this.stateOf(config.id);
        const kept = Object.hasOwn(state.replies, request.key)
            ? state.replies[request.key]
            : undefined;

        if (kept !== undefined && kept.sending !== true) {
            return "Sent already.";
        }

        // A send a restart cut off: a service that sends a key once gets it again; any other might show it twice.
        if (kept !== undefined && connector.idempotentReply !== true) {
            return "This reply may have gone out already (an earlier send failed or was cut off), so it was not sent again.";
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

        state.replies[request.key] = { at: this.now(), sending: true };
        await this.persist();

        // Without the mark on disk, a restart in the send could send it twice.
        if (!this.#written) {
            delete state.replies[request.key];

            throw new Error("The relay could not write its files, so the reply was not sent.");
        }

        try {
            answer = await connector.reply(
                {
                    values,
                    signal: AbortSignal.any([
                        signal,
                        this.#replies.signal,
                        AbortSignal.timeout(30_000),
                    ]),
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
            // The mark stays: the service may have taken it before the answer failed. Only a connector whose service
            // sends a key once sends it again.
            throw new Error(this.scrub(config, message(error)));
        }

        const id = typeof answer?.id === "string" ? answer.id.slice(0, 100) : undefined;

        state.replies[request.key] = { at: this.now(), ...(id === undefined ? {} : { id }) };

        // A call runs again only after a restart cut it off: a key a week old will not come again.
        const now = this.now();
        const keys = Object.keys(state.replies);

        for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REPLIES))) {
            if (now - state.replies[key]!.at > REPLY_LIFETIME) {
                delete state.replies[key];
            }
        }

        await this.persist();

        return "Sent.";
    }

    async put(config: ConnectorConfig): Promise<void> {
        await this.ready;

        const before = this.config(config.id);

        if (before === undefined && Object.keys(this.#configs).length >= LIMITS.connectors) {
            throw new Error(`The relay keeps ${LIMITS.connectors} connectors at most.`);
        }

        // A secret that cannot be hidden is not kept: Pi would see it in what the service echoes.
        if (!this.#hide([config])) {
            throw new Error("Its secrets cannot be hidden from Pi, so it was not saved.");
        }

        this.#configs[config.id] = config;

        if (!this.#safe && this.#hide()) {
            this.#safe = true;
            this.start();
        }

        await this.#stop(config.id);

        // An edit is the owner's answer to a fatal error: try again.
        delete this.stateOf(config.id).fatal;
        await this.persist();
        this.#start(config.id);
        this.changed(config.id);

        if (!this.#written) {
            throw new Error(
                "The relay could not write its files: the change is lost at a restart.",
            );
        }
    }

    async remove(id: string): Promise<boolean> {
        await this.ready;

        if (this.config(id) === undefined) {
            return false;
        }

        await this.#stop(id);
        delete this.#configs[id];
        delete this.#states[id];
        await this.persist();

        return true;
    }

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
            !this.#loaded ||
            !this.#safe ||
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
        await within(runner.done, 3000);
    }

    async stop(): Promise<void> {
        this.#stopped = true;

        try {
            this.#replies.abort();
            // A drop-in's reply that ignores its abort is not waited for long: the connectors stop all the same.
            await within(Promise.allSettled([...this.#replying.values()]), 3000);
            await Promise.all([...this.#runners.keys()].map((id) => this.#stop(id)));
            // A runner past its deadline may still deliver: its delivery ends before the secrets and the files go.
            await Promise.allSettled([...this.#delivering]);
            await this.persist();
            await this.#writing;
        } finally {
            this.#closed = true;
            this.#unhides.splice(0).forEach((unhide) => unhide());
            this.#hidden.clear();
            this.#end();
        }
    }

    running(): number {
        return this.#runners.size;
    }
}

/** The latest time a Date holds, in ms. */
const MAX_DATE = 8.64e15;

export function payloadOf(event: RelayEvent): string {
    const lines = [
        `event: ${event.id}`,
        ...(event.channelName !== undefined || event.channel !== undefined
            ? [
                  `channel: ${[event.channelName, event.channel === undefined ? undefined : `(${event.channel})`].filter((part) => part !== undefined).join(" ")}`,
              ]
            : []),
        ...(event.thread === undefined ? [] : [`thread: ${event.thread}`]),
        ...(typeof event.at === "number" && Math.abs(event.at) <= MAX_DATE
            ? [`sent: ${new Date(event.at).toISOString()}`]
            : []),
        ...(event.url === undefined ? [] : [`link: ${event.url}`]),
        ...(!Array.isArray(event.attachments) || event.attachments.length === 0
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
