// Review round 8: a provider-generation fence while the provider is torn down; every intercepted call fails with its own type.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
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
import { FakeProvider, sandboxOptions } from "./sandbox-fake.ts";

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
