// Review round 4: the admission cache is invalidated when liveness changes; a step that waited compares a revision that never
// resets, also across `stable`; a resume whose check throws leaves the tree suspended, not half way.
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
        join(root, `data-round4-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(options),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round4-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

test("a lease that makes a tree live invalidates the cached admission of its neighbours", async () => {
    const { app } = await boot();
    const dir = folder("cache");
    const b = await newSession(app, dir);

    await app.sandboxes.turnOn(b, owner(app));
    await app.commands.updateSession(b, owner(app), { archived: true });
    // B left the group. A plain session takes the folder, and is archived too: both are archived, neither is live.
    const a = (await app.commands.createSession(owner(app), { cwd: dir })).id;

    assert.equal(app.sandboxes.isOn(a), false);
    await app.commands.updateSession(a, owner(app), { archived: true });
    assert.deepEqual(
        app.sandboxes.deliver(b),
        { ok: true },
        "cached: nothing is live in the folder",
    );
    // A gets a host lease: it is live now, and plain, in the folder of sandboxed B.
    const host = await app.sandboxes.lease(a, { kind: "host", what: "a build" });

    assert.equal(app.sandboxes.deliver(b).ok, false, "B may not work beside a live plain tree");
    await assert.rejects(
        app.sandboxes.lease(b, { kind: "call", revoke: () => {} }),
        /without a sandbox|share/,
    );
    host.end();
    assert.deepEqual(
        app.sandboxes.deliver(b),
        { ok: true },
        "the last lease ended: A is not live any more",
    );
});

test("a reconcile whose tree went through a whole transition while it waited writes nothing", async () => {
    const check = gate();
    let calls = 0;
    const { app } = await boot({
        trustedPlaces: {
            check: async () => {
                // The first check is the turn-on's; the second is the reconcile's, which waits and then refuses.
                if (++calls === 2) {
                    await check.wait();

                    return "a trusted place reaches this folder";
                }

                return undefined;
            },
        },
    });
    const a = await newSession(app, folder("aba"));

    await app.sandboxes.turnOn(a, owner(app));
    assert.equal(app.sandboxes.phaseOf(a), "stable");
    const reconciling = app.sandboxes.reconcile();

    await check.reached;
    // A whole turn-off begins and ends meanwhile: the tree is plain, with no phase record, as it was before.
    await app.sandboxes.turnOff(a, owner(app));
    assert.equal(app.sandboxes.phaseOf(a), "stable");
    check.open();
    await reconciling;
    assert.equal(
        app.sandboxes.phaseOf(a),
        "stable",
        "the stale refusal did not suspend a plain session",
    );
    assert.ok((await app.envFor(a).exec("x", undefined, context)).ok);
});

test("a resume whose check throws leaves the tree suspended with the reason, and a later resume works", async () => {
    let mode: "refuse" | "throw" | "ok" = "ok";
    const { app } = await boot({
        trustedPlaces: {
            check: async () => {
                if (mode === "throw") {
                    throw new Error("the walk failed");
                }

                return mode === "refuse" ? "a trusted place reaches this folder" : undefined;
            },
        },
    });
    const a = await newSession(app, folder("resume-throw"));

    await app.sandboxes.turnOn(a, owner(app));
    mode = "refuse";
    await app.sandboxes.rules("mcp.json changed");
    assert.equal(app.sandboxes.phaseOf(a), "suspended");
    mode = "throw";
    await assert.rejects(app.sandboxes.resume(a), /could not be checked.*the walk failed/);
    assert.equal(app.sandboxes.phaseOf(a), "suspended", "not stuck in turning-off");
    // Turn-off is not refused as "changing" either: the tree is only suspended.
    mode = "ok";
    await app.sandboxes.resume(a);
    assert.equal(app.sandboxes.phaseOf(a), "stable");
});
