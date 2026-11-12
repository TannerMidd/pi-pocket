import { RelayError, type RelayConnector, type RelayContext, type RelayEvent } from "../types.ts";

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
    photo?: unknown[];
    document?: { file_name?: string; mime_type?: string };
    video?: unknown;
    audio?: unknown;
    sticker?: unknown;
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
    longPoll = false,
): Promise<T> {
    let response: Response;
    let data: {
        ok?: boolean;
        result?: T;
        error_code?: number;
        parameters?: { retry_after?: number };
    };

    try {
        const base = String(context.values.apiUrl || "https://api.telegram.org").replace(/\/$/, "");

        response = await fetch(`${base}/bot${context.values.token}/${method}${query}`, {
            method: body === undefined ? "GET" : "POST",
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.any([
                context.signal,
                AbortSignal.timeout(longPoll ? 40_000 : 20_000),
            ]),
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

    if (!response.ok || !data.ok || data.result === undefined) {
        throw new Error("Telegram request failed. Check the bot configuration.");
    }

    return data.result;
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
    };
}

const telegram: RelayConnector = {
    kind: "telegram",
    label: "Telegram",
    shape: "stream",
    mentions: true,
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
            const updates: Update[] = await request<Update[]>(
                context,
                "getUpdates",
                `?${query}`,
                undefined,
                true,
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
        }
    },
    async reply(context, reply) {
        const channel = reply.to?.channel ?? reply.channel ?? context.values.replyChat;

        if (!channel) {
            throw new Error("Choose a Telegram reply chat.");
        }

        const messageId = reply.to?.id.split(":").at(-1);
        // Telegram has no idempotency key. The runtime records replies by key.
        const result = await request<{ message_id: number }>(context, "sendMessage", "", {
            chat_id: channel,
            text: reply.text.slice(0, 4096),
            ...(messageId === undefined
                ? {}
                : {
                      reply_parameters: {
                          message_id: Number(messageId),
                          allow_sending_without_reply: true,
                      },
                  }),
            link_preview_options: { is_disabled: true },
        });

        return { id: `${channel}:${result.message_id}` };
    },
};

export default telegram;
