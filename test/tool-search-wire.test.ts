// A load never changes the tool list on the wire, so the prompt cache that starts with it stays.
import { cleanUp, context, owner, root, work, home } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";

const { PocketApp } = await import("../src/server/app.ts");

const bodies: { tools?: { name: string }[]; messages: unknown[] }[] = [];

const sse = (events: object[]) =>
    events
        .map(
            (each) =>
                `event: ${(each as { type: string }).type}\ndata: ${JSON.stringify(each)}\n\n`,
        )
        .join("");

/** The endpoint: Pi asks for `tool_search` on "need the browser", and answers "ok" to anything else. */
const endpoint = createServer((request, response) => {
    let data = "";

    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => {
        const body = JSON.parse(data) as (typeof bodies)[number];
        const last = JSON.stringify(body.messages.at(-1));
        const search = last.includes("need the browser") && !last.includes("tool_result");
        const usage = { input_tokens: 10, output_tokens: 5 };
        const block = search
            ? [
                  {
                      type: "content_block_start",
                      index: 0,
                      content_block: {
                          type: "tool_use",
                          id: "toolu_1",
                          name: "tool_search",
                          input: {},
                      },
                  },
                  {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "input_json_delta", partial_json: '{"query":"browser"}' },
                  },
              ]
            : [
                  {
                      type: "content_block_start",
                      index: 0,
                      content_block: { type: "text", text: "" },
                  },
                  {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "text_delta", text: "ok" },
                  },
              ];

        bodies.push(body);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
            sse([
                {
                    type: "message_start",
                    message: {
                        id: "m",
                        type: "message",
                        role: "assistant",
                        model: "x",
                        content: [],
                        stop_reason: null,
                        usage,
                    },
                },
                ...block,
                { type: "content_block_stop", index: 0 },
                {
                    type: "message_delta",
                    delta: { stop_reason: search ? "tool_use" : "end_turn" },
                    usage: { output_tokens: 5 },
                },
                { type: "message_stop" },
            ]),
        );
    });
});

await new Promise<void>((done) => endpoint.listen(0, "127.0.0.1", done));

const model = (id: string, compat: object) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 8000,
    compat,
});

mkdirSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true });
writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "models.json"),
    JSON.stringify({
        providers: {
            fake: {
                baseUrl: `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`,
                api: "anthropic-messages",
                apiKey: "x",
                models: [
                    model("native", {
                        supportsMidConvoSystemMessages: true,
                        supportsMidConvoToolChanges: true,
                    }),
                    model("plain", {}),
                ],
            },
        },
    }),
);

const app = await PocketApp.open({
    dataDir: join(root, "wire"),
    defaultCwd: work,
    supervised: false,
    log: () => {},
    home,
});

after(async () => {
    await app.close();
    endpoint.close();
    cleanUp();
});

async function requests(modelId: string) {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "fake", modelId },
        thinkingLevel: "off",
    });
    bodies.length = 0;

    for (const text of ["hi", "need the browser", "and now?"]) {
        const { submissionId } = await app.commands.submit(id, owner(app), {
            text,
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(submissionId, context))!.wait(context);
    }

    return bodies.map((body) => ({
        tools: (body.tools ?? []).map((tool) => tool.name),
        additions: JSON.stringify(body.messages).match(/tool_addition/g)?.length ?? 0,
    }));
}

test("on a model with mid-conversation tool changes, a load leaves the tool list as it was", async () => {
    const sent = await requests("native");
    const first = sent[0]!;
    const last = sent.at(-1)!;

    assert.ok(!first.tools.includes("browser"), "browser waits at first");
    assert.deepEqual(last.tools, first.tools, "the list, where the cache starts, did not change");
    assert.equal(first.additions, 0);
    assert.ok(last.additions >= 1, "the tool came in a tool_addition block of the messages");
});

test("on any other model, a load leaves the tool list as it was too, and the tool comes in a codemode script", async () => {
    const sent = await requests("plain");
    const first = sent[0]!;
    const last = sent.at(-1)!;

    assert.ok(!first.tools.includes("browser"));
    assert.deepEqual(last.tools, first.tools, "nothing is appended to the list");
    assert.equal(last.additions, 0, "and no tool_addition block is sent");
});
