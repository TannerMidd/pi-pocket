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

test("the default keeps a thinking level its model has", async () => {
    await app.setDefaultModel(owner(app), {
        provider: "faux",
        modelId: "plain",
        thinkingLevel: "high",
    });
    assert.equal(app.config.defaultModel?.thinkingLevel, "off");
    assert.deepEqual(await startsWith(), { model: "plain", thinkingLevel: "off" });
    await app.setDefaultModel(owner(app), null);
});

test("only the owner chooses the default, and only a model signed in here", async () => {
    const guest = app.config.addUser("Alex", "guest").user;

    await assert.rejects(app.setDefaultModel(guest, { provider: "faux", modelId: "thinker" }), {
        status: 403,
    });
    await assert.rejects(
        app.setDefaultModel(owner(app), { provider: "faux", modelId: "missing" }),
        { status: 400, message: /not available/ },
    );
    await assert.rejects(app.setDefaultModel(owner(app), "thinker"), { status: 400 });
    await assert.rejects(
        app.setDefaultModel(owner(app), {
            provider: "faux",
            modelId: "thinker",
            thinkingLevel: "banana",
        }),
        { status: 400 },
    );
    assert.equal(app.config.defaultModel, undefined);
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
