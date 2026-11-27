// Review round 6: nothing reopens while a release runs; a move of a sandboxed tree checks every conversation as the move leaves
// it; a module turn-off that waited does not undo a newer load.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
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
    until,
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
        join(root, `data-round6-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(options),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round6-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

const ticks = async (count = 20) => {
    for (let turn = 0; turn < count; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

test("a second rules change does not reopen a tree while the release of the first is still running", async () => {
    let refuse: string | undefined;
    const { app, provider } = await boot({ trusted: () => refuse });
    const a = await newSession(app, folder("release-running"));

    await app.sandboxes.turnOn(a, owner(app));
    const hold = gate();

    provider.holdRelease = hold;
    refuse = "a trusted place now reaches this folder";
    const first = app.sandboxes.rules("first change");

    await hold.reached;
    // The refusal goes away, and a second change takes over; its check is clean, but the first release is still running.
    refuse = undefined;
    const second = app.sandboxes.rules("second change");

    await ticks();
    assert.equal(app.sandboxes.phaseOf(a), "suspended", "closed while the release runs");
    assert.equal((await app.envFor(a).exec("x", undefined, context)).ok, false);
    hold.open();
    await Promise.all([first, second]);
    assert.equal(app.sandboxes.phaseOf(a), "stable", "reopened once the release ended");
    assert.deepEqual(provider.released, [Number(a)]);
});

test("a failed release that the second change waited for keeps the tree suspended, with the reason", async () => {
    let refuse: string | undefined;
    const { app, provider } = await boot({ trusted: () => refuse });
    const a = await newSession(app, folder("release-fails"));

    await app.sandboxes.turnOn(a, owner(app));
    const hold = gate();

    provider.holdRelease = hold;
    provider.failRelease = "the VM would not close";
    refuse = "a trusted place now reaches this folder";
    const first = app.sandboxes.rules("first change");

    await hold.reached;
    refuse = undefined;
    const second = app.sandboxes.rules("second change");

    await ticks();
    hold.open();
    await Promise.all([first, second]);
    assert.equal(app.sandboxes.phaseOf(a), "suspended");
    const result = await app.envFor(a).exec("x", undefined, context);

    assert.ok(!result.ok && /would not close/.test(result.error.message));
    provider.failRelease = undefined;
});

test("a move of a sandboxed root checks every conversation as the move leaves it: a subagent left behind refuses it", async () => {
    const { app, provider } = await boot();
    const from = folder("move-tree");
    const to = folder("move-tree-to");
    const a = await newSession(app, from);

    mkdirSync(join(from, "sub"));
    const child = await app.harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { cwd: join(from, "sub") } },
        context,
    );

    await app.harness.commit(async (tx) => {
        (await tx.doc(SubagentsDoc, a)).agents.helper = { conversationId: child.id, reported: [] };
    }, context);
    await app.sandboxes.turnOn(a, owner(app));
    // The subagent runs, so it counts (a stopped one does not).
    const busy = app.isBusy.bind(app);

    app.isBusy = (conversation) => conversation === child.id || busy(conversation);
    await assert.rejects(
        app.commands.configure(a, owner(app), { cwd: to }),
        new RegExp(`subagent #${String(child.id)} .*outside the session's folder`),
    );
    assert.equal(app.cwdOf(a), from, "nothing moved");
    assert.deepEqual(provider.released, [], "and nothing was stopped");
    app.isBusy = busy;
    // The child goes first, into a folder the new place holds: then the root may follow.
    mkdirSync(join(to, "sub"));
    await assert.rejects(
        app.commands.configure(child.id, owner(app), { cwd: join(to, "sub") }),
        /inside the session's folder/,
    );
});

const module = (version: number) => `/** Sandbox module, version ${version}. */
export default () => ({ name: "t-sandbox", v: ${version} });
`;

test("a turn-off whose proof waited does not undo a load that began meanwhile", async () => {
    const directory = join(root, "round6-loader");
    const dropIn = join(directory, "drop-ins");
    const on = { value: true };
    const hold = gate();
    let armed = false;

    mkdirSync(join(directory, "built-in"), { recursive: true });
    mkdirSync(dropIn, { recursive: true });
    const loader = new ExtensionLoader(
        createRegistry(),
        { notice: () => {} } as unknown as PocketHost,
        { builtIn: join(directory, "built-in"), dropIn },
        () => on.value,
        {
            webs: new ExtensionWebs({}),
            notify: () => {},
            suspend: async (_file, leave) => {
                if (armed && leave) {
                    await hold.wait();
                }
            },
        },
    );

    writeFileSync(join(dropIn, "sandbox.ts"), module(1));
    await loader.loadAll();
    assert.ok(loader.extensionNames().includes("t-sandbox"));
    // Turned off, and the proof waits. The owner turns it on again, and a newer load installs.
    armed = true;
    on.value = false;
    const off = loader.apply("sandbox.ts");

    await hold.reached;
    armed = false;
    on.value = true;
    await loader.apply("sandbox.ts");
    assert.ok(loader.extensionNames().includes("t-sandbox"));
    hold.open();
    await off;
    await until(() => true, "a turn");
    assert.ok(
        loader.extensionNames().includes("t-sandbox"),
        "the older turn-off did not uninstall the newer load",
    );
});
