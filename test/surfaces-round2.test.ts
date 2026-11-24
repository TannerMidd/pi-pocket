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
import { after, before, mock, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SurfacesDoc } from "../src/server/docs.ts";
import createSurfaces from "../src/server/extensions/surfaces.ts";
import { HttpError } from "../src/server/errors.ts";
import { actAs } from "../src/server/surfaces/act.ts";
import { fromRelay, prepareRelay, recordEcho, recordSent } from "../src/server/surfaces/relay.ts";
import { addSurface } from "../src/server/surfaces/store.ts";
import { type Surface, type SurfacesState } from "../src/server/surfaces/types.ts";
import { flatten } from "../src/server/surfaces/validate.ts";

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
    const ui = createSurfaces({ requesterOf: () => owner(app).id, canSteer: () => true } as never)
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

const form = {
    action: "show",
    title: "Form",
    data: { name: "", agree: false },
    components: [
        {
            type: "Column",
            children: [
                { type: "TextField", id: "name", label: "Name", bind: "/name" },
                { type: "CheckBox", id: "agree", label: "Agree", bind: "/agree" },
                {
                    type: "Button",
                    id: "go",
                    label: "Go",
                    action: { event: { name: "go", resolves: false } },
                },
            ],
        },
    ],
};
const route = { connector: "connector-id", routeRevision: "revision" };

async function sent(id: ConversationId, sid: string, msgId: string) {
    const prepared = await prepareRelay(app, id, sid, route);

    await recordSent(app, id, sid, prepared, { id: msgId, channel: "room-1" }, () => true);
}

const message = (text: string, more: object = {}) => ({
    ...route,
    isCurrent: () => true,
    channel: "room-1",
    text,
    replyTo: "m1",
    author: { id: "me", name: "Me" },
    ownerIds: ["me"],
    trusted: true,
    by: owner(app).id,
    ...more,
});
const actor = () => ({ id: owner(app).id, name: owner(app).name, role: owner(app).role });

test("a reply that names an ended card is refused, and never reaches the newest card", async () => {
    const { id, run, card: old } = await made(form);

    await sent(id, old.id, "m1");
    await run({ action: "close", id: old.id }, { task: "t1", call: "c5" });
    await run({ ...form, title: "Newer" }, { task: "t1", call: "c6" });

    const fresh = Object.values(await surfaces(id)).find((each) => each.status === "open")!;

    await sent(id, fresh.id, "m2");

    const outcome = await fromRelay(app, id, message("2", { replyTo: "m1" }));

    assert.equal(outcome.handled, false);
    assert.match((outcome as { refusal?: string }).refusal ?? "", /has ended/);
    assert.equal((await surfaces(id))[fresh.id]!.data.agree, false, "the newest card is untouched");
    assert.equal((await fromRelay(app, id, message("2", { replyTo: "m2" }))).handled, true);
});

test("each card message keeps the numbers it displayed", async () => {
    const { id, run, card } = await made({
        ...form,
        data: { enabled: false },
        components: [
            {
                type: "Column",
                children: [
                    { type: "CheckBox", id: "enable", label: "Enable", bind: "/enabled" },
                    {
                        type: "Button",
                        id: "early",
                        label: "Early",
                        disabled: { "@call": "not", args: { value: { "@path": "/enabled" } } },
                        action: { event: { name: "early", resolves: false } },
                    },
                    {
                        type: "Button",
                        id: "later",
                        label: "Later",
                        action: { event: { name: "later", resolves: false } },
                    },
                ],
            },
        ],
    });

    await sent(id, card.id, "m1");

    const toggled = await fromRelay(app, id, message("1"));

    assert.equal(toggled.handled, true);

    if (!toggled.handled) {
        return;
    }

    assert.match(toggled.reply, /2 Early\n3 Later/);
    await recordEcho(app, id, card.id, "m2", toggled.echo!);

    const echoed = await fromRelay(app, id, message("2", { replyTo: "m2" }));
    const original = await fromRelay(app, id, message("2"));
    const named = await fromRelay(app, id, message(`${card.id} 2`, { replyTo: undefined }));

    assert.equal(echoed.handled && echoed.reply, "s1: Early pressed.");
    assert.equal(original.handled && original.reply, "s1: Later pressed.");
    assert.equal(named.handled && named.reply, "s1: Early pressed.");

    await run(
        {
            action: "patch",
            id: card.id,
            ops: [{ op: "props", id: "early", props: { label: "New" } }],
        },
        { task: "t1", call: "c2" },
    );

    for (const replyTo of ["m1", "m2"]) {
        assert.deepEqual(await fromRelay(app, id, message("2", { replyTo })), {
            handled: false,
            refusal: "Card s1 changed. Look at the new one.",
        });
    }
});

test("unverified legacy relay records do not accept replies", async () => {
    const { id, card } = await made(form);

    await app.harness.commit(async (tx) => {
        (await tx.doc(SurfacesDoc, id)).items[card.id]!.relay = {
            connector: route.connector,
            channel: "room-1",
            msgId: "m1",
            echoes: ["m2"],
            pv: card.pv,
            map: { "2": { kind: "toggle", path: "/agree" } },
        };
    }, context);
    assert.equal((await fromRelay(app, id, message("2"))).handled, false);
    assert.equal((await fromRelay(app, id, message("2", { replyTo: "m2" }))).handled, false);
    assert.equal((await surfaces(id))[card.id]!.data.agree, false);
});

test("an echo from an older relay send cannot attach to a newer send", async () => {
    const { id, card } = await made(form);

    await sent(id, card.id, "m1");

    const pending = await fromRelay(app, id, message("2"));

    assert.equal(pending.handled, true);

    if (!pending.handled) {
        return;
    }

    await sent(id, card.id, "m-new");
    await recordEcho(app, id, card.id, "m-old-echo", pending.echo!);
    assert.deepEqual(await fromRelay(app, id, message("2", { replyTo: "m-old-echo" })), {
        handled: false,
    });
    assert.equal((await surfaces(id))[card.id]!.data.agree, true);
    assert.equal((await surfaces(id))[card.id]!.relay?.echoes?.length ?? 0, 0);
});

test("a chat message that is tried again acts once", async () => {
    const { id, run, card } = await made(form);

    await sent(id, card.id, "m1");

    const first = await fromRelay(app, id, message("2", { eventId: "ev-1" }));
    const again = await fromRelay(app, id, message("2", { eventId: "ev-1" }));

    assert.equal(first.handled, true);
    assert.equal(again.handled, true);
    assert.equal((await surfaces(id))[card.id]!.data.agree, true, "toggled once, not back");
    assert.equal((await surfaces(id))[card.id]!.seen!.length, 1);
    await fromRelay(app, id, message("2", { eventId: "ev-2" }));
    assert.equal((await surfaces(id))[card.id]!.data.agree, false, "another message counts");
    void run;
});

test("a full queue refuses a new action and keeps the card as it was", async () => {
    const { id, card } = await made(form);
    const down = mock.method(app.inbox, "deliver", async () => {
        throw new HttpError(409, "The session does not take messages now.");
    });

    try {
        await app.harness.commit(async (tx) => {
            (await tx.doc(SurfacesDoc, id)).items[card.id]!.pending = Array.from(
                { length: 20 },
                (_, at) => ({
                    rev: at + 1,
                    name: "go",
                    text: `old ${at}`,
                    by: "",
                    sender: { name: "Me", id: "me", trusted: true },
                }),
            );
        }, context);

        await assert.rejects(
            actAs(app, id, actor(), card.id, {
                pv: card.pv,
                set: { "/name": "late" },
                event: "go",
            }),
            (error: unknown) =>
                error instanceof HttpError && /too many|not yet delivered/i.test(error.message),
        );

        const after = (await surfaces(id))[card.id]!;

        assert.equal(after.pending!.length, 20);
        assert.equal(after.pending![0]!.text, "old 0", "the oldest is still there");
        assert.equal(after.data.name, "", "the card did not change");
    } finally {
        down.mock.restore();
    }
});

test("an ended card with an answer not yet delivered is not removed to make room", () => {
    const parts = () => flatten([{ type: "Text", text: "x" }]);
    const state: SurfacesState = { seq: 0, items: {} };

    for (let at = 1; at <= 40; at += 1) {
        const made = addSurface(state, {
            title: `c${at}`,
            who: "owner",
            by: "",
            taskId: "t",
            callId: `c${at}`,
            now: at,
            parts: { ...parts(), data: {} },
        });

        made.status = "done";

        if (at === 1) {
            made.pending = [
                {
                    rev: 1,
                    name: "go",
                    text: "x",
                    by: "",
                    sender: { name: "Me", id: "me", trusted: true },
                },
            ];
        }
    }

    addSurface(state, {
        title: "next",
        who: "owner",
        by: "",
        taskId: "t",
        callId: "next",
        now: 99,
        parts: { ...parts(), data: {} },
    });
    assert.ok(state.items.s1, "the card with the pending answer stays");
    assert.equal(state.items.s2, undefined, "the next oldest went instead");
});

test("an action whose message the inbox would clip is refused, and a message stays whole", async () => {
    const big = {
        ...form,
        data: { name: "", agree: false, big: Array.from({ length: 5 }, () => "y".repeat(1900)) },
        components: [
            {
                type: "Column",
                children: [
                    { type: "TextField", id: "name", label: "Name", bind: "/name" },
                    {
                        type: "Button",
                        id: "go",
                        label: "Go",
                        action: { event: { name: "go", context: { rows: { "@path": "/big" } } } },
                    },
                ],
            },
        ],
    };
    const { id, card } = await made(big);

    await assert.rejects(
        actAs(app, id, actor(), card.id, { pv: card.pv, set: { "/name": "x" }, event: "go" }),
        (error: unknown) => error instanceof HttpError && error.status === 413,
    );
    assert.equal((await surfaces(id))[card.id]!.status, "open");
    assert.equal((await surfaces(id))[card.id]!.pending, undefined);
    assert.equal((await surfaces(id))[card.id]!.data.name, "");
});

test("filled fields cannot push a card past its size, which would block every patch", async () => {
    const fields = Array.from({ length: 30 }, (_, at) => ({
        type: "TextField",
        id: `f${at}`,
        label: `F${at}`,
        bind: `/f${at}`,
    }));
    const { id, run, card } = await made({
        action: "show",
        title: "Long form",
        data: Object.fromEntries(fields.map((each) => [each.id, ""])),
        components: [{ type: "Column", children: fields }],
    });
    const statuses: number[] = [];

    for (let batch = 0; batch < 5; batch += 1) {
        const set = Object.fromEntries(
            fields.slice(batch * 6, batch * 6 + 6).map((each) => [`/${each.id}`, "x".repeat(1900)]),
        );

        statuses.push(
            await actAs(app, id, actor(), card.id, { pv: card.pv, set }).then(
                () => 200,
                (error: unknown) => (error as HttpError).status,
            ),
        );
    }

    assert.ok(statuses.includes(413), `an input was refused: ${statuses.join(" ")}`);

    const stored = (await surfaces(id))[card.id]!;

    assert.ok(
        JSON.stringify({ components: stored.components, data: stored.data }).length <= 48 * 1024,
    );

    const patched = (await run(
        { action: "patch", id: card.id, ops: [{ op: "set", path: "/f29", value: "ok" }] },
        { task: "t1", call: "p1" },
    )) as { isError?: boolean };

    assert.equal(patched.isError, undefined, "a patch still works");
});
