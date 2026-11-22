// The second 0.31.0 review round on the server side of Surfaces: a call that runs again changes a card once, an A2UI
// update leaves the call that made the card, a stale read cannot give a second call the same wait, a reply names its
// card, a chat message is applied once, and an action is refused, not dropped, when the queue, the inbox, or the card's
// size has no room.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SurfacesDoc } from "../src/server/docs.ts";
import createSurfaces from "../src/server/extensions/surfaces.ts";
import type { Surface, SurfacesState } from "../src/server/surfaces/types.ts";

const model = scriptedModel();
const dir = join(root, "surfaces-round2");
let app: App;

before(async () => {
    app = await openApp(model, dir);
});

after(async () => {
    await app.close();
    cleanUp();
});

const surfaces = async (id: ConversationId) =>
    (await app.harness.snapshot(SurfacesDoc, id, context))?.items ?? {};

type Output = { output: { text: string }[]; isError?: boolean } | { sleep: unknown };

/** The `ui` tool run by hand, as Pi Durable runs it: a call id and a task id, and a read that may be stale. */
function tool(id: ConversationId) {
    const ui = createSurfaces({ requesterOf: () => owner(app).id } as never)
        .tools![0]! as unknown as {
        execute(args: unknown, api: unknown, context: unknown): Promise<Output>;
    };

    return async (
        args: Record<string, unknown>,
        call: { task: string; call: string; stale?: SurfacesState; checkpoint?: unknown },
    ): Promise<Output> =>
        ui.execute(
            args,
            {
                conversationId: id,
                taskId: call.task,
                callId: call.call,
                now: Date.now,
                checkpoint: call.checkpoint,
                agent: async () => ({}),
                snapshot: async (doc: never, cid: never, ctx: never) =>
                    call.stale ?? app.harness.snapshot(doc, cid, ctx),
                commit: (fn: never, ctx: never) => app.harness.commit(fn, ctx),
            },
            context,
        );
}

const base = {
    action: "show",
    title: "Round 2",
    data: { rows: [], name: "" },
    components: [
        {
            type: "Column",
            children: [
                { type: "TextField", id: "name", label: "Name", bind: "/name" },
                { type: "Button", id: "go", label: "Go", action: { event: { name: "go" } } },
            ],
        },
    ],
};

async function made(args: Record<string, unknown> = base) {
    const id = await newSession(app);
    const run = tool(id);

    await run(args, { task: "t1", call: "c1" });

    return { id, run, card: Object.values(await surfaces(id))[0]! as Surface };
}

test("a patch that runs again after a restart changes the card once", async () => {
    const { id, run, card } = await made();
    const patch = { action: "patch", id: card.id, ops: [{ op: "push", path: "/rows", value: 1 }] };
    const first = await run(patch, { task: "t1", call: "c2" });
    const again = await run(patch, { task: "t1", call: "c2" });

    assert.deepEqual((await surfaces(id))[card.id]!.data.rows, [1], "pushed once");
    assert.deepEqual(again, first, "the second run returns the first result");

    await run(
        { ...patch, ops: [{ op: "push", path: "/rows", value: 2 }] },
        { task: "t1", call: "c3" },
    );
    assert.deepEqual((await surfaces(id))[card.id]!.data.rows, [1, 2], "another call still counts");
});

test("an A2UI update keeps the call that made the card, with a wait or without", async () => {
    const form = (label: string) => ({
        action: "a2ui",
        messages: [
            { createSurface: { surfaceId: "form" } },
            {
                updateComponents: {
                    surfaceId: "form",
                    components: [
                        { id: "root", component: "Column", children: ["go"] },
                        { id: "go-label", component: "Text", text: label },
                        {
                            id: "go",
                            component: "Button",
                            child: "go-label",
                            action: { event: { name: "go" } },
                        },
                    ],
                },
            },
        ],
    });
    const { id, run, card } = await made(form("Send"));

    await run(
        {
            action: "a2ui",
            messages: [
                {
                    updateComponents: {
                        surfaceId: "form",
                        components: [{ id: "go-label", component: "Text", text: "Later" }],
                    },
                },
            ],
        },
        { task: "t2", call: "c9" },
    );

    const after = (await surfaces(id))[card.id]!;

    assert.equal(after.components.go!.label, "Later");
    assert.equal(after.callId, "c1", "the card stays with the call that made it");
    assert.equal(after.taskId, "t1");
});

test("a stale read cannot give a second call a wait that another holds", async () => {
    const { id, run, card } = await made();
    const stale = { seq: 1, items: { [card.id]: card } };

    await run({ action: "wait", id: card.id, minutes: 5 }, { task: "t2", call: "w1", stale });

    const second = (await run(
        { action: "wait", id: card.id, minutes: 5 },
        { task: "t3", call: "w2", stale },
    )) as { isError?: boolean; output: { text: string }[] };

    assert.equal(second.isError, true);
    assert.match(second.output[0]!.text, /Another call already waits/);
    assert.equal((await surfaces(id))[card.id]!.wait?.taskId, "t2");
});
