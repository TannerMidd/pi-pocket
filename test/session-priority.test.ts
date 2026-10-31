import {
    type App,
    cleanUp,
    context,
    lastText,
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
import type { ConversationId } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";

/** "fail now" ends the run in an error; "start a helper" starts a subagent whose own run fails; the rest is echoed. */
const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text } = lastText(request as never);

    if (/You are the subagent \\"flaky\\"/.test(all)) {
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Bad request" });
    }

    if (role === "user" && text.endsWith("fail now")) {
        return fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: `Invalid request: unsupported parameter temperature${" and so on".repeat(30)}`,
        });
    }

    if (role === "user" && text.endsWith("start a helper")) {
        return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "spawn", name: "flaky", message: "look around" })],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
let calls = 0;

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "priority-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

function ask(id: ConversationId, subject: string, createdAt: number, extra = {}): string {
    const request = {
        id: `priority-${++calls}`,
        conversationId: id,
        taskId: calls as never,
        callId: `call-${calls}`,
        tool: "bash",
        subject,
        reason: "Publishes to a package registry",
        createdAt,
        ...extra,
    };

    void app.approvals.request(request, context);

    return request.id;
}

const row = (id: ConversationId) => app.sessions(owner(app)).find((each) => each.id === id)!;

test("a session that waits carries its oldest call, and how many wait", async () => {
    const id = await newSession(app);

    assert.equal(row(id).approval, undefined, "nothing waits");
    const second = ask(id, "npm publish --tag beta", 2_000);
    const first = ask(id, "npm publish", 1_000);

    assert.equal(row(id).waiting, true);
    assert.deepEqual(row(id).approval, {
        id: first,
        conversationId: Number(id),
        tool: "bash",
        subject: "npm publish",
        reason: "Publishes to a package registry",
        at: 1_000,
        count: 2,
    });
    assert.equal(app.approvals.answer(first, { allow: false, by: "test" }), true);
    assert.equal(row(id).approval?.id, second);
    assert.equal(row(id).approval?.count, 1);
    assert.equal(app.approvals.answer(second, { allow: false, by: "test" }), true);
    assert.equal(row(id).approval, undefined);
    assert.equal(row(id).waiting, false);
});

test("what the list carries of a call is cut short, and a question is marked as one", async () => {
    const id = await newSession(app);
    const key = ask(id, "x".repeat(500), 1_000, {
        form: { title: "Which?", fields: [], submit: "Send" },
    });
    const { approval } = row(id);

    assert.equal(approval?.subject.length, 200);
    assert.equal(approval?.form, true);
    assert.equal(approval?.count, 1);
    app.approvals.answer(key, { allow: false, by: "test" });
});

test("a failed run says why, in a line that is cut short, and a new run clears it", async () => {
    const id = await newSession(app);

    assert.equal(row(id).failed, undefined);
    await app.commands.submit(id, owner(app), { text: "fail now", requestId: "fail-1" });
    await until(() => row(id).failed === true, "the failure");
    assert.match(row(id).failure!, /^Invalid request: unsupported parameter temperature and so on/);
    assert.equal(row(id).failure!.length, 120);
    await app.commands.submit(id, owner(app), { text: "again", requestId: "fail-2" });
    await until(() => row(id).failed === undefined && !app.isBusy(id), "a new run");
    assert.equal(row(id).failure, undefined);
});

test("failed subagents nobody dealt with are named, and leave when dealt with", async () => {
    const id = await newSession(app);

    assert.equal(row(id).failedAgents, undefined);
    await app.commands.submit(id, owner(app), { text: "start a helper", requestId: "helper-1" });
    await until(() => (row(id).failedAgents?.length ?? 0) === 1, "the failed subagent", 20_000);
    const child = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.flaky!;
    const [named] = row(id).failedAgents!;

    assert.equal(named!.name, "flaky");
    assert.equal(named!.conversationId, Number(child.conversationId));
    assert.equal(row(id).subagents?.failed, 1);
    const key = ask(child.conversationId, "ls", 5_000);

    assert.equal(row(id).waiting, true);
    assert.equal(row(id).approval?.conversationId, Number(child.conversationId));
    app.approvals.answer(key, { allow: false, by: "test" });
    const answer = await app.commands.dismissSubagent(child.conversationId, owner(app), named!.at);

    assert.equal(answer.dismissed, true);
    await until(() => row(id).failedAgents === undefined, "the failure dealt with");
    assert.equal(row(id).subagents?.dealt, 1);
});
