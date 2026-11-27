// Review round 2: a provider change never ends a transition it does not own; a change on a server with no sandbox is
// marked and reserved like any other; one release attempt for each tree; a timed-out wait leaves no callback; the audit
// ignores archived trees with no work.
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
        join(root, `data-round2-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(options),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round2-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

const ticks = async (count = 20) => {
    for (let turn = 0; turn < count; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

/** Timers that a test fires one at a time, in the order they were made. */
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

test("a provider change waits for a transition under way and never overwrites its phase", async () => {
    const { app, provider } = await boot();
    const dir = folder("provider-change");
    const a = await newSession(app, dir);

    await app.sandboxes.turnOn(a, owner(app));
    const hold = gate();

    provider.holdRelease = hold;
    // An archive of the sandboxed session: its VM is stopping, and its phase is `moving`.
    const archiving = app.commands.updateSession(a, owner(app), { archived: true });

    await hold.reached;
    assert.equal(app.sandboxes.phaseOf(a), "moving");
    const second = new FakeProvider();
    let installed = false;
    const registering = app.sandboxes.register(second, "other.ts").then(() => (installed = true));

    await ticks();
    assert.equal(installed, false, "the replacement waits for the transition");
    assert.equal(app.sandboxes.phaseOf(a), "moving", "the archive's phase was not overwritten");
    assert.equal(app.sandboxes.deliver(a).ok, false, "no delivery during the pending archive");
    hold.open();
    await archiving;
    await registering;
    assert.equal(app.sessionMeta(a)?.archived, true);
    assert.equal(app.sandboxes.provider, second);
    assert.equal(app.sandboxes.phaseOf(a), "stable");
});

test("a move on a server with no sandbox reserves and marks its tree before it prepares, so a turn-on cannot slip in", async () => {
    const { app } = await boot();
    const from = folder("no-sandbox-from");
    const to = folder("no-sandbox-to");
    const plain = await newSession(app, from);
    const hold = gate();
    const moving = app.sandboxes.change(
        { kind: "move", user: owner(app), id: plain },
        {
            moves: async () => {
                await hold.wait();

                return [{ id: plain, cwd: to }];
            },
            commit: async () => {},
        },
    );

    await hold.reached;
    assert.equal(app.sandboxes.phaseOf(plain), "moving");
    await assert.rejects(app.sandboxes.turnOn(plain, owner(app)), /changing|under way/);
    assert.equal(app.sandboxes.isOn(plain), false);
    hold.open();
    await moving;
    assert.equal(app.cwdOf(plain), to);
    assert.equal(app.sandboxes.phaseOf(plain), "stable");
    await app.sandboxes.turnOn(plain, owner(app));
});

test("one release attempt for each tree: a recovery joins the attempt the bound gave up on, and a late release never follows it", async () => {
    const clock = timers();
    const { app, provider } = await boot({ timer: clock.timer });
    const a = await newSession(app, folder("one-release"));

    await app.sandboxes.turnOn(a, owner(app));
    let settle!: () => void;
    const stuck = new Promise<void>((resolve) => (settle = resolve));
    const lease = await app.sandboxes.lease(a, { kind: "call", revoke: () => stuck });
    const off = app.sandboxes.turnOff(a, owner(app));
    const timedOut = assert.rejects(off, /did not finish in time/);

    await ticks();
    clock.made.at(-1)!.resolve();
    await timedOut;
    assert.equal(app.sandboxes.phaseOf(a), "suspended");
    assert.deepEqual(provider.released, []);

    // The recovery starts while the old attempt still runs: it joins it, and reopens nothing until it settles.
    let resumed = false;
    const resuming = app.sandboxes.resume(a).then(() => (resumed = true));

    await ticks();
    assert.equal(resumed, false);
    assert.notEqual(app.sandboxes.phaseOf(a), "stable");
    settle();
    lease.end();
    await resuming;
    assert.equal(app.sandboxes.phaseOf(a), "stable");
    await ticks();
    assert.deepEqual(
        provider.released,
        [Number(a)],
        "the VM was released once, before the recovery ended",
    );
});

test("a call whose wait for a phase timed out leaves no callback behind", async () => {
    const clock = timers();
    const { app, provider } = await boot({ timer: clock.timer, waitMs: 1000, drainMs: 2000 });
    const a = await newSession(app, folder("wake"));

    await app.sandboxes.turnOn(a, owner(app));
    const hold = gate();

    provider.holdRelease = hold;
    const off = app.sandboxes.turnOff(a, owner(app));

    await hold.reached;
    const call = app.envFor(a).exec("x", undefined, context);

    await ticks();
    assert.equal(app.sandboxes.waiting, 1);
    // The call's own bound is the newest timer: it runs out, and the call fails.
    clock.made.at(-1)!.resolve();
    const result = await call;

    assert.ok(!result.ok && /did not finish in time/.test(result.error.message));
    assert.equal(app.sandboxes.waiting, 0, "the timed-out call removed its callback");
    hold.open();
    await off;
    assert.equal(app.sandboxes.waiting, 0);
});

test("the audit ignores an archived sandboxed tree with no work, so a plain replacement does not block other sandboxes", async () => {
    const { app } = await boot();
    const dir = folder("audit");
    const a = await newSession(app, dir);
    const c = await newSession(app, folder("audit-other"));

    await app.sandboxes.turnOn(a, owner(app));
    await app.sandboxes.turnOn(c, owner(app));
    await app.commands.updateSession(a, owner(app), { archived: true });
    // A plain session may use the folder now: the archived tree left its group.
    const plain = await app.commands.createSession(owner(app), { cwd: dir });

    assert.equal(app.sandboxes.isOn(plain.id), false);
    await app.sandboxes.reconcile();
    assert.deepEqual(app.sandboxes.audit(), []);
    assert.ok(
        (await app.envFor(c).exec("x", undefined, context)).ok,
        "another sandbox is not blocked",
    );
});
