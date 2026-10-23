// Models are a person's to choose. A subagent runs on its session's model: with no models allowed (the default), Pi is
// offered no model and one it names is refused; the owner may allow others, and Pi may use only those. A subagent on a
// model no longer allowed gets no more work. With a list, a subagent or a linked session runs only on a listed model:
// the session's own when that is listed and none is named, else the one named, which is required when the session's is not listed. A subagent its model failed is reported as such, and Pi is told to stop
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
/** The names of the tools that subagents were offered. */
const subagentTools = new Set<string>();
/** The system messages of the parent's last request. */
let instructions = "";
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
    // A linked session's first message holds the task between fences. With more than one person on the server, a
    // message starts with who sent it.
    const text =
        /<linked-session-message>\n([^\n]+)\n/.exec(said)?.[1] ??
        said.replace(/^\[from: [^\]]+\] /, "");
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (subagent !== undefined) {
        for (const message of messages) {
            for (const tool of (message.toolsAdded ?? []) as { name: string }[]) {
                subagentTools.add(tool.name);
            }
        }

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

    instructions = JSON.stringify(messages.filter((message) => message.role === "system"));

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
    assert.match(started.answer, /carry on with your own part/);
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

test("the owner allows models: Pi may use those, and is refused any other and told to choose from the list", async () => {
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
    assert.match(refused.answer, /never one off the list/);
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

/** The text of what the tool calls of a session answered, in order. */
async function answers(id: ConversationId): Promise<string[]> {
    return (await (await app.harness.conversation(id, context))!.context(context)).messages
        .filter((message) => message.role === "toolResult")
        .map((message) => JSON.stringify(message));
}

test("with a list, a subagent with no model runs on the session's model if listed, else a model must be named", async () => {
    const me = owner(app);

    try {
        const id = await session();

        // The session's own model is listed: left out, it runs there.
        await app.setSubagentModels(me, ["faux/pricey", "faux/mine"]);
        const own = await ask(id, "spawn own");

        assert.match(own.answer, /Started own on faux\/mine\./);

        // Not listed: Pi must choose one from the list; there is no default.
        await app.setSubagentModels(me, ["faux/pricey", "faux/other"]);
        const none = await ask(id, "spawn none");

        assert.match(none.answer, /model is required/);
        assert.match(none.answer, /Choose one that suits the work: faux\/pricey, faux\/other/);
        assert.doesNotMatch(none.answer, /stop and (tell|ask) the user/i);
        assert.equal(none.agents.none, undefined);

        // Named, the session's own model is refused too.
        const refused = await ask(id, "spawn mine faux/mine");

        assert.match(refused.answer, /faux\/mine is not one of the models the user allows/);
        assert.match(refused.answer, /never one off the list/);
        assert.equal(refused.agents.mine, undefined);

        // A name that is no model at all is off the list too: the fix is to choose.
        const typo = await ask(id, "spawn typo faux/nonesuch");

        assert.match(typo.answer, /faux\/nonesuch is not one of the models the user allows/);
        assert.doesNotMatch(typo.answer, /stop and tell/i);

        const first = await ask(id, "spawn first faux/pricey");

        assert.match(first.answer, /Started first on faux\/pricey\./);

        const listed = await ask(id, "spawn second faux/other");

        assert.match(listed.answer, /Started second on faux\/other\./);

        // Work goes only to a subagent on a listed model: "own" is on faux/mine, which is not listed now.
        const stale = await ask(id, "send own");

        assert.match(
            stale.answer,
            /own runs on faux\/mine, which is not one of the models the user allows/,
        );
        assert.match((await ask(id, "send first")).answer, /Sent to first\./);

        // The prompt lists each model with its facts, and says the session's model is not listed.
        assert.match(instructions, /- faux\/pricey: /);
        assert.match(instructions, /thinks up to|no thinking/);
        assert.match(instructions, /Your model is not on the list, so model is required/);
        assert.match(instructions, /Match the model to the work/);
        assert.doesNotMatch(instructions, /first on the list/);

        // The session's model listed: marked, and left out means it.
        await app.setSubagentModels(me, ["faux/pricey", "faux/mine"]);
        await ask(id, "spawn again");
        assert.match(instructions, /- faux\/mine: [^\\]*your model/);
        assert.match(instructions, /Left out, it is your model/);
    } finally {
        await app.setSubagentModels(me, []);
    }
});

test("a subagent has no subagent or team tool of its own, so none starts a nested one", async () => {
    const id = await session();

    subagentTools.clear();
    const { agents } = await ask(id, "spawn leaf");

    await until(
        async () => (await answers(id)).length > 0 && subagentTools.size > 0,
        "the subagent's first request",
    );
    assert.ok(agents.leaf !== undefined);
    assert.ok(subagentTools.has("read"), "it has the ordinary tools");
    assert.equal(subagentTools.has("subagent"), false);
    assert.equal(subagentTools.has("team"), false);
});

test("a linked session started with a list runs on a listed model, and its subagents follow the list", async () => {
    const me = owner(app);

    try {
        await app.setSubagentModels(me, ["faux/pricey"]);
        const id = await session();
        const key = crypto.randomUUID();

        await ask(id, "hello");
        const left = await app.linkedSessions.start(
            id,
            { message: "spawn inner", model: "faux/pricey" },
            key,
        );

        assert.equal((await app.agentState(left.session))?.model?.modelId, "pricey");
        await assert.rejects(
            app.linkedSessions.start(id, { message: "spawn x", model: "faux/mine" }, "refused"),
            /not allowed here[^]*never use another/,
        );
        await assert.rejects(
            app.linkedSessions.start(id, { message: "spawn y" }, "no-model"),
            /A model is required[^]*faux\/pricey/,
        );
        await until(
            async () => (await answers(left.session)).length > 0 && !app.isBusy(left.session),
            "the linked session's subagent",
        );
        assert.match((await answers(left.session)).at(-1) ?? "", /Started inner on faux\/pricey\./);

        // Its own subagents are held to the list as well.
        const bad = await app.linkedSessions.start(
            id,
            { message: "spawn bad faux/mine", model: "faux/pricey" },
            "bad",
        );

        await until(
            async () => (await answers(bad.session)).length > 0 && !app.isBusy(bad.session),
            "the refusal in the linked session",
        );
        assert.match(
            (await answers(bad.session)).at(-1) ?? "",
            /faux\/mine is not one of the models the user allows/,
        );
    } finally {
        await app.setSubagentModels(me, []);
    }
});
