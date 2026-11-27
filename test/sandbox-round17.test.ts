// Review round 14: `enter` and `work-add` decide after their last await; a stale change does not stop the replacement provider; a
// reload belongs to the provider it stopped; a load that ended registers nothing.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader } from "../src/server/reload.ts";
import { cleanUp, newSession, openApp, owner, root, scriptedModel, type App } from "./helpers.ts";
import { FakeProvider, gate, sandboxOptions } from "./sandbox-fake.ts";

const apps: App[] = [];
let opened = 0;

after(async () => {
    for (const app of apps) {
        await app.close();
    }

    cleanUp();
});

const timers: { resolve: () => void }[] = [];

async function boot(options: Parameters<typeof sandboxOptions>[0] = {}) {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-round17-${++opened}`),
        undefined,
        undefined,
        sandboxOptions({
            timer: (_ms, signal) =>
                new Promise<void>((resolve) => {
                    timers.push({ resolve });
                    signal.addEventListener("abort", () => resolve());
                }),
            ...options,
        }),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "a.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round17-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

const ticks = async (count = 20) => {
    for (let turn = 0; turn < count; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

test("a move held in preparation while the provider is replaced does not stop the replacement's VM", async () => {
    const { app } = await boot();
    const a = await newSession(app, folder("stale"));
    const target = folder("stale-to");

    await app.sandboxes.turnOn(a, owner(app));
    const hold = gate();
    const moving = app.sandboxes.change(
        { kind: "move", user: owner(app), id: a },
        {
            moves: async () => {
                await hold.wait();

                return [{ id: a, cwd: target }];
            },
            commit: async () => {},
        },
    );
    const refused = assert.rejects(moving, /changed (meanwhile|while)|no longer/);

    await hold.reached;
    const second = new FakeProvider();

    const before = timers.length;
    const replacing = app.sandboxes.register(second, "b.ts");

    await ticks();
    // The takeover waits for the change, until its time runs out, and then takes the tree.
    timers.slice(before).forEach((each) => each.resolve());
    await replacing;
    second.released.length = 0;
    hold.open();
    await refused;
    assert.deepEqual(second.released, [], "the stale move stopped nothing of the new provider");
    assert.notEqual(app.cwdOf(a), target);
});

test("a reload belongs to the provider it stopped: another registration cancels it, and the staged provider is never installed", async () => {
    const { app } = await boot();
    const a = await newSession(app, folder("reload"));

    await app.sandboxes.turnOn(a, owner(app));
    await app.sandboxes.suspendOwner("a.ts", false);
    const staged = new FakeProvider();
    const other = new FakeProvider();

    await app.sandboxes.register(staged, "a.ts");
    await app.sandboxes.register(other, "b.ts");
    assert.equal(app.sandboxes.provider, other);
    await app.sandboxes.reloadCommitted("a.ts");
    assert.equal(
        app.sandboxes.provider,
        other,
        "the staged provider did not replace the newer one",
    );
    assert.equal(app.sandboxes.phaseOf(a), "stable");
});

test("a load that ran out of time registers nothing when its default export goes on", async () => {
    const { app, provider } = await boot();
    const directory = join(root, "round17-loader");
    const dropIn = join(directory, "drop-ins");

    mkdirSync(join(directory, "built-in"), { recursive: true });
    mkdirSync(dropIn, { recursive: true });
    const late = gate();
    const shared = globalThis as unknown as {
        lateSandbox?: () => Promise<unknown>;
        lateMade?: FakeProvider;
    };

    shared.lateSandbox = async () => {
        await late.wait();
        shared.lateMade = new FakeProvider();

        return app.sandboxes.register(shared.lateMade, "late.ts");
    };

    const loader = new ExtensionLoader(
        createRegistry(),
        { notice: () => {} } as unknown as PocketHost,
        { builtIn: join(directory, "built-in"), dropIn },
        () => true,
        {
            webs: new ExtensionWebs({}),
            notify: () => {},
            suspend: (file, leave) => app.sandboxes.suspendOwner(file, leave),
            reloadFailed: (file) => app.sandboxes.reloadFailed(file),
            reloadCommitted: (file) => app.sandboxes.reloadCommitted(file),
            registrationScope: (_file, valid, run) => app.sandboxes.inLoad(valid, run),
            loadLimitMs: 100,
        },
    );

    writeFileSync(
        join(dropIn, "late.ts"),
        `/** A sandbox module that is late. */
export default async () => {
	await globalThis.lateSandbox();
	return { name: "t-late" };
};
`,
    );
    await loader.loadAll().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
    late.open();
    await ticks(50);
    assert.equal(app.sandboxes.provider, provider, "the late registration was refused");
    assert.equal(shared.lateMade?.ran.length ?? 0, 0);
    shared.lateSandbox = undefined;
});

test("a staged provider that its own handle unregistered is not installed by the reload's commit", async () => {
    const { app, provider } = await boot();

    await app.sandboxes.suspendOwner("a.ts", false);
    const staged = new FakeProvider();
    const handle = await app.sandboxes.register(staged, "a.ts");

    await handle.unregister();
    await app.sandboxes.reloadCommitted("a.ts");
    assert.notEqual(app.sandboxes.provider, staged, "the withdrawn provider was not installed");
    assert.equal(app.sandboxes.provider, provider);
});
