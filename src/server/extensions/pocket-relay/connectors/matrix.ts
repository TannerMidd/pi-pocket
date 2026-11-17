import { createHash } from "node:crypto";
import { bytesOf, getFrom } from "../download.ts";
import {
    RelayError,
    type RelayConnector,
    type RelayContext,
    type RelayEvent,
    type RelayFile,
    type RelayOutFile,
} from "../types.ts";

/** Synapse takes 50 MB by default; a homeserver with a lower limit refuses, and nothing is sent. */
const MAX_UPLOAD = 50 * 1024 * 1024;
const MXC = /^mxc:\/\/([A-Za-z0-9.:[\]-]{1,255})\/([A-Za-z0-9_-]{1,255})$/;

type RequestContext = Pick<RelayContext, "values" | "signal">;
interface MatrixEvent {
    type: string;
    event_id: string;
    sender: string;
    origin_server_ts?: number;
    content?: {
        body?: string;
        msgtype?: string;
        filename?: string;
        url?: string;
        info?: { mimetype?: string; size?: number };
        "m.mentions"?: { user_ids?: string[] };
        "m.relates_to"?: { rel_type?: string; event_id?: string };
    };
}
interface Sync {
    next_batch: string;
    rooms?: { join?: Record<string, { timeline?: { events?: MatrixEvent[] } }> };
}

async function request<T>(
    context: RequestContext,
    path: string,
    body?: unknown,
    longPoll = false,
    file?: RelayOutFile,
): Promise<T> {
    let response: Response;
    let data: T & { errcode?: string; retry_after_ms?: number };

    try {
        // A file goes to the media API; everything else is the client API.
        response = await fetch(
            file === undefined
                ? `${baseOf(context)}/_matrix/client/v3/${path}`
                : `${baseOf(context)}/_matrix/media/v3/upload?${new URLSearchParams({ filename: file.name })}`,
            {
                method: file !== undefined ? "POST" : body === undefined ? "GET" : "PUT",
                headers: {
                    Authorization: `Bearer ${context.values.token}`,
                    "content-type": file?.type ?? "application/json",
                },
                body:
                    file !== undefined
                        ? new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.type })
                        : body === undefined
                          ? undefined
                          : JSON.stringify(body),
                signal: AbortSignal.any([
                    context.signal,
                    AbortSignal.timeout(file !== undefined ? 110_000 : longPoll ? 40_000 : 20_000),
                ]),
            },
        );
        data = (await response.json().catch(() => undefined)) as typeof data;
    } catch {
        throw new Error("Matrix request failed. Check the homeserver and connection.");
    }

    // A good status with a body that is not JSON (a proxy's page, a cut body) is no answer: taken as one, it loops.
    if (data === null || typeof data !== "object") {
        if (response.ok) {
            throw new Error(
                "Matrix sent an answer that is not JSON. Check the homeserver address.",
            );
        }

        data = {} as typeof data;
    }

    if (response.status === 401 || response.status === 403 || data.errcode === "M_UNKNOWN_TOKEN") {
        throw new RelayError("Matrix denied access. Check the access token and room permissions.", {
            fatal: true,
        });
    }

    if (response.status === 429 || data.errcode === "M_LIMIT_EXCEEDED") {
        throw new RelayError("Matrix rate limit. Try again later.", {
            retryAfter: Math.max(0, Number(data.retry_after_ms ?? 1000)),
        });
    }

    if (response.status === 413 || data.errcode === "M_TOO_LARGE") {
        throw new Error("The Matrix homeserver refused the file as too large.");
    }

    if (!response.ok || data.errcode) {
        throw new Error("Matrix request failed. Check the homeserver configuration.");
    }

    return data;
}

const baseOf = (context: RequestContext): string =>
    String(context.values.homeserver ?? "").replace(/\/$/, "");

/**
 * Download from the homeserver only, with the token: its authenticated media first, and the old media API when the
 * homeserver does not know the new one.
 */
async function download(
    context: Pick<RelayContext, "values" | "signal">,
    file: RelayFile,
    max: number,
): Promise<{ data: Uint8Array; type?: string }> {
    const match = MXC.exec(file.ref);

    if (match === null || !URL.canParse(baseOf(context))) {
        throw new Error("the attachment has no Matrix media address");
    }

    const origin = new URL(baseOf(context)).origin;
    const media = `${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}`;

    const get = (path: string) =>
        getFrom(
            `${baseOf(context)}/_matrix/${path}/${media}`,
            (url) => url.origin === origin,
            {
                headers: { Authorization: `Bearer ${context.values.token}` },
                signal: context.signal,
            },
            "the Matrix homeserver",
        );

    let response = await get("client/v1/media/download");

    if ([400, 404, 405].includes(response.status)) {
        const error = (await response.json().catch(() => ({}))) as { errcode?: unknown };

        if (response.status !== 405 && error.errcode !== "M_UNRECOGNIZED") {
            throw new Error(`the Matrix homeserver answered ${response.status}`);
        }

        response = await get("media/v3/download");
    }

    if (!response.ok) {
        await response.body?.cancel();

        throw new Error(`the Matrix homeserver answered ${response.status}`);
    }

    const type = response.headers.get("content-type") ?? undefined;

    return { data: await bytesOf(response, max), ...(type === undefined ? {} : { type }) };
}

function batchOf(sync: Sync): string {
    if (typeof sync.next_batch !== "string" || sync.next_batch === "") {
        throw new Error("Matrix sent a sync without a next batch token.");
    }

    return sync.next_batch;
}

function eventOf(event: MatrixEvent, room: string, user: string): RelayEvent {
    const content = event.content ?? {};
    const text = content.body ?? "";
    const relation = content["m.relates_to"];
    const attachment =
        content.msgtype !== undefined &&
        ["m.image", "m.file", "m.video", "m.audio"].includes(content.msgtype);
    // An encrypted file has no plain `url`: it is only described.
    const files: RelayFile[] =
        attachment && typeof content.url === "string" && MXC.test(content.url)
            ? [
                  {
                      name: content.filename ?? content.body ?? "file",
                      ...(typeof content.info?.mimetype === "string"
                          ? { type: content.info.mimetype }
                          : {}),
                      ...(typeof content.info?.size === "number"
                          ? { size: content.info.size }
                          : {}),
                      ref: content.url,
                  },
              ]
            : [];

    return {
        id: event.event_id,
        channel: room,
        thread: relation?.rel_type === "m.thread" ? relation.event_id : undefined,
        text: text.split(user).join("").trim(),
        author: { id: event.sender, name: event.sender, bot: event.sender === user },
        mentioned: content["m.mentions"]?.user_ids?.includes(user) === true || text.includes(user),
        at: event.origin_server_ts,
        attachments: attachment ? [`${content.msgtype}: ${text.replace(/[\r\n]/g, " ")}`] : [],
        ...(files.length > 0 ? { files } : {}),
    };
}

const matrix: RelayConnector = {
    kind: "matrix",
    label: "Matrix",
    idempotentReply: true,
    description: "A Matrix account: messages in the rooms it joined.",
    shape: "stream",
    mentions: true,
    files: { max: 10, maxBytes: MAX_UPLOAD },
    fetch: download,
    fields: [
        {
            name: "homeserver",
            label: "Homeserver address",
            type: "text",
            required: true,
            placeholder: "https://matrix.org",
        },
        { name: "token", label: "Access token", type: "secret", required: true },
        {
            name: "rooms",
            label: "Room IDs",
            type: "text",
            description: "Comma-separated room IDs. Leave empty for joined rooms.",
        },
        { name: "replyRoom", label: "Default reply room", type: "text" },
    ],
    async run(context) {
        const { user_id: user } = await request<{ user_id: string }>(context, "account/whoami");

        if (typeof user !== "string") {
            throw new Error("Matrix did not say who the access token belongs to.");
        }

        const rooms = String(context.values.rooms ?? "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
        let since = typeof context.state.since === "string" ? context.state.since : undefined;

        if (since === undefined) {
            const query = new URLSearchParams({
                timeout: "0",
                filter: JSON.stringify({ room: { timeline: { limit: 1 } } }),
            });

            since = batchOf(await request<Sync>(context, `sync?${query}`));
            context.save({ since });
        }

        context.status("Connected");

        while (!context.signal.aborted) {
            const query = new URLSearchParams({ since: String(since), timeout: "25000" });
            const asked = Date.now();
            const sync: Sync = await request<Sync>(context, `sync?${query}`, undefined, true);
            const events: RelayEvent[] = [];

            for (const [room, joined] of Object.entries(sync.rooms?.join ?? {})) {
                if (rooms.length && !rooms.includes(room)) {
                    continue;
                }

                for (const event of joined.timeline?.events ?? []) {
                    if (event.type === "m.room.message") {
                        events.push(eventOf(event, room, user));
                    }
                }
            }

            await context.emit(events);
            since = batchOf(sync);
            context.save({ since });

            // A long poll that answers at once with nothing (a server that ignores the timeout) must not spin.
            if (events.length === 0 && Date.now() - asked < 1000) {
                await context.sleep(1000);
            }
        }
    },
    async reply(context, reply) {
        const room = reply.to?.channel ?? reply.channel ?? context.values.replyRoom;
        const thread = reply.to?.thread ?? reply.thread;

        if (!room) {
            throw new Error("Choose a Matrix reply room.");
        }

        const relation = {
            ...(reply.to ? { "m.in_reply_to": { event_id: reply.to.id } } : {}),
            ...(thread ? { rel_type: "m.thread", event_id: thread, is_falling_back: true } : {}),
        };
        const files = reply.files ?? [];

        // Each event has its own transaction id from the key: one that runs again is sent once.
        const send = async (part: string, content: Record<string, unknown>) =>
            (
                await request<{ event_id: string }>(
                    context,
                    `rooms/${encodeURIComponent(String(room))}/send/m.room.message/${createHash(
                        "sha256",
                    )
                        .update(part === "" ? reply.key : `${reply.key}\u0000${part}`)
                        .digest("hex")}`,
                    {
                        ...content,
                        ...(Object.keys(relation).length ? { "m.relates_to": relation } : {}),
                        "m.mentions": {},
                    },
                )
            ).event_id;

        let first: string | undefined;

        if (reply.text !== "" || files.length === 0) {
            first = await send("", { msgtype: "m.text", body: reply.text });
        }

        for (const [index, file] of files.entries()) {
            const { content_uri: url } = await request<{ content_uri?: string }>(
                context,
                "",
                undefined,
                false,
                file,
            );

            if (typeof url !== "string" || !MXC.test(url)) {
                throw new Error("The Matrix homeserver gave no media address for the file.");
            }

            const id = await send(`file:${index}`, {
                msgtype: file.type.startsWith("image/") ? "m.image" : "m.file",
                body: file.name,
                filename: file.name,
                url,
                info: { mimetype: file.type, size: file.data.byteLength },
            });

            first ??= id;
        }

        return first === undefined ? {} : { id: first };
    },
};

export default matrix;
