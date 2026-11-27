// Review round 13, Greptile threads: a reservation does not outlive a change that a teardown took over; a change that waited for
// a reservation reads the sandbox state and the folders again when it plans.
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

async function boot(options: Parameters<typeof sandboxOptions>[0] = {}) {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-round15-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(options),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round15-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

const ticks = async (count = 20) => {
    for (let turn = 0; turn < count; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

test("a change that waited for a reservation reads the tree's sandbox state again: it stops the VM it did not know about", async () => {
    const { app, provider } = await boot();
    const c = await newSession(app, folder("wait-c"));
    const aDir = folder("wait-a");
    const a = await newSession(app, aDir);
    const target = join(root, "round15-wait-c");

    await app.sandboxes.turnOn(c, owner(app));
    await app.commands.updateSession(c, owner(app), { archived: true });
    // C's turn-off holds the reservation of its folder, which A's move targets.
    const hold = gate();

    provider.holdRelease = hold;
    const off = app.sandboxes.turnOff(c, owner(app));

    await hold.reached;
    // A is plain when its move is planned, and waits for that reservation.
    const moving = app.sandboxes.change(
        { kind: "move", user: owner(app), id: a },
        { moves: [{ id: a, cwd: target }], commit: async () => {} },
    );

    await ticks();
    // While it waits, A becomes sandboxed (the document is written some other way).
    await app.harness.commit(async (tx) => {
        Object.assign(await tx.doc(SandboxDoc, a), { on: true, by: owner(app).id, at: Date.now() });
    }, context);
    assert.equal(app.sandboxes.isOn(a), true);
    provider.holdOnly = Number(c);
    hold.open();
    await off;
    await moving;
    assert.ok(
        provider.released.includes(Number(a)),
        "A's VM was stopped before its folder changed",
    );
    assert.equal(app.cwdOf(a), target);
});
