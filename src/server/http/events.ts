/**
 * Live events for each browser tab: an event stream (`/api/events`), or long polling (`/api/poll`) for connections
 * that hold event streams back. Either way the tab is a `Client` that the app attaches.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import type { Client } from "../room.ts";
import { accepted, streamCompressor } from "./compress.ts";
import { conversationId, json } from "./io.ts";

/** How long a poll waits for events before answering empty, and how long an unpolled session lives. */
const POLL_HOLD_MS = 25_000;
/**
 * How far behind a tab may fall. Past `BEHIND_BYTES` (or `BEHIND_EVENTS` waiting), a tab must keep up: one that took
 * nothing (its stream did not drain, or it polled and acknowledged nothing) for `STALLED_MS` is cut off, rather than
 * hold the server's memory without end; it connects again, and gets a full view. This is checked as events come, at
 * each ping of a stream, and at each poll. A polling tab with an answer on its way is taking it, however long that takes
 * on a slow link: one that never polls again ends `pollExpireMs` after its last poll or answer. A tab that keeps taking is not cut off for being behind,
 * so a session's first view, however large, and a slow phone that still reads both come through. Past
 * `MAX_BEHIND_BYTES` any tab is cut off.
 */
const BEHIND_BYTES = 8 * 1024 * 1024;
const BEHIND_EVENTS = 5000;
const STALLED_MS = 30_000;
const MAX_BEHIND_BYTES = 128 * 1024 * 1024;

/**
 * How often a stream sends a comment, which keeps proxies from closing it, and checks that its tab keeps up; and how long
 * a polling session lives after its last poll or answer, when no poll comes.
 */
const eventTiming = { pingMs: 15_000, pollExpireMs: 60_000 };

/** One browser tab that receives events by long polling instead of an event stream. */
interface Poller {
    id: string;
    userId: string;
    client: Client;
    queue: { seq: number; event: string; data: unknown; size: number }[];
    /** The queue's events, as JSON, in bytes. */
    bytes: number;
    /** When the tab last took something: its poll acknowledged events, or nothing waited for it. */
    tookAt: number;
    /** An answer went to it since its last poll: it is taking that, which on a slow link takes long. */
    out: boolean;
    /** The poll that made it, while its first view is built and the tab still waits for it. */
    attaching: ServerResponse | undefined;
    seq: number;
    waiting: ServerResponse | undefined;
    timer: NodeJS.Timeout | undefined;
    expiry: NodeJS.Timeout | undefined;
}

function newClient(url: URL, user: User, send: Client["send"]): Client {
    const raw = url.searchParams.get("c");

    return {
        id: (url.searchParams.get("tab") ?? randomUUID()).slice(0, 64),
        connection: randomUUID(),
        user,
        conversationId: raw === null || raw === "" ? undefined : conversationId(raw),
        // What the tab's code understands of updates: none named is older code.
        protocol: Number(url.searchParams.get("p")) || 1,
        sentEntries: new Set(),
        orderKey: "",
        send,
    };
}

/** The event routes of one HTTP handler, with their own pollers. */
export function createEventStreams(app: PocketApp) {
    const events = async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        user: User,
    ): Promise<void> => {
        // What went to the stream, and of it what the tab took (left the stream's buffer), and when it last took some.
        // Compressed, these count the compressed bytes: what the server holds, and what the tab takes.
        let written = 0;
        let taken = 0;
        let tookAt = Date.now();
        const encoding = accepted(request);
        const compressor = encoding === undefined ? undefined : streamCompressor(encoding);

        // One compressor for the whole stream, flushed after each event and ping, so each goes out whole at once.
        const write = (text: string) => {
            if (compressor === undefined) {
                written += Buffer.byteLength(text);
                response.write(text);
            } else {
                compressor.stream.write(text);
                compressor.stream.flush(compressor.flush);
            }
        };

        compressor?.stream
            .on("data", (chunk: Buffer) => {
                if (!response.destroyed) {
                    written += chunk.length;
                    response.write(chunk);
                }
            })
            .on("end", () => response.end())
            .on("error", () => response.destroy());

        /** Whether the stream may take more: false, and cut off, when it took nothing for long while far behind, or is too far behind. */
        const keepsUp = (): boolean => {
            if (response.writableEnded || response.destroyed || compressor?.stream.writableEnded) {
                return false;
            }

            const behind = response.writableLength;
            const now = Date.now();

            if (written - behind > taken || behind <= BEHIND_BYTES) {
                taken = written - behind;
                tookAt = now;
            }

            // Text not yet compressed is not in `behind` (that counts what the tab must take), but it is held too.
            const pending = compressor?.stream.writableLength ?? 0;

            if (
                behind > MAX_BEHIND_BYTES ||
                pending > MAX_BEHIND_BYTES ||
                now - tookAt > STALLED_MS
            ) {
                response.destroy();

                return false;
            }

            return true;
        };

        const client = newClient(url, user, (event, data) => {
            if (keepsUp()) {
                write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
        });

        client.close = () => (compressor === undefined ? response.end() : compressor.stream.end());
        response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
            ...(encoding === undefined ? {} : { "content-encoding": encoding }),
            vary: "accept-encoding",
        });
        write("retry: 1500\n\n");
        // The ping checks too: a tab far behind with nothing new for it would otherwise hold its backlog until the next event.
        const ping = setInterval(() => keepsUp() && write(": ping\n\n"), eventTiming.pingMs);

        request.on("close", () => {
            clearInterval(ping);
            compressor?.stream.destroy();
            app.detach(client);
        });
        await app.attach(client);
    };

    // ─── Long polling: the same events as /api/events, for connections that hold back event streams (Cloudflare
    // quick tunnels do). Each answer carries every event after the client's `ack`, so a lost answer is sent again.
    const pollers = new Map<string, Poller>();

    const answerPoll = (poller: Poller): void => {
        clearTimeout(poller.timer);
        poller.timer = undefined;
        const response = poller.waiting;

        poller.waiting = undefined;

        if (response !== undefined && !response.writableEnded) {
            json(response, 200, {
                session: poller.id,
                events: poller.queue.map(({ seq, event, data }) => ({ seq, event, data })),
            });

            // Until it polls again it takes this: a large answer on a slow link takes long, and only it knows when it is in.
            if (poller.queue.length > 0) {
                poller.out = true;

                // Its session lives on from now, not from the poll: an answer that went late in a long wait still has
                // the whole time to come in.
                if (pollers.has(poller.id)) {
                    keepPoller(poller);
                }
            }
        }
    };

    /** Whether a poller took nothing for long while far behind, or is too far behind: then its session ends. */
    const stalled = (poller: Poller): boolean => {
        const behind = poller.bytes > BEHIND_BYTES || poller.queue.length > BEHIND_EVENTS;

        return (
            poller.bytes > MAX_BEHIND_BYTES ||
            (behind && !poller.out && Date.now() - poller.tookAt > STALLED_MS)
        );
    };

    const closePoller = (poller: Poller): void => {
        clearTimeout(poller.expiry);

        if (!pollers.delete(poller.id)) {
            return;
        }

        answerPoll(poller);
        app.detach(poller.client);
    };

    const keepPoller = (poller: Poller): void => {
        clearTimeout(poller.expiry);

        // A closed one has no time left to keep.
        if (!pollers.has(poller.id)) {
            return;
        }

        // A poll that waits, or the one whose first view is still built, keeps it; with neither, it ends.
        poller.expiry = setTimeout(
            () =>
                poller.waiting === undefined && poller.attaching === undefined
                    ? closePoller(poller)
                    : keepPoller(poller),
            eventTiming.pollExpireMs,
        );
        poller.expiry.unref();
    };

    const poll = async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        user: User,
    ): Promise<void> => {
        let poller = pollers.get(url.searchParams.get("session") ?? "");

        if (poller !== undefined && poller.userId !== user.id) {
            poller = undefined;
        }

        if (url.searchParams.get("close") === "1") {
            if (poller !== undefined) {
                closePoller(poller);
            }

            return json(response, 200, { ok: true });
        }

        if (poller !== undefined) {
            const ack = Number(url.searchParams.get("ack") ?? 0);
            const before = poller.queue.length;

            poller.out = false;

            poller.queue = poller.queue.filter((item) => item.seq > ack);
            poller.bytes = poller.queue.reduce((sum, item) => sum + item.size, 0);

            // It took something, or nothing waits for it: it keeps up.
            if (poller.queue.length < before || poller.queue.length === 0) {
                poller.tookAt = Date.now();
            }

            // Still far behind, and it took nothing for long: start afresh, with a full view.
            if (stalled(poller)) {
                poller.queue = [];
                poller.bytes = 0;
                closePoller(poller);
                poller = undefined;
            } else {
                keepPoller(poller);
            }
        }

        // A tab's first answer goes as soon as its first view is built: the rest of that view, whole (`Room.push`),
        // follows in the next, rather than with it a moment later.
        let first = false;

        if (poller === undefined) {
            // A new tab, or one whose session ended (the server restarted): attach afresh, which sends hello and a full view.
            const created: Poller = {
                id: randomUUID(),
                userId: user.id,
                client: undefined as unknown as Client,
                queue: [],
                bytes: 0,
                tookAt: Date.now(),
                // Its first answer is on its way however long its first view takes to build.
                out: true,
                attaching: response,
                seq: 0,
                waiting: undefined,
                timer: undefined,
                expiry: undefined,
            };

            created.client = newClient(url, user, (event, data) => {
                let size = 0;

                try {
                    size = Buffer.byteLength(JSON.stringify(data ?? null) ?? "null");
                } catch {
                    // Not JSON: its answer would fail as it is, and it weighs nothing here.
                }

                created.queue.push({ seq: ++created.seq, event, data, size });
                created.bytes += size;

                // A tab far behind that took nothing for long, or one too far behind: its session ends, and its next
                // poll starts afresh, with a full view.
                if (stalled(created)) {
                    created.queue = [];
                    created.bytes = 0;
                    closePoller(created);

                    return;
                }

                // A short pause lets a burst of events go out in one answer.
                if (created.waiting !== undefined) {
                    clearTimeout(created.timer);
                    created.timer = setTimeout(() => answerPoll(created), 30);
                }
            });
            created.client.close = () => closePoller(created);
            pollers.set(created.id, created);
            // Its time runs while its first view is built, however long that takes, as long as the tab waits for it: a
            // tab that went is let go when its time is up, even if the build never ends.
            let gone = false;

            response.once("close", () => {
                gone = true;
                created.attaching = undefined;
            });
            keepPoller(created);

            try {
                await app.attach(created.client);
            } catch (error) {
                // A first view that failed to build leaves nothing behind.
                closePoller(created);

                throw error;
            } finally {
                created.attaching = undefined;
            }

            // Closed as it attached (cut off, or its person removed): its next poll starts afresh, with no wait. Its tab may
            // have come in after the close let it go: let it go again.
            if (!pollers.has(created.id)) {
                app.detach(created.client);

                return json(response, 200, { session: created.id, events: [] });
            }

            // The tab went while its first view was built: nothing waits for it now, so it goes at once.
            if (gone) {
                closePoller(created);

                return;
            }

            // Its time starts again, now that its first view is built.
            keepPoller(created);
            poller = created;
            first = true;
        }

        const current = poller;

        // One waiting request per tab: an older one answers now.
        if (current.waiting !== undefined) {
            answerPoll(current);
        }

        current.waiting = response;

        if (first && current.queue.length > 0) {
            answerPoll(current);

            return;
        }

        current.timer = setTimeout(
            () => answerPoll(current),
            current.queue.length > 0 ? 30 : POLL_HOLD_MS,
        );
        // Closes when answered, or when the browser gives up on this request.
        response.on("close", () => {
            if (current.waiting !== response) {
                return;
            }

            clearTimeout(current.timer);
            current.waiting = undefined;
        });
    };

    return { events, poll };
}
