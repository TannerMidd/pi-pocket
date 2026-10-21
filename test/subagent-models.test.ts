// Models are a person's to choose. A subagent runs on its session's model: with no models allowed (the default), Pi is
// offered no model and one it names is refused; the owner may allow others, and Pi may use only those. A subagent on a
// model no longer allowed gets no more work. A subagent its model failed is reported as such, and Pi is told to stop
// and tell the user rather than try another model.
import { type App, cleanUp, context, lastText, openApp, owner, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import { MODEL_FAILED } from "../src/server/extensions/subagents.ts";

/** The subagent tool's parameters as the parent's last request offered them. */
let offered: Record<string, unknown> | undefined;
/** Subagents whose model fails, as a provider whose sign-in expired would. */
const failing = new Set<string>();

/**
 * The parent does as its message says: `spawn <name> [model]` or `send <name>`. Subagents answer, or fail when their
 * name is in `failing`; the parent is done.
 */
const route: FauxResponseStep = (request) => {
    const messages = (request as { messages: { role: string; toolsAdded?: unknown[] }[] }).messages;
    const all = JSON.stringify(messages);
    const { role, text: said } = lastText(request as never);
    // With more than one person on the server, a message starts with who sent it.
    const text = said.replace(/^\[from: [^\]]+\] /, "");
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (subagent !== undefined) {
        return failing.has(subagent)
            ? fauxAssistantMessage([], {
                  stopReason: "error",
                  errorMessage: "OAuth refresh failed for faux",
              })
            : fauxAssistantMessage([fauxText(`result of ${subagent}`)]);
    }

    for (const message of messages) {
        for (const tool of (message.toolsAdded ?? []) as {
            name: string;
            parameters: { properties: Record<string, unknown> };
        }[]) {
            if (tool.name === "subagent") {
                offered = tool.parameters.properties;
            }
        }
    }

    const spawn = /^spawn (\S+)(?: (\S+))?$/.exec(text);
    const send = /^send (\S+)$/.exec(text);

    if (role === "user" && (spawn !== null || send !== null)) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: spawn === null ? "send" : "spawn",
                    name: (spawn ?? send)![1]!,
                    message: "Review it, please.",
                    ...(spawn?.[2] === undefined ? {} : { model: spawn[2] }),
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("done")]);
};

const faux = fauxProvider({ models: [{ id: "mine" }, { id: "pricey" }, { id: "other" }] });

faux.setResponses(Array.from({ length: 200 }, () => route));

let app: App;

before(async () => {
    app = await openApp(faux);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** A session on faux/mine. */
async function session(): Promise<ConversationId> {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "mine" },
        thinkingLevel: "off",
    });

    return id;
}

/** Send the parent `text` and wait for it to be done; what its tool calls answered, and its subagents. */
async function ask(id: ConversationId, text: string) {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await until(() => !app.isBusy(id), "the parent at rest");
    const results = (await (await app.harness.conversation(id, context))!.context(context)).messages
        .filter((message) => message.role === "toolResult")
        .map((message) => JSON.stringify(message));

    return {
        answer: results.at(-1) ?? "",
        agents: (await app.harness.snapshot(SubagentsDoc, id, context))?.agents ?? {},
    };
}

test("with no models allowed, a subagent runs on its session's model, and Pi is offered no other", async () => {
    const id = await session();
    const started = await ask(id, "spawn plain");

    assert.match(started.answer, /Started plain on faux\/mine\./);
    assert.equal(
        (await app.agentState(started.agents.plain!.conversationId))?.model?.modelId,
        "mine",
    );
    assert.ok(offered !== undefined, "the parent was offered the tool");
    assert.equal("model" in offered, false, "no model parameter");

    // One it names anyway is refused, nothing made, and Pi is told to ask the user.
    const refused = await ask(id, "spawn sneaky faux/pricey");

    assert.match(refused.answer, /cannot choose another/);
    assert.match(refused.answer, /ask the user/);
    assert.equal(refused.agents.sneaky, undefined);
});

test("the owner allows models: Pi may use those, and is refused any other with word to ask the user", async () => {
    const me = owner(app);
    const guest = app.config.addUser("Guest", "guest").user;

    await assert.rejects(app.setSubagentModels(guest, ["faux/pricey"]), { status: 403 });
    await app.setSubagentModels(me, ["faux/pricey"]);

    const id = await session();
    const allowed = await ask(id, "spawn reviewer faux/pricey");

    assert.match(allowed.answer, /Started reviewer on faux\/pricey\./);
    assert.ok(offered !== undefined && "model" in offered, "the tool offers a model now");
    assert.equal(
        (await app.agentState(allowed.agents.reviewer!.conversationId))?.model?.modelId,
        "pricey",
    );

    const refused = await ask(id, "spawn wanderer faux/other");

    assert.match(refused.answer, /faux\/other is not one of the models the user allows/);
    assert.match(refused.answer, /Do not pick another model/);
    assert.equal(refused.agents.wanderer, undefined);

    // Allowed no longer: the subagent on it gets no more work.
    await app.setSubagentModels(me, []);
    const after = await ask(id, "send reviewer");

    assert.match(
        after.answer,
        /reviewer runs on faux\/pricey, which is neither this session's model nor one/,
    );
    assert.equal("model" in (offered ?? {}), false, "the tool offers no model again");
});

test("a subagent its model failed is reported with the model, and Pi is told to stop and tell the user", async () => {
    const id = await session();

    failing.add("expired");

    try {
        await ask(id, "spawn expired");
        await until(
            async () =>
                JSON.stringify(
                    (await (await app.harness.conversation(id, context))!.context(context))
                        .messages,
                ).includes("[subagent expired failed"),
            "the failure's report",
        );
    } finally {
        failing.delete("expired");
    }

    const said = JSON.stringify(
        (await (await app.harness.conversation(id, context))!.context(context)).messages,
    );

    assert.match(said, /\[subagent expired failed: faux\/mine: OAuth refresh failed for faux\]/);
    assert.ok(said.includes(MODEL_FAILED), "Pi is told to stop and tell the user");
});

test("models allowed together, as from two tabs, all count, and only the owner may allow", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const toggle = (body: unknown, token = app.config.ownerToken) =>
        fetch(`http://127.0.0.1:${port}/api/subagent-models`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                "x-pocket": "1",
            },
            body: JSON.stringify(body),
        });
    const kept = () => [...app.config.subagentModels].sort();

    try {
        await app.setSubagentModels(owner(app), []);

        // Three at once: each is read and written with no wait between, so none undoes another.
        const answers = await Promise.all(
            ["faux/mine", "faux/pricey", "faux/other"].map((model) =>
                toggle({ model, allowed: true }),
            ),
        );

        assert.deepEqual(
            answers.map((answer) => answer.status),
            [200, 200, 200],
        );
        assert.deepEqual(kept(), ["faux/mine", "faux/other", "faux/pricey"]);

        const guest = app.config.addUser("Cal", "guest").token;

        assert.equal((await toggle({ model: "faux/other", allowed: true }, guest)).status, 403);
    } finally {
        server.closeAllConnections();
        server.close();
        await app.setSubagentModels(owner(app), []);
    }
});
