import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import matrix from "../src/server/extensions/pocket-relay/connectors/matrix.ts";
import slack from "../src/server/extensions/pocket-relay/connectors/slack.ts";
import telegram from "../src/server/extensions/pocket-relay/connectors/telegram.ts";
import type {
    RelayContext,
    RelayEvent,
    RelayValues,
} from "../src/server/extensions/pocket-relay/types.ts";
import { mockServer } from "./relay-ws-mock.ts";

type Answer = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

const png = { name: "a.png", type: "image/png", data: new TextEncoder().encode("PNG1") };
const pdf = { name: "b.pdf", type: "application/pdf", data: new TextEncoder().encode("PDF1") };

function context(values: RelayValues, state: Record<string, unknown>) {
    const controller = new AbortController();
    const events: RelayEvent[] = [];
    const made: RelayContext = {
        values,
        state,
        signal: controller.signal,
        save() {},
        async emit(batch) {
            events.push(...batch);

            if (events.length > 0) {
                controller.abort();
            }
        },
        status() {},
        log() {},
        async sleep() {
            controller.signal.throwIfAborted();
        },
    };

    return { context: made, controller, events };
}

async function serve(t: TestContext, ...args: Parameters<typeof mockServer>) {
    const mock = await mockServer(...args);

    t.after(() => {
        mock.sockets.forEach((socket) => socket.close());
        mock.server.closeAllConnections();
        mock.server.close();
    });

    return mock;
}

const noLink = (secret: string) => (error: Error) => {
    assert.ok(!error.message.includes(secret), error.message);
    assert.ok(!/https?:\/\//.test(error.message), error.message);

    return true;
};

test(
    "Telegram: a photo comes in and is fetched, the token never shows, and files go out as replies",
    { timeout: 5000 },
    async (t) => {
        const TOKEN = "123456:secret-telegram-token";
        let refusePhoto = false;
        const calls: { path: string; body: string; type: string }[] = [];
        const mock = await serve(t, (request, body): Answer => {
            const url = new URL(request.url!, "http://mock");

            calls.push({ path: url.pathname, body, type: String(request.headers["content-type"]) });

            switch (url.pathname.replace(`bot${TOKEN}`, "BOT")) {
                case "/BOT/getMe":
                    return { json: { ok: true, result: { id: 1, username: "RelayBot" } } };
                case "/BOT/getUpdates":
                    return {
                        json: {
                            ok: true,
                            result: [
                                {
                                    update_id: 5,
                                    message: {
                                        message_id: 7,
                                        chat: { id: 10, type: "private" },
                                        from: { id: 2, username: "ann" },
                                        caption: "look",
                                        photo: [
                                            { file_id: "small", file_size: 4 },
                                            { file_id: "big", file_size: 4 },
                                        ],
                                        // A GIF is both: it is listed once.
                                        animation: { file_id: "gif", file_name: "a.gif" },
                                        document: { file_id: "gif", file_name: "a.gif" },
                                    },
                                },
                            ],
                        },
                    };

                case "/BOT/getFile": {
                    const id = url.searchParams.get("file_id");

                    return {
                        json: {
                            ok: true,
                            result:
                                id === "huge"
                                    ? { file_path: "photos/h.jpg", file_size: 30 * 1048576 }
                                    : {
                                          file_path:
                                              id === "moved" ? "photos/m.jpg" : "photos/b.jpg",
                                      },
                        },
                    };
                }

                case "/file/BOT/photos/b.jpg":
                    return {
                        text: "JPEG",
                        headers: { "content-type": "application/octet-stream" },
                    };
                case "/file/BOT/photos/m.jpg":
                    return { status: 302, headers: { location: `${mock.url}/elsewhere` } };
                case "/BOT/sendPhoto":
                    return refusePhoto
                        ? { status: 400, json: { ok: false, error_code: 400 } }
                        : { json: { ok: true, result: { message_id: calls.length } } };
                case "/BOT/sendDocument":
                case "/BOT/sendMessage":
                    return { json: { ok: true, result: { message_id: calls.length } } };
                default:
                    return { status: 404, json: { ok: false } };
            }
        });
        const values = { apiUrl: mock.url, token: TOKEN };
        const run = context(values, { offset: 5 });

        await telegram.run!(run.context);

        const [event] = run.events;

        assert.deepEqual(
            event!.files?.map((file) => file.ref),
            ["big", "gif"],
        );

        const live = { ...run.context, signal: new AbortController().signal };
        const got = await telegram.fetch!(live, event!.files![0]!, 25 * 1048576);

        assert.equal(new TextDecoder().decode(got.data), "JPEG");
        assert.equal(got.type, undefined, "the message's own type wins over octet-stream");

        // Past Telegram's 20 MB download limit, or a redirect: refused, with no token or link.

        for (const file of [
            { name: "h.jpg", ref: "x", size: 21 * 1048576 },
            { name: "h.jpg", ref: "huge" },
            { name: "m.jpg", ref: "moved" },
        ]) {
            await assert.rejects(telegram.fetch!(live, file, 25 * 1048576), noLink(TOKEN));
        }

        assert.ok(!calls.some((call) => call.path.includes("elsewhere")));

        // A short text is the photo's caption; a long one goes first, then the file as a document.
        calls.length = 0;
        await telegram.reply!(live, { text: "here", key: "k1", to: event, files: [png] });
        assert.deepEqual(
            calls.map((call) => call.path.split("/").at(-1)),
            ["sendPhoto"],
        );
        assert.match(calls[0]!.type, /^multipart\/form-data/);
        assert.match(calls[0]!.body, /name="caption"\r\n\r\nhere\r\n/);
        assert.match(calls[0]!.body, /"message_id":7/);
        assert.match(calls[0]!.body, /name="photo"; filename="a.png"/);

        calls.length = 0;
        await telegram.reply!(live, { text: "x".repeat(1500), key: "k2", to: event, files: [pdf] });
        assert.deepEqual(
            calls.map((call) => call.path.split("/").at(-1)),
            ["sendMessage", "sendDocument"],
        );
        assert.match(calls[1]!.body, /name="document"; filename="b.pdf"/);

        // A photo Telegram refuses goes once more, as a document.
        calls.length = 0;
        refusePhoto = true;
        await telegram.reply!(live, { text: "here", key: "k3", to: event, files: [png] });
        assert.deepEqual(
            calls.map((call) => call.path.split("/").at(-1)),
            ["sendPhoto", "sendDocument"],
        );
    },
);

test(
    "Slack: a shared file comes in and is fetched only from its file host; files go out by external upload",
    { timeout: 5000 },
    async (t) => {
        const calls: { path: string; body: string; auth: string; type: string }[] = [];
        let foreign = false;
        const mock = await serve(
            t,
            (request, body): Answer => {
                const path = request.url!;

                calls.push({
                    path,
                    body,
                    auth: String(request.headers.authorization ?? ""),
                    type: String(request.headers["content-type"] ?? ""),
                });

                switch (path) {
                    case "/auth.test":
                        return { json: { ok: true, user_id: "BOT" } };
                    case "/apps.connections.open":
                        return { json: { ok: true, url: `${mock.ws}/socket` } };
                    case "/f/a.png":
                        return { text: "PNG", headers: { "content-type": "image/png" } };
                    case "/f/moved":
                        return {
                            status: 302,
                            headers: { location: mock.url.replace("127.0.0.1", "localhost") },
                        };
                    case "/files.getUploadURLExternal":
                        return {
                            json: {
                                ok: true,
                                upload_url: `${foreign ? mock.url.replace("127.0.0.1", "localhost") : mock.url}/upload/F${calls.length}`,
                                file_id: `F${calls.length}`,
                            },
                        };
                    case "/files.completeUploadExternal":
                        return { json: { ok: true, files: [] } };
                    default:
                        return path.startsWith("/upload/") ? { text: "OK" } : { status: 404 };
                }
            },
            (socket) =>
                socket.send({
                    type: "events_api",
                    envelope_id: "e1",
                    payload: {
                        event: {
                            type: "message",
                            subtype: "file_share",
                            channel: "C",
                            ts: "1.1",
                            user: "U",
                            text: "see",
                            files: [
                                {
                                    id: "F0",
                                    name: "a.png",
                                    mimetype: "image/png",
                                    size: 3,
                                    url_private_download: `${mock.url}/f/a.png`,
                                },
                            ],
                        },
                    },
                }),
        );
        const values = { apiUrl: mock.url, appToken: "xapp-fake", botToken: "xoxb-fake" };
        const run = context(values, {});

        await slack.run!(run.context);

        const [event] = run.events;
        const live = { ...run.context, signal: new AbortController().signal };

        assert.equal(event!.files?.length, 1);
        assert.equal(
            new TextDecoder().decode((await slack.fetch!(live, event!.files![0]!, 100)).data),
            "PNG",
        );
        assert.equal(calls.find((call) => call.path === "/f/a.png")!.auth, "Bearer xoxb-fake");

        // The bot token goes to no other host: not a link from outside, not a redirect.
        for (const url of ["https://evil.example/a.png", `${mock.url}/f/moved`]) {
            await assert.rejects(
                slack.fetch!(live, { name: "a.png", ref: JSON.stringify({ url }) }, 100),
                /not on Slack's file host/,
            );
        }

        assert.ok(!calls.some((call) => call.path === "/" && call.auth !== ""));

        calls.length = 0;
        await slack.reply!(live, { text: "a <b>", key: "k", to: event, files: [png, pdf] });
        assert.deepEqual(
            calls.map((call) => call.path),
            [
                "/files.getUploadURLExternal",
                "/upload/F1",
                "/files.getUploadURLExternal",
                "/upload/F3",
                "/files.completeUploadExternal",
            ],
        );
        assert.equal(calls[1]!.auth, "", "the signed upload address gets no token");
        assert.equal(calls[1]!.body, "PNG1");

        const complete = new URLSearchParams(calls[4]!.body);

        assert.match(calls[4]!.type, /x-www-form-urlencoded/);
        assert.deepEqual(JSON.parse(complete.get("files")!), [
            { id: "F1", title: "a.png" },
            { id: "F3", title: "b.pdf" },
        ]);
        assert.equal(complete.get("channel_id"), "C");
        assert.equal(complete.get("thread_ts"), "1.1");
        assert.equal(complete.get("initial_comment"), "a &lt;b&gt;");

        // An upload address off Slack's host gets no file, and nothing is shared.
        calls.length = 0;
        foreign = true;
        await assert.rejects(
            slack.reply!(live, { text: "x", key: "k2", channel: "C", files: [png] }),
            /not its own/,
        );
        assert.deepEqual(
            calls.map((call) => call.path),
            ["/files.getUploadURLExternal"],
        );
    },
);

test(
    "Matrix: an image comes in and is fetched from the homeserver; files go out once across a replay",
    { timeout: 5000 },
    async (t) => {
        const calls: { method: string; path: string; body: string; auth: string }[] = [];
        const mock = await serve(t, (request, body): Answer => {
            const url = new URL(request.url!, "http://mock");

            calls.push({
                method: request.method!,
                path: url.pathname,
                body,
                auth: String(request.headers.authorization ?? ""),
            });

            if (url.pathname.endsWith("whoami")) {
                return { json: { user_id: "@relay:local" } };
            }

            if (url.pathname.endsWith("/sync")) {
                return {
                    json: {
                        next_batch: "s1",
                        rooms: {
                            join: {
                                "!r:local": {
                                    timeline: {
                                        events: [
                                            {
                                                type: "m.room.message",
                                                event_id: "$img",
                                                sender: "@ann:local",
                                                content: {
                                                    msgtype: "m.image",
                                                    body: "cat.png",
                                                    url: "mxc://local/abc",
                                                    info: { mimetype: "image/png", size: 3 },
                                                },
                                            },
                                        ],
                                    },
                                },
                            },
                        },
                    },
                };
            }

            if (url.pathname === "/_matrix/client/v1/media/download/local/gone") {
                return { status: 404, json: { errcode: "M_NOT_FOUND" } };
            }

            if (url.pathname === "/_matrix/client/v1/media/download/local/moved") {
                return {
                    status: 302,
                    headers: { location: `${mock.url.replace("127.0.0.1", "localhost")}/x` },
                };
            }

            // An older homeserver: no authenticated media yet.
            if (url.pathname.startsWith("/_matrix/client/v1/media/download/")) {
                return { status: 404, json: { errcode: "M_UNRECOGNIZED" } };
            }

            if (url.pathname === "/_matrix/media/v3/download/local/abc") {
                return { text: "CAT", headers: { "content-type": "image/png" } };
            }

            if (url.pathname === "/_matrix/media/v3/upload") {
                assert.equal(url.searchParams.get("filename"), "a.png");

                return { json: { content_uri: `mxc://local/up${calls.length}` } };
            }

            return { json: { event_id: `$sent${calls.length}` } };
        });
        const run = context({ homeserver: mock.url, token: "fake" }, { since: "s0" });

        await matrix.run!(run.context);

        const [event] = run.events;
        const live = { ...run.context, signal: new AbortController().signal };

        assert.deepEqual(event!.files, [
            { name: "cat.png", type: "image/png", size: 3, ref: "mxc://local/abc" },
        ]);
        assert.equal(
            new TextDecoder().decode((await matrix.fetch!(live, event!.files![0]!, 100)).data),
            "CAT",
        );
        assert.ok(
            calls
                .filter((call) => call.path.includes("/download/"))
                .every((call) => call.auth === "Bearer fake"),
        );

        // Media that is gone does not fall back to the old API; a redirect off the homeserver is not followed.
        calls.length = 0;
        await assert.rejects(
            matrix.fetch!(live, { name: "g", ref: "mxc://local/gone" }, 100),
            /answered 404/,
        );
        await assert.rejects(
            matrix.fetch!(live, { name: "m", ref: "mxc://local/moved" }, 100),
            /not on the Matrix homeserver/,
        );
        assert.deepEqual(
            calls.map((call) => call.path),
            [
                "/_matrix/client/v1/media/download/local/gone",
                "/_matrix/client/v1/media/download/local/moved",
            ],
        );

        const sends = async () => {
            calls.length = 0;
            await matrix.reply!(live, { text: "here", key: "k", to: event, files: [png] });

            return calls.filter((call) => call.method === "PUT");
        };

        const first = await sends();
        const again = await sends();

        assert.equal(first.length, 2);
        assert.deepEqual(
            again.map((call) => call.path),
            first.map((call) => call.path),
            "the same transaction ids, so the homeserver sends each event once",
        );
        assert.notEqual(first[0]!.path, first[1]!.path);

        const image = JSON.parse(first[1]!.body) as Record<string, unknown>;

        assert.equal(image.msgtype, "m.image");
        assert.equal(image.body, "a.png");
        assert.match(String(image.url), /^mxc:\/\/local\/up\d+$/);
        assert.deepEqual(image.info, { mimetype: "image/png", size: 4 });
    },
);
