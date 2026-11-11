// A message to a subagent at work waits in its queue until its next pause (a steer) or the end of its run (a
// follow-up): the subagent tool says so when it sends one, and its status lists what waits.
import {
    type App,
    cleanUp,
    context,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: said } = lastText(request as never);
    const text = said.replace(/^\[from: [^\]]+\] /, "");

    // The subagent works on a long call, longer than the test takes.
    if (/You are the subagent/.test(all)) {
        return role === "toolResult"
            ? fauxAssistantMessage([fauxText("done")])
            : fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 600" })], {
                  stopReason: "toolUse",
              });
    }

    const call = (args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall("subagent", args)], { stopReason: "toolUse" });

    if (text === "spawn") {
        return call({ action: "spawn", name: "busy", message: "Work on it." });
    }

    if (text === "nudge") {
        return call({
            action: "send",
            name: "busy",
            message: "Change of plan: stop at step 2.",
            followUp: true,
        });
    }

    if (text === "status") {
        return call({ action: "status", name: "busy" });
    }

    return fauxAssistantMessage([fauxText("noted")]);
};

let app: App;
let id: ConversationId;

/** Ask the parent for something and wait for its answer; the newest tool result it got. */
async function ask(text: string): Promise<string> {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    const results = (await (await app.harness.conversation(id, context))!.context(context)).messages
        .filter((message) => message.role === "toolResult")
        .map((message) => (message.content as { text?: string }[])[0]?.text ?? "");

    return results.at(-1) ?? "";
}

const busy = async () => (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.busy;

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "subagent-queue"));
    id = await newSession(app);
    // Where `subagent` waits for tool search, as if Pi had loaded it.
    await loadTools(app, id, "subagent");
    await ask("spawn");
    await until(async () => {
        const agent = await busy();

        return agent !== undefined && app.isBusy(agent.conversationId);
    }, "the subagent at work");
});

after(async () => {
    const agent = await busy();

    if (agent !== undefined) {
        await (await app.harness.conversation(agent.conversationId, context))?.abort(context);
    }

    await app?.close();
    cleanUp();
});

test("a follow-up to a subagent at work is said to wait for the end of its run, and status lists it until then", async () => {
    assert.match(
        await ask("nudge"),
        /^Queued for busy: it is at work, and gets the message only when its current run ends\./,
    );
    const child = (await busy())!.conversationId;

    await until(
        async () =>
            ((await app.harness.snapshot(InboxDoc, child, context))?.items.length ?? 0) === 1,
        "the follow-up in the subagent's queue",
    );
    assert.equal(
        await ask("status"),
        "busy: working; 1 message waits in its queue (a follow-up, taken when its current run ends: “Change of plan: stop at step 2.”)",
    );
});
