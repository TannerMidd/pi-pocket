// Review round 9: a tree that moves to a remote workspace keeps its local work in its group, and the move checks that work;
// shutdown raises the fence, drains, re-looks, and keeps the commit listener until it is done; a lease grant and an env call
// are refused while the fence is up.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanUp, newSession, openApp, owner, root, scriptedModel, type App } from "./helpers.ts";
import { FakeProvider, sandboxOptions } from "./sandbox-fake.ts";

const apps: App[] = [];
let opened = 0;

after(async () => {
    for (const app of apps) {
        await app.close();
    }

    cleanUp();
});

async function boot() {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-round9-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round9-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

const task = (cwd: string) => ({
    items: { t1: { id: "t1", status: "running", command: "npm run watch", cwd, notify: false } },
});

test("a plain tree that moves to a remote workspace is refused while work stays bound to its local folder", async () => {
    const { app } = await boot();
    const local = folder("remote-move");
    const elsewhere = await newSession(app, folder("remote-move-sandboxed"));
    const plain = await newSession(app, local);

    // A sandbox exists, so the old folder's work is checked at a move.
    await app.sandboxes.turnOn(elsewhere, owner(app));
    app.sandboxes.noteDoc("pocket.background", plain, task(local));
    await assert.rejects(
        app.sandboxes.change(
            { kind: "move", user: owner(app), id: plain },
            { moves: [{ id: plain, cwd: "ssh://host/project" }], commit: async () => {} },
        ),
        /still has work bound/,
    );
    assert.equal(app.cwdOf(plain), local, "nothing moved");
});

test("a tree whose root is remote stays in the group of the local folders its work is bound to", async () => {
    const { app } = await boot();
    const local = folder("remote-group");
    const plain = await newSession(app, local);
    const neighbour = await newSession(app, local);

    await app.sandboxes.turnOn(await newSession(app, folder("remote-group-sandboxed")), owner(app));
    // Its root goes to a remote workspace (no work is bound yet), and then a task is bound to the local folder.
    await app.sandboxes.change(
        { kind: "move", user: owner(app), id: plain },
        { moves: [{ id: plain, cwd: "ssh://host/project" }], commit: async () => {} },
    );
    assert.equal(app.cwdOf(plain), "ssh://host/project");
    app.sandboxes.noteDoc("pocket.background", plain, task(local));
    // Another session may not sandbox the local folder while host work still runs there.
    await assert.rejects(app.sandboxes.turnOn(neighbour, owner(app)), /background task/);
    app.sandboxes.noteDoc("pocket.background", plain, { items: {} });
    await app.sandboxes.turnOn(neighbour, owner(app));
    assert.equal(app.sandboxes.isOn(neighbour), true);
});
