/**
 * The quiet limit of commands: a command that prints nothing for so long is stopped, with its process group, and its
 * call ends as timed out with what it printed. A command that keeps printing (a long build) runs on. A call that gives
 * its own `timeout` has that limit instead. The owner sets the limit (`extensions/background.ts`); 0 turns it off.
 */
import { withCancel } from "@earendil-works/chord/context";
import { ExecutionError, type ExecutionEnv } from "@earendil-works/pi-durable/env";

/** The default quiet limit: long enough for a slow step of a build, short enough to free a stuck helper. */
export const DEFAULT_QUIET_MINUTES = 15;

/**
 * The default quiet limit of a background task: longer, as a watcher or a test run can be quiet a while. A server that
 * may be quiet for hours starts with no limit (`quietMinutes: 0`).
 */
export const DEFAULT_TASK_QUIET_MINUTES = 60;

/** What a command stopped for its quiet limit says, after what it printed. */
export function quietMessage(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    const span = minutes >= 1 ? `${minutes} min` : `${Math.round(ms / 1000)} s`;

    return `Command timed out: it printed nothing for ${span}, so Pi Pocket stopped it and the processes it started. The output above is all it printed. For a long job that prints little, pass timeout (seconds), or use the background tool.`;
}

/** `base`, with the quiet limit `quietMs()` (read at each command; 0 or less: none) on every command it runs. */
export function withQuietLimit(base: ExecutionEnv, quietMs: () => number): ExecutionEnv {
    const exec: ExecutionEnv["exec"] = async (command, options, context) => {
        const limit = quietMs();

        if (options?.timeout !== undefined || !(limit > 0)) {
            return base.exec(command, options, context);
        }

        const { context: inner, cancel } = withCancel(context);
        let last = Date.now();
        let quiet = false;
        const look = setInterval(
            () => {
                if (Date.now() - last >= limit) {
                    quiet = true;
                    cancel(new Error("quiet"));
                }
            },
            Math.max(50, Math.min(limit / 4, 15_000)),
        );

        look.unref?.();

        try {
            const result = await base.exec(
                command,
                {
                    ...options,
                    onOutput: (text, context, info) => {
                        last = Date.now();
                        options?.onOutput?.(text, context, info);
                    },
                },
                inner,
            );

            if (!quiet || result.ok || context.abortSignal?.aborted === true) {
                return result;
            }

            const error = new ExecutionError("unknown", quietMessage(limit));

            if (result.error.spillPath !== undefined) {
                error.spillPath = result.error.spillPath;
            }

            return { ok: false, error } as typeof result;
        } finally {
            clearInterval(look);
        }
    };

    return new Proxy(base, {
        get(target, property) {
            if (property === "exec") {
                return exec;
            }

            const value = Reflect.get(target, property, target) as unknown;

            return typeof value === "function"
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value;
        },
    });
}
