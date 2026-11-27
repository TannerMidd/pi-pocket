// Review round 9: a tree that moves to a remote workspace keeps its local work in its group, and the move checks that work;
// shutdown raises the fence, drains, re-looks, and keeps the commit listener until it is done; a lease grant and an env call
// are refused while the fence is up.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SandboxDoc } from "../src/server/docs.ts";
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    type App,
} from "./helpers.ts";
import { FakeProvider, gate, sandboxOptions } from "./sandbox-fake.ts";

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

test("shutdown raises the fence at once, drains, looks again, and keeps the commit listener until it is done", async () => {
    const { app, provider } = await boot();
    const a = await newSession(app, folder("shutdown-a"));
    const b = await newSession(app, folder("shutdown-b"));
    const c = await newSession(app, folder("shutdown-c"));

    await app.sandboxes.turnOn(a, owner(app));
    const hold = gate();

    provider.holdRelease = hold;
    const closing = app.close();

    await hold.reached;
    // A turn-on that comes now is refused: the server is stopping.
    await assert.rejects(app.sandboxes.turnOn(b, owner(app)), /server is stopping/);
    // A sandbox document that lands during the drain (a commit that began before the fence) is seen: the listener is attached.
    await app.harness.commit(async (tx) => {
        Object.assign(await tx.doc(SandboxDoc, c), { on: true, by: owner(app).id, at: Date.now() });
    }, context);
    assert.equal(app.sandboxes.isOn(c), true);
    hold.open();
    await closing;
    assert.deepEqual(
        provider.released.sort(),
        [Number(a), Number(c)].sort(),
        "the late tree was stopped too",
    );
});

test("a lease grant and an env call are refused while the fence is up", async () => {
    const { app, provider } = await boot();
    const a = await newSession(app, folder("fence-grant"));
    const c = await newSession(app, folder("fence-grant-c"));

    await app.sandboxes.turnOn(a, owner(app));
    const hold = gate();

    provider.holdRelease = hold;
    const replacing = app.sandboxes.register(new FakeProvider(), "other.ts");

    await hold.reached;
    // A tree that became sandboxed some other way has no phase yet: only the fence stops its first call.
    await app.harness.commit(async (tx) => {
        Object.assign(await tx.doc(SandboxDoc, c), { on: true, by: owner(app).id, at: Date.now() });
    }, context);
    assert.equal(app.sandboxes.phaseOf(c), "stable");
    await assert.rejects(
        app.sandboxes.lease(c, { kind: "call", revoke: () => {} }),
        /being replaced or turned off/,
    );
    const result = await app.envFor(c).exec("x", undefined, context);

    assert.ok(!result.ok && /being replaced or turned off/.test(result.error.message));
    hold.open();
    await replacing;
});
