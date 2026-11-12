/**
 * Discord: a bot that hears messages over the gateway (v10) and replies over REST. It resumes its gateway session
 * across reloads, keeps Discord's identify limit, and fills a gap over REST when a session is lost.
 */
import { createHash } from "node:crypto";
import {
    RelayError,
    type RelayConnector,
    type RelayContext,
    type RelayEvent,
    type RelayValues,
} from "../types.ts";

const API = "https://discord.com/api/v10";
// GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT.
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const DAY = 86_400_000;
const IDENTIFY_GAP = 30_000;
/** How long a closed socket waits for the gateway's answer: a dead connection never gives one. */
const CLOSE_WAIT = 2_000;
const IDENTIFY_MAX = 900;
const CURSOR_MAX = 100;
const BACKFILL_CHANNELS = 25;
const BACKFILL_PAGES = 10;
const PAGE = 100;
const LIMIT = 2000;
const THREAD_TYPES = new Set([10, 11, 12]);
const USER_AGENT = "DiscordBot (https://github.com/TannerMidd/pi-pocket, 1)";

const FATAL_CLOSES: Readonly<Record<number, string>> = {
    4004: "Discord refused the bot token (gateway close 4004): check the token in the Developer Portal.",
    4010: "Discord refused the shard (gateway close 4010).",
    4011: "Discord needs sharding for this bot (gateway close 4011): it is in too many servers for one connection.",
    4012: "Discord refused the gateway version (gateway close 4012).",
    4013: "Discord refused the gateway intents (gateway close 4013).",
    4014: "Discord refused a privileged intent (gateway close 4014): turn on Message Content Intent under Bot in the Developer Portal.",
};

interface Session {
    id: string;
    url: string;
    seq: number | null;
}

/** The last message id seen in a channel, its server ("" in a DM), and a thread's parent channel. */
interface Cursor {
    m: string;
    g: string;
    p?: string;
}

interface State {
    session?: Session;
    user?: string;
    identifies: number[];
    cursors: Record<string, Cursor>;
    backfill?: boolean;
}

interface User {
    id: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
}

interface Message {
    id: string;
    channel_id: string;
    guild_id?: string;
    type?: number;
    content?: string;
    timestamp?: string;
    webhook_id?: string;
    author?: User;
    mentions?: { id: string }[];
    attachments?: { filename?: string; content_type?: string; size?: number }[];
}

interface Channel {
    id?: string;
    name?: string;
    type?: number;
    guild_id?: string;
    parent_id?: string | null;
    last_message_id?: string | null;
}

interface Payload {
    op?: number;
    d?: unknown;
    s?: number | null;
    t?: string | null;
}

interface Outcome {
    ready: boolean;
    invalid: boolean;
    code?: number;
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function snowflake(value: unknown): value is string {
    return typeof value === "string" && /^\d{1,20}$/.test(value);
}

function newer(a: string, b: string): boolean {
    return BigInt(a) > BigInt(b);
}

function secretOf(values: RelayValues): string {
    const token = text(values.token).replace(/^Bot\s+/i, "");

    if (token === "") {
        throw new RelayError("Add the bot token.", { fatal: true });
    }

    return token;
}

function channelsOf(values: RelayValues): Set<string> {
    return new Set(
        text(values.channels)
            .split(/[\s,]+/)
            .filter((id) => id !== ""),
    );
}

function gatewayAddress(base: string): string {
    const url = new URL(base);

    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");

    return url.href;
}

function readState(saved: Readonly<Record<string, unknown>>): State {
    const state: State = { identifies: [], cursors: {} };
    const session = saved.session as Partial<Session> | undefined;

    if (
        session !== undefined &&
        typeof session.id === "string" &&
        typeof session.url === "string"
    ) {
        state.session = {
            id: session.id,
            url: session.url,
            seq: typeof session.seq === "number" ? session.seq : null,
        };
    }

    if (snowflake(saved.user)) {
        state.user = saved.user;
    }

    if (Array.isArray(saved.identifies)) {
        state.identifies = saved.identifies.filter((at): at is number => typeof at === "number");
    }

    if (saved.cursors !== null && typeof saved.cursors === "object") {
        for (const [id, cursor] of Object.entries(saved.cursors as Record<string, Cursor>)) {
            if (snowflake(id) && snowflake(cursor?.m)) {
                state.cursors[id] = {
                    m: cursor.m,
                    g: typeof cursor.g === "string" ? cursor.g : "",
                    ...(snowflake(cursor.p) ? { p: cursor.p } : {}),
                };
            }
        }
    }

    if (saved.backfill === true) {
        state.backfill = true;
    }

    return state;
}

/** Discord's REST API. `soft`: a channel the bot cannot read (403, 404) gives undefined, not an error. */
async function api(
    values: RelayValues,
    signal: AbortSignal,
    method: string,
    path: string,
    body?: unknown,
    soft = false,
): Promise<unknown> {
    const base = (text(values.apiUrl) || API).replace(/\/+$/, "");
    const response = await fetch(`${base}${path}`, {
        method,
        headers: {
            Authorization: `Bot ${secretOf(values)}`,
            "User-Agent": USER_AGENT,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    const where = `${method} ${path.split("?")[0]}`;

    if (response.ok) {
        return response.json();
    }

    if (response.status === 429) {
        const data = (await response.json().catch(() => ({}))) as { retry_after?: unknown };
        const seconds =
            typeof data.retry_after === "number"
                ? data.retry_after
                : Number(response.headers.get("retry-after")) || 1;

        throw new RelayError(`Discord limited the rate of ${where}.`, {
            retryAfter: Math.ceil(seconds * 1000),
        });
    }

    await response.body?.cancel();

    if (soft && (response.status === 403 || response.status === 404)) {
        return undefined;
    }

    if (response.status === 401) {
        throw new RelayError("Discord refused the bot token: check it in the Developer Portal.", {
            fatal: true,
        });
    }

    if (response.status === 403) {
        throw new RelayError(
            `Discord denied ${where}: check the bot's permissions in that server and channel.`,
            { fatal: true },
        );
    }

    throw new Error(`Discord answered ${response.status} to ${where}.`);
}

function cut(value: string, limit: number): string {
    if (value.length <= limit) {
        return value;
    }

    const code = value.charCodeAt(limit - 1);

    return value.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}

function toEvent(
    message: Message,
    guild: string | undefined,
    me: string | undefined,
    channelName: string | undefined,
): RelayEvent | undefined {
    if (message.type !== undefined && message.type !== 0 && message.type !== 19) {
        return undefined;
    }

    const author = message.author ?? { id: "", username: "unknown" };
    const own = me !== undefined && author.id === me;
    const named = me !== undefined && (message.mentions ?? []).some((user) => user.id === me);
    let content = message.content ?? "";

    if (me !== undefined) {
        content = content.replace(new RegExp(`<@!?${me}>`, "g"), "").trim();
    }

    const attachments = (message.attachments ?? []).map(
        (file) =>
            `${file.filename ?? "file"} (${file.content_type ?? "unknown type"}, ${file.size ?? 0} bytes)`,
    );
    const at = message.timestamp === undefined ? NaN : Date.parse(message.timestamp);

    return {
        id: message.id,
        text: content,
        author: {
            id: author.id,
            name: author.global_name ?? author.username ?? author.id,
            bot: author.bot === true || message.webhook_id !== undefined || own,
        },
        channel: message.channel_id,
        ...(channelName === undefined ? {} : { channelName }),
        mentioned: named || guild === undefined,
        url: `https://discord.com/channels/${guild ?? "@me"}/${message.channel_id}/${message.id}`,
        ...(Number.isFinite(at) ? { at } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
    };
}

async function run(context: RelayContext): Promise<void> {
    const { values, signal } = context;
    const secret = secretOf(values);
    const state = readState(context.state);
    const listed = channelsOf(values);
    const directMessages = values.directMessages !== false && values.directMessages !== "false";
    const channels = new Map<string, { name?: string; parent?: string }>();
    let chain: Promise<void> = Promise.resolve();
    let failure: unknown;

    let closeCurrent: () => void = () => {};

    const save = (): void => {
        context.save(JSON.parse(JSON.stringify(state)) as Record<string, unknown>);
    };

    const allowed = (channel: string, guild: string | undefined, parent?: string): boolean => {
        if (guild === undefined) {
            return directMessages;
        }

        return (
            listed.size === 0 || listed.has(channel) || (parent !== undefined && listed.has(parent))
        );
    };

    const remember = (channel: Channel | undefined): void => {
        if (channel === undefined || !snowflake(channel.id)) {
            return;
        }

        const parent =
            THREAD_TYPES.has(channel.type ?? -1) && snowflake(channel.parent_id)
                ? channel.parent_id
                : undefined;

        channels.set(channel.id, {
            ...(channel.name ? { name: channel.name } : {}),
            ...(parent ? { parent } : {}),
        });
    };

    // Messages oldest first: emit what passes, then move each channel's cursor.
    const take = async (messages: Message[], fallbackGuild?: string): Promise<void> => {
        const events: RelayEvent[] = [];
        const moved = new Map<string, Cursor>();

        for (const message of messages) {
            if (!snowflake(message.id) || !snowflake(message.channel_id)) {
                continue;
            }

            const id = message.channel_id;
            const guild = message.guild_id ?? (fallbackGuild || undefined);
            const parent = channels.get(id)?.parent ?? state.cursors[id]?.p;

            if (!allowed(id, guild, parent)) {
                continue;
            }

            const event = toEvent(message, guild, state.user, channels.get(id)?.name);

            if (event !== undefined) {
                events.push(event);
            }

            const cursor = moved.get(id) ?? state.cursors[id];

            if (cursor === undefined || newer(message.id, cursor.m)) {
                moved.set(id, { m: message.id, g: guild ?? "", ...(parent ? { p: parent } : {}) });
            }
        }

        if (events.length > 0) {
            await context.emit(events);
        }

        if (moved.size === 0) {
            return;
        }

        for (const [id, cursor] of moved) {
            state.cursors[id] = cursor;
        }

        const ids = Object.keys(state.cursors);

        if (ids.length > CURSOR_MAX) {
            ids.sort((a, b) => (newer(state.cursors[b]!.m, state.cursors[a]!.m) ? 1 : -1));
            ids.slice(CURSOR_MAX).forEach((id) => delete state.cursors[id]);
        }

        save();
    };

    // After a lost session: what came in each channel while the bot was away, then a cursor for new listed channels.
    const catchUp = async (): Promise<void> => {
        if (state.backfill === true) {
            const cursors = Object.entries(state.cursors)
                .filter(([id, cursor]) => allowed(id, cursor.g || undefined, cursor.p))
                .sort((a, b) => (newer(b[1].m, a[1].m) ? 1 : -1))
                .slice(0, BACKFILL_CHANNELS);

            for (const [id, cursor] of cursors) {
                for (let page = 0; page < BACKFILL_PAGES; page++) {
                    const after = state.cursors[id]?.m ?? cursor.m;
                    const found = await api(
                        values,
                        signal,
                        "GET",
                        `/channels/${id}/messages?after=${after}&limit=${PAGE}`,
                        undefined,
                        true,
                    );

                    if (!Array.isArray(found)) {
                        context.log(
                            `Discord channel ${id} is not readable: check the bot's access.`,
                        );
                        break;
                    }

                    const messages = (found as Message[])
                        .filter((message) => snowflake(message.id))
                        .sort((a, b) => (newer(a.id, b.id) ? 1 : -1));

                    await take(messages, cursor.g);

                    if (found.length < PAGE || state.cursors[id]?.m === after) {
                        break;
                    }
                }
            }

            delete state.backfill;
            save();
        }

        for (const id of listed) {
            if (state.cursors[id] !== undefined || !snowflake(id)) {
                continue;
            }

            const channel = (await api(
                values,
                signal,
                "GET",
                `/channels/${id}`,
                undefined,
                true,
            )) as Channel | undefined;

            if (channel === undefined) {
                context.log(`Discord channel ${id} is not readable: check the bot's access.`);
                continue;
            }

            const parent =
                THREAD_TYPES.has(channel.type ?? -1) && snowflake(channel.parent_id)
                    ? channel.parent_id
                    : undefined;

            state.cursors[id] = {
                m: snowflake(channel.last_message_id) ? channel.last_message_id : id,
                g: channel.guild_id ?? "",
                ...(parent ? { p: parent } : {}),
            };
            save();
        }
    };

    const enqueue = (task: () => Promise<void> | void): void => {
        chain = chain.then(async () => {
            if (failure !== undefined) {
                return;
            }

            try {
                await task();
            } catch (error) {
                failure = error;
                closeCurrent();
            }
        });
    };

    const dispatch = async (type: string, data: unknown): Promise<void> => {
        switch (type) {
            case "READY": {
                const ready = data as {
                    session_id?: string;
                    resume_gateway_url?: string;
                    user?: User;
                };

                if (typeof ready.session_id === "string") {
                    state.session = {
                        id: ready.session_id,
                        url: ready.resume_gateway_url ?? state.session?.url ?? "",
                        seq: null,
                    };
                }

                if (snowflake(ready.user?.id)) {
                    state.user = ready.user.id;
                }

                if (Object.keys(state.cursors).length > 0) {
                    state.backfill = true;
                }

                context.status(`Connected as ${ready.user?.username ?? "the bot"}`);
                save();
                await catchUp();
                break;
            }

            case "RESUMED":
                context.status("Connected");
                await catchUp();
                break;

            case "GUILD_CREATE": {
                const guild = data as { channels?: Channel[]; threads?: Channel[] };

                (guild.channels ?? []).forEach(remember);
                (guild.threads ?? []).forEach(remember);
                break;
            }

            case "CHANNEL_CREATE":
            case "CHANNEL_UPDATE":
            case "THREAD_CREATE":
            case "THREAD_UPDATE":
                remember(data as Channel);
                break;
            case "THREAD_LIST_SYNC":
                ((data as { threads?: Channel[] }).threads ?? []).forEach(remember);
                break;
            case "MESSAGE_CREATE":
                await take([data as Message]);
                break;
        }
    };

    // Waits until Discord's identify limit allows one more: 30 s apart, 900 a day.
    const identifyGate = async (): Promise<boolean> => {
        const now = Date.now();

        state.identifies = state.identifies.filter((at) => now - at < DAY).sort((a, b) => a - b);
        const last = state.identifies.at(-1);
        const count = state.identifies.length;
        const wait = Math.max(
            last === undefined ? 0 : last + IDENTIFY_GAP - now,
            count >= IDENTIFY_MAX ? state.identifies[count - IDENTIFY_MAX]! + DAY - now : 0,
        );

        if (wait > 0) {
            context.status(`Waiting ${Math.ceil(wait / 1000)} s to identify (Discord's limit)`);
            await context.sleep(wait);
        }

        return !signal.aborted;
    };

    const gatewayFromApi = async (): Promise<string> => {
        const info = (await api(values, signal, "GET", "/gateway/bot")) as {
            url?: unknown;
            session_start_limit?: { remaining?: number; reset_after?: number };
        };
        const limit = info.session_start_limit;

        if (limit?.remaining === 0 && (limit.reset_after ?? 0) > 0) {
            context.status(
                `Discord's daily identify limit is used up: waiting ${Math.ceil(limit.reset_after! / 60_000)} min`,
            );
            await context.sleep(limit.reset_after!);
        }

        if (typeof info.url !== "string") {
            throw new Error("Discord gave no gateway address.");
        }

        return info.url;
    };

    const connect = async (): Promise<Outcome | undefined> => {
        const session = state.session;
        let address: string;

        if (session !== undefined) {
            address = session.url;
            context.status("Resuming");
        } else {
            address = text(values.gatewayUrl) || (await gatewayFromApi());

            if (signal.aborted || !(await identifyGate())) {
                return undefined;
            }

            context.status("Connecting");
        }

        return new Promise<Outcome>((resolve) => {
            const socket = new WebSocket(gatewayAddress(address));
            let timer: ReturnType<typeof setTimeout> | undefined;
            let interval = 41_250;
            let acked = true;
            let ready = false;
            let invalid = false;
            let seq = session?.seq ?? null;
            let closing: ReturnType<typeof setTimeout> | undefined;
            let settled = false;

            const send = (data: unknown): void => {
                try {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify(data));
                    }
                } catch {
                    // A closing socket: its close event follows.
                }
            };

            const close = (): void => {
                clearTimeout(timer);

                try {
                    socket.close(4000);
                } catch {
                    // Already closed.
                }

                // Node's WebSocket waits for the gateway to answer the close frame, and a dead connection (the reason
                // for a missed ACK) never does: the connection ends here all the same.
                closing ??= setTimeout(() => finish(undefined), CLOSE_WAIT);
            };

            const beat = (): void => {
                if (!acked) {
                    context.log("Discord did not acknowledge a heartbeat: reconnecting.");
                    close();

                    return;
                }

                acked = false;
                send({ op: 1, d: seq });
                timer = setTimeout(beat, interval);
            };

            const handle = (payload: Payload): void => {
                if (typeof payload.s === "number") {
                    seq = payload.s;
                }

                switch (payload.op) {
                    case 10: {
                        const given = (payload.d as { heartbeat_interval?: unknown })
                            ?.heartbeat_interval;

                        if (typeof given === "number" && given > 0) {
                            interval = given;
                        }

                        clearTimeout(timer);
                        timer = setTimeout(beat, interval * Math.random());

                        if (session !== undefined) {
                            send({
                                op: 6,
                                d: { token: secret, session_id: session.id, seq: session.seq },
                            });
                        } else {
                            state.identifies.push(Date.now());
                            save();
                            send({
                                op: 2,
                                d: {
                                    token: secret,
                                    intents: INTENTS,
                                    properties: {
                                        os: process.platform,
                                        browser: "pi-pocket",
                                        device: "pi-pocket",
                                    },
                                },
                            });
                        }

                        break;
                    }

                    case 11:
                        acked = true;
                        break;
                    case 1:
                        send({ op: 1, d: seq });
                        break;
                    case 7:
                        context.log("Discord asked the bot to reconnect.");
                        close();
                        break;
                    case 9:
                        if (payload.d !== true) {
                            invalid = true;
                            delete state.session;
                        }

                        close();
                        break;

                    case 0: {
                        const type = typeof payload.t === "string" ? payload.t : "";
                        const s = payload.s;

                        if (type === "READY" || type === "RESUMED") {
                            ready = true;
                        }

                        enqueue(async () => {
                            await dispatch(type, payload.d);

                            if (state.session !== undefined && typeof s === "number") {
                                state.session.seq = s;
                            }
                        });
                        break;
                    }
                }
            };

            // A stop does not wait for the gateway's answer: the close frame went, and the session stays resumable.
            const onAbort = (): void => {
                close();
                finish(undefined);
            };

            closeCurrent = close;
            signal.addEventListener("abort", onAbort, { once: true });

            if (signal.aborted) {
                close();
            }

            socket.addEventListener("message", (message) => {
                if (settled) {
                    return;
                }

                try {
                    handle(JSON.parse(String(message.data)) as Payload);
                } catch (error) {
                    context.log(
                        `Discord sent a gateway message the bot could not read: ${error instanceof Error ? error.message : "unknown error"}.`,
                    );
                    close();
                }
            });
            socket.addEventListener("error", () => {
                // The close event follows and says what happened.
            });

            const finish = (code: number | undefined): void => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timer);
                clearTimeout(closing);
                signal.removeEventListener("abort", onAbort);

                closeCurrent = () => {};

                const fatal = code === undefined ? undefined : FATAL_CLOSES[code];

                if (fatal !== undefined && failure === undefined) {
                    failure = new RelayError(fatal, { fatal: true });
                }

                if (code === 4007 || code === 4009) {
                    delete state.session;
                }

                void chain.then(() => {
                    try {
                        save();
                    } catch (error) {
                        failure ??= error;
                    }

                    resolve({ ready, invalid, ...(code === undefined ? {} : { code }) });
                });
            };

            socket.addEventListener("close", (event) => finish(event.code));
        });
    };

    let idle = 0;
    let wait = 0;

    try {
        while (!signal.aborted) {
            if (wait > 0) {
                await context.sleep(wait);

                if (signal.aborted) {
                    break;
                }
            }

            const outcome = await connect();

            if (signal.aborted) {
                break;
            }

            if (failure !== undefined) {
                throw failure;
            }

            if (outcome === undefined) {
                continue;
            }

            idle = outcome.ready ? 0 : idle + 1;

            // A session that does not resume twice in a row is gone: identify fresh.
            if (idle >= 2 && state.session !== undefined) {
                delete state.session;
                save();
            }

            if (idle >= 4) {
                throw new Error(
                    `Discord's gateway closed (code ${outcome.code ?? "none"}) before the bot was ready.`,
                );
            }

            wait = outcome.invalid ? 1000 + Math.random() * 4000 : 1000;
        }
    } finally {
        save();
    }
}

const discord: RelayConnector = {
    kind: "discord",
    label: "Discord",
    idempotentReply: true,
    description:
        "A Discord bot: it hears messages in your servers and direct messages, and replies.",
    shape: "stream",
    mentions: true,
    fields: [
        {
            name: "token",
            label: "Bot token",
            type: "secret",
            required: true,
            description:
                "From the Developer Portal: your application, then Bot. Turn on Message Content Intent there too.",
        },
        {
            name: "channels",
            label: "Channels",
            type: "text",
            description:
                "Channel IDs to listen in, separated by commas. Leave empty for every channel the bot can see.",
            placeholder: "123456789012345678, 234567890123456789",
        },
        {
            name: "directMessages",
            label: "Direct messages",
            type: "boolean",
            default: true,
            description: "Hear messages that people send to the bot directly.",
        },
        {
            name: "replyChannel",
            label: "Reply channel",
            type: "text",
            description: "A channel ID for a reply that does not answer a message.",
        },
        {
            name: "apiUrl",
            label: "API address",
            type: "text",
            description: "Leave empty for the service's own address.",
            placeholder: API,
        },
        {
            name: "gatewayUrl",
            label: "Gateway address",
            type: "text",
            description: "Leave empty to ask Discord for it.",
        },
    ],
    check(values) {
        const ids = [...channelsOf(values), text(values.replyChannel)].filter((id) => id !== "");

        if (ids.some((id) => !/^\d{15,22}$/.test(id))) {
            return "Channel IDs are numbers: in Discord, turn on Developer Mode, then right-click a channel and choose Copy Channel ID.";
        }

        for (const name of ["apiUrl", "gatewayUrl"]) {
            const address = text(values[name]);

            if (address !== "" && !URL.canParse(address)) {
                return `${name === "apiUrl" ? "API" : "Gateway"} address is not a URL.`;
            }
        }

        return undefined;
    },
    run,
    async reply(context, reply) {
        const target =
            reply.to?.thread ??
            reply.to?.channel ??
            reply.thread ??
            reply.channel ??
            (text(context.values.replyChannel) || undefined);

        if (target === undefined || !snowflake(target)) {
            throw new Error("The reply has no Discord channel: name one, or set Reply channel.");
        }

        const message = (await api(
            context.values,
            context.signal,
            "POST",
            `/channels/${target}/messages`,
            {
                content: cut(reply.text, LIMIT),
                allowed_mentions: { parse: [], replied_user: false },
                nonce: createHash("sha256").update(reply.key).digest("base64url").slice(0, 25),
                enforce_nonce: true,
                ...(reply.to !== undefined && snowflake(reply.to.id)
                    ? { message_reference: { message_id: reply.to.id, fail_if_not_exists: false } }
                    : {}),
            },
        )) as { id?: unknown };

        return typeof message.id === "string" ? { id: message.id } : {};
    },
};

export default discord;
