// A WebSocket server for the relay's mocked services: text frames only, enough for Node's own WebSocket client.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

export interface MockSocket {
    readonly path: string;
    send(data: unknown): void;
    close(code?: number): void;
    /** Each text message the client sent, parsed as JSON when it is JSON. */
    readonly received: unknown[];
    onMessage(listener: (data: unknown) => void): void;
    readonly closed: Promise<void>;
}

function frame(opcode: number, payload: Buffer): Buffer {
    const length = payload.length;
    const head =
        length < 126
            ? Buffer.from([0x80 | opcode, length])
            : length < 65536
              ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
              : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(length)]);

    return Buffer.concat([head, payload]);
}

function bigLength(length: number): Buffer {
    const buffer = Buffer.alloc(8);

    buffer.writeBigUInt64BE(BigInt(length));

    return buffer;
}

function accept(request: IncomingMessage, socket: Duplex): MockSocket {
    const key = String(request.headers["sec-websocket-key"]);
    const answer = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");

    socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${answer}\r\n\r\n`,
    );

    const received: unknown[] = [];
    const listeners: ((data: unknown) => void)[] = [];
    let buffer = Buffer.alloc(0);

    let done: () => void = () => {};

    const closed = new Promise<void>((resolve) => {
        done = resolve;
    });

    socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= 2) {
            const opcode = buffer[0]! & 0x0f;
            let length = buffer[1]! & 0x7f;
            let offset = 2;

            if (length === 126) {
                length = buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                length = Number(buffer.readBigUInt64BE(2));
                offset = 10;
            }

            const masked = (buffer[1]! & 0x80) !== 0;
            const end = offset + (masked ? 4 : 0) + length;

            if (buffer.length < end) {
                return;
            }

            const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
            const payload = Buffer.from(buffer.subarray(end - length, end));

            if (mask !== undefined) {
                for (let index = 0; index < payload.length; index++) {
                    payload[index]! ^= mask[index % 4]!;
                }
            }

            buffer = buffer.subarray(end);

            if (opcode === 8) {
                socket.end(frame(8, payload.subarray(0, 2)));
                continue;
            }

            if (opcode === 9) {
                socket.write(frame(10, payload));
                continue;
            }

            if (opcode !== 1) {
                continue;
            }

            const text = payload.toString("utf8");
            let data: unknown = text;

            try {
                data = JSON.parse(text);
            } catch {
                // Not JSON: the text as it is.
            }

            received.push(data);
            listeners.forEach((listener) => listener(data));
        }
    });
    socket.on("close", () => done());
    socket.on("error", () => done());

    return {
        path: request.url ?? "/",
        received,
        closed,
        send: (data) => {
            if (!socket.destroyed) {
                socket.write(
                    frame(1, Buffer.from(typeof data === "string" ? data : JSON.stringify(data))),
                );
            }
        },
        close: (code = 1000) => {
            const payload = Buffer.alloc(2);

            payload.writeUInt16BE(code);
            socket.end(frame(8, payload));
        },
        onMessage: (listener) => {
            listeners.push(listener);
        },
    };
}

/**
 * An HTTP server on 127.0.0.1 that also takes WebSocket connections: `onSocket` hears each one. HTTP requests go to
 * `handle`. Close it with `server.close()` and `server.closeAllConnections()`.
 */
export async function mockServer(
    handle: (
        request: IncomingMessage,
        body: string,
    ) =>
        | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }
        | Promise<{
              status?: number;
              json?: unknown;
              text?: string;
              headers?: Record<string, string>;
          }>,
    onSocket: (socket: MockSocket) => void = () => {},
): Promise<{ server: Server; url: string; ws: string; sockets: MockSocket[] }> {
    const sockets: MockSocket[] = [];
    const server = createServer((request, response) => {
        let body = "";

        request.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
        });
        request.on("end", () => {
            void Promise.resolve(handle(request, body)).then(
                (answer) => {
                    const text =
                        answer.text ??
                        (answer.json === undefined ? "" : JSON.stringify(answer.json));

                    response.writeHead(answer.status ?? 200, {
                        "content-type":
                            answer.json === undefined ? "text/plain" : "application/json",
                        ...answer.headers,
                    });
                    response.end(text);
                },
                (error: unknown) => {
                    response.writeHead(500);
                    response.end(String(error));
                },
            );
        });
    });

    server.on("upgrade", (request, socket) => {
        const mock = accept(request, socket);

        sockets.push(mock);
        onSocket(mock);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    return { server, url: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, sockets };
}
