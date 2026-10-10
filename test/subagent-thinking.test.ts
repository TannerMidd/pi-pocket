// The thinking level the subagent tool gives a subagent: any a session's model picker offers, max included; and when
// its model lacks the one asked for, or the one it starts with from Pi, the nearest one it has, as the picker gives,
// with Pi told so.
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

test("a subagent can think at max on a model that has it", async () => {
    const { thinking, answer } = await spawn("plain", "spawn maxed max faux/deep");

    assert.equal(thinking, "max");
    assert.match(answer, /Started maxed\./);
});

test("a level its model lacks becomes the nearest it has, and Pi is told", async () => {
    const { thinking, answer } = await spawn("plain", "spawn capped max faux/thinker");

    assert.equal(thinking, "high");
    assert.match(answer, /Started capped, thinking at high: its model has no max\./);
});

test("with a model of its own and no level, the level it starts with from Pi fits its model", async () => {
    const { thinking, answer } = await spawn("deep", "spawn kept - faux/thinker", "max");

    assert.equal(thinking, "high");
    assert.match(answer, /Started kept, thinking at high: its model has no max\./);
    // On Pi's own model, Pi's own level stays.
    assert.equal((await spawn("deep", "spawn twin - faux/deep", "max")).thinking, "max");
});

test("without a model of its own, a subagent's level fits the model it shares with Pi", async () => {
    assert.equal((await spawn("deep", "spawn same max")).thinking, "max");
    assert.equal((await spawn("plain", "spawn none xhigh")).thinking, "off");
});
