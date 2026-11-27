// How a session's VM ends: a stop or a release finishes only when the VM is really gone, a start under way ends with it,
// a second stop waits for the first, and a release revokes the session's environments before anything else. Each case
// holds the start or the close of the fake VM at a gate (`gondolin-fake.ts`), so nothing here waits for a time.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SandboxManager } from "../src/server/extensions/gondolin/manager.ts";
import { context, until } from "./helpers.ts";
import { FakeDriver } from "./gondolin-fake.ts";

const folder = mkdtempSync(join(tmpdir(), "gondolin-lifecycle-"));

after(() => rmSync(folder, { recursive: true, force: true }));

function gate() {
    let open!: () => void;
    const closed = new Promise<void>((resolve) => {
        open = resolve;
    });

    return { closed, open };
}

/** Whether `promise` has settled by the time the next turn of the event loop starts (the work it waits on is gated). */
async function settled(promise: Promise<unknown>): Promise<boolean> {
    return Promise.race([
        promise.then(
            () => true,
            () => true,
        ),
        new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
}

function setup() {
    const driver = new FakeDriver();
    const vms = new SandboxManager({
        driver,
        log: () => {},
        pidFile: join(folder, `vms-${process.pid}.json`),
        settings: () => ({
            backend: "auto",
            mount: "rw",
            network: "off",
            allowedHosts: [],
            cpus: 1,
            memoryMb: 512,
            diskMb: 1024,
            idleMinutes: 0,
            maxVms: 4,
            image: "alpine-base:latest",
        }),
    });
    const env = vms.envFor(1, { rootId: 1, cwd: folder, uploadDir: undefined });

    return { driver, vms, env };
}

test("a release revokes the environments first: none starts a replacement VM while the VM closes", async () => {
    const { driver, vms, env } = setup();

    try {
        assert.ok((await env.exec("true", undefined, context)).ok);
        const closing = gate();

        driver.closeGate = closing.closed;
        const released = vms.release(1, "the sandbox was turned off");

        await until(() => driver.vms[0]!.closeCalled, "the close to begin");
        const call = await env.exec("true", undefined, context);

        assert.equal(call.ok, false, "a call of an environment that exists is refused");
        assert.match(String((call as { error: Error }).error.message), /turned off/);
        assert.equal(driver.log.started.length, 1, "no replacement VM started");
        assert.equal(await settled(released), false, "the release waits for the close");
        closing.open();
        await released;
        assert.equal(driver.vms[0]!.closed, true);
        assert.equal(driver.log.started.length, 1);
        assert.equal(vms.state(1), undefined, "the entry is gone");
    } finally {
        await vms.stopAll("the test ended");
    }
});

test("a stop while a start is under way waits for the start, and the VM it made is closed when the stop returns", async () => {
    const { driver, vms, env } = setup();
    const starting = gate();

    driver.startGate = starting.closed;

    try {
        const call = env.exec("true", undefined, context);

        await until(() => driver.log.started.length === 1, "the start to begin");
        const stopping = vms.stop(1, "stopped meanwhile");

        assert.equal(await settled(stopping), false, "the stop waits for the start");
        starting.open();
        await stopping;
        assert.equal(driver.vms.length, 1);
        assert.equal(driver.vms[0]!.closed, true, "the VM that the start made is gone");
        assert.equal((await call).ok, false, "the call that waited for the start fails");
        assert.equal(vms.running, 0);
    } finally {
        starting.open();
        await vms.stopAll("the test ended");
    }
});

test("a release while a start is under way leaves no VM, and no call starts one afterwards", async () => {
    const { driver, vms, env } = setup();
    const starting = gate();

    driver.startGate = starting.closed;

    try {
        const call = env.exec("true", undefined, context);

        await until(() => driver.log.started.length === 1, "the start to begin");
        const released = vms.release(1, "the session was removed");

        assert.equal(await settled(released), false);
        starting.open();
        await released;
        assert.equal(driver.vms[0]!.closed, true);
        assert.equal((await call).ok, false);
        assert.equal((await env.exec("true", undefined, context)).ok, false);
        assert.equal(driver.log.started.length, 1);
    } finally {
        starting.open();
        await vms.stopAll("the test ended");
    }
});

test("a second stop waits for the first one's close", async () => {
    const { driver, vms, env } = setup();

    try {
        assert.ok((await env.exec("true", undefined, context)).ok);
        const closing = gate();

        driver.closeGate = closing.closed;
        const first = vms.stop(1, "the first");

        await until(() => driver.vms[0]!.closeCalled, "the close to begin");
        const second = vms.stop(1, "the second");

        assert.equal(await settled(second), false, "the second stop does not return early");
        assert.equal(await settled(first), false);
        closing.open();
        assert.equal(await first, true);
        assert.equal(await second, false);
        assert.equal(driver.vms[0]!.closed, true);
    } finally {
        await vms.stopAll("the test ended");
    }
});

test("a call that comes while a stop closes the VM waits, and then starts a new one", async () => {
    const { driver, vms, env } = setup();

    try {
        assert.ok((await env.exec("true", undefined, context)).ok);
        const closing = gate();

        driver.closeGate = closing.closed;
        const stopping = vms.stop(1, "idle");

        await until(() => driver.vms[0]!.closeCalled, "the close to begin");
        const call = env.exec("true", undefined, context);

        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(driver.log.started.length, 1, "the new VM waits for the old one to be gone");
        closing.open();
        await stopping;
        assert.ok((await call).ok);
        assert.equal(driver.log.started.length, 2);
        assert.equal(driver.vms[0]!.closed, true);
    } finally {
        await vms.stopAll("the test ended");
    }
});

test("a release rejects when the VM cannot be closed, keeps the session revoked, and a later release closes it", async () => {
    const { driver, vms, env } = setup();

    try {
        assert.ok((await env.exec("true", undefined, context)).ok);
        driver.failClose = "the runner does not answer";
        await assert.rejects(vms.release(1, "turned off"), /does not answer/);
        assert.equal((await env.exec("true", undefined, context)).ok, false);
        assert.equal(driver.log.started.length, 1, "no replacement while the old VM may run");
        assert.equal(driver.vms[0]!.closed, false);

        driver.failClose = undefined;
        await vms.release(1, "turned off again");
        assert.equal(driver.vms[0]!.closed, true);
        assert.equal(vms.state(1), undefined);
    } finally {
        driver.failClose = undefined;
        await vms.stopAll("the test ended");
    }
});

test("stopAll waits for starts and closes under way", async () => {
    const { driver, vms, env } = setup();
    const starting = gate();

    driver.startGate = starting.closed;

    try {
        const call = env.exec("true", undefined, context);

        await until(() => driver.log.started.length === 1, "the start to begin");
        const stopping = vms.stopAll("the module goes");

        assert.equal(await settled(stopping), false);
        starting.open();
        await stopping;
        assert.equal(driver.vms[0]!.closed, true);
        assert.equal((await call).ok, false);
    } finally {
        starting.open();
        vms.resume();
        await vms.stopAll("the test ended");
    }
});

test("a release leaves a mark that outlives the entry: no call, browser launch, or shell starts a VM until the session is reinstated", async () => {
    const { driver, vms, env } = setup();
    const target = { rootId: 1, cwd: folder, uploadDir: undefined };

    try {
        assert.ok((await env.exec("true", undefined, context)).ok);
        await vms.release(1, "the sandbox was turned off");
        assert.equal(vms.state(1), undefined, "the entry is gone");

        // Core has not stored `off` yet: calls from before, and a new environment, still reach the manager.
        for (const attempt of [
            () => env.exec("true", undefined, context).then((result) => result.ok),
            () =>
                vms
                    .envFor(1, target)
                    .exec("true", undefined, context)
                    .then((result) => result.ok),
            () =>
                vms.launchBrowser(target, []).then(
                    () => true,
                    () => false,
                ),
            () =>
                vms.spawnShell(target, "true").then(
                    () => true,
                    () => false,
                ),
        ]) {
            assert.equal(await attempt(), false);
        }

        assert.equal(driver.log.started.length, 1, "no VM started");
        assert.equal(vms.running, 0);

        vms.reinstate(1);
        assert.ok((await vms.envFor(1, target).exec("true", undefined, context)).ok);
        assert.equal(driver.log.started.length, 2);
    } finally {
        await vms.stopAll("the test ended");
    }
});
