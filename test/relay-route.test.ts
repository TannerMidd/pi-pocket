import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { type ConversationId, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import type { PocketApp } from "../src/server/app.ts";
import { Commands } from "../src/server/commands.ts";
import discord from "../src/server/extensions/pocket-relay/connectors/discord.ts";
import http, { toEvent } from "../src/server/extensions/pocket-relay/connectors/http.ts";
import matrix from "../src/server/extensions/pocket-relay/connectors/matrix.ts";
import rss from "../src/server/extensions/pocket-relay/connectors/rss.ts";
import slack from "../src/server/extensions/pocket-relay/connectors/slack.ts";
import telegram from "../src/server/extensions/pocket-relay/connectors/telegram.ts";
import { publishFetchedFile } from "../src/server/extensions/pocket-relay/files.ts";
import { Relay, type ConnectorConfig } from "../src/server/extensions/pocket-relay/runtime.ts";
import {
    authenticatedAccount,
    isOwnerAccount,
    type RelayConnector,
    type RelayContext,
    type RelayEvent,
} from "../src/server/extensions/pocket-relay/types.ts";
import { Inbox } from "../src/server/inbox.ts";
import {
    relayActor,
    type RelayMessage,
    type SurfacesRelayApi,
} from "../src/server/surfaces/relay.ts";
import { TurnNotes } from "../src/server/turn-notes.ts";

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

test("chat owner IDs match only authenticated accounts, never a display name", () => {
    const owners = ["account-1"];

    for (const connector of [discord, matrix, slack, telegram]) {
        const account = (id: string, name: string, bot = false) =>
            authenticatedAccount(connector, { id, name, bot });

        assert.equal(isOwnerAccount(owners, account("account-1", "New name")), true);
        assert.equal(isOwnerAccount(owners, account("account-2", "account-1")), false);
        assert.equal(isOwnerAccount(owners, account("", "account-1")), false);
        assert.equal(isOwnerAccount(owners, account("account-1", "A bot", true)), false);
    }
});

test("an HTTP record, feed, legacy connector, or unauthenticated sender is untrusted", () => {
    const owners = ["account-1"];
    const fields = { authorIdField: "user", authorNameField: "label" };
    const url = "https://feed.invalid/items";
    const record = (item: object) => toEvent(item, fields, url).author;
    const withId = record({ user: "account-1", label: "A name" });
    const withoutId = record({ label: "account-1" });

    assert.deepEqual(withId, { id: "account-1", name: "A name" });
    assert.deepEqual(withoutId, { id: "feed.invalid", name: "account-1" });
    assert.equal(authenticatedAccount(http, withId), undefined);
    assert.equal(authenticatedAccount(http, withoutId), undefined);

    const author = { id: "account-1", name: "A name" };
    const legacy = { ...discord, authenticatedAuthors: undefined };

    assert.equal(authenticatedAccount(rss, author), undefined);
    assert.equal(authenticatedAccount(legacy, author), undefined);
    assert.equal(isOwnerAccount(owners, undefined), false);

    const person = { id: "local-1", name: "A person", role: "owner" as const };
    const message: RelayMessage = {
        connector: "chat",
        routeRevision: "revision",
        author: { id: "account-1", name: "A name" },
        ownerIds: owners,
        by: person.id,
        text: "1",
    };

    assert.equal(relayActor(message, person)?.role, "viewer");
    assert.deepEqual(relayActor({ ...message, trusted: true }, person), person);
    assert.equal(relayActor(message, undefined), undefined);
    assert.equal(relayActor({ ...message, trusted: true }, undefined), undefined);
});

test("inbox delivery checks the current route after lookup and gives admission the same guard", async () => {
    const person = { id: "person", role: "owner" };
    const checked: string[] = [];
    let phase = "lookup";
    const checkCurrent = () => checked.push(phase);
    const inbox = new Inbox({
        config: { userById: () => person },
        steeringUser: (_target: unknown, by: string) => (by === person.id ? person : undefined),
        sessionMeta: () => ({}),
        canSee: () => true,
        now: () => 1,
        harness: {
            commit: async () => {
                phase = "after lookup";
            },
        },
        commands: {
            submit: async (...args: Parameters<PocketApp["commands"]["submit"]>) => {
                phase = "admission";
                assert.equal(args[5], checkCurrent);
                args[5]!();
            },
        },
    } as unknown as PocketApp);

    assert.deepEqual(
        await inbox.deliver(
            1 as unknown as ConversationId,
            {
                by: person.id,
                via: "fixture",
                payload: "message",
                key: "fixture-input",
            },
            checkCurrent,
        ),
        { sent: true },
    );
    assert.deepEqual(checked, ["lookup", "after lookup", "admission"]);
});

for (const annotated of [false, true]) {
    test(`guarded admission rolls back a cancelled ${annotated ? "annotated" : "plain"} input`, async () => {
        const owner = { id: "owner", role: "owner", name: "Owner" };
        const route = new AbortController();
        const staged: string[] = [];
        const committed: string[] = [];
        const log: string[] = [];
        const tx = {
            submissionByRequest: async () => undefined,
            doc: async (kind: unknown) =>
                kind === LiveDoc && staged.length > 0
                    ? { run: { inputs: ["submission"] } }
                    : { items: [] },
            appendEntry: async () => {
                staged.push("note");
                route.abort();
            },
        };
        const app = {
            config: { users: [owner], userById: () => owner },
            steeringUser: (_target: unknown, by: string) => (by === owner.id ? owner : undefined),
            canSee: () => true,
            requireSee: () => {},
            requireSteer: (user: unknown) => assert.equal(user, owner),
            requireDriver: async () => {},
            sessionMeta: () => ({}),
            agentState: async () => ({ model: { provider: "fixture", modelId: "fixture" } }),
            models: { getModel: () => ({ input: ["text"] }) },
            spend: { check: () => {} },
            hidden: { replace: (value: string) => value },
            now: () => 1,
            pip: { ownerOf: () => undefined },
            parentOf: () => undefined,
            log: (line: string) => log.push(line),
            conversation: async () => ({
                id: 1,
                entries: async () => ({ items: [] }),
                submit: async (transaction: unknown) => {
                    assert.equal(transaction, tx);
                    staged.push("input");

                    if (!annotated) {
                        route.abort();
                    }

                    return "submission";
                },
            }),
            harness: {
                snapshot: async (kind: unknown) => (kind === InboxDoc ? { items: [] } : {}),
                commit: async (prepare: (transaction: typeof tx) => Promise<unknown>) => {
                    const result = await prepare(tx);

                    committed.push(...staged);

                    return result;
                },
            },
        } as unknown as PocketApp;
        const notes = new TurnNotes(app);
        const commands = new Commands(app);

        Object.assign(app, { turnNotes: notes, commands });

        if (annotated) {
            notes.add("fixture", () => "note");
        }

        const inbox = new Inbox(app);

        await assert.rejects(
            inbox.deliver(
                1 as unknown as ConversationId,
                {
                    by: owner.id,
                    via: "fixture",
                    payload: "message",
                    key: "input",
                },
                () => route.signal.throwIfAborted(),
            ),
            /does not take messages now/,
        );
        assert.deepEqual(staged, annotated ? ["input", "note"] : ["input"], log.join("\n"));
        assert.deepEqual(committed, []);
    });
}

for (const cancelled of [false, true]) {
    test(`attachment publication ${cancelled ? "keeps the previous file on cancellation" : "commits the complete staged file"}`, async (t) => {
        const folder = await mkdtemp(join(tmpdir(), "relay-publish-"));

        t.after(() => rm(folder, { recursive: true, force: true }));
        const path = join(folder, "note.txt");
        const data = Buffer.from("updated");

        await writeFile(path, "previous");
        let checkedStaged = false;
        const publish = publishFetchedFile(path, data, () => {
            const staged = readdirSync(folder).find((name) => name.endsWith(".tmp"));

            if (staged !== undefined && statSync(join(folder, staged)).size === data.length) {
                checkedStaged = true;

                if (cancelled) {
                    throw new Error("Cancelled");
                }
            }
        });

        if (cancelled) {
            await assert.rejects(publish, /Cancelled/);
        } else {
            await publish;
        }

        assert.equal(checkedStaged, true);
        assert.equal(await readFile(path, "utf8"), cancelled ? "previous" : "updated");
        assert.deepEqual(await readdir(folder), ["note.txt"]);
    });
}
