// A start reads the models of the providers extensions registered: their models work without the owner refreshing.
import { cleanUp, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");
const file = "startup-models.ts";

/** A drop-in whose provider starts with no models: only a read over the network gives it one. */
const module = `/** Startup models: a provider whose model comes from a read at the start. */
export default (host, web) => {
    const stop = host.registerModelProvider("startup", {
        name: "Startup",
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        apiKey: "test-only",
        models: [],
        async refreshModels({ allowNetwork, publish }) {
            const models = allowNetwork
                ? [
                      {
                          type: "chat",
                          id: "from-network",
                          name: "from-network",
                          api: "openai-completions",
                          baseUrl: "http://127.0.0.1:1/v1",
                          reasoning: false,
                          input: ["text"],
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                          contextWindow: 8000,
                          maxTokens: 1000,
                      },
                  ]
                : [];
            await publish?.({ persist: { models, checkedAt: Date.now() }, update: () => {} });

            return models;
        },
    });

    web.onDispose(stop);
};
`;

test("a start reads a provider an extension registered, so its models work without a refresh", async () => {
    mkdirSync(dropIns, { recursive: true });
    writeFileSync(join(dropIns, file), module);

    // Turn it on, as the owner would, then start again: that start loads it before anything else happens.
    const first = await openApp(scriptedModel(), dataDir);

    await first.setExtensionEnabled(owner(first), file, true);
    await first.close();

    const app = await openApp(scriptedModel(), dataDir);

    try {
        assert.equal(app.models.getModel("startup", "from-network"), undefined, "nothing kept yet");
        await until(
            () => app.models.getModel("startup", "from-network") !== undefined,
            "the start to read the provider's models",
        );
        assert.equal(app.models.getModel("startup", "from-network")?.id, "from-network");
    } finally {
        await app.close();
        cleanUp();
    }
});
