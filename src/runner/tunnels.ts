/**
 * Network streams on a runner link, shared by both sides (`protocol.ts`): TCP connections that the runner opens on its
 * computer for the server, so a session's browser reaches the web from that computer.
 *
 * Each stream has a credit window per direction: a side sends at most `WINDOW` bytes the other side has not consumed,
 * and the other side gives credit back (`net-credit`) as its socket takes the bytes. A slow reader therefore holds back
 * only its own stream. The link carries at most `LINK_WINDOW` bytes of stream data not yet written to the WebSocket's
 * connection, taken from the streams in turn, so pi-env's frames, which skip this queue, wait behind little of it.
 *
 * Streams do not survive a drop: when the link goes, every stream ends at once (`dropAll`), and the browser retries.
 *
 * Sockets given to `attach` must allow half-open connections (`allowHalfOpen`): each direction ends on its own, with
 * `net-end`, and a socket closes only when both did.
 */
import type { Duplex } from "node:stream";
import { type NetMessage, streamData } from "./protocol.ts";

/** Bytes a side may send on one stream before the other side gives credit back. */
export const WINDOW = 256 * 1024;

/** Bytes of stream data on their way into the WebSocket's connection, for all streams together. */
const LINK_WINDOW = 128 * 1024;

/** The largest piece of a stream in one message. */
const PIECE = 32 * 1024;

/** Give credit back once this much was consumed. */
const CREDIT_STEP = 64 * 1024;

/** Open streams one computer may have at once. */
export const MAX_STREAMS = 256;

/** How long the runner tries to connect, and how long the server waits for it (a little longer). */
export const CONNECT_MS = 10_000;

type Stream = {
    id: number;
    socket: Duplex;
    /** Bytes read from the socket, waiting to be sent. */
    queue: Buffer[];
    queued: number;
    /** Bytes the other side may still take. */
    credit: number;
    /** Bytes written to the socket and consumed, not yet given back as credit. */
    consumed: number;
    /** Bytes received and not yet given back: the other side's view of its own window. */
    outstanding: number;
    /** The socket's reading side ended: send `net-end` once the queue is empty. */
    readEnded: boolean;
    endSent: boolean;
    /** The other side sent `net-end`. */
    endReceived: boolean;
    paused: boolean;
    /** The socket closed after its reading side ended: what it gave still goes out, then the stream is done. */
    gone: boolean;
};

export type StreamLinkOptions = {
    /** Send a binary message; `done` once it is written out (or failed). False: the link is down. */
    send(message: Buffer, done: () => void): boolean;
    control(message: NetMessage): void;
    /** A stream ended (its socket closed), with an error when it did not end cleanly. */
    closed?(id: number, error?: string): void;
};

/** The streams of one link connection, on either side. */
export class StreamLink {
    readonly #options: StreamLinkOptions;
    readonly #streams = new Map<number, Stream>();
    /** Streams with bytes and credit, in turn. */
    #turn: number[] = [];
    #inFlight = 0;

    constructor(options: StreamLinkOptions) {
        this.#options = options;
    }

    get size(): number {
        return this.#streams.size;
    }

    has(id: number): boolean {
        return this.#streams.has(id);
    }

    /** Relay stream `id` to and from `socket`, sending `first` before what the socket gives. */
    attach(id: number, socket: Duplex, first: readonly Buffer[] = []): void {
        const stream: Stream = {
            id,
            socket,
            queue: [],
            queued: 0,
            credit: WINDOW,
            consumed: 0,
            outstanding: 0,
            readEnded: false,
            endSent: false,
            endReceived: false,
            paused: false,
            gone: false,
        };

        this.#streams.set(id, stream);

        for (const bytes of first) {
            if (bytes.length > 0) {
                stream.queue.push(bytes);
                stream.queued += bytes.length;
            }
        }

        socket.on("data", (chunk: Buffer) => {
            if (this.#streams.get(id) !== stream) {
                return;
            }

            stream.queue.push(chunk);
            stream.queued += chunk.length;

            if (stream.queued >= WINDOW && !stream.paused) {
                stream.paused = true;
                socket.pause();
            }

            this.#ready(stream);
        });
        socket.on("end", () => {
            stream.readEnded = true;
            this.#ready(stream);
        });
        socket.on("error", () => {});
        socket.on("close", (hadError: boolean) => {
            if (this.#streams.get(id) !== stream) {
                return;
            }

            if (stream.readEnded && !hadError) {
                stream.gone = true;
                this.#ready(stream);

                return;
            }

            this.#streams.delete(id);
            this.#options.control({ type: "net-reset", id });
            this.#options.closed?.(id, "The connection closed");
        });
        this.#ready(stream);
    }

    /** Bytes of stream `id` from the other side. */
    data(id: number, bytes: Buffer): void {
        const stream = this.#streams.get(id);

        if (stream === undefined) {
            return;
        }

        stream.outstanding += bytes.length;

        // More than it was allowed: a broken peer. Only this stream pays.
        if (stream.outstanding > WINDOW || stream.endReceived) {
            this.reset(id, "Stream data out of order");

            return;
        }

        // Closed here already: nobody reads these bytes.
        if (stream.gone) {
            return;
        }

        stream.socket.write(bytes, () => {
            if (this.#streams.get(id) !== stream) {
                return;
            }

            stream.consumed += bytes.length;

            if (stream.consumed >= CREDIT_STEP) {
                stream.outstanding -= stream.consumed;
                this.#options.control({ type: "net-credit", id, bytes: stream.consumed });
                stream.consumed = 0;
            }
        });
    }

    /** A control message about one of these streams. */
    message(message: NetMessage): void {
        const stream = this.#streams.get(message.id);

        if (stream === undefined) {
            return;
        }

        if (message.type === "net-credit") {
            stream.credit += message.bytes;

            if (stream.credit > WINDOW) {
                this.reset(stream.id, "Too much credit");

                return;
            }

            this.#ready(stream);
        } else if (message.type === "net-end") {
            stream.endReceived = true;
            stream.socket.end();
        } else if (message.type === "net-reset") {
            this.#streams.delete(stream.id);
            stream.socket.destroy();
            this.#options.closed?.(stream.id, message.message ?? "reset");
        }
    }

    /** Abandon stream `id` here, and tell the other side. */
    reset(id: number, message?: string): void {
        const stream = this.#streams.get(id);

        if (stream === undefined) {
            return;
        }

        this.#streams.delete(id);
        this.#options.control({
            type: "net-reset",
            id,
            ...(message === undefined ? {} : { message }),
        });
        stream.socket.destroy();
        this.#options.closed?.(id, message ?? "reset");
    }

    /** The link went down: every stream ends now, without a word to the other side, which does the same. */
    dropAll(): void {
        const streams = [...this.#streams.values()];

        this.#streams.clear();
        this.#turn = [];

        for (const stream of streams) {
            stream.socket.destroy();
            this.#options.closed?.(stream.id, "The link dropped");
        }
    }

    #ready(stream: Stream): void {
        if (!this.#turn.includes(stream.id)) {
            this.#turn.push(stream.id);
        }

        this.#pump();
    }

    /** Send what the streams have, in turn, while the link has room. */
    #pump(): void {
        while (this.#inFlight < LINK_WINDOW && this.#turn.length > 0) {
            const id = this.#turn.shift()!;
            const stream = this.#streams.get(id);

            if (stream === undefined) {
                continue;
            }

            if (stream.queued === 0) {
                if (stream.readEnded && !stream.endSent) {
                    stream.endSent = true;
                    this.#options.control({ type: "net-end", id });
                }

                if (stream.endSent && stream.gone) {
                    this.#streams.delete(id);
                    this.#options.closed?.(id);
                }

                continue;
            }

            if (stream.credit === 0) {
                // It comes back in turn when credit arrives.
                continue;
            }

            const head = stream.queue[0]!;
            const size = Math.min(head.length, stream.credit, PIECE);
            const piece = head.subarray(0, size);

            if (size === head.length) {
                stream.queue.shift();
            } else {
                stream.queue[0] = head.subarray(size);
            }

            stream.queued -= size;
            stream.credit -= size;
            this.#inFlight += size;

            const sent = this.#options.send(streamData(id, piece), () => {
                this.#inFlight -= size;
                this.#pump();
            });

            if (!sent) {
                this.#inFlight -= size;
                this.dropAll();

                return;
            }

            if (stream.paused && stream.queued < WINDOW / 2) {
                stream.paused = false;
                stream.socket.resume();
            }

            if (stream.queued > 0 || stream.readEnded) {
                this.#turn.push(id);
            }
        }
    }
}
