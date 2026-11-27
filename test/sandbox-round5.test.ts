// Review round 5: the newest rules win; a folder that may not be shared any more has its VM stopped and proved gone; a turn-on
// checks every conversation of the tree.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SubagentsDoc } from "../src/server/docs.ts";
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
        join(root, `data-round5-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(options),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round5-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

test("the newest rules win: a second change while the first check waits is not lost, and the first cannot restore stable", async () => {
    const wait = gate();
    let calls = 0;
    let refuse: string | undefined;
    const { app, provider } = await boot({
        trustedPlaces: {
            check: async () => {
                // 1: the turn-on's. 2: the first rules check, which waits and finds nothing wrong. 3: the second one.
                if (++calls === 2) {
                    await wait.wait();

                    return undefined;
                }

                return calls === 3 ? refuse : undefined;
            },
        },
    });
    const a = await newSession(app, folder("newest"));

    await app.sandboxes.turnOn(a, owner(app));
    const first = app.sandboxes.rules("first change");

    await wait.reached;
    refuse = "a trusted place now reaches this folder";
    const second = app.sandboxes.rules("second change");

    wait.open();
    await Promise.all([first, second]);
    assert.equal(
        app.sandboxes.phaseOf(a),
        "suspended",
        "the first, stale answer did not restore stable",
    );
    assert.equal(
        await app
            .envFor(a)
            .exec("x", undefined, context)
            .then((r) => r.ok),
        false,
    );
    assert.deepEqual(provider.released, [Number(a)]);
});

test("a folder that may not be shared any more has its leases revoked and its VM released, and a failed teardown says so", async () => {
    let refuse: string | undefined;
    const { app, provider } = await boot({ trusted: () => refuse });
    const a = await newSession(app, folder("forbidden"));

    await app.sandboxes.turnOn(a, owner(app));
    const revoked: string[] = [];
    const lease = await app.sandboxes.lease(a, {
        kind: "task",
        revoke: () => {
            revoked.push("task");
            lease.end();
        },
    });

    refuse = "a trusted place now reaches this folder";
    await app.sandboxes.rules("mcp.json changed");
    assert.deepEqual(revoked, ["task"], "what runs in the folder was revoked");
    assert.deepEqual(provider.released, [Number(a)], "and the VM is gone");
    assert.equal(app.sandboxes.phaseOf(a), "suspended");

    // A teardown that fails keeps the tree suspended, with both reasons.
    const b = await newSession(app, folder("forbidden-stuck"));

    refuse = undefined;
    await app.sandboxes.resume(a);
    await app.sandboxes.turnOn(b, owner(app));
    provider.failRelease = "the VM would not close";
    refuse = "a trusted place now reaches this folder";
    await app.sandboxes.rules("again");
    assert.equal(app.sandboxes.phaseOf(b), "suspended");
    const refused = await app.envFor(b).exec("x", undefined, context);

    assert.ok(
        !refused.ok &&
            /trusted place.*could not be stopped.*would not close/.test(refused.error.message),
    );
    provider.failRelease = undefined;
});

test("a turn-on checks every conversation of the tree: a subagent outside the folder refuses it, by name", async () => {
    const { app } = await boot();
    const dir = folder("child");
    const outside = folder("child-outside");
    const a = await newSession(app, dir);
    const stray = await app.harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { cwd: outside } },
        context,
    );
    const inside = await app.harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { cwd: dir } },
        context,
    );

    await app.harness.commit(async (tx) => {
        const agents = (await tx.doc(SubagentsDoc, a)).agents;

        agents.inside = { conversationId: inside.id, reported: [] };
        agents.stray = { conversationId: stray.id, reported: [] };
    }, context);
    // A subagent that runs counts: the stray one is made to look busy.
    const busy = app.isBusy.bind(app);

    app.isBusy = (conversation) => conversation === stray.id || busy(conversation);
    await assert.rejects(
        app.sandboxes.turnOn(a, owner(app)),
        new RegExp(`subagent #${String(stray.id)} .*outside the session's folder`),
    );
    assert.equal(app.sandboxes.isOn(a), false);
    assert.equal(app.sandboxes.phaseOf(a), "stable");
    app.isBusy = busy;
    // With the stray one moved inside the folder, it turns on.
    await app.commands.configure(stray.id, owner(app), { cwd: dir });
    await app.sandboxes.turnOn(a, owner(app));
    assert.equal(app.sandboxes.isOn(a), true);
});
