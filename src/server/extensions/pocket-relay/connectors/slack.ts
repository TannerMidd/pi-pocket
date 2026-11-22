import { bytesOf, getFrom } from "../download.ts";
import {
    RelayError,
    type RelayConnector,
    type RelayContext,
    type RelayEvent,
    type RelayFile,
    type RelayOutFile,
    type RelayValues,
} from "../types.ts";

/** Slack takes files of up to 1 GB: the relay keeps them in memory, so it sends 50 MB at most. */
const MAX_FILE = 50 * 1024 * 1024;

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
    files?: SlackFile[];
}
interface SlackFile {
    id?: string;
    name?: string;
    mimetype?: string;
    size?: number;
    mode?: string;
    url_private?: string;
    url_private_download?: string;
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
    form?: Record<string, string>,
): Promise<T> {
    let response: Response;
    let data: T & { ok?: boolean; error?: string; needed?: string };

    try {
        const base = String(context.values.apiUrl || "https://slack.com/api").replace(/\/$/, "");

        // The file methods take form fields, not JSON.
        response = await fetch(`${base}/${method}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${app ? context.values.appToken : context.values.botToken}`,
                "content-type":
                    form === undefined ? "application/json" : "application/x-www-form-urlencoded",
            },
            body: form === undefined ? JSON.stringify(body ?? {}) : new URLSearchParams(form),
            signal: AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]),
        });
        data = (await response.json().catch(() => ({}))) as typeof data;
    } catch {
        throw new Error("Slack request failed. Check the API address and connection.");
    }

    if (data.error === "missing_scope" && /^[a-z:._,]{1,100}$/.test(data.needed ?? "")) {
        throw new RelayError(`Slack denied access: the bot token needs the ${data.needed} scope.`, {
            fatal: true,
        });
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
        (event.subtype !== undefined &&
            event.subtype !== "thread_broadcast" &&
            event.subtype !== "file_share") ||
        !event.channel ||
        !event.ts ||
        !event.user ||
        (channels.length > 0 && !channels.includes(event.channel))
    ) {
        return undefined;
    }

    const text = event.text ?? "";
    const mention = `<@${user}>`;
    // A file kept outside Slack (a drive's link) or deleted has nothing for the bot to download.
    const files: RelayFile[] = (event.files ?? []).flatMap((file) =>
        typeof file.id === "string" && file.mode !== "external" && file.mode !== "tombstone"
            ? [
                  {
                      name: file.name ?? "file",
                      ...(typeof file.mimetype === "string" ? { type: file.mimetype } : {}),
                      ...(typeof file.size === "number" ? { size: file.size } : {}),
                      ref: JSON.stringify({
                          id: file.id,
                          url: file.url_private_download ?? file.url_private,
                      }),
                  },
              ]
            : [],
    );

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
        ...(files.length > 0 ? { files } : {}),
    };
}

/** Slack's file host, and the API's own (a mock's) when the owner set one: the bot token goes to no other host. */
function fileHost(url: URL, values: RelayValues): boolean {
    const api = String(values.apiUrl ?? "");

    return (
        (url.protocol === "https:" && url.hostname === "files.slack.com") ||
        (api !== "" && URL.canParse(api) && url.origin === new URL(api).origin)
    );
}

const escape = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function download(
    context: Pick<RelayContext, "values" | "signal">,
    file: RelayFile,
    max: number,
): Promise<{ data: Uint8Array; type?: string }> {
    const ref = JSON.parse(file.ref) as { id?: unknown; url?: unknown };
    let url = typeof ref.url === "string" ? ref.url : undefined;

    // An event may leave the link out (a file shared from another workspace): files.info has it.
    if (url === undefined && typeof ref.id === "string") {
        const info = await request<{ file?: SlackFile }>(context, "files.info", false, undefined, {
            file: ref.id,
        });

        url = info.file?.url_private_download ?? info.file?.url_private;
    }

    if (url === undefined) {
        throw new Error("Slack has no download for the attachment");
    }

    const response = await getFrom(
        url,
        (each) => fileHost(each, context.values),
        {
            headers: { Authorization: `Bearer ${context.values.botToken}` },
            signal: context.signal,
        },
        "Slack's file host",
    );

    if (!response.ok) {
        await response.body?.cancel();

        throw new Error(`Slack's file host answered ${response.status}`);
    }

    const type = response.headers.get("content-type") ?? undefined;

    // Without the files:read scope, Slack answers with its sign-in page.
    if (type?.startsWith("text/html") && !file.type?.startsWith("text/html")) {
        await response.body?.cancel();

        throw new Error("Slack sent a sign-in page: the bot token needs the files:read scope");
    }

    return { data: await bytesOf(response, max), ...(type === undefined ? {} : { type }) };
}

/** Upload one file (Slack's external upload): it shows only when `completeUploadExternal` shares it. */
async function upload(context: RequestContext, file: RelayOutFile): Promise<string> {
    const { upload_url: url, file_id: id } = await request<{
        upload_url?: string;
        file_id?: string;
    }>(context, "files.getUploadURLExternal", false, undefined, {
        filename: file.name,
        length: String(file.data.byteLength),
    });

    if (
        typeof id !== "string" ||
        typeof url !== "string" ||
        !URL.canParse(url) ||
        !fileHost(new URL(url), context.values)
    ) {
        throw new Error("Slack gave an upload address that is not its own. Nothing was sent.");
    }

    let response: Response;

    try {
        // The address is signed for this one file: it needs no token.
        response = await fetch(url, {
            method: "POST",
            headers: { "content-type": file.type },
            body: new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.type }),
            redirect: "error",
            signal: AbortSignal.any([context.signal, AbortSignal.timeout(110_000)]),
        });
        await response.body?.cancel();
    } catch {
        throw new Error("Slack upload failed. Check the connection.");
    }

    if (!response.ok) {
        throw new Error(`Slack upload failed: its file host answered ${response.status}.`);
    }

    return id;
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

            const ack = () => {
                if (envelope.envelope_id && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
                }
            };

            if (envelope.type === "disconnect") {
                ack();
                finish();
            }

            const event =
                envelope.type === "events_api" && envelope.payload?.event
                    ? eventOf(envelope.payload.event, user, channels)
                    : undefined;

            // An event is acknowledged only once the relay stored it: Slack sends one it did not hear back about again.
            if (event) {
                pending = pending
                    .then(async () => {
                        if (!context.signal.aborted) {
                            await context.emit([event]);
                            ack();
                        }
                    })
                    .catch(() => {
                        failure = new Error("Slack message delivery failed.");
                        finish();
                    });
            } else if (envelope.type !== "disconnect") {
                ack();
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

        let delay = 1000;

        while (!context.signal.aborted) {
            const { url } = await request<{ url: string }>(context, "apps.connections.open", true);
            const started = Date.now();

            await socketRun(context, url, user, channels);

            if (!context.signal.aborted) {
                // A socket that closes at once is retried less often each time; one that lived a while starts over.
                delay = Date.now() - started >= 30_000 ? 1000 : delay;
                context.status("Reconnecting");
                await context.sleep(delay);
                delay = Math.min(delay * 2, 60_000);
            }
        }
    },
    // 10 files a reply, as Discord: Slack shares them in one message.
    files: { max: 10, maxBytes: MAX_FILE },
    fetch: download,
    async reply(context, reply) {
        const channel = reply.to?.channel ?? reply.channel ?? context.values.replyChannel;
        const thread = reply.to?.thread ?? reply.thread;

        if (!channel) {
            throw new Error("Choose a Slack reply channel.");
        }

        const files = reply.files ?? [];

        // Files and text go as one message: the text is its comment.
        if (files.length > 0) {
            const ids: string[] = [];

            for (const file of files) {
                ids.push(await upload(context, file));
            }

            const text = escape(reply.text.slice(0, 4000));

            await request(context, "files.completeUploadExternal", false, undefined, {
                files: JSON.stringify(ids.map((id, index) => ({ id, title: files[index]!.name }))),
                channel_id: String(channel),
                ...(thread ? { thread_ts: String(thread) } : {}),
                ...(text === "" ? {} : { initial_comment: text }),
            });

            return {};
        }

        const result = await request<{ ts: string }>(context, "chat.postMessage", false, {
            channel,
            text: escape(reply.text.slice(0, 4000)),
            ...(thread ? { thread_ts: thread } : {}),
            unfurl_links: false,
            parse: "none",
        });

        return { id: `${channel}:${result.ts}` };
    },
};

export default slack;
