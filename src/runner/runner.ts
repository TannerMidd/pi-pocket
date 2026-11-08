/**
 * The runner's work: start the pi-env daemon here, keep a link to the server, and relay pi-env frames both ways.
 * `main.ts` runs it from the command line; tests run it in the same process.
 *
 * The link survives drops of any length (`protocol.ts`). While it is down, the daemon keeps running, the runner pings it
 * itself, and its output waits here (reading stops when too much waits, as a full pipe would). When the server answers
 * again, both sides send what the other missed. When the server does not know the session anymore (it restarted), the
 * runner stops the daemon, which stops what it ran, and starts a new one.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { localDaemon } from "@earendil-works/pi-env";
import WebSocket from "ws";
import { checkTransport, refusal, type Transport } from "./transport.ts";
import { checkTools } from "./tools.ts";
import { broadFolder, coveredFolder, realFolder } from "./folders.ts";
import {
    Approvals,
    type SessionPermission,
    type SessionScope,
    type ApprovalMethod,
} from "./approvals.ts";
import type { TotpState } from "./totp.ts";
import { Activity, type ActivityOptions, type ActivityState } from "./activity.ts";
import { RequestGate, sessionScope } from "./request-gate.ts";
import { Tasks } from "./tasks.ts";
import type { RunnerTools, TaskRequest, TaskResult } from "./protocol.ts";
import {
    CLOSE,
    type Confirm,
    type Confirmed,
    type ApprovalNeeded,
    type ControlMessage,
    FRAME,
    FrameSplitter,
    frame,
    Inbox,
    LINK_PATH,
    LINK_PROTOCOL,
    LINK_SUBPROTOCOL,
    MAX_MESSAGE,
    type NetOpen,
    Outbox,
    parseControl,
    readStreamData,
    STREAM_DATA,
} from "./protocol.ts";
import { CONNECT_MS, MAX_STREAMS, StreamLink } from "./tunnels.ts";

/** Daemon pings, as pi-env's own client sends them: it stops everything after 30 s without a byte. */
const DAEMON_PING_MS = 5000;

/** Send an acknowledgement once this many bytes came in, or within ACK_MS. */
const ACK_BYTES = 256 * 1024;
const ACK_MS = 1000;

/** Stop reading the daemon's output while this much waits for the server, as a full pipe would (pi-env pauses). */
const OUTBOX_LIMIT = 32 * 1024 * 1024;

/** Reconnect waits, growing from the first to the last. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000];
/** How long git and GitHub readiness is kept between connections (an install or a sign-in shows after this). */
const TOOLS_FOR_MS = 5 * 60_000;

/** WebSocket pings to the server; a link that answers none for SILENT_MS is closed and made again. */
const PING_MS = 10_000;
const SILENT_MS = 30_000;

/** What a runner needs to connect: kept in `runner.json` by `pi-pocket runner link`. */
export type RunnerLinkFile = {
    server: string;
    id: string;
    name: string;
    key: string;
    /** The person's choices for this link (`pi-pocket runner settings`); absent: the defaults. */
    settings?: RunnerSettings;
};

/** The runner's settings, kept with its link. */
export type RunnerSettings = {
    /** Ask before a new session starts on this computer. Default: true. */
    confirm?: boolean;
    /** Real absolute folders allowed by the person here, including their descendants. */
    folders?: string[];
    /** Authenticator grants last this many days; null means no expiry. Default: 7. */
    totpDays?: number | null;
    /** Local only: never sent to the server. */
    totp?: TotpState;
    sessions?: SessionPermission[];
    /** Use plain HTTP to this server even where it is not this computer or a tailnet device. Default: false. */
    allowHttp?: boolean;
    /** Open the network connections of sessions' browsers from this computer. Default: true. */
    network?: boolean;
    /** Where sessions' browser downloads go, an absolute folder: `<folder>/<session>/`. Default: the temporary folder. */
    downloads?: string;
};

/** A question the server asked this computer: a session would start here. */
export type SessionQuestion = {
    kind: "new" | "fork" | "move";
    /** A root, home folder, or ancestor of home: allow this session only. */
    broad: boolean;
    permission: "folder" | "session";
    expired: boolean;
    session: string;
    totp: boolean;
    expiresInMs: number;
    person: string;
    folder: string;
    server: string;
    computer: string;
    /** Aborts when the question ends, not when the network link drops. */
    signal: AbortSignal;
};

/** Whether a new session may start here, and why not, in words for the person who asked. */
export type SessionAnswer = { allow: boolean; reason?: string };

export type RunnerOptions = {
    link: RunnerLinkFile;
    version: string;
    /** The pi-env daemon to start; default the one packaged for this computer. */
    daemon?: string;
    /** The folder the daemon starts in; default the home folder. */
    cwd?: string;
    log?: (line: string) => void;
    /** Reconnect waits; tests make them short. */
    retryMs?: readonly number[];
    /** Tests shorten the fixed, 30-hour computer approval lifetime. */
    approvalMs?: number;
    /** The link's settings now: read again for each connect and each question, so changes need no restart. */
    settings?: () => RunnerSettings;
    /** Save a local settings change, preserving other settings read from the file now. */
    saveSettings?: (change: RunnerSettings) => void | Promise<void>;
    /**
     * Ask the person here whether a session may start. Absent: nobody can be asked, so every session is refused
     * while asking is on.
     */
    ask?: (question: SessionQuestion) => Promise<SessionAnswer>;
    /** Check the server's transport before each connect; tests and HTTPS skip it. Default: `checkTransport`. */
    transport?: (server: string, allowHttp: boolean) => Promise<Transport>;
    /** Told when sessions start or stop working on this computer, and where (`activity.ts`). */
    activity?: (state: ActivityState) => void;
    /** Smoothing of `activity`; tests shorten it. */
    activityTiming?: Omit<ActivityOptions, "now">;
};

/** How long the runner waits for its person; the server waits 10 s longer (`CONFIRM_MS` in `runners.ts`). */
const ASK_MS = 120_000;

/** With an authenticator: time to open it and type a code in Pi Pocket. */
const ASK_TOTP_MS = 300_000;

const WITHDRAWN = "Withdrawn by the server.";

/** What a question here came to; `method` says how an allowed one was approved. */
type Approval = { allow: boolean; reason?: string; method?: ApprovalMethod; withdrawn?: boolean };

/** Why a runner stopped for good: the server removed it, another one took its place, or the protocols differ. */
export class RunnerStopped extends Error {}

/** The pi-env daemon on this computer: started with a fresh token, its output read after its sync line. */
class Daemon {
    readonly child: ChildProcessWithoutNullStreams;
    readonly exited: Promise<number | null>;
    #synced = false;
    #pending: Buffer[] = [];
    readonly #token = randomBytes(16).toString("hex");
    readonly #ping: NodeJS.Timeout;

    constructor(
        program: string,
        cwd: string,
        log: (line: string) => void,
        onOutput: (bytes: Buffer) => void,
    ) {
        this.child = spawn(program, ["serve", "--token", this.#token], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        this.exited = new Promise((resolve) => {
            this.child.once("exit", (code) => resolve(code));
            this.child.once("error", (error) => {
                log(
                    `The tool process could not start: ${error.message}\nCheck PI_POCKET_RUNNER_DAEMON, or reinstall Pi Pocket.`,
                );
                resolve(null);
            });
        });
        this.child.stdin.on("error", () => {});
        this.child.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8").trim();

            if (text !== "") {
                log(`Tool process: ${text}`);
            }
        });
        this.child.stdout.on("data", (chunk: Buffer) => {
            if (this.#synced) {
                onOutput(chunk);

                return;
            }

            // Shell startup files may print before the daemon runs: skip everything before its sync line.
            this.#pending.push(chunk);

            const all = Buffer.concat(this.#pending);
            const marker = Buffer.from(`PI-ENV ${this.#token}\n`, "utf8");
            const at = all.indexOf(marker);

            if (at === -1) {
                this.#pending = [all.subarray(Math.max(0, all.length - marker.length))];

                return;
            }

            this.#synced = true;
            this.#pending = [];

            const rest = all.subarray(at + marker.length);

            if (rest.length > 0) {
                onOutput(rest);
            }
        });
        this.#ping = setInterval(() => this.write(frame(FRAME.ping, 0, {})), DAEMON_PING_MS);
        this.#ping.unref();
    }

    /** Write whole frames only: the runner's pings go between them. */
    write(bytes: Buffer): void {
        if (this.child.exitCode === null && !this.child.stdin.destroyed) {
            this.child.stdin.write(bytes);
        }
    }

    pause(): void {
        this.child.stdout.pause();
    }

    resume(): void {
        this.child.stdout.resume();
    }

    /** Stop it: it kills every process group it started when its input ends. */
    stop(): Promise<number | null> {
        clearInterval(this.#ping);
        this.child.stdin.end();

        const timer = setTimeout(() => this.child.kill(), 2000);

        timer.unref();
        void this.exited.then(() => clearTimeout(timer));

        return this.exited;
    }
}

/** One daemon and its link session with the server: what both sides keep across drops. */
class Session {
    readonly outbox = new Outbox();
    readonly inbox = new Inbox();
    readonly splitter = new FrameSplitter();
    readonly daemon: Daemon;
    readonly outputFrames = new FrameSplitter();
    gate!: RequestGate;
    /** The server's id for it, once welcomed. */
    id: string | null = null;
    paused = false;

    constructor(
        make: (onOutput: (bytes: Buffer) => void) => Daemon,
        onOutput: (session: Session, bytes: Buffer) => void,
    ) {
        this.daemon = make((bytes) => onOutput(this, bytes));
    }
}

export class Runner {
    readonly #options: RunnerOptions;
    #toolsChecked: { at: number; tools: Promise<RunnerTools> } | undefined;
    readonly #url: URL;
    readonly #log: (line: string) => void;
    readonly #retry: readonly number[];
    #socket: WebSocket | undefined;
    /** Confirm answers wait until this socket has received its welcome. */
    #welcomed: WebSocket | undefined;
    #session!: Session;
    #stopping = false;
    /** Questions that the server can withdraw while the person answers. */
    readonly #questions = new Map<string, AbortController>();
    /** Questions belong to this computer, not its WebSocket; announce them again after a drop. */
    readonly #notices = new Map<string, ApprovalNeeded>();
    /** A local answer made offline must still reach the server's waiting confirm. */
    readonly #answers = new Map<string, Confirmed>();
    readonly #approvals: Approvals;
    readonly #tasks: Tasks;
    /** Starts are replayed after reconnects, once per id for this runner's lifetime. */
    readonly #taskResults = new Map<string, Promise<TaskResult>>();
    /** Questions that wait here, by id: a code from Pi Pocket can answer them. */
    readonly #pending = new Map<
        string,
        {
            scope: SessionScope;
            stop: AbortController;
            resolve: (answer: Approval) => void;
            promise: Promise<Approval>;
            /** Another request of the same session waits on this question too. */
            hold: (signal: AbortSignal | undefined) => void;
        }
    >();
    /** Whether sessions work on this computer now, and where (`activity.ts`). */
    readonly #activity: Activity;
    /** Approvals and folders of a runner without `saveSettings` (tests, and programs that keep no file). */
    #unsaved: RunnerSettings = {};
    #stateTimer: NodeJS.Timeout | undefined;
    #lastState = "";
    #attempt = 0;
    #ackTimer: NodeJS.Timeout | undefined;
    #retryTimer: NodeJS.Timeout | undefined;
    /** Why the last connect was refused before it began (`transport.ts`), so it is said once. */
    #refused: string | undefined;
    /** The network streams of the current connection. */
    #streams: StreamLink | undefined;
    /** Network connections opened so far, for tests. */
    opened = 0;
    /** Network connections still connecting, by stream id. */
    readonly #connecting = new Map<number, Socket>();
    #done!: (error?: Error) => void;
    /** Settles when the runner stops: resolves after `stop()`, rejects with `RunnerStopped` when the server ends it. */
    readonly finished: Promise<void>;

    constructor(options: RunnerOptions) {
        this.#options = options;
        this.#approvals = new Approvals(
            () => this.#settings(),
            async (change) => {
                if (options.saveSettings !== undefined) {
                    await options.saveSettings(change);
                } else {
                    // Nowhere to save: kept for this runner's life, over what `settings` reads.
                    this.#unsaved = { ...this.#unsaved, ...change };
                }
            },
            options.approvalMs,
        );
        this.#activity = new Activity((state) => options.activity?.(state), options.activityTiming);
        this.#log = options.log ?? (() => {});
        this.#tasks = new Tasks(
            (permission, cwd) => this.#session.gate.task(permission, cwd),
            this.#log,
        );
        this.#retry = options.retryMs ?? RETRY_MS;
        this.#url = new URL(options.link.server);
        this.#url.protocol = this.#url.protocol === "https:" ? "wss:" : "ws:";
        this.#url.pathname = `${this.#url.pathname.replace(/\/+$/, "")}${LINK_PATH}`;
        this.finished = new Promise<void>((resolve, reject) => {
            this.#done = (error) => {
                // Stopped: nothing works here any more, said at once.
                this.#activity.stop();

                if (error === undefined) {
                    resolve();
                } else {
                    reject(error);
                }
            };
        });
        this.finished.catch(() => {});
    }

    /** Whether a link to the server is up and welcomed. */
    get connected(): boolean {
        return this.#socket?.readyState === WebSocket.OPEN && this.#session?.id !== null;
    }

    /** The daemon's process id, for tests. */
    get daemonPid(): number | undefined {
        return this.#session?.daemon.child.pid;
    }

    start(): void {
        this.#session = this.#fresh();
        this.#stateTimer = setInterval(() => void this.#state(), 2000);
        this.#stateTimer.unref();
        this.#connect();
    }

    /** Stop: tell the server, end the link, and stop the daemon, which stops what it ran. */
    async stop(): Promise<void> {
        if (this.#stopping) {
            return this.finished;
        }

        this.#stopping = true;
        clearTimeout(this.#retryTimer);
        clearTimeout(this.#ackTimer);
        clearInterval(this.#stateTimer);
        this.#session.gate.stop();

        for (const pending of this.#pending.values()) {
            pending.stop.abort();
        }

        this.#control({ type: "bye", reason: "The runner was stopped" });
        this.#socket?.close(1000, "Stopped");
        await Promise.all([this.#session.daemon.stop(), this.#tasks.stop()]);
        this.#done();
    }

    /** For tests: cut the link as a network drop would, without a goodbye. The runner reconnects. */
    drop(): void {
        this.#socket?.terminate();
    }

    #control(message: ControlMessage): void {
        if (this.#socket?.readyState === WebSocket.OPEN) {
            this.#socket.send(JSON.stringify(message));
        }
    }

    #ack(): void {
        clearTimeout(this.#ackTimer);
        this.#ackTimer = undefined;

        const session = this.#session;

        if (session.inbox.unacknowledged > 0 && this.#socket?.readyState === WebSocket.OPEN) {
            session.inbox.acknowledged();
            this.#control({ type: "ack", received: session.inbox.received });
        }
    }

    #onOutput(from: Session, bytes: Buffer): void {
        if (from !== this.#session) {
            return;
        }

        for (const whole of from.outputFrames.push(bytes)) {
            from.gate.output(whole);
        }

        this.#relay(from, bytes);
    }

    #relay(from: Session, bytes: Buffer): void {
        if (from !== this.#session) {
            return;
        }

        const message = from.outbox.write(bytes);

        if (this.#socket?.readyState === WebSocket.OPEN && from.id !== null) {
            this.#socket.send(message);
        }

        if (!from.paused && from.outbox.unacknowledged > OUTBOX_LIMIT) {
            from.paused = true;
            from.daemon.pause();
        }
    }

    #fresh(): Session {
        const program = this.#options.daemon ?? localDaemon();
        // The daemon's temporary folder: it takes it from the environment as it starts, as this does.
        const temporary = realFolder(tmpdir());
        const made = new Session(
            (onOutput) => new Daemon(program, this.#options.cwd ?? homedir(), this.#log, onOutput),
            (session, bytes) => this.#onOutput(session, bytes),
        );

        made.gate = new RequestGate({
            approvals: this.#approvals,
            ask: async (scope, signal) =>
                (await this.#approve(`resume-${scope.id}`, scope, "new", true, signal)).allow,
            send: (bytes) => made.daemon.write(bytes),
            reply: (bytes) => this.#relay(made, bytes),
            shared: async (id) => this.#shared(await temporary, id),
            tmpdir: () => temporary,
            name: () => this.#options.link.name,
            working: (folder) => this.#activity.begin(folder),
        });
        void made.daemon.exited.then((code) => {
            made.gate.stop();

            if (this.#session !== made || this.#stopping) {
                return;
            }

            this.#log(
                `The tool process stopped (exit code ${String(code)}). Restarting it automatically. If this repeats, reinstall Pi Pocket.`,
            );
            this.#session = this.#fresh();
            // The server's session belonged to the old daemon: say hello again, as a new one.
            this.#socket?.close(1000, "pi-env restarted");
        });

        return made;
    }

    #restart(why: string): void {
        this.#log(why);
        this.#session.gate.stop();
        void this.#session.daemon.stop();
        this.#session = this.#fresh();
    }

    /** Stop for good, with why. */
    #fail(message: string): void {
        this.#stopping = true;
        clearTimeout(this.#retryTimer);
        clearInterval(this.#stateTimer);
        this.#session.gate.stop();

        for (const pending of this.#pending.values()) {
            pending.stop.abort();
        }

        this.#log(message);
        void Promise.all([this.#session.daemon.stop(), this.#tasks.stop()]).then(() =>
            this.#done(new RunnerStopped(message)),
        );
    }

    /**
     * The runner's own folders that session `id` (its permission) may use besides its folder: its own attached files
     * (`<temp>/pi-pocket-uploads/<id>`), background tasks (`<temp>/pi-pocket-tasks/<id>`), browser downloads
     * (`<temp>/pi-pocket-downloads/<id>`, or `<id>` in the downloads folder), and its git worktrees
     * (`<home>/.pi-pocket/worktrees/<id>`). Only its own: never another session's, and never the downloads or worktrees
     * folder itself.
     */
    async #shared(temporary: string, id: string): Promise<string[]> {
        // A permission id names one folder: nothing that climbs or splits a path.
        if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
            return [];
        }

        const downloads = this.#settings().downloads;

        return [
            join(temporary, "pi-pocket-uploads", id),
            join(temporary, "pi-pocket-tasks", id),
            join(temporary, "pi-pocket-downloads", id),
            join(await realFolder(homedir()), ".pi-pocket", "worktrees", id),
            ...(downloads === undefined ? [] : [join(await realFolder(downloads), id)]),
        ];
    }

    async #task(ws: WebSocket, message: TaskRequest): Promise<void> {
        let result = message.op === "start" ? this.#taskResults.get(message.id) : undefined;

        if (result === undefined) {
            result = this.#tasks.request(message).catch((error: unknown): TaskResult => ({
                type: "task-result",
                id: message.id,
                ok: false,
                error: (error as Error).message,
            }));

            if (message.op === "start") {
                this.#taskResults.set(message.id, result);
            }
        }

        const answer = await result;

        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(answer));
        }
    }

    /** The link's settings now. */
    #settings(): RunnerSettings {
        return {
            ...(this.#options.settings?.() ?? this.#options.link.settings ?? {}),
            ...this.#unsaved,
        };
    }

    /** Check that the server may be reached this way (`transport.ts`), then connect; refused, it stops for good. */
    #connect(): void {
        if (this.#stopping) {
            return;
        }

        const check = this.#options.transport ?? checkTransport;

        void check(this.#options.link.server, this.#settings().allowHttp === true).then(
            (transport) => {
                if (this.#stopping) {
                    return;
                }

                // Refused: it tries again, since Tailscale may only be starting (at boot, say), and says why once.
                if (!transport.ok) {
                    const why = refusal(this.#options.link.server, transport);

                    if (why !== this.#refused) {
                        this.#refused = why;
                        this.#log(why);
                    }

                    const wait = this.#retry[Math.min(this.#attempt, this.#retry.length - 1)]!;

                    this.#attempt++;
                    this.#retryTimer = setTimeout(() => this.#connect(), wait);

                    return;
                }

                this.#refused = undefined;

                if (this.#attempt === 0 && transport.why === "allowed") {
                    this.#log(
                        `Warning: plain HTTP to ${this.#options.link.server}, as allowed in this runner's settings. Anyone on the network can read this computer's key and its commands.`,
                    );
                }

                void this.#tools().then((tools) => this.#open(tools));
            },
            (error: unknown) => this.#fail(`Could not check the server address: ${String(error)}`),
        );
    }

    /**
     * git and GitHub readiness for the hello. Checked again after `TOOLS_FOR_MS` only: a reconnect after a short drop
     * must not wait for `gh auth status`, which asks GitHub.
     */
    #tools(): Promise<RunnerTools> {
        const now = Date.now();

        if (this.#toolsChecked === undefined || now - this.#toolsChecked.at > TOOLS_FOR_MS) {
            this.#toolsChecked = { at: now, tools: checkTools() };
        }

        return this.#toolsChecked.tools;
    }

    #open(tools: RunnerTools): void {
        if (this.#stopping) {
            return;
        }

        const link = this.#options.link;
        const ws = new WebSocket(this.#url, LINK_SUBPROTOCOL, {
            headers: { authorization: `Bearer ${link.key}` },
            maxPayload: MAX_MESSAGE,
            handshakeTimeout: 15_000,
        });

        this.#socket = ws;

        const streams = new StreamLink({
            send: (message, done) => {
                if (ws.readyState !== WebSocket.OPEN) {
                    return false;
                }

                ws.send(message, done);

                return true;
            },
            control: (message) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(message));
                }
            },
        });

        this.#streams = streams;

        let welcomed = false;
        let silent = Date.now();
        const pinger = setInterval(() => {
            if (Date.now() - silent > SILENT_MS) {
                ws.terminate();

                return;
            }

            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, PING_MS);

        pinger.unref();
        ws.on("unexpected-response", (_request, response) => {
            if (response.statusCode === 401) {
                this.#fail(
                    `${link.server} no longer accepts this computer's key. To link again, run pi-pocket runner and choose Link again.`,
                );
            } else {
                this.#log(
                    `${link.server} returned HTTP ${String(response.statusCode)}. Retrying automatically. If this continues, check that Pi Pocket is running at this address.`,
                );
            }

            ws.terminate();
        });
        ws.on("open", () => {
            silent = Date.now();
            ws.send(
                JSON.stringify({
                    type: "hello",
                    protocol: LINK_PROTOCOL,
                    session: this.#session.id,
                    received: this.#session.inbox.received,
                    version: this.#options.version,
                    tools,
                    ...(this.#settings().downloads === undefined
                        ? {}
                        : { downloads: this.#settings().downloads }),
                } satisfies ControlMessage),
            );
        });
        ws.on("pong", () => (silent = Date.now()));
        ws.on("message", (data, binary) => {
            silent = Date.now();

            const bytes = Buffer.isBuffer(data)
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.from(data);

            if (!binary) {
                welcomed = this.#onControl(ws, welcomed, parseControl(bytes.toString("utf8")));

                return;
            }

            if (!welcomed) {
                ws.close(1002, "Data before welcome");

                return;
            }

            if (bytes[0] === STREAM_DATA) {
                const data = readStreamData(bytes);

                if (data !== undefined) {
                    streams.data(data.id, data.bytes);
                }

                return;
            }

            this.#onData(ws, bytes);
        });
        ws.on("error", (error) => {
            if (this.#attempt <= 1) {
                this.#log(
                    `Connection error (${error.message}). If the runner does not connect, check the address and network.`,
                );
            }
        });
        ws.on("close", (code, reason) => {
            clearInterval(pinger);
            // Network streams do not survive a drop: the browser on the server opens them again.
            streams.dropAll();

            for (const socket of this.#connecting.values()) {
                socket.destroy();
            }

            this.#connecting.clear();

            if (this.#streams === streams) {
                this.#streams = undefined;
            }

            if (this.#socket === ws) {
                this.#socket = undefined;
            }

            if (this.#stopping) {
                return;
            }

            const why = reason.toString("utf8");

            if (code === CLOSE.removed) {
                this.#fail(
                    `${link.server} removed this computer. To link again, run pi-pocket runner and choose Link again.`,
                );

                return;
            }

            if (code === CLOSE.replaced) {
                this.#fail(
                    "Another runner is using this computer's link. This runner has stopped. Stop the other runner before you start this one again.",
                );

                return;
            }

            if (code === CLOSE.protocol) {
                this.#fail(
                    `${why}. Update Pi Pocket on this computer and the server, then start the runner again.`,
                );

                return;
            }

            if (welcomed) {
                this.#log(
                    `Disconnected${why === "" ? "" : ` (${why})`}. Reconnecting automatically. Commands keep running; their sessions continue when the link is back.`,
                );
            }

            const wait = this.#retry[Math.min(this.#attempt, this.#retry.length - 1)]!;

            this.#attempt++;
            this.#retryTimer = setTimeout(() => this.#connect(), wait);
        });
    }

    /** A control message; returns whether the link is welcomed now. */
    #onControl(ws: WebSocket, welcomed: boolean, message: ControlMessage | undefined): boolean {
        const session = this.#session;

        if (message?.type === "welcome" && !welcomed) {
            this.#attempt = 0;
            // Runners shows this computer's settings, folders, and sessions as soon as it is welcomed.
            this.#lastState = "";
            queueMicrotask(() => void this.#state());

            if (message.resume) {
                const resent =
                    session.id === message.session
                        ? session.outbox.resend(message.received)
                        : undefined;

                if (resent === undefined) {
                    // The server kept bytes this side can no longer send: start over cleanly.
                    this.#control({
                        type: "bye",
                        reason: "The runner lost its place; it starts over",
                    });
                    this.#restart(
                        "The connection could not resume. Restarting the tool process and connecting again.",
                    );
                    ws.close(1000, "Start over");

                    return false;
                }

                for (const each of resent) {
                    ws.send(each);
                }

                this.#log(
                    `Reconnected to ${this.#options.link.server}. Running commands continue.`,
                );
                this.#welcomeApprovals(ws);

                return true;
            }

            let current = session;

            // A new session on the server: a daemon that served an old one starts over, so nothing it ran outlives it.
            if (session.id !== null) {
                this.#restart(
                    "The server reset the connection. Stopping the previous commands and restarting the tool process.",
                );
                current = this.#session;
            }

            current.id = message.session;

            // Output the daemon gave before this session was welcomed (none, normally).
            for (const each of current.outbox.resend(0) ?? []) {
                ws.send(each);
            }

            this.#log(`Connected to ${this.#options.link.server} as "${this.#options.link.name}".`);
            this.#welcomeApprovals(ws);

            return true;
        }

        if (message?.type === "ack") {
            if (!session.outbox.acknowledge(message.received)) {
                ws.close(1002, "Acknowledged bytes it was never sent");
            } else if (session.paused && session.outbox.unacknowledged < OUTBOX_LIMIT / 2) {
                session.paused = false;
                session.daemon.resume();
            }
        } else if (message?.type === "confirm") {
            void this.#answer(message);
        } else if (message?.type === "withdraw") {
            this.#questions.get(message.id)?.abort(WITHDRAWN);
        } else if (message?.type === "approval-code") {
            void this.#code(message.id, message.code);
        } else if (message?.type === "task" && welcomed) {
            void this.#task(ws, message);
        } else if (message?.type === "runner-action") {
            void this.#approvals.action(message.request).then(
                async () => {
                    this.#control({
                        type: "runner-result",
                        id: message.id,
                        ok: true,
                        state: await this.#approvals.state(),
                    });
                },
                (error: unknown) =>
                    this.#control({
                        type: "runner-result",
                        id: message.id,
                        ok: false,
                        reason: (error as Error).message,
                    }),
            );
        } else if (message?.type === "net-open") {
            void this.#authorizedStream(ws, message);
        } else if (
            message?.type === "net-end" ||
            message?.type === "net-reset" ||
            message?.type === "net-credit"
        ) {
            if (message.type === "net-reset") {
                this.#questions.get(`net-${message.id}`)?.abort();
                this.#connecting.get(message.id)?.destroy();
                this.#connecting.delete(message.id);
            }

            this.#streams?.message(message);
        } else if (message?.type === "bye") {
            this.#log(`Server message: ${message.reason}`);
        } else {
            ws.close(1002, "Unexpected message");
        }

        return welcomed;
    }

    /** Public state never contains the authenticator secret, failures, or accepted counter. */
    async #state(): Promise<void> {
        if (!this.connected) {
            return;
        }

        try {
            const state = await this.#approvals.state();
            const json = JSON.stringify(state);

            if (json !== this.#lastState) {
                this.#lastState = json;
                this.#control({ type: "runner-state", state });
            }
        } catch (error) {
            this.#log("Could not read runner permissions: " + String(error));
        }
    }

    /** A code from Pi Pocket for a question that waits here. Only this runner checks it. */
    async #code(id: string, code: string): Promise<void> {
        const pending = this.#pending.get(id);
        const allow =
            pending !== undefined &&
            !pending.stop.signal.aborted &&
            (await this.#approvals.code(code));

        this.#control({
            type: "code-result",
            id,
            allow,
            ...(allow ? {} : { reason: "That code is wrong or used. Try the next one." }),
        });

        if (allow && !pending!.stop.signal.aborted) {
            pending!.resolve({ allow: true, method: "totp" });
        }
    }

    /** Reattach the computer's open questions and saved answers to the welcomed link. */
    #welcomeApprovals(ws: WebSocket): void {
        this.#welcomed = ws;

        for (const notice of this.#notices.values()) {
            this.#control(notice);
        }

        this.#sendAnswers();
    }

    #sendAnswers(): void {
        if (this.#welcomed !== this.#socket || !this.connected) {
            return;
        }

        for (const [id, answer] of this.#answers) {
            this.#control(answer);
            this.#answers.delete(id);
        }
    }

    /** The server's question before a session starts, moves, or is copied here. */
    async #answer(question: Confirm): Promise<void> {
        const scope: SessionScope = {
            id: question.session,
            folder: question.folder,
            person: question.person,
        };
        const answer = await this.#approve(question.id, scope, question.kind, false);

        if (answer.withdrawn) {
            return;
        }

        this.#answers.set(question.id, {
            type: "confirmed",
            id: question.id,
            allow: answer.allow,
            ...(answer.allow
                ? {}
                : {
                      reason:
                          answer.reason ?? `${this.#options.link.name} did not allow the session.`,
                  }),
        });
        this.#sendAnswers();
    }

    /**
     * Approve session `scope` here: at once when its permission is valid, without a question when its folder is saved
     * and asking is off, else by the person here or a code from Pi Pocket. Questions for one session are shared. A
     * withdrawn or timed-out question saves nothing, even when a late answer comes.
     */
    async #approve(
        id: string,
        scope: SessionScope,
        kind: SessionQuestion["kind"],
        expired: boolean,
        signal?: AbortSignal,
    ): Promise<Approval> {
        const existing = [...this.#pending.values()].find((each) => each.scope.id === scope.id);

        if (existing !== undefined) {
            existing.hold(signal);

            return existing.promise;
        }

        const link = this.#options.link;
        const what = expired
            ? "a session to continue"
            : kind === "move"
              ? "a session move"
              : kind === "fork"
                ? "a copy of a session"
                : "a session";
        const stop = new AbortController();
        const abort = () => stop.abort();
        const totp = this.#settings().totp !== undefined;
        const timer = setTimeout(abort, totp ? ASK_TOTP_MS : ASK_MS);

        let resolveAnswer: (answer: Approval) => void = () => {};

        // The requests of one session share its question: it ends when the last of them is cancelled. A caller
        // without a signal (the server's own question) keeps it until it is answered, withdrawn, or times out.
        let holders = 0;
        let kept = false;
        const released: (() => void)[] = [];

        const hold = (more: AbortSignal | undefined) => {
            if (more === undefined) {
                kept = true;

                return;
            }

            if (more.aborted) {
                if (!kept && holders === 0) {
                    abort();
                }

                return;
            }

            const release = () => {
                holders--;

                if (!kept && holders === 0) {
                    abort();
                }
            };

            holders++;
            more.addEventListener("abort", release, { once: true });
            released.push(() => more.removeEventListener("abort", release));
        };

        hold(signal);

        const promise = (async (): Promise<Approval> => {
            try {
                if ((await this.#approvals.valid(scope)) !== undefined) {
                    return { allow: true };
                }

                // A permission keeps the real folder: a symlink changed later cannot widen it.
                const folder = await realFolder(scope.folder);
                const real = { ...scope, folder };
                const broad = broadFolder(folder, await realFolder(homedir()));
                const saved = await coveredFolder(folder, this.#settings().folders ?? []);
                let answer: Approval;

                if (saved && this.#settings().confirm === false) {
                    answer = { allow: true, method: "automatic" };
                    this.#log(`${scope.person} started ${what} in ${folder} (asking is off).`);
                } else if (this.#options.ask === undefined && !totp) {
                    answer = {
                        allow: false,
                        reason: `${link.name} asks before new sessions, but nobody can answer there: its runner runs without a terminal. Run it in a terminal or a program that runs the runner, such as the desktop app, or set up an authenticator there.`,
                    };
                } else {
                    const question: SessionQuestion = {
                        kind,
                        broad,
                        permission: saved ? "session" : "folder",
                        expired,
                        session: scope.id,
                        totp,
                        expiresInMs: totp ? ASK_TOTP_MS : ASK_MS,
                        person: scope.person,
                        folder,
                        server: link.server,
                        computer: link.name,
                        signal: stop.signal,
                    };

                    const notice: ApprovalNeeded = {
                        type: "approval-needed",
                        id,
                        session: scope.id,
                        folder,
                        permission: question.permission,
                        expired,
                        broad,
                        totp,
                    };

                    this.#notices.set(id, notice);

                    this.#control(notice);

                    answer = await new Promise<Approval>((resolve) => {
                        resolveAnswer = resolve;

                        const ended = () =>
                            resolve({
                                allow: false,
                                reason: `Nobody answered on ${link.name} in time.`,
                            });

                        if (stop.signal.aborted) {
                            ended();

                            return;
                        }

                        stop.signal.addEventListener("abort", ended, { once: true });
                        void this.#options.ask?.(question).then(
                            (got) =>
                                resolve(
                                    got.allow
                                        ? { allow: true, method: "computer" }
                                        : {
                                              allow: false,
                                              ...(got.reason === undefined
                                                  ? {}
                                                  : { reason: got.reason }),
                                          },
                                ),
                            () => resolve({ allow: false }),
                        );
                    });
                }

                if (stop.signal.reason === WITHDRAWN) {
                    this.#log(`${scope.person} cancelled ${what} in ${scope.folder}.`);

                    return { allow: false, withdrawn: true };
                }

                if (!answer.allow || answer.method === undefined || stop.signal.aborted) {
                    if (answer.method !== "automatic") {
                        this.#log(`Denied ${what} for ${scope.person} in ${folder}.`);
                    }

                    return answer.allow
                        ? { allow: false, reason: `Nobody answered on ${link.name} in time.` }
                        : answer;
                }

                if (!saved) {
                    await this.#approvals.saveFolder(folder);
                }

                await this.#approvals.approve(real, answer.method);

                if (answer.method !== "automatic") {
                    this.#log(
                        `Allowed ${what} for ${scope.person} in ${folder}${answer.method === "totp" ? " (with a code from the authenticator)" : ""}.`,
                    );
                }

                return { allow: true };
            } catch (error) {
                return {
                    allow: false,
                    reason: `${link.name} could not ask or save its answer: ${String(error)}`,
                };
            } finally {
                clearTimeout(timer);

                for (const release of released) {
                    release();
                }

                this.#notices.delete(id);
                this.#pending.delete(id);
                this.#questions.delete(id);

                if (this.connected) {
                    this.#control({ type: "approval-ended", id });
                }

                // Ends the question here (and a program's `PI-POCKET-CONFIRM-END`) after the answer is saved.
                stop.abort();
                void this.#state();
            }
        })();

        this.#questions.set(id, stop);
        this.#pending.set(id, {
            scope,
            stop,
            resolve: (answer) => resolveAnswer(answer),
            promise,
            hold,
        });

        return promise;
    }

    /** A network stream for a session's browser: only for a session with a valid permission. */
    async #authorizedStream(ws: WebSocket, open: NetOpen): Promise<void> {
        const scope = sessionScope(open.session);
        const stop = new AbortController();

        this.#questions.set(`net-${open.id}`, stop);

        try {
            const allowed =
                scope !== undefined &&
                ((await this.#approvals.valid(scope)) !== undefined ||
                    (await this.#approve(`resume-${scope.id}`, scope, "new", true, stop.signal))
                        .allow);

            if (allowed && ws.readyState === WebSocket.OPEN && !stop.signal.aborted) {
                this.#openStream(ws, open, this.#approvals.begin(scope.id));
            } else if (ws.readyState === WebSocket.OPEN && !stop.signal.aborted) {
                ws.send(
                    JSON.stringify({
                        type: "net-failed",
                        id: open.id,
                        code: "refused",
                        message: `Session not approved on ${this.#options.link.name}`,
                    } satisfies ControlMessage),
                );
            }
        } finally {
            this.#questions.delete(`net-${open.id}`);
        }
    }

    /**
     * The server asks for a TCP connection from this computer, for a session's browser: open it here, with this
     * computer's names and routes, unless its settings say not to share the network.
     */
    #openStream(ws: WebSocket, open: NetOpen, finish: () => void): void {
        const streams = this.#streams;

        const fail = (code: "refused" | "unreachable" | "timeout" | "limit", message: string) => {
            finish();

            // Errors only, not every connection: a page opens many.
            if (code !== "refused") {
                this.#log(`Browser connection failed: ${message}`);
            }

            if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                    JSON.stringify({
                        type: "net-failed",
                        id: open.id,
                        code,
                        message,
                    } satisfies ControlMessage),
                );
            }
        };

        if (streams === undefined || streams.has(open.id) || this.#connecting.has(open.id)) {
            finish();
            ws.close(1002, "A stream id in use");

            return;
        }

        if (this.#settings().network === false) {
            fail("refused", `${this.#options.link.name} does not share its network`);

            return;
        }

        if (streams.size + this.#connecting.size >= MAX_STREAMS) {
            fail("limit", `${this.#options.link.name} has too many open connections`);

            return;
        }

        const host = open.host.replace(/^\[|\]$/g, "");
        const socket = connectTcp({ host, port: open.port, allowHalfOpen: true });
        const timer = setTimeout(() => {
            socket.destroy();
            fail("timeout", `No answer from ${open.host}:${open.port} in ${CONNECT_MS / 1000} s`);
        }, CONNECT_MS);

        // Not `socket.connecting`: Node clears it before a failed connect's error event.
        let connected = false;

        timer.unref();
        this.#connecting.set(open.id, socket);
        socket.once("close", () => {
            finish();
            clearTimeout(timer);

            if (this.#connecting.get(open.id) === socket) {
                this.#connecting.delete(open.id);
            }
        });
        socket.once("error", (error: NodeJS.ErrnoException) => {
            if (!connected && this.#connecting.get(open.id) === socket) {
                clearTimeout(timer);
                this.#connecting.delete(open.id);
                fail("unreachable", `${open.host}:${open.port}: ${error.code ?? error.message}`);
            }
        });
        socket.once("connect", () => {
            connected = true;
            clearTimeout(timer);
            this.#connecting.delete(open.id);

            if (ws.readyState !== WebSocket.OPEN || this.#streams !== streams) {
                socket.destroy();

                return;
            }

            this.opened++;
            ws.send(JSON.stringify({ type: "net-opened", id: open.id } satisfies ControlMessage));
            streams.attach(open.id, socket);
        });
    }

    #onData(ws: WebSocket, bytes: Buffer): void {
        const session = this.#session;
        const fresh = session.inbox.take(bytes);

        if (fresh === undefined) {
            ws.close(1002, "A gap in the stream");

            return;
        }

        let frames: Buffer[];

        try {
            frames = session.splitter.push(fresh);
        } catch (error) {
            this.#restart(
                `The server sent invalid tool data: ${(error as Error).message}\nRestarting the tool process. Update Pi Pocket if this repeats.`,
            );
            ws.close(1002, "Corrupt frame");

            return;
        }

        for (const whole of frames) {
            try {
                session.gate.input(whole);
            } catch {
                ws.close(1002, "Invalid request frame");
            }
        }

        if (session.inbox.unacknowledged >= ACK_BYTES) {
            this.#ack();
        } else if (this.#ackTimer === undefined) {
            this.#ackTimer = setTimeout(() => this.#ack(), ACK_MS);
            this.#ackTimer.unref();
        }
    }
}
