// A VM counts as closed only when its runner is shown gone (`GondolinVm.close`), and a VM that could not be closed
// stays known to the manager (its pid stays in the pid file) until a later end really closes it. No real VM runs: the
// package's VM is a stand-in with a close that fails, and the runner is a real process or a stand-in.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SandboxManager } from "../src/server/extensions/gondolin/manager.ts";
import { GondolinVm, type RunnerControl } from "../src/server/extensions/gondolin/real-driver.ts";
import { context } from "./helpers.ts";
import { FakeDriver } from "./gondolin-fake.ts";

const folder = mkdtempSync(join(tmpdir(), "gondolin-close-"));
const children: ReturnType<typeof spawn>[] = [];

after(() => {
    for (const child of children) {
        child.kill("SIGKILL");
    }

    rmSync(folder, { recursive: true, force: true });
});

/** A process that runs until it is killed; `name` is what its command line begins with. */
function lasting(name?: string) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], {
        ...(name === undefined ? {} : { argv0: name }),
        stdio: "ignore",
    });

    children.push(child);

    return child;
}

/** The package's VM, as far as a close needs it: its first close runs `first`, which may throw. */
function packageVm(pid: number | null, first?: () => void) {
    let calls = 0;

    return {
        id: "vm-1",
        getHostPid: () => pid,
        async close() {
            if (calls++ === 0) {
                first?.();
            }
        },
    };
}

const pidsIn = (file: string): number[] =>
    (JSON.parse(readFileSync(file, "utf8")) as { pid: number }[]).map((item) => item.pid);

test("a close that failed is tried again, and counts as done only when the runner is shown gone", async () => {
    let alive = true;
    let kills = 0;
    const control: RunnerControl = {
        alive: () => alive,
        kill: () => {
            kills++;
        },
    };
    const vm = new GondolinVm(
        packageVm(5000, () => {
            throw new Error("the package could not close");
        }),
        control,
        30,
    );

    await assert.rejects(vm.close(), /process 5000\) is still running: .*could not close/);
    await assert.rejects(vm.close(), /still running/, "a second close is not reported as done");
    assert.ok(kills >= 2, "each try ends the runner");

    alive = false;
    await vm.close();
    await vm.close();
});

test("a runner that outlives a failed close is killed, and the close then holds", async () => {
    const runner = lasting("gondolin-krun-runner-test");
    const gone = new Promise<void>((resolve) => runner.once("exit", () => resolve()));
    const vm = new GondolinVm(
        packageVm(runner.pid!, () => {
            throw new Error("the package could not close");
        }),
        undefined,
        3000,
    );

    await vm.close();
    await gone;
    assert.throws(() => process.kill(runner.pid!, 0), /ESRCH/);
});

test("a process id that another program reuses is not killed", async () => {
    const other = lasting();
    const vm = new GondolinVm(packageVm(other.pid!));

    await vm.close();
    assert.doesNotThrow(() => process.kill(other.pid!, 0), "the other program still runs");
});

test("a VM that could not be closed keeps its pid in the pid file until a later end closes it", async () => {
    const driver = new FakeDriver();
    const file = join(folder, "vms.json");

    driver.pids = true;
    const vms = new SandboxManager({
        driver,
        log: () => {},
        pidFile: file,
        settings: () => ({
            backend: "auto",
            mount: "rw",
            network: "off",
            allowedHosts: [],
            cpus: 1,
            memoryMb: 512,
            diskMb: 1024,
            idleMinutes: 0,
            maxVms: 2,
            image: "alpine-base:latest",
        }),
    });
    const env = vms.envFor(1, { rootId: 1, cwd: folder, uploadDir: undefined });

    try {
        assert.ok((await env.exec("true", undefined, context)).ok);
        const pid = driver.vms[0]!.pid;

        assert.deepEqual(pidsIn(file), [pid]);
        driver.failClose = "the runner does not answer";
        await assert.rejects(vms.release(1, "turned off"), /does not answer/);
        assert.deepEqual(pidsIn(file), [pid], "a VM that may still run stays in the file");
        await assert.rejects(
            vms.release(1, "again"),
            /does not answer/,
            "a retry reports no success",
        );

        driver.failClose = undefined;
        await vms.release(1, "once more");
        assert.equal(readFileSync(file, "utf8"), "[]");
    } finally {
        driver.failClose = undefined;
        await vms.stopAll("the test ended");
    }
});

test("a session that this manager holds no VM of is released only when no runner of an earlier sandbox is left", async () => {
    const file = join(folder, "earlier.json");
    let dead = false;
    const vms = new SandboxManager({
        driver: new FakeDriver(),
        log: () => {},
        pidFile: file,
        settings: () => ({}) as never,
        inspect: async () => (dead ? undefined : "gondolin-krun-runner --config /tmp/c.json"),
        kill: () => {},
    });

    writeFileSync(file, JSON.stringify([{ pid: 777, vm: "vm-777" }]));
    await assert.rejects(vms.release(9, "turned off"), /process 777\)/);
    dead = true;
    await vms.release(9, "turned off");
    assert.equal(readFileSync(file, "utf8"), "[]");
});
