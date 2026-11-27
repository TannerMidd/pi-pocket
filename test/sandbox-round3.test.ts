// Review round 3: a step that waits writes a phase only when its own record is still current; work and lease grants of a tree
// that is not live respect a reservation that covers its folder, and `off` is checked again where it is stored; a resume asks
// the folder, the trusted places, and the gate again before it reopens work.
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

async function boot(options: Parameters<typeof sandboxOptions>[0] = {}) {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-round3-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(options),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round3-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

test("a tree that is not live gains no work or lease while a neighbour's turn-off reserves the folder, and `off` is checked again at the commit", async () => {
    const { app, provider } = await boot();
    const dir = folder("neighbour");
    const b = await newSession(app, dir);

    await app.sandboxes.turnOn(b, owner(app));
    const a = (await app.commands.createSession(owner(app), { cwd: dir })).id;

    assert.equal(app.sandboxes.isOn(a), true);
    // `off` of one of two live sandboxed neighbours is refused where it is stored, not only at the plan.
    await assert.rejects(
        app.harness.commit(
            (tx) => app.sandboxes.admit(tx, { kind: "off", id: b, user: owner(app) }),
            context,
        ),
        /in a sandbox and use/,
    );
    // The way out: the neighbour is archived (no work), and B's turn-off is held in the middle of its release.
    await app.commands.updateSession(a, owner(app), { archived: true });
    const hold = gate();

    provider.holdRelease = hold;
    const off = app.sandboxes.turnOff(b, owner(app));

    await hold.reached;
    await assert.rejects(
        app.commands.schedule(a, owner(app), { when: "every 2 hours check" }),
        /cannot be added now|under way/,
    );
    await assert.rejects(app.sandboxes.lease(a, { kind: "call", revoke: () => {} }), /under way/);
    hold.open();
    await off;
    assert.equal(app.sandboxes.isOn(b), false);
    // B is plain and live beside the archived sandboxed A: A cannot gain work any more either.
    await assert.rejects(
        app.commands.schedule(a, owner(app), { when: "every 2 hours check" }),
        /live again beside others/,
    );
});

test("a resume asks the folder, the trusted places, and the gate again: a suspension the rules made stays", async () => {
    let refuse: string | undefined;
    const { app } = await boot({ trusted: () => refuse });
    const a = await newSession(app, folder("resume-trusted"));

    await app.sandboxes.turnOn(a, owner(app));
    refuse = "a trusted place now reaches this folder";
    await app.sandboxes.rules("mcp.json changed");
    assert.equal(app.sandboxes.phaseOf(a), "suspended");
    await assert.rejects(app.sandboxes.resume(a), /trusted place now reaches this folder/);
    assert.equal(app.sandboxes.phaseOf(a), "suspended", "the suspension stays, with its reason");
    assert.ok((await app.envFor(a).exec("x", undefined, context)).ok === false);
    refuse = undefined;
    await app.sandboxes.resume(a);
    assert.equal(app.sandboxes.phaseOf(a), "stable");
    assert.ok((await app.envFor(a).exec("x", undefined, context)).ok);
});
