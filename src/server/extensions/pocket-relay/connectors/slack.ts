import { RelayError, type RelayConnector, type RelayContext, type RelayEvent } from "../types.ts";

type RequestContext = Pick<RelayContext, "values" | "signal">;
interface SlackEvent {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
    thread_ts?: string;
    text?: string;
    files?: { name?: string; mimetype?: string }[];
}
interface Envelope {
    envelope_id?: string;
    type?: string;
    payload?: { event?: SlackEvent };
}

async function request<T>(
    context: RequestContext,
    method: string,
    app = false,
    body?: unknown,
): Promise<T> {
    let response: Response;
    let data: T & { ok?: boolean; error?: string };

    try {
        const base = String(context.values.apiUrl || "https://slack.com/api").replace(/\/$/, "");

        response = await fetch(`${base}/${method}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${app ? context.values.appToken : context.values.botToken}`,
                "content-type": "application/json",
            },
            body: JSON.stringify(body ?? {}),
            signal: AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]),
        });
        data = (await response.json().catch(() => ({}))) as typeof data;
    } catch {
        throw new Error("Slack request failed. Check the API address and connection.");
    }

    if (
        response.status === 401 ||
        response.status === 403 ||
        ["invalid_auth", "not_authed", "missing_scope"].includes(data.error ?? "")
    ) {
        throw new RelayError("Slack denied access. Check the app token, bot token, and scopes.", {
            fatal: true,
        });
    }

    if (response.status === 429 || data.error === "ratelimited") {
        throw new RelayError("Slack rate limit. Try again later.", {
            retryAfter: Math.max(0, Number(response.headers.get("retry-after") ?? 1)) * 1000,
        });
    }

    if (!response.ok || !data.ok) {
        throw new Error("Slack request failed. Check the app configuration.");
    }

    return data;
}

function eventOf(event: SlackEvent, user: string, channels: string[]): RelayEvent | undefined {
    if (
        !["message", "app_mention"].includes(event.type ?? "") ||
        event.bot_id ||
        (event.subtype !== undefined && event.subtype !== "thread_broadcast") ||
        !event.channel ||
        !event.ts ||
        !event.user ||
        (channels.length > 0 && !channels.includes(event.channel))
    ) {
        return undefined;
    }

    const text = event.text ?? "";
    const mention = `<@${user}>`;

    return {
        id: `${event.channel}:${event.ts}`,
        channel: event.channel,
        thread: event.thread_ts ?? event.ts,
        text: text.split(mention).join("").trim(),
        author: { id: event.user, name: event.user, bot: event.user === user },
        mentioned: text.includes(mention) || event.channel_type === "im",
        at: Number(event.ts) * 1000,
        attachments: (event.files ?? []).map(
            (file) =>
                `File: ${(file.name ?? file.mimetype ?? "attachment").replace(/[\r\n]/g, " ")}`,
        ),
    };
}

async function socketRun(
    context: RelayContext,
    url: string,
    user: string,
    channels: string[],
): Promise<void> {
    let socket: WebSocket;

    try {
        socket = new WebSocket(url);
    } catch {
        throw new Error("Slack socket failed. Check the connection.");
    }

    let pending = Promise.resolve();
    let failure: unknown;

    let finish: () => void = () => {};

    const ended = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const timeout = setTimeout(() => {
        failure = new Error("Slack socket connection timed out.");
        finish();
    }, 20_000);
    const abort = () => finish();

    const onOpen = () => {
        clearTimeout(timeout);
        context.status("Connected");
    };

    const onMessage = (message: MessageEvent) => {
        try {
            const envelope = JSON.parse(String(message.data)) as Envelope;

            if (envelope.envelope_id) {
                socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            }

            if (envelope.type === "disconnect") {
                finish();
            }

            if (envelope.type === "events_api" && envelope.payload?.event) {
                const event = eventOf(envelope.payload.event, user, channels);

                if (event) {
                    pending = pending
                        .then(async () => {
                            if (!context.signal.aborted) {
                                await context.emit([event]);
                            }
                        })
                        .catch(() => {
                            failure = new Error("Slack message delivery failed.");
                            finish();
                        });
                }
            }
        } catch {
            failure = new Error("Slack sent an invalid socket message.");
            finish();
        }
    };

    const onError = () => {
        failure = new Error("Slack socket failed. Check the connection.");
        finish();
    };

    const onClose = () => finish();

    context.signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);

    try {
        if (!context.signal.aborted) {
            await ended;
        }

        await pending;

        if (failure && !context.signal.aborted) {
            throw failure;
        }
    } finally {
        clearTimeout(timeout);
        context.signal.removeEventListener("abort", abort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        // Keep the safe error handler for a close during the opening handshake.
        socket.close();
    }
}

const slack: RelayConnector = {
    kind: "slack",
    label: "Slack",
    description: "A Slack app in Socket Mode: messages in its channels and direct messages.",
    shape: "stream",
    mentions: true,
    fields: [
        {
            name: "appToken",
            label: "App token",
            type: "secret",
            required: true,
            placeholder: "xapp-…",
        },
        {
            name: "botToken",
            label: "Bot token",
            type: "secret",
            required: true,
            placeholder: "xoxb-…",
        },
        {
            name: "channels",
            label: "Channel IDs",
            type: "text",
            description: "Comma-separated channel IDs. Leave empty for all channels.",
        },
        { name: "replyChannel", label: "Default reply channel", type: "text" },
        {
            name: "apiUrl",
            label: "API address",
            type: "text",
            description: "Leave empty for the service's own address.",
        },
    ],
    check(values) {
        if (
            !String(values.appToken ?? "").startsWith("xapp-") ||
            !String(values.botToken ?? "").startsWith("xoxb-")
        ) {
            return "Slack needs an xapp- app token and an xoxb- bot token.";
        }
    },
    async run(context) {
        const { user_id: user } = await request<{ user_id: string }>(context, "auth.test");
        const channels = String(context.values.channels ?? "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);

        context.save({});

        while (!context.signal.aborted) {
            const { url } = await request<{ url: string }>(context, "apps.connections.open", true);

            await socketRun(context, url, user, channels);

            if (!context.signal.aborted) {
                context.status("Reconnecting");
                await context.sleep(1000);
            }
        }
    },
    async reply(context, reply) {
        const channel = reply.to?.channel ?? reply.channel ?? context.values.replyChannel;
        const thread = reply.to?.thread ?? reply.thread;

        if (!channel) {
            throw new Error("Choose a Slack reply channel.");
        }

        const result = await request<{ ts: string }>(context, "chat.postMessage", false, {
            channel,
            text: reply.text.slice(0, 4000),
            ...(thread ? { thread_ts: thread } : {}),
            unfurl_links: false,
            parse: "none",
        });

        return { id: `${channel}:${result.ts}` };
    },
};

export default slack;
