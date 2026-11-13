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

test("a lead hears once of a stalled linked session, and the hard limit stops its stuck call", async () => {
    const id = await newSession(app);

    await say(app, id, "START_A_TEAM");
    const started = app.sessions().find((session) => session.linkedFrom?.id === Number(id))!;
    const target = started.id as unknown as ConversationId;
    const running = async () =>
        (await app.harness.snapshot(LiveDoc, target, context))?.tools?.find(
            (tool) => tool.status === "running",
        );

    await until(async () => (await running()) !== undefined, "the stuck call");
    await new Promise((resolve) => setTimeout(resolve, 300));
    offset += 61 * 60_000;

    const told = async () => {
        const messages = (await (await app.harness.conversation(id, context))!.context(context))
            .messages;

        return JSON.stringify(messages.filter((message) => message.role === "user"));
    };

    await until(async () => (await told()).includes("stalled: no progress for 1 h"), "the stall");
    await until(async () => (await running()) === undefined, "the call stopped");
    await until(() => !app.isBusy(target), "its run on to its answer");
    assert.match(await told(), /stop 1 of 2/);
    assert.equal(((await told()).match(/\[linked sessions\]/g) ?? []).length, 1, "one message");
});

test("a linked session that another wakes after its lead's watch ended is watched again", async () => {
    const id = await newSession(app);

    await say(app, id, "START_A_TEAM");
    const target = app.sessions().find((each) => each.linkedFrom?.id === Number(id))!
        .id as unknown as ConversationId;

    await until(() => !app.isBusy(target), "its first answer");
    await new Promise((resolve) => setTimeout(resolve, 300));
    offset += 4 * 60_000;
    // None at work for 3 min: the watch ends. A person wakes it, not its lead.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await app.commands.submit(target, owner(app), { text: "WAKE_AND_HANG", requestId: "w3" });
    await until(
        async () =>
            (await app.harness.snapshot(LiveDoc, target, context))?.tools?.some(
                (t) => t.status === "running",
            ) === true,
        "the stuck call",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    offset += 61 * 60_000;
    await until(
        async () =>
            JSON.stringify(
                (await (await app.harness.conversation(id, context))!.context(context)).messages,
            ).includes("stalled: no progress"),
        "the lead told",
    );
});

test("a started session cannot stop a call of its lead", async () => {
    const lead = await newSession(app);

    await say(app, lead, "START_A_TEAM");
    const child = app.sessions().find((each) => each.linkedFrom?.id === Number(lead))!
        .id as unknown as ConversationId;

    await until(() => !app.isBusy(child), "the child idle");
    void app.commands.submit(lead, owner(app), { text: "HANG_LEAD", requestId: "leads" });
    const running = async () =>
        (await app.harness.snapshot(LiveDoc, lead, context))?.tools?.find(
            (tool) => tool.status === "running",
        )?.callId;

    await until(async () => (await running()) !== undefined, "the lead's call");
    const callId = (await running())!;
    const up = (await app.linkedSessions.list(child))[0]!;

    assert.equal(await app.linkedSessions.stopCall(child, { to: up.address, callId }), false);
    assert.equal(await running(), callId, "the lead's call still runs");
    await app.commands.abort(lead, owner(app));
});
