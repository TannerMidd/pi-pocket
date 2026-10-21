import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { createHandler } from "../src/server/http.ts";
import type { Provider } from "@earendil-works/pi-ai";

let app: App;
const configPath = join(root, "agent", "models.json");
const authPath = join(root, "agent", "auth.json");

before(async () => {
    app = await openApp(scriptedModel());
});
after(async () => {
    await app?.close();
    cleanUp();
});

function config(id: string) {
    writeFileSync(
        configPath,
        JSON.stringify({
            providers: {
                local: {
                    baseUrl: "http://127.0.0.1:1/v1",
                    api: "openai-completions",
                    models: [{ id }],
                },
            },
        }),
    );
}

test("refresh reloads model edits and sign-ins, but keeps working models on invalid configuration", async () => {
    config("first");
    writeFileSync(authPath, JSON.stringify({ local: { type: "api_key", key: "test-only" } }));
    assert.equal((await app.providers.modelRefresh.refresh()).added, 1);
    assert.ok(app.models.getAvailableSnapshot().some((model) => model.id === "first"));
    config("second");
    const changed = await app.providers.modelRefresh.refresh();

    assert.equal(changed.added, 1);
    assert.equal(changed.removed, 1);
    writeFileSync(configPath, "{ invalid");
    assert.equal((await app.providers.modelRefresh.refresh()).errors[0]?.provider, "models.json");
    assert.ok(app.models.getModel("local", "second"));
    config("second");
    writeFileSync(authPath, "{}");
    assert.equal((await app.providers.modelRefresh.refresh()).removed, 1);
    rmSync(configPath);
});

test("refresh isolates failed and slow providers without blocking sessions", async () => {
    const { ModelRefresh } = await import("../src/server/model-refresh.ts");
    const base = app.models.getProvider("faux")!;
    const providers = ["healthy", "broken", "slow"].map((id) => {
        const provider: Provider = {
            ...base,
            id,
            name: id,
            getModels: () => [{ ...base.getModels()[0]!, provider: id, id: "old" }],
            refreshModels: async (context) => {
                if (!context.allowNetwork) {
                    return;
                }

                if (id === "broken") {
                    throw new Error("secret API key");
                }

                if (id === "slow") {
                    await new Promise(() => {});
                }

                await context.publish({
                    update: () => {
                        provider.getModels = () => [
                            { ...base.getModels()[0]!, provider: id, id: "new" },
                        ];
                    },
                });
            },
        };

        app.models.registerNativeProvider(provider);

        return provider;
    });

    await until(async () => {
        await app.models.getAvailable();

        return providers.every(({ id }) => app.models.getModel(id, "old") !== undefined);
    }, "provider registration");
    const session = await newSession(app);
    const refresh = new ModelRefresh(app, 400);
    const pending = refresh.refresh();

    assert.equal(refresh.refresh(), pending);
    await until(() => app.models.getModel("healthy", "new") !== undefined, "healthy models");
    await say(app, session, "Still working");
    const result = await pending;

    assert.deepEqual(result.errors.map(({ provider }) => provider).sort(), ["broken", "slow"]);
    assert.doesNotMatch(JSON.stringify(result), /secret API key/);
    assert.ok(app.models.getModel("broken", "old"));
    assert.ok(app.models.getModel("slow", "old"));
    assert.deepEqual((await app.agentState(session))?.model, {
        provider: "faux",
        modelId: "faux-1",
    });

    for (const { id } of providers) {
        app.models.unregisterProvider(id);
    }
});

test("the refresh endpoint requires an owner and the CSRF header", async () => {
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/models/refresh`;
    const guest = app.config.addUser("Guest", "guest");
    const post = (token: string, csrf = true) =>
        fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, ...(csrf ? { "X-Pocket": "1" } : {}) },
        });

    try {
        assert.equal((await post(guest.token)).status, 403);
        assert.equal((await post(app.config.ownerToken, false)).status, 403);
        assert.equal((await post(app.config.ownerToken)).status, 200);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});
