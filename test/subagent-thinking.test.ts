// A subagent thinks at the level Pi asks, also above its session's; a level its model lacks becomes a lower one, and a
// level raised by hand stays as work is sent.
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

/** The parent does as its message says: `spawn <name> <level>` or `send <name>`. Subagents answer, and the parent is done. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const asked = /spawn (\S+) (\S+)(?: (\S+))?$/.exec(text);
    const again = /^send (\S+)$/.exec(text);

    if (role === "user" && again !== null) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "send",
                    name: again[1]!,
                    message: "Think again.",
                }),
            ],
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

const faux = fauxProvider({ models: [{ id: "deep", reasoning: true }, { id: "plain" }] });

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

test("a subagent thinks harder than its session when Pi asks, with no note", async () => {
    const { thinking, answer } = await spawn("deep", "spawn eager high", "low");

    assert.equal(thinking, "high");
    assert.match(answer, /Started eager on faux\/deep\./);
});

test("a subagent with no level named takes its session's", async () => {
    assert.equal((await spawn("deep", "spawn same -", "medium")).thinking, "medium");
});

test("a level its model lacks becomes a lower one, and Pi is told", async () => {
    const { thinking, answer } = await spawn("plain", "spawn modest high", "medium");

    assert.equal(thinking, "off");
    assert.match(answer, /thinking at off: its model has no high\./);
});

test("a send leaves the level a person raised by hand", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "deep" },
        thinkingLevel: "low",
    });
    await app.commands.submit(id, owner(app), { text: "spawn steady -", requestId: "first" });

    let child: ConversationId | undefined;

    await until(async () => {
        child = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.steady
            ?.conversationId;

        return child !== undefined && !app.isBusy(id);
    }, "steady spawned");
    await app.commands.configure(child!, owner(app), { thinkingLevel: "high" });
    await app.commands.submit(id, owner(app), { text: "send steady", requestId: "second" });
    await until(() => !app.isBusy(id), "the send");

    const messages = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;

    assert.match(
        JSON.stringify(messages.filter((each) => each.role === "toolResult")),
        /Sent to steady\./,
    );
    assert.equal((await app.agentState(child!))?.thinkingLevel, "high");
});
