// Review round 7: a failed or timed-out release leaves "the teardown needs proof", and nothing reopens the tree until a release
// succeeds; the wait for a release in flight is bounded; a stuck tree never hangs a provider change.
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

/** Timers that a test fires one at a time; every one also ends when its signal aborts, as the real one does. */
function timers() {
    const made: { resolve: () => void }[] = [];

    return {
        made,
        timer: (_ms: number, signal: AbortSignal) =>
            new Promise<void>((resolve) => {
                made.push({ resolve });
                signal.addEventListener("abort", () => resolve());
            }),
    };
}

async function boot(options: Parameters<typeof sandboxOptions>[0] = {}) {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-round7-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(options),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round7-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

const ticks = async (count = 20) => {
    for (let turn = 0; turn < count; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

test("a tree whose release failed is not reopened by a later clean rules change until a release succeeds", async () => {
    let refuse: string | undefined;
    const { app, provider } = await boot({ trusted: () => refuse });
    const a = await newSession(app, folder("needs-proof"));

    await app.sandboxes.turnOn(a, owner(app));
    provider.failRelease = "the VM would not close";
    refuse = "a trusted place now reaches this folder";
    await app.sandboxes.rules("first change");
    assert.equal(app.sandboxes.phaseOf(a), "suspended");
    // The refusal goes away, and a clean change takes over. No VM is proved gone yet: it runs the release, which fails.
    refuse = undefined;
    await app.sandboxes.rules("second change");
    assert.equal(app.sandboxes.phaseOf(a), "suspended", "not reopened without a proof");
    assert.equal(
        await app
            .envFor(a)
            .exec("x", undefined, context)
            .then((r) => r.ok),
        false,
    );
    // A release that succeeds is the proof: the next clean change reopens it.
    provider.failRelease = undefined;
    await app.sandboxes.rules("third change");
    assert.equal(app.sandboxes.phaseOf(a), "stable");
    assert.deepEqual(provider.released, [Number(a)]);
    assert.ok((await app.envFor(a).exec("x", undefined, context)).ok);
});

test("the wait for a release in flight is bounded: a newer clean change ends suspended and does not hang, and the attempt is kept", async () => {
    const clock = timers();
    let refuse: string | undefined;
    const { app, provider } = await boot({ timer: clock.timer, trusted: () => refuse });
    const a = await newSession(app, folder("bounded-wait"));

    await app.sandboxes.turnOn(a, owner(app));
    const hold = gate();

    provider.holdRelease = hold;
    refuse = "a trusted place now reaches this folder";
    const first = app.sandboxes.rules("first change");

    await hold.reached;
    refuse = undefined;
    const second = app.sandboxes.rules("second change");

    await ticks();
    // The second change waits for the release in flight; its wait runs out.
    clock.made.at(-1)!.resolve();
    await second;
    assert.equal(app.sandboxes.phaseOf(a), "suspended");
    const result = await app.envFor(a).exec("x", undefined, context);

    assert.ok(!result.ok && /still being stopped/.test(result.error.message));
    // The attempt is still there: when it ends, a later change joins the proof and reopens the tree.
    hold.open();
    await first;
    await app.sandboxes.rules("third change");
    assert.equal(app.sandboxes.phaseOf(a), "stable");
    assert.deepEqual(provider.released, [Number(a)], "one release, the one in flight");
});

test("a stuck transition never hangs a provider change: the wait for transitions is bounded, and the others go on", async () => {
    const clock = timers();
    const { app, provider } = await boot({ timer: clock.timer });
    const a = await newSession(app, folder("stuck-tree"));
    const b = await newSession(app, folder("stuck-other"));

    await app.sandboxes.turnOn(a, owner(app));
    await app.sandboxes.turnOn(b, owner(app));
    const hold = gate();
    const to = folder("stuck-tree-to");
    // A move that never finishes its preparation: no timer, no release, a transition that stays under way for ever.
    const moving = app.sandboxes.change(
        { kind: "move", user: owner(app), id: a },
        {
            moves: async () => {
                await hold.wait();

                return [{ id: a, cwd: to }];
            },
            commit: async () => {},
        },
    );

    await hold.reached;
    const second = new FakeProvider();
    let installed = false;
    const replacing = app.sandboxes.register(second, "other.ts").then(() => (installed = true));

    await ticks();
    assert.equal(installed, false, "it waits for the transition first");
    // The wait runs out (its timer is the newest): the stuck transition is left alone, and the replacement goes on.
    clock.made.at(-1)!.resolve();
    await replacing;
    assert.equal(app.sandboxes.provider, second);
    assert.ok(provider.released.includes(Number(b)), "the other tree was stopped and proved gone");
    hold.open();
    await moving.catch(() => undefined);
});
