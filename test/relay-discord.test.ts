import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import discord from "../src/server/extensions/pocket-relay/connectors/discord.ts";
import {
    RelayError,
    type RelayContext,
    type RelayEvent,
} from "../src/server/extensions/pocket-relay/types.ts";
import { mockServer, type MockSocket } from "./relay-ws-mock.ts";

const TOKEN = "test-token-value";
const BOT = "900";
const G = "50";
const C1 = "1001";

const closes: number[] = [];
const Native = globalThis.WebSocket;

globalThis.WebSocket = class extends Native {
    override close(code?: number, reason?: string): void {
        closes.push(code ?? 1005);
        super.close(code, reason);
    }
} as typeof WebSocket;

type Mock = Awaited<ReturnType<typeof mockServer>>;
type Packet = { op: number; d?: Record<string, unknown> | boolean | null };

const mocks: Mock[] = [];

afterEach(() => {
    for (const mock of mocks.splice(0)) {
        mock.server.closeAllConnections();
        mock.server.close();
    }
});

function message(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        channel_id: C1,
        guild_id: G,
        type: 0,
        content: `m${id}`,
        timestamp: "2025-01-01T00:00:00.000Z",
        author: { id: "7", username: "ann", global_name: "Ann" },
        mentions: [],
        attachments: [],
        ...extra,
    };
}

function fakeContext(
    values: Record<string, string | boolean>,
    state: Record<string, unknown> = {},
) {
    const controller = new AbortController();
    const events: RelayEvent[] = [];
    const waits: number[] = [];
    const statuses: string[] = [];
    let saved = state;

    const context: RelayContext = {
        values: { token: TOKEN, ...values },
        get state() {
            return saved;
        },
        save(next) {
            saved = structuredClone(next);
        },
        emit: async (list) => {
            events.push(...list);
        },
        signal: controller.signal,
        status: (text) => statuses.push(text),
        log: () => {},
        sleep: (ms) => {
            waits.push(ms);

            return new Promise((resolve) => setTimeout(resolve, 1));
        },
    };

    return { context, controller, events, waits, statuses, state: () => saved };
}

async function until(check: () => boolean, limit = 400): Promise<void> {
    for (let tries = 0; !check(); tries++) {
        assert.ok(tries < limit, "timed out");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function sent(sockets: MockSocket[], op: number): Packet[] {
    return sockets.flatMap((socket) => socket.received as Packet[]).filter((p) => p.op === op);
}

function hello(socket: MockSocket, interval: number): void {
    socket.send({ op: 10, d: { heartbeat_interval: interval } });
}

test("identifies once, then resumes after a missed heartbeat ACK", async () => {
    const mock: Mock = await mockServer(
        (request) =>
            request.url === "/api/gateway/bot"
                ? {
                      json: {
                          url: mock.ws,
                          session_start_limit: { remaining: 999, reset_after: 0 },
                      },
                  }
                : { status: 404 },
        (socket) => {
            const resuming = socket.path.startsWith("/resume");

            // The first socket never ACKs a heartbeat, so the connector drops it.
            hello(socket, resuming ? 60_000 : 30);
            socket.onMessage((data) => {
                const packet = data as Packet;

                if (packet.op === 2) {
                    socket.send({
                        op: 0,
                        t: "READY",
                        s: 1,
                        d: {
                            session_id: "S1",
                            resume_gateway_url: `${mock.ws}/resume`,
                            user: { id: BOT, username: "pi" },
                        },
                    });
                    socket.send({ op: 0, t: "MESSAGE_CREATE", s: 2, d: message("101") });
                }

                if (packet.op === 6) {
                    socket.send({ op: 0, t: "RESUMED", s: 3, d: {} });
                    socket.send({
                        op: 0,
                        t: "MESSAGE_CREATE",
                        s: 4,
                        d: message("102", { channel_id: "2002", guild_id: undefined }),
                    });
                }
            });
        },
    );

    mocks.push(mock);

    const fake = fakeContext({ apiUrl: `${mock.url}/api` });
    const running = discord.run!(fake.context);

    await until(() => fake.events.length === 2);
    fake.controller.abort();
    await running;

    assert.equal(sent(mock.sockets, 2).length, 1);
    assert.deepEqual(sent(mock.sockets, 6)[0]!.d, { token: TOKEN, session_id: "S1", seq: 2 });
    assert.ok(mock.sockets[1]!.path.startsWith("/resume?v=10&encoding=json"));
    assert.deepEqual(
        fake.events.map((event) => [event.id, event.mentioned]),
        [
            ["101", false],
            ["102", true],
        ],
    );
    assert.equal(fake.events[1]!.url, "https://discord.com/channels/@me/2002/102");

    const state = fake.state() as { cursors: Record<string, { m: string }>; identifies: number[] };

    assert.equal(state.cursors[C1]!.m, "101");
    assert.equal(state.cursors["2002"]!.m, "102");
    assert.equal(state.identifies.length, 1);
});

test("a failed resume waits, identifies, and backfills from the cursor before live events", async () => {
    const requests: string[] = [];
    const mock: Mock = await mockServer(
        (request) => {
            requests.push(request.url ?? "");

            if (request.url === "/api/gateway/bot") {
                return { json: { url: mock.ws } };
            }

            if (request.url === `/api/channels/${C1}/messages?after=100&limit=100`) {
                // Discord answers newest first, without guild_id.
                return {
                    json: [
                        message("103", { guild_id: undefined }),
                        message("102", { guild_id: undefined }),
                    ],
                };
            }

            if (request.url === "/api/channels/1002") {
                return { json: { id: "1002", guild_id: G, type: 0, last_message_id: "500" } };
            }

            return { status: 404 };
        },
        (socket) => {
            hello(socket, 60_000);
            socket.onMessage((data) => {
                const packet = data as Packet;

                if (packet.op === 6) {
                    socket.send({ op: 9, d: false });
                }

                if (packet.op === 2) {
                    socket.send({
                        op: 0,
                        t: "READY",
                        s: 1,
                        d: { session_id: "S2", resume_gateway_url: mock.ws, user: { id: BOT } },
                    });
                    socket.send({ op: 0, t: "MESSAGE_CREATE", s: 2, d: message("104") });
                }
            });
        },
    );

    mocks.push(mock);

    const fake = fakeContext(
        { apiUrl: `${mock.url}/api`, channels: `${C1}, 1002` },
        {
            session: { id: "OLD", url: `${mock.ws}/resume`, seq: 7 },
            user: BOT,
            identifies: [Date.now() - 5000],
            cursors: { [C1]: { m: "100", g: G } },
        },
    );
    const running = discord.run!(fake.context);

    await until(() => fake.events.length === 3);
    fake.controller.abort();
    await running;

    assert.deepEqual(sent(mock.sockets, 6)[0]!.d, { token: TOKEN, session_id: "OLD", seq: 7 });
    assert.equal(sent(mock.sockets, 2).length, 1);
    // The identify waited for the 30 s gap since the saved identify.
    assert.ok(fake.waits.some((ms) => ms > 20_000));
    assert.ok(fake.statuses.some((line) => line.includes("to identify")));
    assert.deepEqual(
        fake.events.map((event) => event.id),
        ["102", "103", "104"],
    );
    assert.equal(fake.events[0]!.url, `https://discord.com/channels/${G}/${C1}/102`);
    assert.equal(fake.events[0]!.mentioned, false);

    const state = fake.state() as {
        session: { id: string };
        cursors: Record<string, { m: string }>;
        backfill?: boolean;
    };

    assert.equal(state.session.id, "S2");
    assert.equal(state.cursors[C1]!.m, "104");
    // A newly listed channel gets a baseline, not its history.
    assert.equal(state.cursors["1002"]!.m, "500");
    assert.equal(state.backfill, undefined);
    assert.ok(!requests.some((url) => url.includes("/channels/1002/messages")));
});

test("filters channels and DMs, marks bots and the bot itself, and sees mentions", async () => {
    const mock: Mock = await mockServer(
        (request) =>
            request.url === `/api/channels/${C1}`
                ? { json: { id: C1, guild_id: G, type: 0, last_message_id: "1" } }
                : { status: 404 },
        (socket) => {
            hello(socket, 60_000);
            socket.onMessage((data) => {
                if ((data as Packet).op !== 2) {
                    return;
                }

                const dispatches: [string, unknown][] = [
                    ["READY", { session_id: "S", resume_gateway_url: mock.ws, user: { id: BOT } }],
                    [
                        "GUILD_CREATE",
                        {
                            id: G,
                            channels: [{ id: C1, name: "general", type: 0 }],
                            threads: [{ id: "3003", name: "talk", type: 11, parent_id: C1 }],
                        },
                    ],
                    ["MESSAGE_CREATE", message("201", { author: { id: BOT, username: "pi" } })],
                    [
                        "MESSAGE_CREATE",
                        message("202", { author: { id: "8", username: "b", bot: true } }),
                    ],
                    ["MESSAGE_CREATE", message("203", { webhook_id: "77" })],
                    ["MESSAGE_CREATE", message("204", { channel_id: "9009" })],
                    ["MESSAGE_CREATE", message("205", { channel_id: "2002", guild_id: undefined })],
                    ["MESSAGE_CREATE", message("206", { type: 7 })],
                    [
                        "MESSAGE_CREATE",
                        message("207", {
                            content: `<@${BOT}> hello <@!${BOT}>`,
                            mentions: [{ id: BOT }],
                        }),
                    ],
                    [
                        "MESSAGE_CREATE",
                        message("208", {
                            author: { id: "7", username: "ann", global_name: null },
                            attachments: [
                                { filename: "a.png", content_type: "image/png", size: 12 },
                            ],
                        }),
                    ],
                    ["MESSAGE_CREATE", message("209", { channel_id: "3003" })],
                ];

                dispatches.forEach(([t, d], index) => socket.send({ op: 0, t, s: index + 1, d }));
            });
        },
    );

    mocks.push(mock);

    const fake = fakeContext({
        apiUrl: `${mock.url}/api`,
        gatewayUrl: mock.ws,
        channels: C1,
        directMessages: false,
    });
    const running = discord.run!(fake.context);

    await until(() => fake.events.some((event) => event.id === "209"));
    fake.controller.abort();
    await running;

    const byId = new Map(fake.events.map((event) => [event.id, event]));

    assert.deepEqual([...byId.keys()], ["201", "202", "203", "207", "208", "209"]);
    assert.deepEqual(
        ["201", "202", "203", "207"].map((id) => byId.get(id)!.author.bot),
        [true, true, true, false],
    );
    assert.equal(byId.get("207")!.mentioned, true);
    assert.equal(byId.get("207")!.text, "hello");
    assert.equal(byId.get("208")!.mentioned, false);
    assert.equal(byId.get("208")!.author.name, "ann");
    assert.deepEqual(byId.get("208")!.attachments, ["a.png (image/png, 12 bytes)"]);
    assert.equal(byId.get("209")!.channelName, "talk");
    assert.equal(byId.get("201")!.channelName, "general");

    const state = fake.state() as { cursors: Record<string, { m: string; p?: string }> };

    assert.equal(state.cursors[C1]!.m, "208");
    assert.deepEqual(state.cursors["3003"], { m: "209", g: G, p: C1 });
    assert.equal(state.cursors["2002"], undefined);
});

test("close 4004 is fatal and does not show the token", async () => {
    const mock: Mock = await mockServer(
        () => ({ status: 404 }),
        (socket) => {
            hello(socket, 60_000);
            socket.onMessage((data) => {
                if ((data as Packet).op === 2) {
                    socket.close(4004);
                }
            });
        },
    );

    mocks.push(mock);

    const fake = fakeContext({ gatewayUrl: mock.ws });

    await assert.rejects(discord.run!(fake.context), (error: unknown) => {
        assert.ok(error instanceof RelayError);
        assert.equal(error.fatal, true);
        assert.match(error.message, /4004/);
        assert.ok(!error.message.includes(TOKEN));

        return true;
    });
    assert.ok(fake.statuses.every((line) => !line.includes(TOKEN)));
});

test("a reply sends once per key, without mentions, as a reply to the event", async () => {
    const posts: { url: string; auth: string; body: Record<string, unknown> }[] = [];
    let limited = false;
    const mock: Mock = await mockServer((request, body) => {
        if (limited) {
            return { status: 429, json: { retry_after: 1.5 } };
        }

        posts.push({
            url: request.url ?? "",
            auth: String(request.headers.authorization),
            body: JSON.parse(body) as Record<string, unknown>,
        });

        return { json: { id: "999" } };
    });

    mocks.push(mock);

    const context = {
        values: { token: TOKEN, apiUrl: `${mock.url}/api`, replyChannel: "4004" },
        signal: new AbortController().signal,
        log: () => {},
    };
    const to: RelayEvent = { id: "101", text: "hi", author: { id: "7", name: "Ann" }, channel: C1 };
    const long = "x".repeat(2500);

    assert.deepEqual(await discord.reply!(context, { text: long, to, key: "k1" }), { id: "999" });
    await discord.reply!(context, { text: "again", to, key: "k1" });
    await discord.reply!(context, { text: "plain", key: "k2" });

    const [first, again, plain] = posts;

    assert.equal(first!.url, `/api/channels/${C1}/messages`);
    assert.equal(first!.auth, `Bot ${TOKEN}`);
    assert.equal((first!.body.content as string).length, 2000);
    assert.deepEqual(first!.body.allowed_mentions, { parse: [], replied_user: false });
    assert.deepEqual(first!.body.message_reference, {
        message_id: "101",
        fail_if_not_exists: false,
    });
    assert.equal(first!.body.enforce_nonce, true);
    assert.ok((first!.body.nonce as string).length <= 25);
    assert.equal(again!.body.nonce, first!.body.nonce);
    assert.notEqual(plain!.body.nonce, first!.body.nonce);
    assert.equal(plain!.url, "/api/channels/4004/messages");
    assert.equal(plain!.body.message_reference, undefined);

    limited = true;
    await assert.rejects(
        discord.reply!(context, { text: "x", to, key: "k3" }),
        (error: unknown) => {
            assert.ok(error instanceof RelayError);
            assert.equal(error.retryAfter, 1500);

            return true;
        },
    );
});

test("a stop closes with 4000, keeps the session, and leaves no timer", async () => {
    const mock: Mock = await mockServer(
        () => ({ status: 404 }),
        (socket) => {
            hello(socket, 60_000);
            socket.onMessage((data) => {
                if ((data as Packet).op === 2) {
                    socket.send({
                        op: 0,
                        t: "READY",
                        s: 1,
                        d: { session_id: "S", resume_gateway_url: mock.ws, user: { id: BOT } },
                    });
                }
            });
        },
    );

    mocks.push(mock);

    const fake = fakeContext({ gatewayUrl: mock.ws });
    const running = discord.run!(fake.context);

    await until(() => fake.statuses.some((line) => line.startsWith("Connected")));
    closes.length = 0;
    fake.controller.abort();
    await running;
    await mock.sockets[0]!.closed;

    assert.deepEqual(closes, [4000]);
    assert.deepEqual((fake.state() as { session: unknown }).session, {
        id: "S",
        url: mock.ws,
        seq: 1,
    });
    assert.ok(!process.getActiveResourcesInfo().includes("Timeout"));
});

test(
    "a dead connection: a missed ACK resumes, and a stop ends run()",
    { timeout: 5000 },
    async () => {
        const mock: Mock = await mockServer(
            () => ({ status: 404 }),
            (socket) => {
                // No socket answers a close frame, and the first one never ACKs a heartbeat.
                socket.ignoreClose();
                hello(socket, mock.sockets.length === 1 ? 30 : 60_000);
                socket.onMessage((data) => {
                    const op = (data as Packet).op;
                    const d = { session_id: "S", resume_gateway_url: mock.ws, user: { id: BOT } };

                    if (op === 2 || op === 6) {
                        socket.send({ op: 0, t: op === 2 ? "READY" : "RESUMED", s: 1, d });
                    }
                });
            },
        );

        mocks.push(mock);

        const fake = fakeContext({ gatewayUrl: mock.ws });
        const running = discord.run!(fake.context);

        await until(() => sent(mock.sockets, 6).length === 1, 800);
        const stopped = Date.now();

        fake.controller.abort();
        await running;
        assert.ok(Date.now() - stopped < 1000, "a stop does not wait for the dead socket");
        mock.sockets.forEach((socket) => socket.close());
    },
);
