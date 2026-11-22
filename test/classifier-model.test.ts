// The owner's one shared classifier model: chosen in Providers, validated against the classifier models of providers
// signed in to, kept in the config, counted in the provider's list, and shown by Jev Hub. Pi Pocket names none itself.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createProvider } from "@earendil-works/pi-ai";
import { createHandler } from "../src/server/http.ts";
import { type App, cleanUp, openApp, owner, scriptedModel, until } from "./helpers.ts";

let app: App;

const classifier = (id: string, provider: string) => ({
    type: "classifier" as const,
    id,
    name: `Faux ${id}`,
    api: "typesafe-system-one" as const,
    provider,
    baseUrl: "https://faux.example/v1",
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64_000,
});

before(async () => {
    app = await openApp(scriptedModel());
    // One provider with a key (signed in), one without.
    app.models.registerNativeProvider(
        createProvider({
            id: "faux-jev",
            auth: { apiKey: { name: "Faux Jev", resolve: async () => ({ auth: {} }) } },
            models: [classifier("jev-test", "faux-jev")],
            classifiers: {
                "typesafe-system-one": {
                    classify: async () => {
                        throw new Error("not called");
                    },
                },
            },
        }),
    );
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("the list counts a provider's classifier models, and the owner picks one signed in", async () => {
    const row = app.providers.list(true).find((provider) => provider.id === "faux-jev");

    assert.equal(row?.classifiers, 1);
    assert.equal(row?.models, 0, "chat models are counted on their own");

    // Nothing is chosen by default: no hard-coded route.
    assert.equal(app.config.classifierModel, undefined);

    await until(() => app.models.hasConfiguredAuth("faux-jev"), "the provider's key is known");
    const listed = app.classifierModels(owner(app)).map((each) => each.spec);

    assert.ok(listed.includes("faux-jev/jev-test"));

    await assert.rejects(app.setClassifierModel(owner(app), "faux-jev/nope"), /classifier model/);
    await assert.rejects(app.setClassifierModel(owner(app), 7), /classifier model/);

    await app.setClassifierModel(owner(app), "faux-jev/jev-test");
    assert.equal(app.config.classifierModel, "faux-jev/jev-test");

    const guest = app.config.addUser("guest", "guest").user;

    await assert.rejects(app.setClassifierModel(guest, null), /Only the owner/);
    assert.throws(() => app.classifierModels(guest), /Only the owner/);

    await app.setClassifierModel(owner(app), null);
    assert.equal(app.config.classifierModel, undefined);
});

test("Jev Hub says when no classifier model is chosen, and names it when one is", async () => {
    await app.setExtensionEnabled(owner(app), "jev-hub.ts", true);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const read = async () =>
        (
            await fetch(`http://127.0.0.1:${port}/api/x/jev-hub/activity`, {
                headers: { "X-Pocket": "1", authorization: `Bearer ${app.config.ownerToken}` },
            })
        ).json() as Promise<{ classifierModel: string | null }>;

    try {
        assert.equal((await read()).classifierModel, null);
        await app.setClassifierModel(owner(app), "faux-jev/jev-test");
        assert.equal((await read()).classifierModel, "faux-jev/jev-test");
    } finally {
        await app.setClassifierModel(owner(app), null);
        server.closeAllConnections();
        server.close();
    }
});
