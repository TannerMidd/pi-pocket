// Review round 13: only the step that raised the provider fence lowers it, and a resume waits; admission is checked again after its
// awaits, with the provider generation; a reload's registration is staged and takes effect only when the loader commits it.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader } from "../src/server/reload.ts";
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
        join(root, `data-round14-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(options),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round14-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

const ticks = async (count = 20) => {
    for (let turn = 0; turn < count; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

test("a resume during a provider teardown is refused, and the fence stays up for the teardown that owns it", async () => {
    const { app, provider } = await boot();
    const a = await newSession(app, folder("fence-a"));
    const b = await newSession(app, folder("fence-b"));

    await app.sandboxes.turnOn(a, owner(app));
    await app.sandboxes.turnOn(b, owner(app));
    const hold = gate();

    // A's VM is proved gone at once; B's is held. A is suspended by the teardown, and the fence is up.
    provider.holdRelease = hold;
    provider.holdOnly = Number(b);
    const second = new FakeProvider();
    const replacing = app.sandboxes.register(second, "other.ts");

    await hold.reached;
    await ticks();
    assert.equal(app.sandboxes.phaseOf(a), "suspended");
    await assert.rejects(app.sandboxes.resume(a), /cannot be resumed now/);
    assert.equal(app.sandboxes.phaseOf(a), "suspended", "A was not reopened");
    assert.equal((await app.envFor(a).exec("x", undefined, context)).ok, false, "and starts no VM");
    hold.open();
    await replacing;
    assert.equal(app.sandboxes.phaseOf(a), "stable", "the new provider's reconcile reopens it");
    assert.ok((await app.envFor(a).exec("y", undefined, context)).ok);
    assert.deepEqual(second.ran, ["y"]);
});

test("a move that waited in its admission is checked again before it commits: a replaced provider refuses it", async () => {
    const wait = gate();
    const made: { resolve: () => void }[] = [];
    let calls = 0;
    const { app } = await boot({
        timer: (_ms, signal) =>
            new Promise<void>((resolve) => {
                made.push({ resolve });
                signal.addEventListener("abort", () => resolve());
            }),
        trustedPlaces: {
            // 1: the turn-on's. 2: the dry run of the admission. 3: the admission in the commit, which waits here.
            check: async () => {
                if (++calls === 3) {
                    await wait.wait();
                }

                return undefined;
            },
        },
    });
    const from = folder("admission-from");
    const to = folder("admission-to");
    const a = await newSession(app, from);

    await app.sandboxes.turnOn(a, owner(app));
    const moving = app.commands.configure(a, owner(app), { cwd: to });
    const refused = assert.rejects(moving, /changed (meanwhile|while this was being admitted)/);

    await wait.reached;
    const before = made.length;
    const replacing = app.sandboxes.register(new FakeProvider(), "other.ts");

    await ticks();
    // The wait for the move runs out, the teardown takes the tree, and another provider is installed.
    made[before]!.resolve();
    await replacing;
    wait.open();
    await refused;
    assert.equal(
        app.cwdOf(a),
        from,
        "the move did not commit on a provider it was not admitted under",
    );
});

const module = (version: number) => `/** Sandbox module, version ${version}. */
export default async () => {
	await globalThis.registerSandbox(${version});
	if (${version} === 2) throw new Error("the new version is broken after it registered");
	return { name: "t-sandbox-staged" };
};
`;

test("a replacement that registers and then throws leaves the old provider in place; one that loads takes its place", async () => {
    const { app, provider } = await boot();
    const directory = join(root, "round14-loader");
    const dropIn = join(directory, "drop-ins");
    const replacements = new Map<number, FakeProvider>();

    mkdirSync(join(directory, "built-in"), { recursive: true });
    mkdirSync(dropIn, { recursive: true });
    const shared = globalThis as unknown as {
        registerSandbox?: (version: number) => Promise<unknown>;
    };

    shared.registerSandbox = (version) => {
        const made = version === 1 ? provider : new FakeProvider();

        replacements.set(version, made);

        return app.sandboxes.register(made, "box.ts");
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
        },
    );

    writeFileSync(join(dropIn, "box.ts"), module(1));
    await loader.loadAll();
    const a = await newSession(app, folder("staged"));

    await app.sandboxes.turnOn(a, owner(app));
    writeFileSync(join(dropIn, "box.ts"), module(2));
    await assert.rejects(loader.reload("box.ts"), /broken after it registered/);
    assert.equal(app.sandboxes.provider, provider, "the old provider was never removed");
    assert.equal(app.sandboxes.phaseOf(a), "stable");
    assert.ok((await app.envFor(a).exec("old", undefined, context)).ok);
    assert.deepEqual(provider.ran, ["old"]);
    assert.deepEqual(replacements.get(2)!.ran, [], "the dropped one never served");
    // A replacement that loads well takes the old one's place when the loader commits it.
    writeFileSync(join(dropIn, "box.ts"), module(3).replace("=== 2", "=== 99"));
    await loader.reload("box.ts");
    assert.equal(app.sandboxes.provider, replacements.get(3));
    assert.ok((await app.envFor(a).exec("new", undefined, context)).ok);
    assert.deepEqual(replacements.get(3)!.ran, ["new"]);
    shared.registerSandbox = undefined;
});
