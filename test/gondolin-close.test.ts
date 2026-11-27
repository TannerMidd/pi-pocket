// A VM counts as closed only when its runner is shown gone (`GondolinVm.close`), and a VM that could not be closed
// stays known to the manager (its pid stays in the pid file) until a later end really closes it. No real VM runs: the
// package's VM is a stand-in with a close that fails, and the runner is a real process or a stand-in.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SandboxManager, type Inspected } from "../src/server/extensions/gondolin/manager.ts";
import {
    GondolinVm,
    type Runner,
    type RunnerControl,
} from "../src/server/extensions/gondolin/real-driver.ts";
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
        identity: () => (alive ? { state: "alive", identity: "boot-1:runner" } : { state: "gone" }),
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
    let who: Runner = { state: "alive", identity: "boot-1:runner" };
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

    who = { state: "alive", identity: "boot-9:runner" };
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
                dead.has(pid)
                    ? { state: "gone" }
                    : { state: "alive", line: "gondolin-krun-runner --config /tmp/c.json" },
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
        inspect: async () =>
            dead
                ? { state: "gone" }
                : { state: "alive", line: "gondolin-krun-runner --config /tmp/c.json" },
        kill: () => {},
    });

    writeFileSync(file, JSON.stringify([{ pid: 777, vm: "vm-777", session: 9 }]));
    await assert.rejects(vms.release(9, "turned off"), /process 777\)/);
    dead = true;
    await vms.release(9, "turned off");
    assert.equal(readFileSync(file, "utf8"), "[]");
});

test("a runner that cannot be told from gone is not gone: the close fails, and nothing is killed", async () => {
    let state: Runner = { state: "alive", identity: "boot-1:runner" };
    let kills = 0;
    const vm = new GondolinVm(
        packageVm(5000),
        {
            identity: () => state,
            kill: () => {
                kills++;
            },
        },
        30,
    );

    state = { state: "unknown" };
    await assert.rejects(vm.close(), /cannot be shown gone/);
    assert.equal(kills, 0, "a process that cannot be identified is never killed");
    state = { state: "gone" };
    await vm.close();
});

test("a runner on record that ps cannot tell about stays on record, and its release fails", async () => {
    const file = join(folder, "unknown.json");
    let seen: Inspected = { state: "unknown" };
    let kills = 0;
    const vms = new SandboxManager({
        driver: new FakeDriver(),
        log: () => {},
        pidFile: file,
        settings: settings(),
        inspect: async () => seen,
        kill: () => {
            kills++;
        },
    });

    writeFileSync(file, JSON.stringify([{ pid: 777, vm: "vm-777", session: 9 }]));
    await assert.rejects(vms.release(9, "turned off"), /process 777\)/);
    assert.deepEqual(pidsIn(file), [777]);
    assert.equal(kills, 0);

    seen = { state: "gone" };
    await vms.release(9, "turned off");
    assert.equal(readFileSync(file, "utf8"), "[]");
});

test("a boot that fails after the runner exists keeps it on record when the close fails, and removes it when the close works", async () => {
    const driver = new FakeDriver();
    const file = join(folder, "boot.json");

    driver.pids = true;
    driver.failBoot = "the guest did not answer";
    const vms = new SandboxManager({ driver, log: () => {}, pidFile: file, settings: settings() });
    const env = vms.envFor(1, { rootId: 1, cwd: folder, uploadDir: undefined });

    try {
        const clean = await env.exec("true", undefined, context);

        assert.equal(clean.ok, false);
        assert.match(String((clean as { error: Error }).error.message), /did not answer/);
        assert.equal(driver.vms[0]!.closed, true, "the VM of the failed boot was closed");
        assert.equal(readFileSync(file, "utf8"), "[]", "and is off the record");

        driver.failClose = "the runner does not answer";
        const stuck = await env.exec("true", undefined, context);

        assert.equal(stuck.ok, false);
        assert.deepEqual(
            pidsIn(file),
            [driver.vms[1]!.pid],
            "a close that failed leaves the runner on record",
        );
        const refused = await env.exec("true", undefined, context);

        assert.match(String((refused as { error: Error }).error.message), /could not be closed/);
        assert.equal(driver.vms.length, 2, "no new VM while the runner may run");
        await assert.rejects(vms.release(1, "turned off"), /does not answer/);

        driver.failClose = undefined;
        await vms.release(1, "turned off");
        assert.equal(readFileSync(file, "utf8"), "[]");
    } finally {
        driver.failClose = undefined;
        await vms.stopAll("the test ended");
    }
});

test("a record that cannot be read or written stops starts and releases, with the reason", async () => {
    const driver = new FakeDriver();
    const damaged = join(folder, "damaged.json");
    const noRead = join(folder, "no-read.json");
    const noWrite = join(folder, "no-write.json");

    writeFileSync(damaged, "{ not a list");
    mkdirSync(noRead);
    mkdirSync(`${noWrite}.${process.pid}.tmp`);
    const manager = (pidFile: string) =>
        new SandboxManager({ driver, log: () => {}, pidFile, settings: settings() });

    for (const [file, reason] of [
        [damaged, /is damaged/],
        [noRead, /cannot be read/],
    ] as const) {
        const vms = manager(file);
        const call = await vms
            .envFor(1, { rootId: 1, cwd: folder, uploadDir: undefined })
            .exec("true", undefined, context);

        assert.equal(call.ok, false);
        assert.match(String((call as { error: Error }).error.message), reason);
        assert.equal(driver.log.started.length, 0, "no VM started");
        await assert.rejects(vms.release(1, "turned off"), reason);
        await assert.rejects(vms.reapStale(), reason);
    }

    // The record can be read but not written once the VM exists: the VM is closed, and the start fails with the reason.
    driver.pids = true;
    const written = await manager(noWrite)
        .envFor(2, { rootId: 2, cwd: folder, uploadDir: undefined })
        .exec("true", undefined, context);

    assert.equal(written.ok, false);
    assert.match(String((written as { error: Error }).error.message), /cannot be written/);
    assert.equal(driver.vms.at(-1)!.closed, true, "the VM that could not be recorded was closed");
});

test("the record is replaced in one step: written under another name and renamed over the old one", async () => {
    const driver = new FakeDriver();
    const file = join(folder, "atomic.json");

    driver.pids = true;
    const vms = new SandboxManager({ driver, log: () => {}, pidFile: file, settings: settings() });

    try {
        assert.ok(
            (
                await vms
                    .envFor(1, { rootId: 1, cwd: folder, uploadDir: undefined })
                    .exec("true", undefined, context)
            ).ok,
        );
        const before = statSync(file).ino;

        assert.ok(
            (
                await vms
                    .envFor(2, { rootId: 2, cwd: folder, uploadDir: undefined })
                    .exec("true", undefined, context)
            ).ok,
        );
        assert.notEqual(statSync(file).ino, before, "a new file took the place of the old one");
        assert.deepEqual(
            readdirSync(folder).filter((name) => name.startsWith("atomic.json")),
            ["atomic.json"],
            "no temporary file is left",
        );
        assert.equal(pidsIn(file).length, 2);
    } finally {
        await vms.stopAll("the test ended");
    }
});
