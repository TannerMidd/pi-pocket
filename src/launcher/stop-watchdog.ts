/** After the close attempt, process.exit can still block in libuv waiting for a filesystem call. */
export const POST_STOP_KILL_MS = 3_000;

export function createStopWatchdog(forceStop: () => boolean) {
    let timer: NodeJS.Timeout | undefined;
    let intended: number | undefined;
    let forced = false;

    return {
        noteStopping(code: number) {
            if (intended !== undefined) {
                return;
            }

            intended = code;
            timer = setTimeout(() => {
                forced = forceStop();
            }, POST_STOP_KILL_MS);
            timer.unref();
        },
        resolveExit(code: number | null, signal: NodeJS.Signals | null) {
            clearTimeout(timer);
            // Windows can report TerminateProcess's exit code (1), with no signal.
            const hardKill =
                signal === "SIGKILL" ||
                (process.platform === "win32" && signal === null && code === 1);

            return forced && intended !== undefined && hardKill
                ? { code: intended, signal: null }
                : { code, signal };
        },
    };
}
