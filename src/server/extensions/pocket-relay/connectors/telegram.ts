import { bytesOf } from "../download.ts";
import {
    RelayError,
    type RelayConnector,
    type RelayContext,
    type RelayEvent,
    type RelayFile,
} from "../types.ts";

const API = "https://api.telegram.org";
/** The Bot API's own limits: a bot uploads 50 MB, a photo 10 MB, and downloads 20 MB at most. */
const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_PHOTO = 10 * 1024 * 1024;
const MAX_DOWNLOAD = 20 * 1024 * 1024;
const PHOTOS = new Set(["image/png", "image/jpeg", "image/webp"]);

type RequestContext = Pick<RelayContext, "values" | "signal">;
interface TelegramUser {
    id: number;
    username?: string;
    first_name?: string;
    is_bot?: boolean;
}
interface Message {
    message_id: number;
    date?: number;
    chat: { id: number; type: string; title?: string };
    from?: TelegramUser;
    sender_chat?: { id: number; title?: string };
    text?: string;
    caption?: string;
    entities?: { type: string; offset: number; length: number }[];
    caption_entities?: { type: string; offset: number; length: number }[];
    reply_to_message?: { from?: TelegramUser };
    photo?: TelegramFile[];
    document?: TelegramFile;
    video?: TelegramFile;
    audio?: TelegramFile;
    voice?: TelegramFile;
    animation?: TelegramFile;
    sticker?: unknown;
}
interface TelegramFile {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}
interface Update {
    update_id: number;
    message?: Message;
}

async function request<T>(
    context: RequestContext,
    method: string,
    query = "",
    body?: unknown,
    timeout = 20_000,
): Promise<T> {
    let response: Response;
    let data: {
        ok?: boolean;
        result?: T;
        error_code?: number;
        parameters?: { retry_after?: number };
    };

    try {
        const form = body instanceof FormData;

        response = await fetch(`${baseOf(context)}/bot${context.values.token}/${method}${query}`, {
            method: body === undefined ? "GET" : "POST",
            headers:
                body === undefined || form ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : form ? body : JSON.stringify(body),
            signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeout)]),
        });
        data = (await response.json().catch(() => ({}))) as typeof data;
    } catch {
        // Telegram puts the token in the URL. Never expose a URL or a transport error.
        throw new Error("Telegram request failed. Check the API address and connection.");
    }

    const code = response.ok ? data.error_code : response.status;

    if (code === 401 || code === 403) {
        throw new RelayError("Telegram denied access. Check the bot token and permissions.", {
            fatal: true,
        });
    }

    if (code === 409) {
        throw new RelayError(
            "Telegram polling conflicts with another getUpdates client or an active webhook. Stop the other client or remove the webhook.",
            { fatal: true },
        );
    }

    if (code === 429) {
        throw new RelayError("Telegram rate limit. Try again later.", {
            retryAfter: Math.max(0, Number(data.parameters?.retry_after ?? 1)) * 1000,
        });
    }

    if (code === 400) {
        // Telegram's own words can carry what Pi sent: say only that it refused.
        throw Object.assign(new Error("Telegram refused the request."), { refused: true });
    }

    if (!response.ok || !data.ok || data.result === undefined) {
        throw new Error("Telegram request failed. Check the bot configuration.");
    }

    return data.result;
}

const baseOf = (context: RequestContext): string =>
    String(context.values.apiUrl || API).replace(/\/$/, "");

/** The files a message carries: the largest size of a photo, and each document, video, or sound. */
function filesOf(message: Message): RelayFile[] {
    // Telegram lists a photo's sizes smallest first.
    const largest = (message.photo ?? []).reduce<TelegramFile | undefined>(
        (best, each) =>
            best === undefined || (each.file_size ?? 0) >= (best.file_size ?? 0) ? each : best,
        undefined,
    );
    const found: [TelegramFile | undefined, string, string | undefined][] = [
        [largest, `photo-${message.message_id}.jpg`, "image/jpeg"],
        // A GIF comes as `animation` and as `document` with the same file: list it once.
        [message.animation === undefined ? message.document : undefined, "document", undefined],
        [message.video, `video-${message.message_id}.mp4`, undefined],
        [message.animation, `animation-${message.message_id}.mp4`, undefined],
        [message.audio, `audio-${message.message_id}.mp3`, undefined],
        [message.voice, `voice-${message.message_id}.ogg`, "audio/ogg"],
    ];

    return found.flatMap(([file, name, type]) =>
        typeof file?.file_id === "string"
            ? [
                  {
                      name: file.file_name ?? name,
                      ...((file.mime_type ?? type) === undefined
                          ? {}
                          : { type: file.mime_type ?? type }),
                      ...(typeof file.file_size === "number" ? { size: file.file_size } : {}),
                      ref: file.file_id,
                  },
              ]
            : [],
    );
}

/**
 * Telegram's download puts the bot token in the address: no address, and no transport error, ever leaves this
 * function.
 */
async function download(
    context: Pick<RelayContext, "values" | "signal">,
    file: RelayFile,
    max: number,
): Promise<{ data: Uint8Array; type?: string }> {
    const cap = Math.min(max, MAX_DOWNLOAD);

    if ((file.size ?? 0) > cap) {
        throw new Error(`Telegram lets a bot download ${Math.round(cap / 1048576)} MB at most`);
    }

    const found = await request<{ file_path?: string; file_size?: number }>(
        context,
        "getFile",
        `?${new URLSearchParams({ file_id: file.ref })}`,
    );
    const path = found.file_path;

    if (
        typeof path !== "string" ||
        !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(path) ||
        path.split("/").some((part) => part === "..")
    ) {
        throw new Error("Telegram gave no file to download");
    }

    if ((found.file_size ?? 0) > cap) {
        throw new Error(`Telegram lets a bot download ${Math.round(cap / 1048576)} MB at most`);
    }

    let response: Response;

    try {
        response = await fetch(`${baseOf(context)}/file/bot${context.values.token}/${path}`, {
            redirect: "error",
            signal: context.signal,
        });
    } catch {
        throw new Error("Telegram download failed. Check the connection.");
    }

    if (!response.ok) {
        await response.body?.cancel().catch(() => {});

        throw new Error(`Telegram's file server answered ${response.status}`);
    }

    const type = response.headers.get("content-type") ?? undefined;
    let data: Uint8Array;

    try {
        data = await bytesOf(response, cap);
    } catch (error) {
        throw new Error(
            String((error as Error).message).startsWith("the file is larger")
                ? `the file is larger than ${Math.round(cap / 1048576)} MB`
                : "Telegram download failed. Check the connection.",
        );
    }

    // Telegram serves most files as octet-stream: the type the message named is the better one.
    return {
        data,
        ...(type === undefined || (type === "application/octet-stream" && file.type)
            ? {}
            : { type }),
    };
}

function eventOf(message: Message, bot: TelegramUser): RelayEvent {
    const text = message.text ?? message.caption ?? "";
    const entities = message.text === undefined ? message.caption_entities : message.entities;
    const ownMentions = (entities ?? []).filter(
        (entity) =>
            entity.type === "mention" &&
            bot.username !== undefined &&
            text.slice(entity.offset, entity.offset + entity.length).toLowerCase() ===
                `@${bot.username}`.toLowerCase(),
    );
    let stripped = text;

    for (const entity of [...ownMentions].sort((a, b) => b.offset - a.offset)) {
        stripped = stripped.slice(0, entity.offset) + stripped.slice(entity.offset + entity.length);
    }

    const author = message.from;
    const files = filesOf(message);
    const attachments: string[] = [];

    if (message.photo?.length) {
        attachments.push("Photo");
    }

    if (message.document) {
        attachments.push(
            `Document: ${(message.document.file_name ?? message.document.mime_type ?? "file").replace(/[\r\n]/g, " ")}`,
        );
    }

    for (const kind of ["video", "audio", "sticker"] as const) {
        if (message[kind]) {
            attachments.push(kind);
        }
    }

    return {
        id: `${message.chat.id}:${message.message_id}`,
        channel: String(message.chat.id),
        channelName: message.chat.title,
        text: stripped.trim(),
        author: {
            id: String(author?.id ?? message.sender_chat?.id ?? "unknown"),
            name: author?.username ?? author?.first_name ?? message.sender_chat?.title ?? "Unknown",
            bot: author?.is_bot === true || author?.id === bot.id || author === undefined,
        },
        mentioned:
            message.chat.type === "private" ||
            ownMentions.length > 0 ||
            message.reply_to_message?.from?.id === bot.id,
        at: message.date === undefined ? undefined : message.date * 1000,
        attachments,
        ...(files.length > 0 ? { files } : {}),
    };
}

const telegram: RelayConnector = {
    kind: "telegram",
    label: "Telegram",
    description: "A Telegram bot: messages to it and in its groups. Make one with @BotFather.",
    shape: "stream",
    mentions: true,
    files: { max: 10, maxBytes: MAX_UPLOAD },
    fetch: download,
    fields: [
        { name: "token", label: "Bot token", type: "secret", required: true },
        {
            name: "chats",
            label: "Chat IDs",
            type: "text",
            description: "Comma-separated chat IDs. Leave empty for all chats.",
        },
        { name: "replyChat", label: "Default reply chat", type: "text" },
        {
            name: "apiUrl",
            label: "API address",
            type: "text",
            description: "Leave empty for the service's own address.",
        },
    ],
    async run(context) {
        const bot = await request<TelegramUser>(context, "getMe");
        const chats = String(context.values.chats ?? "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
        let offset = typeof context.state.offset === "number" ? context.state.offset : undefined;

        if (offset === undefined) {
            const updates = await request<Update[]>(context, "getUpdates", "?offset=-1");

            offset = updates.reduce((last, update) => Math.max(last, update.update_id + 1), 0);
            context.save({ offset });
        }

        context.status("Connected");

        while (!context.signal.aborted) {
            const query = new URLSearchParams({
                offset: String(offset),
                timeout: "25",
                allowed_updates: JSON.stringify(["message"]),
            });
            const asked = Date.now();
            const updates: Update[] = await request<Update[]>(
                context,
                "getUpdates",
                `?${query}`,
                undefined,
                40_000,
            );
            const events = updates.flatMap((update) => {
                const message = update.message;

                return message && (!chats.length || chats.includes(String(message.chat.id)))
                    ? [eventOf(message, bot)]
                    : [];
            });

            await context.emit(events);
            offset = updates.reduce((last, update) => Math.max(last, update.update_id + 1), offset);
            context.save({ offset });

            // A long poll that answers at once with nothing (a server that ignores the timeout) must not spin.
            if (updates.length === 0 && Date.now() - asked < 1000) {
                await context.sleep(1000);
            }
        }
    },
    async reply(context, reply) {
        const channel = reply.to?.channel ?? reply.channel ?? context.values.replyChat;

        if (!channel) {
            throw new Error("Choose a Telegram reply chat.");
        }

        const messageId = reply.to?.id.split(":").at(-1);
        const answer =
            messageId === undefined
                ? undefined
                : { message_id: Number(messageId), allow_sending_without_reply: true };
        const files = reply.files ?? [];
        // A short text goes as the first file's caption; a long one as a message of its own first.
        const caption = files.length > 0 && reply.text.length <= 1024 ? reply.text : undefined;
        let first: number | undefined;

        // Telegram has no idempotency key. The runtime records replies by key.
        if (caption === undefined) {
            const result = await request<{ message_id: number }>(context, "sendMessage", "", {
                chat_id: channel,
                text: reply.text.slice(0, 4096),
                ...(answer === undefined ? {} : { reply_parameters: answer }),
                link_preview_options: { is_disabled: true },
            });

            first = result.message_id;
        }

        for (const [index, file] of files.entries()) {
            const send = async (photo: boolean) => {
                const form = new FormData();

                form.append("chat_id", String(channel));

                if (index === 0 && caption !== undefined && caption !== "") {
                    form.append("caption", caption);
                }

                if (answer !== undefined) {
                    form.append("reply_parameters", JSON.stringify(answer));
                }

                form.append(
                    photo ? "photo" : "document",
                    new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.type }),
                    file.name,
                );

                return request<{ message_id: number }>(
                    context,
                    photo ? "sendPhoto" : "sendDocument",
                    "",
                    form,
                    110_000,
                );
            };

            const photo = PHOTOS.has(file.type) && file.data.byteLength <= MAX_PHOTO;
            // A photo Telegram refuses (too long, too wide) is not sent: it goes as a document.
            const result = await send(photo).catch((error: unknown) => {
                if (photo && (error as { refused?: unknown }).refused === true) {
                    return send(false);
                }

                throw error;
            });

            first ??= result.message_id;
        }

        return first === undefined ? {} : { id: `${channel}:${first}` };
    },
};

export default telegram;
