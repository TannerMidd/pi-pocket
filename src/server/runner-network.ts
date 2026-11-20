/**
 * The server's side of a runner link's network streams (`src/runner/tunnels.ts`): TCP connections that the computer
 * opens for the server, so a session's browser reaches the web from that computer, never from this server. One per link
 * connection: when the connection drops, every stream ends, and the browser opens them again.
 */
import type { Duplex } from "node:stream";
import type { NetFailure, NetMessage } from "../runner/protocol.ts";
import { CONNECT_MS, MAX_STREAMS, StreamLink } from "../runner/tunnels.ts";

/** Why a connection through a computer did not open: its runner's reason, or the link's. */
export type NetProblem = NetFailure | "offline";

export class NetError extends Error {
    readonly code: NetProblem;

    constructor(code: NetProblem, message: string) {
        super(message);
        this.code = code;
    }
}

/** How to relay a stream once it opened. */
export type OpenOptions = {
    /** Bytes for the computer, ahead of what the socket gives. */
    first?: Buffer[];
    session?: import("../runner/protocol.ts").SessionScope;
    /** Called as the computer connected, before anything from it reaches the socket: write a reply, say. */
    opened?: () => void;
};

type Opening = {
    socket: Duplex;
    options: OpenOptions;
    resolve: () => void;
    reject: (error: NetError) => void;
    timer: NodeJS.Timeout;
};

export class LinkNetwork {
    readonly #name: () => string;
    readonly #control: (message: NetMessage) => void;
    readonly #streams: StreamLink;
    readonly #opening = new Map<number, Opening>();
    #next = 1;
    #dropped = false;

    constructor(options: {
        /** The computer's name, for messages. */
        name: () => string;
        send(message: Buffer, done: () => void): boolean;
        control(message: NetMessage): void;
    }) {
        this.#name = options.name;
        this.#control = options.control;
        this.#streams = new StreamLink({ send: options.send, control: options.control });
    }

    /** Streams open or opening. */
    get size(): number {
        return this.#streams.size + this.#opening.size;
    }

    /**
     * Have the computer connect to `host`:`port`, then relay `socket` to it. Rejects with the computer's reason when it
     * does not connect; `socket` is the caller's to close then.
     */
    open(host: string, port: number, socket: Duplex, options: OpenOptions = {}): Promise<void> {
        if (this.#dropped) {
            return Promise.reject(this.#offline());
        }

        if (this.size >= MAX_STREAMS) {
            return Promise.reject(
                new NetError("limit", `${this.#name()} has too many open connections`),
            );
        }

        const id = this.#id();

        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => {
                    this.#opening.delete(id);
                    this.#control({ type: "net-reset", id });
                    reject(
                        new NetError(
                            "timeout",
                            `${this.#name()} did not connect to ${host}:${port} in ${CONNECT_MS / 1000} s`,
                        ),
                    );
                },
                options.session === undefined ? CONNECT_MS + 2000 : 312_000,
            );

            timer.unref();
            // What the browser sends while the computer connects waits in the socket.
            socket.pause();
            this.#opening.set(id, { socket, options, resolve, reject, timer });
            // The browser gave up before the computer answered.
            socket.once("close", () => {
                if (this.#opening.get(id)?.socket === socket) {
                    this.#opening.delete(id);
                    clearTimeout(timer);
                    this.#control({ type: "net-reset", id });
                    reject(new NetError("unreachable", "The browser closed the connection"));
                }
            });
            this.#control({
                type: "net-open",
                id,
                host,
                port,
                ...(options.session === undefined ? {} : { session: options.session }),
            });
        });
    }

    /** Bytes of a stream from the computer. */
    data(id: number, bytes: Buffer): void {
        this.#streams.data(id, bytes);
    }

    /** A stream's control message from the computer. */
    message(message: NetMessage): void {
        const opening = this.#opening.get(message.id);

        if (opening !== undefined) {
            this.#opening.delete(message.id);
            clearTimeout(opening.timer);

            if (message.type === "net-opened") {
                opening.options.opened?.();
                this.#streams.attach(message.id, opening.socket, opening.options.first);
                opening.socket.resume();
                opening.resolve();
            } else if (message.type === "net-failed") {
                opening.reject(new NetError(message.code, message.message));
            } else {
                opening.reject(
                    new NetError("unreachable", `${this.#name()} closed the connection`),
                );
            }

            return;
        }

        this.#streams.message(message);
    }

    /** The link connection went: every stream ends, and what is opening fails as offline. */
    drop(): void {
        this.#dropped = true;
        this.#streams.dropAll();

        const opening = [...this.#opening.values()];

        this.#opening.clear();

        for (const each of opening) {
            clearTimeout(each.timer);
            each.reject(this.#offline());
        }
    }

    #offline(): NetError {
        return new NetError(
            "offline",
            `${this.#name()} is offline. Start Pi Pocket's runner there, then try again.`,
        );
    }

    #id(): number {
        for (;;) {
            const id = this.#next;

            this.#next = this.#next >= 0xfffffff0 ? 1 : this.#next + 1;

            if (!this.#opening.has(id) && !this.#streams.has(id)) {
                return id;
            }
        }
    }
}
