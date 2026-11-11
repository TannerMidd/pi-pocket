// A tool marked for every subagent stays with an explicit tool list, only while its extension runs there. Tools that
// wait for search are offered at once, and tools that only scripts call still bring codemode.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    offerSubagents,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";

let app: App;
let tools: string[] | undefined;
let brief = "Check it.";

const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text === "spawn") {
        const args = {
            action: "spawn",
            name: "helper",
            message: brief,
            ...(tools === undefined ? {} : { tools }),
        };

        return fauxAssistantMessage(
            [
                fauxToolCall("codemode", {
                    code: `return await tools.subagent(${JSON.stringify(args)})`,
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (role === "user" && text === "Call the waiting tool.") {
        return fauxAssistantMessage([fauxToolCall("test_waiting", {})], {
            stopReason: "toolUse",
        });
    }

    if (role === "user" && text === "send") {
        return fauxAssistantMessage(
            [
                fauxToolCall("codemode", {
                    code: 'return await tools.subagent({ action: "send", name: "helper", message: "Again.", followUp: true })',
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("done")]);
});

before(async () => {
    mkdirSync(join(root, "data", "extensions"), { recursive: true });
    writeFileSync(
        join(root, "data", "extensions", "subagent-tools.ts"),
        `/** Tools for subagents: for tests. */
import { wrapTool } from "@earendil-works/pi-durable";
const tool = (name, options = {}) => ({
    name,
    description: "A test tool.",
    parameters: { type: "object", properties: {} },
    replay: "safe",
    ...options,
    execute: async () => ({ output: [{ type: "text", text: "ok" }] }),
});
export default () => [{
    name: "test-subagent-tools",
    tools: [
        tool("test_always", { subagents: "always" }),
        tool("test_waiting", { subagents: "always", deferred: true }),
        tool("test_script", { subagents: "always", deferred: true, callers: ["tools"] }),
        tool("test_optional"),
        tool("test_optional_waiting", { deferred: true }),
    ],
    wraps: [
        wrapTool({ name: "ask" }, (tool) => ({ ...tool, subagents: "always" })),
        wrapTool({ name: "codemode" }, (tool) => ({ ...tool })),
    ],
}, {
    name: "test-subagent-only",
    tools: [tool("only_always", { subagents: "always" })],
}];
`,
    );
    app = await openApp(model);
    await app.setExtensionEnabled(owner(app), "subagent-tools.ts", true);
    offerSubagents(app);
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function spawn(list: string[] | undefined, source?: ConversationId, message = "Check it.") {
    const parent = source ?? (await newSession(app));

    tools = list;
    brief = message;
    await say(app, parent, "spawn");
    let child: ConversationId | undefined;

    await until(async () => {
        child = (await app.harness.snapshot(SubagentsDoc, parent, context))?.agents.helper
            ?.conversationId;

        return child !== undefined && !app.isBusy(child);
    }, "the subagent's first answer");

    return {
        child: child!,
        agent: await (await app.conversation(child!)).agent(context),
        state: (await app.agentState(child!))!,
    };
}

test("an explicit list also gets tools marked for every subagent, but not other tools", async () => {
    const { agent } = await spawn(["read", "bash"]);
    const offered = agent.tools.map((tool) => tool.name);

    assert.ok(offered.includes("read"));
    assert.ok(offered.includes("bash"));
    assert.ok(offered.includes("test_always"));
    assert.ok(!offered.includes("test_optional"));
});

test("the model is not told about marked tools in the tool prompt or spawn result", async () => {
    const parent = await newSession(app);
    const parentAgent = await (await app.conversation(parent)).agent(context);
    const subagent = parentAgent.tools.find((tool) => tool.name === "subagent")!;
    const parameters = subagent.parameters as {
        properties: { tools: { description: string } };
    };

    assert.equal(
        parameters.properties.tools.description,
        "spawn only: the tool names it may use. Default: yours.",
    );
    assert.doesNotMatch(subagent.description, /marked|always/i);
    const { agent } = await spawn(["read", "write"], parent);
    const messages = (await (await app.conversation(parent)).context(context)).messages;
    const results = JSON.stringify(messages.filter((message) => message.role === "toolResult"));
    const sections = messages
        .filter((message) => message.role === "system")
        .map((message) => (message as { sections?: Record<string, string> }).sections?.subagents)
        .filter((section) => section !== undefined)
        .join("\n");

    assert.match(sections, /The subagent tool hands work/);
    assert.doesNotMatch(sections, /marked|always|test_waiting|test_script/i);
    assert.match(results, /Started helper on/);
    assert.doesNotMatch(results, /marked|always|test_waiting|test_script/i);
    assert.ok(agent.tools.some((tool) => tool.name === "read"));
    assert.ok(agent.tools.some((tool) => tool.name === "write"));
    assert.ok(agent.tools.some((tool) => tool.name === "test_always"));
});

test("a marked tool that waits for search is offered at once", async () => {
    const { child, agent, state } = await spawn([], undefined, "Call the waiting tool.");
    const messages = (await (await app.conversation(child)).context(context)).messages;

    assert.match(
        JSON.stringify(messages.filter((message) => message.role === "toolResult")),
        /"text":"ok"/,
    );
    assert.ok(agent.tools.some((tool) => tool.name === "test_waiting"));
    assert.ok(!agent.deferred.some((tool) => tool.name === "test_waiting"));
    assert.ok(!agent.tools.some((tool) => tool.name === "test_optional_waiting"));
    assert.ok(!Array.isArray(state.modelTools) && state.modelTools?.add?.includes("test_waiting"));
});

test("a marked tool from an extension removed for subagents does not come along", async () => {
    const parent = await newSession(app);
    const parentAgent = await (await app.conversation(parent)).agent(context);

    assert.ok(parentAgent.tools.some((tool) => tool.name === "ask"));
    const { agent, state } = await spawn(["read"], parent);

    assert.ok(!agent.extensions.some((extension) => extension.name === "pocket-ask"));
    assert.ok(!agent.tools.some((tool) => tool.name === "ask"));
    assert.ok(Array.isArray(state.tools) && !state.tools.includes("ask"));
});

test("a fixed extension list does not gain an extension or its marked tools", async () => {
    const parent = await newSession(app);
    const agent = await (await app.conversation(parent)).agent(context);

    await (
        await app.conversation(parent)
    ).configure(
        {
            extensions: agent.extensions.filter(
                (extension) => !extension.name.startsWith("test-subagent-"),
            ),
        },
        context,
    );
    const child = await spawn(["read"], parent);

    assert.ok(
        !child.agent.extensions.some((extension) => extension.name === "test-subagent-tools"),
    );
    assert.ok(!child.agent.tools.some((tool) => tool.name.startsWith("test_")));
    assert.ok(!child.agent.tools.some((tool) => tool.name === "only_always"));
    assert.ok(Array.isArray(child.state.tools) && !child.state.tools.includes("test_always"));
});

test("an extension the parent removed stays out of the subagent", async () => {
    const parent = await newSession(app);
    const parentAgent = await (await app.conversation(parent)).agent(context);

    await (
        await app.conversation(parent)
    ).configure(
        {
            extensions: {
                remove: parentAgent.extensions.filter((extension) =>
                    extension.name.startsWith("test-subagent-"),
                ),
            },
        },
        context,
    );
    const { agent, state } = await spawn(["read"], parent);

    assert.ok(!agent.extensions.some((extension) => extension.name.startsWith("test-subagent-")));
    assert.ok(Array.isArray(state.tools) && !state.tools.includes("test_always"));
    assert.ok(Array.isArray(state.tools) && !state.tools.includes("only_always"));
});

test("without a list, tool selection and deferred tools stay as before", async () => {
    const { agent, state } = await spawn(undefined);

    assert.equal(state.tools, undefined);
    assert.ok(agent.tools.some((tool) => tool.name === "test_always"));
    assert.ok(agent.tools.some((tool) => tool.name === "test_optional"));
    assert.ok(agent.deferred.some((tool) => tool.name === "test_waiting"));
    assert.ok(agent.deferred.some((tool) => tool.name === "test_optional_waiting"));
});

test("without a list, the subagent's extensions stay the host's defaults", async () => {
    const parent = await newSession(app);
    const extensions = (await (await app.conversation(parent)).agent(context)).extensions;

    await (
        await app.conversation(parent)
    ).configure(
        { extensions: { remove: extensions.filter((each) => each.name === "test-subagent-only") } },
        context,
    );
    const { agent } = await spawn(undefined, parent);

    assert.ok(agent.extensions.some((extension) => extension.name === "test-subagent-only"));
});

test("a list that already has a marked tool gets it once", async () => {
    const { agent, state } = await spawn(["read", "codemode", "test_always", "test_waiting"]);

    assert.equal(agent.tools.filter((tool) => tool.name === "test_always").length, 1);
    assert.ok(Array.isArray(state.tools));
    assert.equal(state.tools.filter((name) => name === "test_always").length, 1);
    assert.equal(state.tools.filter((name) => name === "test_waiting").length, 1);
    assert.equal(state.tools.filter((name) => name === "codemode").length, 1);
});

test("a marked tool that only scripts call also gets codemode, in On and Only modes", async () => {
    for (const mode of ["on", "only"]) {
        app.setExtensionSettings(owner(app), "codemode", { mode });
        const { agent } = await spawn([]);

        assert.ok(agent.tools.some((tool) => tool.name === "codemode"));
        assert.ok(agent.callable.some((tool) => tool.name === "test_script"));
        assert.ok(!agent.tools.some((tool) => tool.name === "test_script"));
        assert.equal(
            agent.tools.some((tool) => tool.name === "test_always"),
            mode === "on",
        );
    }

    app.setExtensionSettings(owner(app), "codemode", { mode: "on" });
});

test("Only mode still brings codemode when the parent disabled its marked tools", async () => {
    app.setExtensionSettings(owner(app), "codemode", { mode: "only" });
    const parent = await newSession(app);
    const parentAgent = await (await app.conversation(parent)).agent(context);

    await (
        await app.conversation(parent)
    ).configure(
        {
            extensions: parentAgent.extensions.filter(
                (extension) => extension.name !== "test-subagent-tools",
            ),
            tools: parentAgent.callable
                .filter((tool) => tool.name === "subagent")
                .concat(parentAgent.tools.filter((tool) => tool.name === "codemode")),
        },
        context,
    );
    const { agent } = await spawn([], parent);

    assert.ok(agent.tools.some((tool) => tool.name === "codemode"));
    assert.ok(agent.callable.some((tool) => tool.name === "only_always"));
    assert.ok(!agent.tools.some((tool) => tool.name === "only_always"));
    app.setExtensionSettings(owner(app), "codemode", { mode: "on" });
});

test("sending a follow-up does not add marked tools to an existing subagent", async () => {
    const parent = await newSession(app);
    const { child, agent } = await spawn(["read"], parent);

    await (
        await app.conversation(child)
    ).configure({ tools: agent.tools.filter((tool) => tool.name === "read") }, context);
    await say(app, parent, "send");

    assert.deepEqual((await app.agentState(child))?.tools, ["read"]);
});

test("marked tools of a loaded extension also come along when the parent disabled them", async () => {
    const parent = await newSession(app);

    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, parent)).tools = ["read", "subagent", "codemode"];
    }, context);
    const { agent } = await spawn(["read"], parent);

    assert.ok(agent.tools.some((tool) => tool.name === "test_always"));
    assert.ok(agent.tools.some((tool) => tool.name === "test_waiting"));
    assert.ok(agent.callable.some((tool) => tool.name === "test_script"));
});
