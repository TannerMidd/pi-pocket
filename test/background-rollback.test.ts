import {
    cleanUp,
    context,
    hostFolder,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { BackgroundDoc } from "../src/server/docs.ts";
import { BACKGROUND_MARKER, taskProcesses } from "../src/server/processes.ts";

after(cleanUp);

const skip = process.platform !== "linux";

function stat(pid: number) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");

        return { state: fields[0], group: Number(fields[2]), start: Number(fields[19]) };
    } catch {
        return undefined;
    }
}

test("rollback retains an unmarked child after the group leader exits", { skip }, async (t) => {
    const app = await openApp(scriptedModel());

    t.after(() => app.close());
    app.background.sizes.keepEnded = 0;
    const id = await newSession(app);
    const requestedBy = owner(app).id;
    const leaderFile = join(work, "leader");
    const childFile = join(work, "unmarked");
    const releaseFile = join(work, "release");
    const command = `echo "$PPID" > leader; env -u ${BACKGROUND_MARKER} node -e 'const fs = require("node:fs"); fs.writeFileSync("unmarked", String(process.pid)); setInterval(() => { if (fs.existsSync("release")) process.exit(); }, 30); setTimeout(() => process.exit(), 30000)' </dev/null >/dev/null 2>&1 &`;
    let child = 0;
    let leader = 0;

    app.background.beforeRecord = async () => {
        await until(
            () =>
                existsSync(leaderFile) &&
                existsSync(childFile) &&
                Number(readFileSync(childFile, "utf8")) > 0,
            "the unmarked child to start",
        );
        child = Number(readFileSync(childFile, "utf8"));
        leader = Number(readFileSync(leaderFile, "utf8"));
        await until(() => stat(leader) === undefined, "the launcher to exit");
        assert.equal(stat(child)?.group, leader);
        assert.ok(
            !readFileSync(`/proc/${child}/environ`, "utf8")
                .split("\0")
                .some((entry) => entry.startsWith(`${BACKGROUND_MARKER}=`)),
        );

        throw new Error("synthetic record failure");
    };

    try {
        await assert.rejects(
            app.background.start(id, { command, requestedBy, notify: false }),
            /synthetic record failure/,
        );
        app.background.beforeRecord = undefined;
        await app.background.sweep();
        const [attempt] = Object.values(
            (await app.harness.snapshot(BackgroundDoc, id, context))!.items,
        );

        assert.ok(
            attempt,
            "an inconclusive initial rollback keeps its stop handle, even under pruning",
        );
        assert.equal(attempt.pid, leader);
        assert.ok(attempt.startTicks);
        assert.equal(attempt.neverSpawned, undefined);
        assert.equal(attempt.launchFailed, true);
        assert.ok(attempt.processObservedAt);
        assert.equal(attempt.processAlive, undefined);
        assert.equal(await app.background.aliveNow(id, attempt), undefined);
        await assert.rejects(
            app.background.start(id, {
                command: "true",
                requestedBy,
                jobId: attempt.jobId!,
                expectedAttempt: attempt.id,
                notify: false,
            }),
            { status: 409 },
        );
        assert.equal(stat(child)?.group, leader);
    } finally {
        writeFileSync(releaseFile, "");

        if (child > 0) {
            await until(
                () => [undefined, "Z", "X"].includes(stat(child)?.state),
                "the isolated child to exit",
            );
        }
    }
});

test("rollback signals the verified launcher group, not a reused group", { skip }, async (t) => {
    const backend = taskProcesses();
    const task = { pid: 0, marker: `${root}#rollback`, files: "", startedAt: Date.now() };
    const env = { ...process.env };

    delete env[BACKGROUND_MARKER];
    const decoy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        detached: true,
        env,
        stdio: "ignore",
    });
    const exited = once(decoy, "exit");
    const pid = decoy.pid!;
    const recorder = t.mock.method(process, "kill");

    try {
        const start = stat(pid)!.start;
        const reused = { ...task, pid, startTicks: start - 1 };

        await backend.killSpawned(reused, pid);
        assert.ok(!recorder.mock.calls.some(({ arguments: [, signal] }) => signal === "SIGKILL"));
        assert.equal(stat(pid)?.start, start);

        const launched = await backend.spawn("exec sleep 30", hostFolder(root), env, task);
        const original = { ...task, pid: launched.pid, startTicks: launched.start };

        assert.ok(original.startTicks);
        await backend.killSpawned(original, launched.pid);
        assert.ok(
            recorder.mock.calls.some(
                ({ arguments: [target, signal] }) =>
                    target === -launched.pid && signal === "SIGKILL",
            ),
        );
        await until(() => stat(launched.pid) === undefined, "the verified launcher to exit");
    } finally {
        decoy.kill();
        await exited;
        backend.close();
    }
});
