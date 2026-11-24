/**
 * The relay's runtime. Its files are 0600, in `x.pocket-relay`, which Lancet Guard keeps Pi out of. Nothing here throws
 * into the server: a connector's error is its status.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { InboxApi } from "../../host.ts";
import type { SurfacesRelayApi } from "../../surfaces/relay.ts";
import { MAX_REPLY_BYTES } from "./files.ts";
import { recoverRelay } from "./recovery.ts";
import {
    type RelayConnector,
    type RelayContext,
    type RelayEvent,
    type RelayField,
    type RelayFile,
    type RelayOutFile,
    type RelayOutbound,
    type RelayReceipt,
    type RelayTriage,
    type RelayTriageVerdict,
    type RelayValues,
    authenticatedAccount,
    isOwnerAccount,
    relayErrorOf,
} from "./types.ts";

/** A connector the owner added. `values` holds its fields, secrets too: it never leaves the server as it is. */
export interface ConnectorConfig {
    /** Server-assigned identity of this route. Older configuration files have none. */
    revision?: string;
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
    /** Reference in the session; the service id below is only for transport and deduplication. */
    reference: string;
    id: string;
    channel?: string;
    thread?: string;
    author: string;
    authenticatedAccount?: string;
    at: number;
    /** Its attachments that Pi can fetch, refs and all: they stay in this folder. */
    files?: RelayFile[];
}

interface ConnectorState {
    revision?: string;
    /** `RelayContext.state`. */
    own: Record<string, unknown>;
    /** Oldest first. */
    pending: RelayEvent[];
    /** Account proof by route-scoped event reference, never from the connector payload. */
    pendingAccounts?: Record<string, string>;
    /** Newest last: a reply finds its event here. */
    recent: Heard[];
    /** Replies sent, by key: a call that runs again does not send twice. */
    replies: Record<string, { at: number; id?: string; sending?: boolean; retired?: boolean }>;
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

type StatusState =
    "off" | "starting" | "running" | "waiting" | "failed" | "stopped" | "no-connector";

interface Status {
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

/** Attachments kept for each event, and the most one fetch downloads. */
export const MAX_FILES = 10;
export const MAX_FETCH = 25 * 1024 * 1024;
const HOUR = 3_600_000;
/** setTimeout's longest wait: a longer one fires at once. */
const TIMER_MAX = 2_147_483_647;
/** How long one triage hook call may take; past it, the delivery goes on unlabelled. */
const TRIAGE_CAP_MS = 10_000;
/** How many triage verdicts are kept by event id, so a delivery that retries is not triaged again. */
const MAX_VERDICTS = 200;
/** The longest triage label kept: it goes into the delivered message. */
const MAX_LABEL = 200;

/**
 * What a triage hook answered, as the relay uses it: `"drop"`, a label as one plain line (no line breaks or control
 * characters, so it cannot forge a line of the payload, and capped), or `"deliver"` for anything else.
 */
function cleanVerdict(verdict: unknown): RelayTriageVerdict {
    if (verdict === "drop") {
        return "drop";
    }

    const label = (verdict as { label?: unknown } | null | undefined)?.label;

    if (typeof label !== "string") {
        return "deliver";
    }

    const line = label
        .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
        .trim()
        .slice(0, MAX_LABEL)
        .trim();

    return line === "" ? "deliver" : { label: line };
}

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

const RELAY_INSTRUCTIONS =
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

/** A route change discards destinations, credentials' cursors, and pending work. Keep only counts and replay tombstones. */
function resetRoute(revision: string, previous: ConnectorState | undefined): ConnectorState {
    const state = fresh();

    state.revision = revision;

    if (previous !== undefined) {
        state.delivered = previous.delivered;
        state.dropped = previous.dropped + previous.pending.length;
        state.replies = Object.fromEntries(
            Object.entries(previous.replies).map(([key, mark]) => [
                key,
                { at: mark.at, retired: true },
            ]),
        );
    }

    return state;
}

function eventReference(
    config: ConnectorConfig,
    event: Pick<RelayEvent, "id" | "channel" | "thread">,
): string {
    return (
        "e-" +
        createHash("sha256")
            .update(JSON.stringify([config.revision, event.id, event.channel, event.thread]))
            .digest("base64url")
            .slice(0, 24)
    );
}

function sameRoute(a: ConnectorConfig, b: ConnectorConfig): boolean {
    return (
        a.kind === b.kind &&
        a.name === b.name &&
        a.enabled === b.enabled &&
        a.target === b.target &&
        a.by === b.by &&
        a.mentionOnly === b.mentionOnly &&
        isDeepStrictEqual(a.ownerIds, b.ownerIds) &&
        isDeepStrictEqual(a.values, b.values)
    );
}

const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

function scrub(text: string, secrets: readonly string[]): string {
    let out = text;

    for (const secret of secrets) {
        if (secret.length >= 4) {
            out = out.split(secret).join("[secret]");
        }
    }

    return out.replace(/\s+/g, " ").trim().slice(0, 300);
}

function checkConnector(connector: RelayConnector): RelayConnector {
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

    const limit = connector.authorLimit;

    if (
        limit !== undefined &&
        limit !== false &&
        !(typeof limit === "string" && names.has(limit))
    ) {
        throw new Error(
            `relay: connector ${connector.kind}'s authorLimit is false, or the name of one of its fields`,
        );
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

/** A header whose value is a credential: only such a value is refused when it is too short to hide. */
const CREDENTIAL_HEADER = /authorization|cookie|key|token|secret|auth|pass|session|signature/i;

/** A secret too short to hide. In `headers` (one `Name: value` on each line), only a credential header's value counts. */
export function tooShort(value: string, headers = false): boolean {
    return value.split(/\r?\n/).some((line) => {
        const colon = line.indexOf(":");

        if (headers && colon !== -1 && !CREDENTIAL_HEADER.test(line.slice(0, colon))) {
            return false;
        }

        const part = (colon === -1 ? line : line.slice(colon + 1)).trim();
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

async function save(path: string, text: string): Promise<void> {
    const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;

    try {
        await writeFile(temporary, `${text}\n`, { mode: 0o600 });
        await rename(temporary, path);
    } catch (error) {
        await unlink(temporary).catch(() => {});

        throw error;
    }

    await chmod(path, 0o600).catch(() => {});
}

/** Never rejects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

interface RelayOptions {
    folder: string;
    inbox: () => { deliver: NonNullable<InboxApi["deliverCurrent"]> } | undefined;
    /** Cards Pi shows in a chat (`surfaces/relay.ts`): a message that acts on one is answered here and not sent to Pi. */
    surfaces?: () => SurfacesRelayApi | undefined;
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
        this.done = Promise.resolve().then(async () => {
            await Promise.all([this.#loop(), this.#deliver()]);
        });
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
        const state = relay.stateOf(this.config.id);
        const values = valuesOf(this.config, this.connector.fields);

        return {
            values,
            get state() {
                return state.own;
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

                state.own = JSON.parse(text) as Record<string, unknown>;
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
                    this.abort.abort();

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
    /** Registration and start() must not run an edit still waiting for its write. */
    readonly #stored = new WeakSet<ConnectorConfig>();
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
    /** The triage hook a module set, or none: deliveries from untrusted senders pass it first. */
    #triage?: RelayTriage;
    /** The outbound hook a module set, or none: every reply passes it before it leaves. */
    #outbound?: RelayOutbound;
    /** Triage verdicts by connector and event id, oldest first: a delivery that retries keeps its verdict. */
    readonly #verdicts = new Map<string, RelayTriageVerdict>();
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
        this.ready = Promise.all(before).then(async () => {
            if (this.#stopped) {
                return;
            }

            const { configs, states } = recoverRelay(options.folder);
            let migrated = false;

            for (const config of Object.values(configs)) {
                if (config.revision !== undefined) {
                    continue;
                }

                const state = states[config.id]!;

                config.revision = randomUUID();
                states[config.id] = resetRoute(config.revision, state);
                migrated = true;

                if (state.fatal !== undefined) {
                    states[config.id]!.fatal = state.fatal;
                }
            }

            if (migrated) {
                // Stop waits for this write too, without letting persist() overwrite a failed recovery.
                const migration = this.#save(configs, states);

                this.#writing = migration.catch(() => {});
                await migration.catch(() => {
                    throw new Error(
                        "Relay recovery could not save its files. Check the relay folder and reload Relay.",
                    );
                });
            }

            if (!this.#stopped) {
                this.#configs = configs;
                this.#states = states;
                this.#safe = this.#hide();
                Object.values(configs).forEach((config) => this.#stored.add(config));
                this.#loaded = true;
                this.start();
            }
        });
        // Routes can await the rejection. A module with no requests still reports the failure safely.
        void this.ready.catch((error: unknown) => this.log(message(error)));
    }

    now(): number {
        return (this.#options.now ?? Date.now)();
    }

    log(line: string): void {
        this.#options.log(`relay: ${line}`);
    }

    /**
     * Set the hook that screens each delivery from a sender the owner did not mark as trusted, before it reaches
     * the session. The last set wins; the return unsets it. One call gets `TRIAGE_CAP_MS` at most: past it, or when
     * it fails, the relay delivers as if no hook was set.
     */
    setTriage(hook: RelayTriage): () => void {
        this.#triage = hook;

        return () => {
            if (this.#triage === hook) {
                this.#triage = undefined;
            }
        };
    }

    /**
     * Set the hook that screens each reply before it leaves, the path the `relay_reply` tool takes. The last set
     * wins; the return unsets it. One call gets `TRIAGE_CAP_MS` at most: past it, or when it fails, the reply goes
     * on as if no hook was set.
     */
    setOutbound(hook: RelayOutbound): () => void {
        this.#outbound = hook;

        return () => {
            if (this.#outbound === hook) {
                this.#outbound = undefined;
            }
        };
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

    current(config: ConnectorConfig): boolean {
        const runner = this.#runners.get(config.id);

        return (
            !this.#stopped &&
            this.#safe &&
            config.enabled === true &&
            this.config(config.id) === config &&
            runner?.config === config &&
            !runner.signal.aborted
        );
    }

    #signal(config: ConnectorConfig): AbortSignal {
        if (!this.current(config)) {
            throw new Error(
                "The relay connector changed or is not enabled. Nothing more can be sent.",
            );
        }

        return this.#runners.get(config.id)!.signal;
    }

    stateOf(id: string): ConnectorState {
        if (!Object.hasOwn(this.#states, id)) {
            this.#states[id] = fresh();
        }

        return this.#states[id]!;
    }

    heard(config: ConnectorConfig, reference: string): Heard | undefined {
        return this.current(config)
            ? this.stateOf(config.id).recent.find(
                  (each) =>
                      each.reference === reference && reference === eventReference(config, each),
              )
            : undefined;
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

    async #save(
        configs: Record<string, ConnectorConfig>,
        states: Record<string, ConnectorState>,
    ): Promise<void> {
        // Capture both files before either write yields. A later edit queues its own snapshot.
        const configText = JSON.stringify({ version: 1, connectors: configs });
        const stateText = JSON.stringify({
            version: 1,
            connectors: Object.fromEntries(Object.keys(configs).map((id) => [id, states[id]])),
        });

        await mkdir(this.#options.folder, { recursive: true, mode: 0o700 });
        await save(this.#connectorsFile, configText);
        await save(this.#stateFile, stateText);
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
                await this.#save(this.#configs, this.#states);
                this.#written = true;
            } catch {
                this.#written = false;
                this.log("its files could not be written; check the relay folder");
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
        const limit = runner.connector.authorLimit;
        const authorLimited =
            limit === undefined ||
            (typeof limit === "string" &&
                String(valuesOf(config, runner.connector.fields)[limit] ?? "").trim() !== "");
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
                (Array.isArray(event.attachments) ? event.attachments : []).length === 0 &&
                filesOf(event.files).length === 0
            ) {
                continue;
            }

            if (
                state.pending.some((each) => each.id === event.id) ||
                state.recent.some((each) => each.id === event.id)
            ) {
                continue;
            }

            const account = authenticatedAccount(runner.connector, event.author);
            const trusted = isOwnerAccount(config.ownerIds, account);

            if (!trusted && authorLimited) {
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
                const evicted = state.pending.shift()!;

                delete state.pendingAccounts?.[eventReference(config, evicted)];
                state.dropped += 1;
            }

            const copy = JSON.parse(JSON.stringify(event)) as RelayEvent;
            const files = filesOf(copy.files);

            const reference = eventReference(config, copy);

            if (account !== undefined) {
                (state.pendingAccounts ??= {})[reference] = account;
            } else {
                delete state.pendingAccounts?.[reference];
            }

            delete copy.files;
            state.pending.push(files.length === 0 ? copy : { ...copy, files });
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
        if (!this.current(config)) {
            return "done";
        }

        const signal = this.#signal(config);
        const state = this.stateOf(config.id);
        const inbox = this.#options.inbox();
        const reference = eventReference(config, event);
        const account = state.pending.includes(event)
            ? state.pendingAccounts?.[reference]
            : undefined;
        const authenticated = typeof account === "string" && account === event.author.id;
        const trusted = authenticated && isOwnerAccount(config.ownerIds, account);

        const finish = (outcome: "delivered" | "dropped") => {
            if (signal.aborted) {
                return "done" as const;
            }

            if (state.pending.includes(event)) {
                state.pending = state.pending.filter((each) => each !== event);
                delete state.pendingAccounts?.[reference];
            }

            if (outcome === "delivered") {
                state.delivered += 1;

                // A wait that ended (a busy session, a restart's first moments) is no longer an error.
                if (state.lastError?.startsWith("Not delivered yet") === true) {
                    delete state.lastError;
                    delete state.lastErrorAt;
                }

                state.recent = [
                    ...state.recent,
                    {
                        reference,
                        id: event.id,
                        ...(event.channel === undefined ? {} : { channel: event.channel }),
                        ...(event.thread === undefined ? {} : { thread: event.thread }),
                        author: event.author.id,
                        ...(authenticated ? { authenticatedAccount: account } : {}),
                        at: this.now(),
                        ...(event.files === undefined || event.files.length === 0
                            ? {}
                            : { files: event.files }),
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
            payload = payloadOf(
                event,
                reference,
                typeof this.#kinds.get(config.kind)?.fetch === "function",
            );
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

        // A reply to a card Pi showed here (`3`, `1 2`, `5: text`) is an action on it: the relay answers it itself.
        const surfaces = this.#options.surfaces?.();

        if (typeof surfaces?.confirm === "function") {
            try {
                const outcome = await surfaces.fromRelay(
                    config.target as unknown as ConversationId,
                    {
                        connector: config.id,
                        routeRevision: config.revision!,
                        isCurrent: () => !signal.aborted && this.current(config),
                        ...(event.channel === undefined ? {} : { channel: event.channel }),
                        ...(event.thread === undefined ? {} : { thread: event.thread }),
                        ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
                        eventId: `${config.revision}/${event.id}`,
                        text: event.text,
                        author: {
                            id: event.author.id,
                            name: String(event.author.name ?? event.author.id),
                        },
                        ownerIds: trusted ? [account] : [],
                        trusted,
                        by: config.by,
                    },
                );

                if (signal.aborted) {
                    return "done";
                }

                if (outcome.handled) {
                    const echo = await this.#say(
                        config,
                        event,
                        outcome.reply,
                        outcome.echo?.isCurrent,
                    );

                    // A reply to the echo of a card acts on the card too: the surface keeps its id. Whatever
                    // happens here, the action is done and the message is not Pi's.
                    if (
                        !signal.aborted &&
                        echo !== undefined &&
                        outcome.surface !== undefined &&
                        outcome.echo !== undefined
                    ) {
                        await surfaces
                            .echoed(
                                config.target as unknown as ConversationId,
                                outcome.surface,
                                echo,
                                outcome.echo,
                            )
                            .catch((error: unknown) =>
                                this.log(
                                    `${config.name}: an echo was not recorded: ${this.scrub(config, message(error))}`,
                                ),
                            );
                    }

                    return finish("delivered");
                }

                if (outcome.refusal !== undefined) {
                    await this.#say(config, event, outcome.refusal);
                }
            } catch (error) {
                this.log(
                    `${config.name}: a card's action failed: ${this.scrub(config, message(error))}`,
                );
            }
        }

        if (signal.aborted) {
            return "done";
        }

        // A triage hook a module set screens deliveries from senders the owner did not mark. It never holds the
        // queue: past its cap, or when it fails, the message goes on as it came.
        if (this.#triage !== undefined && !trusted) {
            const verdict = await this.#screen(config, event, this.#triage);

            if (signal.aborted) {
                return "done";
            }

            if (verdict === "drop") {
                this.failed(
                    config.id,
                    `A message from ${String(event.author.name ?? event.author.id)} was dropped by a triage hook.`,
                    false,
                );

                return finish("dropped");
            }

            if (typeof verdict === "object") {
                payload = `Triage: ${verdict.label}\n${payload}`;
            }
        }

        try {
            await inbox.deliver(
                config.target as unknown as ConversationId,
                {
                    by: config.by,
                    via: `relay ${config.name}`,
                    instructions: this.instructions(config),
                    tag: "relay-message",
                    attributes: { connector: config.name, kind: config.kind },
                    sender: {
                        name: String(event.author.name ?? event.author.id),
                        id: event.author.id,
                        trusted,
                    },
                    payload,
                    key: `relay-${config.revision}-${event.id}`,
                    limit: { bucket: `relay:${config.id}`, perHour: config.perHour },
                },
                () => {
                    signal.throwIfAborted();
                    this.#signal(config);
                },
            );

            return finish("delivered");
        } catch (error) {
            if (signal.aborted) {
                return "done";
            }

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

    /**
     * One screening call, with the relay's own cap: a hook that hangs, throws, or answers nothing it recognizes
     * delivers the message as if no hook was set.
     */
    async #screen(
        config: ConnectorConfig,
        event: RelayEvent,
        hook: RelayTriage,
    ): Promise<RelayTriageVerdict> {
        const key = `${config.revision}:${event.id}`;
        const known = this.#verdicts.get(key);

        if (known !== undefined) {
            return known;
        }

        const verdict = await this.#askTriage(config, event, hook);

        this.#verdicts.set(key, verdict);

        if (this.#verdicts.size > MAX_VERDICTS) {
            this.#verdicts.delete(this.#verdicts.keys().next().value!);
        }

        return verdict;
    }

    async #askTriage(
        config: ConnectorConfig,
        event: RelayEvent,
        hook: RelayTriage,
    ): Promise<RelayTriageVerdict> {
        let timer: NodeJS.Timeout | undefined;

        try {
            return cleanVerdict(
                await Promise.race([
                    hook({
                        connector: config.name,
                        kind: config.kind,
                        author: {
                            name: String(event.author.name ?? event.author.id),
                            id: event.author.id,
                        },
                        ...(event.channel === undefined ? {} : { channel: event.channel }),
                        text: event.text,
                        files: (event.files ?? []).map((file) => ({
                            name: file.name,
                            type: file.type ?? "file",
                        })),
                    }),
                    new Promise<RelayTriageVerdict>((resolve) => {
                        timer = setTimeout(() => resolve("deliver"), TRIAGE_CAP_MS);
                    }),
                ]),
            );
        } catch {
            return "deliver";
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * One reply through the outbound hook, with a triage call's cap: a hook that fails or runs long sends, so a
     * screen never holds a send back on its own account.
     */
    async #screenOutbound(
        config: ConnectorConfig,
        request: { text: string; replyTo?: string; key: string; files?: RelayOutFile[] },
        channel: string | undefined,
    ): Promise<"send" | "block"> {
        let timer: NodeJS.Timeout | undefined;

        try {
            return await Promise.race([
                this.#outbound!({
                    connector: config.name,
                    kind: config.kind,
                    ...(channel === undefined ? {} : { channel }),
                    text: request.text,
                    files: (request.files ?? []).map((file) => ({ name: file.name })),
                }),
                new Promise<"send">((resolve) => {
                    timer = setTimeout(() => resolve("send"), TRIAGE_CAP_MS);
                }),
            ]);
        } catch {
            return "send";
        } finally {
            clearTimeout(timer);
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
        return this.configs().filter(
            (config) => config.enabled === true && config.target === target,
        );
    }

    async reply(
        config: ConnectorConfig,
        request: {
            text: string;
            replyTo?: string;
            key: string;
            files?: RelayOutFile[];
            /** Called once a new send went out, with where and the service's id for it. */
            onSent?: (sent: RelayReceipt, isCurrent: () => boolean) => Promise<void>;
        },
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

        const files = request.files ?? [];

        if (files.length > 0 && connector.files === undefined) {
            throw new Error(
                `The ${connector.label} connector cannot send files yet: send text only, and nothing was sent.`,
            );
        }

        if (files.reduce((sum, file) => sum + file.data.byteLength, 0) > MAX_REPLY_BYTES) {
            throw new Error(
                `A reply sends ${mb(MAX_REPLY_BYTES)} of files in all at most: nothing was sent.`,
            );
        }

        if (
            files.length > (connector.files?.max ?? 0) ||
            files.some((file) => file.data.byteLength > (connector.files?.maxBytes ?? 0))
        ) {
            throw new Error(
                `The ${connector.label} connector sends ${connector.files?.max ?? 0} files of ${mb(connector.files?.maxBytes ?? 0)} each at most: nothing was sent.`,
            );
        }

        if (this.#stopped) {
            throw new Error("The relay is stopping. Try again in a moment.");
        }

        if (!this.#safe) {
            throw new Error("The relay could not hide its secrets from Pi, so it sends nothing.");
        }

        const route = this.#signal(config);
        const key = JSON.stringify([config.revision, request.key]);
        const running = this.#replying.get(key);

        if (running !== undefined) {
            return running;
        }

        const sending = this.#send(
            config,
            connector as RelayConnector & { reply: NonNullable<RelayConnector["reply"]> },
            request,
            AbortSignal.any([signal, route]),
        ).finally(() => this.#replying.delete(key));

        this.#replying.set(key, sending);

        return sending;
    }

    async #send(
        config: ConnectorConfig,
        connector: RelayConnector & { reply: NonNullable<RelayConnector["reply"]> },
        request: Parameters<Relay["reply"]>[1],
        signal: AbortSignal,
    ): Promise<string> {
        const state = this.stateOf(config.id);
        const kept = Object.hasOwn(state.replies, request.key)
            ? state.replies[request.key]
            : undefined;

        if (kept?.retired) {
            throw new Error(
                "This reply belongs to an earlier connector configuration. It was not sent again.",
            );
        }

        if (kept !== undefined && kept.sending !== true) {
            return "Sent already.";
        }

        // A send a restart cut off: a service that sends a key once gets it again; any other might show it twice.
        if (kept !== undefined && connector.idempotentReply !== true) {
            return "This reply may have gone out already (an earlier send failed or was cut off), so it was not sent again.";
        }

        const heard =
            request.replyTo === undefined ? undefined : this.heard(config, request.replyTo);

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

        // An outbound hook a module set screens the reply before it leaves. A block throws, so the caller hears that
        // nothing was sent; a hook that fails or runs long sends as if no hook was set. A reply to a message from an
        // owner is not screened: the owner is who the reply is for.
        if (
            this.#outbound !== undefined &&
            !(
                heard !== undefined &&
                heard.authenticatedAccount === heard.author &&
                isOwnerAccount(config.ownerIds, heard.authenticatedAccount)
            )
        ) {
            if ((await this.#screenOutbound(config, request, to?.channel)) === "block") {
                this.log(
                    `held a reply on ${config.name}: its screen read it as holding something the owner would not want outside`,
                );

                throw new Error(
                    `The relay held this reply: its screen read it as holding something the owner would not want outside. Nothing was sent. Send it again without that, or ask the owner to turn the relay's screening off.`,
                );
            }
        }

        signal.throwIfAborted();
        let answer: RelayReceipt | void;

        state.replies[request.key] = { at: this.now(), sending: true };
        await this.persist();

        // Without the mark on disk, a restart in the send could send it twice.
        if (!this.#written) {
            delete state.replies[request.key];

            throw new Error("The relay could not write its files, so the reply was not sent.");
        }

        // About 1 MB a second more for files: 100 MB has 222 seconds.
        const timeout = request.files?.length
            ? 120_000 +
              Math.ceil(request.files.reduce((sum, file) => sum + file.data.byteLength, 0) / 1024)
            : 30_000;

        signal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
        signal.throwIfAborted();

        try {
            answer = await connector.reply(
                {
                    values,
                    signal,
                    log: (text) => this.log(`${config.name}: ${this.scrub(config, String(text))}`),
                },
                {
                    text: request.text,
                    ...(request.onSent === undefined ? {} : { confirmDestination: true }),
                    ...(to === undefined ? {} : { to }),
                    ...(to?.channel === undefined ? {} : { channel: to.channel }),
                    ...(to?.thread === undefined ? {} : { thread: to.thread }),
                    key: request.key,
                    ...(request.files?.length ? { files: request.files } : {}),
                },
            );
        } catch (error) {
            // The mark stays: the service may have taken it before the answer failed. Only a connector whose service
            // sends a key once sends it again. Pi hears it too: a new call has a new key, so it could show twice.
            throw new Error(
                `${this.scrub(config, message(error)).replace(/[^.!?]$/, "$&.")} The reply may have gone out: do not send it again unless you know it did not.`,
            );
        }

        signal.throwIfAborted();
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

        if (request.onSent !== undefined) {
            signal.throwIfAborted();

            // A replay can get the receipt for the original text, not this freshly rendered card.
            if (kept?.sending) {
                return "Sent, but the card is not active: this send resumed an earlier attempt.";
            }

            if (
                !this.#written ||
                !answer?.channel?.trim() ||
                (to !== undefined && (to.channel !== answer.channel || to.thread !== answer.thread))
            ) {
                return "Sent, but the card is not active: its delivery destination was not confirmed.";
            }

            await request.onSent(answer, () => !signal.aborted && this.current(config));
        }

        return "Sent.";
    }

    /**
     * A short answer the relay gives itself, in the place an event came from. A connector that cannot reply says
     * nothing, and an answer that fails to send is only logged: the action it answers was done. It returns the id the
     * service gave the message, when it did.
     */
    async #say(
        config: ConnectorConfig,
        event: RelayEvent,
        text: string,
        canEcho?: () => boolean,
    ): Promise<string | undefined> {
        const connector = this.#kinds.get(config.kind);

        if (typeof connector?.reply !== "function" || !this.current(config)) {
            return undefined;
        }

        const signal = AbortSignal.any([this.#signal(config), AbortSignal.timeout(30_000)]);

        try {
            // The echo of a card holds the whole card, values typed in the app too: the outbound screen reads it as it
            // reads a reply of Pi's, and a block means nothing is sent.
            if (
                this.#outbound !== undefined &&
                (await this.#screenOutbound(
                    config,
                    { text, key: `surface-${config.revision}-${event.id}` },
                    event.channel,
                )) === "block"
            ) {
                this.log(`held an answer on ${config.name}: the outbound screen blocked it`);

                return undefined;
            }

            signal.throwIfAborted();

            if (canEcho !== undefined && !canEcho()) {
                return undefined;
            }

            const sent = await connector.reply(
                {
                    values: valuesOf(config, connector.fields),
                    signal,
                    log: (line) => this.log(`${config.name}: ${this.scrub(config, String(line))}`),
                },
                {
                    text,
                    confirmDestination: true,
                    to: { ...event, text: "" },
                    ...(event.channel === undefined ? {} : { channel: event.channel }),
                    ...(event.thread === undefined ? {} : { thread: event.thread }),
                    key: `surface-${config.revision}-${event.id}`,
                },
            );

            return !signal.aborted &&
                sent?.channel &&
                sent.channel === event.channel &&
                sent.thread === event.thread &&
                typeof sent.id === "string"
                ? sent.id
                : undefined;
        } catch (error) {
            this.log(
                `${config.name}: an answer was not sent: ${this.scrub(config, message(error))}`,
            );

            return undefined;
        }
    }

    /** Download attachment `index` (from 1) of a recent event. Its errors have no secrets and no links. */
    async fetch(
        config: ConnectorConfig,
        eventId: string,
        index: number,
        signal: AbortSignal,
    ): Promise<{ name: string; type: string; data: Uint8Array; checkCurrent: () => void }> {
        await this.ready;

        const connector = this.#kinds.get(config.kind);

        if (typeof connector?.fetch !== "function") {
            throw new Error(
                `The ${connector?.label ?? config.kind} connector cannot fetch attachments yet.`,
            );
        }

        if (this.#stopped || !this.#safe) {
            throw new Error("The relay cannot fetch now. Try again in a moment.");
        }

        signal = AbortSignal.any([signal, this.#signal(config), AbortSignal.timeout(120_000)]);
        signal.throwIfAborted();
        const heard = this.heard(config, eventId);

        if (heard === undefined) {
            throw new Error(
                `No recent event ${JSON.stringify(eventId).slice(0, 80)} on connector "${config.name}".`,
            );
        }

        const file = Number.isInteger(index) ? heard.files?.[index - 1] : undefined;

        if (file === undefined) {
            throw new Error(
                `Event ${eventId} has ${heard.files?.length ?? 0} attachments to fetch: give a number from 1.`,
            );
        }

        if ((file.size ?? 0) > MAX_FETCH) {
            throw new Error(
                `${file.name} is ${mb(file.size ?? 0)}: the relay fetches ${mb(MAX_FETCH)} at most.`,
            );
        }

        let got: { data: Uint8Array; type?: string };

        try {
            got = await connector.fetch(
                {
                    values: valuesOf(config, connector.fields),
                    signal,
                    log: (text) => this.log(`${config.name}: ${this.scrub(config, String(text))}`),
                },
                file,
                MAX_FETCH,
            );
        } catch (error) {
            throw new Error(
                `${file.name} could not be fetched: ${this.scrub(config, message(error)).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link]")}`,
            );
        }

        signal.throwIfAborted();

        if (!(got?.data instanceof Uint8Array) || got.data.byteLength > MAX_FETCH) {
            throw new Error(
                `${file.name} is larger than ${mb(MAX_FETCH)}, or empty: it was not kept.`,
            );
        }

        const type = (got.type ?? file.type ?? "application/octet-stream")
            .split(";")[0]!
            .trim()
            .toLowerCase();

        if (
            !/^[a-z]+\/[a-z0-9.+-]+$/.test(type) ||
            (type === "text/html" && file.type !== "text/html")
        ) {
            throw new Error(
                `${file.name} came as ${type.slice(0, 60) || "no type"}, not as the file it named: it was not kept.`,
            );
        }

        return {
            name: file.name,
            type,
            data: got.data,
            checkCurrent: () => {
                signal.throwIfAborted();
                this.#signal(config);
            },
        };
    }

    async put(config: ConnectorConfig): Promise<ConnectorConfig> {
        await this.ready;

        if (this.#stopped) {
            throw new Error("The relay stopped.");
        }

        const before = this.config(config.id);

        if (before === undefined && Object.keys(this.#configs).length >= LIMITS.connectors) {
            throw new Error(`The relay keeps ${LIMITS.connectors} connectors at most.`);
        }

        // A secret that cannot be hidden is not kept: Pi would see it in what the service echoes.
        if (!this.#hide([config])) {
            throw new Error("Its secrets cannot be hidden from Pi, so it was not saved.");
        }

        const stopping = this.#stop(config.id);
        const revision =
            before?.revision !== undefined && sameRoute(before, config)
                ? before.revision
                : randomUUID();
        const next = { ...config, revision };

        this.#configs[config.id] = next;

        if (this.#states[config.id]?.revision !== revision) {
            this.#states[config.id] = resetRoute(revision, this.#states[config.id]);
        }

        await stopping;

        if (this.config(config.id) !== next) {
            throw new Error("Another change replaced this connector.");
        }

        // An edit is the owner's answer to a fatal error: try again after the write.
        delete this.stateOf(config.id).fatal;
        await this.persist();

        if (!this.#written) {
            throw new Error(
                "The relay could not write its files: the change is lost at a restart.",
            );
        }

        if (this.config(config.id) !== next || this.#stopped) {
            throw new Error("The connector changed or the relay stopped during the save.");
        }

        this.#stored.add(next);

        if (!this.#safe && this.#hide()) {
            this.#safe = true;
            this.start();
        } else {
            this.#start(config.id);
        }

        this.changed(config.id);

        return next;
    }

    async remove(id: string): Promise<boolean> {
        await this.ready;

        if (this.#stopped) {
            throw new Error("The relay stopped.");
        }

        if (this.config(id) === undefined) {
            return false;
        }

        const stopping = this.#stop(id);

        delete this.#configs[id];
        delete this.#states[id];
        await stopping;
        await this.persist();

        if (!this.#written) {
            throw new Error(
                "The relay could not write its files: the change is lost at a restart.",
            );
        }

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
            !this.#stored.has(config) ||
            connector === undefined ||
            config.enabled !== true ||
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
            // A drop-in's reply that ignores its abort is not waited for long: the connectors stop all the same.
            await Promise.all([
                within(Promise.allSettled([...this.#replying.values()]), 3000),
                ...[...this.#runners.keys()].map((id) => this.#stop(id)),
            ]);
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

const mb = (bytes: number): string => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

/** What a connector gave as `files`, checked: a name, a ref, and nothing odd. */
function filesOf(files: unknown): RelayFile[] {
    return (Array.isArray(files) ? files : [])
        .filter(
            (file): file is RelayFile =>
                typeof file?.name === "string" &&
                typeof file.ref === "string" &&
                file.ref !== "" &&
                file.ref.length <= 4096,
        )
        .slice(0, MAX_FILES)
        .map((file) => ({
            name: file.name.replace(/\s+/g, " ").trim().slice(0, 120) || "file",
            ...(typeof file.type === "string" ? { type: file.type.slice(0, 100) } : {}),
            ...(typeof file.size === "number" && Number.isFinite(file.size)
                ? { size: file.size }
                : {}),
            ref: file.ref,
        }));
}

function payloadOf(event: RelayEvent, reference: string, fetchable: boolean): string {
    const files = fetchable ? filesOf(event.files) : [];

    const lines = [
        `event: ${reference}`,
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
        ...(files.length > 0
            ? [
                  `attachments (fetch one with relay_fetch, by its number): ${files
                      .map(
                          (file, index) =>
                              `${index + 1}. ${file.name} (${file.type ?? "unknown type"}, ${file.size ?? "?"} bytes)`,
                      )
                      .join("; ")}`,
              ]
            : !Array.isArray(event.attachments) || event.attachments.length === 0
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
