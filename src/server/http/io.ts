/** What every route uses: the request it answers, reading its body or a file, and writing its response. */
import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import { accepted, compressed, compressible, MIN_COMPRESS_BYTES } from "./compress.ts";

const MAX_JSON = 1_000_000;

/** Opened on its own, an SVG could run script with the app's origin: give it an opaque one. */
export const SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

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
    readonly signal: AbortSignal;
}

/** An answer, compressed when it is text the browser takes compressed and large enough to gain from it. */
export function send(
    response: ServerResponse,
    status: number,
    body: string | Buffer,
    type = "text/plain; charset=utf-8",
    headers: Record<string, string> = {},
): void {
    const encoding =
        compressible(type) &&
        headers["content-encoding"] === undefined &&
        Buffer.byteLength(body) >= MIN_COMPRESS_BYTES
            ? accepted(response.req)
            : undefined;

    if (encoding !== undefined) {
        body = compressed(body, encoding);
        headers = {
            ...headers,
            "content-encoding": encoding,
            vary:
                headers.vary === undefined ? "accept-encoding" : `${headers.vary}, accept-encoding`,
        };
    }

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

/**
 * A request's JSON body, which every route takes as an object (an empty body is an empty one). Anything else, such as
 * null or a list, is refused here: a route reading its fields would fail with a server error.
 */
export async function readJson<T>(request: IncomingMessage): Promise<T> {
    const body = await readBody(request, MAX_JSON);

    if (body.length === 0) {
        return {} as T;
    }

    let value: unknown;

    try {
        value = JSON.parse(body.toString("utf8"));
    } catch {
        throw new HttpError(400, "Invalid JSON");
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new HttpError(400, "Send a JSON object.");
    }

    return value as T;
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

/**
 * Whether `fd`, with these `stats`, is the file that was checked: the same file (device and inode) as the check saw, and,
 * where the system says where an open file is (Linux), at the path checked. A folder on the way swapped for a link
 * between the check and the open leads to another file, which fails the first test everywhere. `proc` is for tests.
 */
export function opened(
    fd: number,
    checked: { file: string; dev: number; ino: number },
    stats: { dev: number; ino: number },
    proc = true,
): boolean {
    if (stats.dev !== checked.dev || stats.ino !== checked.ino) {
        return false;
    }

    if (!proc) {
        return true;
    }

    try {
        return readlinkSync(`/proc/self/fd/${fd}`) === checked.file;
    } catch {
        // No /proc here (macOS): the same file as checked is the test.
        return true;
    }
}

/**
 * A file to serve, read whole as it was checked: a regular file, not a link, and the very file the check saw (`opened`).
 * Anything else is a 404; one larger than `max` bytes is a 413 with `tooLarge` as its words, or a 404 without them.
 */
export function readChecked(
    checked: { file: string; dev: number; ino: number },
    max: number,
    tooLarge?: string,
): Buffer {
    let fd: number;

    // Never waiting: a pipe swapped in after the check would otherwise hold the whole server.
    try {
        fd = openSync(
            checked.file,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
    } catch {
        throw new HttpError(404, "Not found");
    }

    try {
        const stats = fstatSync(fd);

        if (!stats.isFile() || !opened(fd, checked, stats)) {
            throw new HttpError(404, "Not found");
        }

        if (stats.size > max) {
            throw tooLarge === undefined
                ? new HttpError(404, "Not found")
                : new HttpError(413, tooLarge);
        }

        return readFileSync(fd);
    } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(404, "Not found");
    } finally {
        closeSync(fd);
    }
}
