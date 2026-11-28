import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import childProcess, { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import {
    appendFileSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { context } from "./helpers.ts";
import { type BackgroundTask, wait } from "../src/server/background.ts";
import { BackgroundDoc } from "../src/server/docs.ts";
import { taskProcesses, type TaskRef, WindowsProcesses } from "../src/server/processes.ts";

const model = scriptedModel(() => fauxAssistantMessage([fauxText("noted")]));
const dataDir = join(root, "platforms");
let app: App;
const decoys: ChildProcess[] = [];

function quick(): void {
    app.background.timing = { look: 100, grace: 1000, starting: 600, sweep: 60_000 };
}

before(async () => {
    app = await openApp(model, dataDir);
    quick();
});

after(async () => {
    for (const decoy of decoys) {
        decoy.kill("SIGKILL");
    }

    await app?.close();
    cleanUp();
});

const running = (pid: number) => {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

const one = async (id: ConversationId) =>
    Object.values((await app.harness.snapshot(BackgroundDoc, id, context))?.items ?? {})[0]!;

/** A command that starts node, which writes its own pid (the platform's, not bash's) and runs until stopped. */
const child = (file: string) =>
    `node -e "require('fs').writeFileSync('${file}', String(process.pid)); setInterval(() => {}, 1000)"`;

async function pidIn(item: BackgroundTask, file: string): Promise<number> {
    const path = join(item.cwd, file);

    await until(
        () => existsSync(path) && readFileSync(path, "utf8").trim() !== "",
        `${file} to be written`,
        30_000,
    );

    return Number(readFileSync(path, "utf8"));
}

test("Windows membership needs process identity, not a PID probe", async (t) => {
    const task: TaskRef = {
        pid: 41,
        startTicks: 100,
        marker: "synthetic",
        files: join(root, "synthetic-attempt"),
        startedAt: 0,
    };
    const calls: string[] = [];
    let table = "list 41,1,100 42,41,102";
    let job = "none";
    let fails = "";
    const processes = new WindowsProcesses({
        ask: async (line) => {
            const command = line.split(" ")[0];

            calls.push(line);

            if (command === fails) {
                throw new Error("synthetic helper failure");
            }

            return command === "list" ? table : command === "members" ? job : "ok";
        },
        failed: undefined,
        holds: () => false,
        close: () => {},
    });
    const probe = t.mock.method(process, "kill", () => true);
    const members = () => processes.members(task, true);

    assert.equal(processes.aliveSync(task), false, "a missing snapshot proves nothing");
    assert.deepEqual(await members(), [41, 42]);
    assert.equal(processes.aliveSync(task), true);

    const later = Date.now() + 6000;
    const clock = t.mock.method(Date, "now", () => later);

    assert.equal(processes.aliveSync(task), false, "an expired snapshot proves nothing");
    clock.mock.restore();

    for (fails of ["members", "list"]) {
        assert.equal(await members(), undefined, `${fails} failed after a positive observation`);
    }

    fails = "";
    table = "list 41,1,200 42,41,0";
    assert.equal(await members(), undefined, "a known child has an unreadable start");
    assert.equal(processes.aliveSync(task), false);
    table = "list 41,1,0 42,41,102";
    assert.deepEqual(await members(), [42], "the verified child is sufficient on its own");
    table = "list 41,1,0";
    assert.equal(await members(), undefined, "the leader has an unreadable start");

    table = "list 41,1,200 42,41,201 43,41,0";
    job = "members 77,0";
    assert.equal(await members(), undefined, "the helper could not identify a job member");
    job = "members 77,300";
    assert.equal(await members(), undefined, "the job and table do not agree about a member");
    assert.ok(!calls.some((line) => line.startsWith("drop ")), "keep the job on uncertainty");
    job = "none";
    const noStart = { ...task, marker: "another", files: join(root, "no-start"), startTicks: 0 };

    assert.equal(await processes.members(noStart, true), undefined, "no recorded identity");
    assert.equal(await members(), undefined, "a reused leader cannot exclude unseen descendants");
    await processes.signal(task, "SIGKILL");
    assert.ok(!calls.some((line) => line.startsWith("kill ")), "do not kill by PID alone");
    table = "list 77,1,300";
    job = "members 77,300";
    assert.deepEqual(await members(), [77], "the checked job member survives its launcher");
    assert.deepEqual(await processes.members({ ...task, pid: 0 }, true), [77]);
    assert.deepEqual(await processes.find({ ...task, pid: 0 }), { pid: 77, start: 300 });
    await processes.signal(task, "SIGKILL");
    assert.ok(calls.includes("kill 77 300"), "the kill request includes the verified start");
    assert.equal(probe.mock.callCount(), 0);
});

test("Windows absence requires coverage of the gated command, not just an empty job", async (t) => {
    let table = "list";
    let job = "members";
    let mode = "";
    const requests: string[] = [];
    const helper = {
        ask: async (line: string) => {
            const [command] = line.split(" ");

            requests.push(line);

            if (command === "cover") {
                return mode === "failed-assignment" ? "no" : "covered 100";
            }

            if (command === "watch" && mode === "failed-monitor") {
                return "no";
            }

            return command === "members" ? job : command === "list" ? table : "ok";
        },
        close: () => {},
        holds: () => false,
        failed: undefined,
    };
    let released = false;
    const fake = t.mock.method(childProcess, "spawn", (_shell: string, args: string[]) => {
        assert.deepEqual(args.slice(0, 2), ["-p", "-c"]);
        const stdin = new PassThrough();
        const stdout = new PassThrough();

        stdout.write("42\n");
        stdin.on("data", (data: Buffer) => {
            const word = data.toString().trim();

            if (word === "go") {
                released = true;
            } else {
                assert.match(requests.at(-1)!, /^pin \w+ 41 42$/);
                stdout.write(`${word} ${mode === "wrong-shell" ? "49" : "42"}\n`);
            }
        });

        return Object.assign(new EventEmitter(), {
            pid: 41,
            stdin,
            stdout,
            unref: () => {},
            kill: (signal?: number) => signal !== 0 || mode !== "exited-launcher",
        });
    });

    syncBuiltinESMExports();

    try {
        for (mode of [
            "covered",
            "exited-launcher",
            "wrong-shell",
            "failed-assignment",
            "failed-monitor",
        ]) {
            const task = { pid: 0, marker: mode, files: join(root, mode), startedAt: Date.now() };
            const processes = new WindowsProcesses(helper);

            t.mock.method(processes, "shell", () => "synthetic-shell");
            requests.length = 0;
            released = false;
            // This plausible table and stale PID file must not establish launch identity.
            table = "list 41,1,100 42,41,110";
            job = "members";
            writeFileSync(`${task.files}.pid`, "42\n");

            const launched = processes.spawn("", root, {}, task, () => {
                assert.equal(released, false);
                const key = readFileSync(`${task.files}.pids`, "utf8").match(/^job (\w+)$/m)![1];
                const receipt = Buffer.from(`${task.files}.pids`).toString("base64");

                assert.deepEqual(requests, [
                    `pin ${key} 41 42`,
                    `cover ${key}`,
                    `watch ${key} ${receipt}`,
                ]);
            });

            if (mode === "covered") {
                assert.deepEqual(await launched, { pid: 41, start: 100 });
                assert.equal(released, true);
            } else {
                await assert.rejects(
                    launched,
                    /verified|cover the gated command|monitor the Windows job/,
                );
                assert.equal(released, false, "no command runs without durable coverage");
                assert.equal(existsSync(`${task.files}.pids`), false);

                if (mode === "wrong-shell" || mode === "exited-launcher") {
                    await processes.signal(task, "SIGKILL");
                    assert.ok(
                        !requests.some((line) => /^(cover|kill) /.test(line)),
                        "no assignment or PID kill after a failed proof",
                    );
                }
            }

            // A grandchild can remain after an unobserved parent exits. Its ppid does not identify it.
            table = "list 99,73,120";
            job = "none";
            assert.equal(await new WindowsProcesses(helper).members(task, true), undefined);
            job = "members";
            const recovered = new WindowsProcesses(helper);

            if (mode === "covered") {
                assert.equal(
                    await recovered.members({ ...task, marker: "different" }, true),
                    undefined,
                );
                appendFileSync(`${task.files}.pids`, "truncated pid");
                assert.deepEqual(await recovered.members(task, true), []);
                job = "none";
                assert.deepEqual(await new WindowsProcesses(helper).members(task, true), []);
            } else {
                assert.equal(await recovered.members(task, true), undefined);
            }
        }
    } finally {
        fake.mock.restore();
        syncBuiltinESMExports();
    }
});

test("Windows recovery waits for a complete, matching receipt from the previous helper", async () => {
    const task = { pid: 0, marker: "offline", files: join(root, "offline"), startedAt: 0 };
    const file = `${task.files}.pids`;
    const key = createHash("sha256").update(task.marker).digest("hex").slice(0, 32);
    const restarted = new WindowsProcesses({
        ask: async (line) => (line === "list" ? "list 99,73,0" : "none"),
        failed: undefined,
        holds: () => false,
        close: () => {},
    });

    writeFileSync(file, `job ${key}\n99 101\nempty other-attempt\n`);
    assert.equal(await restarted.members(task, true), undefined);
    appendFileSync(file, `empty ${key}`);
    assert.equal(await restarted.members(task, true), undefined, "no torn record");
    appendFileSync(file, "\n");
    assert.deepEqual(await restarted.members(task, true), []);
    assert.equal(await restarted.members({ ...task, marker: "replacement" }, true), undefined);
});

test("Windows recovery does not identify a process by its PID file and a timestamp window", async () => {
    const task = { pid: 0, marker: "legacy", files: join(root, "legacy"), startedAt: Date.now() };
    const start = task.startedAt + 11_644_473_600_000;
    const processes = new WindowsProcesses({
        ask: async (line) => (line === "list" ? `list 41,1,${start}` : "none"),
        close: () => {},
        holds: () => false,
        failed: undefined,
    });

    writeFileSync(`${task.files}.pid`, "41");
    assert.equal(await processes.find(task), undefined);
    assert.equal(await processes.members(task, true), undefined);
});

// The Darwin Nix builder can deny /bin/ps. Outside that builder, a broken ps must fail the tests.
const psDenied =
    process.platform === "darwin" &&
    process.env.NIX_BUILD_TOP !== undefined &&
    (
        spawnSync("/bin/ps", ["-p", String(process.pid)], { stdio: "ignore" }).error as
            NodeJS.ErrnoException | undefined
    )?.code === "EPERM";
const processTest = (name: string, run: () => Promise<void>) =>
    test(name, { skip: psDenied && "the Nix sandbox denies /bin/ps" }, run);

if (psDenied) {
    test("a denied process table prevents a task from starting", async () => {
        const id = await newSession(app);

        await assert.rejects(
            app.background.start(id, { command: "echo started" }),
            /ps: spawn EPERM/,
        );
        assert.equal(await one(id), undefined);
    });
}

processTest("a task runs, prints, and ends with its exit code", async () => {
    const id = await newSession(app);
    const item = await app.background.start(id, {
        requestedBy: owner(app).id,
        command: "echo one; sleep 0.3; echo two; exit 3",
        notify: false,
    });

    assert.equal(item.status, "running");
    assert.ok(item.startTicks !== undefined, "its start time is recorded");
    await until(async () => (await one(id)).status !== "running", "the end", 30_000);
    assert.equal((await one(id)).status, "exited");
    assert.equal((await one(id)).code, 3);
    assert.equal((await app.background.read(id, item.id))?.text, "one\ntwo\n");
});

processTest("a stop ends the task and a child it started, also one its shell left", async () => {
    const id = await newSession(app);
    const item = await app.background.start(id, {
        requestedBy: owner(app).id,
        command: `${child("waits.pid")} & first=$!; ${child("left.pid")} > /dev/null 2>&1 & echo started; wait $first`,
        notify: false,
    });
    const waits = await pidIn(item, "waits.pid");
    const left = await pidIn(item, "left.pid");

    assert.ok(running(waits) && running(left));
    await wait(500);

    const stopped = await app.background.stop(id, item.id);

    assert.equal(stopped?.status, "stopped");
    await until(() => !running(waits) && !running(left), "both children to be ended", 15_000);
    assert.equal(await app.background.aliveNow(id, item), false);
});

processTest("a task whose shell exits runs while its child runs", async () => {
    const id = await newSession(app);
    const item = await app.background.start(id, {
        requestedBy: owner(app).id,
        command: `${child("daemon.pid")} > /dev/null 2>&1 & exit 0`,
        notify: false,
    });
    const daemon = await pidIn(item, "daemon.pid");

    await wait(1500);
    assert.equal((await one(id)).status, "running", "its child keeps it running");
    await app.background.stop(id, item.id);
    await until(() => !running(daemon), "the child to be ended", 15_000);
});

processTest("a stop never ends a process that took the task's pid", async () => {
    const id = await newSession(app);
    const item = await app.background.start(id, {
        requestedBy: owner(app).id,
        command: child("real.pid"),
        notify: false,
    });
    const real = await pidIn(item, "real.pid");
    // Another process, which is not the task's, in a group of its own, as a task's leader would be.
    const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
    });

    decoys.push(decoy);
    await until(() => running(decoy.pid!), "the decoy to run");

    // As if the task's first process ended and the decoy took its pid: the record's start time is the task's.
    await app.harness.commit(async (tx) => {
        (await tx.doc(BackgroundDoc, id)).items[item.id]!.pid = decoy.pid!;
    }, context);

    if (process.platform !== "win32") {
        const { startTicks: _missing, ...noStart } = item;
        const backend = taskProcesses();

        try {
            await backend.killSpawned(
                {
                    pid: 0,
                    marker: `${dataDir}#not-this-attempt`,
                    files: "",
                    startedAt: item.startedAt,
                },
                decoy.pid!,
            );
        } finally {
            backend.close();
        }

        assert.equal(
            await app.background.aliveNow(id, { ...noStart, pid: decoy.pid! }),
            undefined,
            "a leader without a saved start must carry the attempt marker",
        );
    }

    await app.background.stop(id, item.id);
    await wait(1500);
    assert.equal(running(decoy.pid!), true, "the decoy runs on");

    await until(() => !running(real), "the task's own process to be ended", 15_000);
});

processTest("a task quiet for its limit is stopped, with what it printed", async () => {
    const id = await newSession(app);
    const item = await app.background.start(id, {
        requestedBy: owner(app).id,
        command: `echo begun; ${child("quiet.pid")}`,
        quietMinutes: 0.05,
        notify: false,
    });
    const quiet = await pidIn(item, "quiet.pid");

    await until(async () => (await one(id)).status !== "running", "the quiet limit", 30_000);
    assert.equal((await one(id)).status, "stopped");
    assert.match((await one(id)).why ?? "", /printed nothing/);
    assert.equal((await app.background.read(id, item.id))?.text, "begun\n");
    await until(() => !running(quiet), "its process to be ended", 15_000);
});

const windowsTest = (name: string, run: () => Promise<void>) =>
    test(name, { skip: process.platform !== "win32" && "needs Windows job objects" }, run);

test(
    "Windows refuses a gated shell that exits after its handle is pinned",
    { skip: process.platform !== "win32" },
    async (t) => {
        const backend = new WindowsProcesses();
        const shell = backend.shell();
        const task = {
            pid: 0,
            marker: "exit-at-pin",
            files: join(root, "exit-at-pin"),
            startedAt: Date.now(),
        };
        const launch = childProcess.spawn;
        const hook = t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
            if (args[0] === shell) {
                // A real Git Bash reports its real Windows PID, waits for the challenge, then exits normally.
                return launch(
                    shell,
                    ["-p", "-c", 'read -r p < /proc/$$/winpid; echo "$p"; IFS= read -r _'],
                    args[2],
                );
            }

            return launch(...args);
        });

        syncBuiltinESMExports();

        try {
            await assert.rejects(
                backend.spawn("", root, process.env, task),
                /process identity could not be verified/,
            );
            assert.equal(existsSync(`${task.files}.pids`), false);
            assert.equal(await backend.members(task, true), undefined);
        } finally {
            hook.mock.restore();
            syncBuiltinESMExports();
            backend.close();
        }
    },
);

const waitForFile = (name: string) =>
    `for ((n=0; n<1200; n++)); do [ -f '${name}' ] && break; sleep 0.1; done`;

async function offline(run: () => Promise<void>): Promise<void> {
    await app.close();

    try {
        await run();
    } finally {
        app = await openApp(model, dataDir);
        quick();
    }
}

windowsTest(
    "Windows records natural completion during downtime before authorizing a resume",
    async () => {
        const id = await newSession(app);
        const item = await app.background.start(id, {
            requestedBy: owner(app).id,
            command: `${waitForFile("offline-release")}; exit 7`,
            notify: false,
        });
        const file = join(app.backgroundFolder(id)!, `${item.id}.pids`);
        const hasReceipt = () => /^empty [a-f0-9]{32}\n/m.test(readFileSync(file, "utf8"));

        assert.equal(hasReceipt(), false);
        await offline(async () => {
            writeFileSync(join(item.cwd, "offline-release"), "");
            await until(hasReceipt, "the disconnected helper to record zero members", 30_000);
        });

        await until(
            async () => (await one(id)).status === "exited",
            "the recovered watch to finish",
            30_000,
        );
        assert.equal((await one(id)).code, 7);
        assert.equal(await app.background.aliveNow(id, item), false);

        const next = await app.background.start(id, {
            requestedBy: owner(app).id,
            jobId: item.jobId!,
            expectedAttempt: item.id,
            command: "echo after-downtime",
            notify: false,
        });

        assert.notEqual(next.id, item.id);
        assert.equal(next.jobId, item.jobId);
        await until(
            async () => (await app.background.read(id, next.id))?.text === "after-downtime\n",
            "resume after downtime",
            30_000,
        );
    },
);

windowsTest(
    "Windows keeps a covered descendant created after shutdown until it exits",
    async () => {
        const id = await newSession(app);
        const item = await app.background.start(id, {
            requestedBy: owner(app).id,
            command: `${waitForFile("create-offline-child")}; ( ${waitForFile("end-offline-child")} ) >/dev/null 2>&1 & exit 5`,
            notify: false,
        });
        const prefix = join(app.backgroundFolder(id)!, item.id);
        const hasReceipt = () =>
            /^empty [a-f0-9]{32}\n/m.test(readFileSync(`${prefix}.pids`, "utf8"));

        try {
            await offline(async () => {
                writeFileSync(join(item.cwd, "create-offline-child"), "");
                await until(
                    () => existsSync(`${prefix}.exit`) && !running(item.pid),
                    "the original launcher to end offline",
                    30_000,
                );
                assert.equal(hasReceipt(), false);
            });

            assert.equal(
                await app.background.aliveNow(id, item),
                true,
                "the original job still identifies the child",
            );
            assert.equal((await one(id)).status, "running");
            await offline(async () => {
                writeFileSync(join(item.cwd, "end-offline-child"), "");
                await until(
                    hasReceipt,
                    "the original monitor to observe the last descendant ending",
                    30_000,
                );
            });

            await until(
                async () => (await one(id)).status === "exited",
                "the recovered watch to finish",
                30_000,
            );
            assert.equal((await one(id)).code, 5);
            assert.equal(await app.background.aliveNow(id, item), false);
        } finally {
            writeFileSync(join(item.cwd, "end-offline-child"), "");
        }
    },
);

test(
    "Windows recovery replaces a failed monitor while its covered job is openable",
    { skip: process.platform !== "win32" },
    async (t) => {
        const first = new WindowsProcesses();
        const second = new WindowsProcesses();
        const task = {
            pid: 0,
            marker: `${root}#takeover`,
            files: join(root, "takeover"),
            startedAt: Date.now(),
        };
        const release = join(root, "release-takeover");
        let helper: ChildProcess | undefined;
        const launch = childProcess.spawn;
        const hook = t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
            const child = launch(...args);

            if (args[0].endsWith("powershell.exe")) {
                helper = child;
            }

            return child;
        });

        syncBuiltinESMExports();

        try {
            const started = await first.spawn(
                waitForFile("release-takeover"),
                root,
                process.env,
                task,
            );

            assert.ok(helper, "this backend started its own helper");
            const exited = once(helper, "exit");

            assert.ok(helper.kill());
            await exited;
            const members = await second.members(
                { ...task, pid: started.pid, startTicks: started.start },
                true,
            );

            assert.ok(members?.includes(started.pid));
            second.close();
            writeFileSync(release, "");
            await until(
                () => /^empty [a-f0-9]{32}\n/m.test(readFileSync(`${task.files}.pids`, "utf8")),
                "the replacement monitor to record completion after EOF",
                30_000,
            );
        } finally {
            hook.mock.restore();
            syncBuiltinESMExports();
            writeFileSync(release, "");
            first.close();
            second.close();
        }
    },
);

processTest("a restarted server finds a task's processes, and its stop ends them", async () => {
    const id = await newSession(app);
    const item = await app.background.start(id, {
        requestedBy: owner(app).id,
        command: `${child("restart.pid")} > /dev/null 2>&1 & while [ ! -f release ]; do sleep 0.1; done; ${child("after.pid")} > /dev/null 2>&1 & echo released`,
        notify: false,
    });
    const kept = await pidIn(item, "restart.pid");

    // A look or two finds the child before the server goes.
    await wait(1000);
    await app.close();
    assert.equal(running(kept), true, "the task outlives the server");
    app = await openApp(model, dataDir);
    quick();
    await wait(1000);

    // A child it starts after the restart, once its shell is gone, is found too (Windows: by its job).
    writeFileSync(join(item.cwd, "release"), "");
    const later = await pidIn(item, "after.pid");

    await wait(1500);
    assert.equal((await one(id)).status, "running", "its children keep it running");
    assert.equal(await app.background.aliveNow(id, await one(id)), true);
    await app.background.stop(id, item.id);
    await until(
        () => !running(kept) && !running(later),
        "the children to be ended after the restart",
        15_000,
    );

    if (process.platform === "win32") {
        await until(
            async () => (await app.background.aliveNow(id, item)) === false,
            "the covered Windows job to be empty",
            15_000,
        );
        await app.close();
        app = await openApp(model, dataDir);
        quick();
        assert.equal(await app.background.aliveNow(id, item), false);

        const next = await app.background.start(id, {
            requestedBy: owner(app).id,
            jobId: item.jobId!,
            expectedAttempt: item.id,
            command: "echo resumed",
            notify: false,
        });

        assert.notEqual(next.id, item.id);
        assert.equal(next.jobId, item.jobId);
        await until(
            async () => (await app.background.read(id, next.id))?.text === "resumed\n",
            "the replacement command to run",
            30_000,
        );
    }
});

test("a restarted Windows watch refreshes receipts while it holds the job open", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-refresh-"));

    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const task = { marker: "recovered", files: join(dir, "attempt"), pid: 0, startedAt: 0 };
    const file = `${task.files}.pids`;
    const key = createHash("sha256").update(task.marker).digest("hex").slice(0, 32);
    let job = "members";
    let table = "list";
    const helper = {
        ask: async (line: string) => {
            if (line === "list") {
                return table;
            }

            if (line.startsWith(`members ${key}`)) {
                return job;
            }

            assert.equal(line, `drop ${key}`);

            return "ok";
        },
        failed: undefined,
        holds: () => false,
        close: () => {},
    };
    const processes = new WindowsProcesses(helper);
    const poll = () => processes.members(task, true);

    assert.equal(await poll(), undefined, "the first receipt read fails");
    assert.equal(helper.holds(), true, "the new helper now holds the named job");
    table = "list 88,1,111";
    writeFileSync(file, `88 111 extra\nempty other-attempt\nempty ${key}`);
    assert.equal(
        await poll(),
        undefined,
        "ignore a malformed identity, a wrong key, and a torn line",
    );

    const ledger = `job ${key}\n77 123\nempty ${key}\n`;

    writeFileSync(file, ledger);
    table = "list 77,1,123";
    assert.deepEqual(
        await poll(),
        [77],
        "a restored live identity takes priority over the receipt",
    );
    table = "list";
    job = "members 91,456";
    assert.equal(await poll(), undefined, "the receipt conflicts with a nonempty job");
    assert.equal(helper.holds(), true);
    job = "members";
    assert.deepEqual(await poll(), [], "stable completion does not require the job to disappear");
    assert.equal(helper.holds(), false);
    assert.equal(readFileSync(file, "utf8"), ledger, "use the existing completion receipt");
});
