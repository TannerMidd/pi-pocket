import {
    type App,
    cleanUp,
    context,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { BackgroundDoc } from "../src/server/docs.ts";
import { taskProcesses, type TaskProcesses, type TaskRef } from "../src/server/processes.ts";

const skip = !existsSync("/proc/self/stat") && "requires /proc";
const model = scriptedModel();
const data = join(root, "managed-jobs");
const sessions = new Set<ConversationId>();
let app: App;

async function open(): Promise<void> {
    app = await openApp(model, data);
    app.background.timing = { look: 50, grace: 400, starting: 2000, sweep: 60_000 };
}

async function session(): Promise<ConversationId> {
    const id = await newSession(app);

    sessions.add(id);

    return id;
}

before(open);

after(async () => {
    try {
        for (const id of sessions) {
            for (const item of await app.background.list(id)) {
                if (item.status === "running" || item.status === "starting") {
                    await app.background.stop(id, item.id);
                }
            }
        }
    } finally {
        await app?.close();
        cleanUp();
    }
});

async function assertNoNotification(id: ConversationId): Promise<void> {
    const graph = await app.harness.watchTaskGraph(context);

    try {
        await until(
            () => !Object.values(graph.value.tasks).some((task) => task.conversationId === id),
            "the job watches to finish",
        );
        assert.deepEqual(await modelTexts(app, id), []);
        assert.equal(model.state.callCount, 0, "no model invocation");
    } finally {
        await graph.stop();
    }
}

test(
    "a quiet restart of a timed-out job keeps its own command, process and output",
    { skip },
    async () => {
        const id = await session();
        const cwd = app.cwdOf(id);
        const requestedBy = owner(app).id;
        const common = { requestedBy, notify: false };
        const firstRequest = {
            ...common,
            command: "cat sample-a.txt; sleep 30",
            quietMinutes: 0.01,
            key: "first-launch",
        };

        writeFileSync(join(cwd, "sample-a.txt"), "sample from A\n");
        const a = await app.background.start(id, firstRequest);
        const row = async (attempt: string) =>
            (await app.harness.snapshot(BackgroundDoc, id, context))?.items[attempt];

        await until(async () => (await row(a.id))?.status === "stopped", "A to time out");
        assert.match((await row(a.id))?.why ?? "", /quiet limit/);
        assert.equal((await app.background.output(id, a.id))?.text, "sample from A\n");

        const resume = {
            ...common,
            jobId: a.jobId!,
            expectedAttempt: a.id,
            key: "second-launch",
            command:
                "echo launch >> starts-b.txt; for n in {1..900}; do [ -f release-b ] && break; sleep 0.1; done; test -f release-b && echo 'B finished'",
            quietMinutes: 0,
        };
        const guest = app.config.addUser("another driver", "guest", [String(id)]).user;

        try {
            await assert.rejects(app.background.start(id, { ...resume, requestedBy: guest.id }), {
                status: 403,
            });
            await assert.rejects(
                app.background.start(id, { ...firstRequest, requestedBy: guest.id }),
                { status: 403 },
            );
        } finally {
            app.config.removeUser(guest.id);
        }

        const [b, duplicate] = await Promise.all([
            app.background.start(id, resume),
            app.background.start(id, resume),
        ]);

        assert.equal(duplicate.id, b.id);
        await assert.rejects(app.background.stopJob(id, resume.jobId, b.id, guest.id), {
            status: 403,
        });
        await assert.rejects(
            app.background.stopJob(id, resume.jobId, b.id, requestedBy, AbortSignal.abort()),
            { name: "AbortError" },
        );

        assert.notEqual(b.id, a.id);
        assert.equal(b.jobId, a.jobId);
        assert.equal(b.attempt, 2);
        assert.notEqual(b.taskId, a.taskId);
        assert.equal((await row(a.id))?.superseded, true);
        // A late write to the old log must not make the quiet replacement look active.
        appendFileSync(join(data, "background", String(id), `${a.id}.log.aaaaaa`), "late A line\n");
        await until(() => existsSync(join(cwd, "starts-b.txt")), "B to reach its wait");

        await until(
            async () => (await row(b.id))?.processAlive === true,
            "B to be observed before restart",
        );
        await app.close();
        const reopenedAt = Date.now();

        await open();

        assert.equal((await app.background.start(id, firstRequest)).id, a.id);
        assert.equal((await app.background.start(id, resume)).id, b.id);
        await assert.rejects(app.background.start(id, { ...resume, key: "another-resume" }), {
            status: 409,
        });
        await assert.rejects(
            app.background.stopJob(id, resume.jobId, resume.expectedAttempt, requestedBy),
            {
                status: 409,
            },
        );
        await until(async () => {
            const current = (await app.background.jobs(id)).jobs[0];

            return current?.processAlive === true && (current.processObservedAt ?? 0) > reopenedAt;
        }, "a new observation of B after the server reopened");
        const { jobs, recentAdverse } = await app.background.jobs(id);

        assert.deepEqual(
            jobs.map((job) => job.attemptId),
            [b.id],
        );
        assert.ok((jobs[0]!.processObservedAt ?? 0) >= b.startedAt);
        assert.equal(jobs[0]!.outcome, undefined);
        assert.equal(jobs[0]!.outputBytes ?? 0, 0);
        assert.equal(jobs[0]!.lastOutputAt, undefined);
        assert.deepEqual(
            recentAdverse.map((job) => [job.attemptId, job.outcome]),
            [[a.id, "timeout"]],
        );
        assert.ok((recentAdverse[0]!.lastOutputAt ?? 0) >= a.startedAt);
        assert.equal(recentAdverse[0]!.outputBytes, Buffer.byteLength("sample from A\n"));
        assert.doesNotMatch(
            JSON.stringify({ jobs, recentAdverse }),
            /sample from A|late A line|sample-a\.txt|starts-b\.txt/,
        );
        assert.equal((await row(b.id))?.status, "running");
        assert.equal((await row(b.id))?.command, resume.command);
        assert.equal((await row(b.id))?.why, undefined);
        assert.equal((await app.background.output(id, b.id))?.text, "");
        assert.equal((await app.background.output(id, a.id))?.text, "sample from A\nlate A line\n");

        writeFileSync(join(cwd, "release-b"), "");
        await until(async () => (await row(b.id))?.status === "exited", "B to finish");
        assert.equal((await row(b.id))?.code, 0);
        assert.equal((await app.background.read(id, b.id))?.text, "B finished\n");
        assert.equal(readFileSync(join(cwd, "starts-b.txt"), "utf8"), "launch\n");
        assert.equal((await row(a.id))?.status, "stopped");
        app.background.sizes.keepEnded = 1;
        const last = await app.background.start(id, { ...common, command: "true" });

        await until(
            async () => (await row(last.id))?.status === "exited",
            "older attempts to be pruned",
        );
        await app.close();
        await open();
        await assert.rejects(app.background.start(id, firstRequest), { status: 410 });
        await assert.rejects(app.background.start(id, resume), { status: 410 });
        assert.equal(readFileSync(join(cwd, "starts-b.txt"), "utf8"), "launch\n");
        await assertNoNotification(id);
    },
);

for (const cut of ["before termination", "after termination"] as const) {
    test(`recovery finishes the committed timeout: shutdown ${cut}`, { skip }, async (t) => {
        const id = await session();
        const procs = Object.getPrototypeOf(taskProcesses()) as TaskProcesses;
        const signal = procs.signal;
        let reasonAtFirstSignal: string | undefined;
        let closing: Promise<void> | undefined;

        t.mock.method(
            procs,
            "signal",
            async function (this: TaskProcesses, ...args: Parameters<TaskProcesses["signal"]>) {
                const [ref, name] = args;
                const attemptId = ref.marker.split("/").at(-1)!;

                if (name === "SIGTERM") {
                    const item = (await app.harness.snapshot(BackgroundDoc, id, context))?.items[
                        attemptId
                    ];

                    reasonAtFirstSignal =
                        item?.status === "running" && item.timedOut ? item.why : undefined;
                }

                if (cut === "after termination") {
                    await signal.apply(this, args);
                }

                if (name === (cut === "before termination" ? "SIGTERM" : "SIGKILL")) {
                    closing = app.harness.close(context);
                }
            },
        );
        const item = await app.background.start(id, {
            command: "sleep 30",
            notify: false,
            requestedBy: owner(app).id,
            quietMinutes: 0.001,
        });

        await until(() => closing !== undefined, "the injected shutdown");
        await closing;
        t.mock.restoreAll();
        await app.close();
        await open();
        assert.match(reasonAtFirstSignal ?? "", /quiet limit/);
        await until(
            async () => (await app.background.jobs(id)).recentAdverse[0]?.outcome === "timeout",
            "the committed timeout to finish",
        );
        const row = (await app.harness.snapshot(BackgroundDoc, id, context))?.items[item.id];

        assert.equal(row?.status, "stopped");
        assert.equal(row.why, reasonAtFirstSignal);
        assert.equal(row.processAlive, false);
        assert.equal(await app.background.aliveNow(id, row), false);
        await assertNoNotification(id);
    });
}

test("a confirmed exit at the quiet deadline keeps its exit code", { skip }, async (t) => {
    const id = await session();

    app.background.beforeRecord = async () => {
        const [reserved] = await app.background.list(id);
        const path = join(data, "background", String(id), `${reserved!.id}.exit`);

        await until(
            () => existsSync(path) && readFileSync(path, "utf8").trim() === "7 0",
            "the wrapper to record its exit",
        );
        t.mock.method(Object.getPrototypeOf(taskProcesses()), "members", async () => []);
    };

    try {
        const item = await app.background.start(id, {
            command: "exit 7",
            notify: false,
            requestedBy: owner(app).id,
            quietMinutes: Number.EPSILON,
        });

        await until(
            async () => (await app.background.list(id))[0]?.endedAt !== undefined,
            "the finished attempt",
        );
        const row = (await app.harness.snapshot(BackgroundDoc, id, context))?.items[item.id];

        assert.equal(row?.status, "exited");
        assert.equal(row.code, 7);
        assert.equal(row.timedOut, undefined);
    } finally {
        app.background.beforeRecord = undefined;
    }
});

test(
    "a failed initial launch remains visible without putting its command in the lead's history",
    { skip },
    async () => {
        const id = await session();
        const request = {
            requestedBy: owner(app).id,
            command: "echo sample-initial-command",
            notify: false,
            key: "launch-error",
        };

        app.background.beforeSpawn = async () => {
            throw new Error("sample startup error");
        };

        try {
            await assert.rejects(app.background.start(id, request), /sample startup error/);
        } finally {
            app.background.beforeSpawn = undefined;
        }

        assert.deepEqual(await app.background.list(id), []);
        const { recentAdverse } = await app.background.jobs(id);

        assert.deepEqual(
            recentAdverse.map((attempt) => attempt.outcome),
            ["failure"],
        );
        assert.doesNotMatch(JSON.stringify(recentAdverse), /sample-/);
        await assert.rejects(app.background.start(id, request), { status: 410 });
        await assertNoNotification(id);
    },
);

test(
    "only a proven pre-spawn failure permits a retry without process evidence",
    { skip },
    async (t) => {
        const id = await session();
        const requestedBy = owner(app).id;
        const first = {
            id: "aaaaaa",
            jobId: "synthetic-job",
            command: "synthetic first attempt",
            cwd: app.cwdOf(id),
            pid: 0,
            status: "exited" as const,
            code: 1,
            startedAt: 1,
            endedAt: 2,
            taskId: 1 as TaskId,
            requestedBy,
            notify: false,
            read: 0,
        };
        const processes = Object.getPrototypeOf(taskProcesses()) as TaskProcesses;
        const members = t.mock.method(processes, "members", async (ref: TaskRef) =>
            ref.marker.endsWith(`/${first.id}`) ? [] : undefined,
        );
        const signal = t.mock.method(processes, "signal", async () => {});
        let evidencePath: string | undefined;
        const spawn = t.mock.method(
            processes,
            "spawn",
            async (_script: string, _cwd: string, _env: NodeJS.ProcessEnv, task: TaskRef) => {
                evidencePath = task.files + ".pids";
                writeFileSync(evidencePath, "synthetic partial process evidence");

                throw new Error("ambiguous adapter failure");
            },
        );

        t.mock.method(processes, "left", async () => []);
        await app.harness.commit(async (tx) => {
            (await tx.doc(BackgroundDoc, id)).items[first.id] = first;
        }, context);
        const resume = (expectedAttempt: string) =>
            app.background.start(id, {
                jobId: first.jobId,
                expectedAttempt,
                key: `replace-${expectedAttempt}`,
                command: "synthetic replacement",
                requestedBy,
                notify: false,
            });

        const env = t.mock.method(app.commandEnvs, "for", async () => {
            throw new Error("synthetic preparation failure");
        });

        await assert.rejects(resume(first.id), /synthetic preparation failure/);
        env.mock.restore();

        assert.equal(spawn.mock.callCount(), 0);
        assert.equal(signal.mock.callCount(), 0);
        await app.close();
        await open();
        const failed = await resume(first.id);

        assert.equal(failed.neverSpawned, true);
        assert.equal(failed.processAlive, false);
        assert.ok(failed.processObservedAt !== undefined);
        assert.equal(failed.launchFailed, true);
        assert.equal(failed.resumedFrom, first.id);
        assert.equal(failed.attempt, 2);
        assert.equal(spawn.mock.callCount(), 0, "replaying the failed reservation must not launch");

        // The adapter cannot prove absence for either replacement. Only the launcher's own proof permits a retry.
        await assert.rejects(resume(failed.id), /ambiguous adapter failure/);
        const uncertain = await resume(failed.id);

        assert.equal(uncertain.neverSpawned, undefined);
        assert.equal(uncertain.pid, 0);
        assert.equal(uncertain.attempt, 3);
        assert.ok(
            evidencePath && existsSync(evidencePath),
            "keep the evidence of a possible launch",
        );
        assert.ok(uncertain.processObservedAt !== undefined);
        assert.equal(uncertain.processAlive, undefined);
        await assert.rejects(resume(uncertain.id), { status: 409 });
        assert.equal(spawn.mock.callCount(), 1);
        assert.ok(
            members.mock.calls.some(({ arguments: [ref] }) =>
                ref.marker.endsWith(`/${uncertain.id}`),
            ),
        );
        const { jobs, recentAdverse } = await app.background.jobs(id);

        assert.deepEqual(
            jobs.map((job) => job.attemptId),
            [uncertain.id],
        );
        assert.deepEqual(
            new Set(recentAdverse.map((job) => job.attemptId)),
            new Set([first.id, failed.id, uncertain.id]),
        );
        assert.ok(recentAdverse.every((job) => job.outcome === "failure"));
        await assertNoNotification(id);
    },
);

test(
    "legacy rows remain independent jobs and recent failures survive successful jobs and pruning",
    { skip },
    async () => {
        const id = await session();
        const cwd = app.cwdOf(id);
        const base = app.now() - 100_000;
        const failureIds: string[] = [];
        const successIds: string[] = [];

        // Old records have only the attempt's original ID, no lineage or observation fields.
        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(BackgroundDoc, id);
            const { items } = doc;

            delete doc.nextAttemptId;

            for (let n = 1; n <= 34; n++) {
                const attemptId = n.toString(16).padStart(6, "0");
                const failed = n <= 12;

                (failed ? failureIds : successIds).push(attemptId);
                items[attemptId] = {
                    id: attemptId,
                    command: "echo sample",
                    cwd,
                    pid: 0,
                    startedAt: base + n,
                    endedAt: base + n + 1,
                    status: "exited",
                    code: failed ? 1 : 0,
                    notify: false,
                    read: 0,
                    taskId: n as TaskId,
                };
            }
        }, context);

        const view = await app.background.jobs(id);

        assert.deepEqual(
            view.jobs.map((job) => job.attemptId),
            successIds.toReversed().slice(0, 20),
        );
        assert.ok(view.jobs.every((job) => job.attempt === 1));
        assert.equal(new Set(view.jobs.map((job) => job.jobId)).size, view.jobs.length);
        assert.ok(
            view.jobs.every(
                (job) => job.processObservedAt === undefined && job.lastOutputAt === undefined,
            ),
        );
        const expectedFailures = failureIds.toReversed().slice(0, 10);

        assert.deepEqual(
            view.recentAdverse.map((job) => job.attemptId),
            expectedFailures,
        );

        const ended = await app.background.start(id, {
            command: "true",
            notify: false,
            requestedBy: owner(app).id,
        });
        const stored = () => app.harness.snapshot(BackgroundDoc, id, context);

        await until(
            async () => (await stored())?.items[ended.id]?.status === "exited",
            "ordinary retention to prune old rows",
        );
        assert.equal((await stored())?.items[failureIds[0]!], undefined);
        await app.close();
        await open();
        const afterPrune = await app.background.jobs(id);

        assert.deepEqual(
            afterPrune.recentAdverse.map((job) => job.attemptId),
            expectedFailures,
        );
        assert.ok(afterPrune.recentAdverse.every((job) => job.outcome === "failure"));
        await assertNoNotification(id);
    },
);
