// The 0.31.0 review fixes to the server side of Surfaces: no pattern runs on the server, a wait key serves one wait, a
// recorded action is delivered again after a failure, a card answers only where it went, a toggle is worked out in the
// commit, an unseen key is still refused, a data patch keeps `pv`, and one body can carry a value and a press.
import {
    type App,
    cleanUp,
    context,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SurfacesDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";
import { fromRelay, prepareRelay, recordSent } from "../src/server/surfaces/relay.ts";
import { applyOps } from "../src/server/surfaces/patch.ts";
import type { Surface } from "../src/server/surfaces/types.ts";
import { checkData, checkSurface, flatten } from "../src/server/surfaces/validate.ts";

const card = {
    action: "show",
    title: "Form",
    data: { name: "", agree: false, status: "idle", picks: [], rows: [{ picked: false }] },
    components: [
        {
            type: "Column",
            children: [
                { type: "Status", id: "state", label: "State", state: { "@path": "/status" } },
                { type: "TextField", id: "name", label: "Name", bind: "/name", pattern: "(a|a)*$" },
                { type: "CheckBox", id: "agree", label: "Agree", bind: "/agree" },
                {
                    type: "ChoicePicker",
                    id: "picks",
                    label: "Pick",
                    bind: "/picks",
                    multiple: true,
                    options: ["x", "y", "z"],
                },
                {
                    type: "Button",
                    id: "go",
                    label: "Go",
                    action: {
                        event: {
                            name: "go",
                            resolves: false,
                            context: { name: { "@path": "/name" }, agree: { "@path": "/agree" } },
                        },
                    },
                },
                {
                    type: "Button",
                    id: "done",
                    label: "Done",
                    action: { event: { name: "done", context: { name: { "@path": "/name" } } } },
                },
            ],
        },
    ],
};
const script = new Map<string, Record<string, unknown> | Record<string, unknown>[]>();
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return /^Surface s1 .*: go, pressed/.test(text)
            ? fauxAssistantMessage(
                  [fauxToolCall("ui", { action: "wait", id: "s1", minutes: 30 } as never)],
                  { stopReason: "toolUse" },
              )
            : fauxAssistantMessage([fauxText(`got: ${text}`)]);
    }

    const call = script.get(text.replace(/^\[from: [^\]]*\] /, ""));

    return call === undefined
        ? fauxAssistantMessage([fauxText(`ok: ${text}`)])
        : fauxAssistantMessage(
              [call].flat().map((each) => fauxToolCall("ui", each as never)),
              { stopReason: "toolUse" },
          );
});
const dir = join(root, "surfaces-fixes");
let app: App;
let server: Server;
let port = 0;
let counter = 0;

before(async () => {
    const { createHandler } = await import("../src/server/http.ts");

    app = await openApp(model, dir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

const surfaces = async (id: ConversationId) =>
    (await app.harness.snapshot(SurfacesDoc, id, context))?.items ?? {};
const stored = async (id: ConversationId) =>
    JSON.stringify(await app.transcripts.allEntries(id as never, true));

async function show(
    args: Record<string, unknown> | Record<string, unknown>[],
): Promise<{ id: ConversationId; card: Surface }> {
    const id = await newSession(app);
    const text = `show card ${(counter += 1)}`;

    await loadTools(app, id, "ui");
    script.set(text, args);
    await app.commands.submit(id, owner(app), { text, requestId: `show-${counter}` });
    await until(async () => Object.keys(await surfaces(id)).length > 0, "the surface");

    return { id, card: Object.values(await surfaces(id))[0]! };
}

/** How many messages a surface's action put in the session. */
async function viaMessages(id: ConversationId): Promise<number> {
    const entries = (await app.transcripts.allEntries(id as never, true)) as {
        kind: string;
        text?: string;
    }[];

    return entries.filter(
        (entry) => entry.kind === "user" && entry.text?.startsWith("[via surface"),
    ).length;
}

async function act(id: ConversationId, sid: string, body: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}/api/c/${id}/surfaces/${sid}/act`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });

    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

test("a pattern from Pi never runs on the server: a hostile input is answered at once", async () => {
    const { id, card: made } = await show(card);

    for (const value of ["a".repeat(1999) + "b", `${"a ".repeat(900)}!`]) {
        const started = Date.now();
        const result = await act(id, made.id, { pv: made.pv, set: { "/name": value } });

        assert.equal(result.status, 200);
        assert.ok(Date.now() - started < 1500, "no time spent on the pattern");
    }
});

test("a key with a zero-width character is the same key: __pro\\u200bto__ is refused", () => {
    assert.throws(() => checkData({ "__pro\u200bto__": 1 }), /not allowed/);
    assert.throws(
        () =>
            applyOps({ root: "r", components: { r: { type: "Column", children: [] } }, data: {} }, [
                { op: "set", path: "/__pro\u200bto__", value: 1 },
            ]),
        /not allowed/,
    );
});

test("a second wait on the same card in one task takes a new signal key", async () => {
    const { id, card: made } = await show({ ...card, wait: { minutes: 30 } });

    assert.equal(made.wait?.key, `${made.id}.1`);

    const first = await act(id, made.id, { pv: made.pv, event: "go" });

    assert.equal(first.json.delivered, "woke");
    await until(async () => (await surfaces(id))[made.id]!.wait?.key === `${made.id}.2`, "wait 2");

    const second = await act(id, made.id, { pv: made.pv, event: "done" });

    assert.equal(second.status, 200);
    assert.equal(second.json.delivered, "woke", "the second wait was woken, not refused");
    await until(async () => /got: Surface s1 “Form”: done/.test(await stored(id)), "the wake");
});

test("an A2UI update changes a card that waits, and leaves its wait alone", async () => {
    const form = (name: string, label: string) => ({
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
                            action: { event: { name } },
                        },
                    ],
                },
            },
        ],
    });
    const first = await show(form("send", "Send"));
    const { id } = first;

    // Another call of Pi's holds a wait on the card (a call cannot update it while it is itself parked).
    await app.harness.commit(async (tx) => {
        (await tx.doc(SurfacesDoc, id)).items[first.card.id]!.wait = {
            taskId: "other",
            key: `${first.card.id}.1`,
            gen: 1,
        };
    }, context);

    const made = (await surfaces(id))[first.card.id]!;

    assert.ok(made.wait !== undefined && made.a2uiRaw !== undefined);

    const text = "update the waiting card";

    script.set(text, {
        action: "a2ui",
        messages: [
            {
                updateComponents: {
                    surfaceId: "form",
                    components: [{ id: "go-label", component: "Text", text: "Later" }],
                },
            },
        ],
    });
    await app.commands.submit(id, owner(app), { text, requestId: "update-wait" });
    await until(
        async () => (await surfaces(id))[made.id]!.components.go!.label === "Later",
        "update",
    );

    const after = (await surfaces(id))[made.id]!;

    assert.deepEqual(after.wait, made.wait, "the wait is the same one");
    assert.equal(after.callId, made.callId);
});

test("a recorded action that could not be delivered is delivered again", async () => {
    const { id, card: made } = await show({ ...card, title: "No wait" });

    await until(async () => (await stored(id)).includes("Surface s1 shown"), "shown");

    const real = app.inbox.deliver.bind(app.inbox);
    const fail = mock.method(app.inbox, "deliver", async () => {
        throw new HttpError(409, "The session does not take messages now.");
    });
    const result = await act(id, made.id, { pv: made.pv, event: "done" });

    assert.equal(result.status, 200, "the action is recorded whatever the delivery does");
    assert.equal((await surfaces(id))[made.id]!.status, "done");
    assert.equal((await surfaces(id))[made.id]!.pending?.length, 1, "a mark is kept");
    assert.ok(fail.mock.callCount() >= 1);
    assert.equal(await viaMessages(id), 0);
    fail.mock.restore();
    mock.method(app.inbox, "deliver", real);
    await app.surfacePending.retry(id);
    assert.equal((await surfaces(id))[made.id]!.pending, undefined, "cleared when delivered");
    await until(async () => (await viaMessages(id)) === 1, "the message");
    mock.restoreAll();
});

test("a body with a value and a press: the context sees the value set in that same body", async () => {
    const { id, card: made } = await show({ ...card, wait: { minutes: 30 } });
    const result = await act(id, made.id, {
        pv: made.pv,
        set: { "/name": "Riley", "/agree": true },
        event: "go",
    });

    assert.equal(result.status, 200);
    await until(async () => (await stored(id)).includes("Riley"), "the values");
    assert.match(await stored(id), /\\"name\\":\\"Riley\\",\\"agree\\":true/);
    assert.equal((await surfaces(id))[made.id]!.data.name, "Riley");
});

test("a patch that touches no layout and no input keeps pv; one that does raises it", async () => {
    const { id, card: made } = await show({ ...card, title: "Patch" });

    await until(async () => (await stored(id)).includes("Surface s1 shown"), "shown");

    const rev = async () => (await surfaces(id))[made.id]!;

    const patch = async (name: string, ops: unknown[]) => {
        const seen = (await rev()).rev;

        script.set(name, { action: "patch", id: made.id, ops });
        await app.commands.submit(id, owner(app), { text: name, requestId: name });
        await until(async () => (await rev()).rev > seen, name);
    };

    await patch("patch status", [{ op: "set", path: "/status", value: "busy" }]);

    const after = await rev();

    assert.equal(after.pv, made.pv, "pv kept");
    assert.ok(after.rev > made.rev, "the card is redrawn");
    assert.equal((await act(id, made.id, { pv: made.pv, set: { "/name": "x" } })).status, 200);

    const before = (await rev()).pv;

    await patch("patch field", [{ op: "set", path: "/name", value: "y" }]);
    assert.equal((await rev()).pv, before + 1, "a bound field changed");
    await patch("patch layout", [{ op: "props", id: "state", props: { label: "S" } }]);
    assert.equal((await rev()).pv, before + 2, "a layout op");
});

test("a card answers only in the channel and thread it went to, and a toggle is worked out in the commit", async () => {
    const { id, card: made } = await show({ ...card, title: "Chat" });
    const by = owner(app).id;
    const message = (text: string, more: object = {}) => ({
        connector: "Chat",
        channel: "room-1",
        text,
        author: { id: "me", name: "Me" },
        ownerIds: ["me"],
        by,
        ...more,
    });

    await prepareRelay(app, id, made.id, { connector: "Chat" });
    await recordSent(app, id, made.id, "m1", { channel: "room-1" });

    assert.deepEqual(
        await fromRelay(app, id, message("2", { channel: "room-2" })),
        { handled: false },
        "another channel is not an answer",
    );
    assert.deepEqual(await fromRelay(app, id, message("2", { channel: undefined })), {
        handled: false,
    });
    assert.equal((await surfaces(id))[made.id]!.data.agree, false);

    // Two quick toggles from the owner make true, then false: neither reads an earlier snapshot.
    await Promise.all([fromRelay(app, id, message("2")), fromRelay(app, id, message("2"))]);
    assert.equal((await surfaces(id))[made.id]!.data.agree, false);
    await fromRelay(app, id, message("2"));
    assert.equal((await surfaces(id))[made.id]!.data.agree, true);

    // A message with attachments and no text does not throw.
    assert.deepEqual(await fromRelay(app, id, message(undefined as never)), { handled: false });

    // A stranger who may use no control of an owner card: not handled, no refusal, no names.
    assert.deepEqual(await fromRelay(app, id, message("2", { author: { id: "x", name: "X" } })), {
        handled: false,
    });

    // Two numbers of a multiple picker in one message both stick.
    await fromRelay(app, id, message("3 4"));
    assert.deepEqual((await surfaces(id))[made.id]!.data.picks, ["x", "y"]);
});

test("a small data image is accepted, a link stays at 2,000 characters", () => {
    const image = (url: string) =>
        checkSurface({ ...flatten([{ type: "Image", url, alt: "x" }]), data: {} });
    const png = `data:image/png;base64,${"A".repeat(10_000)}`;

    assert.doesNotThrow(() => image(png));
    assert.throws(() => image(`https://example.com/${"a".repeat(2000)}`), /2000|characters/);
    assert.throws(() => image(`data:image/png;base64,${"A".repeat(70_000)}`), /65536 characters/);
});

test("a locked input takes no value from a person", async () => {
    const { id, card: made } = await show({
        action: "show",
        title: "Locked",
        data: { name: "", other: "", locked: true },
        components: [
            {
                type: "Column",
                children: [
                    {
                        type: "TextField",
                        id: "name",
                        label: "Name",
                        bind: "/name",
                        disabled: { "@path": "/locked" },
                    },
                    { type: "TextField", id: "other", label: "Other", bind: "/other" },
                ],
            },
        ],
    });

    assert.equal((await act(id, made.id, { pv: made.pv, set: { "/name": "x" } })).status, 409);
    assert.equal((await surfaces(id))[made.id]!.data.name, "");
    assert.equal((await act(id, made.id, { pv: made.pv, set: { "/other": "x" } })).status, 200);
});

test("a thread card answers only in its thread", async () => {
    const { id, card: made } = await show({ ...card, title: "Thread" });
    const message = (more: object) => ({
        connector: "Chat",
        channel: "room-1",
        text: "2",
        author: { id: "me", name: "Me" },
        ownerIds: ["me"],
        by: owner(app).id,
        ...more,
    });

    await prepareRelay(app, id, made.id, { connector: "Chat", channel: "room-1", thread: "t1" });
    assert.deepEqual(await fromRelay(app, id, message({})), { handled: false }, "no thread");
    assert.deepEqual(await fromRelay(app, id, message({ thread: "t2" })), { handled: false });
    assert.equal((await surfaces(id))[made.id]!.data.agree, false);
    assert.equal((await fromRelay(app, id, message({ thread: "t1" }))).handled, true);
    assert.equal((await surfaces(id))[made.id]!.data.agree, true);
});
