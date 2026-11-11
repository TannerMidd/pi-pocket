// The subagent tool's status: a subagent at work says when it last did something, and one quiet for too long is called
// stalled; without a name, status lists only those at work and counts the rest.
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
import type { ConversationId } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";

/** Subagents that run a `sleep` of so many seconds before they answer: longer than the tests take. */
const slow: Record<string, number> = { hang: 600 };
/** How far the app's clock is ahead of the real one. */
let offset = 0;

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: said } = lastText(request as never);
    const text = said.replace(/^\[from: [^\]]+\] /, "");
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (subagent !== undefined) {
        if (slow[subagent] !== undefined && role !== "toolResult") {
            return fauxAssistantMessage(
                [fauxToolCall("bash", { command: `sleep ${slow[subagent]}` })],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText(`result of ${subagent}`)]);
    }

    const spawn = /^spawn (.+)$/.exec(text);

    if (spawn !== null) {
        return fauxAssistantMessage(
            spawn[1]!
                .split(" ")
                .map((name) =>
                    fauxToolCall("subagent", { action: "spawn", name, message: `Check ${name}.` }),
                ),
            { stopReason: "toolUse" },
        );
    }

    const status = /^status ?(\S*)$/.exec(text);

    if (status !== null) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "status",
                    ...(status[1] === "" ? {} : { name: status[1] }),
                }),
            ],
            { stopReason: "toolUse" },
        );
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

const agents = async () => (await app.harness.snapshot(SubagentsDoc, id, context))?.agents ?? {};

before(async () => {
    app = await openApp(
        scriptedModel(route),
        join(root, "subagent-status"),
        () => Date.now() + offset,
    );
    id = await newSession(app);
    // Where `subagent` waits for tool search, as if Pi had loaded it.
    await loadTools(app, id, "subagent");
    await ask("spawn done1 done2 hang");
    await until(
        async () => {
            const hang = (await agents()).hang;
            const got = JSON.stringify(
                (await (await app.harness.conversation(id, context))!.context(context)).messages,
            );

            return (
                got.includes("[subagent done1 answered") &&
                got.includes("[subagent done2 answered") &&
                hang !== undefined &&
                app.isBusy(hang.conversationId) &&
                !app.isBusy(id)
            );
        },
        "two subagents' reports with the parent, and one subagent at work",
        20_000,
    );
});

after(async () => {
    const hang = (await agents()).hang;

    if (hang !== undefined) {
        await (await app.harness.conversation(hang.conversationId, context))?.abort(context);
    }

    await app?.close();
    cleanUp();
});

test("a subagent at work with nothing new in its transcript for longer than the setting is called stalled", async () => {
    assert.match(
        await ask("status hang"),
        /^hang: working; running bash; last activity \d+ s ago$/,
    );

    offset += 2 * 60 * 60_000;
    assert.match(
        await ask("status hang"),
        /^hang: working; running bash; last activity 2 h ago: stalled, nothing new for 30 min or more$/,
    );
});

test("status without a name lists the subagents at work and counts the rest; all lists every one", async () => {
    const compact = await ask("status");

    assert.match(compact, /^hang: working/);
    assert.doesNotMatch(compact, /done1|done2/);
    assert.match(compact, /\nNot at work: 2 done\. status with name "all" lists them\.$/);

    const every = await ask("status all");

    assert.match(every, /^done1: done /m);
    assert.match(every, /^done2: done /m);
    assert.match(every, /^hang: working/m);
});
