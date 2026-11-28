import assert from "node:assert/strict";
import test from "node:test";
import discord from "../src/server/extensions/pocket-relay/connectors/discord.ts";
import http from "../src/server/extensions/pocket-relay/connectors/http.ts";
import rss from "../src/server/extensions/pocket-relay/connectors/rss.ts";
import slack from "../src/server/extensions/pocket-relay/connectors/slack.ts";
import telegram from "../src/server/extensions/pocket-relay/connectors/telegram.ts";
import type { RelayContext } from "../src/server/extensions/pocket-relay/types.ts";

const file = { name: "sample.txt", type: "text/plain", data: Uint8Array.of(1) };
const reply = { text: "sample", key: "sample", confirmDestination: true };

function fixture() {
    const ctrl = new AbortController();
    const saves: unknown[] = [];
    const events: unknown[] = [];
    const context: RelayContext = {
        values: {
            url: "https://example.invalid",
            replyUrl: "https://example.invalid/reply",
            replyChannel: "C23",
            replyChat: "@alias",
        },
        signal: ctrl.signal,
        state: { started: true, seen: [] },
        log() {},
        status() {},
        async sleep() {},
        save(state) {
            saves.push(state);
        },
        async emit(batch) {
            events.push(...batch);
        },
    };

    return { ctrl, context, saves, events };
}

test("Stopped adapters do not start a request", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected request"));
    const { ctrl, context } = fixture();

    ctrl.abort();

    for (const adapter of [slack, telegram, http, rss]) {
        await (adapter.run ?? adapter.poll)!(context).catch(() => {});
        await adapter.reply?.(context, reply).catch(() => {});
    }

    assert.equal(fetch.mock.callCount(), 0);
});

test("A late Slack connection response does not open a socket", async (t) => {
    const { ctrl, context } = fixture();
    const socket = t.mock.method(globalThis, "WebSocket", class {});

    t.mock.method(globalThis, "fetch", async (url: string) => {
        if (url.endsWith("auth.test")) {
            return Response.json({ ok: true, user_id: "sample" });
        }

        ctrl.abort();

        return Response.json({ ok: true, url: "wss://example.invalid" });
    });
    await slack.run!(context).catch(() => {});
    assert.equal(socket.mock.callCount(), 0);
});

test(
    "Slack closes during a pending emit without acknowledging or reconnecting",
    { timeout: 2000 },
    async (t) => {
        const { ctrl, context } = fixture();
        let sent = 0;
        let closed = false;
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const socket = t.mock.method(
            globalThis,
            "WebSocket",
            class extends EventTarget {
                readyState = 1;
                constructor() {
                    super();
                    queueMicrotask(() =>
                        this.dispatchEvent(
                            new MessageEvent("message", {
                                data: JSON.stringify({
                                    type: "events_api",
                                    envelope_id: "ack",
                                    payload: {
                                        event: {
                                            type: "message",
                                            channel: "C",
                                            ts: "2",
                                            user: "U",
                                            text: "fixture",
                                        },
                                    },
                                }),
                            }),
                        ),
                    );
                }
                send = () => {
                    sent++;
                };
                close = () => {
                    closed = true;
                };
            },
        );
        const fetch = t.mock.method(globalThis, "fetch", async (url: string) =>
            Response.json(
                url.endsWith("auth.test")
                    ? { ok: true, user_id: "test" }
                    : { ok: true, url: "wss://example.invalid" },
            ),
        );

        context.emit = async () => {
            entered();
            await held;
        };

        const running = slack.run!(context);

        await started;
        ctrl.abort();
        await running;
        release();
        await Promise.resolve();
        assert.equal(closed, true);
        assert.equal(sent, 0);
        assert.equal(socket.mock.callCount(), 1);
        assert.equal(fetch.mock.callCount(), 2);
    },
);

test("Slack does not confirm an incomplete file batch", async (t) => {
    const { context } = fixture();
    let files = 0;

    t.mock.method(globalThis, "fetch", async (url: string) => {
        if (url.endsWith("files.getUploadURLExternal")) {
            return Response.json({
                ok: true,
                file_id: String(++files),
                upload_url: "https://files.slack.com/fixture",
            });
        }

        if (url.endsWith("completeUploadExternal")) {
            return Response.json({ ok: true, files: [{ id: "1" }] });
        }

        return new Response();
    });
    await assert.rejects(
        slack.reply!(context, { ...reply, files: [file, file] }),
        /confirm every file/,
    );
});

test("HTTP and RSS do not emit or advance a cursor after cancellation", async (t) => {
    for (const [adapter, response] of [
        [http, Response.json([{ id: "new", text: "sample" }])],
        [rss, new Response("<rss><item><guid>new</guid><title>sample</title></item></rss>")],
    ] as const) {
        const { ctrl, context, saves, events } = fixture();
        const fetch = t.mock.method(globalThis, "fetch", async () => {
            ctrl.abort();

            return response;
        });

        await adapter.poll!(context).catch(() => {});
        assert.equal(fetch.mock.callCount(), 1);
        assert.deepEqual([saves, events], [[], []]);
        fetch.mock.restore();
    }
});

test("Slack confirms the configured channel, thread and escaped text", async (t) => {
    const { context } = fixture();
    const message = { ...reply, thread: "20.2", text: "<sample>" };
    let result = {
        ok: true,
        ts: "21.3",
        channel: "C23",
        message: { thread_ts: "20.2", text: "&lt;sample&gt;" },
    };

    t.mock.method(globalThis, "fetch", async () => Response.json(result));
    assert.deepEqual(await slack.reply!(context, message), {
        channel: "C23",
        thread: "20.2",
        id: "C23:21.3",
    });
    result = { ...result, channel: "C24" };
    assert.deepEqual(await slack.reply!(context, message), {});
    result = { ...result, channel: "C23", message: { ...result.message, text: "short" } };
    assert.deepEqual(await slack.reply!(context, message), {});
});

test("Telegram confirms all parts in the same chat and topic", async (t) => {
    const { context } = fixture();
    let id = 0;
    let chat = -12;
    const fetch = t.mock.method(globalThis, "fetch", async () =>
        Response.json({
            ok: true,
            result: {
                chat: { id: chat, username: "Alias" },
                document: { file_id: "fixture" },
                caption: id % 2 === 0 ? reply.text : undefined,
                message_id: ++id,
                message_thread_id: 7,
                is_topic_message: true,
            },
        }),
    );
    const message = { ...reply, thread: "7", files: [file, file] };

    assert.deepEqual(await telegram.reply!(context, message), {
        id: "-12:1",
        channel: "-12",
        thread: "7",
    });
    assert.equal(fetch.mock.callCount(), 2);
    fetch.mock.mockImplementationOnce(async () => {
        chat = -13;

        return Response.json({
            ok: true,
            result: {
                chat: { id: -12, username: "alias" },
                document: { file_id: "fixture" },
                caption: reply.text,
                message_id: ++id,
                is_topic_message: true,
                message_thread_id: 7,
            },
        });
    });
    await assert.rejects(telegram.reply!(context, message), /different destinations/);
});

test("Telegram sends each later part to the numeric chat and topic in the first receipt", async (t) => {
    const { context } = fixture();

    for (const [confirmDestination, text] of [
        [true, "card"],
        [false, "a".repeat(1025)],
    ] as const) {
        const sent: { method: string; chat: string; topic: string }[] = [];
        const fetch = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
            const form = init.body instanceof FormData ? init.body : undefined;
            const message = form
                ? Object.fromEntries(form)
                : (JSON.parse(String(init.body)) as Record<string, unknown>);
            const first = sent.length === 0;

            sent.push({
                method: url.split("/").at(-1)!,
                chat: String(message.chat_id),
                topic: String(message.message_thread_id),
            });

            return Response.json({
                ok: true,
                result: {
                    chat: { id: -12, ...(first ? { username: "alias" } : {}) },
                    message_thread_id: 7,
                    is_topic_message: true,
                    message_id: sent.length,
                    ...(form
                        ? { document: { file_id: "fixture" }, caption: message.caption }
                        : { text }),
                },
            });
        });
        const receipt = await telegram.reply!(context, {
            ...reply,
            confirmDestination,
            text,
            thread: "7",
            files: [file, file],
        });
        const methods = [
            ...(text.length > 1024 ? ["sendMessage"] : []),
            "sendDocument",
            "sendDocument",
        ];

        assert.deepEqual(
            sent,
            methods.map((method, i) => ({ method, chat: i === 0 ? "@alias" : "-12", topic: "7" })),
        );
        assert.deepEqual(
            receipt,
            confirmDestination ? { id: "-12:1", channel: "-12", thread: "7" } : { id: "-12:1" },
        );
        fetch.mock.restore();
    }
});

test("Discord confirms a multipart card when every upload has a matching attachment", async (t) => {
    const { context } = fixture();
    const files = [file, { ...file, data: Uint8Array.of(2, 3) }];

    const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
        const body = init.body;

        assert.ok(body instanceof FormData);

        const payload = JSON.parse(String(body.get("payload_json"))) as { content: string };
        const attachments = files.map((file, i) => {
            const upload = body.get(`files[${i}]`);

            assert.ok(upload instanceof File);
            assert.equal(upload.name, file.name);
            assert.equal(upload.size, file.data.byteLength);

            return { id: String(51 + i), filename: upload.name, size: upload.size };
        });

        return Response.json({
            id: "42",
            channel_id: "24",
            content: payload.content,
            attachments: attachments.reverse(),
        });
    });
    const receipt = await discord.reply!(
        { ...context, values: { token: "fixture" } },
        { ...reply, channel: "24", files },
    );

    assert.deepEqual(receipt, { id: "42", channel: "24" });
    assert.equal(fetch.mock.callCount(), 1);
});

test("Telegram stops a multipart send on error or cancellation", async (t) => {
    for (const abort of [true, false]) {
        const { context, ctrl } = fixture();
        let count = 0;
        const fetch = t.mock.method(globalThis, "fetch", async () => {
            count += 1;

            if (count === 1 && abort) {
                ctrl.abort();
            }

            if (count === 2) {
                return Response.json({ ok: false }, { status: 500 });
            }

            return Response.json({
                ok: true,
                result: {
                    chat: { id: -12, username: "alias" },
                    document: { file_id: "f" },
                    caption: reply.text,
                    message_id: 1,
                },
            });
        });

        await assert.rejects(telegram.reply!(context, { ...reply, files: [file, file, file] }));
        assert.equal(count, abort ? 1 : 2);
        fetch.mock.restore();
    }
});

test("Telegram rejects mismatched aliases, text and captions as proof", async (t) => {
    const { context } = fixture();
    const message = {
        chat: { id: -23, username: "alias" },
        message_id: 2,
        document: { file_id: "f" },
    };
    let result = { ...message, text: "cut", caption: "cut" };

    t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, result }));
    assert.deepEqual(await telegram.reply!(context, reply), {});
    assert.deepEqual(await telegram.reply!(context, { ...reply, files: [file] }), {});
    result = { ...result, text: reply.text, chat: { ...message.chat, username: "other" } };
    assert.deepEqual(await telegram.reply!(context, reply), {});
});

test("Confirmed chat sends reject over-limit text before uploading files", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected upload"));
    const { context } = fixture();

    for (const adapter of [slack, telegram]) {
        await assert.rejects(
            adapter.reply!(context, { ...reply, text: "a".repeat(4097), files: [file] }),
            /limit/,
        );
    }

    assert.equal(fetch.mock.callCount(), 0);
});

test("An HTTP request template supplies no confirmed chat destination", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
        Response.json({ id: 11, channel: "unverified" }),
    );
    assert.deepEqual(await http.reply!(fixture().context, { ...reply, channel: "requested" }), {
        id: "11",
    });
});
