// Pocket Surfaces (docs/design/surfaces.md): the `ui` tool shows an interactive card; a person's action comes back as
// values. Park and signal across a restart, the layout checks, atomic patches, the act route's checks (who, pv, bound
// paths), the message for a card nobody waits on, a deadline and Stop, and the text forms.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SurfacesDoc } from "../src/server/docs.ts";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";
import { dataFromSteps } from "../src/server/surfaces/a2ui.ts";
import { applyOps } from "../src/server/surfaces/patch.ts";
import { SurfaceActed } from "../src/server/surfaces/signal.ts";
import { toText } from "../src/server/surfaces/text.ts";
import type { Surface } from "../src/server/surfaces/types.ts";
import { checkSurface, clean, flatten, SurfaceError } from "../src/server/surfaces/validate.ts";
import { bytes, checkExpr, evaluate, evaluateComputed } from "../web/surfaces-expr.js";

const cleanup = {
    action: "show",
    title: "Cleanup dry run",
    wait: { minutes: 120 },
    data: {
        rows: [
            { name: "/tmp/a", size: 4200000000, picked: true },
            { name: "/tmp/b", size: 9700000000, picked: false },
        ],
        note: "",
    },
    computed: {
        gb: {
            "@call": "bytes",
            args: {
                value: {
                    "@call": "sum",
                    args: { list: "/rows", field: "size", where: "picked" },
                },
            },
        },
    },
    components: [
        {
            type: "Column",
            children: [
                {
                    type: "Table",
                    id: "table",
                    rows: "/rows",
                    select: "picked",
                    columns: [
                        { label: "Path", value: "name" },
                        { label: "Size", value: "size", format: "bytes" },
                    ],
                },
                { type: "TextField", id: "note", label: "Note", bind: "/note", max: 20 },
                {
                    type: "Text",
                    text: { "@call": "formatString", args: { value: "${/$/gb} selected" } },
                },
                {
                    type: "Row",
                    children: [
                        {
                            type: "Button",
                            id: "delete",
                            label: "Delete",
                            style: "danger",
                            action: {
                                event: {
                                    name: "delete",
                                    confirm: "Delete the selected paths?",
                                    context: {
                                        paths: {
                                            "@call": "pick",
                                            args: { list: "/rows", field: "name", where: "picked" },
                                        },
                                    },
                                },
                            },
                        },
                        {
                            type: "Button",
                            id: "refresh",
                            label: "Refresh",
                            action: { event: { name: "refresh", resolves: false } },
                        },
                    ],
                },
            ],
        },
    ],
};
const script = new Map<string, Record<string, unknown>>();
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);
    const call = script.get(text.replace(/^\[from: [^\]]*\] /, ""));

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`got: ${text}`)]);
    }

    return call === undefined
        ? fauxAssistantMessage([fauxText(`ok: ${text}`)])
        : fauxAssistantMessage([fauxToolCall("ui", call as never)], { stopReason: "toolUse" });
});
let skew = 0;
const clock = () => Date.now() + skew;
const dir = join(root, "surfaces");
let app: App;
let server: Server;
let port = 0;
let counter = 0;

async function serve() {
    const { createHandler } = await import("../src/server/http.ts");

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
}

before(async () => {
    app = await openApp(model, dir, clock);
    await serve();
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

const surfaces = async (id: ConversationId) =>
    (await app.harness.snapshot(SurfacesDoc, id, context))?.items ?? {};

/** A session where Pi shows `args` as a card (`ui`), and the card once it is stored. */
async function show(args: Record<string, unknown>): Promise<{ id: ConversationId; card: Surface }> {
    const id = await newSession(app);
    const text = `show card ${(counter += 1)}`;

    await loadTools(app, id, "ui");
    script.set(text, args);
    await app.commands.submit(id, owner(app), { text, requestId: `show-${counter}` });
    await until(
        async () => Object.keys(await surfaces(id)).length > 0,
        `the surface: ${await stored(id)}`,
    );

    return { id, card: Object.values(await surfaces(id))[0]! };
}

async function act(token: string, id: ConversationId, sid: string, body: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}/api/c/${id}/surfaces/${sid}/act`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });

    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

const stored = async (id: ConversationId) =>
    JSON.stringify(await app.transcripts.allEntries(id as never, true));
const me = () => app.config.ownerToken;

test("a parked ui call survives a restart, and a signal wakes it with the values", async () => {
    const { id, card } = await show(cleanup);

    assert.equal(card.status, "open");
    assert.equal(card.wait?.key, `${card.id}.1`);

    await server.close();
    await app.close();
    app = await openApp(model, dir, clock);
    await serve();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(Object.keys(await surfaces(id)).length, 1, "no second surface after the restart");

    const result = await app.harness.commit(
        (tx) =>
            tx.signal(card.taskId as never, SurfaceActed, card.wait!.key, {
                name: "delete",
                by: "Tanner (owner)",
                at: clock(),
                values: { paths: ["/tmp/a"] },
            }),
        context,
    );

    assert.equal(result, "delivered");
    await until(async () => (await stored(id)).includes("got: Surface s1"), "the wake");
    assert.match(await stored(id), /<surface-values surface=\\"s1\\" action=\\"delete\\"/);
});

test("show refuses an unknown type, a bad reference, an http link, and a surface over the limits; nested input is stored flat", () => {
    const check = (components: unknown, data: Record<string, unknown> = {}) => {
        const made = flatten(components);

        checkSurface({ ...made, data: data as never });

        return made;
    };

    assert.throws(() => check({ type: "Video" }), /unknown type/);
    assert.throws(() => check({ type: "Column", children: ["nope"] }), /nope is not a component/);
    assert.throws(
        () =>
            check({ type: "Button", label: "x", action: { open: { url: "http://example.com" } } }),
        /https URL/,
    );
    assert.throws(
        () =>
            check({
                type: "Button",
                label: "Go",
                style: "danger",
                action: { event: { name: "go" } },
            }),
        /must carry confirm/,
    );
    assert.throws(() => check({ type: "Text", text: "x", color: "red" }), /does not take/);
    assert.throws(
        () =>
            check({
                type: "Column",
                children: Array.from({ length: 201 }, () => ({ type: "Divider" })),
            }),
        /at most 200/,
    );
    assert.throws(
        () => check({ type: "Column", children: [{ type: "Text", text: "x".repeat(4001) }] }),
        /at most 4000/,
    );
    assert.throws(() => check({ type: "Text", text: "x" }, { a: "x".repeat(60_000) }), /48 KB/);

    const flat = check({
        type: "Column",
        children: [
            { type: "Text", text: "a" },
            { type: "Row", children: [{ type: "Divider" }] },
        ],
    });

    assert.equal(flat.root, "c1");
    assert.deepEqual(flat.components.c1!.children, ["c2", "c3"]);
    assert.deepEqual(flat.components.c3!.children, ["c4"]);
});

test("a patch is all or nothing: one bad op changes nothing", () => {
    const made = flatten({ type: "Column", children: [{ type: "Text", id: "t", text: "hi" }] });
    const parts = { ...made, data: { n: 1, list: [1] } };
    const done = applyOps(parts, [
        { op: "set", path: "/n", value: 2 },
        { op: "push", path: "/list", value: 3 },
        { op: "props", id: "t", props: { text: "yo" } },
        { op: "add", parent: made.root, component: { type: "Divider" } },
    ]);

    assert.deepEqual(done.parts.data, { n: 2, list: [1, 3] });
    assert.equal(done.parts.components.t!.text, "yo");
    assert.equal((done.parts.components[made.root]!.children as string[]).length, 2);
    assert.equal(done.layout, true);
    assert.throws(
        () =>
            applyOps(parts, [
                { op: "set", path: "/n", value: 5 },
                { op: "drop", id: "nope" },
            ]),
        SurfaceError,
    );
    assert.throws(
        () => applyOps(parts, [{ op: "props", id: "t", props: { color: "red" } }]),
        /does not take/,
    );
    assert.deepEqual(parts.data, { n: 1, list: [1] }, "the original is untouched");
});

test("a person's action is checked: an unbound path and a value that does not fit are refused", async () => {
    const { id, card } = await show(cleanup);
    const sid = card.id;

    assert.equal(
        (await act(me(), id, sid, { pv: card.pv, set: { "/note": "hello" } })).status,
        200,
    );
    assert.equal((await surfaces(id))[sid]!.data.note, "hello");
    assert.equal(
        (await act(me(), id, sid, { pv: card.pv, set: { "/rows/0/name": "x" } })).status,
        400,
    );
    assert.equal((await act(me(), id, sid, { pv: card.pv, set: { "/$/gb": "x" } })).status, 400);
    assert.equal(
        (await act(me(), id, sid, { pv: card.pv, set: { "/rows/0/picked": "yes" } })).status,
        400,
    );
    assert.equal(
        (await act(me(), id, sid, { pv: card.pv, set: { "/note": "x".repeat(21) } })).status,
        400,
    );
    assert.equal(
        (await act(me(), id, sid, { pv: card.pv, set: { "/rows/7/picked": true } })).status,
        400,
    );
    assert.equal((await act(me(), id, sid, { pv: card.pv, event: "note" })).status, 400);
    assert.equal((await act(me(), id, sid, { pv: card.pv })).status, 400);
    assert.equal((await act(me(), id, "s99", { pv: 1, set: { "/note": "x" } })).status, 404);
});

test("who may act: a viewer and a guest are refused on an owner card; steer opens it to guests and invited guests; a stranger's session is hidden", async () => {
    const { id, card } = await show(cleanup);
    const steer = await show({ ...cleanup, title: "Steer", who: "steer" });
    const guest = app.config.addUser("Riley", "guest");
    const viewer = app.config.addUser("Vera", "viewer");
    const invited = app.config.addUser("Ines", "guest", [String(steer.id)]);
    const elsewhere = app.config.addUser("Sam", "guest", [String(id)]);
    const set = (token: string, on: { id: ConversationId; card: Surface }) =>
        act(token, on.id, on.card.id, { pv: on.card.pv, set: { "/note": "hi" } });

    assert.equal((await set(viewer.token, { id, card })).status, 403);
    assert.equal(
        (await set(guest.token, { id, card })).status,
        403,
        "a guest on an owner-only card",
    );
    assert.equal((await set(viewer.token, steer)).status, 403, "a viewer on a steer card");
    assert.equal((await set(guest.token, steer)).status, 200);
    assert.equal((await set(invited.token, steer)).status, 200, "a guest invited to that session");
    assert.equal((await set(elsewhere.token, steer)).status, 404, "a session not shared with them");
    assert.equal((await set(me(), { id, card })).status, 200);

    const anyone = await show({ ...cleanup, title: "Anyone", who: "anyone" });

    assert.equal((await set(viewer.token, anyone)).status, 200, "a viewer on an anyone card");
});

test("a stale pv is refused, and a second resolving action is too", async () => {
    const { id, card } = await show(cleanup);

    assert.equal((await act(me(), id, card.id, { pv: card.pv + 1, event: "refresh" })).status, 409);
    assert.equal(
        (await act(me(), id, card.id, { pv: card.pv, event: "refresh" })).status,
        200,
        "does not resolve",
    );
    assert.equal((await surfaces(id))[card.id]!.status, "open");

    const first = await act(me(), id, card.id, { pv: card.pv, event: "delete" });

    // The refresh woke the waiting call, which ended its wait: this action reaches the session as a message.
    assert.deepEqual(
        [first.status, first.json.delivered, first.json.status],
        [200, "message", "done"],
    );

    const second = await act(me(), id, card.id, { pv: card.pv, event: "delete" });

    assert.equal(second.status, 409);
    assert.match(String(second.json.error), /done by /);
});

test("the browser's context is ignored: Pi gets the values the server works out", async () => {
    const { id, card } = await show(cleanup);

    await act(me(), id, card.id, { pv: card.pv, set: { "/rows/1/picked": true } });
    const response = await act(me(), id, card.id, {
        pv: card.pv,
        event: "delete",
        context: { paths: ["/etc/passwd"] },
        data: { rows: [] },
    });

    assert.equal(response.status, 200);
    await until(async () => (await stored(id)).includes("got: Surface"), "the wake");
    assert.match(await stored(id), /\\"paths\\":\[\\"\/tmp\/a\\",\\"\/tmp\/b\\"\]/);
    assert.doesNotMatch(await stored(id), /passwd/);
});

test("with no call waiting, an action reaches the session once as a message", async () => {
    const { id, card } = await show({ ...cleanup, wait: undefined, title: "No wait" });

    await until(async () => (await stored(id)).includes("got: Surface s"), "the shown result");
    assert.match(await stored(id), /Actions come as \[via surface /);

    const sent = await act(me(), id, card.id, { pv: card.pv, event: "delete" });

    assert.equal(sent.json.delivered, "message");
    await until(async () => (await stored(id)).includes("[via surface "), "the message");
    assert.match(await stored(id), /owner marked as trusted/, "an owner's press is trusted");
    assert.doesNotMatch(await stored(id), /is not one the owner marked/);
    const entries = (await app.transcripts.allEntries(id as never, true)) as {
        kind: string;
        text?: string;
    }[];

    assert.equal(
        entries.filter((entry) => entry.kind === "user" && entry.text?.startsWith("[via surface "))
            .length,
        1,
    );
    assert.equal((await act(me(), id, card.id, { pv: card.pv, event: "delete" })).status, 409);
});

test("a wait ends at its deadline on a moved clock, and Stop cancels a card", async () => {
    const short = await show({ ...cleanup, title: "Short", wait: { minutes: 1 } });
    const stopped = await show({ ...cleanup, title: "Stopped" });

    await app.commands.abort(stopped.id, owner(app));
    await until(
        async () => (await surfaces(stopped.id))[stopped.card.id]!.status === "cancelled",
        "Stop",
    );
    assert.match((await surfaces(stopped.id))[stopped.card.id]!.final!.text, /Stopped/);

    await app.close();
    server.close();
    skew += 5 * 60_000;
    app = await openApp(model, dir, clock);
    await serve();
    await until(
        async () => (await surfaces(short.id))[short.card.id]!.status === "expired",
        "the deadline",
    );
    await until(async () => (await stored(short.id)).includes("timed out"), "the result");
});

test("the text form: a golden card, and the relay's numbers", () => {
    const made = flatten(cleanup.components);
    const card = {
        v: 1,
        id: "s3",
        title: "Cleanup dry run",
        status: "open",
        who: "owner",
        by: "u1",
        taskId: "1",
        callId: "c",
        createdAt: 0,
        updatedAt: 0,
        rev: 1,
        pv: 1,
        ...made,
        data: cleanup.data,
        computed: cleanup.computed,
    } as unknown as Surface;
    const golden = (name: string) =>
        readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

    assert.equal(`${toText(card, "transcript")}\n`, golden("surface-cleanup.transcript.txt"));
    assert.equal(`${toText(card, "relay")}\n`, golden("surface-cleanup.relay.txt"));
    assert.equal(toText(card, "push"), "Cleanup dry run");
});

test("expressions: sum, pick, bytes, formatString, and the limit on depth", () => {
    const data = {
        rows: [
            { name: "a", size: 4200000000, picked: true },
            { name: "b", size: 9700000000, picked: false },
            { name: "c", size: 100, picked: true },
        ],
    };
    const scope = { data };
    const call = (name: string, args: Record<string, unknown>) =>
        evaluate({ "@call": name, args }, scope);

    assert.equal(call("sum", { list: "/rows", field: "size" }), 13900000100);
    assert.equal(call("sum", { list: "/rows", field: "size", where: "picked" }), 4200000100);
    assert.equal(call("sum", { list: "/rows", field: "size", where: "!picked" }), 9700000000);
    assert.deepEqual(call("pick", { list: "/rows", field: "name", where: "picked" }), ["a", "c"]);
    assert.equal(call("count", { list: "/rows" }), 3);
    assert.equal(bytes(13900000000), "13.9 GB");
    assert.equal(bytes(512), "512 B");
    assert.equal(call("pluralize", { count: 1, one: "file", other: "files" }), "file");
    assert.equal(
        evaluateComputed(
            {
                n: { "@call": "count", args: { list: "/rows" } },
                t: { "@call": "formatString", args: { value: "${/$/n} rows" } },
            },
            data,
        ).t,
        "3 rows",
    );
    assert.equal(call("nope", {}), undefined);

    let deep: unknown = 1;

    for (let at = 0; at < 8; at += 1) {
        deep = { "@call": "not", args: { value: deep } };
    }

    assert.match(String(checkExpr(deep)), /too deep/);
});

test("a tab gets each surface projected for its person, with no task or wait key", async () => {
    const { id, card } = await show({ ...cleanup, title: "Projected", who: "steer" });
    const guest = app.config.addUser("Gil", "guest");
    const tabs = [fakeTab(id, owner(app)), fakeTab(id, guest.user)];

    for (const tab of tabs) {
        await app.attach(tab.client);
    }

    await until(() => tabs.every((tab) => tab.field("surfaces") !== undefined), "the views");

    for (const tab of tabs) {
        const shown = (tab.field("surfaces") as Record<string, Record<string, unknown>>)[card.id]!;

        assert.equal(shown.waiting, true);
        assert.equal("taskId" in shown || "wait" in shown, false);
        assert.deepEqual(Object.keys(shown.can as object).includes("delete"), true);
    }

    assert.equal(work.length > 0, true);
});

test("plan mode lets a card be shown, as it does a question", () => {
    assert.equal(blockedInPlanMode("ui", { action: "show", title: "x" }), undefined);
});

test("button.disabled is evaluated against post-set data on combined set+event requests", async () => {
    const gated = {
        action: "show",
        title: "Confirm",
        wait: { minutes: 10 },
        data: { confirmed: false },
        components: [
            {
                type: "Column",
                children: [
                    { type: "CheckBox", id: "agree", label: "Agree", bind: "/confirmed" },
                    {
                        type: "Button",
                        id: "submit",
                        label: "Submit",
                        disabled: { "@call": "not", args: { value: { "@path": "/confirmed" } } },
                        action: {
                            event: {
                                name: "submit",
                                context: { confirmed: { "@path": "/confirmed" } },
                            },
                        },
                    },
                ],
            },
        ],
    };
    const { id, card } = await show(gated);

    // Filling the required field and pressing the gated button in one POST succeeds.
    const ok = await act(me(), id, card.id, {
        pv: card.pv,
        set: { "/confirmed": true },
        event: "submit",
    });

    assert.equal(ok.status, 200);

    // Conversely, setting a value that disables the button in the same POST is refused (409).
    const gatedOn = { ...gated, data: { confirmed: true } };
    const second = await show(gatedOn);
    const blocked = await act(me(), second.id, second.card.id, {
        pv: second.card.pv,
        set: { "/confirmed": false },
        event: "submit",
    });

    assert.equal(blocked.status, 409);
});

test("applyOps drop handles cyclic or missing children cleanly, and A2UI enforces size and array bounds", () => {
    const base = {
        ...flatten([
            {
                type: "Column",
                id: "box",
                children: [{ type: "Text", id: "a", text: "hi" }],
            },
        ]),
        data: {},
    };

    assert.throws(
        () =>
            applyOps(base, [
                { op: "props", id: "box", props: { children: ["box"] } },
                { op: "drop", id: "box" },
            ]),
        SurfaceError,
    );
    assert.throws(
        () =>
            applyOps(base, [
                { op: "props", id: "box", props: { children: ["missing"] } },
                { op: "drop", id: "box" },
            ]),
        SurfaceError,
    );
    assert.throws(() => clean(JSON.parse('{"__proto__":{}}'), "a2ui"), SurfaceError);
    assert.throws(
        () => checkSurface(base, new Set(), { big: { junk: "x".repeat(60_000) } }),
        SurfaceError,
    );
    assert.throws(
        () => dataFromSteps({ rows: ["a"] }, [{ kind: "remove", path: "/rows/not-a-number" }]),
        /invalid array index/,
    );
    assert.throws(
        () => dataFromSteps({ rows: ["a"] }, [{ kind: "set", path: "/rows/999", value: "b" }]),
        /out of range/,
    );
});

test("surface client model helpers (web/surfaces-model.js)", async () => {
    type RawSurface = Record<string, unknown>;
    type Model = {
        cellPath: (rows: string, index: number, field: string) => string;
        controlState: (surface: RawSurface, id: string) => { enabled: boolean; why: string };
        withPending: (data: unknown, pending: Record<string, { value: unknown }>) => unknown;
        prunePending: (
            pending: Record<string, { value: unknown; until?: number }>,
            rev: number,
        ) => Record<string, unknown>;
        imageKind: (url: unknown) => { kind: string; src?: string; href?: string; host?: string };
        httpsUrl: (url: unknown) => URL | undefined;
        footerOf: (surface: RawSurface) => string | undefined;
        actBody: (
            surface: RawSurface,
            what: { set?: unknown; event?: string; pv?: number },
        ) => unknown;
        stepIndex: (count: number, at: number, key: string) => number | undefined;
        toggled: (current: unknown, options: unknown, value: string, on: boolean) => string[];
        bodyOfText: (text: string, title: string) => string;
    };
    const model = (await import(
        new URL("../web/surfaces-model.js", import.meta.url).href
    )) as Model;
    const makeSurface = (extra: RawSurface = {}): RawSurface => ({
        id: "s1",
        status: "open",
        who: "owner",
        by: "Maria",
        pv: 3,
        rev: 5,
        waiting: true,
        components: { go: { type: "Button" }, tick: { type: "CheckBox", who: "requester" } },
        can: { go: true, tick: false },
        ...extra,
    });

    assert.equal(model.cellPath("/rows", 0, "picked"), "/rows/0/picked");
    assert.equal(model.cellPath("/a/b/", 12, "name"), "/a/b/12/name");
    assert.equal(model.controlState(makeSurface(), "go").enabled, true);
    assert.deepEqual(model.controlState(makeSurface(), "tick"), {
        enabled: false,
        why: "Only Maria and the owner can use this",
    });
    assert.equal(model.controlState(makeSurface(), "none").enabled, false);
    assert.equal(
        model.controlState(makeSurface({ status: "done", can: {} }), "go").why,
        "This card has ended",
    );

    const data = { rows: [{ picked: false }, { picked: false }], other: { x: 1 } };
    const shown = model.withPending(data, { "/rows/1/picked": { value: true } }) as typeof data;

    assert.equal(shown.rows[1]!.picked, true);
    assert.equal(data.rows[1]!.picked, false);
    assert.equal(shown.other, data.other);
    assert.equal(model.withPending(data, { "/nope/1": { value: 1 } }), data);
    assert.deepEqual(
        Object.keys(
            model.prunePending(
                { "/a": { value: 1 }, "/b": { value: 2, until: 7 }, "/c": { value: 3, until: 5 } },
                5,
            ),
        ),
        ["/a", "/b"],
    );
    assert.deepEqual(model.imageKind("https://example.com/a.png"), {
        kind: "link",
        href: "https://example.com/a.png",
        host: "example.com",
    });
    assert.equal(model.imageKind("data:image/png;base64,iVBORw0KGgo=").kind, "img");
    assert.equal(model.imageKind("data:image/svg+xml;base64,PHN2Zz4=").kind, "none");
    assert.equal(model.imageKind("http://example.com/a.png").kind, "none");
    assert.equal(model.imageKind("javascript:alert(1)").kind, "none");
    assert.equal(model.httpsUrl("https://user:pw@example.com/"), undefined);
    assert.equal(model.footerOf(makeSurface()), "Pi is waiting for you");
    assert.equal(model.footerOf(makeSurface({ waiting: false })), undefined);
    assert.equal(
        model.footerOf(makeSurface({ status: "done", final: { text: "Maria pressed delete" } })),
        "Done: Maria pressed delete",
    );
    assert.equal(model.footerOf(makeSurface({ status: "expired" })), "Expired");
    assert.deepEqual(model.actBody(makeSurface(), { event: "go" }), { pv: 3, event: "go" });
    assert.deepEqual(
        model.actBody(makeSurface({ pv: 7 }), { set: { "/a": 1 }, event: "go", pv: 4 }),
        {
            pv: 4,
            set: { "/a": 1 },
            event: "go",
        },
    );
    assert.deepEqual(model.toggled(["b"], ["a", { label: "B", value: "b" }, "c"], "a", true), [
        "a",
        "b",
    ]);
    assert.equal(model.bodyOfText("Title\nline", "Title"), "line");
    assert.equal(model.stepIndex(3, 2, "ArrowRight"), 0);
    assert.equal(model.stepIndex(3, 0, "ArrowLeft"), 2);
    assert.equal(model.stepIndex(3, 1, "Home"), 0);
    assert.equal(model.stepIndex(3, 1, "End"), 2);
    assert.equal(model.stepIndex(3, 1, "a"), undefined);
});

test("ui calls in transcript turns and call descriptions (web/turns.js, web/calls.js)", async () => {
    type Block =
        | { type: "text"; text: string }
        | { type: "toolCall"; id: string; name: string; args: Record<string, unknown> };
    type Entry = {
        id?: number;
        kind: string;
        blocks?: Block[];
        stopReason?: string;
        text?: string;
    };
    type Step = { block: Block; entry?: Entry; streaming: boolean; canRun: boolean };
    type Item = { type: string; key: string | number; steps?: Step[]; step?: Step };
    type Turns = {
        itemsOf: (rows: Entry[], partial: Entry | null) => Item[];
        isInlineCall: (block: Block) => boolean;
        summarize: (steps: Step[], thinking?: boolean) => string;
    };
    type Calls = {
        describeCall: (call: { name: string; args?: Record<string, unknown> }) => {
            label: string;
            subject: string;
        };
    };
    const turns = (await import(new URL("../web/turns.js", import.meta.url).href)) as Turns;
    const calls = (await import(new URL("../web/calls.js", import.meta.url).href)) as Calls;
    const call = (id: string, name: string, args: Record<string, unknown> = {}): Block => ({
        type: "toolCall",
        id,
        name,
        args,
    });
    const said = (text: string): Block => ({ type: "text", text });
    const answer = (id: number, blocks: Block[], stopReason = "toolUse"): Entry => ({
        id,
        kind: "assistant",
        blocks,
        stopReason,
    });
    const user: Entry = { id: 1, kind: "user", text: "go" };

    const items = turns.itemsOf(
        [
            user,
            answer(2, [
                call("a", "grep"),
                said("Pick one:"),
                call("card", "ui", { action: "show", title: "Cleanup" }),
                call("b", "read", { path: "x" }),
                call("c", "bash"),
            ]),
            answer(3, [said("Waiting."), call("d", "ui", { action: "show" })], "toolUse"),
        ],
        null,
    );

    assert.deepEqual(
        items.map((item) => item.type),
        ["row", "activity", "reply", "inline", "activity", "reply", "inline"],
    );
    assert.equal(items[3]!.key, "icard");
    assert.equal(items[6]!.key, "id");
    assert.equal(turns.isInlineCall(call("n", "ui", {})), true);
    assert.equal(turns.isInlineCall(call("n", "ui", { action: "patch" })), false);
    assert.equal(turns.isInlineCall(call("n", "ui", { action: "show", id: "s1" })), false);
    assert.equal(
        turns.isInlineCall(
            call("c", "ui", { action: "a2ui", messages: [{ createSurface: { surfaceId: "a" } }] }),
        ),
        true,
    );
    assert.equal(
        turns.isInlineCall(
            call("u", "ui", {
                action: "a2ui",
                messages: [{ updateDataModel: { surfaceId: "a" } }],
            }),
        ),
        false,
    );
    assert.deepEqual(calls.describeCall({ name: "ui", args: { title: "Cleanup" } }), {
        icon: "▦",
        label: "Showed card",
        subject: "“Cleanup”",
        mono: false,
    });
    assert.equal(
        calls.describeCall({ name: "ui", args: { action: "patch", id: "s2" } }).label,
        "Updated card",
    );
    assert.equal(
        calls.describeCall({ name: "ui", args: { action: "show", id: "s1", title: "x" } }).label,
        "Replaced card",
    );
    assert.equal(
        turns.summarize([
            {
                block: call("a", "ui", { action: "patch", id: "s1" }),
                streaming: false,
                canRun: false,
            },
        ]),
        "Updated a card",
    );
});
