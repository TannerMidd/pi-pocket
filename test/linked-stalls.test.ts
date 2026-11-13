// The stall watch of linked sessions (`extensions/agent-teams.ts`): a lead hears of a linked session with no progress,
// and the hard limit stops its stuck call while its run goes on.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { STALL_LOOK } from "../src/server/stall-facts.ts";

let app: App;
let offset = 0;
let stuckCalls = 0;

before(async () => {
    STALL_LOOK.ms = 100;
    const model = scriptedModel((request) => {
        const { text, role } = lastText(request as never);

        if (role === "user" && text.includes("START_A_TEAM")) {
            return fauxAssistantMessage(
                [fauxToolCall("team", { action: "start", message: "HANG_HERE please." })],
                { stopReason: "toolUse" },
            );
        }

        // A stuck call that a person asks for, in a linked session or its lead.
        if (role === "user" && /WAKE_AND_HANG|HANG_LEAD/.test(text)) {
            return fauxAssistantMessage(
                [fauxToolCall("bash", { command: "exec tail -f /dev/null" })],
                { stopReason: "toolUse" },
            );
        }

        // The linked session: a call that never ends, then, once it is stopped, an answer.
        if (JSON.stringify(request).includes("HANG_HERE") && !text.includes("[linked sessions]")) {
            if (role !== "toolResult" && stuckCalls++ === 0) {
                return fauxAssistantMessage(
                    [fauxToolCall("bash", { command: "exec tail -f /dev/null" })],
                    { stopReason: "toolUse" },
                );
            }
        }

        return fauxAssistantMessage([fauxText("Done.")]);
    });

    app = await openApp(model, join(root, "linked-stalls"), () => Date.now() + offset);
    app.background.limits.commandQuietMs = 0;
    await app.setExtensionEnabled(owner(app), "agent-teams.ts", true);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** The call a session waits on now, if any. */
const running = async (id: ConversationId) =>
    (await app.harness.snapshot(LiveDoc, id, context))?.tools?.find(
        (tool) => tool.status === "running",
    )?.callId;

/** What a lead was told: its messages from people and from Pi Pocket. */
async function told(id: ConversationId): Promise<string> {
    const messages = (await (await app.harness.conversation(id, context))!.context(context))
        .messages;

    return JSON.stringify(messages.filter((message) => message.role === "user"));
}

/** A new lead and the linked session it started, at its first answer. */
async function team(): Promise<[ConversationId, ConversationId]> {
    const id = await newSession(app);

    await say(app, id, "START_A_TEAM");
    const started = app.sessions().find((session) => session.linkedFrom?.id === Number(id))!;

    return [id, started.id as unknown as ConversationId];
}

test("a lead hears once of a stalled linked session, and the hard limit stops its stuck call", async () => {
    const [id, target] = await team();

    await until(async () => (await running(target)) !== undefined, "the stuck call");
    await new Promise((resolve) => setTimeout(resolve, 300));
    offset += 61 * 60_000;
    await until(async () => (await told(id)).includes("stalled: no progress for 1 h"), "the stall");
    await until(async () => (await running(target)) === undefined, "the call stopped");
    await until(() => !app.isBusy(target), "its run on to its answer");
    assert.match(await told(id), /stop 1 of 2/);
    assert.equal(((await told(id)).match(/\[linked sessions\]/g) ?? []).length, 1, "one message");
});

test("a linked session that another wakes after its lead's watch ended is watched again", async () => {
    const [id, target] = await team();

    await until(() => !app.isBusy(target), "its first answer");
    await new Promise((resolve) => setTimeout(resolve, 300));
    offset += 4 * 60_000;
    // None at work for 3 min: the watch ends. A person wakes it, not its lead.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await app.commands.submit(target, owner(app), { text: "WAKE_AND_HANG", requestId: "w3" });
    await until(async () => (await running(target)) !== undefined, "the stuck call");
    await new Promise((resolve) => setTimeout(resolve, 300));
    offset += 61 * 60_000;
    await until(async () => (await told(id)).includes("stalled: no progress"), "the lead told");
});

test("a started session cannot stop a call of its lead", async () => {
    const [lead, child] = await team();

    await until(() => !app.isBusy(child), "the child idle");
    void app.commands.submit(lead, owner(app), { text: "HANG_LEAD", requestId: "leads" });
    await until(async () => (await running(lead)) !== undefined, "the lead's call");
    const callId = (await running(lead))!;
    const up = (await app.linkedSessions.list(child))[0]!;

    assert.equal(await app.linkedSessions.stopCall(child, { to: up.address, callId }), false);
    assert.equal(await running(lead), callId, "the lead's call still runs");
    await app.commands.abort(lead, owner(app));
});
