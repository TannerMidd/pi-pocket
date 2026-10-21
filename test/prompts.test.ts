// Pi's prompt templates as slash commands: where they load from, how arguments fill them, and sending one.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

let app: App;

before(async () => {
    mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "prompts"), { recursive: true });
    writeFileSync(
        join(process.env.PI_CODING_AGENT_DIR!, "prompts", "fix.md"),
        "---\ndescription: Fix an issue\n---\nFix issue $1. Keep the change small.",
    );
    mkdirSync(join(work, ".pi", "prompts"), { recursive: true });
    writeFileSync(join(work, ".pi", "prompts", "tidy.md"), "Tidy up $@");
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a session offers its folder's templates, and sending one sends it filled in", async () => {
    const id = await newSession(app);

    assert.deepEqual(
        app.promptTemplates(id).map((template) => template.name),
        ["fix", "tidy"],
    );
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text: "/fix 42",
        requestId: "t1",
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        10,
        undefined,
        context,
    );
    const sent = page.items.find((entry) => entry.kind === "pi.user");

    assert.match(JSON.stringify(sent?.model), /Fix issue 42\. Keep the change small\./);
});
