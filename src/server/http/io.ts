/** What every route uses: the request it answers, reading its body, and writing its response. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";

const MAX_JSON = 1_000_000;

export interface HttpOptions {
    app: PocketApp;
    /** Where the server listens, to offer reachable invite links when the browser uses a loopback address. */
    listen: { host: string; port: number };
    /** Restart the process (exit code 75 under the launcher). */
    restart(): void;
}

/** A signed-in API request, as each group of routes gets it. */
export interface ApiRequest {
    readonly app: PocketApp;
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
    readonly url: URL;
    readonly user: User;
}

export function send(
    response: ServerResponse,
    status: number,
    body: string | Buffer,
    type = "text/plain; charset=utf-8",
    headers: Record<string, string> = {},
): void {
    response.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
    response.end(body);
}

export function json(response: ServerResponse, status: number, value: unknown): void {
    send(response, status, JSON.stringify(value), "application/json");
}

/** How long a JSON or form body may take to arrive: a client that stops sending must not hold the connection. */
const BODY_TIMEOUT_MS = 60_000;

export async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
    if (Number(request.headers["content-length"] ?? 0) > limit) {
        throw new HttpError(413, "Request too large");
    }

    const timer = setTimeout(
        () => request.destroy(new HttpError(408, "The request body took too long")),
        BODY_TIMEOUT_MS,
    );

    try {
        const chunks: Buffer[] = [];
        let size = 0;

        for await (const chunk of request) {
            size += (chunk as Buffer).length;

            if (size > limit) {
                throw new HttpError(413, "Request too large");
            }

            chunks.push(chunk as Buffer);
        }

        return Buffer.concat(chunks);
    } finally {
        clearTimeout(timer);
    }
}

export async function readJson<T>(request: IncomingMessage): Promise<T> {
    const body = await readBody(request, MAX_JSON);

    if (body.length === 0) {
        return {} as T;
    }

    try {
        return JSON.parse(body.toString("utf8")) as T;
    } catch {
        throw new HttpError(400, "Invalid JSON");
    }
}

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function conversationId(value: string | undefined): ConversationId {
    const id = Number(value);

    if (!Number.isInteger(id) || id < 0) {
        throw new HttpError(400, "Bad conversation id");
    }

    return id as unknown as ConversationId;
}
