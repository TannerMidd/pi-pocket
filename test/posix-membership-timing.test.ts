import { cleanUp, context, newSession, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { BackgroundDoc } from "../src/server/docs.ts";
import { PosixProcesses, taskProcesses } from "../src/server/processes.ts";

const task = { pid: 101, startTicks: 11, files: "", startedAt: 1, marker: "synthetic" };
const child = { pid: 102, start: 12, pgid: task.pid, state: "S" };
const replacement = { ...child, pid: task.pid, start: 99 };

after(cleanUp);

function scenario(t: TestContext, boot?: string) {
    const state = {
        probe: (): string | undefined => undefined,
        list: (_fresh: boolean): (typeof child)[] => [],
        leader: (): typeof child | undefined => undefined,
    };
    const calls: string[] = [];

    t.mock.method(process, "kill", (pid: number, signal: string | number) => {
        calls.push(`${signal}:${pid}`);

        if (signal === 0) {
            const code = state.probe();

            if (code !== undefined) {
                throw Object.assign(new Error(code), { code });
            }
        }

        return true;
    });
    const backend = new PosixProcesses({
        coarse: false,
        boot,
        unsupported: () => undefined,
        begin() {},
        stat: () => state.leader(),
        list: (fresh) => {
            calls.push(`list:${fresh}`);

            return state.list(fresh);
        },
        marked: (pid) => pid === child.pid,
        fill: async () => false,
        forget() {},
        known: () => true,
    });

    return { backend, calls, state };
}

test("an empty scan while the group still exists is not proof of absence or permission to signal", async (t) => {
    const { backend, calls, state } = scenario(t);

    assert.equal(await backend.members(task), undefined);
    assert.deepEqual(calls, ["0:-101", "list:false", "list:true", "0:-101"]);
    await backend.signal(task, "SIGKILL");
    assert.ok(!calls.some((call) => call.startsWith("SIGKILL:")));
    state.list = () => [child];
    assert.deepEqual(await backend.members(task, true), [child.pid]);
});

test("only a missing group after enumeration confirms an empty scan", async (t) => {
    const { backend, calls, state } = scenario(t);

    for (const [code, expected] of [
        ["EPERM", undefined],
        ["EIO", undefined],
        ["ESRCH", []],
    ] as const) {
        calls.length = 0;
        state.probe = () => (calls.includes("list:true") ? code : undefined);
        assert.deepEqual(await backend.members(task, true), expected);
        assert.deepEqual(calls, ["0:-101", "list:true", "0:-101"]);
    }

    state.probe = () => "EIO";
    assert.equal(await backend.members(task, true), undefined);
});

test("a reused leader that exits during enumeration never authorizes a group signal", async (t) => {
    const { backend, calls, state } = scenario(t);

    state.leader = () => replacement;
    state.list = () => [child];
    assert.equal(await backend.members(task, true), undefined);
    await backend.signal(task, "SIGTERM");
    assert.deepEqual(
        calls.filter((call) => call.startsWith("SIGTERM:")),
        ["SIGTERM:102"],
    );

    state.leader = () => undefined;
    calls.length = 0;
    assert.deepEqual(await backend.members(task, true), [child.pid]);
    await backend.signal(task, "SIGTERM");
    assert.deepEqual(
        calls.filter((call) => call.startsWith("SIGTERM:")),
        ["SIGTERM:102"],
        "a marked child does not authorize a group signal",
    );
});

test(
    "rollback with an empty scan or a reused group keeps its guarded stop handle",
    { skip: process.platform !== "linux" },
    async (t) => {
        const app = await openApp(scriptedModel());

        t.after(() => app.close());
        const id = await newSession(app);
        const requestedBy = owner(app).id;
        const { backend, calls, state } = scenario(t, taskProcesses().boot);
        const proto = PosixProcesses.prototype;

        t.mock.method(proto, "spawn", async () => ({ pid: task.pid, start: task.startTicks }));
        t.mock.method(proto, "members", backend.members.bind(backend));
        t.mock.method(proto, "signal", backend.signal.bind(backend));
        t.mock.method(proto, "left", backend.left.bind(backend));
        app.background.sizes.keepEnded = 0;

        app.background.beforeRecord = async () => {
            throw new Error("simulated record failure");
        };

        await assert.rejects(
            app.background.start(id, { requestedBy, command: "true", notify: false }),
            /simulated record failure/,
        );
        const stored = async () =>
            Object.values((await app.harness.snapshot(BackgroundDoc, id, context))!.items)[0];
        const row = await stored();

        assert.ok(row);
        assert.equal(row.pid, task.pid);
        assert.equal(row.launchFailed, true);
        assert.equal(row.processAlive, undefined);
        state.leader = () => replacement;
        state.list = () => [replacement];
        await app.background.sweep();
        assert.equal((await stored())?.id, row.id);
        assert.equal(
            (await app.background.stopJob(id, row.jobId!, row.id, requestedBy)).processAlive,
            undefined,
        );
        assert.equal((await stored())?.id, row.id);
        assert.ok(
            !calls.some((call) => call.startsWith("SIG")),
            "neither rollback nor the guarded stop sends a signal",
        );
        await assert.rejects(
            app.background.start(id, {
                requestedBy,
                command: "true",
                jobId: row.jobId!,
                expectedAttempt: row.id,
            }),
            { status: 409 },
        );
    },
);
