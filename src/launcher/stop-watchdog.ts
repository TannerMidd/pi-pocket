/**
 * Watches a server child while it stops, so a `process.exit()` stuck in libuv's threadpool cleanup
 * does not leave the launcher waiting forever after the server has already closed.
 */

/** How long a server may take to finish exiting after it has closed and told the launcher `stopping`. */
export const POST_STOP_KILL_MS = 3_000;

/**
 * How long a server asked to restart (`SIGUSR2`) may take to exit before the launcher stops it
 * anyway: `STOP_LIMIT_MS` (10 seconds) plus room for closing and the IPC notice.
 */
export const RESTART_SIGNAL_KILL_MS = 15_000;

export type StopWatchdogReason = "post-stop" | "restart-signal";

export type StopWatchdog = {
    /** The server has closed its HTTP server and database and is about to exit with `code`. */
    noteStopping(code: number): void;
    /** The launcher asked the server to restart (for example with `SIGUSR2`). */
    noteRestartSignal(restartCode: number): void;
    /**
     * The exit code and signal the launcher should act on. When this watchdog had to stop the
     * child, the code the server meant to leave with (or the restart code) replaces the forced exit.
     */
    resolveExit(
        code: number | null,
        signal: NodeJS.Signals | null,
    ): { code: number | null; signal: NodeJS.Signals | null };
    /** Cancel any pending timer. */
    dispose(): void;
};

export function createStopWatchdog(options: {
    postStopMs?: number;
    restartSignalMs?: number;
    kill: (reason: StopWatchdogReason) => void;
}): StopWatchdog {
    const postStopMs = options.postStopMs ?? POST_STOP_KILL_MS;
    const restartSignalMs = options.restartSignalMs ?? RESTART_SIGNAL_KILL_MS;
    let stoppingCode: number | undefined;
    let forcedRestartCode: number | undefined;
    let killed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clear = () => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };

    const arm = (delayMs: number, reason: StopWatchdogReason, onFire?: () => void) => {
        clear();
        timer = setTimeout(() => {
            timer = undefined;
            killed = true;
            onFire?.();
            options.kill(reason);
        }, delayMs);
        timer.unref?.();
    };

    return {
        noteStopping(code) {
            stoppingCode = code;

            if (killed) {
                return;
            }

            arm(postStopMs, "post-stop");
        },
        noteRestartSignal(restartCode) {
            if (stoppingCode !== undefined || timer !== undefined || killed) {
                return;
            }

            arm(restartSignalMs, "restart-signal", () => {
                forcedRestartCode = restartCode;
            });
        },
        resolveExit(code, signal) {
            clear();

            // On Unix `SIGKILL` yields `code === null`; on Windows `TerminateProcess` can report a
            // non-null exit code alongside or instead of a signal. Once the server has finished
            // closing and told us the code it meant to leave with, honor it on a signal or our kill.
            if (stoppingCode !== undefined && (code === null || killed)) {
                return { code: stoppingCode, signal: null };
            }

            if (stoppingCode === undefined && killed && forcedRestartCode !== undefined) {
                return { code: forcedRestartCode, signal: null };
            }

            return { code, signal };
        },
        dispose: clear,
    };
}
