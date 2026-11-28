import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { BackgroundDoc } from "../src/server/docs.ts";
import {
    BACKGROUND_MARKER,
    LinuxTable,
    PosixProcesses,
    taskProcesses,
    type TaskRef,
} from "../src/server/processes.ts";

after(cleanUp);

const mount = "23 19 0:21 / /proc rw - proc proc rw";

function fixture(t: TestContext, boot = "synthetic-boot") {
    const proc = mkdtempSync(join(root, "proc-"));

    const write = (name: string, text: string) => {
        const path = join(proc, name);

        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
    };

    const task = { pid: 101, startTicks: 11, boot, files: "", startedAt: 0, marker: "synthetic" };

    const member = (
        pid: number,
        state = "Z",
        group = 101,
        session = 101,
        start = 12,
        threads = 1,
    ) => {
        const fields = Array<string>(22).fill("0");

        fields[0] = state;
        fields[2] = String(group);
        fields[3] = String(session);
        fields[17] = String(threads);
        fields[19] = String(start);
        write(`${pid}/stat`, `${pid} (fixture) ${fields.join(" ")}\n`);
    };

    write("self/mountinfo", mount);
    write("self/status", `NSpid:\t${process.pid}\n`);
    write("sys/kernel/random/boot_id", boot);
    write("stat", "processes 25\n");
    let clock = 0;

    const next = () => {
        clock += 2000;
    };

    const table = new LinuxTable(proc, () => clock);
    const backend = new PosixProcesses(table);
    const calls = t.mock.method(process, "kill", () => true);

    const members = () => {
        next();

        return backend.members(task, true);
    };

    return { write, member, task, table, backend, members, calls, next };
}

test("a positive group probe distinguishes zombies, executable members, and missing evidence", async (t) => {
    const { write, member, task, backend, members, calls } = fixture(t);

    assert.equal(await members(), undefined, "no observed member");
    member(102);
    assert.deepEqual(await members(), [], "unreaped child without its launcher");
    assert.equal(await backend.members({ ...task, startTicks: undefined }, true), undefined);
    assert.equal(await backend.members({ ...task, boot: undefined }, true), undefined);
    member(103, "X");
    assert.deepEqual(await members(), []);
    member(103, "S");
    assert.equal(await members(), undefined, "unmarked executable child");
    write("103/environ", `${BACKGROUND_MARKER}=${task.marker}\0`);
    assert.deepEqual(await members(), [103], "the zombie is not a live member");
    member(103, "Z", 101, 101, 13, 2);
    assert.equal(await members(), undefined, "the zombie thread leader has siblings");
    member(103, "S", 103);
    assert.equal(await members(), undefined, "an executable process could join from this session");
    member(103);
    member(101, "Z", 101, 101, 99);
    assert.equal(await members(), undefined, "a reused launcher contradicts the recorded identity");
    await backend.killSpawned(task);
    assert.ok(calls.mock.calls.every(({ arguments: [, signal] }) => signal === 0));
    member(101, "Z", 101, 101, task.startTicks);
    assert.deepEqual(await members(), [], "verified zombie launcher");
    write("222/stat", "truncated");
    assert.equal(await members(), undefined, "a partial stat could hide a live member");
    member(222, "S", 222, 222);
    write("223/other", "");
    assert.equal(await members(), undefined, "an unreadable stat is not absence");
});

test("a failed census delays another scan; absence is never cached", (t) => {
    const { write, member, table, task, next } = fixture(t);
    const stats = t.mock.method(table, "stat");

    member(102);
    assert.equal(table.zombiesOnly(task), true);
    write("222/stat", "incomplete");
    assert.equal(table.zombiesOnly(task), false, "never reuse a successful observation");
    member(222, "S", 222, 222);
    const reads = stats.mock.callCount();

    for (let i = 0; i < 8; i++) {
        assert.equal(table.zombiesOnly(task), false);
    }

    assert.equal(stats.mock.callCount(), reads, "no census during the rejection cooldown");
    next();
    assert.equal(table.zombiesOnly(task), true, "fresh evidence after the cooldown");
});

test("a count or a promptly reaped group does not need the zombie census", async (t) => {
    const { member, task, backend, table, members, calls } = fixture(t);
    const census = t.mock.method(table, "zombiesOnly");

    member(102);
    assert.equal(backend.aliveSync(task), false);
    calls.mock.mockImplementationOnce(() => {
        throw Object.assign(new Error(), { code: "ESRCH" });
    }, calls.mock.callCount() + 1);
    assert.deepEqual(await members(), []);
    assert.equal(census.mock.callCount(), 0);
});

test("zombie evidence requires full visibility and a stable fork count", async (t) => {
    const { write, member, table, members } = fixture(t);

    member(102);
    write("self/mountinfo", `${mount},hidepid=invisible`);
    assert.equal(await members(), undefined);
    write("self/mountinfo", `${mount}\n24 23 0:22 / /proc/202 rw - tmpfs tmpfs rw`);
    assert.equal(await members(), undefined);
    write("self/mountinfo", mount);
    write("self/status", `NSpid:\t9999\t${process.pid}\n`);
    assert.equal(await members(), undefined);
    write("self/status", `NSpid:\t${process.pid}\n`);
    write("stat", "unavailable");
    assert.equal(await members(), undefined);
    write("stat", "processes 25\n");
    const stat = table.stat.bind(table);
    let seen = 0;

    t.mock.method(table, "stat", (pid: number) => {
        if (pid === 102 && ++seen === 2) {
            // This child starts after readdir, before the confirming scan reads its zombie witness.
            member(103, "S");
            write("stat", "processes 26\n");
        }

        return stat(pid);
    });
    assert.equal(await members(), undefined, "turnover can hide a newly born member");
    assert.ok(seen >= 2);
    member(103);
    assert.deepEqual(await members(), [], "a later complete observation succeeds");
    t.mock.method(table, "stat", (pid: number) => {
        if (pid === 102 && ++seen === 2) {
            write("self/mountinfo", `${mount},hidepid=invisible`);
        }

        return stat(pid);
    });
    seen = 0;
    assert.equal(await members(), undefined, "visibility changed during the confirming scan");
});

test(
    "a zombie-only command completes, but its tracked daemon or an unknown scan blocks replacement",
    { skip: process.platform !== "linux" },
    async (t) => {
        const app = await openApp(scriptedModel());

        t.after(() => app.close());
        app.background.timing = { look: 40, starting: 2000, grace: 100, sweep: 60_000 };
        const id = await newSession(app);
        const { write, member, backend, task, next } = fixture(t, taskProcesses().boot);
        const proto = PosixProcesses.prototype;
        let firstMarker: string | undefined;
        const spawn = t.mock.method(
            proto,
            "spawn",
            async (_script: string, _cwd: string, env: NodeJS.ProcessEnv, ref: TaskRef) => {
                writeFileSync(env.PI_POCKET_BACKGROUND_EXIT!, "7 0\n");

                if (ref.marker !== firstMarker && firstMarker !== undefined) {
                    member(302, "Z", 301, 301, 92);

                    return { pid: 301, start: 91 };
                }

                firstMarker = ref.marker;
                member(102);
                member(201, "S", 201, 201);
                write("201/environ", `${BACKGROUND_MARKER}=${ref.marker}\0`);

                return { pid: task.pid, start: task.startTicks };
            },
        );

        t.mock.method(proto, "members", backend.members.bind(backend));
        t.mock.method(proto, "left", backend.left.bind(backend));
        const request = {
            command: "synthetic",
            requestedBy: owner(app).id,
            notify: false,
            key: "launch",
        };
        const first = await app.background.start(id, request);
        const row = async () =>
            (await app.harness.snapshot(BackgroundDoc, id, context))?.items[first.id];

        await until(
            async () => (await row())?.status === "exited",
            "the wrapper exit receipt and zombie-only group",
        );
        assert.equal((await row())?.code, 7);
        assert.equal((await row())?.processAlive, true);
        assert.deepEqual((await row())?.left, [201]);
        const resume = {
            ...request,
            key: "resume",
            expectedAttempt: first.id,
            jobId: first.jobId!,
        };

        await assert.rejects(app.background.start(id, resume), { status: 409 });
        member(201, "Z", 201, 201, 12, 2);
        await assert.rejects(app.background.start(id, resume), { status: 409 });
        member(201, "Z", 201, 201);
        write("stat", "unavailable");
        next();
        app.background.sizes.keepEnded = 0;
        await app.background.sweep();
        assert.equal(
            (await app.background.start(id, request)).id,
            first.id,
            "retained replay uses the receipt",
        );
        await assert.rejects(app.background.start(id, resume), { status: 409 });
        assert.equal(spawn.mock.callCount(), 1);
        write("stat", "processes 25\n");
        next();
        const second = await app.background.start(id, resume);

        assert.equal(second.resumedFrom, first.id);
        assert.notEqual(second.id, first.id);
        await assert.rejects(app.background.start(id, { ...resume, key: "stale" }), {
            status: 409,
        });
        await app.background.sweep();
        await assert.rejects(app.background.start(id, request), { status: 410 });
        assert.equal(spawn.mock.callCount(), 2, "only the two authorized launches ran");
    },
);
