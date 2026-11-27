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
import { context, until } from "./helpers.ts";
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

/** The package's VM, as far as a close needs it: it answers its runner's pid once, and null while it closes. */
function packageVm(pid: number | null, first?: () => void) {
    let asked = false;
    let calls = 0;

    return {
        id: "vm-1",
        getHostPid: () => {
            if (asked) {
                return null;
            }

            asked = true;

            return pid;
        },
        async close() {
            if (calls++ === 0) {
                first?.();
            }
        },
    };
}

const refuses = () => {
    throw new Error("the package could not close");
};

const pidsIn = (file: string): number[] =>
    (JSON.parse(readFileSync(file, "utf8")) as { pid: number }[]).map((item) => item.pid);

const onLinux = {
    skip:
        process.platform === "linux"
            ? false
            : "needs /proc and process groups, which only Linux has",
};

test("a close that failed is tried again with the runner asked for once, and counts as done only when it is shown gone", async () => {
    let alive = true;
    let kills = 0;
    const control: RunnerControl = {
        identity: () => (alive ? "boot-1:gondolin-krun-runner" : undefined),
        kill: () => {
            kills++;
        },
    };
    const vm = new GondolinVm(packageVm(5000, refuses), control, 30);

    assert.equal(vm.hostPid(), 5000, "the pid is the one that was asked for at the start");
    await assert.rejects(vm.close(), /process 5000\) is still running: .*could not close/);
    await assert.rejects(
        vm.close(),
        /still running/,
        "the package now answers null: the retry still knows the runner",
    );
    assert.ok(kills >= 2, "each try ends the runner");
    assert.equal(vm.hostPid(), 5000);

    alive = false;
    await vm.close();
    await vm.close();
});

test("a process id that another program has taken since is not the runner, and is not killed", async () => {
    let who: string | undefined = "boot-1:gondolin-krun-runner";
    let kills = 0;
    const vm = new GondolinVm(
        packageVm(5000),
        {
            identity: () => who,
            kill: () => {
                kills++;
            },
        },
        30,
    );

    who = "boot-9:gondolin-krun-runner";
    await vm.close();
    assert.equal(kills, 0);
});

test(
    "a runner that outlives a failed close is killed, and the close then holds",
    onLinux,
    async () => {
        const runner = lasting("gondolin-krun-runner-test");
        const gone = new Promise<void>((resolve) => runner.once("exit", () => resolve()));
        const vm = new GondolinVm(packageVm(runner.pid!, refuses), undefined, 3000);

        await vm.close();
        await gone;
        assert.throws(() => process.kill(runner.pid!, 0), /ESRCH/);
    },
);

test("a process that is not a runner is not killed", onLinux, async () => {
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

function settings() {
    return () => ({
        backend: "auto" as const,
        mount: "rw" as const,
        network: "off" as const,
        allowedHosts: [],
        cpus: 1,
        memoryMb: 512,
        diskMb: 1024,
        idleMinutes: 0,
        maxVms: 4,
        image: "alpine-base:latest",
    });
}

test("a runner is on record from the moment it exists: a start that is cancelled and whose VM cannot be closed stays on record", async () => {
    const driver = new FakeDriver();
    const file = join(folder, "cancelled.json");
    let open!: () => void;

    driver.pids = true;
    driver.startGate = new Promise<void>((resolve) => {
        open = resolve;
    });
    const vms = new SandboxManager({ driver, log: () => {}, pidFile: file, settings: settings() });
    const env = vms.envFor(1, { rootId: 1, cwd: folder, uploadDir: undefined });

    try {
        const call = env.exec("true", undefined, context);

        await until(() => driver.log.started.length === 1, "the start to begin");
        driver.failClose = "the runner does not answer";
        const stopping = vms.stop(1, "stopped meanwhile");

        open();
        await stopping;
        assert.equal((await call).ok, false);
        assert.deepEqual(
            pidsIn(file),
            [driver.vms[0]!.pid],
            "the VM that could not be closed is on record",
        );
        await assert.rejects(vms.release(1, "turned off"), /does not answer/);
    } finally {
        open();
        driver.failClose = undefined;
        await vms.stopAll("the test ended");
    }
});

test("a release ends every runner of the session on record, from any earlier manager, and fails when one cannot be shown gone", async () => {
    const driver = new FakeDriver();
    const file = join(folder, "generations.json");
    const dead = new Set<number>();
    let killable = false;

    driver.pids = true;
    const first = new SandboxManager({
        driver,
        log: () => {},
        pidFile: file,
        settings: settings(),
    });

    try {
        for (const id of [1, 2]) {
            const env = first.envFor(id, { rootId: id, cwd: folder, uploadDir: undefined });

            assert.ok((await env.exec("true", undefined, context)).ok);
        }

        const [mine, other] = driver.vms.map((vm) => vm.pid!);

        // The module loads again: a new manager has an empty entry for the session, made by the first call of an environment.
        const second = new SandboxManager({
            driver: new FakeDriver(),
            log: () => {},
            pidFile: file,
            settings: settings(),
            inspect: async (pid) =>
                dead.has(pid) ? undefined : "gondolin-krun-runner --config /tmp/c.json",
            kill: (pid) => {
                if (killable) {
                    dead.add(pid);
                }
            },
        });

        second.envFor(1, { rootId: 1, cwd: folder, uploadDir: undefined });
        await assert.rejects(second.release(1, "turned off"), new RegExp(`process ${mine}\\)`));
        assert.deepEqual(
            pidsIn(file).sort(),
            [mine, other].sort(),
            "nothing leaves the record unproven",
        );

        killable = true;
        await second.release(1, "turned off again");
        assert.deepEqual(pidsIn(file), [other], "only the session's own runner went");
    } finally {
        await first.stopAll("the test ended");
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

    writeFileSync(file, JSON.stringify([{ pid: 777, vm: "vm-777", session: 9 }]));
    await assert.rejects(vms.release(9, "turned off"), /process 777\)/);
    dead = true;
    await vms.release(9, "turned off");
    assert.equal(readFileSync(file, "utf8"), "[]");
});
