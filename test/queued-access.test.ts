import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import type { PocketApp } from "../src/server/app.ts";
import { Commands } from "../src/server/commands.ts";
import { HeldDoc } from "../src/server/docs.ts";
import { interruptTask, resendTask } from "../src/server/resend.ts";
import { TurnNotes } from "../src/server/turn-notes.ts";

const id = 1 as unknown as ConversationId;
const requester = {
    id: "current",
    role: "guest",
    name: "Pat",
    tokenHash: "",
    createdAt: 0,
} as const;
const canSteer = (target: ConversationId, by: string | undefined) =>
    target === id && by === requester.id;
const steeringUser = (target: ConversationId, by: string | undefined) =>
    canSteer(target, by) ? requester : undefined;

const noop = () => {};

const held = (requestId: string) => ({
    requestId,
    key: requestId,
    content: requestId,
    mode: "followUp" as const,
});
const ids = ["u:current:1", "u:old:2", "p:current:3", "p:old:4", "legacy-unattributed"];

test("queue cleanup settles only unauthorized inputs and preserves authorized messages and queue writes", async () => {
    const heldDoc = { items: ids.map(held) };
    const inbox = {
        items: [
            ...ids.map((_, index) => ({ id: index, mode: "followUp" })),
            { id: 6, mode: "write" },
        ],
    };
    const settled: number[] = [];
    const tx = {
        doc: (token: unknown) =>
            token === InboxDoc ? inbox : token === HeldDoc ? heldDoc : assert.fail(),
        submission: (index: number) => ({ requestId: ids[index] }),
        settleSubmission: (index: number, reason: object) => {
            assert.deepEqual(reason, { status: "unanswered", reason: "aborted" });
            settled.push(index);
        },
    };
    const commands = new Commands({
        steeringUser,
        harness: { snapshot: tx.doc, commit: (fn: (t: typeof tx) => unknown) => fn(tx) },
    } as unknown as PocketApp);

    await commands.pruneQueued([id], requester.id);
    assert.deepEqual(settled, []);
    await commands.pruneQueued([id], "old");
    assert.deepEqual(settled, [1, 3]);
    assert.deepEqual(
        heldDoc.items.map((item) => item.requestId),
        [ids[0], ids[2], ids[4]],
    );
    await commands.pruneQueued([id]);
    await commands.pruneQueued([id]);
    assert.deepEqual(settled, [1, 3, 4]);
    assert.deepEqual(
        inbox.items.map((item) => item.id),
        [0, 2, 6],
    );
    assert.deepEqual(
        heldDoc.items.map((item) => item.requestId),
        [ids[0], ids[2]],
    );
});

test("startup does not create queue documents for an empty session", async () => {
    const commands = new Commands({
        steeringUser,
        harness: { snapshot: () => undefined, commit: () => assert.fail("no document needed") },
    } as unknown as PocketApp);

    await commands.pruneQueued([id]);
});

test("sending held messages checks the original requester separately from the driver", async () => {
    const doc = { items: ids.map(held) };
    const tx = { doc: () => doc };
    const sent: string[] = [];
    const commands = new Commands({
        steeringUser,
        requireSee: noop,
        requireSteer: noop,
        requireDriver: noop,
        pip: { ownerOf: () => undefined },
        sandboxes: { requireDelivery: noop },
        spend: { check: noop },
        collab: { activity: noop },
        conversation: () => ({
            submit: (_tx: unknown, draft: { requestId: string }) => sent.push(draft.requestId),
        }),
        harness: {
            snapshot: () => structuredClone(doc),
            commit: (fn: (t: typeof tx) => unknown) => fn(tx),
        },
    } as unknown as PocketApp);

    assert.equal(await commands.sendHeld(id, requester), 2);
    assert.deepEqual(sent, [ids[0], ids[2]]);
    assert.deepEqual(doc.items, []);
});

test("an interrupt rechecks its sender before stopping and checks each restored input at admission", async () => {
    const sent: string[] = [];
    const interrupts = { pending: { [ids[1]!]: 10 } };
    const tx = { submissionByRequest: () => undefined, doc: () => interrupts };
    const runtime = {
        conversationId: id,
        report: (error: unknown) => assert.fail(String(error)),
        commit: (fn: (t: typeof tx) => unknown) => fn(tx),
        conversation: () => ({
            submit: (_tx: unknown, draft: { requestId: string }) => sent.push(draft.requestId),
        }),
    };
    const input = { content: "interrupt", requestId: ids[1], run: 10, others: ids.map(held) };

    await interruptTask(
        () => assert.fail("no stop"),
        canSteer,
        () => {},
    ).definition.phases.send({ input } as never, runtime as never, BACKGROUND_CONTEXT);
    assert.deepEqual(sent, [ids[0], ids[2]]);
    assert.deepEqual(interrupts.pending, {});

    // The run can finish stopping after the person's access changes.
    let stopping = true;

    await interruptTask(
        async () => {
            stopping = false;
        },
        (target, person) => (person === "old" ? stopping : canSteer(target, person)),
        () => {},
    ).definition.phases.send({ input } as never, runtime as never, BACKGROUND_CONTEXT);
    assert.deepEqual(sent.splice(0), [ids[0], ids[2], ids[0], ids[2]]);

    for (const by of ["old", "current"]) {
        await resendTask(
            canSteer,
            async () => new Set(),
            () => {},
        ).definition.phases.send(
            { input: { text: "fork", by } } as never,
            runtime as never,
            BACKGROUND_CONTEXT,
        );
    }

    assert.deepEqual(sent, ["u:current:resend"]);
});

test("turn notes cannot admit a message after its requester loses access during annotation", async () => {
    let allowed = true;
    const tx = { submissionByRequest: () => undefined, doc: () => ({ items: [] }) };
    const notes = new TurnNotes({
        harness: {
            snapshot: () => ({ items: [] }),
            commit: (fn: (t: typeof tx) => unknown) => fn(tx),
        },
        hidden: { replace: (text: string) => text },
        notice: noop,
    } as unknown as PocketApp);
    const conversation = {
        id,
        entries: () => ({ items: [] }),
        submit: () => assert.fail("no annotated submission"),
    };

    notes.add("test", () => {
        allowed = false;

        return "note";
    });
    await assert.rejects(
        notes.submit(
            conversation as never,
            { type: "input", content: "message", requestId: "u:current:test" },
            { by: "current", text: "message", at: 0 },
            BACKGROUND_CONTEXT,
            () => {},
            () => {
                if (!allowed) {
                    throw new Error("access ended");
                }
            },
        ),
        /access ended/,
    );
});

test("a prepared input requires current steering access at admission", async () => {
    let available = true;
    const tx = { submissionByRequest: () => undefined };
    const commands = new Commands({
        steeringUser: () => (available ? requester : undefined),
        requireSee: noop,
        requireSteer: noop,
        requireDriver: noop,
        pip: { ownerOf: () => undefined },
        spend: { check: noop },
        parentOf: () => undefined,
        conversation: () => ({ id, submit: () => assert.fail("no submission") }),
        hidden: { replace: (text: string) => text },
        agentState: () => ({ model: {} }),
        models: { getModel: () => ({ input: ["text"] }) },
        config: { users: [requester] },
        harness: { commit: (fn: (t: typeof tx) => unknown) => fn(tx) },
        now: () => 0,
        turnNotes: {
            submit: () => {
                available = false;
            },
        },
    } as unknown as PocketApp);

    await assert.rejects(
        commands.submit(id, requester, { text: "message", requestId: "example" }),
        /no longer steer/,
    );
});
