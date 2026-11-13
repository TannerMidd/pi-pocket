import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { InboxApi, InboxDelivery } from "../src/server/host.ts";
import {
    type ConnectorConfig,
    Relay,
    secretsOf,
    tooShort,
} from "../src/server/extensions/pocket-relay/runtime.ts";
import {
    type RelayConnector,
    type RelayContext,
    type RelayEvent,
    RelayError,
} from "../src/server/extensions/pocket-relay/types.ts";
import { mockServer } from "./relay-ws-mock.ts";

const folders: string[] = [];

after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

const folder = () => {
    const made = mkdtempSync(join(tmpdir(), "pocket-relay-"));

    folders.push(made);

    return made;
};

async function until(check: () => boolean, what: string): Promise<void> {
    const started = Date.now();

    while (!check()) {
        if (Date.now() - started > 5000) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** An inbox that keeps what it delivered, once for each key, as core's does; `refuse` makes it answer 409. */
function fakeInbox() {
    const delivered: InboxDelivery[] = [];
    const keys = new Set<string>();
    const state = { refuse: false };
    const inbox: InboxApi = {
        deliver: async (_target, delivery) => {
            if (state.refuse) {
                throw Object.assign(new Error("busy"), { status: 409 });
            }

            if (keys.has(delivery.key)) {
                return { sent: false };
            }

            keys.add(delivery.key);
            delivered.push(delivery);

            return { sent: true };
        },
    };

    return { inbox, delivered, state };
}

const config = (kind: string, more: Partial<ConnectorConfig> = {}): ConnectorConfig => ({
    id: `c-${kind}`,
    name: `${kind} one`,
    kind,
    enabled: true,
    target: 1,
    by: "owner",
    instructions: "",
    ownerIds: ["me"],
    mentionOnly: false,
    perHour: 30,
    perAuthor: 10,
    values: { token: "very-secret-token-value" },
    createdAt: 1,
    updatedAt: 1,
    ...more,
});

const event = (id: string, author = "someone", more: Partial<RelayEvent> = {}): RelayEvent => ({
    id,
    text: `message ${id}`,
    author: { id: author, name: author },
    channel: "chan",
    ...more,
});

function open(where: string, inbox: InboxApi, hidden: string[] = []) {
    return new Relay({
        folder: where,
        inbox: () => inbox,
        log: () => {},
        onStatus: () => {},
        hide: (values) => {
            hidden.push(...values.map((value) => value.value));

            return () => {};
        },
    });
}

/** A stream connector a test drives: `push` hands it events, and it keeps a cursor of the last one. */
function scripted(kind = "mock") {
    const queue: RelayEvent[][] = [];
    const replies: { text: string; key: string; to?: string }[] = [];

    let wake = () => {};

    const connector: RelayConnector = {
        kind,
        label: "Mock",
        shape: "stream",
        mentions: true,
        fields: [{ name: "token", label: "Token", type: "secret" }],
        run: async (context: RelayContext) => {
            while (!context.signal.aborted) {
                const next = queue.shift();

                if (next === undefined) {
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                        context.signal.addEventListener("abort", () => resolve(), { once: true });
                    });
                    continue;
                }

                await context.emit(next);
                context.save({ cursor: next.at(-1)?.id });
            }
        },
        reply: async (_context, reply) => {
            replies.push({
                text: reply.text,
                key: reply.key,
                ...(reply.to ? { to: reply.to.id } : {}),
            });

            return { id: `sent-${replies.length}` };
        },
    };

    return {
        connector,
        replies,
        push: (...events: RelayEvent[]) => {
            queue.push(events);
            wake();
        },
    };
}

test("what came is delivered once, also after a restart in the middle", async () => {
    const where = folder();
    const { inbox, delivered, state } = fakeInbox();
    const hidden: string[] = [];
    const first = open(where, inbox, hidden);
    const mock = scripted();

    first.register(mock.connector);
    await first.put(config("mock"));
    mock.push(event("1"));
    await until(() => delivered.length === 1, "the first event");

    // A module's new version loads before the old one stops: it reads the files only once the old one is done.
    const overlap = open(where, inbox);
    let read = false;

    void overlap.ready.then(() => {
        read = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(read, false, "the new version waits");
    await overlap.stop();

    // The session takes nothing now: the next event waits on disk, in the queue.
    state.refuse = true;
    mock.push(event("2"));
    await until(() => first.stateOf("c-mock").pending.length === 1, "the event to wait");
    // `pending` grows before the write ends: the cursor is saved only after it, once `emit` resolves.
    await until(() => first.stateOf("c-mock").own.cursor === "2", "the cursor");
    await first.stop();
    assert.equal(first.running(), 0);
    assert.equal(statSync(join(where, "state.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(where, "connectors.json")).mode & 0o777, 0o600);
    assert.ok(hidden.includes("very-secret-token-value"), "the token is hidden from Pi");
    assert.ok(
        secretsOf(
            config("mock", { values: { token: "Authorization: Bearer abcdefghijk\nX-Key: k123" } }),
            mock.connector.fields,
        ).includes("abcdefghijk"),
        "each header's token is hidden on its own",
    );

    // A restart: the waiting event goes, and the connector, which saw event 1 again, does not send it twice.
    state.refuse = false;
    const second = open(where, inbox);
    const again = scripted();

    second.register(again.connector);
    await second.ready;
    assert.equal(second.stateOf("c-mock").own.cursor, "2");
    again.push(event("1"), event("3"));
    await until(() => delivered.length === 3, "the waiting and the new event");
    await second.stop();
    assert.deepEqual(
        delivered.map((each) => each.key),
        ["relay-c-mock-1", "relay-c-mock-2", "relay-c-mock-3"],
    );

    // The owner's ids are trusted outside the fence; the reply hint is the relay's own words, after the owner's.
    const one = delivered[0]!;

    assert.equal(one.tag, "relay-message");
    assert.deepEqual(one.sender, { name: "someone", id: "someone", trusted: false });
    assert.match(one.instructions!, /relay_reply with connector "mock one"/);
    assert.match(one.payload, /^event: 1\nchannel: \(chan\)\n\nmessage 1$/);
});

test("bots, messages without a mention, and authors past their limit are not delivered; the owner has no limit", async () => {
    const { inbox, delivered } = fakeInbox();
    const relay = open(folder(), inbox);
    const mock = scripted();

    relay.register(mock.connector);
    await relay.put(config("mock", { mentionOnly: true, perAuthor: 2 }));
    mock.push(
        event("bot", "a-bot", { author: { id: "a-bot", name: "bot", bot: true }, mentioned: true }),
        event("quiet", "x"),
        ...["1", "2", "3"].map((id) => event(`x${id}`, "x", { mentioned: true })),
        ...["1", "2", "3"].map((id) => event(`me${id}`, "me", { mentioned: true })),
    );
    await until(() => delivered.length === 5, "the deliveries");
    await relay.stop();
    assert.deepEqual(
        delivered.map((each) => each.key.replace("relay-c-mock-", "")),
        ["x1", "x2", "me1", "me2", "me3"],
    );
    assert.equal(delivered[2]!.sender?.trusted, true);
    assert.equal(relay.stateOf("c-mock").dropped, 1);
});

test("an author named as an object's key (constructor, __proto__) has a limit and holds up nothing", async () => {
    const { inbox, delivered } = fakeInbox();
    const relay = open(folder(), inbox);
    const mock = scripted();
    const names = ["constructor", "__proto__", "toString"];

    relay.register(mock.connector);
    await relay.put(config("mock", { perAuthor: 1 }));
    mock.push(...names.flatMap((name) => [event(`${name}1`, name), event(`${name}2`, name)]));
    mock.push(event("last"));
    await until(() => delivered.length === 4, "the deliveries");
    await relay.stop();
    assert.deepEqual(
        delivered.map((each) => each.key.replace("relay-c-mock-", "")),
        [...names.map((name) => `${name}1`), "last"],
    );
});

test("an event with a date out of range, or attachments not in a list, holds up nothing", async () => {
    const { inbox, delivered } = fakeInbox();
    const relay = open(folder(), inbox);
    const mock = scripted();
    const odd = { attachments: "a.png" as unknown as string[] };

    relay.register(mock.connector);
    await relay.put(config("mock"));
    mock.push(event("late", "x", { at: 9e15 }), event("odd", "x", odd), event("good"));
    await until(() => delivered.length === 3, "the deliveries");
    await relay.stop();
});

test("a feed (authorLimit false, or its author field empty) has only the connector's limit", async () => {
    const { inbox, delivered } = fakeInbox();
    const relay = open(folder(), inbox);
    const [feed, chat, empty] = [scripted(), scripted("chat"), scripted("empty")];

    relay.register({ ...feed.connector, authorLimit: false });
    relay.register({ ...chat.connector, authorLimit: "token" });
    relay.register({ ...empty.connector, authorLimit: "token" });
    await relay.put(config("mock", { perAuthor: 1 }));
    await relay.put(config("chat", { perAuthor: 1 }));
    await relay.put(config("empty", { perAuthor: 1, values: {} }));
    feed.push(...["1", "2", "3"].map((id) => event(id, "feed")));
    chat.push(...["4", "5", "6"].map((id) => event(id, "stranger")));
    empty.push(...["7", "8", "9"].map((id) => event(id, "feed")));
    await until(
        () => delivered.length === 7 && relay.stateOf("c-chat").dropped === 2,
        "the deliveries",
    );
    await relay.stop();
});

test("a short header value is refused only for a credential header", () => {
    assert.equal(tooShort("Accept: */*\nX-Version: 2", true), false);
    assert.equal(tooShort("X-Api-Key: abc", true), true);
    assert.equal(tooShort("Authorization: Bearer abc", true), true);
    assert.equal(tooShort("abc"), true);
});

test("a connector that throws backs off and goes on; a fatal error stops it until an edit; the server never sees either", async () => {
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => rejections.push(error);

    process.on("unhandledRejection", onRejection);

    const { inbox } = fakeInbox();
    const relay = open(folder(), inbox);
    let polls = 0;
    const flaky: RelayConnector = {
        kind: "flaky",
        label: "Flaky",
        shape: "poll",
        interval: 10,
        fields: [{ name: "token", label: "Token", type: "secret" }],
        poll: async () => {
            polls += 1;

            if (polls === 1) {
                throw new RelayError("slow down very-secret-token-value", { retryAfter: 10 });
            }

            throw new RelayError("bad token", { fatal: true });
        },
    };

    relay.register(flaky);
    await relay.put(config("flaky"));
    await until(() => relay.status("c-flaky").state === "stopped", "the fatal error");
    assert.equal(polls, 2);
    assert.equal(relay.stateOf("c-flaky").lastError, "bad token");

    await relay.put(config("flaky", { updatedAt: 2 }));
    await until(() => polls === 3, "a new try");
    await relay.stop();
    process.off("unhandledRejection", onRejection);
    assert.deepEqual(rejections, []);
});

test("a retry-after of 0, or past setTimeout's limit, still backs off", async () => {
    const relay = open(folder(), fakeInbox().inbox);
    const runs: number[] = [];

    for (const [index, retryAfter] of [0, 30 * 24 * 3_600_000].entries()) {
        runs[index] = 0;
        relay.register({
            kind: `wait${index}`,
            label: "Wait",
            shape: "stream",
            fields: [],
            run: async () => {
                runs[index]! += 1;

                throw new RelayError("slow down", { retryAfter });
            },
        });
        await relay.put(config(`wait${index}`));
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    await relay.stop();
    assert.deepEqual(runs, [1, 1]);
});

test("a stop closes a stream's socket and timers, and a removed kind stops its connectors", async () => {
    const mock = await mockServer(() => ({ json: {} }));
    const { inbox } = fakeInbox();
    const relay = open(folder(), inbox);
    const socket: RelayConnector = {
        kind: "socket",
        label: "Socket",
        shape: "stream",
        fields: [],
        run: (context) =>
            new Promise<void>((resolve, reject) => {
                const ws = new WebSocket(`${mock.ws}/gateway`);
                const beat = setInterval(() => {}, 1000);

                context.signal.addEventListener("abort", () => {
                    clearInterval(beat);
                    ws.close(4000);
                });
                ws.onclose = () => resolve();
                ws.onerror = () => reject(new Error("socket error"));
            }),
    };
    const unregister = relay.register(socket);

    await relay.put(config("socket"));
    await until(() => mock.sockets.length === 1, "the socket");
    unregister();
    await mock.sockets[0]!.closed;
    await until(() => relay.running() === 0, "the runner to stop");
    assert.equal(relay.status("c-socket").state, "no-connector");
    await relay.stop();
    mock.server.closeAllConnections();
    mock.server.close();
});

test("a reply sends once for its key, to the event it answers, with secrets kept out of its errors", async () => {
    const { inbox, delivered } = fakeInbox();
    const relay = open(folder(), inbox);
    const mock = scripted();

    relay.register(mock.connector);
    await relay.put(config("mock"));
    mock.push(event("7"));
    await until(() => delivered.length === 1, "the event");

    const signal = new AbortController().signal;
    const request = { text: "hello", replyTo: "7", key: "task:call" };

    // Two calls with one key at once, then again: one send.
    const both = await Promise.all([
        relay.reply(config("mock"), request, signal),
        relay.reply(config("mock"), request, signal),
    ]);

    assert.deepEqual(both, ["Sent.", "Sent."]);
    assert.equal(await relay.reply(config("mock"), request, signal), "Sent already.");
    assert.deepEqual(mock.replies, [{ text: "hello", key: "task:call", to: "7" }]);
    await assert.rejects(
        relay.reply(config("mock"), { ...request, replyTo: "nope", key: "other" }, signal),
        /No recent event/,
    );

    mock.connector.reply = async () => {
        throw new Error("401 for very-secret-token-value");
    };

    await assert.rejects(
        relay.reply(config("mock"), { ...request, key: "third" }, signal),
        (error: Error) =>
            !error.message.includes("very-secret") && /\[secret\]/.test(error.message),
    );

    // A send that failed, or that a restart cut off, may have gone: a connector whose service does not keep a key once
    // does not send it again.
    assert.match(
        await relay.reply(config("mock"), { ...request, key: "third" }, signal),
        /may have gone out already/,
    );
    relay.stateOf("c-mock").replies.cut = { at: 1, sending: true };
    assert.match(
        await relay.reply(config("mock"), { ...request, key: "cut" }, signal),
        /may have gone out already/,
    );
    await relay.stop();
});
