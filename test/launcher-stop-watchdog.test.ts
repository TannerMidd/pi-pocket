import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import {
    createStopWatchdog,
    POST_STOP_KILL_MS,
    RESTART_SIGNAL_KILL_MS,
    type StopWatchdogReason,
} from "../src/launcher/stop-watchdog.ts";
import { stopMeansRollBack } from "../src/server/update-state.ts";

test("a server that finishes exiting on its own keeps its exit code and is never killed", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const kills: StopWatchdogReason[] = [];
    const plain = createStopWatchdog({ kill: (reason) => kills.push(reason) });

    assert.deepEqual(plain.resolveExit(0, null), { code: 0, signal: null });
    assert.deepEqual(plain.resolveExit(78, null), { code: 78, signal: null });

    for (const code of [0, 75]) {
        const watchdog = createStopWatchdog({ kill: (reason) => kills.push(reason) });

        watchdog.noteStopping(code);
        assert.deepEqual(watchdog.resolveExit(code, null), { code, signal: null });
        t.mock.timers.tick(POST_STOP_KILL_MS * 2);
    }

    assert.deepEqual(kills, []);
});

test("a server that hangs after closing is force-stopped and keeps exit code 75 or 0 on Unix and Windows", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    // On Unix `SIGKILL` reports `(null, "SIGKILL")`; on Windows `TerminateProcess` can report a
    // non-null exit code (often 1) with or without a signal.
    const forcedExits: [number | null, NodeJS.Signals | null][] = [
        [null, "SIGKILL"],
        [1, "SIGKILL"],
        [1, null],
    ];

    for (const intended of [75, 0]) {
        for (const [rawCode, rawSignal] of forcedExits) {
            const kills: StopWatchdogReason[] = [];
            const watchdog = createStopWatchdog({ kill: (reason) => kills.push(reason) });

            watchdog.noteStopping(intended);
            t.mock.timers.tick(POST_STOP_KILL_MS - 1);
            assert.deepEqual(kills, []);

            t.mock.timers.tick(1);
            assert.deepEqual(kills, ["post-stop"]);
            assert.deepEqual(watchdog.resolveExit(rawCode, rawSignal), {
                code: intended,
                signal: null,
            });
        }
    }
});

test("a server that ignores a restart signal is force-stopped and still counts as a restart", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    for (const [rawCode, rawSignal] of [
        [null, "SIGKILL"],
        [1, null],
    ] as const) {
        const kills: StopWatchdogReason[] = [];
        const watchdog = createStopWatchdog({ kill: (reason) => kills.push(reason) });

        watchdog.noteRestartSignal(75);
        // A second restart request while already waiting does not reset the timer.
        t.mock.timers.tick(RESTART_SIGNAL_KILL_MS - 10);
        watchdog.noteRestartSignal(75);
        t.mock.timers.tick(9);
        assert.deepEqual(kills, []);

        t.mock.timers.tick(1);
        assert.deepEqual(kills, ["restart-signal"]);
        assert.deepEqual(watchdog.resolveExit(rawCode, rawSignal), { code: 75, signal: null });
    }
});

test("a stopping notice replaces the longer restart timer with the shorter post-stop timer", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const kills: StopWatchdogReason[] = [];
    const watchdog = createStopWatchdog({ kill: (reason) => kills.push(reason) });

    watchdog.noteRestartSignal(75);
    watchdog.noteStopping(75);
    t.mock.timers.tick(POST_STOP_KILL_MS);
    assert.deepEqual(kills, ["post-stop"]);
    assert.deepEqual(watchdog.resolveExit(null, "SIGKILL"), { code: 75, signal: null });
});

test("a real crash before the restart timer fires stays a crash", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    for (const [rawCode, rawSignal] of [
        [null, "SIGABRT"],
        [1, null],
    ] as const) {
        const kills: StopWatchdogReason[] = [];
        const watchdog = createStopWatchdog({ kill: (reason) => kills.push(reason) });

        watchdog.noteRestartSignal(75);
        t.mock.timers.tick(RESTART_SIGNAL_KILL_MS - 1);
        assert.deepEqual(watchdog.resolveExit(rawCode, rawSignal), {
            code: rawCode,
            signal: rawSignal,
        });
        t.mock.timers.tick(RESTART_SIGNAL_KILL_MS);
        assert.deepEqual(kills, []);
    }
});

test("a server that fails before ready, sends stopping with code 1, and hangs still triggers rollback", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    for (const [rawCode, rawSignal] of [
        [null, "SIGKILL"],
        [1, null],
    ] as const) {
        const kills: StopWatchdogReason[] = [];
        const watchdog = createStopWatchdog({ kill: (reason) => kills.push(reason) });

        watchdog.noteStopping(1);
        t.mock.timers.tick(POST_STOP_KILL_MS);
        assert.deepEqual(kills, ["post-stop"]);
        const resolved = watchdog.resolveExit(rawCode, rawSignal);

        assert.deepEqual(resolved, { code: 1, signal: null });
        assert.equal(stopMeansRollBack(false, resolved.code), true);
    }
});

test("dispose cancels pending post-stop and restart timers", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const kills: StopWatchdogReason[] = [];
    const postStop = createStopWatchdog({ kill: (reason) => kills.push(reason) });

    postStop.noteStopping(75);
    postStop.dispose();

    const restart = createStopWatchdog({ kill: (reason) => kills.push(reason) });

    restart.noteRestartSignal(75);
    restart.dispose();

    t.mock.timers.tick(RESTART_SIGNAL_KILL_MS * 2);
    assert.deepEqual(kills, []);
});

test("a real child that sends stopping over IPC and refuses to exit is force-stopped quickly", async () => {
    const proc = spawn(
        process.execPath,
        ["-e", 'process.send({ type: "stopping", code: 75 }); setInterval(() => {}, 60_000);'],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const kills: StopWatchdogReason[] = [];
    const watchdog = createStopWatchdog({
        postStopMs: 80,
        kill(reason) {
            kills.push(reason);
            proc.kill("SIGKILL");
        },
    });
    const exited = once(proc, "exit");
    let stoppingAt = 0;

    proc.on("message", (message: { type?: string; code?: number }) => {
        if (message?.type === "stopping" && typeof message.code === "number") {
            stoppingAt = Date.now();
            watchdog.noteStopping(message.code);
        }
    });

    const safety = setTimeout(() => proc.kill("SIGKILL"), 15_000);

    try {
        const [rawCode, rawSignal] = (await exited) as [number | null, NodeJS.Signals | null];
        const elapsedMs = Date.now() - stoppingAt;

        assert.ok(stoppingAt > 0, "expected the child to send a stopping notice");
        assert.deepEqual(kills, ["post-stop"]);
        assert.deepEqual(watchdog.resolveExit(rawCode, rawSignal), { code: 75, signal: null });
        assert.ok(
            elapsedMs < 5_000,
            `expected force-stop under 5s after stopping notice, took ${elapsedMs}ms`,
        );
    } finally {
        clearTimeout(safety);
        watchdog.dispose();
    }
});
