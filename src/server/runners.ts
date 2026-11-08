/**
 * Computers that run sessions' tools: each one's runner (`pi-pocket runner`, `src/runner/`) connects out to this server
 * over a WebSocket and relays Earendil's pi-env protocol to a pi-env daemon on that computer. Here, each computer has
 * one `RunnerLink`, which talks to its daemon as pi-env's own `Connection` does to a daemon it started; a session that
 * runs there gets a `RemoteExecutionEnv` on that link (`RunnerEnv`). The agent, models, keys, and history stay here.
 *
 * Offline is offline (`docs/runners.md`): while a computer is away, its daemon session is kept for as long as this server
 * runs, and requests and their answers wait for it, however long that is. Nothing fails because a computer is offline.
 * Only when its runner had to start a new daemon (it quit, or this server restarted) does what was in flight fail as
 * lost: those processes are gone.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
    type Connection,
    RemoteError,
    RemoteExecutionEnv,
    type RemoteInfo,
    type Reply,
    type RequestOptions,
} from "@earendil-works/pi-env";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import {
    type ControlMessage,
    LEGACY_GRACE_MS,
    FRAME,
    FrameSplitter,
    Inbox,
    LINK_PATH,
    LINK_PROTOCOL,
    LINK_SUBPROTOCOL,
    MAX_MESSAGE,
    CLOSE,
    Outbox,
    parseControl,
    readFrame,
    frame,
    type Confirm,
    type Confirmed,
    type Hello,
    type ApprovalState,
    type ApprovalNeeded,
    type SessionScope,
    type RunnerAction,
    type TaskRequest,
    type TaskResult,
    SESSION_FIELD,
    readStreamData,
    STREAM_DATA,
} from "../runner/protocol.ts";
import { LinkNetwork, NetError, type OpenOptions } from "./runner-network.ts";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import type { ConfigStore, StoredRunner, User } from "./config.ts";
import { HttpError } from "./errors.ts";
import { LinkLimits, type LinkLocks, WRONG_CODE } from "./link-limits.ts";

/**
 * The built-in extensions a session on another computer runs with: exactly these, in order. Drop-ins that say they work
 * there (`export const remoteSessions = true`) follow them (`App.remoteExtensions`); other drop-ins never load. Each
 * works through the session's environment, which is that computer's, or on app state only. Subagents and linked
 * sessions keep the computer, and codemode calls its tools without saving output on this server. The others (PiP, the
 * gallery, updates) are about this server itself, not a session's computer.
 */
export const REMOTE_EXTENSIONS = [
    "coding-tools",
    // Core's own: its hook takes the values extensions hide (`host.hide`) out of tool results.
    "pocket-core",
    "pocket-prompt",
    "pocket-guard",
    "pocket-ask",
    "pocket-ask-someone",
    "pocket-schedules",
    "pocket-tool-search",
    "pocket-subagents",
    "pocket-agent-teams",
    "pocket-codemode",
    "pocket-background",
    "pocket-goals",
    "pocket-plan",
    "pocket-memory",
    "pocket-triggers",
    // Its pages load through the computer (`runner-network.ts`), and it opens no files of this server.
    "pocket-browser",
    "pocket-artifacts",
    // Design renders here, with a bounded copy of the session folder (`design/mirror.ts`).
    "pocket-design",
] as const;

/** What a subagent of a session on another computer runs without: it starts no agents of its own, and asks nobody. */
export const REMOTE_SUBAGENT_WITHOUT: readonly string[] = [
    "pocket-subagents",
    "pocket-agent-teams",
    "pocket-ask",
];

/** How long a one-time link code works. */
export const CODE_MINUTES = 10;

/**
 * What another computer installs to get `pi-pocket runner`, as `npm install -g` takes it: this release from npm, or
 * `PI_POCKET_RUNNER_PACKAGE` (a fork's tarball, say) on a server that runs a build npm does not have.
 */
export function runnerPackage(): string {
    const given = process.env.PI_POCKET_RUNNER_PACKAGE?.trim();

    return given || "pi-pocket@latest";
}

/** Send an acknowledgement once this many bytes came in, or within ACK_MS. */
const ACK_BYTES = 256 * 1024;
const ACK_MS = 1000;

/** WebSocket pings: one every PING_MS; a link that answers none for SILENT_MS is closed. */
const PING_MS = 10_000;
const SILENT_MS = 30_000;

/**
 * How long a session waits for its computer to allow it. The runner gives up 10 s sooner, so its answer (or its
 * "nobody answered") comes back before this.
 */
const CONFIRM_MS = 120_000;

/** How long a runner has to say hello after it connects. */
const HELLO_MS = 10_000;

/** A computer, as people see it. */
export type RunnerView = {
    id: string;
    name: string;
    online: boolean;
    /** The runner asks before starting a session. */
    asks: boolean;
    /** Offline, with its work waiting for it (its daemon session is kept until it is back). */
    away: boolean;
    lastSeen?: number;
    os?: string;
    arch?: string;
    home?: string;
    version?: string;
    tools?: Hello["tools"];
    createdBy: string;
    /** Granted people, visible only in the owner's list. */
    users?: { id: string; name: string }[];
    approvals?: ApprovalState;
    questions?: ApprovalNeeded[];
};

function lost(message: string): RemoteError {
    return new RemoteError({ code: "unknown", message, lost: true });
}

/**
 * A page of a folder's entries (`readdir`) without the ones the daemon could not `lstat`. pi-env fails a whole listing
 * (`listDir`, `openDirReader`) for one such entry, as Node's `readdir` does; here a listing shows what it can read, so
 * the folder picker, the Files panel, and the agent's tools all see the rest. On Windows a file with a reserved name
 * (`nul`, `con`, `com1.txt`, made by a POSIX tool) is one: its `lstat` reaches the device, not the file, and fails
 * with `EISDIR`. The daemon sends no kind with a failed entry, so it is left out; reading it still fails, by itself.
 */
export function readableEntries(reply: Reply): Reply {
    const entries = reply.json.entries;

    if (!Array.isArray(entries)) {
        return reply;
    }

    const readable = entries.filter(
        (entry: unknown) => (entry as { error?: unknown } | null)?.error === undefined,
    );

    return readable.length === entries.length
        ? reply
        : { ...reply, json: { ...reply.json, entries: readable } };
}

type Pending = {
    resolve: (reply: Reply) => void;
    reject: (error: Error) => void;
    onEvent?: (json: Record<string, unknown>, payload: Uint8Array) => void;
};

/** One daemon session on the computer: its streams, its requests, and what its daemon said in `hello`. */
class LinkSession {
    readonly id = randomUUID();
    readonly outbox = new Outbox();
    readonly inbox = new Inbox();
    readonly splitter = new FrameSplitter();
    readonly pending = new Map<number, Pending>();
    live = true;
    ready!: Promise<RemoteInfo>;
    /** Whether its daemon has said hello: `ready` is settled, so `info` answers without the computer. */
    known = false;
    readonly number: number;

    constructor(number: number) {
        this.number = number;
    }
}

/**
 * The link to one computer's daemon. Has the part of pi-env's `Connection` that `RemoteExecutionEnv` uses (`info`,
 * `session`, `request`, `kill`, `close`), so the env works on it unchanged.
 */
export class RunnerLink {
    readonly id: string;
    readonly #runners: Runners;
    #session: LinkSession | undefined;
    #socket: WebSocket | undefined;
    #sessions = 0;
    #nextId = 1;
    #ackTimer: NodeJS.Timeout | undefined;
    #closed = false;
    /** Whether its runner answers `confirm` (it said so in `hello`): older runners do not. */
    #asks = false;
    /** Whether the runner understands `withdraw`. */
    #withdraws = false;
    #scoped = false;
    state: ApprovalState | undefined;
    readonly questions = new Map<string, ApprovalNeeded>();
    readonly #results = new Map<string, (message: ControlMessage) => void>();
    /** Unlike daemon requests, these survive a reset of the daemon session. */
    readonly #taskRequests = new Map<
        string,
        {
            message: TaskRequest;
            resolve: (result: TaskResult) => void;
            reject: (error: Error) => void;
        }
    >();
    /** The runner owns background tasks; absent on older runners. */
    tasks = false;
    /** Questions sent to its runner, waiting for `confirmed`. */
    readonly #questions = new Map<string, (answer: Confirmed) => void>();
    /** The network streams of the current connection, when its runner opens them (`hello.network`). */
    #network: LinkNetwork | undefined;
    /** The folder its runner keeps browser downloads in (`hello.downloads`); undefined: its temporary folder. */
    downloads: string | undefined;
    /** Who waits for the computer to be online with a daemon that said hello (`whenOnline`). */
    readonly #waiting = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

    constructor(id: string, runners: Runners) {
        this.id = id;
        this.#runners = runners;
    }

    get name(): string {
        return this.#runners.stored(this.id)?.name ?? "The computer";
    }

    /** Its system as it last said (`hello`), kept with the computer. */
    platform(): { os?: string; arch?: string } {
        const platform = this.#runners.stored(this.id)?.platform;

        return platform === undefined ? {} : { os: platform.os, arch: platform.arch };
    }

    get asks(): boolean {
        return this.#asks;
    }

    get online(): boolean {
        return this.#socket !== undefined;
    }

    /** Offline with work waiting: its daemon session is kept until it is back. */
    get away(): boolean {
        return this.#socket === undefined && this.#session?.live === true;
    }

    /**
     * Wait until the computer is online and its daemon said hello. A session's turn and each of its tool calls wait here
     * (`app.ts`), so Pi does not start on a message, or a tool, while its computer is offline. Ends when `signal` aborts,
     * and fails only when the computer was removed.
     */
    async whenOnline(signal?: AbortSignal): Promise<void> {
        for (;;) {
            if (this.#closed || this.#runners.stored(this.id) === undefined) {
                throw lost(`${this.name} was removed from this server`);
            }

            signal?.throwIfAborted();

            const session = this.#session;

            if (this.#socket !== undefined && session !== undefined && session.live) {
                try {
                    await session.ready;

                    return;
                } catch {
                    // That daemon failed its hello: wait for the next connection.
                }
            }

            await new Promise<void>((resolve, reject) => {
                const waiter = {
                    resolve: () => {
                        signal?.removeEventListener("abort", aborted);
                        resolve();
                    },
                    reject: (error: Error) => {
                        signal?.removeEventListener("abort", aborted);
                        reject(error);
                    },
                };

                const aborted = () => {
                    this.#waiting.delete(waiter);
                    reject(signal!.reason);
                };

                this.#waiting.add(waiter);
                signal?.addEventListener("abort", aborted, { once: true });
            });
        }
    }

    /** Tell whoever waits for the computer (`whenOnline`) to look again. */
    #wake(error?: Error): void {
        const waiting = [...this.#waiting];

        this.#waiting.clear();

        for (const waiter of waiting) {
            if (error === undefined) {
                waiter.resolve();
            } else {
                waiter.reject(error);
            }
        }
    }

    /**
     * What its daemon said in `hello`. Known after it first connected (also while it is offline since): then at once;
     * else when it is first online. pi-env asks for it before most operations.
     */
    async info(): Promise<RemoteInfo> {
        const session = this.#session;

        if (session?.live === true && session.known) {
            return session.ready;
        }

        await this.whenOnline();

        return this.#session!.ready;
    }

    /**
     * `info`, for what a person waits on (a panel, the folder picker): a 409 that says the computer is offline, at once,
     * rather than waiting for it.
     */
    async infoNow(): Promise<RemoteInfo> {
        if (!this.online) {
            throw new HttpError(
                409,
                `${this.name} is offline. It continues when its runner is back.`,
            );
        }

        return this.info();
    }

    async session(): Promise<number> {
        await this.info();

        return this.#ready().number;
    }

    async request(
        op: string,
        json: Record<string, unknown>,
        options: RequestOptions = {},
        scope?: SessionScope,
    ): Promise<Reply> {
        if (this.#scoped && scope !== undefined) {
            json = { ...json, [SESSION_FIELD]: scope };
        }

        if (options.session !== undefined) {
            const current = this.#session;

            if (current === undefined || current.number !== options.session || !current.live) {
                throw lost(`${this.name}: its connection was lost`);
            }

            return this.#answer(op, this.#send(current, op, json, options));
        }

        await this.info();

        return this.#answer(op, this.#send(this.#ready(), op, json, options));
    }

    /** The daemon's answer as the env gets it: a folder's page without entries it could not read. */
    async #answer(op: string, reply: Promise<Reply>): Promise<Reply> {
        return op === "readdir" ? readableEntries(await reply) : reply;
    }

    /** Kill one `exec` without aborting it. */
    kill(id: number, session: number): void {
        const current = this.#session;

        if (current?.number === session && current.live) {
            this.#write(current, frame(FRAME.cancel, id, { mode: "kill" }));
        }
    }

    /** The computer was removed: what runs there stops, and its runner is told to go for good. */
    remove(): void {
        this.#closed = true;

        if (this.#session !== undefined) {
            this.#end(this.#session, lost(`${this.name} was removed from this server`));
        }

        this.#wake(lost(`${this.name} was removed from this server`));

        for (const pending of this.#taskRequests.values()) {
            pending.reject(lost(`${this.name} was removed from this server`));
        }

        this.#taskRequests.clear();
        this.#drop(CLOSE.removed, "This computer was removed from the server");
    }

    /**
     * The server is stopping. Requests in flight stay unanswered: the process ends, and Pi Durable reports their tool
     * calls as interrupted when it starts again, as for local work. The runner reconnects and starts over.
     */
    shutdown(): void {
        this.#closed = true;
        this.#drop(1001, "The server is restarting");
    }

    /** The live session, after `info` waited for one; lost when its runner started over meanwhile. */
    #ready(): LinkSession {
        const session = this.#session;

        if (session === undefined || !session.live) {
            throw lost(`${this.name} restarted, so the command it was running stopped`);
        }

        return session;
    }

    #send(
        session: LinkSession,
        op: string,
        json: Record<string, unknown>,
        options: RequestOptions,
    ): Promise<Reply> {
        if (!session.live) {
            return Promise.reject(lost(`${this.name}: its connection was lost`));
        }

        const id = this.#nextId++;

        if (this.#nextId > 0xfffffff0) {
            this.#nextId = 1;
        }

        return new Promise<Reply>((resolve, reject) => {
            const onAbort = () => this.#write(session, frame(FRAME.cancel, id, {}));
            const done = () => options.signal?.removeEventListener("abort", onAbort);

            session.pending.set(id, {
                resolve: (value) => {
                    done();
                    resolve(value);
                },
                reject: (error) => {
                    done();
                    reject(error);
                },
                ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
            });
            options.signal?.addEventListener("abort", onAbort, { once: true });
            options.onStart?.(id, session.number);
            this.#write(session, frame(FRAME.request, id, { ...json, op }, options.payload));

            if (options.signal?.aborted === true) {
                onAbort();
            }
        });
    }

    /** Add bytes to the session's stream, and send them now when its runner is here. */
    #write(session: LinkSession, bytes: Buffer): void {
        if (!session.live) {
            return;
        }

        const message = session.outbox.write(bytes);

        if (this.#socket !== undefined && this.#session === session) {
            this.#socket.send(message);
        }
    }

    /** A runner connected and said hello: resume its session, or start a new one. */
    attach(socket: WebSocket, hello: Hello): void {
        if (this.#closed) {
            socket.close(CLOSE.removed, "Removed");

            return;
        }

        if (this.#socket !== undefined && this.#socket !== socket) {
            // The same computer connected again before the old link was noticed gone: the new one wins. The old one's
            // close handler still runs, to stop its pings; it changes nothing else once this is no longer its socket.
            this.#socket.close(CLOSE.replaced, "Replaced by a newer connection");
        }

        this.#socket = socket;
        this.#asks = hello.asks === true;
        this.#withdraws = hello.withdraws === true;
        this.#scoped = hello.approvals === true;
        this.tasks = hello.tasks === true;
        this.#runners.toolsSeen(this.id, hello.tools);

        this.#network?.drop();
        this.#network = hello.network === true ? this.#networkOf(socket) : undefined;
        this.downloads =
            typeof hello.downloads === "string" && hello.downloads !== ""
                ? hello.downloads
                : undefined;

        const network = this.#network;

        const current = this.#session;
        const resent =
            current !== undefined && current.live && hello.session === current.id
                ? current.outbox.resend(hello.received)
                : undefined;
        let session: LinkSession;

        if (current !== undefined && resent !== undefined) {
            session = current;
            this.#control({
                type: "welcome",
                session: session.id,
                resume: true,
                received: session.inbox.received,
                graceMs: LEGACY_GRACE_MS,
                ...(this.#scoped ? { approvals: true } : {}),
            });

            for (const message of resent) {
                socket.send(message);
            }

            this.#runners.log(`${this.name} is back; its work goes on.`);
        } else {
            if (current !== undefined) {
                this.#end(
                    current,
                    lost(`${this.name} restarted, so the command it was running stopped`),
                );
            }

            session = new LinkSession(++this.#sessions);
            this.#session = session;
            this.#control({
                type: "welcome",
                session: session.id,
                resume: false,
                received: 0,
                graceMs: LEGACY_GRACE_MS,
                ...(this.#scoped ? { approvals: true } : {}),
            });
            session.ready = this.#send(session, "hello", { protocol: 1 }, {}).then((reply) => {
                if (reply.json.protocol !== 1) {
                    throw lost(
                        `${this.name}: unsupported pi-env protocol ${String(reply.json.protocol)}`,
                    );
                }

                const info = reply.json as unknown as RemoteInfo;

                session.known = true;
                this.#runners.seen(this.id, info, hello.version);

                return info;
            });
            session.ready.then(
                () => this.#wake(),
                () => this.#wake(),
            );
            this.#runners.log(`${this.name} connected (pi-env session ${session.number}).`);
        }

        // Welcome always goes first. Replay requests whose result the previous connection lost.
        void session.ready
            .then(() => {
                if (this.#socket === socket) {
                    for (const pending of this.#taskRequests.values()) {
                        if (this.tasks) {
                            this.#control(pending.message);
                        } else {
                            pending.reject(
                                new HttpError(
                                    409,
                                    "Connect an updated runner on this computer first.",
                                ),
                            );
                        }
                    }
                }
            })
            .catch(() => {});
        this.#runners.changed();

        if (session.known) {
            this.#wake();
        }

        let silent = Date.now();
        const pinger = setInterval(() => {
            if (Date.now() - silent > SILENT_MS) {
                socket.terminate();

                return;
            }

            socket.ping();
        }, PING_MS);

        pinger.unref();
        socket.on("pong", () => (silent = Date.now()));
        socket.on("message", (data, binary) => {
            silent = Date.now();

            if (this.#socket !== socket) {
                return;
            }

            if (binary) {
                const bytes = toBuffer(data);
                const stream = bytes[0] === STREAM_DATA ? readStreamData(bytes) : undefined;

                if (stream !== undefined && network !== undefined) {
                    network.data(stream.id, stream.bytes);
                } else if (bytes[0] === STREAM_DATA) {
                    this.#drop(1002, "Stream data without network streams");
                } else {
                    this.#data(session, bytes);
                }
            } else {
                const message = parseControl(toBuffer(data).toString("utf8"));

                if (message?.type.startsWith("net-") === true && network !== undefined) {
                    network.message(message as Parameters<LinkNetwork["message"]>[0]);
                } else {
                    this.#onControl(session, message);
                }
            }
        });
        socket.on("close", () => {
            clearInterval(pinger);
            network?.drop();

            if (this.#socket !== socket) {
                return;
            }

            this.#socket = undefined;
            this.#network = undefined;
            this.questions.clear();
            this.#runners.changed();

            if (!session.live || this.#session !== session) {
                return;
            }

            this.#runners.log(`${this.name} went offline; its work waits until it is back.`);
        });
    }

    #onControl(session: LinkSession, message: ControlMessage | undefined): void {
        if (message?.type === "ack") {
            if (!session.outbox.acknowledge(message.received)) {
                this.#drop(1002, "Acknowledged bytes it was never sent");
            }
        } else if (message?.type === "confirmed") {
            this.questions.delete(message.id);
            this.#questions.get(message.id)?.(message);
            this.#runners.changed();
        } else if (message?.type === "approval-needed") {
            this.questions.set(message.id, message);
            this.#runners.changed();
        } else if (message?.type === "approval-ended") {
            this.questions.delete(message.id);
            this.#runners.changed();
        } else if (message?.type === "runner-state") {
            this.state = message.state;
            this.downloads = message.state.settings.downloads ?? undefined;
            this.#runners.changed();
        } else if (message?.type === "task-result") {
            this.#taskRequests.get(message.id)?.resolve(message);
        } else if (message?.type === "code-result" || message?.type === "runner-result") {
            if (message.type === "runner-result" && message.state !== undefined) {
                this.state = message.state;
            }

            this.#results.get(message.id)?.(message);
            this.#runners.changed();
        } else if (message?.type === "bye") {
            this.#runners.log(`${this.name} left: ${message.reason}`);
            this.#end(session, lost(`${this.name}: ${message.reason}`));
            this.#drop(1000, "Bye");
            this.#runners.changed();
        } else {
            this.#drop(1002, "Unexpected message");
        }
    }

    /** Bytes of the daemon's stream: complete frames go to their requests. */
    #data(session: LinkSession, message: Buffer): void {
        if (!session.live) {
            return;
        }

        const fresh = session.inbox.take(message);

        if (fresh === undefined) {
            this.#drop(1002, "A gap in the stream");

            return;
        }

        let frames: Buffer[];

        try {
            frames = session.splitter.push(fresh);
        } catch (error) {
            this.#end(session, lost(`${this.name}: ${(error as Error).message}`));
            this.#drop(1002, "Corrupt frame");

            return;
        }

        for (const whole of frames) {
            let parsed: ReturnType<typeof readFrame>;

            try {
                parsed = readFrame(whole);
            } catch (error) {
                this.#end(session, lost(`${this.name}: ${(error as Error).message}`));
                this.#drop(1002, "Corrupt frame");

                return;
            }

            this.#dispatch(session, parsed);
        }

        if (session.inbox.unacknowledged >= ACK_BYTES) {
            this.#ack(session);
        } else if (session.inbox.unacknowledged > 0 && this.#ackTimer === undefined) {
            this.#ackTimer = setTimeout(() => {
                this.#ackTimer = undefined;

                if (this.#session === session) {
                    this.#ack(session);
                }
            }, ACK_MS);
            this.#ackTimer.unref();
        }
    }

    #ack(session: LinkSession): void {
        if (this.#socket === undefined || !session.live) {
            return;
        }

        session.inbox.acknowledged();
        this.#control({ type: "ack", received: session.inbox.received });
    }

    #dispatch(session: LinkSession, parsed: ReturnType<typeof readFrame>): void {
        const { type, id, json, payload } = parsed;
        const pending = session.pending.get(id);

        if (type === FRAME.event) {
            pending?.onEvent?.(json, payload);

            return;
        }

        if ((type !== FRAME.result && type !== FRAME.error) || pending === undefined) {
            return;
        }

        session.pending.delete(id);

        if (type === FRAME.result) {
            pending.resolve({ json, payload, session: session.number });
        } else {
            pending.reject(new RemoteError(json));
        }
    }

    #control(message: ControlMessage): void {
        this.#socket?.send(JSON.stringify(message));
    }

    /**
     * Ask the computer whether a session may start there: its runner asks its person, or answers at once as its
     * settings say. Throws 403 with the computer's reason when it says no, and 409 when it is offline or does not
     * answer in time (the person was away). `asker`: the id of the person whose start waits, who may see and answer
     * its question (`Runners.mayAnswer`).
     */
    async confirm(
        question: Omit<Confirm, "type" | "id">,
        signal?: AbortSignal,
        asker?: string,
    ): Promise<void> {
        if (signal?.aborted) {
            throw new HttpError(409, "Cancelled.");
        }

        const asked = this.#runners.asking(question.session, asker);

        try {
            await this.#confirm(question, signal);
        } finally {
            asked();
        }
    }

    async #confirm(question: Omit<Confirm, "type" | "id">, signal?: AbortSignal): Promise<void> {
        if (this.#socket === undefined) {
            throw new HttpError(
                409,
                `${this.name} is offline. Start Pi Pocket's runner there, then try again.`,
            );
        }

        if (!this.#asks) {
            return;
        }

        const id = randomUUID();
        let timer: NodeJS.Timeout | undefined;
        let cancelled: (() => void) | undefined;
        const answer = await new Promise<Confirmed | undefined>((resolve, reject) => {
            timer = setTimeout(
                () => resolve(undefined),
                (this.state?.totp ? 300_000 : CONFIRM_MS) + 10_000,
            );

            cancelled = () => {
                this.#questions.delete(id);

                if (this.#withdraws) {
                    this.#control({ type: "withdraw", id });
                }

                reject(new HttpError(409, "Cancelled."));
            };

            signal?.addEventListener("abort", cancelled, { once: true });
            this.#questions.set(id, resolve);
            // Older runners close the link for an unknown kind. They can still ask a generic session question.
            this.#control({
                type: "confirm",
                id,
                ...question,
                ...(question.kind === "move" ? ({ kind: "new", move: true } as const) : {}),
            });
        }).finally(() => {
            clearTimeout(timer);
            this.#questions.delete(id);
            this.questions.delete(id);
            this.#runners.changed();

            if (cancelled !== undefined) {
                signal?.removeEventListener("abort", cancelled);
            }
        });

        if (signal?.aborted) {
            throw new HttpError(409, "Cancelled.");
        }

        if (answer === undefined) {
            throw new HttpError(
                409,
                `Nobody answered on ${this.name}. Approve the session there, or enter a code from your authenticator.`,
            );
        }

        if (!answer.allow) {
            throw new HttpError(403, answer.reason ?? `${this.name} did not allow the session.`);
        }
    }

    /** Codes are relayed only. Never keep them in config, session documents, or logs. */
    async approveCode(id: string, code: string): Promise<void> {
        const result = await this.#result(id, { type: "approval-code", id, code });

        if (result.type !== "code-result" || !result.allow) {
            throw new HttpError(400, "That code is wrong or used. Try the next one.");
        }
    }

    async action(request: RunnerAction): Promise<void> {
        const id = randomUUID();
        const result = await this.#result(id, { type: "runner-action", id, request });

        if (result.type !== "runner-result" || !result.ok) {
            throw new HttpError(
                400,
                result.type === "runner-result"
                    ? (result.reason ?? "The runner refused it.")
                    : "The runner refused it.",
            );
        }
    }

    async #result(id: string, message: ControlMessage): Promise<ControlMessage> {
        if (!this.online || !this.#scoped) {
            throw new HttpError(409, "Connect an updated runner on this computer first.");
        }

        if (this.#results.has(id)) {
            throw new HttpError(409, "A code is already being checked.");
        }

        let timer: NodeJS.Timeout | undefined;

        return new Promise<ControlMessage>((resolve, reject) => {
            timer = setTimeout(
                () => reject(new HttpError(409, "The computer did not answer.")),
                15_000,
            );
            this.#results.set(id, resolve);
            this.#control(message);
        }).finally(() => {
            clearTimeout(timer);
            this.#results.delete(id);
        });
    }

    async taskStart(
        request: Omit<Extract<TaskRequest, { op: "start" }>, "type" | "id" | "op">,
    ): Promise<number> {
        const result = await this.#taskRequest({
            ...request,
            type: "task",
            id: randomUUID(),
            op: "start",
        });

        if (result.pid === undefined) {
            throw new Error("The background task did not return its process id.");
        }

        return result.pid;
    }

    /** The runner's tasks of a session; `ended`: its shell ended, while what it started may still run. */
    async taskList(
        permission: string,
    ): Promise<{ task: string; pid: number; ended?: boolean; left?: number[] }[]> {
        const result = await this.#taskRequest({
            type: "task",
            id: randomUUID(),
            op: "list",
            permission,
        });

        return result.tasks ?? [];
    }

    async taskSignal(permission: string, task: string, signal: "TERM" | "KILL"): Promise<void> {
        await this.#taskRequest({
            type: "task",
            id: randomUUID(),
            op: "signal",
            permission,
            task,
            signal,
        });
    }

    async #taskRequest(message: TaskRequest): Promise<TaskResult> {
        await this.whenOnline();

        if (!this.tasks) {
            throw new HttpError(409, "Connect an updated runner on this computer first.");
        }

        const result = await new Promise<TaskResult>((resolve, reject) => {
            this.#taskRequests.set(message.id, { message, resolve, reject });
            this.#control(message);
        }).finally(() => this.#taskRequests.delete(message.id));

        if (!result.ok) {
            throw new HttpError(
                403,
                result.error ?? "The runner refused the background task request.",
            );
        }

        return result;
    }

    withdraw(id: string): void {
        this.#control({ type: "withdraw", id });
    }

    /**
     * Open a TCP connection to `host`:`port` from the computer, and relay `socket` to it (`runner-network.ts`). Rejects
     * with a `NetError` that names the computer when it is offline, its runner is too old, or it refused or failed.
     */
    openNetwork(host: string, port: number, socket: Duplex, options?: OpenOptions): Promise<void> {
        if (this.#closed || this.#socket === undefined) {
            return Promise.reject(
                new NetError(
                    "offline",
                    `${this.name} is offline. Start Pi Pocket's runner there, then try again.`,
                ),
            );
        }

        if (this.#network === undefined) {
            return Promise.reject(
                new NetError(
                    "unsupported",
                    `${this.name} runs an older Pi Pocket runner, which cannot open pages for the browser: update its runner (npm install -g ${runnerPackage()}), then try again.`,
                ),
            );
        }

        return this.#network.open(host, port, socket, options);
    }

    /** Network streams over `socket`: their data waits behind pi-env's (`tunnels.ts`). */
    #networkOf(socket: WebSocket): LinkNetwork {
        return new LinkNetwork({
            name: () => this.name,
            send: (message, done) => {
                if (this.#socket !== socket || socket.readyState !== socket.OPEN) {
                    return false;
                }

                socket.send(message, done);

                return true;
            },
            control: (message) => {
                if (this.#socket === socket && socket.readyState === socket.OPEN) {
                    socket.send(JSON.stringify(message));
                }
            },
        });
    }

    /** End a daemon session: what it was doing fails with `error`. */
    #end(session: LinkSession, error: Error): void {
        if (!session.live) {
            return;
        }

        session.live = false;

        if (this.#session === session) {
            this.#session = undefined;
        }

        const pending = [...session.pending.values()];

        session.pending.clear();

        for (const request of pending) {
            request.reject(error);
        }
    }

    #drop(code: number, reason: string): void {
        const socket = this.#socket;

        if (socket !== undefined) {
            socket.close(code, reason);
        }
    }
}

function toBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) {
        return data;
    }

    return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

/** A session's environment on a computer: pi-env's, with which computer it is. */
export class RunnerEnv extends RemoteExecutionEnv {
    readonly runner: string;
    readonly link: RunnerLink;

    constructor(link: RunnerLink, cwd: string, scope?: SessionScope) {
        const connection = {
            info: () => link.info(),
            session: () => link.session(),
            request: (op: string, json: Record<string, unknown>, options?: RequestOptions) =>
                link.request(op, json, options, scope),
            kill: (id: number, session: number) => link.kill(id, session),
            close: () => {},
        };

        super({
            connection: connection as unknown as Connection,
            id: `runner:${link.id}${scope === undefined ? "" : `:${scope.id}`}`,
            cwd,
        });
        this.runner = link.id;
        this.link = link;
    }

    /** The computer, for the system prompt: its name, and its system as it last said. */
    computer(): { name: string; os?: string; arch?: string } {
        return { name: this.link.name, ...this.link.platform() };
    }
}

/** The computers whose runners may connect, and their links. */
export class Runners {
    readonly #config: ConfigStore;
    readonly #linkLimits: LinkLimits;
    readonly #log: (line: string) => void;
    readonly #onChange: () => void;
    readonly #askerOf: (permission: string) => string | undefined;
    readonly #asking = new Map<string, string>();
    readonly #links = new Map<string, RunnerLink>();
    readonly #envs = new Map<string, RunnerEnv>();
    readonly #server = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_MESSAGE,
        handleProtocols: (protocols) =>
            protocols.has(LINK_SUBPROTOCOL) ? LINK_SUBPROTOCOL : false,
    });

    constructor(options: {
        config: ConfigStore;
        log: (line: string) => void;
        onChange?: () => void;
        /**
         * The person who started the session a runner's question is about (its permission id, `SessionScope.id`):
         * they see and answer it, with the computer's linker and the owner. Undefined: nobody else does.
         */
        askerOf?: (permission: string) => string | undefined;
        /** The clock for the wrong link code limits (tests give their own). */
        now?: () => number;
    }) {
        this.#config = options.config;
        this.#log = options.log;
        this.#askerOf = options.askerOf ?? (() => undefined);
        this.#onChange = options.onChange ?? (() => {});

        const config = options.config;

        this.#linkLimits = new LinkLimits(options.now, {
            read: () => config.runnerLinkLimits,
            write: (value) => {
                config.runnerLinkLimits = value;
            },
        });
    }

    log(line: string): void {
        this.#log(`Runners: ${line}`);
    }

    changed(): void {
        this.#onChange();
    }

    /**
     * Whether `user` may see and answer question `id` of computer `runner`: one waiting for a code, or a session's
     * question they can withdraw. The owner and the computer's linker answer any; a person the linker chose only the
     * questions of sessions they started, whose folders and sessions are theirs.
     */
    mayAnswer(runner: string, question: ApprovalNeeded | undefined, user: User): boolean {
        if (user.role === "owner" || this.stored(runner)?.createdBy === user.id) {
            return true;
        }

        if (question === undefined || !this.mayUse(runner, user)) {
            return false;
        }

        // A session being started has no record yet: whoever's start waits on the question asked it.
        return (this.#asking.get(question.session) ?? this.#askerOf(question.session)) === user.id;
    }

    /** While `confirm` waits, who asked about session permission `permission` (`mayAnswer`). */
    asking(permission: string | undefined, asker: string | undefined): () => void {
        if (permission === undefined || asker === undefined) {
            return () => {};
        }

        this.#asking.set(permission, asker);

        return () => {
            if (this.#asking.get(permission) === asker) {
                this.#asking.delete(permission);
            }
        };
    }

    stored(id: string): StoredRunner | undefined {
        return this.#config.runnerById(id);
    }

    /** Note what a computer's daemon reported, for the computers list. */
    seen(id: string, info: RemoteInfo, version: string): void {
        this.#config.updateRunner(id, {
            lastSeen: Date.now(),
            platform: {
                os: info.os,
                arch: info.arch,
                home: info.home,
                version,
                tmpdir: info.tmpdir,
            },
        });
        // Its system shows in Runners from now: the list went out when it connected, before this was known.
        this.#onChange();
    }

    /**
     * The system of computer `id` as it last said (`hello`), also while it is offline: its OS and temporary folder.
     * Undefined before a runner that tells its temporary folder first connected.
     */
    system(id: string): { os: string; tmpdir: string } | undefined {
        const platform = this.stored(id)?.platform;

        return platform?.tmpdir === undefined
            ? undefined
            : { os: platform.os, tmpdir: platform.tmpdir };
    }

    /** Each hello refreshes readiness, including a resumed daemon session. */
    toolsSeen(id: string, tools: Hello["tools"]): void {
        this.#config.updateRunner(id, { tools });
    }

    /** The link to a computer, made when first asked for, also for a computer not (or no longer) here. */
    link(id: string): RunnerLink {
        let link = this.#links.get(id);

        if (link === undefined) {
            link = new RunnerLink(id, this);
            this.#links.set(id, link);
        }

        return link;
    }

    /** The environment of a session that runs in `cwd` on computer `id`. */
    env(id: string, cwd: string, scope?: SessionScope): RunnerEnv {
        const key = `${id}\0${cwd}\0${scope?.id ?? ""}\0${scope?.folder ?? ""}`;
        let env = this.#envs.get(key);

        if (env === undefined) {
            env = new RunnerEnv(this.link(id), cwd, scope);
            this.#envs.set(key, env);
        }

        return env;
    }

    /** A computer's name, for prompts and messages; its id when it is gone. */
    name(id: string): string {
        return this.#config.runnerById(id)?.name ?? id;
    }

    /** Throw unless computer `id` is linked here. */
    require(id: string): StoredRunner {
        const runner = this.#config.runnerById(id);

        if (runner === undefined) {
            throw new HttpError(404, "That computer is not linked to this server.");
        }

        return runner;
    }

    /** A folder on computer `id` as a session means it: `~` is the home there; others are absolute or under home. */
    async #resolve(
        id: string,
        path: string,
    ): Promise<{ env: RunnerEnv; path: string; home: string; separator: string }> {
        this.require(id);

        const info = await this.link(id)
            .infoNow()
            .catch((error: unknown) => {
                throw error instanceof HttpError
                    ? error
                    : new HttpError(409, error instanceof Error ? error.message : String(error));
            });
        const env = this.env(id, info.home);
        const trimmed = path.trim() === "" ? "~" : path.trim();
        const expanded =
            trimmed === "~"
                ? info.home
                : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
                  ? `${info.home}${info.separator}${trimmed.slice(2)}`
                  : trimmed;
        const absolute = await env.absolutePath(expanded, BACKGROUND);

        if (!absolute.ok) {
            throw new HttpError(400, absolute.error.message);
        }

        return { env, path: absolute.value, home: info.home, separator: info.separator };
    }

    /** Check that `path` is a folder on computer `id`; its absolute path. */
    async checkFolder(id: string, path: string): Promise<string> {
        const { env, path: absolute } = await this.#resolve(id, path);
        const info = await env.fileInfo(absolute, BACKGROUND);

        if (!info.ok || info.value.kind !== "directory") {
            throw new HttpError(
                400,
                `${absolute} is not a folder on ${this.name(id)}${info.ok ? "" : `: ${info.error.message}`}`,
            );
        }

        return absolute;
    }

    /** The folders in `path` on computer `id`, for the folder picker, as `GET /api/fs` lists this machine's. */
    async folders(
        id: string,
        path: string,
        hidden: boolean,
    ): Promise<{
        path: string;
        parent: string | null;
        home: string;
        dirs: { name: string; path: string }[];
    }> {
        const resolved = await this.#resolve(id, path);
        const listed = await resolved.env.listDir(resolved.path, BACKGROUND);

        if (!listed.ok) {
            throw new HttpError(
                400,
                `${resolved.path} on ${this.name(id)}: ${listed.error.message}`,
            );
        }

        const dirs: { name: string; path: string }[] = [];

        for (const entry of listed.value) {
            if (!hidden && entry.name.startsWith(".")) {
                continue;
            }

            let folder = entry.kind === "directory";

            if (entry.kind === "symlink") {
                const target = await resolved.env.fileInfo(
                    await resolved.env
                        .canonicalPath(entry.path, BACKGROUND)
                        .then((real) => (real.ok ? real.value : entry.path)),
                    BACKGROUND,
                );

                folder = target.ok && target.value.kind === "directory";
            }

            if (folder) {
                dirs.push({ name: entry.name, path: entry.path });
            }
        }

        dirs.sort((a, b) => a.name.localeCompare(b.name));

        const sep = resolved.separator;
        const trimmed = resolved.path.replace(/[\\/]+$/, "");
        const at = trimmed.lastIndexOf(sep);
        const parent =
            at < 0 || trimmed === ""
                ? null
                : at === 0
                  ? sep
                  : /^[A-Za-z]:$/.test(trimmed.slice(0, at))
                    ? `${trimmed.slice(0, at)}${sep}`
                    : trimmed.slice(0, at);

        return {
            path: resolved.path,
            parent: parent === resolved.path ? null : parent,
            home: resolved.home,
            dirs: dirs.slice(0, 1000),
        };
    }

    /** Who is locked out of linking now, and whether all of it is paused (`link-limits.ts`), for the Runners sheet. */
    linkLocks(): LinkLocks {
        return this.#linkLimits.locks();
    }

    /** Lift the ban on `address` (the owner's, in Runners). */
    liftLinkBan(address: string): void {
        if (!this.#linkLimits.lift(address)) {
            throw new HttpError(404, "That address is not banned.");
        }

        this.log(`The link ban on ${address} was lifted.`);
        this.changed();
    }

    /** A computer's linker and granted people may use it while they can steer on this server. */
    mayUse(runnerId: string, user: User): boolean {
        const runner = this.stored(runnerId);
        const current = this.#config.userById(user.id);

        return (
            runner !== undefined &&
            (runner.createdBy === user.id || runner.users?.includes(user.id) === true) &&
            current !== undefined &&
            current.sessions === undefined &&
            current.role !== "viewer"
        );
    }

    /** With a person, only the computers they may use; owners see all, and the granted people. */
    list(user?: User): RunnerView[] {
        return this.#config.runners
            .filter(
                (runner) =>
                    user === undefined || user.role === "owner" || this.mayUse(runner.id, user),
            )
            .map((runner) => {
                const link = this.#links.get(runner.id);

                return {
                    id: runner.id,
                    name: runner.name,
                    createdBy: runner.createdBy,
                    ...(user?.role === "owner"
                        ? {
                              users: (runner.users ?? []).flatMap((id) => {
                                  const person = this.#config.userById(id);

                                  return person === undefined ? [] : [{ id, name: person.name }];
                              }),
                          }
                        : {}),
                    // The computer's approvals (every session's folder and person, its settings) are its
                    // linker's and the owner's business; a granted person sees only that it is there.
                    ...(link?.state === undefined || (user !== undefined && user.role !== "owner")
                        ? {}
                        : { approvals: link.state }),
                    ...(link === undefined
                        ? {}
                        : {
                              questions: [...link.questions.values()].filter(
                                  (question) =>
                                      user === undefined ||
                                      this.mayAnswer(runner.id, question, user),
                              ),
                          }),
                    online: link?.online === true,
                    asks: link?.asks === true,
                    away: link?.away === true,
                    ...(runner.lastSeen === undefined ? {} : { lastSeen: runner.lastSeen }),
                    ...(runner.platform ?? {}),
                    ...(runner.tools === undefined ? {} : { tools: runner.tools }),
                };
            });
    }

    /** A one-time code that links a computer named `name`: `pi-pocket runner link <server> <code>` on it. */
    makeCode(
        name: string,
        createdBy: string,
    ): { code: string; expiresAt: number; package: string } {
        const clean = name.replace(/\s+/g, " ").trim().slice(0, 60);

        if (clean === "") {
            throw new HttpError(400, "Give the computer a name.");
        }

        if (this.#config.runners.some((runner) => runner.name === clean)) {
            throw new HttpError(
                409,
                `A computer named ${clean} is already linked. Choose another name.`,
            );
        }

        // 12 characters of an alphabet without look-alikes (no 0/O, 1/I/L): 60 bits, easy to read out and type.
        const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
        const raw = [...randomBytes(12)].map((byte) => alphabet[byte % 31]).join("");
        const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
        const expiresAt = Date.now() + CODE_MINUTES * 60_000;

        this.#config.addRunnerCode(code, clean, createdBy, expiresAt);

        return { code, expiresAt, package: runnerPackage() };
    }

    /**
     * A runner gives its one-time code: it gets its computer's key, kept only there. `address`: the client's
     * (`link-limits.ts` `clientAddress`). Wrong codes are counted: too many from one address lock it out, and its
     * third lockout bans it; too many in all pause new linking and void the open codes. Linked computers and their keys
     * stay as they are.
     */
    redeem(code: string, address = "unknown"): { id: string; name: string; key: string } {
        this.#linkLimits.check(address);

        const found = this.#config.takeRunnerCode(code.trim().toUpperCase());

        if (found === undefined) {
            const result = this.#linkLimits.wrong(address);

            if (result.banned) {
                this.log(
                    `Too many wrong link codes from ${address}, for the third time: it is banned from linking until you lift the ban in Runners.`,
                );
            } else if (result.locked) {
                this.log(
                    `Too many wrong link codes from ${address}: it is locked out for 10 minutes.`,
                );
            }

            if (result.ceiling) {
                this.#config.voidRunnerCodes();
                this.log(
                    "Too many wrong link codes reached this server: new linking is paused for 10 minutes, and open codes were voided. Linked computers are not affected.",
                );
            }

            this.changed();

            throw new HttpError(403, WRONG_CODE);
        }

        const { runner, key } = this.#config.addRunner(found.name, found.createdBy);

        this.log(`${runner.name} was linked.`);
        this.changed();

        return { id: runner.id, name: runner.name, key };
    }

    /** Forget a computer: its runner is sent away, and its key stops working. */
    remove(id: string): void {
        const runner = this.#config.runnerById(id);

        if (runner === undefined) {
            throw new HttpError(404, "No such computer");
        }

        this.#links.get(id)?.remove();
        this.#links.delete(id);

        for (const key of this.#envs.keys()) {
            if (key.startsWith(`${id}\0`)) {
                this.#envs.delete(key);
            }
        }

        this.#config.removeRunner(id);
        this.log(`${runner.name} was removed.`);
        this.changed();
    }

    /**
     * An HTTP upgrade: a runner connecting, when it is for the link path. Returns false for any other upgrade, which
     * the caller ends.
     */
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
        const path = new URL(request.url ?? "/", "http://pocket").pathname;

        if (path !== LINK_PATH) {
            return false;
        }

        const refuse = (status: number, message: string) => {
            socket.end(
                `HTTP/1.1 ${status} ${message}\r\nconnection: close\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
            );
        };

        const auth = request.headers.authorization ?? "";
        const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        const runner = key === "" ? undefined : this.#config.runnerByKey(key);

        if (runner === undefined) {
            refuse(401, "Unknown runner key");

            return true;
        }

        const offered = String(request.headers["sec-websocket-protocol"] ?? "")
            .split(",")
            .map((each) => each.trim());

        if (!offered.includes(LINK_SUBPROTOCOL)) {
            refuse(426, `This server speaks ${LINK_SUBPROTOCOL}: update the runner or the server`);

            return true;
        }

        this.#server.handleUpgrade(request, socket, head, (ws) => this.#accept(ws, runner));

        return true;
    }

    #accept(socket: WebSocket, runner: StoredRunner): void {
        const timer = setTimeout(() => socket.close(1002, "No hello"), HELLO_MS);

        socket.once("message", (data, binary) => {
            clearTimeout(timer);

            const hello = binary ? undefined : parseControl(toBuffer(data).toString("utf8"));

            if (hello?.type !== "hello") {
                socket.close(1002, "Say hello first");

                return;
            }

            if (hello.protocol !== LINK_PROTOCOL) {
                socket.send(
                    JSON.stringify({
                        type: "bye",
                        reason: `This server speaks link protocol ${LINK_PROTOCOL}, the runner ${hello.protocol}: update the older one`,
                    }),
                );
                socket.close(CLOSE.protocol, "Protocol");

                return;
            }

            // Still here: removed while it was saying hello.
            if (this.#config.runnerById(runner.id) === undefined) {
                socket.close(CLOSE.removed, "Removed");

                return;
            }

            this.link(runner.id).attach(socket, hello);
        });
        socket.on("error", (error) => this.log(`${runner.name}: ${error.message}`));
    }

    close(): void {
        for (const link of this.#links.values()) {
            link.shutdown();
        }

        this.#links.clear();
        this.#server.close();
    }
}
