// Session tags use the existing durable catalogue: explicit patches, fresh authorization, and all-or-none batches.
// helpers first, so no real Pi configuration or session data is loaded.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
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
import { after, before, test } from "node:test";
import { type ConversationId, defineDoc } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let base = "";

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await app?.close();
    cleanUp();
});

function tags(id: ConversationId): string[] {
    return app.sessionMeta(id)?.tags ?? [];
}

function patch(
    ids: ConversationId[],
    add: string[] = [],
    remove: string[] = [],
    user = owner(app),
) {
    return app.commands.updateSessionTags(user, { ids: ids.map(Number), add, remove });
}

test("older untagged sessions need no backfill; first add and last remove do not change recency", async () => {
    const id = await newSession(app);
    const before = structuredClone(app.sessionMeta(id));

    assert.equal(before?.tags, undefined);
    await patch([id], ["  Security  ", "security", "Needs review", "日本語"]);
    assert.deepEqual(tags(id), ["needs review", "security", "日本語"]);
    assert.equal(app.sessionMeta(id)?.updatedAt, before?.updatedAt);
    await patch([id], [], ["needs review", "SECURITY", "日本語"]);
    assert.deepEqual(app.sessionMeta(id), before);
});

test("tag names and patch shapes are validated without truncation or partial writes", async () => {
    const id = await newSession(app);
    const invalid = [
        {},
        { ids: [] },
        { ids: ["1"] },
        { ids: [0] },
        { ids: [-1] },
        { ids: [1.1] },
        { ids: [Number.MAX_SAFE_INTEGER + 1] },
        { ids: [Number(id)], add: "security" },
        { ids: [Number(id)], add: [null] },
        { ids: [Number(id)], add: [""] },
        { ids: [Number(id)], add: ["  "] },
        { ids: [Number(id)], add: ["bad\nname"] },
        { ids: [Number(id)], add: ["bad\u007fname"] },
        ...["\u202e", "\u2066", "\u2028", "\u2029"].map((control) => ({
            ids: [Number(id)],
            add: [`bad${control}name`],
        })),
        { ids: [Number(id)], add: ["x".repeat(33)] },
        { ids: [Number(id)], remove: [false] },
        { ids: [Number(id)], add: ["SECURITY"], remove: [" security "] },
    ];

    for (const body of invalid) {
        await assert.rejects(app.commands.updateSessionTags(owner(app), body), { status: 400 });
        assert.deepEqual(tags(id), []);
    }

    await patch([id], ["x".repeat(32)]);
    assert.deepEqual(tags(id), ["x".repeat(32)]);
});

test("mixed batches apply explicit additions and removals while preserving unrelated metadata", async () => {
    const first = await newSession(app);
    const second = await newSession(app);

    await patch([first], ["arca", "maintenance"]);
    await patch([second], ["pi-pocket", "security"]);
    await app.commands.updateSession(first, owner(app), { archived: true });
    const before = structuredClone(app.sessionMeta(first));

    await patch([first, second, first], ["reviewed"], ["maintenance"]);
    assert.deepEqual(tags(first), ["arca", "reviewed"]);
    assert.deepEqual(tags(second), ["pi-pocket", "reviewed", "security"]);
    assert.deepEqual(app.sessionMeta(first), { ...before, tags: ["arca", "reviewed"] });
    await patch([first, second], ["reviewed"], ["maintenance"]);
    assert.deepEqual(tags(first), ["arca", "reviewed"], "a retried patch is idempotent");
});

test("batch removal can cover more than ten distinct names across sessions", async () => {
    const first = await newSession(app);
    const second = await newSession(app);
    const left = Array.from({ length: 10 }, (_, i) => `left-${i}`);
    const right = Array.from({ length: 10 }, (_, i) => `right-${i}`);

    await patch([first], left);
    await patch([second], right);
    const before = [first, second].map((id) => {
        const meta = { ...app.sessionMeta(id) };

        delete meta.tags;

        return meta;
    });

    await patch([first, second], [], [...left, ...right]);
    assert.deepEqual(tags(first), []);
    assert.deepEqual(tags(second), []);
    assert.deepEqual([app.sessionMeta(first), app.sessionMeta(second)], before);
});

test("one full, unavailable, or hidden target rejects the entire batch", async () => {
    const first = await newSession(app);
    const full = await newSession(app);
    const names = Array.from({ length: 10 }, (_, i) => `tag-${i}`);

    await assert.rejects(patch([first, full], [...names, "eleventh"]), { status: 409 });
    assert.deepEqual(tags(first), []);
    assert.deepEqual(tags(full), []);
    await patch([full], names);
    await assert.rejects(patch([first, full], ["extra"]), { status: 409 });
    assert.deepEqual(tags(first), []);
    assert.deepEqual(tags(full), names);
    await assert.rejects(patch([first, 999_999 as ConversationId], ["extra"]), { status: 404 });
    assert.deepEqual(tags(first), []);
    const scoped = app.config.addUser("Scoped", "guest", [String(first)]).user;

    await assert.rejects(patch([first, full], ["extra"], [], scoped), { status: 404 });
    assert.deepEqual(tags(first), []);
    await patch([full], ["replacement"], ["tag-0"]);
    assert.equal(tags(full).length, 10, "removal makes room without truncating another tag");
});

test("viewers cannot edit; scoped guests can edit only ordinary sessions they can see", async () => {
    const id = await newSession(app);
    const viewer = app.config.addUser("Viewer", "viewer").user;
    const guest = app.config.addUser("Scoped writer", "guest", [String(id)]).user;

    await assert.rejects(patch([id], ["forbidden"], [], viewer), { status: 403 });
    await patch([id], ["allowed"], [], guest);
    assert.deepEqual(tags(id), ["allowed"]);
    const pip = await app.pip.ensure(owner(app));

    await assert.rejects(patch([id, pip], ["forbidden"]), { status: 404 });
    assert.deepEqual(tags(id), ["allowed"]);
});

test("scoped GET and live events never disclose hidden tag vocabulary", async () => {
    const visible = await newSession(app);
    const hidden = await newSession(app);
    const person = app.config.addUser("Scoped reader", "viewer", [String(visible)]);
    const tab = fakeTab(undefined, person.user);

    await app.attach(tab.client);

    try {
        await patch([visible], ["visible-label"]);
        await patch([hidden], ["private-vocabulary"]);
        await until(
            () => JSON.stringify(tab.last("sessions")).includes("visible-label"),
            "tag event",
        );
        assert.ok(!JSON.stringify(tab.events).includes("private-vocabulary"));
        const response = await fetch(`${base}/api/sessions`, {
            headers: { authorization: `Bearer ${person.token}` },
        });
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.ok(body.includes("visible-label"));
        assert.ok(!body.includes("private-vocabulary"));
    } finally {
        app.detach(tab.client);
    }
});

test("concurrent patches and other metadata writers preserve unmentioned changes", async () => {
    const id = await newSession(app);

    await patch([id], ["keep", "remove-me"]);
    await Promise.all([
        patch([id], ["first"], ["remove-me"]),
        patch([id], ["second"]),
        app.commands.updateSession(id, owner(app), { title: "Still organized", archived: true }),
        app.spend.setSessionBudget(owner(app), id, 5),
    ]);
    assert.deepEqual(tags(id), ["first", "keep", "second"]);
    assert.equal(app.sessionMeta(id)?.title, "Still organized");
    assert.equal(app.sessionMeta(id)?.archived, true);
    assert.equal(app.sessionMeta(id)?.budget, 5);
});

test("concurrent additions recheck capacity and a losing batch leaves its other target untouched", async () => {
    const full = await newSession(app);
    const first = await newSession(app);
    const second = await newSession(app);

    await patch(
        [full],
        Array.from({ length: 9 }, (_, i) => `existing-${i}`),
    );
    const results = await Promise.allSettled([
        patch([full, first], ["first"]),
        patch([full, second], ["second"]),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failed = results.find((result) => result.status === "rejected");

    assert.ok(failed?.status === "rejected");
    assert.equal(failed.reason.status, 409);
    assert.equal(tags(full).length, 10);
    assert.deepEqual(tags(first), results[0]!.status === "fulfilled" ? ["first"] : []);
    assert.deepEqual(tags(second), results[1]!.status === "fulfilled" ? ["second"] : []);
});

test("a patch waiting for the mutation line rechecks revoked access, role, and removed users", async () => {
    const id = await newSession(app);

    for (const revoke of [
        (user: User) => app.config.updateUser(user.id, { sessions: [] }),
        (user: User) => app.config.updateUser(user.id, { role: "viewer" }),
        (user: User) => app.config.removeUser(user.id),
    ]) {
        const user = app.config.addUser("Pending writer", "guest", [String(id)]).user;
        let release!: () => void;
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const blocker = app.harness.commit(async (tx) => {
            await tx.doc(SessionsDoc);
            entered();
            await gate;
        }, context);

        await ready;
        const pending = patch([id], ["must-not-save"], [], user);
        const rejected = assert.rejects(pending, (error: { status?: number }) =>
            [401, 403, 404].includes(error.status ?? 0),
        );

        revoke(user);
        release();
        await blocker;
        await rejected;
        assert.deepEqual(tags(id), []);
    }
});

test("the real HTTP route enforces sign-in, X-Pocket, validation and atomicity", async () => {
    const first = await newSession(app);
    const second = await newSession(app);
    const body = { ids: [Number(first), Number(second)], add: ["http"], remove: [] };
    const request = (token?: string, header = true, value: unknown = body) =>
        fetch(`${base}/api/sessions/tags`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
                ...(header ? { "X-Pocket": "1" } : {}),
            },
            body: JSON.stringify(value),
        });

    assert.equal((await request()).status, 401);
    assert.equal((await request(app.config.ownerToken, false)).status, 403);
    assert.equal((await request(app.config.ownerToken)).status, 200);
    assert.deepEqual(tags(first), ["http"]);
    assert.deepEqual(tags(second), ["http"]);
    assert.equal(
        (await request(app.config.ownerToken, true, { ...body, ids: [Number(first), -1] })).status,
        400,
    );
    const viewer = app.config.addUser("HTTP viewer", "viewer");

    assert.equal((await request(viewer.token)).status, 403);
    const scoped = app.config.addUser("HTTP scoped", "guest", [String(first)]);

    assert.equal(
        (await request(scoped.token, true, { ...body, add: ["no-partial-save"] })).status,
        404,
    );
    assert.deepEqual(tags(first), ["http"]);
});

test("version-one readers preserve the optional field, and a restart retains tags", async () => {
    const data = join(root, "tags-restart");
    let isolated = await openApp(scriptedModel(), data);
    const me = owner(isolated);
    const id = await newSession(isolated);
    // A pre-tags definition of the same version-one document, not a separate table or migration.
    const legacy = defineDoc<{ items: Record<string, { cwd: string; title?: string }> }>({
        kind: "pocket.sessions",
        version: 1,
        scope: "session",
        initial: () => ({ items: {} }),
    });

    try {
        await isolated.commands.updateSessionTags(me, { ids: [Number(id)], add: ["durable"] });
        const read = (await isolated.harness.snapshot(legacy, context))?.items[String(id)];

        assert.ok(read && "tags" in read);
        assert.deepEqual(read.tags, ["durable"]);
        await isolated.harness.commit(async (tx) => {
            (await tx.doc(legacy)).items[String(id)]!.title = "Older metadata writer";
        }, context);
        assert.deepEqual(isolated.sessionMeta(id)?.tags, ["durable"]);
        await isolated.close();
        isolated = await openApp(scriptedModel(), data);
        assert.deepEqual(isolated.sessionMeta(id)?.tags, ["durable"]);
        assert.equal(isolated.sessionMeta(id)?.title, "Older metadata writer");
    } finally {
        await isolated.close();
    }
});
