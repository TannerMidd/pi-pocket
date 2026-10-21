// helpers first: no personal model configuration or session data is used.
import { cleanUp, openApp, owner, root, scriptedModel, type App } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
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

function create(body: unknown, token = app.config.ownerToken, header = true) {
    return fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(header ? { "X-Pocket": "1" } : {}),
        },
        body: JSON.stringify(body),
    });
}

test("creation stores normalized initial tags alongside its title and folder", async () => {
    const response = await create({
        cwd: root,
        title: "Inherited",
        tags: [" Review ", "project", "REVIEW"],
    });
    const { id } = (await response.json()) as { id: ConversationId };

    assert.equal(response.status, 200);
    assert.deepEqual(app.sessionMeta(id)?.tags, ["project", "review"]);
    assert.equal(app.sessionMeta(id)?.title, "Inherited");
    assert.equal(app.sessionMeta(id)?.cwd, root);
});

test("invalid or over-capacity initial tags reject creation without a partial session", async () => {
    for (const tags of [
        null,
        "review",
        [null],
        [""],
        ["bad\nname"],
        ["x".repeat(33)],
        Array.from({ length: 11 }, (_, i) => `tag-${i}`),
    ]) {
        const before = app.sessions(owner(app)).map((session) => session.id);
        const response = await create({ cwd: root, tags });

        assert.equal(response.status, Array.isArray(tags) && tags.length === 11 ? 409 : 400);
        assert.deepEqual(
            app.sessions(owner(app)).map((session) => session.id),
            before,
        );
    }

    const response = await create({
        cwd: root,
        tags: Array.from({ length: 10 }, (_, i) => `tag-${i}`),
    });
    const { id } = (await response.json()) as { id: ConversationId };

    assert.equal(response.status, 200);
    assert.equal(app.sessionMeta(id)?.tags?.length, 10);
});

test("untagged creation stays compatible and existing route permissions still apply", async () => {
    for (const body of [{ cwd: root }, { cwd: root, tags: [] }]) {
        const response = await create(body);
        const { id } = (await response.json()) as { id: ConversationId };

        assert.equal(response.status, 200);
        assert.equal(app.sessionMeta(id)?.tags, undefined);
    }

    const viewer = app.config.addUser("Viewer", "viewer");
    const scoped = app.config.addUser("Scoped", "guest", []);

    assert.equal((await create({ cwd: root, tags: ["review"] }, viewer.token)).status, 403);
    assert.equal((await create({ cwd: root, tags: ["review"] }, scoped.token)).status, 403);
    assert.equal(
        (await create({ cwd: root, tags: ["review"] }, app.config.ownerToken, false)).status,
        403,
    );
});

test("initial tags survive closing and reopening the real storage", async () => {
    const data = join(root, "tagged-creation-restart");
    let isolated = await openApp(scriptedModel(), data);

    try {
        // The request type also describes direct internal callers, not only HTTP input.
        const request = { cwd: root, tags: ["persistent", "review"] };
        const { id } = await isolated.commands.createSession(owner(isolated), request);

        await isolated.close();
        isolated = await openApp(scriptedModel(), data);
        assert.deepEqual(isolated.sessionMeta(id)?.tags, ["persistent", "review"]);
    } finally {
        await isolated.close();
    }
});
