import assert from "node:assert/strict";
import { test } from "node:test";
import {
    type ConversationId,
    LiveDoc,
    type Storage,
    type TaskId,
} from "@earendil-works/pi-durable";
import { PocketApp } from "../src/server/app.ts";
import { Attribution } from "../src/server/attribution.ts";
import { HttpError } from "../src/server/errors.ts";
import createSurfaces from "../src/server/extensions/surfaces.ts";
import { actAs } from "../src/server/surfaces/act.ts";
import { deliverPending, PendingActions } from "../src/server/surfaces/pending.ts";
import { Inbox } from "../src/server/inbox.ts";
import { addSurface, startWait } from "../src/server/surfaces/store.ts";
import type { Surface, SurfacesState } from "../src/server/surfaces/types.ts";

const session = 1 as ConversationId;
const other = 2 as ConversationId;

function fixture() {
    const state: SurfacesState = { seq: 0, items: {} };
    const stopped: number[] = [];
    const submitted: string[] = [];
    const allowed = new Set(["owner", "guest", "peer"]);
    const app = {
        harness: {
            commit: async (act: (tx: unknown) => unknown) =>
                act({
                    submissionByRequest: async () => undefined,
                    doc: async (doc: unknown) =>
                        doc === LiveDoc ? { tools: [{ taskId: 37, status: "running" }] } : state,
                }),
            snapshot: async () => state,
            abortTask: async (task: number) => stopped.push(task),
        },
        commands: {
            submit: async (_id: ConversationId, user: { id: string }) => submitted.push(user.id),
        },
        rootOf: (id: ConversationId) => id,
        sessionMeta: (id: ConversationId) => (id === session ? {} : undefined),
        config: {
            userById: (id: string) =>
                id === "absent"
                    ? undefined
                    : { id, role: id === "owner" ? "owner" : id === "viewer" ? "viewer" : "guest" },
        },
        canSee: (person: { id: string }, id: ConversationId) =>
            id === session && allowed.has(person.id),
        steeringUser: PocketApp.prototype.steeringUser,
        now: () => 1,
        inbox: {} as Inbox,
        log: () => {},
    };
    const pocket = app as unknown as PocketApp;

    app.inbox = new Inbox(pocket);
    const make = (by: string) =>
        addSurface(state, {
            title: "Choice",
            who: "anyone",
            by,
            taskId: `tool-${state.seq}`,
            callId: "show",
            now: 1,
            parts: {
                root: "go",
                components: {
                    go: { type: "Button", label: "Go", action: { event: { name: "go" } } },
                },
                data: {},
            },
        });

    return { pocket, allowed, make, state, stopped, submitted };
}

const pending = (surface: Surface) => {
    surface.pending = [
        {
            rev: surface.rev,
            by: surface.by,
            name: "go",
            text: "chosen",
            sender: { name: "Peer", id: "peer", trusted: false },
        },
    ];
};

test("recovered actions and waits keep their own requester, never the current owner", async () => {
    const { pocket, allowed, state, make, stopped } = fixture();
    const absent = make("absent");
    const guest = make("guest");
    const owner = make("owner");
    const peer = make("peer");
    const legacy = make("");
    const waiting = make("owner");
    const viewer = make("viewer");

    startWait(waiting, "37", 1000, "guest");

    for (const surface of [absent, guest, owner, peer, legacy, viewer]) {
        pending(surface);
    }

    const actions = new PendingActions(pocket);

    actions.note(session, state.items);
    allowed.delete("guest");
    await actions.cancelRevoked("guest");
    assert.deepEqual(stopped, [37]);
    assert.equal(waiting.status, "cancelled");
    assert.equal(guest.status, "cancelled");
    assert.equal(guest.pending, undefined);
    assert.equal(legacy.status, "open", "an unrelated grant change does not cancel legacy cards");
    await actions.cancelRevoked();

    for (const card of [absent, guest, legacy, viewer]) {
        assert.equal(card.status, "cancelled");
        assert.equal(card.pending, undefined);
    }

    for (const card of [peer, owner]) {
        assert.equal(card.status, "open");
        assert.equal(card.pending?.length, 1);
    }

    assert.equal(pocket.steeringUser(other, "guest"), undefined);
    actions.close();
});

test("retry delivers only under the recorded current requester", async () => {
    const { pocket, make, submitted, allowed } = fixture();

    allowed.delete("guest");

    for (const by of ["", "absent", "viewer", "guest", "peer", "owner"]) {
        const card = make(by);

        pending(card);
        assert.equal(await deliverPending(pocket, session, card.id), true);
        assert.equal(card.pending, undefined);
    }

    const legacyRelayCard = make("owner");

    legacyRelayCard.relay = { connector: "old", channel: "chat", pv: 1, map: {} };
    pending(legacyRelayCard);
    assert.equal(await deliverPending(pocket, session, legacyRelayCard.id), true);
    assert.equal(legacyRelayCard.pending, undefined);
    assert.deepEqual(submitted, ["peer", "owner"]);
});

test("an action cannot wake a wait after either requester's access ends", async () => {
    const { pocket, make, allowed } = fixture();
    const surface = make("owner");

    startWait(surface, "guest-wait", 1000, "guest");
    allowed.delete("guest");
    await assert.rejects(
        actAs(pocket, session, { id: "peer", role: "guest", name: "Peer" }, surface.id, {
            pv: 1,
            event: "go",
        }),
        (error) => error instanceof HttpError && error.status === 403,
    );
    assert.equal(surface.rev, 1);
    assert.equal(surface.pending, undefined);
});

test("a parked tool checks its captured requester again before returning signal values", async () => {
    const { pocket, state, make, allowed } = fixture();
    const surface = make("owner");

    startWait(surface, "wait-task", 1000, "guest");
    const checkpoint = { id: surface.id, ...surface.wait };
    const tool = createSurfaces({
        requesterOf: () => "owner",
        canSteer: (id: ConversationId, by: string) => pocket.steeringUser(id, by) !== undefined,
    } as never).tools![0]! as unknown as {
        execute(
            given: unknown,
            api: unknown,
            context: unknown,
        ): Promise<{ isError?: boolean; structuredOutput?: unknown }>;
    };

    allowed.delete("guest");
    const result = await tool.execute(
        { action: "wait" },
        {
            conversationId: session,
            taskId: "wait-task",
            callId: "wait",
            checkpoint,
            readSignal: async () => ({
                value: { name: "go", at: 1, by: "peer", values: { choice: 1 } },
            }),
            now: () => 1,
            commit: pocket.harness.commit,
            agent: async () => ({}),
            snapshot: async () => state,
        },
        {},
    );

    assert.equal(result.isError, true);
    assert.equal(result.structuredOutput, undefined);
    assert.equal(surface.status, "cancelled");
});

test("revoking one grant selects only that person's affected runs; recovery also cancels unknown runs", async () => {
    const valid = new Map([
        [1, "owner"],
        [2, "guest"],
        [3, "peer"],
    ]);
    const attribution = new Attribution({
        steeringUser: (id: number, by?: string) =>
            by !== undefined && valid.get(id) === by ? { id: by } : undefined,
    } as never);
    const busy = new Map<ConversationId, TaskId>();
    const storage = { scanSubmissions: async () => ({ items: [] }) } as unknown as Storage;

    for (const [index, by] of ["owner", "guest", "peer", "guest", undefined].entries()) {
        const id = (index + 1) as ConversationId;

        busy.set(id, (index + 10) as TaskId);
        await attribution.recover(
            storage,
            id,
            by === undefined ? undefined : { entries: { "1": by } },
        );
    }

    assert.deepEqual(attribution.revokedRuns(busy, "guest"), [13]);
    assert.deepEqual(attribution.revokedRuns(busy), [13, 14]);
});

test("an unattributed placed input does not inherit earlier or parent authority on recovery", async () => {
    const attribution = new Attribution({ rootOf: () => session } as never);
    const storage = (items: unknown[]) =>
        ({ scanSubmissions: async () => ({ items }) }) as unknown as Storage;

    await attribution.recover(storage([]), session, { entries: { "1": "owner" } });
    await attribution.recover(storage([{ type: "input", entry: 4 }]), other, {
        entries: { "1": "guest" },
        requesters: { "4": "owner" },
    });
    assert.equal(attribution.requesterOf(other), undefined);
    assert.equal(attribution.requesterOf(session), "owner");
});
