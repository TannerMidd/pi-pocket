// What an artifact's page saves for the person using it (#89): one JSON value per artifact, person, and session, over
// HTTP as the viewer's bridge asks for it; a schema label, limits, forks, and who may read and save.
import { type App, cleanUp, context, openApp, owner, say, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";

let app: App;
let server: Server;
let port = 0;
let calls = 0;

before(async () => {
    app = await openApp(scriptedModel());

    const { createHandler } = await import("../src/server/http.ts");

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

/** A session with the artifact `calc` in it. */
async function sessionWithArtifact(): Promise<ConversationId> {
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const { id } = await app.commands.createSession(owner(app), { cwd: work });
    const tool = createArtifacts({} as PocketHost).tools![0]!;

    await tool.execute(
        { id: "calc", title: "Calculator", content: "<h1>calc</h1>" } as never,
        {
            conversationId: id,
            taskId: 7000 + (calls += 1),
            callId: "publish",
            agent: async () => ({ cwd: work }),
            snapshot: app.harness.snapshot.bind(app.harness),
            commit: app.harness.commit.bind(app.harness),
        } as never,
        context,
    );

    return id;
}

/** Read (no body) or save (a body) as the person with `token`: the status and the JSON. */
async function call(token: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

test("a person's state comes back as saved, and each person has their own", async () => {
    const id = await sessionWithArtifact();
    const me = app.config.ownerToken;
    const other = app.config.addUser("Riley", "guest");
    const path = `c/${id}/artifact-state/calc`;

    try {
        assert.deepEqual((await call(me, path)).json, { state: null, at: null }, "none yet");

        const saved = await call(me, path, { state: { rate: 4.5, years: 30 }, schema: "v1" });

        assert.equal(saved.status, 200);
        assert.equal(typeof saved.json.at, "number");
        assert.deepEqual((await call(me, `${path}?schema=v1`)).json.state, {
            rate: 4.5,
            years: 30,
        });
        assert.equal(
            (await call(me, `${path}?schema=v2`)).json.state,
            null,
            "another schema reads as none",
        );
        assert.equal((await call(me, path)).json.state, null, "and so does none");
        assert.equal((await call(other.token, `${path}?schema=v1`)).json.state, null, "theirs");

        await call(other.token, path, { state: ["theirs"], schema: "v1" });
        assert.deepEqual((await call(me, `${path}?schema=v1`)).json.state, {
            rate: 4.5,
            years: 30,
        });

        // Cleared with null.
        assert.equal((await call(me, path, { state: null })).status, 200);
        assert.equal((await call(me, `${path}?schema=v1`)).json.state, null);
        assert.deepEqual((await call(other.token, `${path}?schema=v1`)).json.state, ["theirs"]);
    } finally {
        app.config.removeUser(other.user.id);
    }
});

test("limits: size, schema, saves in a row, and only the session's own artifacts", async () => {
    const id = await sessionWithArtifact();
    const me = app.config.ownerToken;
    const path = `c/${id}/artifact-state/calc`;

    assert.equal((await call(me, path, { state: "x".repeat(17 * 1024) })).status, 413);
    assert.equal((await call(me, path, { state: 1, schema: "no spaces" })).status, 400);
    assert.equal((await call(me, `c/${id}/artifact-state/nope`, { state: 1 })).status, 404);
    assert.equal((await call(me, `c/${id}/artifact-state/__proto__`)).status, 404);

    const statuses: number[] = [];

    for (let index = 0; index < 22; index++) {
        statuses.push((await call(me, path, { state: index })).status);
    }

    assert.equal(statuses.filter((status) => status === 200).length, 20);
    assert.equal(statuses.at(-1), 429, "past 20 saves in 10 seconds");
});

test("only people who see the session read or save there, viewers too, each their own", async () => {
    const id = await sessionWithArtifact();
    const other = await sessionWithArtifact();
    const viewer = app.config.addUser("Vee", "viewer");
    const elsewhere = app.config.addUser("Sam", "guest", [String(other)]);
    const path = `c/${id}/artifact-state/calc`;

    try {
        assert.equal((await call(viewer.token, path, { state: { mine: true } })).status, 200);
        assert.deepEqual((await call(viewer.token, path)).json.state, { mine: true });
        assert.equal((await call(elsewhere.token, path)).status, 404);
        assert.equal((await call(elsewhere.token, path, { state: 1 })).status, 404);
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/${path}`)).status, 401);
    } finally {
        app.config.removeUser(viewer.user.id);
        app.config.removeUser(elsewhere.user.id);
    }
});

test("a fork starts with no saved state, and the original keeps its own", async () => {
    const id = await sessionWithArtifact();
    const me = app.config.ownerToken;

    await call(me, `c/${id}/artifact-state/calc`, { state: { kept: 1 } });

    await say(app, id, "hello");
    const last = (await app.transcripts.allEntries(id, false)).at(-1)!;
    const fork = await app.commands.fork(id, owner(app), { entryId: last.id });

    assert.equal((await call(me, `c/${fork.id}/artifact-state/calc`)).json.state, null);
    assert.deepEqual((await call(me, `c/${id}/artifact-state/calc`)).json.state, { kept: 1 });
});
