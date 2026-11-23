/**
 * The browser's proxy for sessions on another computer: every connection of their pages goes to that computer, which
 * opens it there (`runner-network.ts`), so their pages browse from it and nothing they load leaves from this server.
 *
 * One listener on 127.0.0.1, on a port of the system's choice. Each browser context has credentials of its own
 * (`add`), which name its computer: wrong or missing ones get 407, so other programs on this server (sessions here run
 * bash) cannot use the proxy to reach a person's computer. `CONNECT host:port` (https, ws, wss) becomes a raw tunnel;
 * a plain `http://` request in absolute form is sent on in origin form, with `Connection: close`, and then its bytes
 * pass through untouched: one request per proxy connection. When the computer cannot connect, the browser gets 502,
 * with a page that says why for plain http; `problem` keeps the last reason for each context, for https.
 *
 * A second listener refuses everything (`denyPort`): the browser's own proxy, for whatever does not belong to a
 * context with credentials (the browser's own requests), so that nothing goes out from here.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/** Opens a connection from a computer and relays `socket` to it; rejects with a reason to show. */
export type Connect = (
    runner: string,
    host: string,
    port: number,
    socket: Duplex,
    options: { first?: Buffer[]; opened?: () => void; conversationId?: number },
) => Promise<void>;

/** The address a context loads once with its credentials, so that Chromium keeps them (`browser.ts`). */
export const PRIME_HOST = "pi-pocket-proxy.invalid";

/** The longest request head the proxy reads. */
const MAX_HEAD = 64 * 1024;

/** How long a browser has to send its request head. */
const HEAD_MS = 30_000;

/** Headers for the proxy alone, not passed on. */
const HOP_HEADERS = new Set([
    "proxy-authorization",
    "proxy-connection",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
]);

type Context = {
    runner: string;
    conversationId?: number;
    primed: boolean;
    problem?: { message: string; at: number };
};

type Head = { method: string; target: string; version: string; headers: [string, string][] };

/** Parse a request head (without its blank line); undefined when it is not one. */
export function parseHead(text: string): Head | undefined {
    const lines = text.split("\r\n");
    const first = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(lines[0] ?? "");

    if (first === null) {
        return undefined;
    }

    const headers: [string, string][] = [];

    for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");

        if (colon <= 0 || /[\s]/.test(line.slice(0, colon))) {
            return undefined;
        }

        headers.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
    }

    return { method: first[1]!, target: first[2]!, version: first[3]!, headers };
}

/** `host:port` of a CONNECT, with IPv6 in brackets. */
function hostPort(target: string): { host: string; port: number } | undefined {
    const match = /^(\[[0-9a-fA-F:.]+\]|[^\s:[\]/]+):(\d{1,5})$/.exec(target);
    const port = Number(match?.[2]);

    return match === null || !(port > 0 && port <= 65535)
        ? undefined
        : { host: match[1]!.replace(/^\[|\]$/g, ""), port };
}

function escape(text: string): string {
    return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A complete response for the browser, then the end of the connection. */
function reply(socket: Socket, status: string, headers: string[], body = ""): void {
    const bytes = Buffer.from(body, "utf8");

    socket.end(
        [
            `HTTP/1.1 ${status}`,
            ...headers,
            `Content-Length: ${bytes.length}`,
            "Connection: close",
            "",
            "",
        ].join("\r\n") + body,
    );
}

/** The page the browser shows for a plain-http address the computer could not open. */
function problemPage(message: string): string {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Not opened</title><body style="font:16px system-ui,sans-serif;margin:2rem;max-width:40rem;color:#222"><h1 style="font-size:1.3rem">This page did not open</h1><p>${escape(message)}</p></body>`;
}

export class BrowserProxy {
    readonly #connect: Connect;
    readonly #contexts = new Map<string, Context>();
    #server: Server | undefined;
    #deny: Server | undefined;
    #starting: Promise<void> | undefined;
    readonly #sockets = new Set<Socket>();
    port = 0;
    denyPort = 0;

    constructor(connect: Connect) {
        this.#connect = connect;
    }

    /** Listen, once. */
    start(): Promise<void> {
        this.#starting ??= (async () => {
            const track = (socket: Socket) => {
                this.#sockets.add(socket);
                socket.once("close", () => this.#sockets.delete(socket));
                socket.on("error", () => {});
            };

            const server = createServer({ allowHalfOpen: true }, (socket) => {
                track(socket);
                this.#accept(socket);
            });
            const deny = createServer((socket) => {
                track(socket);
                // Whatever it asks: nothing goes out from here.
                socket.once("data", () =>
                    reply(socket, "502 Bad Gateway", ["Content-Type: text/plain"], "Refused"),
                );
                socket.setTimeout(HEAD_MS, () => socket.destroy());
            });

            this.port = await listen(server);
            this.denyPort = await listen(deny);
            this.#server = server;
            this.#deny = deny;
        })();

        return this.#starting;
    }

    /** New credentials for a browser context whose connections go to computer `runner`. */
    add(
        runner: string,
        conversationId?: number,
    ): { username: string; password: string; key: string } {
        const username = `pocket-${randomBytes(6).toString("hex")}`;
        const password = randomBytes(24).toString("base64url");
        const key = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

        this.#contexts.set(key, {
            runner,
            primed: false,
            ...(conversationId === undefined ? {} : { conversationId }),
        });

        return { username, password, key };
    }

    /** Whether the browser sent these credentials (to `PRIME_HOST`): it keeps them for the context from then on. */
    primed(key: string): boolean {
        return this.#contexts.get(key)?.primed === true;
    }

    /** Forget a context's credentials: its connections are refused from now. */
    remove(key: string): void {
        this.#contexts.delete(key);
    }

    /** Why the computer last refused or failed a connection of this context, if it did after `since`. */
    problem(key: string, since: number): string | undefined {
        const problem = this.#contexts.get(key)?.problem;

        return problem !== undefined && problem.at >= since ? problem.message : undefined;
    }

    close(): void {
        this.#server?.close();
        this.#deny?.close();

        for (const socket of this.#sockets) {
            socket.destroy();
        }

        this.#contexts.clear();
    }

    #accept(socket: Socket): void {
        let buffered = Buffer.alloc(0);

        socket.setTimeout(HEAD_MS, () => socket.destroy());

        const onData = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);

            const end = buffered.indexOf("\r\n\r\n");

            if (end < 0) {
                if (buffered.length > MAX_HEAD) {
                    socket.off("data", onData);
                    reply(socket, "431 Request Header Fields Too Large", []);
                }

                return;
            }

            socket.off("data", onData);
            socket.pause();
            socket.setTimeout(0);

            const head = parseHead(buffered.subarray(0, end).toString("latin1"));
            const rest = buffered.subarray(end + 4);

            if (head === undefined) {
                reply(socket, "400 Bad Request", []);

                return;
            }

            this.#handle(socket, head, rest);
        };

        socket.on("data", onData);
        socket.on("end", () => {
            if (buffered.indexOf("\r\n\r\n") < 0) {
                socket.destroy();
            }
        });
    }

    #handle(socket: Socket, head: Head, rest: Buffer): void {
        const auth = head.headers.find(([name]) => name.toLowerCase() === "proxy-authorization");
        const key = auth?.[1] ?? "";
        const context = key === "" ? undefined : this.#contexts.get(key);

        if (context === undefined) {
            reply(socket, "407 Proxy Authentication Required", [
                'Proxy-Authenticate: Basic realm="Pi Pocket"',
            ]);

            return;
        }

        if (head.method === "CONNECT") {
            const target = hostPort(head.target);

            if (target === undefined) {
                reply(socket, "400 Bad Request", []);

                return;
            }

            this.#open(socket, context, target.host, target.port, {
                first: [rest],
                opened: () => socket.write("HTTP/1.1 200 Connection established\r\n\r\n"),
            });

            return;
        }

        let url: URL;

        try {
            url = new URL(head.target);
        } catch {
            reply(socket, "400 Bad Request", []);

            return;
        }

        if (url.protocol !== "http:") {
            reply(socket, "400 Bad Request", []);

            return;
        }

        if (url.hostname === PRIME_HOST) {
            context.primed = true;
            reply(socket, "204 No Content", []);

            return;
        }

        // Headers the browser named in `Connection` are for this hop only.
        const named = new Set(
            head.headers
                .filter(([name]) => name.toLowerCase() === "connection")
                .flatMap(([, value]) => value.split(","))
                .map((each) => each.trim().toLowerCase()),
        );
        const lines = [
            `${head.method} ${url.pathname}${url.search} ${head.version}`,
            ...head.headers
                .filter(([name]) => !HOP_HEADERS.has(name.toLowerCase()))
                .filter(([name]) => !named.has(name.toLowerCase()))
                .map(([name, value]) => `${name}: ${value}`),
            "Connection: close",
            "",
            "",
        ];

        this.#open(
            socket,
            context,
            url.hostname.replace(/^\[|\]$/g, ""),
            Number(url.port || 80),
            { first: [Buffer.from(lines.join("\r\n"), "latin1"), rest] },
            true,
        );
    }

    #open(
        socket: Socket,
        context: Context,
        host: string,
        port: number,
        options: { first: Buffer[]; opened?: () => void },
        page = false,
    ): void {
        this.#connect(context.runner, host, port, socket, {
            ...options,
            ...(context.conversationId === undefined
                ? {}
                : { conversationId: context.conversationId }),
        }).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);

            context.problem = { message, at: Date.now() };

            if (socket.destroyed) {
                return;
            }

            socket.resume();

            if (page) {
                reply(
                    socket,
                    "502 Bad Gateway",
                    ["Content-Type: text/html; charset=utf-8", "Cache-Control: no-store"],
                    problemPage(message),
                );
            } else {
                reply(socket, "502 Bad Gateway", ["Content-Type: text/plain"], message);
            }
        });
    }
}

function listen(server: Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            server.unref();

            const address = server.address();

            resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
    });
}
