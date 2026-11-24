import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import discord from "../src/server/extensions/pocket-relay/connectors/discord.ts";
import type { RelayContext, RelayEvent } from "../src/server/extensions/pocket-relay/types.ts";

const current = "wss://current.invalid";
const stale = "wss://previous.invalid";

function fixture(t: TestContext, state: Record<string, unknown> = {}) {
    const sockets: Socket[] = [];

    class Socket extends EventTarget {
        static OPEN = 1;
        readyState = Socket.OPEN;
        sent: unknown[] = [];
        url: URL;
        closing = false;

        constructor(url: string) {
            super();
            this.url = new URL(url);
            sockets.push(this);
        }

        close() {
            this.closing = true;
        }

        send(data: string) {
            this.sent.push(JSON.parse(data));
        }

        receive(packet: unknown) {
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(packet) }));
        }
    }

    const native = globalThis.WebSocket;

    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    t.after(() => {
        globalThis.WebSocket = native;
    });
    t.mock.method(globalThis, "fetch", () => {
        throw new Error("unexpected fetch");
    });

    const controller = new AbortController();
    const events: RelayEvent[] = [];
    const saves: Record<string, unknown>[] = [];
    const context: RelayContext = {
        values: { token: "fixture-current", gatewayUrl: current },
        state,
        signal: controller.signal,
        sleep: async () => {},
        status() {},
        log() {},
        save: (next) => saves.push(next),
        emit: async (list) => {
            events.push(...list);
        },
    };

    t.after(() => controller.abort());

    return { controller, context, sockets, events, saves };
}

const hello = { op: 10, d: { heartbeat_interval: 60_000 } };
const message = {
    op: 0,
    t: "MESSAGE_CREATE",
    s: 2,
    d: { id: "1", channel_id: "2", content: "ok" },
};

test("saved gateway addresses cannot select where a new run authenticates", async (t) => {
    const f = fixture(t, { session: { id: "fixture-session", seq: 1, url: stale } });
    const running = discord.run!(f.context);

    await setImmediate();
    const socket = f.sockets[0]!;

    assert.equal(socket.url.origin, current);
    socket.receive(hello);
    assert.deepEqual(socket.sent, [
        { op: 6, d: { token: "fixture-current", session_id: "fixture-session", seq: 1 } },
    ]);
    socket.receive(message);
    f.controller.abort();
    socket.receive(hello);
    await running;
    assert.equal(socket.sent.length, 1);
    assert.equal(f.sockets.length, 1);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.saves, []);
});

test("a closing gateway cannot dispatch, authenticate, or replace its reconnect address", async (t) => {
    const f = fixture(t);
    const running = discord.run!(f.context);

    await setImmediate();
    const first = f.sockets[0]!;

    first.receive(hello);
    first.receive({
        op: 0,
        t: "READY",
        s: 1,
        d: { session_id: "fixture-session", resume_gateway_url: current + "/resume" },
    });
    first.receive({ op: 7 });
    assert.equal(first.closing, true);
    first.receive({
        op: 0,
        t: "READY",
        s: 2,
        d: { session_id: "other", resume_gateway_url: stale },
    });
    first.receive(message);
    first.receive(hello);
    first.dispatchEvent(new Event("close"));
    await setImmediate();
    assert.equal(first.sent.length, 1);
    assert.deepEqual(f.events, []);
    assert.equal(f.sockets[1]!.url.origin, current);
    assert.equal(f.sockets[1]!.url.pathname, "/resume");
    f.controller.abort();
    await running;
});

test("aborting during gateway discovery opens no socket", async (t) => {
    const f = fixture(t);
    const response = Promise.withResolvers<Response>();

    t.mock.method(globalThis, "fetch", () => response.promise);
    const running = discord.run!({ ...f.context, values: { token: "fixture-current" } });

    f.controller.abort();
    response.resolve(Response.json({ url: stale }));
    await running;
    assert.deepEqual(f.sockets, []);
    assert.deepEqual(f.saves, []);
});

test("a backfill response that arrives after abort cannot emit or save", async (t) => {
    const f = fixture(t, { cursors: { "2": { m: "1", g: "3" } } });
    const pending = Promise.withResolvers<Response>();
    const get = t.mock.method(globalThis, "fetch", () => pending.promise);
    const running = discord.run!(f.context);

    await setImmediate();
    f.sockets[0]!.receive(hello);
    f.sockets[0]!.receive({ op: 0, t: "READY", s: 1, d: { session_id: "fixture-session" } });
    await setImmediate();
    assert.equal(get.mock.callCount(), 1);
    const count = f.saves.length;

    f.controller.abort();
    pending.resolve(Response.json([{ id: "4", channel_id: "2", content: "late" }]));
    await running;
    assert.equal(f.saves.length, count);
    assert.deepEqual(f.events, []);
    assert.equal(f.sockets.length, 1);
});

test("a card requires complete text and a matching Discord message receipt", async (t) => {
    const f = fixture(t);
    let answer: unknown = { id: "10", channel_id: "25", content: "choices" };
    const post = t.mock.method(globalThis, "fetch", async () => Response.json(answer));
    const card = { text: "choices", key: "fixture-card", channel: "25", confirmDestination: true };

    await assert.rejects(discord.reply!(f.context, { ...card, text: "x".repeat(2001) }), /exceeds/);
    assert.equal(post.mock.callCount(), 0);
    assert.deepEqual(await discord.reply!(f.context, card), { id: "10", channel: "25" });

    for (answer of [
        { id: "10" },
        { id: "10", channel_id: "99", content: "choices" },
        { id: "10", channel_id: "25", content: "cut" },
    ]) {
        assert.deepEqual(await discord.reply!(f.context, card), {});
    }

    assert.deepEqual(
        await discord.reply!(f.context, {
            ...card,
            confirmDestination: false,
            text: "x".repeat(2001),
        }),
        { id: "10" },
    );
});
