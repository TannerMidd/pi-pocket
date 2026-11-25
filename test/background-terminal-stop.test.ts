import { cleanUp, context, newSession, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundDoc } from "../src/server/docs.ts";
import {
    type Signal,
    taskProcesses,
    type TaskProcesses,
    type TaskRef,
} from "../src/server/processes.ts";

test("a guarded terminal stop retains the attempt until its group and descendants are gone", async (t) => {
    const app = await openApp(scriptedModel());

    t.after(async () => {
        await app.close();
        cleanUp();
    });
    const id = await newSession(app);
    const requestedBy = owner(app).id;
    const row = {
        id: "aaaaaa",
        jobId: "synthetic-job",
        pid: 234567,
        startTicks: 71,
        startedAt: 1,
        endedAt: 2,
        command: "synthetic",
        cwd: app.cwdOf(id),
        requestedBy,
        status: "stopped" as const,
        processAlive: true,
        processObservedAt: 2,
        notify: false,
        read: 0,
        taskId: 1 as never,
    };
    const processes = Object.getPrototypeOf(taskProcesses()) as TaskProcesses;
    let group: number[] | undefined = [row.pid];
    let escaped: number[] = [];
    const signals: string[] = [];

    t.mock.method(processes, "unsupported", async () => undefined);
    t.mock.method(processes, "members", async (task: TaskRef, fresh?: boolean) => {
        assert.equal(fresh, true);

        return task.pid === row.pid ? group : [];
    });
    t.mock.method(processes, "left", async (task: TaskRef) =>
        task.marker.endsWith(`/${row.id}`) ? escaped : [],
    );
    t.mock.method(processes, "signal", async (task: TaskRef, name: Signal) => {
        assert.equal(task.pid, row.pid);
        assert.equal(task.startTicks, row.startTicks);
        assert.ok(task.marker.endsWith(`/${row.id}`));
        signals.push(name);
    });
    app.background.timing.grace = 0;
    app.background.beforeSpawn = async () => assert.fail("must not launch a replacement");
    app.background.sizes.keepEnded = 1;
    app.managedStorage.folder("background", String(id), true);
    await app.harness.commit(async (tx) => {
        const items = (await tx.doc(BackgroundDoc, id)).items;

        items[row.id] = row;
        items.bbbbbb = { ...row, id: "bbbbbb", pid: 0, left: [345679], endedAt: 3 };
        items.cccccc = { ...row, id: "cccccc", pid: 0, processAlive: false, endedAt: 4 };
    }, context);
    const stored = async () => (await app.harness.snapshot(BackgroundDoc, id, context))!.items;
    const stop = () => app.background.stopJob(id, row.jobId, row.id, requestedBy);
    const resume = () =>
        app.background.start(id, {
            jobId: row.jobId,
            expectedAttempt: row.id,
            requestedBy,
            command: "synthetic",
        });

    assert.equal((await stop()).processAlive, true);
    assert.deepEqual(signals.splice(0), ["SIGTERM", "SIGKILL"]);
    await app.background.sweep();
    assert.ok((await stored())[row.id], "a surviving group needs its stop handle");
    assert.equal((await stored()).bbbbbb, undefined, "a stale daemon handle can be pruned");
    await assert.rejects(resume, { status: 409 });

    group = undefined;
    const unknown = await stop();

    assert.equal(unknown.processAlive, undefined);
    assert.ok(unknown.processObservedAt! > row.processObservedAt);
    assert.deepEqual(signals, [], "uncertainty is not permission to signal");
    await app.harness.commit(async (tx) => {
        (await tx.doc(BackgroundDoc, id)).items.dddddd = {
            ...row,
            id: "dddddd",
            pid: 0,
            left: [345680],
            endedAt: 3,
        };
    }, context);
    await app.background.sweep();
    assert.equal((await stored()).dddddd, undefined);
    assert.ok((await stored())[row.id]);
    await assert.rejects(resume, { status: 409 });

    group = [];
    escaped = [345678];
    const survivor = await stop();

    assert.deepEqual(signals.splice(0), ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(survivor.left, escaped);
    assert.equal(survivor.processAlive, true);
    await assert.rejects(resume, { status: 409 });
    escaped = [];
    await app.background.sweep();
    assert.equal((await stored())[row.id], undefined, "both scans now confirm absence");
});
