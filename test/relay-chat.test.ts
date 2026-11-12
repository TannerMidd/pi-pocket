import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import telegram from "../src/server/extensions/pocket-relay/connectors/telegram.ts";
import slack from "../src/server/extensions/pocket-relay/connectors/slack.ts";
import matrix from "../src/server/extensions/pocket-relay/connectors/matrix.ts";
import {
    RelayError,
    type RelayContext,
    type RelayEvent,
    type RelayValues,
} from "../src/server/extensions/pocket-relay/types.ts";
import { mockServer } from "./relay-ws-mock.ts";

function context(values: RelayValues, state: Record<string, unknown> = {}) {
    const controller = new AbortController();
    const events: RelayEvent[] = [];
    const saves: Record<string, unknown>[] = [];
    const context: RelayContext = {
        values,
        get state() {
            return state;
        },
        signal: controller.signal,
        save(next) {
            state = next;
            saves.push(next);
        },
        async emit(batch) {
            events.push(...batch);
        },
        status() {},
        log() {},
        async sleep() {
            controller.signal.throwIfAborted();
        },
    };

    return { context, controller, events, saves };
}

function cleanup(t: TestContext, mock: Awaited<ReturnType<typeof mockServer>>) {
    t.after(async () => {
        for (const socket of mock.sockets) {
            socket.close();
        }

        mock.server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
            mock.server.close((error) => (error ? reject(error) : resolve()));
        });
    });
}

const fatal = (error: unknown) => error instanceof RelayError && error.fatal;
const rate = (ms: number) => (error: unknown) =>
    error instanceof RelayError && error.retryAfter === ms;

test(
    "Telegram baselines, resumes after emit, filters chats, and identifies mentions and bots",
    { timeout: 3000 },
    async (t) => {
        const offsets: string[] = [];
        const message = (id: number, chat = 10, extra = {}) => ({
            message_id: id,
            chat: { id: chat, type: "group" },
            from: { id: 2, username: "writer" },
            text: "Hi @RelayBot",
            entities: [{ type: "mention", offset: 3, length: 9 }],
            ...extra,
        });
        const mock = await mockServer((request) => {
            const url = new URL(request.url!, "http://mock");

            if (url.pathname.endsWith("getMe")) {
                return { json: { ok: true, result: { id: 1, username: "RelayBot" } } };
            }

            offsets.push(url.searchParams.get("offset")!);

            if (offsets.length === 1) {
                return { json: { ok: true, result: [{ update_id: 20, message: message(1) }] } };
            }

            assert.equal(url.searchParams.get("timeout"), "25");
            assert.equal(url.searchParams.get("allowed_updates"), '["message"]');

            return {
                json: {
                    ok: true,
                    result: [
                        { update_id: 21, message: message(2) },
                        { update_id: 22, message: message(3, 99) },
                        {
                            update_id: 23,
                            message: message(4, 10, {
                                text: "direct",
                                entities: [],
                                chat: { id: 10, type: "private" },
                            }),
                        },
                        {
                            update_id: 24,
                            message: message(5, 10, {
                                text: "answer",
                                entities: [],
                                reply_to_message: { from: { id: 1 } },
                            }),
                        },
                        {
                            update_id: 25,
                            message: message(6, 10, {
                                text: "ordinary",
                                entities: [],
                                from: { id: 1, is_bot: true },
                            }),
                        },
                    ],
                },
            };
        });

        cleanup(t, mock);

        const first = context({ apiUrl: mock.url, token: "fake", chats: "10" });
        const saveFirst = first.context.save;

        first.context.save = (state) => {
            saveFirst(state);
            first.controller.abort();
        };

        await telegram.run!(first.context);
        assert.deepEqual(first.events, []);
        assert.deepEqual(first.saves, [{ offset: 21 }]);

        const resumed = context(first.context.values, first.context.state);
        const saveResume = resumed.context.save;

        resumed.context.save = (state) => {
            assert.equal(resumed.events.length, 4);
            saveResume(state);
            resumed.controller.abort();
        };

        await telegram.run!(resumed.context);
        assert.deepEqual(offsets, ["-1", "21"]);
        assert.deepEqual(resumed.saves, [{ offset: 26 }]);
        assert.equal(resumed.events[0]!.id, "10:2");
        assert.equal(resumed.events[0]!.text, "Hi");
        assert.deepEqual(
            resumed.events.map((event) => event.mentioned),
            [true, true, true, false],
        );
        assert.equal(resumed.events[3]!.author.bot, true);
    },
);

test("Telegram replies use reply parameters and disable previews", { timeout: 3000 }, async (t) => {
    const mock = await mockServer((request, body) => {
        assert.equal(request.method, "POST");
        assert.deepEqual(JSON.parse(body), {
            chat_id: "10",
            text: "x".repeat(4096),
            reply_parameters: { message_id: 42, allow_sending_without_reply: true },
            link_preview_options: { is_disabled: true },
        });

        return { json: { ok: true, result: { message_id: 43 } } };
    });

    cleanup(t, mock);

    const fake = context({ apiUrl: mock.url, token: "fake", replyChat: "default" });
    const result = await telegram.reply!(fake.context, {
        text: "x".repeat(4200),
        key: "reply",
        channel: "ignored",
        to: { id: "10:42", channel: "10", text: "", author: { id: "u", name: "u" } },
    });

    assert.deepEqual(result, { id: "10:43" });
});

test(
    "Telegram auth, polling conflicts, rate limits, and transport errors never expose tokens",
    { timeout: 3000 },
    async (t) => {
        let status = 401;
        const mock = await mockServer(() => ({ status, json: { parameters: { retry_after: 3 } } }));

        cleanup(t, mock);

        const fake = context({ apiUrl: mock.url, token: "SECRET" });

        await assert.rejects(telegram.run!(fake.context), fatal);
        status = 409;
        await assert.rejects(
            telegram.run!(fake.context),
            (error: unknown) =>
                fatal(error) && error instanceof Error && /webhook/.test(error.message),
        );
        status = 429;
        await assert.rejects(telegram.run!(fake.context), rate(3000));
        await assert.rejects(
            telegram.run!(context({ apiUrl: "http://[", token: "SECRET" }).context),
            (error: unknown) => error instanceof Error && !error.message.includes("SECRET"),
        );
    },
);

test(
    "Matrix baselines, resumes, filters rooms, and preserves thread and mention data",
    { timeout: 3000 },
    async (t) => {
        const cursors: (string | null)[] = [];
        const event = (id: string, content = {}, sender = "@person:local") => ({
            type: "m.room.message",
            event_id: id,
            sender,
            content: { msgtype: "m.text", body: "hi", ...content },
        });
        const mock = await mockServer((request) => {
            const url = new URL(request.url!, "http://mock");

            assert.equal(request.headers.authorization, "Bearer fake");

            if (url.pathname.endsWith("whoami")) {
                return { json: { user_id: "@relay:local" } };
            }

            cursors.push(url.searchParams.get("since"));

            if (cursors.length === 1) {
                assert.equal(url.searchParams.get("timeout"), "0");
                assert.deepEqual(JSON.parse(url.searchParams.get("filter")!), {
                    room: { timeline: { limit: 1 } },
                });

                return {
                    json: {
                        next_batch: "baseline",
                        rooms: {
                            join: { "!room:local": { timeline: { events: [event("$old")] } } },
                        },
                    },
                };
            }

            assert.equal(url.searchParams.get("timeout"), "25000");

            return {
                json: {
                    next_batch: "next",
                    rooms: {
                        join: {
                            "!room:local": {
                                timeline: {
                                    events: [
                                        event("$new", {
                                            body: "hello @relay:local",
                                            "m.relates_to": {
                                                rel_type: "m.thread",
                                                event_id: "$root",
                                            },
                                        }),
                                        event("$mention", {
                                            "m.mentions": { user_ids: ["@relay:local"] },
                                        }),
                                        event("$own", {}, "@relay:local"),
                                        { type: "m.room.member", event_id: "$member" },
                                    ],
                                },
                            },
                            "!other:local": { timeline: { events: [event("$ignored")] } },
                        },
                    },
                },
            };
        });

        cleanup(t, mock);

        const first = context({ homeserver: mock.url, token: "fake", rooms: "!room:local" });
        const saveFirst = first.context.save;

        first.context.save = (state) => {
            saveFirst(state);
            first.controller.abort();
        };

        await matrix.run!(first.context);
        assert.deepEqual(first.events, []);
        assert.deepEqual(first.saves, [{ since: "baseline" }]);

        const resumed = context(first.context.values, first.context.state);
        const saveResume = resumed.context.save;

        resumed.context.save = (state) => {
            assert.equal(resumed.events.length, 3);
            saveResume(state);
            resumed.controller.abort();
        };

        await matrix.run!(resumed.context);
        assert.deepEqual(cursors, [null, "baseline"]);
        assert.deepEqual(resumed.saves, [{ since: "next" }]);
        assert.equal(resumed.events[0]!.id, "$new");
        assert.equal(resumed.events[0]!.thread, "$root");
        assert.equal(resumed.events[0]!.text, "hello");
        assert.deepEqual(
            resumed.events.map((item) => item.mentioned),
            [true, true, false],
        );
        assert.equal(resumed.events[2]!.author.bot, true);
    },
);

test(
    "Matrix replies use stable transaction IDs and suppress notification mentions",
    { timeout: 3000 },
    async (t) => {
        const paths: string[] = [];
        const mock = await mockServer((request, body) => {
            paths.push(request.url!);
            assert.equal(request.method, "PUT");
            assert.match(request.url!, /rooms\/!room%3Alocal\/send\/m.room.message\/[a-f0-9]{64}$/);
            assert.deepEqual(JSON.parse(body), {
                msgtype: "m.text",
                body: "answer",
                "m.mentions": {},
                "m.relates_to": {
                    "m.in_reply_to": { event_id: "$event" },
                    rel_type: "m.thread",
                    event_id: "$root",
                    is_falling_back: true,
                },
            });

            return { json: { event_id: "$sent" } };
        });

        cleanup(t, mock);

        const fake = context({ homeserver: mock.url, token: "fake" });
        const reply = {
            text: "answer",
            key: "stable",
            to: {
                id: "$event",
                channel: "!room:local",
                thread: "$root",
                text: "",
                author: { id: "u", name: "u" },
            },
        };

        assert.deepEqual(await matrix.reply!(fake.context, reply), { id: "$sent" });
        await matrix.reply!(fake.context, reply);
        assert.equal(paths[0], paths[1]);
    },
);

test("Matrix maps token and rate-limit errors", { timeout: 3000 }, async (t) => {
    let status = 403;
    const mock = await mockServer(() => ({
        status,
        json:
            status === 403
                ? { errcode: "M_UNKNOWN_TOKEN" }
                : { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 456 },
    }));

    cleanup(t, mock);

    const fake = context({ homeserver: mock.url, token: "fake" });

    await assert.rejects(matrix.run!(fake.context), fatal);
    status = 429;
    await assert.rejects(matrix.run!(fake.context), rate(456));
});

test(
    "Slack acknowledges every envelope, filters, reconnects, and closes on stop",
    { timeout: 3000 },
    async (t) => {
        let connections = 0;
        let fake: ReturnType<typeof context>;
        const mock = await mockServer(
            (request) => {
                if (request.url!.endsWith("auth.test")) {
                    assert.equal(request.headers.authorization, "Bearer xoxb-fake");

                    return { json: { ok: true, user_id: "BOT" } };
                }

                assert.equal(request.headers.authorization, "Bearer xapp-fake");
                connections++;

                return { json: { ok: true, url: `${mock.ws}/socket` } };
            },
            (socket) => {
                const index = connections;
                const send = (id: string, event: Record<string, unknown>) =>
                    socket.send({ type: "events_api", envelope_id: id, payload: { event } });

                socket.onMessage((data) => {
                    const id = (data as { envelope_id: string }).envelope_id;

                    if (id === "disconnect") {
                        return;
                    }

                    if (id === "last") {
                        socket.send({ type: "disconnect", envelope_id: "disconnect" });
                    }

                    if (id === "resumed") {
                        fake.controller.abort();
                    }
                });
                socket.send({ type: "hello" });

                if (index === 1) {
                    const base = {
                        type: "message",
                        channel: "C",
                        ts: "123.1",
                        user: "U",
                        text: "hello <@BOT>",
                    };

                    send("message", base);
                    send("duplicate", { ...base, type: "app_mention" });
                    send("filtered", { ...base, channel: "OTHER" });
                    send("subtype", { ...base, subtype: "message_changed" });
                    send("bot", { ...base, bot_id: "B" });
                    send("thread", {
                        ...base,
                        ts: "123.2",
                        thread_ts: "100.1",
                        subtype: "thread_broadcast",
                        text: "normal",
                    });
                    send("last", { ...base, ts: "123.3", text: "dm", channel_type: "im" });
                } else {
                    socket.send({ type: "hello", envelope_id: "resumed" });
                }
            },
        );

        cleanup(t, mock);
        fake = context({
            apiUrl: mock.url,
            appToken: "xapp-fake",
            botToken: "xoxb-fake",
            channels: "C",
        });
        await slack.run!(fake.context);
        await Promise.all(mock.sockets.map((socket) => socket.closed));
        assert.equal(connections, 2);
        assert.deepEqual(fake.saves, [{}]);
        assert.equal(fake.events.length, 4);
        assert.equal(fake.events[0]!.id, fake.events[1]!.id);
        assert.equal(fake.events[0]!.text, "hello");
        assert.deepEqual(
            fake.events.map((event) => event.mentioned),
            [true, true, false, true],
        );
        assert.equal(fake.events[2]!.thread, "100.1");
        // Every envelope is acknowledged; one with an event only after the relay stored it, so filtered ones go first.
        const acks = (mock.sockets[0]!.received as { envelope_id: string }[]).map(
            (ack) => ack.envelope_id,
        );

        assert.deepEqual(
            [...acks].sort(),
            [
                "message",
                "duplicate",
                "filtered",
                "subtype",
                "bot",
                "thread",
                "last",
                "disconnect",
            ].sort(),
        );
        assert.ok(acks.indexOf("filtered") < acks.indexOf("message"));
    },
);

test("Slack replies set thread, limits, and parsing options", { timeout: 3000 }, async (t) => {
    const mock = await mockServer((request, body) => {
        assert.equal(request.url, "/chat.postMessage");
        assert.deepEqual(JSON.parse(body), {
            channel: "C",
            text: "x".repeat(4000),
            thread_ts: "100.1",
            unfurl_links: false,
            parse: "none",
        });

        return { json: { ok: true, ts: "123.4" } };
    });

    cleanup(t, mock);

    const fake = context({ apiUrl: mock.url, botToken: "xoxb-fake", replyChannel: "default" });

    assert.deepEqual(
        await slack.reply!(fake.context, {
            text: "x".repeat(4100),
            key: "reply",
            channel: "ignored",
            to: {
                id: "C:123.1",
                channel: "C",
                thread: "100.1",
                text: "",
                author: { id: "U", name: "U" },
            },
        }),
        { id: "C:123.4" },
    );
});

test(
    "Slack maps fatal authentication and scope errors and Retry-After",
    { timeout: 3000 },
    async (t) => {
        let error = "invalid_auth";
        const mock = await mockServer(() => ({
            status: error === "ratelimited" ? 429 : 200,
            headers: { "retry-after": "7" },
            json: { ok: false, error },
        }));

        cleanup(t, mock);

        const fake = context({ apiUrl: mock.url, botToken: "xoxb-fake" });

        for (error of ["invalid_auth", "not_authed", "missing_scope"]) {
            await assert.rejects(slack.run!(fake.context), fatal);
        }

        error = "ratelimited";
        await assert.rejects(slack.run!(fake.context), rate(7000));
    },
);

for (const connector of [telegram, matrix]) {
    test(`${connector.label} abort stops an active long poll`, { timeout: 3000 }, async (t) => {
        let entered: () => void = () => {};

        const polling = new Promise<void>((resolve) => {
            entered = resolve;
        });

        let release: () => void = () => {};

        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const mock = await mockServer(async (request) => {
            if (request.url!.includes("getMe")) {
                return { json: { ok: true, result: { id: 1 } } };
            }

            if (request.url!.includes("whoami")) {
                return { json: { user_id: "@relay:local" } };
            }

            entered();
            await held;

            return { json: {} };
        });

        cleanup(t, mock);

        const fake = context(
            { apiUrl: mock.url, homeserver: mock.url, token: "fake" },
            { offset: 1, since: "old" },
        );
        const running = connector.run!(fake.context);
        const settled = running.catch(() => {});

        await polling;
        fake.controller.abort();
        await settled;
        release();
        assert.deepEqual(fake.saves, []);
    });
}
