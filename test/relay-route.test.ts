import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Relay, type ConnectorConfig } from "../src/server/extensions/pocket-relay/runtime.ts";
import type {
    RelayConnector,
    RelayContext,
    RelayEvent,
} from "../src/server/extensions/pocket-relay/types.ts";
import type { SurfacesRelayApi } from "../src/server/surfaces/relay.ts";

const settings: ConnectorConfig = {
    id: "c1",
    kind: "fixture",
    name: "Chat",
    enabled: true,
    target: 1,
    by: "owner",
    ownerIds: [],
    instructions: "",
    values: { endpoint: "fixture-a" },
    mentionOnly: false,
    perHour: 30,
    perAuthor: 10,
    createdAt: 1,
    updatedAt: 1,
};
const event: RelayEvent = {
    id: "event",
    channel: "room",
    author: { id: "author", name: "Author" },
    text: "message",
    files: [{ name: "note", ref: "file" }],
};
const signal = new AbortController().signal;

async function fixture(
    t: TestContext,
    options: Partial<RelayConnector> = {},
    surfaces?: SurfacesRelayApi,
) {
    const folder = await mkdtemp(join(tmpdir(), "relay-route-"));
    const deliveries: string[] = [];
    const polls: RelayContext[] = [];
    const relay = new Relay({
        folder,
        inbox: () => ({
            deliver: async (_target, request) => {
                deliveries.push(/^event: (.+)$/m.exec(request.payload)![1]!);

                return { sent: true };
            },
        }),
        surfaces: () => surfaces,
        log: () => {},
        onStatus: () => {},
        hide: () => () => {},
    });
    const unregister = relay.register({
        kind: "fixture",
        label: "Fixture",
        fields: [],
        shape: "poll",
        poll: async (context) => {
            polls.push(context);
        },
        ...options,
    });

    t.after(async () => {
        await relay.stop();
        await rm(folder, { recursive: true, force: true });
    });
    const config = await relay.put(settings);

    return { relay, folder, config, unregister, polls, deliveries };
}

test("A route change discards queued work, heard events and connector cursors before the new runner starts", async (t) => {
    const { relay, config, polls, deliveries } = await fixture(t, {
        reply: async () => ({ id: "sent" }),
    });
    const state = relay.stateOf(config.id);

    state.pending.push(event);
    polls[0]!.save({ cursor: "first" });
    state.recent.push({
        reference: "ref",
        id: event.id,
        channel: "room",
        author: "author",
        at: 1,
        files: event.files!,
    });
    state.replies["call"] = { at: 1, sending: true };
    const changed = await relay.put({ ...config, target: 2 });

    assert.notEqual(changed.revision, config.revision);
    assert.equal(polls[0]!.signal.aborted, true);
    polls[0]!.save({ cursor: "late" });
    await assert.rejects(polls[0]!.emit([event]), /stopped/);
    assert.deepEqual(deliveries, []);
    assert.deepEqual(polls.at(-1)!.state, {});
    assert.equal(relay.stateOf(config.id).pending.length, 0);
    assert.equal(relay.stateOf(config.id).recent.length, 0);
    await assert.rejects(
        relay.reply(changed, { key: "call", text: "x" }, signal),
        /earlier connector/,
    );
    await assert.rejects(
        relay.reply(changed, { key: "fresh", text: "x", replyTo: event.id }, signal),
        /No recent event/,
    );

    for (const patch of [
        { values: { endpoint: "fixture-b" } },
        { by: "another" },
        { ownerIds: ["someone"] },
        { name: "Other" },
    ]) {
        const before = relay.config(config.id)!;
        const after = await relay.put({ ...before, ...patch });

        assert.notEqual(before.revision, after.revision);
    }

    const before = relay.config(config.id)!;

    assert.equal(
        (await relay.put({ ...before, instructions: "Be brief." })).revision,
        before.revision,
    );
});

test("Disabling a route stops its poll, held send, fetch, card echo and delayed delivery", async (t) => {
    const inScreen = Promise.withResolvers<void>();
    const screen = Promise.withResolvers<"send">();
    const inCard = Promise.withResolvers<void>();
    const card = Promise.withResolvers<{ handled: true; reply: string }>();
    const fetchStarted = Promise.withResolvers<AbortSignal>();
    const fetchDone = Promise.withResolvers<{ data: Uint8Array }>();
    let sent = 0;
    let holdCard = false;
    const surfaces = {
        confirm: async () => {},
        fromRelay: async () => {
            if (!holdCard) {
                return { handled: false };
            }

            inCard.resolve();

            return card.promise;
        },
    } as unknown as SurfacesRelayApi;
    const { relay, config, polls, deliveries } = await fixture(
        t,
        {
            reply: async () => {
                sent++;
            },
            fetch: async (context) => {
                fetchStarted.resolve(context.signal);

                return fetchDone.promise;
            },
        },
        surfaces,
    );

    await relay.deliver(config, { ...event, id: "attachment-message" });
    const [fileRef] = deliveries;

    assert.ok(fileRef);
    holdCard = true;
    relay.setOutbound(async () => {
        inScreen.resolve();

        return screen.promise;
    });
    const sending = relay.reply(config, { key: "send", text: "x" }, signal);
    const fetching = relay.fetch(config, fileRef, 1, signal);
    const delivering = relay.deliver(config, event);
    const [fetchSignal] = await Promise.all([
        fetchStarted.promise,
        inScreen.promise,
        inCard.promise,
    ]);
    const disabled = await relay.put({ ...config, enabled: false });

    assert.equal(fetchSignal.aborted, true);
    assert.equal(polls[0]!.signal.aborted, true);
    assert.equal(relay.running(), 0);
    screen.resolve("send");
    card.resolve({ handled: true, reply: "echo" });
    fetchDone.resolve({ data: new Uint8Array([1]) });
    await assert.rejects(sending);
    await assert.rejects(fetching);
    await delivering;
    await assert.rejects(relay.reply(disabled, { key: "new", text: "x" }, signal), /not enabled/);
    await assert.rejects(relay.fetch(disabled, event.id, 1, signal), /not enabled/);
    assert.deepEqual(deliveries, [fileRef]);
    assert.equal(sent, 0);
});

test("A send receipt activates only the complete current delivery to the expected channel and thread", async (t) => {
    const waiting = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    const { relay, config } = await fixture(t, {
        reply: async (_context, reply) => {
            assert.equal(reply.confirmDestination, true);

            switch (reply.text) {
                case "partial":
                    throw new Error("part failed");
                case "unknown":
                    return {};
                case "other":
                    return { id: "sent", channel: "other" };
                case "thread":
                    return { id: "sent", channel: "room", thread: "other" };
                case "late":
                    waiting.resolve();
                    await done.promise;
                    break;
            }

            return { id: "sent", channel: "room" };
        },
    });

    await relay.deliver(config, event);
    const confirmed: string[] = [];
    const send = (text: string) =>
        relay.reply(
            config,
            {
                text,
                key: text,
                replyTo: relay.stateOf(config.id).recent[0]!.reference,
                onSent: async () => {
                    confirmed.push(text);
                },
            },
            signal,
        );

    await assert.rejects(send("partial"));

    for (const result of ["unknown", "other", "thread"]) {
        assert.match(await send(result), /not active/);
    }

    assert.equal(await send("good"), "Sent.");
    const late = send("late");

    await waiting.promise;
    await relay.put({ ...config, values: { endpoint: "fixture-b" } });
    done.resolve();
    await assert.rejects(late);
    assert.deepEqual(confirmed, ["good"]);
});

test("A resumed idempotent send cannot activate a newly prepared card", async (t) => {
    const { relay, config } = await fixture(t, {
        idempotentReply: true,
        reply: async () => ({ id: "original", channel: "room" }),
    });

    relay.stateOf(config.id).replies.call = { at: 1, sending: true };
    const result = await relay.reply(
        config,
        {
            text: "new rendering",
            key: "call",
            onSent: async () => assert.fail("not a fresh receipt"),
        },
        signal,
    );

    assert.match(result, /card is not active/);
});

test("a restored event reference is valid only for its recorded route and destination", async (t) => {
    const { relay, config, deliveries } = await fixture(t, {});

    await relay.deliver(config, event);
    const [reference] = deliveries;

    assert.ok(reference);
    const record = relay.heard(config, reference);

    assert.ok(record);
    record.channel = "different-room";
    assert.equal(relay.heard(config, reference), undefined);
});

test("The same native event id on a new route has a new reference; only its fresh reference can send or fetch", async (t) => {
    const sent: string[] = [];
    const fetched: string[] = [];
    const { relay, config, deliveries } = await fixture(t, {
        reply: async (_context, reply) => {
            sent.push(reply.to!.id);
        },
        fetch: async (_context, file) => {
            fetched.push(file.ref);

            return { data: new Uint8Array([1]) };
        },
    });

    await relay.deliver(config, event);
    const changed = await relay.put({ ...config, target: 2, values: { endpoint: "another" } });

    await relay.deliver(changed, { ...event, channel: "another-room" });
    assert.notEqual(deliveries[0], deliveries[1]);

    for (const reference of [event.id, deliveries[0]!]) {
        await assert.rejects(
            relay.reply(changed, { key: reference, text: "x", replyTo: reference }, signal),
            /No recent event/,
        );
        await assert.rejects(relay.fetch(changed, reference, 1, signal), /No recent event/);
    }

    await relay.reply(changed, { key: "new", text: "x", replyTo: deliveries[1]! }, signal);
    await relay.fetch(changed, deliveries[1]!, 1, signal);
    assert.deepEqual(sent, [event.id]);
    assert.deepEqual(fetched, ["file"]);
});

test("Restart does not accept unbound state or state from a different route revision", async (t) => {
    const { relay, folder, config } = await fixture(t);
    const old = relay.stateOf(config.id);

    await relay.stop();

    for (const stale of [undefined, "unrelated"]) {
        await writeFile(
            join(folder, "state.json"),
            JSON.stringify({
                version: 1,
                connectors: {
                    [config.id]: {
                        ...old,
                        revision: stale,
                        own: { cursor: "previous" },
                        pending: [event],
                    },
                },
            }),
        );
        const next = new Relay({
            folder,
            inbox: () => undefined,
            log: () => {},
            onStatus: () => {},
            hide: () => () => {},
        });

        const before = await readFile(join(folder, "state.json"));

        try {
            await assert.rejects(next.ready, /revisions do not match/);
            assert.equal(next.running(), 0);
            assert.equal(next.config(config.id), undefined);
        } finally {
            await next.stop();
        }

        assert.deepEqual(await readFile(join(folder, "state.json")), before);
    }
});
