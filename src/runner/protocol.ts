/**
 * The link between a Pi Pocket server and a runner (`pi-pocket runner`), shared by both sides.
 *
 * The runner runs Earendil's pi-env daemon on its computer and connects out to the server over one WebSocket. The link
 * carries two byte streams: pi-env frames from the server to the daemon, and the daemon's frames back. Pi Pocket does
 * not read or change them, except that the runner sends the daemon a ping of its own every few seconds, between frames,
 * so the daemon keeps running while the link is down.
 *
 * The streams survive a drop of any length. Both sides count the bytes of each stream, keep what the other side has not
 * acknowledged, and send it again after a reconnect, starting where the other side says it stopped. Nothing is lost or
 * repeated, so the daemon's handles, watches, and commands stay valid. The server keeps its side for as long as it runs
 * (offline is offline, `docs/runners.md`); after it restarts, or when the runner quit, the runner starts a new daemon and
 * the old work ends.
 *
 * Beside them, a runner that says `network` in its hello carries network streams (`tunnels.ts`): TCP connections that
 * the server asks the runner to open on its computer, for the browser of a session there. They do not survive a drop.
 *
 * Messages:
 * - Text: JSON control messages (`ControlMessage`).
 * - Binary: pi-env stream data. 8 bytes of the data's offset in its stream (unsigned, big-endian), then the bytes.
 *   Offsets stay below 2^53, so the first byte is 0.
 * - Binary, first byte `STREAM_DATA`: network stream data. 4 bytes of the stream's id (big-endian), then the bytes.
 */

/** The link protocol's version. Both sides refuse a different one. */
export const LINK_PROTOCOL = 1;

/** The WebSocket subprotocol a runner asks for. */
export const LINK_SUBPROTOCOL = `pi-pocket-runner.${LINK_PROTOCOL}`;

/** Where a runner connects, on the server. */
export const LINK_PATH = "/runner/socket";

/** Where a runner exchanges a one-time code for its key, on the server. */
export const LINK_CODE_PATH = "/runner/link";

/** WebSocket close codes with a meaning for the runner. */
export const CLOSE = {
    /** Another connection of the same computer took over: this runner stops. */
    replaced: 4000,
    /** The computer was removed from the server: its key no longer works, and the runner stops. */
    removed: 4001,
    /** The two sides speak different link protocols: the runner stops. */
    protocol: 4002,
} as const;

/**
 * What the server says in `welcome.graceMs`. It keeps a dropped runner's work for as long as it runs, so this is only for
 * runners from before that, which stop their daemon this long after a drop: about 23 days, under the 2^31 - 1 ms that a
 * Node timer takes (a larger one fires at once).
 */
export const LEGACY_GRACE_MS = 2_000_000_000;

/** The largest WebSocket message either side accepts: one pi-env frame (16 MiB) and some room. */
export const MAX_MESSAGE = 17 * 1024 * 1024;

/** pi-env's frame types, from its protocol (`@earendil-works/pi-env/docs/protocol.md`). */
export const FRAME = { request: 1, result: 2, error: 3, event: 4, cancel: 5, ping: 6 } as const;

/** pi-env's largest frame. */
export const MAX_FRAME = 16 * 1024 * 1024;

/** Programs ready on the runner, checked at each connection; older runners do not send this. */
export type RunnerTools = { git: boolean; gh: boolean; github: boolean };

import type { ApprovalState, RunnerAction, SessionScope } from "./approvals.ts";
export type { ApprovalState, RunnerAction, SessionScope } from "./approvals.ts";

/** Removed by the runner before a request reaches pi-env. Negotiated with hello/welcome.approvals. */
export const SESSION_FIELD = "_pocketSession";
export type ApprovalNeeded = {
    type: "approval-needed";
    id: string;
    session: string;
    folder: string;
    permission: "folder" | "session";
    expired: boolean;
    broad: boolean;
    totp: boolean;
};
export type ApprovalEnded = { type: "approval-ended"; id: string };
export type ApprovalCode = { type: "approval-code"; id: string; code: string };
export type CodeResult = { type: "code-result"; id: string; allow: boolean; reason?: string };
export type StateMessage = { type: "runner-state"; state: ApprovalState };
export type ActionMessage = { type: "runner-action"; id: string; request: RunnerAction };
export type ActionResult = {
    type: "runner-result";
    id: string;
    ok: boolean;
    reason?: string;
    state?: ApprovalState;
};

/** Runner-owned background tasks, independent of the pi-env daemon session. */
export type TaskRequest = { type: "task"; id: string; permission: string } & (
    | {
          op: "start";
          task: string;
          command: string;
          cwd: string;
          env: Record<string, string>;
          segment: number;
      }
    | { op: "list" }
    | { op: "signal"; task: string; signal: "TERM" | "KILL" }
);
export type TaskResult = {
    type: "task-result";
    id: string;
    ok: boolean;
    error?: string;
    pid?: number;
    /** `left`: of a task whose shell ended, the processes it started that still run, as the runner found them. */
    tasks?: { task: string; pid: number; ended?: true; left?: number[] }[];
};

/** Runner to server, first: who it is and where its stream from the server stopped. */
export type Hello = {
    type: "hello";
    protocol: number;
    /** The link session the runner's daemon belongs to, null for a daemon that has none yet. */
    session: string | null;
    /** Bytes of the server's stream the runner received in that session. */
    received: number;
    /** The runner's Pi Pocket version, for the computers list. */
    version: string;
    /**
     * The runner answers `Confirm`: it decides on its computer whether a new session may start there. Absent (a runner
     * older than this): the server does not ask, and sessions start as before.
     */
    asks?: boolean;
    /** Enforces and reports per-session grants, TOTP, and settings. */
    approvals?: boolean;
    /** The runner understands `Withdraw`: a session question can be cancelled by the server. */
    withdraws?: boolean;
    /** Background tasks belong to this runner process, not its tool daemon. */
    tasks?: true;
    tools?: RunnerTools;
    /** The runner opens network streams (`net-open`). Absent (an older runner): the server asks it for none. */
    network?: boolean;
    /** The folder for its browser downloads, absolute (`settings downloads`). Absent: its temporary folder. */
    downloads?: string;
};

/**
 * Server to runner, before a session starts on its computer: who wants it and where. The runner asks its person (or
 * not, as its settings say) and answers with `Confirmed`.
 */
export type Confirm = {
    type: "confirm";
    id: string;
    /** A new session, a fork (a copy), or a change of working folder. */
    kind: "new" | "fork" | "move";
    /** Moves travel as kind new + move so older runners still ask rather than reject the message. */
    move?: true;
    /** Who asked, by their name on the server. */
    person: string;
    /** The folder on this computer. */
    folder: string;
    /** Root session permission, absent on older servers. */
    session?: string;
};

/** Runner to server: the answer to `Confirm`; `reason` says why not, in words for the person who asked. */
export type Confirmed = { type: "confirmed"; id: string; allow: boolean; reason?: string };

/** Server to runner: the session question with this id no longer stands. */
export type Withdraw = { type: "withdraw"; id: string };

/** Server to runner, the answer to `Hello`. */
export type Welcome = {
    type: "welcome";
    session: string;
    /** True: the session goes on, and `received` says where. False: a new session, and the runner starts a new daemon. */
    resume: boolean;
    /** Bytes of the runner's stream the server received in that session. */
    received: number;
    /** Unused since the server keeps the session while it runs (`LEGACY_GRACE_MS`); older runners read it. */
    graceMs: number;
    /** Requests carry SESSION_FIELD, and net-open carries its session scope. */
    approvals?: boolean;
};

/** Either side: bytes of the other side's stream received so far, so the other side can drop them. */
export type Ack = { type: "ack"; received: number };

/** Either side, before it closes the link on purpose: why. */
export type Bye = { type: "bye"; reason: string };

/** Server to runner: open a TCP connection to `host`:`port` on the computer, as stream `id`. */
export type NetOpen = {
    type: "net-open";
    id: number;
    host: string;
    port: number;
    session?: SessionScope;
};

/** Runner to server: stream `id` is connected. */
export type NetOpened = { type: "net-opened"; id: number };

/**
 * Why a stream did not open: the runner does not share its network (`refused`), the connection failed (`unreachable`)
 * or took too long (`timeout`), or too many streams are open (`limit`).
 */
export type NetFailure = "refused" | "unreachable" | "timeout" | "limit";

/** Runner to server: stream `id` did not open; `message` says why, for people. */
export type NetFailed = { type: "net-failed"; id: number; code: NetFailure; message: string };

/** Either side: no more bytes of stream `id` come from this side. */
export type NetEnd = { type: "net-end"; id: number };

/** Either side: stream `id` is abandoned, in both directions. */
export type NetReset = { type: "net-reset"; id: number; message?: string };

/** Either side: the other side may send `bytes` more of stream `id` (`tunnels.ts`). */
export type NetCredit = { type: "net-credit"; id: number; bytes: number };

export type NetMessage = NetOpen | NetOpened | NetFailed | NetEnd | NetReset | NetCredit;

export type ControlMessage =
    | Hello
    | Welcome
    | Ack
    | Bye
    | Confirm
    | Confirmed
    | Withdraw
    | NetMessage
    | ApprovalNeeded
    | ApprovalEnded
    | ApprovalCode
    | CodeResult
    | StateMessage
    | ActionMessage
    | ActionResult
    | TaskRequest
    | TaskResult;

/** The first byte of a network stream's binary message. */
export const STREAM_DATA = 1;

const NET_FAILURES = new Set(["refused", "unreachable", "timeout", "limit"]);

/** Parse a text message; undefined for anything that is not a control message. */
export function parseControl(text: string): ControlMessage | undefined {
    let value: unknown;

    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }

    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const message = value as Record<string, unknown>;
    const count = (key: string) =>
        typeof message[key] === "number" && Number.isSafeInteger(message[key]) && message[key] >= 0;
    const stream = count("id") && (message.id as number) <= 0xffffffff;

    switch (message.type) {
        case "approval-needed":
            return typeof message.id === "string" &&
                typeof message.session === "string" &&
                typeof message.folder === "string" &&
                ["folder", "session"].includes(message.permission as string) &&
                typeof message.expired === "boolean" &&
                typeof message.broad === "boolean" &&
                typeof message.totp === "boolean"
                ? (message as ApprovalNeeded)
                : undefined;
        case "approval-ended":
            return typeof message.id === "string" ? (message as ApprovalEnded) : undefined;
        case "approval-code":
            return typeof message.id === "string" && typeof message.code === "string"
                ? (message as ApprovalCode)
                : undefined;
        case "code-result":
            return typeof message.id === "string" && typeof message.allow === "boolean"
                ? (message as CodeResult)
                : undefined;
        case "runner-state":
            return typeof message.state === "object" && message.state !== null
                ? (message as StateMessage)
                : undefined;

        case "runner-action": {
            const request = message.request as Record<string, unknown> | undefined;

            return typeof message.id === "string" &&
                request !== null &&
                typeof request === "object" &&
                ((request.action === "revoke" && typeof request.session === "string") ||
                    (request.action === "remove-folder" && typeof request.folder === "string") ||
                    (request.action === "settings" &&
                        typeof request.code === "string" &&
                        typeof request.change === "object" &&
                        request.change !== null &&
                        !Array.isArray(request.change)))
                ? (message as ActionMessage)
                : undefined;
        }

        case "task": {
            if (typeof message.id !== "string" || typeof message.permission !== "string") {
                return undefined;
            }

            if (message.op === "list") {
                return message as TaskRequest;
            }

            if (typeof message.task !== "string") {
                return undefined;
            }

            if (message.op === "signal") {
                return message.signal === "TERM" || message.signal === "KILL"
                    ? (message as TaskRequest)
                    : undefined;
            }

            return message.op === "start" &&
                typeof message.command === "string" &&
                typeof message.cwd === "string" &&
                count("segment") &&
                (message.segment as number) > 0 &&
                typeof message.env === "object" &&
                message.env !== null &&
                !Array.isArray(message.env) &&
                Object.values(message.env).every((value) => typeof value === "string")
                ? (message as TaskRequest)
                : undefined;
        }

        case "task-result":
            return typeof message.id === "string" &&
                typeof message.ok === "boolean" &&
                (message.error === undefined || typeof message.error === "string") &&
                (message.pid === undefined || (count("pid") && (message.pid as number) > 0)) &&
                (message.tasks === undefined ||
                    (Array.isArray(message.tasks) &&
                        message.tasks.every((item: unknown) => {
                            const task = item as {
                                task?: unknown;
                                pid?: unknown;
                                left?: unknown;
                            } | null;

                            return (
                                task !== null &&
                                typeof task?.task === "string" &&
                                Number.isSafeInteger(task.pid) &&
                                (task.pid as number) > 0 &&
                                (task.left === undefined ||
                                    (Array.isArray(task.left) &&
                                        task.left.every(
                                            (pid) => Number.isSafeInteger(pid) && pid > 0,
                                        )))
                            );
                        })))
                ? (message as TaskResult)
                : undefined;
        case "runner-result":
            return typeof message.id === "string" && typeof message.ok === "boolean"
                ? (message as ActionResult)
                : undefined;
        case "net-open":
            return stream &&
                typeof message.host === "string" &&
                message.host !== "" &&
                count("port") &&
                (message.port as number) <= 65535
                ? (message as NetOpen)
                : undefined;
        case "net-opened":
        case "net-end":
            return stream ? (message as NetOpened | NetEnd) : undefined;
        case "net-failed":
            return stream &&
                NET_FAILURES.has(message.code as string) &&
                typeof message.message === "string"
                ? (message as NetFailed)
                : undefined;
        case "net-reset":
            return stream && (message.message === undefined || typeof message.message === "string")
                ? (message as NetReset)
                : undefined;
        case "net-credit":
            return stream && count("bytes") ? (message as NetCredit) : undefined;
        case "hello":
            return typeof message.protocol === "number" &&
                (message.session === null || typeof message.session === "string") &&
                count("received") &&
                typeof message.version === "string" &&
                (message.tools === undefined ||
                    (typeof message.tools === "object" &&
                        message.tools !== null &&
                        ["git", "gh", "github"].every(
                            (name) =>
                                typeof (message.tools as Record<string, unknown>)[name] ===
                                "boolean",
                        )))
                ? (message as Hello)
                : undefined;
        case "welcome":
            return typeof message.session === "string" &&
                typeof message.resume === "boolean" &&
                count("received") &&
                count("graceMs")
                ? (message as Welcome)
                : undefined;
        case "ack":
            return count("received") ? (message as Ack) : undefined;
        case "bye":
            return typeof message.reason === "string" ? (message as Bye) : undefined;
        case "confirm":
            return typeof message.id === "string" &&
                (message.kind === "new" || message.kind === "fork" || message.kind === "move") &&
                typeof message.person === "string" &&
                typeof message.folder === "string"
                ? (message as Confirm)
                : undefined;
        case "withdraw":
            return typeof message.id === "string" ? (message as Withdraw) : undefined;
        case "confirmed":
            return typeof message.id === "string" &&
                typeof message.allow === "boolean" &&
                (message.reason === undefined || typeof message.reason === "string")
                ? (message as Confirmed)
                : undefined;
        default:
            return undefined;
    }
}

/** A binary message: `bytes` at `offset` of its stream. */
export function dataMessage(offset: number, bytes: Uint8Array): Buffer {
    const message = Buffer.allocUnsafe(8 + bytes.length);

    message.writeBigUInt64BE(BigInt(offset), 0);
    message.set(bytes, 8);

    return message;
}

/** A network stream's binary message: `bytes` of stream `id`. */
export function streamData(id: number, bytes: Uint8Array): Buffer {
    const message = Buffer.allocUnsafe(5 + bytes.length);

    message.writeUInt8(STREAM_DATA, 0);
    message.writeUInt32BE(id, 1);
    message.set(bytes, 5);

    return message;
}

/** Read a network stream's binary message; undefined when it is not one. */
export function readStreamData(message: Buffer): { id: number; bytes: Buffer } | undefined {
    if (message.length < 5 || message[0] !== STREAM_DATA) {
        return undefined;
    }

    return { id: message.readUInt32BE(1), bytes: message.subarray(5) };
}

/** Read a binary message; undefined when it is too short to be one. */
export function readData(message: Buffer): { offset: number; bytes: Buffer } | undefined {
    if (message.length < 8) {
        return undefined;
    }

    const offset = message.readBigUInt64BE(0);

    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
        return undefined;
    }

    return { offset: Number(offset), bytes: message.subarray(8) };
}

/**
 * The bytes a side sends on one stream and keeps until the other side acknowledges them, numbered from the start of the
 * stream, so it can send them again after a reconnect.
 */
export class Outbox {
    #chunks: { offset: number; bytes: Buffer }[] = [];
    /** Bytes written so far: the next chunk's offset. */
    #end = 0;
    /** Bytes the other side acknowledged. */
    #acked = 0;

    get end(): number {
        return this.#end;
    }

    /** Bytes kept for the other side: written, not yet acknowledged. */
    get unacknowledged(): number {
        return this.#end - this.#acked;
    }

    /** Keep `bytes` as the stream's next ones; returns the binary message that sends them. */
    write(bytes: Uint8Array): Buffer {
        const chunk = { offset: this.#end, bytes: Buffer.from(bytes) };

        this.#chunks.push(chunk);
        this.#end += bytes.length;

        return dataMessage(chunk.offset, chunk.bytes);
    }

    /** The other side has the stream up to `received`: forget those bytes. False when `received` is past the end. */
    acknowledge(received: number): boolean {
        if (received > this.#end) {
            return false;
        }

        if (received <= this.#acked) {
            return true;
        }

        this.#acked = received;

        while (this.#chunks.length > 0) {
            const first = this.#chunks[0]!;

            if (first.offset + first.bytes.length > received) {
                break;
            }

            this.#chunks.shift();
        }

        return true;
    }

    /** The messages that send everything from `received` on again, after a reconnect; undefined when it is gone. */
    resend(received: number): Buffer[] | undefined {
        if (received < this.#acked || !this.acknowledge(received)) {
            return undefined;
        }

        return this.#chunks.map((chunk) => {
            const skip = Math.max(0, received - chunk.offset);

            return dataMessage(chunk.offset + skip, chunk.bytes.subarray(skip));
        });
    }
}

/**
 * The receiving end of one stream: takes binary messages, drops bytes it already has (sent again after a reconnect),
 * and says how many it received.
 */
export class Inbox {
    #received = 0;
    #unacknowledged = 0;

    get received(): number {
        return this.#received;
    }

    /** Bytes received since the last acknowledgement. */
    get unacknowledged(): number {
        return this.#unacknowledged;
    }

    acknowledged(): void {
        this.#unacknowledged = 0;
    }

    /**
     * The new bytes of a data message, possibly none; undefined when the message leaves a gap in the stream, which a
     * correct peer never sends.
     */
    take(message: Buffer): Buffer | undefined {
        const data = readData(message);

        if (data === undefined || data.offset > this.#received) {
            return undefined;
        }

        const fresh = data.bytes.subarray(this.#received - data.offset);

        this.#received += fresh.length;
        this.#unacknowledged += fresh.length;

        return fresh;
    }
}

/** Splits a byte stream into whole pi-env frames (each with its 4-byte length). */
export class FrameSplitter {
    #chunks: Buffer[] = [];
    #buffered = 0;

    /** Whether part of a frame is waiting for the rest. */
    get partial(): boolean {
        return this.#buffered > 0;
    }

    /** Add bytes; returns the frames they complete. Throws on a frame no pi-env side sends. */
    push(bytes: Buffer): Buffer[] {
        if (bytes.length > 0) {
            this.#chunks.push(bytes);
            this.#buffered += bytes.length;
        }

        const frames: Buffer[] = [];

        while (this.#buffered >= 4) {
            const head = this.#peek(4);
            const length = head.readUInt32BE(0);

            if (length < 9 || length > MAX_FRAME) {
                throw new Error(`Corrupt pi-env frame (length ${length})`);
            }

            if (this.#buffered < 4 + length) {
                break;
            }

            frames.push(this.#take(4 + length));
        }

        return frames;
    }

    #peek(size: number): Buffer {
        if (this.#chunks[0]!.length >= size) {
            return this.#chunks[0]!.subarray(0, size);
        }

        const all = Buffer.concat(this.#chunks);

        this.#chunks = [all];

        return all.subarray(0, size);
    }

    #take(size: number): Buffer {
        const all = this.#chunks.length === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks);
        const taken = Buffer.from(all.subarray(0, size));
        const rest = all.subarray(size);

        this.#chunks = rest.length === 0 ? [] : [rest];
        this.#buffered -= size;

        return taken;
    }
}

/** Strings as well-formed UTF-16, as pi-env sends them: a lone surrogate becomes U+FFFD. */
function wellFormed(_key: string, value: unknown): unknown {
    return typeof value === "string" ? value.toWellFormed() : value;
}

/** One pi-env frame, as `@earendil-works/pi-env`'s client writes it. */
export function frame(type: number, id: number, json: object, payload?: Uint8Array): Buffer {
    const body = Buffer.from(JSON.stringify(json, wellFormed), "utf8");
    const extra = payload?.length ?? 0;
    const out = Buffer.allocUnsafe(13 + body.length + extra);

    out.writeUInt32BE(9 + body.length + extra, 0);
    out.writeUInt8(type, 4);
    out.writeUInt32BE(id, 5);
    out.writeUInt32BE(body.length, 9);
    body.copy(out, 13);

    if (payload !== undefined && extra > 0) {
        out.set(payload, 13 + body.length);
    }

    return out;
}

/** A whole frame's parts; throws on one that is not valid. */
export function readFrame(whole: Buffer): {
    type: number;
    id: number;
    json: Record<string, unknown>;
    payload: Uint8Array;
} {
    const body = whole.subarray(4);
    const type = body.readUInt8(0);
    const id = body.readUInt32BE(1);
    const jsonLength = body.readUInt32BE(5);

    if (9 + jsonLength > body.length) {
        throw new Error("Corrupt pi-env frame (JSON length out of range)");
    }

    const json = JSON.parse(body.subarray(9, 9 + jsonLength).toString("utf8")) as unknown;

    if (typeof json !== "object" || json === null || Array.isArray(json)) {
        throw new Error("Corrupt pi-env frame (JSON is not an object)");
    }

    return {
        type,
        id,
        json: json as Record<string, unknown>,
        payload: new Uint8Array(body.subarray(9 + jsonLength)),
    };
}
