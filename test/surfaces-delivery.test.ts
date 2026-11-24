import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../src/server/app.ts";
import {
    fromRelay,
    prepareRelay,
    recordEcho,
    recordSent,
    type RelayMessage,
    type RelayReceipt,
    type SurfaceWhere,
} from "../src/server/surfaces/relay.ts";
import type { Surface, SurfacesState } from "../src/server/surfaces/types.ts";

const route = { connector: "connector-id", routeRevision: "revision-1", channel: "room" };
const current = () => true;
let nextSession = 0;

/** Only the document and transaction reads used by the card path. No server, disk or transport. */
function fixture() {
    const sid = "s1";
    const id = ++nextSession as ConversationId;
    const card: Surface = {
        v: 1,
        id: sid,
        title: "Confirm",
        status: "open",
        who: "anyone",
        by: "owner",
        taskId: "task",
        callId: "call",
        createdAt: 1,
        updatedAt: 1,
        rev: 1,
        pv: 1,
        root: "agree",
        components: { agree: { type: "CheckBox", bind: "/agree", label: "Agree" } },
        data: { agree: false },
    };
    const state: SurfacesState = { seq: 1, items: { [sid]: card } };
    const steering = new Set(["owner", "creator", "waiter"]);
    let beforeSignal: (() => void) | undefined;
    let beforeDoc: (() => void) | undefined;
    const app = {
        steeringUser: (session: ConversationId, by: string) =>
            session === id && steering.has(by)
                ? { id: by, name: by, role: by === "owner" ? "owner" : "guest" }
                : undefined,
        harness: {
            snapshot: async () => structuredClone(state),
            commit: (body: (tx: unknown) => Promise<unknown>) =>
                body({
                    signal: async () => {
                        beforeSignal?.();

                        return "delivered";
                    },
                    doc: async () => {
                        beforeDoc?.();
                        beforeDoc = undefined;

                        return state;
                    },
                }),
        },
    } as unknown as PocketApp;
    const prepare = (where: SurfaceWhere = route) => prepareRelay(app, id, sid, where);
    const confirm = (
        prepared: Awaited<ReturnType<typeof prepare>>,
        receipt: RelayReceipt,
        isCurrent = current,
    ) => recordSent(app, id, sid, prepared, receipt, isCurrent);
    const act = (overrides: Partial<RelayMessage> = {}) =>
        fromRelay(app, id, {
            ...route,
            isCurrent: current,
            text: "s1 1",
            by: "owner",
            ownerIds: [],
            author: { id: "viewer" },
            ...overrides,
        });

    return {
        app,
        id,
        sid,
        card,
        prepare,
        confirm,
        act,
        steering,
        atSignal: (run: () => void) => {
            beforeSignal = run;
        },
        atRead: (run: () => void) => {
            beforeDoc = run;
        },
    };
}

test("only a matching receipt can replace the last confirmed card", async () => {
    const { card, prepare, confirm, act } = fixture();
    const pending = await prepare();

    assert.deepEqual(await act(), { handled: false }, "preparation is not a delivery");
    await confirm(pending, { id: "m1", channel: "room" });

    const first = await prepare({ ...route, channel: "one" });
    const second = await prepare({ ...route, channel: "two" });

    await confirm(first, { id: "stale", channel: "one" });
    assert.equal(card.relay?.msgId, "m1");
    assert.deepEqual(await act({ channel: "one" }), { handled: false });
    assert.deepEqual(await act({ channel: "two" }), { handled: false });
    await confirm(second, { id: "m2", channel: "two" });
    await confirm(first, { id: "late", channel: "one" });
    await confirm(second, { id: "duplicate", channel: "two" });
    assert.equal(card.relay?.msgId, "m2");
    assert.deepEqual(await act(), { handled: false }, "the old route is gone");
    assert.equal((await act({ channel: "two" })).handled, true);
    assert.equal(card.data.agree, true);
});

test("an unconfirmed, mismatched or stale delivery creates no route", async () => {
    const { card, prepare, confirm, act, atRead } = fixture();

    for (const receipt of [
        {},
        { channel: "" },
        { id: "only-id" },
        { channel: "wrong" },
        { channel: "room", thread: "wrong" },
    ]) {
        await confirm(await prepare(), receipt);
        assert.equal(card.relay, undefined);
    }

    const pending = await prepare();
    let live = true;

    atRead(() => {
        live = false;
    });
    await confirm(pending, { channel: "room" }, () => live);
    assert.equal(card.relay, undefined, "the route expired while waiting for the document");

    const stale = await prepare();

    card.rev++;
    await confirm(stale, { channel: "room" });
    assert.equal(card.relay, undefined);

    const closed = await prepare();

    card.status = "done";
    await confirm(closed, { channel: "room" });
    assert.deepEqual(await act(), { handled: false });
});

test("a card acts only on its confirmed instance, revision and destination", async () => {
    const { card, act, prepare, confirm } = fixture();
    const where = { ...route, thread: "thread" };

    await confirm(await prepare(where), { channel: "room", thread: "thread", id: "m1" });

    for (const changed of [
        { connector: "same-name-new-connector" },
        { routeRevision: "other" },
        { channel: "other" },
        { thread: "other" },
        { thread: undefined },
        { isCurrent: undefined },
    ]) {
        assert.deepEqual(await act({ thread: "thread", replyTo: "m1", ...changed }), {
            handled: false,
        });
    }

    assert.equal(card.data.agree, false);
    assert.equal((await act({ thread: "thread", text: "1", replyTo: "m1" })).handled, true);
});

test("a root message can start a reply thread, but unrelated threads cannot use that message or its echoes", async () => {
    const { app, id, sid, act, prepare, confirm } = fixture();

    await confirm(await prepare(), { channel: "room", id: "room:root" });
    assert.deepEqual(await act({ replyTo: "room:root", thread: "unrelated" }), { handled: false });

    const answer = await act({ replyTo: "room:root", thread: "root", text: "1" });

    assert.ok(answer.handled && answer.echo);
    await recordEcho(app, id, sid, "echo", answer.echo);
    assert.deepEqual(await act({ text: "1", replyTo: "echo" }), { handled: false });
    assert.equal((await act({ text: "1", replyTo: "echo", thread: "root" })).handled, true);
});

test("unverified stored routes stay inactive until a fresh confirmed send", async () => {
    const { card, act, prepare, confirm } = fixture();

    card.relay = {
        connector: route.connector,
        channel: "room",
        msgId: "old",
        generation: "old",
        pv: 1,
        map: { "1": { kind: "toggle", path: "/agree" } },
    };
    assert.deepEqual(await act({ text: "1", replyTo: "old" }), { handled: false });
    await confirm(
        await prepare({ connector: route.connector, routeRevision: route.routeRevision }),
        { channel: "room" },
    );
    assert.equal(
        (await act()).handled,
        true,
        "a confirmed id-less post accepts named actions in its exact destination",
    );
    assert.deepEqual(await act({ text: "1", replyTo: "old" }), { handled: false });
});

test("an event replay and an obsolete echo cannot authorize a new message view", async () => {
    const { app, id, sid, card, act, prepare, confirm } = fixture();
    let live = true;

    await confirm(await prepare(), { id: "m1", channel: "room" });

    const first = await act({ eventId: "event", isCurrent: () => live });
    const replay = await act({ eventId: "event" });

    assert.ok(first.handled && first.echo);
    assert.ok(replay.handled && replay.echo === undefined);
    assert.equal(card.data.agree, true);
    live = false;
    await recordEcho(app, id, sid, "late", first.echo);
    assert.deepEqual(await act({ text: "1", replyTo: "late" }), { handled: false });
});

test("an echo receipt cannot bind after the connector person loses access", async () => {
    const { app, id, sid, card, act, prepare, confirm, steering, atRead } = fixture();

    card.by = "creator";
    await confirm(await prepare(), { id: "m1", channel: "room" });
    const result = await act();

    assert.ok(result.handled && result.echo);
    atRead(() => steering.delete("owner"));
    await recordEcho(app, id, sid, "late", result.echo);
    assert.equal(card.relay?.echoes, undefined);
});

test("a cached result still needs the current connector person and the same delivery", async () => {
    for (const changed of ["person", "delivery"]) {
        const { card, act, prepare, confirm, atRead, steering } = fixture();
        const action = { eventId: "event" };

        card.by = "creator";
        await confirm(await prepare(), { id: "m1", channel: "room" });
        assert.equal((await act(action)).handled, true);
        const rev = card.rev;

        atRead(() => {
            if (changed === "person") {
                steering.delete("owner");
            } else {
                card.relay!.generation = "another-send";
            }
        });
        assert.equal((await act(action)).handled, false, changed);
        assert.equal(card.rev, rev);
    }
});

test("a confirmed owner action rechecks the route and each requester after the signal read", async () => {
    for (const change of ["none", "route", "creator", "owner", "waiter"]) {
        const { card, act, prepare, confirm, atSignal, steering } = fixture();
        let live = true;

        card.who = "owner";
        card.by = "creator";
        card.components.agree = {
            type: "Button",
            label: "Agree",
            action: { event: { name: "agree" } },
        };
        card.wait = { key: "wait", taskId: "2", gen: 1, until: 1000, by: "waiter" };
        await confirm(await prepare(), { id: "m1", channel: "room" });

        const action = {
            by: "owner",
            ownerIds: ["account"],
            author: { id: "account" },
            isCurrent: () => live,
            eventId: "confirmation",
        };

        assert.equal((await act(action)).handled, false, "an account needs proof");
        atSignal(() => {
            if (change === "route") {
                live = false;
            } else if (change !== "none") {
                steering.delete(change);
            }
        });
        const result = await act({ ...action, trusted: true });

        assert.equal(result.handled, change === "none", change);
        assert.equal(card.status, change === "none" ? "done" : "open", change);
        assert.equal(card.checkedSignal, change === "none" ? "wait" : undefined, change);
        assert.equal(card.seen?.length ?? 0, change === "none" ? 1 : 0, change);
    }
});

test("a route replaced between reading the card and applying a number cannot act", async () => {
    const { card, act, prepare, confirm, atRead } = fixture();

    await confirm(await prepare(), { id: "m1", channel: "room" });
    atRead(() => {
        card.relay!.generation = "new-send";
    });
    assert.equal((await act()).handled, false);
    assert.equal(card.data.agree, false);

    let live = true;

    atRead(() => {
        live = false;
    });
    assert.equal((await act({ isCurrent: () => live })).handled, false);
    assert.equal(card.data.agree, false);
});
