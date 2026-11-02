// OpenAI-compatible endpoints from the Providers sheet: models.json made when missing, keys in auth.json, hand-made
// files left alone, and an endpoint's models discovered.
import { cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
                        { id: "qwen-big", object: "model", context_length: 131072 },
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

test("ids come from the name and skip ones that are taken; model lists are read in their usual shapes", () => {
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
    assert.deepEqual(parseModelList({ models: [{ name: "x" }] }), [{ id: "x" }]);
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
        "other APIs are not listed",
    );

    await app.customProviders.remove("home-llm");
    assert.equal(readModels().providers["home-llm"], undefined);
    assert.ok(readModels().providers.other, "other providers stay");
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

    const refused = JSON.stringify({ providers: { bad: { models: [{ id: 5 }] } } });

    writeFileSync(modelsFile, refused);
    await assert.rejects(
        app.customProviders.create({ name: "X", baseUrl, noKey: true, models: [] }),
        (error: unknown) => error instanceof HttpError && error.status === 409,
    );
    assert.equal(readFileSync(modelsFile, "utf8"), refused);

    await assert.rejects(
        app.customProviders.create({ name: "X", baseUrl, models: [] }),
        /API key/,
        "a key or No key is required",
    );
});
