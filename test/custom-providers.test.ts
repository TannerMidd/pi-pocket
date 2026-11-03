// OpenAI-compatible endpoints from the Providers sheet: models.json made when missing, keys in auth.json, hand-made
// files left alone, and an endpoint's models discovered.
import { cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
    existsSync,
    lstatSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { HttpError } from "../src/server/errors.ts";
import { idFor, parseModelList } from "../src/server/custom-providers.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR!;
const modelsFile = join(agentDir, "models.json");
const authFile = join(agentDir, "auth.json");
const readModels = () => JSON.parse(readFileSync(modelsFile, "utf8"));

let app: Awaited<ReturnType<typeof openApp>>;
let baseUrl: string;
let seenAuth: string | undefined;
let server: ReturnType<typeof createServer>;

before(async () => {
    server = createServer((request, response) => {
        seenAuth = request.headers.authorization;

        if (request.url === "/v1/models") {
            response.setHeader("content-type", "application/json");
            response.end(
                JSON.stringify({
                    object: "list",
                    data: [
                        { id: "qwen-big", object: "model", max_model_len: 131072 },
                        { id: "llama-small", object: "model" },
                    ],
                }),
            );

            return;
        }

        response.statusCode = 404;
        response.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
    app = await openApp(scriptedModel(), join(root, "data"));
});

after(async () => {
    server?.close();
    await app?.close();
    cleanUp();
});

test("ids come from the name and skip ones that are taken; model lists are read as OpenAI sends them", () => {
    assert.equal(
        idFor("My LM Studio!", () => false),
        "my-lm-studio",
    );
    assert.equal(
        idFor("openai", (id) => id === "openai"),
        "openai-2",
    );
    assert.deepEqual(
        parseModelList({ data: [{ id: "b" }, { id: "a", max_model_len: 4096 }, { id: "b" }] }),
        [{ id: "a", contextWindow: 4096 }, { id: "b" }],
    );
    assert.throws(() => parseModelList({ nope: 1 }));
});

test("discovery asks GET /models with the key", async () => {
    const models = await app.customProviders.discover({ baseUrl: `${baseUrl}/`, apiKey: "sk-1" });

    assert.deepEqual(models, [{ id: "llama-small" }, { id: "qwen-big", contextWindow: 131072 }]);
    assert.equal(seenAuth, "Bearer sk-1");
    await assert.rejects(
        app.customProviders.discover({ baseUrl: "http://127.0.0.1:1/v1" }),
        (error: unknown) => error instanceof HttpError && error.status === 502,
    );
    await assert.rejects(
        app.customProviders.discover({ baseUrl: "file:///etc" }),
        (error: unknown) => error instanceof HttpError && error.status === 400,
    );
});

test("adding one makes Pi's folder and models.json, keeps the key in auth.json, and Pi has its models", async () => {
    // Pi's folder as on a machine where Pi never ran.
    rmSync(agentDir, { recursive: true, force: true });
    assert.equal(existsSync(agentDir), false);

    const made = await app.customProviders.create({
        name: "Home LLM",
        baseUrl,
        apiKey: "sk-secret",
        models: [{ id: "qwen-big", contextWindow: 131072 }, "typed-by-hand"],
    });

    assert.equal(made.id, "home-llm");
    assert.equal(made.key, "stored");
    assert.deepEqual(made.models, ["qwen-big", "typed-by-hand"]);
    assert.equal(statSync(modelsFile).mode & 0o777, 0o600);

    const entry = readModels().providers["home-llm"];

    assert.equal(entry.api, "openai-completions");
    assert.equal(entry.baseUrl, baseUrl);
    assert.equal(entry.apiKey, undefined, "the key is not in models.json");
    assert.ok(readFileSync(authFile, "utf8").includes("sk-secret"), "the key is a stored sign-in");
    assert.equal(app.models.getModel("home-llm", "qwen-big")?.contextWindow, 131072);
    assert.ok(app.models.hasConfiguredAuth("home-llm"));

    // A saved endpoint's discovery uses its stored key.
    await app.customProviders.discover({ baseUrl, id: "home-llm" });
    assert.equal(seenAuth, "Bearer sk-secret");
    // Not to another address: there the key must be typed again.
    await assert.rejects(
        app.customProviders.discover({ baseUrl: "http://127.0.0.1:1/v1", id: "home-llm" }),
        (error: unknown) => error instanceof HttpError && error.status === 400,
    );
    await assert.rejects(
        app.customProviders.update("home-llm", { baseUrl: "http://127.0.0.1:1/v1" }),
        (error: unknown) => error instanceof HttpError && error.status === 400,
    );

    // A move with a new key: a discovery asked meanwhile waits for it, and never gets the old key.
    const moved = baseUrl.replace("127.0.0.1", "localhost");

    await Promise.all([
        app.customProviders.update("home-llm", { baseUrl: moved, apiKey: "sk-moved" }),
        app.customProviders.discover({ baseUrl: moved, id: "home-llm" }),
    ]);
    assert.equal(seenAuth, "Bearer sk-moved");
    await app.customProviders.update("home-llm", { baseUrl, apiKey: "sk-secret" });

    // A move that Pi's check refuses keeps the sign-in it had.
    await assert.rejects(
        app.customProviders.update("home-llm", {
            baseUrl: moved,
            apiKey: "sk-refused",
            models: [{ id: "half", contextWindow: 0.5 }],
        }),
        /contextWindow/,
    );
    assert.ok(readFileSync(authFile, "utf8").includes("sk-secret"));

    // A change to the file while the old key goes is not overwritten: the key comes back, unless a sign-in from
    // another tab stored a newer one meanwhile.
    const logout = app.providers.logout.bind(app.providers);

    const refusedMove = async (edit: string, rotate?: string) => {
        const edited = readFileSync(modelsFile, "utf8").replace("{", `{"$comment":"${edit}",`);

        app.providers.logout = async (id) => {
            await logout(id);

            if (rotate !== undefined) {
                await app.providers.storeApiKey(id, rotate);
            }

            writeFileSync(modelsFile, edited);
        };

        try {
            await assert.rejects(
                app.customProviders.update("home-llm", { baseUrl: moved, noKey: true }),
                /changed meanwhile/,
            );
        } finally {
            app.providers.logout = logout;
        }

        assert.equal(readFileSync(modelsFile, "utf8"), edited);
    };

    await refusedMove("by hand");
    assert.ok(readFileSync(authFile, "utf8").includes("sk-secret"));
    writeFileSync(modelsFile, JSON.stringify(readModels()));
    await refusedMove("again", "sk-rotated");
    assert.ok(readFileSync(authFile, "utf8").includes("sk-rotated"));
});

test("an edit keeps what it does not change; no key uses the placeholder; removing takes the key too", async () => {
    const config = readModels();

    config.providers["home-llm"].compat = { maxTokensField: "max_tokens" };
    config.providers["home-llm"].models[0].reasoning = true;
    config.providers.other = {
        baseUrl: "https://example.com/v1",
        api: "anthropic-messages",
        apiKey: "k",
    };
    // The user's own override of a built-in provider.
    config.providers.openai = { baseUrl: "https://proxy.example/v1", api: "openai-completions" };
    writeFileSync(modelsFile, JSON.stringify(config));

    const edited = await app.customProviders.update("home-llm", {
        models: ["qwen-big", "llama-small"],
        noKey: true,
    });

    assert.deepEqual(edited.models, ["qwen-big", "llama-small"]);
    assert.equal(edited.key, "none");

    const entry = readModels().providers["home-llm"];

    assert.deepEqual(entry.compat, { maxTokensField: "max_tokens" });
    assert.equal(entry.models[0].reasoning, true, "a kept model keeps its metadata");
    assert.equal(entry.apiKey, "none");
    assert.ok(!readFileSync(authFile, "utf8").includes("sk-secret"));
    assert.ok(app.models.getModel("home-llm", "llama-small"));
    assert.equal(app.models.getModel("home-llm", "typed-by-hand"), undefined);
    assert.deepEqual(
        app.customProviders.list().map((each) => each.id),
        ["home-llm"],
        "other APIs and built-in providers are not listed",
    );
    await assert.rejects(app.customProviders.remove("openai"), /No such endpoint/);

    // A new key is a new sign-in: a limit that the old key hit is not its own.
    const epoch = app.providers.signInEpoch("home-llm");

    await app.customProviders.update("home-llm", { apiKey: "sk-again" });
    assert.equal(app.providers.signInEpoch("home-llm"), epoch + 1);
    await app.customProviders.remove("home-llm");
    assert.equal(readModels().providers["home-llm"], undefined);
    assert.ok(!readFileSync(authFile, "utf8").includes("sk-again"), "its key goes too");
    assert.ok(readModels().providers.other && readModels().providers.openai, "the others stay");
    assert.equal(app.models.getModel("home-llm", "qwen-big"), undefined);
});

test("a hand-made file with comments, or one Pi refuses, is left alone", async () => {
    const commented = '{\n  // mine\n  "providers": {}\n}\n';

    writeFileSync(modelsFile, commented);
    await assert.rejects(
        app.customProviders.create({ name: "X", baseUrl, noKey: true, models: [] }),
        (error: unknown) => error instanceof HttpError && error.status === 409,
    );
    assert.equal(readFileSync(modelsFile, "utf8"), commented);
    assert.deepEqual(app.customProviders.list(), [], "the sheet still opens");

    const refused = JSON.stringify({ providers: { bad: { models: [{ id: 5 }] } } });

    writeFileSync(modelsFile, refused);
    await assert.rejects(
        app.customProviders.create({ name: "X", baseUrl, noKey: true, models: [] }),
        (error: unknown) => error instanceof HttpError && error.status === 409,
    );
    assert.equal(readFileSync(modelsFile, "utf8"), refused);

    // Nor does Pi Pocket write one Pi would refuse (a context window floored to 0).
    const empty = '{"providers":{}}';

    writeFileSync(modelsFile, empty);
    await assert.rejects(
        app.customProviders.create({
            name: "Half",
            baseUrl,
            noKey: true,
            models: [{ id: "half", contextWindow: 0.5 }],
        }),
        /contextWindow/,
    );
    assert.equal(readFileSync(modelsFile, "utf8"), empty);

    await assert.rejects(
        app.customProviders.create({ name: "X", baseUrl, models: [] }),
        /API key/,
        "a key or No key is required",
    );

    // Another server's change while this save checks its file is not undone.
    const saving = app.customProviders.create({ name: "Late", baseUrl, noKey: true, models: [] });
    const theirs = '{"providers":{"theirs":{}}}';

    await new Promise((resolve) => setImmediate(resolve));
    writeFileSync(modelsFile, theirs);
    await assert.rejects(saving, /changed meanwhile/);
    assert.equal(readFileSync(modelsFile, "utf8"), theirs);
    writeFileSync(modelsFile, empty);

    // A models.json that links to another file stays a link, and that file changes.
    const target = join(root, "dotfiles-models.json");

    writeFileSync(target, empty);
    rmSync(modelsFile);
    symlinkSync(target, modelsFile);
    await app.customProviders.create({ name: "Linked", baseUrl, noKey: true, models: [] });
    assert.ok(lstatSync(modelsFile).isSymbolicLink());
    assert.ok(JSON.parse(readFileSync(target, "utf8")).providers.linked);
});

test("a new endpoint does not take a key that auth.json keeps for its id", async () => {
    await app.customProviders.create({ name: "Gone", baseUrl, apiKey: "sk-gone", models: [] });
    // Removed by hand: auth.json keeps its key.
    writeFileSync(modelsFile, '{"providers":{}}');
    await app.models.refresh({ allowNetwork: false });

    const made = await app.customProviders.create({
        name: "Gone",
        baseUrl: baseUrl.replace("127.0.0.1", "localhost"),
        noKey: true,
        models: [],
    });

    assert.deepEqual([made.id, made.key], ["gone-2", "none"]);
});

test("a key that Pi stored for an endpoint without one does not move with it", async () => {
    await app.customProviders.create({ name: "Term", baseUrl, noKey: true, models: [] });
    // Pi in a terminal: /login term.
    const auth = JSON.parse(readFileSync(authFile, "utf8"));

    writeFileSync(authFile, JSON.stringify({ ...auth, term: { type: "api_key", key: "sk-term" } }));

    const moved = baseUrl.replace("127.0.0.1", "localhost");

    await assert.rejects(app.customProviders.update("term", { baseUrl: moved }), /URL changed/);
    await app.customProviders.update("term", { baseUrl: moved, noKey: true });
    assert.ok(!readFileSync(authFile, "utf8").includes("sk-term"));
});

test("a refused move puts the old key back only when no sign-in or sign-out came meanwhile", async () => {
    await app.customProviders.create({ name: "Rot", baseUrl, apiKey: "sk-v1", models: [] });

    const logout = app.providers.logout.bind(app.providers);
    const stored = () => JSON.parse(readFileSync(authFile, "utf8")).rot?.key;

    const refused = async (meanwhile: () => Promise<unknown> | void) => {
        app.providers.logout = async (id) => {
            app.providers.logout = logout;
            await logout(id);
            await meanwhile();
            // Another server changes models.json: the save is refused.
            writeFileSync(modelsFile, readFileSync(modelsFile, "utf8").replace("{", '{"x":1,'));
        };

        await assert.rejects(
            app.customProviders.update("rot", {
                baseUrl: baseUrl.replace("127.0.0.1", "localhost"),
                apiKey: "sk-mine",
            }),
            /changed meanwhile/,
        );
        writeFileSync(modelsFile, JSON.stringify({ ...readModels(), x: undefined }));
    };

    // Pi in a terminal stores a newer key.
    await refused(() =>
        writeFileSync(
            authFile,
            JSON.stringify({
                ...JSON.parse(readFileSync(authFile, "utf8")),
                rot: { type: "api_key", key: "sk-v2" },
            }),
        ),
    );
    assert.equal(stored(), "sk-v2");
    // Another tab logs out of it.
    await refused(() => logout("rot"));
    assert.equal(stored(), undefined);
});

test("a move with a new key takes a hand-made key out of models.json", async () => {
    const config = readModels();

    config.providers.hand = { baseUrl, api: "openai-completions", apiKey: "sk-file", models: [] };
    writeFileSync(modelsFile, JSON.stringify(config));
    await app.customProviders.update("hand", {
        baseUrl: baseUrl.replace("127.0.0.1", "localhost"),
        apiKey: "sk-new",
    });
    assert.equal(readModels().providers.hand.apiKey, undefined);
});

test("an endpoint takes its key in its form, not in a sign-in that holds Pi's queue open", async () => {
    await app.customProviders.create({ name: "Form", baseUrl, noKey: true, models: [] });
    assert.throws(
        () => app.providers.startLogin(owner(app), "form", "api_key"),
        (error: unknown) => error instanceof HttpError && error.status === 400,
    );
});

test("Find models sends one Authorization header, also for an endpoint with authHeader", async () => {
    const config = readModels();

    config.providers.bearer = {
        baseUrl,
        api: "openai-completions",
        apiKey: "sk-bearer",
        authHeader: true,
        models: [],
    };
    writeFileSync(modelsFile, JSON.stringify(config));
    await app.models.refresh({ allowNetwork: false });
    await app.customProviders.discover({ baseUrl, id: "bearer" });
    assert.equal(seenAuth, "Bearer sk-bearer");
});
