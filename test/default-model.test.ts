// The model and thinking level new sessions start with: the owner's choice, ahead of the last one picked.
import { type App, cleanUp, openApp, owner, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

const faux = fauxProvider({
    models: [{ id: "plain" }, { id: "thinker", reasoning: true }, { id: "other", reasoning: true }],
});

let app: App;

before(async () => {
    app = await openApp(faux);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** What a new session of the owner's starts with. */
async function startsWith(): Promise<{ model?: string; thinkingLevel?: string }> {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });
    const agent = await app.agentState(id);

    return { model: agent?.model?.modelId, thinkingLevel: agent?.thinkingLevel };
}

test("new sessions start with the owner's default, whatever was picked since", async () => {
    await app.setDefaultModel(owner(app), {
        provider: "faux",
        modelId: "thinker",
        thinkingLevel: "high",
    });
    assert.deepEqual(await startsWith(), { model: "thinker", thinkingLevel: "high" });
    assert.deepEqual((await app.hello(owner(app))).server.defaultModel, {
        provider: "faux",
        modelId: "thinker",
        thinkingLevel: "high",
    });

    // Picking another model in a session is that session's: the next one still starts with the default.
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "other" },
        thinkingLevel: "low",
    });
    assert.deepEqual(await startsWith(), { model: "thinker", thinkingLevel: "high" });

    // Cleared, new sessions follow the last model picked again.
    await app.setDefaultModel(owner(app), null);
    assert.equal((await app.hello(owner(app))).server.defaultModel, null);
    assert.deepEqual(await startsWith(), { model: "other", thinkingLevel: "low" });
});

test("the settings route sets and clears the default, for the owner only", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const settings = (token: string, defaultModel: unknown, more: object = {}) =>
        fetch(`http://127.0.0.1:${port}/api/settings`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                "x-pocket": "1",
            },
            body: JSON.stringify({ defaultModel, ...more }),
        });

    try {
        const choice = { provider: "faux", modelId: "other", thinkingLevel: "low" };
        const guest = app.config.addUser("Bea", "guest").token;

        assert.equal((await settings(guest, choice)).status, 403);
        assert.equal(app.config.defaultModel, undefined);
        assert.equal((await settings(app.config.ownerToken, choice)).status, 200);
        assert.deepEqual(app.config.defaultModel, choice);
        assert.equal((await settings(app.config.ownerToken, null)).status, 200);
        assert.equal(app.config.defaultModel, undefined);

        // One setting at a time: one that fails must not leave the other changed.
        const rule = app.config.approvalRule;

        assert.equal(
            (
                await settings(app.config.ownerToken, choice, {
                    approvalRule: rule === "anyone" ? "others" : "anyone",
                })
            ).status,
            400,
        );
        assert.equal(app.config.defaultModel, undefined);
        assert.equal(app.config.approvalRule, rule);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test("a default that is not signed in stays the default: no other model is put in its place", async () => {
    // A model Pi knows, of a provider nobody signed in to here.
    const away = app.models.getModels("anthropic")[0]!;

    app.config.lastModel = { provider: "faux", modelId: "other", thinkingLevel: "low" };
    app.config.defaultModel = { provider: away.provider, modelId: away.id, thinkingLevel: "off" };
    assert.equal(
        (await startsWith()).model,
        away.id,
        "the owner's default, not the last one picked",
    );
    app.config.defaultModel = undefined;
});

test("with no model anyone chose, a new session starts with none, never the first there is", async () => {
    app.config.defaultModel = undefined;
    app.config.lastModel = undefined;
    assert.equal((await startsWith()).model, undefined);
    // The last one picked, once there is one.
    app.config.lastModel = { provider: "faux", modelId: "other", thinkingLevel: "low" };
    assert.deepEqual(await startsWith(), { model: "other", thinkingLevel: "low" });
});
