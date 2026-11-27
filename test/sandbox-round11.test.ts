// Review round 11: an artifact call that names a host path holds a host lease for its whole duration, so a turn-on cannot finish
// between its start and its read.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanUp, newSession, openApp, owner, root, scriptedModel, type App } from "./helpers.ts";
import { FakeProvider, sandboxOptions } from "./sandbox-fake.ts";

let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

test("an artifact call that names a path is host work until it ends; one made from content is not", async () => {
    app = await openApp(
        scriptedModel(),
        join(root, "data-round11"),
        undefined,
        undefined,
        sandboxOptions(),
    );
    await app.sandboxes.register(new FakeProvider(), "fake.ts");
    const dir = join(root, "round11-plain");

    mkdirSync(dir);
    const id = await newSession(app, dir);

    // Made from content: nothing on this machine, no lease.
    assert.equal(
        await app.sandboxes.beforeTool(id, "t0", "artifact", { title: "a", content: "x" }),
        undefined,
    );
    assert.equal(app.sandboxes.leasesOf(id).length, 0);
    // From a file (the path itself, or an asset's): the call reads host files, and holds a lease from its start.
    assert.equal(
        await app.sandboxes.beforeTool(id, "t1", "artifact", { title: "a", path: "page.html" }),
        undefined,
    );
    assert.equal(app.sandboxes.leasesOf(id).length, 1);
    assert.match(app.sandboxes.leasesOf(id)[0]!.what, /artifact call that is running/);
    // The call is paused before its read: a turn-on finds the work and refuses, so the session cannot become sandboxed
    // between the start of the call and its read.
    await assert.rejects(app.sandboxes.turnOn(id, owner(app)), /artifact call that is running/);
    app.sandboxes.toolEnded("t1");
    assert.equal(
        await app.sandboxes.beforeTool(id, "t2", "artifact", {
            assets: [{ name: "a", path: "a.png" }],
        }),
        undefined,
    );
    assert.equal(app.sandboxes.leasesOf(id).length, 1, "an asset's path counts too");
    app.sandboxes.toolEnded("t2");
    await app.sandboxes.turnOn(id, owner(app));
    assert.equal(app.sandboxes.isOn(id), true);
});
