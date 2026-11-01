// The owner chooses how long a session sits idle before its next message compacts the context first.
import { type App, cleanUp, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app.close();
    cleanUp();
});

test("the owner reads and changes the idle compaction pause, and nobody else can", async () => {
    assert.equal(app.config.compactIdleHours, 1, "default is 1 hour");

    await app.setCompactIdleHours(owner(app), 2);
    assert.equal(app.config.compactIdleHours, 2);

    await app.setCompactIdleHours(owner(app), 0);
    assert.equal(app.config.compactIdleHours, 0, "0 turns idle compaction off");

    await assert.rejects(
        app.setCompactIdleHours(
            { id: "guest", role: "guest", name: "Guest", tokenHash: "x", createdAt: 0 },
            1,
        ),
        /Only the owner/,
    );
    await assert.rejects(app.setCompactIdleHours(owner(app), 99), /must be one of 0, 1, 2, 5, 12/);
});
