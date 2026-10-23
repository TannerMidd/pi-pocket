// Extension modules' model providers: registered with Pi's runtime, and taken out only by the version that put them in.
import {
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");
const file = "dropin-models.ts";

/**
 * A drop-in that registers `provider` with one model, and takes it out again with its module. `extra` adds to the
 * config, last, so it can override what comes before, and `after` runs once it registered.
 */
const module = (
    model: string,
    { provider = "dropin", extra = 'name: "Drop-in",', after = "" } = {},
) =>
    `/** Drop-in models: one provider for the model providers test. */
export default (host, web) => {
    const stop = host.registerModelProvider("${provider}", {
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        apiKey: "test-only",
        ${extra}
        models: [
            {
                id: "${model}",
                name: "${model}",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8000,
                maxTokens: 1000,
            },
        ],
    });

    web.onDispose(stop);
    ${after}
};
`;

const write = (name: string, source: string) => writeFileSync(join(dropIns, name), source);

let app: App;

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    write(file, module("one"));
    app = await openApp(scriptedModel(), dataDir);
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a module's provider serves Pi's model runtime, a reload keeps it, and turning the module off takes it out", async () => {
    assert.equal(app.models.getProvider("dropin"), undefined, "off until the owner turns it on");

    await app.setExtensionEnabled(owner(app), file, true);
    assert.ok(app.models.getModel("dropin", "one"), "the provider's model is in Pi's runtime");

    // A new version starts before the old one's cleanups run: the old cleanup must leave the new provider in place.
    write(file, module("two"));
    await app.loader.apply(file);
    assert.ok(
        app.models.getModel("dropin", "two"),
        "the reloaded module's model replaced the old one",
    );
    assert.equal(app.models.getModel("dropin", "one"), undefined);

    await app.setExtensionEnabled(owner(app), file, false);
    assert.equal(app.models.getProvider("dropin"), undefined, "the module's provider went with it");
    await newSession(app);
});

test("a reload uses the new version's config alone, not merged with the old one's", async () => {
    const name = "merge.ts";

    write(name, module("one", { provider: "merge", extra: 'name: "Old name",' }));
    await app.setExtensionEnabled(owner(app), name, true);
    assert.equal(app.models.getProvider("merge")?.name, "Old name");

    write(name, module("two", { provider: "merge", extra: "" }));
    await app.loader.apply(name);
    assert.notEqual(app.models.getProvider("merge")?.name, "Old name", "the old name did not stay");

    await app.setExtensionEnabled(owner(app), name, false);
    assert.equal(app.models.getProvider("merge"), undefined);
});

test("a version that registers and then fails to load leaves the old version's provider in place", async () => {
    const name = "fails.ts";

    write(name, module("one", { provider: "fails" }));
    await app.setExtensionEnabled(owner(app), name, true);

    write(name, module("two", { provider: "fails", after: 'throw new Error("broken");' }));
    await assert.rejects(app.loader.apply(name), /broken/);
    assert.ok(app.models.getModel("fails", "one"), "the old version's model is back");
    assert.equal(app.models.getModel("fails", "two"), undefined);

    await app.setExtensionEnabled(owner(app), name, false);
    assert.equal(
        app.models.getProvider("fails"),
        undefined,
        "the old version's removal still works",
    );
});

test("a config Pi refuses throws, keeps the provider before it, and leaves nothing behind", async () => {
    const name = "refused.ts";

    write(name, module("one", { provider: "refused" }));
    await app.setExtensionEnabled(owner(app), name, true);

    // Pi needs an `api` with `streamSimple`.
    write(
        name,
        module("two", { provider: "refused", extra: "streamSimple: () => {}, api: undefined," }),
    );
    await assert.rejects(app.loader.apply(name), /"api" is required/);
    assert.ok(app.models.getModel("refused", "one"), "the old version's provider is untouched");

    await app.setExtensionEnabled(owner(app), name, false);
    assert.equal(
        app.models.getProvider("refused"),
        undefined,
        "the refused registration does not keep the old one from going",
    );
});

test("two modules with one provider name: the last wins, and its removal puts back the other", async () => {
    const first = "first.ts";
    const second = "second.ts";

    write(first, module("first-model", { provider: "shared" }));
    write(second, module("second-model", { provider: "shared" }));
    await app.setExtensionEnabled(owner(app), first, true);
    await app.setExtensionEnabled(owner(app), second, true);
    assert.ok(app.models.getModel("shared", "second-model"), "the last registration is in force");
    assert.equal(app.models.getModel("shared", "first-model"), undefined);

    await app.setExtensionEnabled(owner(app), second, false);
    assert.ok(app.models.getModel("shared", "first-model"), "the first module's provider is back");

    // The registration in force stays when one before it goes.
    await app.setExtensionEnabled(owner(app), second, true);
    await app.setExtensionEnabled(owner(app), first, false);
    assert.ok(app.models.getModel("shared", "second-model"));

    await app.setExtensionEnabled(owner(app), second, false);
    assert.equal(app.models.getProvider("shared"), undefined);
});

test("open tabs get the provider's models when its module goes on, and lose them when it goes off", async () => {
    const name = "tabs.ts";
    const tab = fakeTab(await newSession(app), owner(app));
    const listed = () =>
        (tab.last("models") as unknown as { provider: string; id: string }[] | undefined)?.some(
            (model) => model.provider === "tabs" && model.id === "tab-model",
        );

    await app.attach(tab.client);
    write(name, module("tab-model", { provider: "tabs" }));
    await app.setExtensionEnabled(owner(app), name, true);
    await until(() => listed() === true, "the tab to get the provider's model");

    await app.setExtensionEnabled(owner(app), name, false);
    await until(() => listed() === false, "the tab to lose the provider's model");
});
