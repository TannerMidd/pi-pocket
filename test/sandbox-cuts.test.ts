// Scope cuts (design, "Scope cuts"): the sandbox module is not reloaded, turned off, or removed while a sandbox is on; sandboxed
// folders in one group are exactly the same folder; a removal keeps the tree reserved until its cleanup ends.
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

async function boot() {
    const provider = new FakeProvider();
    const app = await openApp(
        scriptedModel(),
        join(root, `data-cuts-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `cuts-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

const TURN_OFF = /Turn the sandbox off in every session first/;

test("cut 1: a module that serves a sandbox is not replaced, reloaded, or removed while a sandbox is on", async () => {
    const { app, provider } = await boot();
    const a = await newSession(app, folder("module"));

    await app.sandboxes.turnOn(a, owner(app));
    await assert.rejects(app.sandboxes.suspendOwner("fake.ts", false), TURN_OFF);
    await assert.rejects(app.sandboxes.suspendOwner("fake.ts", true), TURN_OFF);
    await assert.rejects(app.sandboxes.register(new FakeProvider(), "other.ts"), TURN_OFF);
    assert.equal(app.sandboxes.provider, provider, "the old module stays");
    assert.ok((await app.envFor(a).exec("still", undefined, context)).ok);
    // With every sandbox off, the same calls go through.
    await app.sandboxes.turnOff(a, owner(app));
    const next = new FakeProvider();

    await app.sandboxes.register(next, "other.ts");
    assert.equal(app.sandboxes.provider, next);
    await app.sandboxes.suspendOwner("other.ts", true);
    assert.equal(app.sandboxes.provider, undefined);
});

test("cut 1: a reload of the module while a sandbox is on fails like a failed load: the old module and its provider stay", async () => {
    const { app } = await boot();
    const directory = join(root, "cuts-loader");
    const dropIn = join(directory, "drop-ins");

    mkdirSync(join(directory, "built-in"), { recursive: true });
    mkdirSync(dropIn, { recursive: true });
    const shared = globalThis as unknown as { cutsSandbox?: (version: number) => Promise<unknown> };
    const made = new Map<number, FakeProvider>();

    shared.cutsSandbox = (version) => {
        const provider = new FakeProvider();

        made.set(version, provider);

        return app.sandboxes.register(provider, "box.ts");
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
        },
    );
    const source = (version: number) => `/** Sandbox module, version ${version}. */
export default async () => {
	await globalThis.cutsSandbox(${version});
	return { name: "t-cuts" };
};
`;

    writeFileSync(join(dropIn, "box.ts"), source(1));
    await loader.loadAll();
    assert.equal(app.sandboxes.provider, made.get(1));
    const a = await newSession(app, folder("reload"));

    await app.sandboxes.turnOn(a, owner(app));
    writeFileSync(join(dropIn, "box.ts"), source(2));
    await assert.rejects(loader.reload("box.ts"), TURN_OFF);
    assert.equal(app.sandboxes.provider, made.get(1), "the old provider stays");
    assert.equal(made.has(2), false, "the new version never ran");
    await app.sandboxes.turnOff(a, owner(app));
    await loader.reload("box.ts");
    assert.equal(app.sandboxes.provider, made.get(2));
    shared.cutsSandbox = undefined;
});

test("cut 2: sandboxed folders that overlap are the same folder: a join, a move, and an unarchive into a folder inside or around another are refused", async () => {
    const { app } = await boot();
    const outer = folder("nest-outer");
    const inner = join(outer, "inner");
    const elsewhere = folder("nest-else");

    mkdirSync(inner, { recursive: true });
    const b = await newSession(app, inner);

    await app.sandboxes.turnOn(b, owner(app));
    // Join: a session in the folder around it would run in a sandbox too, and may not.
    await assert.rejects(
        app.commands.createSession(owner(app), { cwd: outer }),
        /exactly the same folder/,
    );
    // The same folder is fine: it is one group.
    const twin = await app.commands.createSession(owner(app), { cwd: inner });

    assert.equal(app.sandboxes.isOn(twin.id), true);
    // Move: a sandboxed session may not move into a folder around another sandboxed one.
    const c = await newSession(app, elsewhere);

    await app.sandboxes.turnOn(c, owner(app));
    await assert.rejects(
        app.commands.configure(c, owner(app), { cwd: outer }),
        /exactly the same folder/,
    );
    await app.commands.configure(c, owner(app), { cwd: inner });
    assert.equal(app.cwdOf(c), inner, "the same folder is allowed");
    // Unarchive: B and its twin leave the group, A takes the folder around, and B may not come back.
    await app.commands.configure(c, owner(app), { cwd: elsewhere });
    await app.commands.updateSession(b, owner(app), { archived: true });
    await app.commands.updateSession(twin.id, owner(app), { archived: true });
    const a = await newSession(app, outer);

    await app.sandboxes.turnOn(a, owner(app));
    await assert.rejects(
        app.commands.updateSession(b, owner(app), { archived: false }),
        /exactly the same folder/,
    );
});

test("cut 3: a removal holds the tree until its cleanup ends, and idle is decided when it reserves", async () => {
    const { app } = await boot();
    const a = await newSession(app, folder("removal"));

    await app.sandboxes.turnOn(a, owner(app));
    await app.commands.updateSession(a, owner(app), { archived: true });
    const hold = gate();
    const removing = app.sandboxes.change(
        { kind: "remove", id: a },
        { commit: async () => {}, afterCommit: () => hold.wait() },
    );

    await hold.reached;
    // The entry is gone, the cleanup is still under way: nothing is delivered, and a call waits for the end.
    assert.equal(app.sandboxes.phaseOf(a), "moving");
    assert.equal(app.sandboxes.deliver(a).ok, false);
    hold.open();
    await removing;
    assert.equal(app.sandboxes.phaseOf(a), "stable");
    // A run that started before the removal reserved the tree keeps the session.
    const b = await newSession(app, folder("removal-busy"));

    await app.commands.updateSession(b, owner(app), { archived: true });
    const isBusy = app.isBusy.bind(app);

    app.isBusy = ((id: Parameters<typeof isBusy>[0]) =>
        Number(id) === Number(b) || isBusy(id)) as typeof app.isBusy;
    await assert.rejects(
        app.sandboxes.change(
            { kind: "remove", id: b },
            { commit: async () => assert.fail("removed") },
        ),
        /Pi is working in it/,
    );
    app.isBusy = isBusy;
    assert.equal(app.sandboxes.phaseOf(b), "stable");
});
