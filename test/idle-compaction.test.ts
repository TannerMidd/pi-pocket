// A session idle for over an hour is compacted before its next message goes out, as Claude Code does.
import { type App, cleanUp, context, newSession, openApp, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let clock = Date.now();
let app: App;

before(async () => {
    app = await openApp(scriptedModel(), undefined, () => clock);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** The entry the conversation's context starts from: it changes when the context is compacted. */
const head = async (id: Parameters<typeof say>[1]) =>
    (await (await app.harness.conversation(id, context))!.context(context)).head?.id;

test("a message after an idle hour compacts first; a prompt one does not", async () => {
    const id = await newSession(app);

    // Big enough to be worth a summary.
    await say(app, id, "x".repeat(80_000));
    clock += 30 * 60 * 1000;

    const before = await head(id);

    await say(app, id, "still here");
    assert.equal(await head(id), before, "a half hour is not a pause");

    clock += 61 * 60 * 1000;
    await say(app, id, "back again");
    assert.notEqual(await head(id), before, "an idle hour compacts the context");
});

test("a small context is left as it is", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");
    clock += 2 * 60 * 60 * 1000;
    const before = await head(id);

    await say(app, id, "hello again");
    assert.equal(await head(id), before);
});
