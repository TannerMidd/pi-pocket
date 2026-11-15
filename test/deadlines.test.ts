// The quiet limit of commands (`deadline.ts`): a bash call that prints nothing for too long ends as timed out with
// what it printed, and its processes go; one that keeps printing, or gives its own timeout, runs on.
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
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("done")]);
    }

    const args = /^(?:\[from: [^\]]+\] )?run (\{.*\})$/s.exec(text)?.[1];

    return args === undefined
        ? fauxAssistantMessage([fauxText("noted")])
        : fauxAssistantMessage([fauxToolCall("bash", JSON.parse(args))], { stopReason: "toolUse" });
};

let app: App;
let id: ConversationId;

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "deadlines"));
    id = await newSession(app);
    app.background.limits.commandQuietMs = 400;
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Run a bash call through Pi and give its result's text, and how long it took. */
async function run(args: object): Promise<{ text: string; ms: number }> {
    const started = Date.now();
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text: `run ${JSON.stringify(args)}`,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    const results = (await (await app.harness.conversation(id, context))!.context(context)).messages
        .filter((message) => message.role === "toolResult")
        .map((message) =>
            (message.content as { text?: string }[]).map((part) => part.text ?? "").join(""),
        );

    return { text: results.at(-1) ?? "", ms: Date.now() - started };
}

test("a bash call that prints nothing for the quiet limit times out with its partial output", async () => {
    const { text, ms } = await run({ command: "echo begun; sleep 30" });

    assert.ok(ms < 10_000, `ended at the limit, not after the command: ${ms} ms`);
    assert.match(text, /begun/);
    assert.match(text, /Command timed out: it printed nothing/);
});

test("a call that keeps printing, or gives its own timeout, runs past the quiet limit", async () => {
    const busy = await run({
        command: "for i in 1 2 3 4 5 6; do echo tick$i; sleep 0.2; done",
    });

    assert.match(busy.text, /tick6/);
    assert.doesNotMatch(busy.text, /timed out/);

    const own = await run({ command: "sleep 0.8; echo late", timeout: 5 });

    assert.match(own.text, /late/);
});
