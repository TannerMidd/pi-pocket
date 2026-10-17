// The thinking level the subagent tool gives a subagent: any a session's model picker offers, up to the session's own
// and never above it; and when its model lacks the one asked for, or the one it starts with from Pi, the nearest lower
// one it has, with Pi told so.
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

/**
 * The parent spawns as its message says: `spawn <name> <level> [model]`, with `-` for no level. Subagents answer, and
 * the parent is done.
 */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const asked = /spawn (\S+) (\S+)(?: (\S+))?$/.exec(text);
    const again = /^send (\S+)$/.exec(text);

    if (role === "user" && again !== null) {
        return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "send", name: again[1]!, message: "More." })],
            { stopReason: "toolUse" },
        );
    }

    if (role === "user" && asked !== null) {
        const [, name, thinking, model] = asked;

        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: name!,
                    message: "Think about it.",
                    ...(thinking === "-" ? {} : { thinking }),
                    ...(model === undefined ? {} : { model }),
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("done")]);
};

const faux = fauxProvider({
    models: [{ id: "plain" }, { id: "thinker", reasoning: true }, { id: "deep", reasoning: true }],
});

// Thinks as far as max, as GPT-6 Luna does; the scripted provider has no option for it.
Object.assign(
    faux.models.find((model) => model.id === "deep")!,
    {
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    },
);
faux.setResponses(Array.from({ length: 100 }, () => route));

let app: App;

before(async () => {
    app = await openApp(faux);
    // Another model for subagents, as the owner may allow one: the levels it has are its own.
    await app.setSubagentModels(owner(app), ["faux/thinker"]);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/**
 * A session on `modelId` at `thinkingLevel` whose Pi spawns as `text` says; the subagent's thinking level, and what the
 * tool answered.
 */
async function spawn(modelId: string, text: string, thinkingLevel = "off") {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId },
        thinkingLevel,
    });
    await app.commands.submit(id, owner(app), { text, requestId: `spawn-${id}` });

    const name = /spawn (\S+)/.exec(text)![1]!;
    let child: ConversationId | undefined;

    await until(async () => {
        child = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents[name]
            ?.conversationId;

        return child !== undefined && !app.isBusy(id);
    }, `${name} spawned`);

    const messages = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;
    const answer = JSON.stringify(messages.filter((message) => message.role === "toolResult"));

    return { thinking: (await app.agentState(child!))?.thinkingLevel, answer };
}

test("a subagent thinks at max when its session does, on a model that has it", async () => {
    const { thinking, answer } = await spawn("deep", "spawn maxed max", "max");

    assert.equal(thinking, "max");
    assert.match(answer, /Started maxed on faux\/deep\./);
});

test("a subagent never thinks harder than its session, and Pi is told", async () => {
    const { thinking, answer } = await spawn("deep", "spawn eager max", "low");

    assert.equal(thinking, "low");
    assert.match(
        answer,
        /Started eager on faux\/deep, thinking at low: no higher than this session's low\./,
    );
    // Lower is fine.
    assert.equal((await spawn("deep", "spawn calm minimal", "high")).thinking, "minimal");
});

test("a level its model lacks becomes the nearest lower one it has, and Pi is told", async () => {
    const { thinking, answer } = await spawn("deep", "spawn capped max faux/thinker", "max");

    assert.equal(thinking, "high");
    assert.match(
        answer,
        /Started capped on faux\/thinker, thinking at high: its model has no max\./,
    );
});

test("with a model of its own and no level, the session's level fits its model, never above it", async () => {
    const { thinking, answer } = await spawn("deep", "spawn kept - faux/thinker", "max");

    assert.equal(thinking, "high");
    assert.match(answer, /Started kept on faux\/thinker, thinking at high: its model has no max\./);
    // On Pi's own model, Pi's own level stays.
    assert.equal((await spawn("deep", "spawn twin - faux/deep", "max")).thinking, "max");
});

test("without a model of its own, a subagent's level fits the model it shares with Pi", async () => {
    assert.equal((await spawn("deep", "spawn same max", "max")).thinking, "max");
    // A session on a model that does not think thinks at off, and so does its subagent, whatever is asked.
    assert.equal((await spawn("plain", "spawn none xhigh")).thinking, "off");
});

test("work sent to a subagent thinking harder than its session lowers it to the session's level", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "deep" },
        thinkingLevel: "max",
    });
    await app.commands.submit(id, owner(app), { text: "spawn lofty -", requestId: `lofty-${id}` });
    await until(async () => {
        const agent = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.lofty;

        return agent !== undefined && !app.isBusy(id) && !app.isBusy(agent.conversationId);
    }, "lofty spawned and done");
    const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.lofty!
        .conversationId;

    assert.equal((await app.agentState(child))?.thinkingLevel, "max");
    await app.commands.configure(id, owner(app), { thinkingLevel: "low" });
    await app.commands.submit(id, owner(app), { text: "send lofty", requestId: `again-${id}` });
    await until(
        async () => (await app.agentState(child))?.thinkingLevel === "low",
        "lofty lowered",
    );
    await until(() => !app.isBusy(id), "the parent at rest");
    const results = JSON.stringify(
        (await (await app.harness.conversation(id, context))!.context(context)).messages.filter(
            (message) => message.role === "toolResult",
        ),
    );

    assert.match(results, /Sent to lofty, thinking at low now: no higher than this session's\./);
});
