import assert from "node:assert/strict";
import { test } from "node:test";
import { createStopWatchdog, POST_STOP_KILL_MS } from "../src/launcher/stop-watchdog.ts";

test("a stopping child gets the full grace period, and a normal exit or crash cancels the timer", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    for (const [code, signal] of [
        [75, null],
        [1, null],
        [null, "SIGABRT"],
        [null, "SIGKILL"],
    ] as const) {
        const watchdog = createStopWatchdog(() => assert.fail("no escalation expected"));

        t.mock.timers.tick(POST_STOP_KILL_MS * 2);
        watchdog.noteStopping(75);
        t.mock.timers.tick(POST_STOP_KILL_MS - 1);
        assert.deepEqual(watchdog.resolveExit(code, signal), { code, signal });
        t.mock.timers.tick(POST_STOP_KILL_MS * 2);
    }
});

test("only this watchdog's successful hard stop can substitute the announced exit code", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    for (const intended of [0, 75, 78]) {
        for (const sent of [true, false]) {
            for (const [code, signal, hardKill] of [
                [null, "SIGKILL", true],
                [1, null, process.platform === "win32"],
                [null, "SIGABRT", false],
                [0, null, false],
            ] as const) {
                const kill = t.mock.fn(() => sent);
                const watchdog = createStopWatchdog(kill);

                watchdog.noteStopping(intended);
                t.mock.timers.tick(POST_STOP_KILL_MS - 1);
                watchdog.noteStopping(23);
                assert.equal(kill.mock.callCount(), 0);
                t.mock.timers.tick(1);
                assert.equal(kill.mock.callCount(), 1);
                assert.deepEqual(
                    watchdog.resolveExit(code, signal),
                    sent && hardKill ? { code: intended, signal: null } : { code, signal },
                );
            }
        }
    }
});
