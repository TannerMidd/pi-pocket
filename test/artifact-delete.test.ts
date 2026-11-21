// Deleting an artifact: who may, what goes with it, what a fork and a restart keep, and the numbers of later versions.
import { type App, cleanUp, context, openApp, owner, say, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
    ArtifactAssetDoc,
    ArtifactBodyDoc,
    ArtifactsDoc,
    ArtifactStateDoc,
    DesignCommentsDoc,
} from "../src/server/docs.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";
import { root } from "./helpers.ts";

const dataDir = join(root, "data");
let app: App;
let server: Server;
let port = 0;
let calls = 0;

before(async () => {
    app = await openApp(scriptedModel(), dataDir);

    const { createHandler } = await import("../src/server/http.ts");

    // Through `app` as it is now: the last test opens it again.
    server = createServer((request, response) =>
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} })(
            request,
            response,
        ),
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

async function publish(id: ConversationId, content: string, more: object = {}): Promise<number> {
    const tool = createArtifacts({} as PocketHost).tools![0]!;
    const result = await tool.execute(
        { id: "demo", title: "Demo", content, ...more } as never,
        {
            conversationId: id,
            taskId: 8000 + (calls += 1),
            callId: "publish",
            agent: async () => ({ cwd: work }),
            snapshot: app.harness.snapshot.bind(app.harness),
            commit: app.harness.commit.bind(app.harness),
        } as never,
        context,
    );

    return (result.details as { version: number }).version;
}

async function session(): Promise<ConversationId> {
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };

    return (await app.commands.createSession(owner(app), { cwd: work })).id;
}

async function call(token: string, method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, text: await response.text() };
}

const body = async (id: ConversationId, version: number) =>
    (await app.harness.snapshot(ArtifactBodyDoc, id, `demo@${version}`, context))?.content;

test("a delete takes every version, link, saved state, and comment at once; viewers may not; a fork keeps its copy", async () => {
    const id = await session();
    const me = app.config.ownerToken;
    const viewer = app.config.addUser("Vee", "viewer");

    try {
        await publish(id, "<h1>one</h1>");
        await publish(id, "<h1>two</h1>", { assets: [{ name: "a.txt", content: "forked bytes" }] });

        const share = await app.shares.create(id, owner(app), { id: "demo" });

        await call(me, "POST", `/api/c/${id}/artifact-state/demo`, { state: { kept: 1 } });
        await app.harness.commit(async (tx) => {
            (await tx.doc(DesignCommentsDoc, id)).items.demo = { comments: [] };
        }, context);
        await say(app, id, "hello");

        const last = (await app.transcripts.allEntries(id, false)).at(-1)!;
        const fork = await app.commands.fork(id, owner(app), { entryId: last.id });

        assert.equal(
            (await call(viewer.token, "DELETE", `/api/c/${id}/artifacts/demo`)).status,
            403,
        );
        assert.equal((await app.artifactBody(id, "demo")).content, "<h1>two</h1>");

        const done = await call(me, "DELETE", `/api/c/${id}/artifacts/demo`);

        assert.equal(done.status, 200, done.text);
        assert.deepEqual(JSON.parse(done.text), { versions: 2 });
        await assert.rejects(app.artifactBody(id, "demo"), /No such artifact/);
        assert.equal((await call(me, "GET", `/a/${id}/demo/1`)).status, 404);
        assert.equal(await app.shares.open(share.token), undefined);
        assert.equal((await fetch(`http://127.0.0.1:${port}${share.path}`)).status, 404);
        assert.equal(
            (await app.harness.snapshot(ArtifactStateDoc, id, context))?.items.demo,
            undefined,
        );
        assert.equal(
            (await app.harness.snapshot(DesignCommentsDoc, id, context))?.items.demo,
            undefined,
        );
        assert.equal(await body(id, 1), undefined);
        assert.equal(await body(id, 2), undefined);
        assert.equal((await call(me, "DELETE", `/api/c/${id}/artifacts/demo`)).status, 404);

        // The fork is another session: its artifact and its pages stay.
        assert.equal((await app.artifactBody(fork.id, "demo", 1)).content, "<h1>one</h1>");
        assert.equal((await app.artifactBody(fork.id, "demo")).content, "<h1>two</h1>");
        assert.ok(await app.artifactAsset(fork.id, "demo", 2, "a.txt"), "the fork still uses it");
    } finally {
        app.config.removeUser(viewer.user.id);
    }
});

test("an asset's bytes go once no artifact uses them, and no stored revision keeps what was deleted", async () => {
    const first = await session();
    const second = await session();
    const me = app.config.ownerToken;
    const shared = { name: "shared.txt", content: "bytes-both-use" };

    await publish(first, "<h1>page-gone-1</h1>", {
        title: "title-gone-1",
        assets: [shared, { name: "own.txt", content: "bytes-gone-1" }],
    });
    await publish(second, "<h1>other</h1>", { assets: [shared] });
    await call(me, "POST", `/api/c/${first}/artifact-state/demo`, { state: "state-gone-1" });

    const own = (await app.harness.snapshot(ArtifactsDoc, first, context))!.items.demo!.versions[0]!
        .assets!["own.txt"]!.hash;
    const both = (await app.harness.snapshot(ArtifactsDoc, first, context))!.items.demo!
        .versions[0]!.assets!["shared.txt"]!.hash;

    assert.equal((await call(me, "DELETE", `/api/c/${first}/artifacts/demo`)).status, 200);
    assert.equal(await app.harness.snapshot(ArtifactAssetDoc, own, context), undefined);
    assert.ok(
        await app.harness.snapshot(ArtifactAssetDoc, both, context),
        "the other still uses it",
    );
    assert.ok(await app.artifactAsset(second, "demo", 1, "shared.txt"));

    assert.equal((await call(me, "DELETE", `/api/c/${second}/artifacts/demo`)).status, 200);
    assert.equal(await app.harness.snapshot(ArtifactAssetDoc, both, context), undefined);

    await app.close();

    const db = new DatabaseSync(join(dataDir, "pocket.sqlite"), { readOnly: true });

    try {
        for (const gone of [
            "page-gone-1",
            "title-gone-1",
            "state-gone-1",
            Buffer.from("bytes-gone-1").toString("base64"),
            Buffer.from("bytes-both-use").toString("base64"),
        ]) {
            const row = db
                .prepare("SELECT count(*) AS n FROM document_revisions WHERE content LIKE ?")
                .get(`%${gone}%`) as { n: number };

            assert.equal(row.n, 0, `${gone} is still stored`);
        }
    } finally {
        db.close();
        app = await openApp(scriptedModel(), dataDir);
    }
});

test("published again, a deleted artifact never reuses a version number, and its delete holds after a restart", async () => {
    const id = await session();
    const me = app.config.ownerToken;

    await publish(id, "<h1>old</h1>");
    assert.equal((await call(me, "DELETE", `/api/c/${id}/artifacts/demo`)).status, 200);

    // A card in a reply names `demo` version 1: that address must not show the new page.
    assert.equal(await publish(id, "<h1>new</h1>"), 2);
    await assert.rejects(app.artifactBody(id, "demo", 1), /No such version/);

    await app.close();
    app = await openApp(scriptedModel(), dataDir);

    assert.equal((await app.artifactBody(id, "demo")).content, "<h1>new</h1>");
    await assert.rejects(app.artifactBody(id, "demo", 1), /No such version/);
    assert.equal(await body(id, 1), undefined);
    assert.equal(await publish(id, "<h1>newer</h1>"), 3);
});
