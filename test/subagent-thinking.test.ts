// A subagent never thinks harder than its session, however hard Pi asks.
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

/** The parent spawns as its message says: `spawn <name> <level>`. Subagents answer, and the parent is done. */
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

const faux = fauxProvider({ models: [{ id: "deep", reasoning: true }] });

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

test("a subagent never thinks harder than its session, and Pi is told", async () => {
    const { thinking, answer } = await spawn("deep", "spawn eager max", "low");

    assert.equal(thinking, "low");
    assert.match(
        answer,
        /Started eager on faux\/deep, thinking at low: no higher than this session's low\./,
    );
});
