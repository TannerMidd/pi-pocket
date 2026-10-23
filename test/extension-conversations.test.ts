// Isolated request capability tests. No live data, providers, model turns, or extension-private APIs.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SessionsDoc } from "../src/server/docs.ts";
import { ExtensionRequest } from "../src/server/extension-request.ts";
import type { ConversationSummary } from "../src/server/host.ts";

let app: App;
let root: ConversationId;
let child: ConversationId;
let archived: ConversationId;
let pip: ConversationId;

before(async () => {
    app = await openApp(
        scriptedModel(() => {
            throw new Error("Discovery must never call a model");
        }),
    );
    root = await newSession(app);
    child = await newSession(app);
    archived = await newSession(app);
    pip = await newSession(app);
    await app.harness.commit(async (tx) => {
        const catalogue = await tx.doc(SessionsDoc);

        catalogue.items[String(root)]!.title = "Floor";
        catalogue.items[String(root)]!.budget = 123;
        catalogue.items[String(root)]!.fromPi = { session: "private-source", count: 1 };
        catalogue.items[String(child)]!.linkedFrom = { id: Number(root) };
        catalogue.items[String(archived)]!.archived = true;
        catalogue.items[String(pip)]!.pip = owner(app).id;
    }, context);
});

after(async () => {
    await app.close();
    cleanUp();
});

const scope = (by = owner(app).id) => new ExtensionRequest(app, by, "view");
const ids = (rows: ConversationSummary[]) =>
    rows.map((row) => row.conversationId).sort((a, b) => a - b);

test("owner, guest, and viewer receive minimal catalogue metadata without durable writes", async () => {
    const before = await app.harness.snapshot(SessionsDoc, context);

    for (const role of ["owner", "guest", "viewer"] as const) {
        const by =
            role === "owner" ? owner(app).id : app.config.addUser(`List ${role}`, role).user.id;
        const request = scope(by);
        const commit = app.harness.commit;
        let rows: ConversationSummary[];

        try {
            app.harness.commit = () => {
                throw new Error("Listing must not commit durable state");
            };

            rows = await request.conversations.list();
        } finally {
            app.harness.commit = commit;
            request.close();
        }

        assert.deepEqual(
            ids(rows),
            [Number(root), Number(child)].sort((a, b) => a - b),
        );
        assert.deepEqual(
            rows.find((row) => row.conversationId === Number(root)),
            {
                conversationId: Number(root),
                title: "Floor",
                cwd: app.cwdOf(root),
                busy: false,
                archived: false,
            },
        );
        assert.equal(
            rows.find((row) => row.conversationId === Number(child))!.linkedFrom,
            Number(root),
        );
        assert.ok(
            rows.every((row) => !Object.hasOwn(row, "budget") && !Object.hasOwn(row, "fromPi")),
        );
    }

    assert.deepEqual(await app.harness.snapshot(SessionsDoc, context), before);
});

test("archive and root filters default to false and PiP never appears", async () => {
    const request = scope();

    try {
        assert.deepEqual(ids(await request.conversations.list({ rootsOnly: true })), [
            Number(root),
        ]);
        assert.deepEqual(
            ids(await request.conversations.list({ includeArchived: true })),
            [root, child, archived].map(Number).sort((a, b) => a - b),
        );
        assert.deepEqual(
            ids(await request.conversations.list({ rootsOnly: true, includeArchived: true })),
            [root, archived].map(Number).sort((a, b) => a - b),
        );
        assert.ok(
            !(await request.conversations.list({ includeArchived: true })).some(
                (row) => row.conversationId === Number(pip),
            ),
        );
        assert.ok(
            (await request.conversations.list()).every((row) => row.parentId === undefined),
            "core catalogue excludes subagents and fork origins",
        );
    } finally {
        request.close();
    }
});

test("fresh seeing checks hide linked origins and exclude hidden conversations", async () => {
    const viewer = app.config.addUser("Hidden origin", "viewer").user;
    const request = scope(viewer.id);
    const canSee = app.canSee;

    try {
        app.canSee = (actor, id) => id !== root && canSee.call(app, actor, id);
        const rows = await request.conversations.list();

        assert.deepEqual(rows, [
            {
                conversationId: Number(child),
                title: "New session",
                cwd: app.cwdOf(child),
                busy: false,
                archived: false,
                linkedOrigin: true,
            },
        ]);
        assert.deepEqual(await request.conversations.list({ rootsOnly: true }), []);
    } finally {
        app.canSee = canSee;
        request.close();
    }
});

test("scoped actors remain barred and current revocation applies to retained list functions", async () => {
    const viewer = app.config.addUser("Revoked list", "viewer").user;
    const request = scope(viewer.id);
    const list = request.conversations.list;

    assert.equal((await list()).length, 2);
    app.config.updateUser(viewer.id, { sessions: [String(child)] });
    assert.deepEqual(
        app.sessions(app.config.userById(viewer.id)).map((row) => row.id),
        [Number(child)],
    );
    await assert.rejects(list(), /no longer have access/);
    request.close();

    const scoped = app.config.addUser("Scoped list", "guest", [String(root)]).user;
    const scopedRequest = scope(scoped.id);

    await assert.rejects(scopedRequest.conversations.list(), /no longer have access/);
    scopedRequest.close();

    const removed = app.config.addUser("Removed list", "guest").user;
    const removedRequest = scope(removed.id);

    app.config.removeUser(removed.id);
    await assert.rejects(removedRequest.conversations.list(), /no longer have access/);
    removedRequest.close();
});

test("request close expires detached discovery, including an already aborted request", async () => {
    const request = scope();
    const list = request.conversations.list;

    request.close();
    assert.equal(request.context.abortSignal?.aborted, true);
    await assert.rejects(list(), /request has ended/);
    await assert.rejects(
        request.conversations.list({ includeArchived: true }),
        /request has ended/,
    );
});
