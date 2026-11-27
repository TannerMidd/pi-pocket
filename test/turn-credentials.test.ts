import {
    cleanUp,
    context,
    home,
    lastText,
    newSession,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const { PocketApp } = await import("../src/server/app.ts");

after(cleanUp);

test(
    "a shared session keeps the submitter's key across a tool, a queued guest, and a restart",
    { timeout: 30000 },
    async () => {
        const wire: (string | null | undefined)[][] = [];
        const keys = new Map<string, string>();
        const model = scriptedModel((req, opts) => {
            const { role, text } = lastText(req);

            wire.push([opts?.apiKey, opts?.headers?.["x-litellm-api-key"]]);

            return role === "user" && text.endsWith("ask Alice")
                ? fauxAssistantMessage(
                      [
                          fauxToolCall("ask", {
                              questions: [
                                  {
                                      header: "Choice",
                                      question: "Which?",
                                      options: [
                                          { label: "One", description: "First" },
                                          { label: "Two", description: "Second" },
                                      ],
                                      multiSelect: false,
                                  },
                              ],
                          }),
                      ],
                      { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage([fauxText("done")]);
        });
        const open = () =>
            PocketApp.open({
                dataDir: join(root, "shared"),
                home,
                defaultCwd: work,
                supervised: false,
                log: () => {},
                configureModels: (models) => models.registerNativeProvider(model.provider),
                turnCredentials: {
                    provider: "faux",
                    baseUrl: "https://gateway.invalid",
                    resolve: (id: string) => {
                        const key = keys.get(id);

                        return key === undefined
                            ? undefined
                            : {
                                  apiKey: key,
                                  headers: { "x-litellm-api-key": key + "-gateway" },
                              };
                    },
                },
            });
        let app = await open();

        try {
            const id = await newSession(app);
            const alice = owner(app);
            const bob = app.config.addUser("Bob", "guest").user;

            keys.set(alice.id, "fake-alice");
            keys.set(bob.id, "fake-bob");
            await app.commands.submit(id, alice, { text: "ask Alice", requestId: "alice" });
            await until(() => app.approvals.forConversation(id).length === 1, "Alice's tool card");
            assert.deepEqual(wire, [["fake-alice", "fake-alice-gateway"]]);
            await app.commands.submit(id, bob, {
                text: "Bob next",
                requestId: "bob",
                mode: "followUp",
            });
            const followUp = await app.commands.submit(id, alice, {
                text: "Alice after Bob",
                requestId: "alice-last",
                mode: "followUp",
            });

            await app.close();
            keys.set(alice.id, "fake-alice-refreshed");
            app = await open();
            await until(
                () => app.approvals.forConversation(id).length === 1,
                "the recovered tool card",
            );
            await app.answerApproval(app.approvals.forConversation(id)[0]!.id, true, owner(app), {
                q1: "One",
            });
            const submission = await app.harness.submission(followUp.submissionId, context);

            await submission!.wait(context);
            assert.deepEqual(wire, [
                ["fake-alice", "fake-alice-gateway"],
                ["fake-alice-refreshed", "fake-alice-refreshed-gateway"],
                ["fake-bob", "fake-bob-gateway"],
                ["fake-alice-refreshed", "fake-alice-refreshed-gateway"],
            ]);
            keys.delete(bob.id);
            const missing = await app.commands.submit(id, bob, {
                text: "no key",
                requestId: "missing",
            });
            const missingSubmission = await app.harness.submission(missing.submissionId, context);

            await missingSubmission!.wait(context);
            assert.equal(wire.length, 4, "missing credentials must stop before the provider");
            const transcript = JSON.stringify(await app.transcripts.allEntries(id, true));

            assert.match(transcript, /No personal credential/);
            assert.doesNotMatch(transcript, /fake-alice|fake-bob/);
        } finally {
            await app.close();
        }
    },
);

test("native Codex sends each person's bearer, account id and gateway key over HTTP", async () => {
    const requests: unknown[][] = [];
    const gateway = createServer((req, res) => {
        requests.push([
            req.url,
            req.headers.authorization,
            req.headers["chatgpt-account-id"],
            req.headers["x-litellm-api-key"],
        ]);
        req.resume();
        res.writeHead(200, { "content-type": "text/event-stream" });
        const response = {
            id: "local",
            status: "completed",
            output: [],
            usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        };

        res.end(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
    });

    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");

    try {
        const address = gateway.address();

        assert.ok(address && typeof address === "object");
        const baseUrl = `http://127.0.0.1:${address.port}/backend-api/codex`;
        // The Codex adapter reads the account claim. This local gateway accepts unsigned test tokens.
        const token = (id: string) =>
            "test." +
            Buffer.from(
                JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } }),
            ).toString("base64") +
            ".unsigned";
        const provider = "openai-codex";
        const app = await PocketApp.open({
            home,
            defaultCwd: work,
            supervised: false,
            dataDir: join(root, "native"),
            log: () => {},
            configureModels: (models) => models.registerProvider(provider, { baseUrl }),
            turnCredentials: {
                provider,
                baseUrl,
                resolve: (id) => ({
                    apiKey: token(id),
                    headers: { "x-litellm-api-key": "gateway-" + id },
                }),
            },
        });

        try {
            const alice = owner(app);
            const bob = app.config.addUser("Bob", "guest").user;
            const { id } = await app.commands.createSession(alice, { cwd: work });
            const model = app.models.getModels(provider)[0]!;

            await app.commands.configure(id, alice, {
                model: { provider, modelId: model.id },
                thinkingLevel: "off",
            });

            for (const person of [alice, bob]) {
                const { submissionId } = await app.commands.submit(id, person, {
                    text: "hello",
                    requestId: person.id,
                });
                const submission = await app.harness.submission(submissionId, context);

                await submission!.wait(context);
            }

            assert.deepEqual(
                requests,
                [alice, bob].map(({ id }) => [
                    "/backend-api/codex/responses",
                    "Bearer " + token(id),
                    id,
                    "gateway-" + id,
                ]),
            );
        } finally {
            await app.close();
        }
    } finally {
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
});
