// Review round 8: a provider-generation fence while the provider is torn down; every intercepted call fails with its own type.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { SandboxDoc } from "../src/server/docs.ts";
import { FILE_CALLS } from "../src/server/sandbox-tools.ts";
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
        join(root, `data-round8-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );

    apps.push(app);
    await app.sandboxes.register(provider, "fake.ts");

    return { app, provider };
}

const folder = (name: string) => {
    const path = join(root, `round8-${name}`);

    mkdirSync(path, { recursive: true });

    return path;
};

test("while the provider is torn down nothing new starts under it, and a tree that appeared anyway is stopped too", async () => {
    const { app, provider } = await boot();
    const dir = folder("fence");
    const other = folder("fence-other");
    const a = await newSession(app, dir);
    const b = await newSession(app, other);

    await app.sandboxes.turnOn(a, owner(app));
    const hold = gate();

    provider.holdRelease = hold;
    const second = new FakeProvider();
    const replacing = app.sandboxes.register(second, "other.ts");

    await hold.reached;
    // A new session joins the sandboxed folder: refused, with the reason.
    await assert.rejects(app.commands.createSession(owner(app), { cwd: dir }), /being replaced/);
    // A turn-on of another session: refused too.
    await assert.rejects(app.sandboxes.turnOn(b, owner(app)), /being replaced/);
    // A tree that became sandboxed some other way (a commit that began before the fence) is not missed by the teardown.
    await app.harness.commit(async (tx) => {
        Object.assign(await tx.doc(SandboxDoc, b), { on: true, by: owner(app).id, at: Date.now() });
    }, context);
    assert.equal(app.sandboxes.isOn(b), true);
    hold.open();
    await replacing;
    assert.deepEqual(
        provider.released.sort(),
        [Number(a), Number(b)].sort(),
        "both were proved gone under the old provider",
    );
    assert.equal(app.sandboxes.provider, second);
    // The new provider serves, and the fence is down.
    assert.equal(app.sandboxes.phaseOf(b), "stable");
    const joined = await app.commands.createSession(owner(app), { cwd: dir });

    assert.equal(app.sandboxes.isOn(joined.id), true);
});

test("every intercepted call of a denied handle fails with its own result type, listFiles included", async () => {
    const { app, provider } = await boot();
    const a = await newSession(app, folder("denied"));

    await app.sandboxes.turnOn(a, owner(app));
    const handle = app.envFor(a) as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
    >;

    provider.failRelease = "the VM would not close";
    await assert.rejects(app.sandboxes.turnOff(a, owner(app)), /would not close/);
    assert.equal(app.sandboxes.phaseOf(a), "suspended");

    for (const name of [...FILE_CALLS, "exec"]) {
        assert.equal(typeof handle[name], "function", `${name} is intercepted`);
        const result = (await handle[name]!("x", undefined, context)) as {
            ok: boolean;
            error?: Error;
        };

        assert.equal(result?.ok, false, `${name} fails`);
        assert.ok(
            result.error instanceof (name === "exec" ? ExecutionError : FileError),
            `${name} fails with its own error type`,
        );
        assert.match(result.error!.message, /suspended/, name);
    }

    provider.failRelease = undefined;
});
