// Review round 10: a shutdown flag that nothing clears; the folder a lease asks to be bound to is checked as part of the
// candidate group, before the grant.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
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
        join(root, `data-round10-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round10-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

test("a registration queued behind shutdown is refused, and nothing clears the shutdown", async () => {
    const { app, provider } = await boot();
    const a = await newSession(app, folder("stopping-a"));
    const b = await newSession(app, folder("stopping-b"));

    await app.sandboxes.turnOn(a, owner(app));
    const hold = gate();

    provider.holdRelease = hold;
    const stopping = app.sandboxes.shutdown();

    await hold.reached;
    // A module that loads while the server stops asks to register: queued behind the shutdown.
    const second = new FakeProvider();
    const registering = app.sandboxes.register(second, "late.ts");
    const refused = assert.rejects(registering, /server is stopping/);

    hold.open();
    await stopping;
    await refused;
    assert.equal(app.sandboxes.provider, provider, "no provider was installed");
    await app.sandboxes.reconcile();
    await assert.rejects(app.sandboxes.turnOn(b, owner(app)), /server is stopping/);
    assert.equal((await app.envFor(a).exec("x", undefined, context)).ok, false);
});

test("the folder a lease asks to be bound to is checked in the candidate group, before the grant", async () => {
    const { app, provider } = await boot();
    const boxed = folder("lease-boxed");
    const s = await newSession(app, boxed);
    const p = await newSession(app, folder("lease-plain"));

    await app.sandboxes.turnOn(s, owner(app));
    // A plain tree asks for a host lease bound to the folder of a sandboxed one: refused, with the group's reason.
    await assert.rejects(
        app.sandboxes.lease(p, { kind: "host", folder: boxed, what: "a build" }),
        /in a sandbox and share/,
    );
    assert.equal(app.sandboxes.leasesOf(p).length, 0, "nothing was granted");
    // The same for a plain tree on a remote workspace, whose own folder says nothing about the group.
    await app.sandboxes.change(
        { kind: "move", user: owner(app), id: p },
        { moves: [{ id: p, cwd: "ssh://host/project" }], commit: async () => {} },
    );
    await assert.rejects(
        app.sandboxes.lease(p, { kind: "host", folder: boxed, what: "a build" }),
        /in a sandbox and share/,
    );
    // And a reservation that covers the folder is respected too: the sandboxed tree's turn-off is held half way.
    const q = await newSession(app, folder("lease-plain-two"));
    const hold = gate();

    provider.holdRelease = hold;
    const off = app.sandboxes.turnOff(s, owner(app));

    await hold.reached;
    await assert.rejects(
        app.sandboxes.lease(q, { kind: "host", folder: boxed, what: "a build" }),
        /under way/,
    );
    hold.open();
    await off;
    // With the sandbox off, the folder is plain: the same lease is granted.
    const lease = await app.sandboxes.lease(q, { kind: "host", folder: boxed, what: "a build" });

    assert.equal(app.sandboxes.leasesOf(q).length, 1);
    lease.end();
});
