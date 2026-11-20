import type { Context } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
    type BinaryReader,
    err,
    type ExecutionEnv,
    FileError,
    LineScanner,
    ok,
} from "@earendil-works/pi-durable/env";
import { RunnerEnv } from "./runners.ts";

/** Give the stock read tool one immutable view of a small runner file. No other tool uses this environment. */
export function withRunnerRead<T extends ToolRegistration>(tool: T): T {
    return {
        ...tool,
        execute(args, api, context) {
            const base = api.env;

            if (!(base instanceof RunnerEnv) || !base.link.supportsReadSnapshot) {
                return tool.execute(args, api, context);
            }

            const env = snapshotEnv(base);

            return tool.execute(
                args,
                new Proxy(api, {
                    get(target, property) {
                        return property === "env" ? env : Reflect.get(target, property, target);
                    },
                }),
                context,
            );
        },
    };
}

function snapshotEnv(base: RunnerEnv): ExecutionEnv {
    let probed = false;
    let snapshot: Awaited<ReturnType<RunnerEnv["readSnapshot"]>>;

    const exists: ExecutionEnv["exists"] = async (path, context) => {
        if (!probed) {
            probed = true;
            snapshot = await base.readSnapshot(path, context);

            if (snapshot !== undefined) {
                return cancelled(path, context) ?? ok(true);
            }
        }

        return base.exists(path, context);
    };

    const openBinaryReader: ExecutionEnv["openBinaryReader"] = async (path, options, context) => {
        const captured = snapshot;

        snapshot = undefined;

        if (captured?.info.path !== path || options !== undefined) {
            return base.openBinaryReader(path, options, context);
        }

        const { info, bytes } = captured;
        const reader: BinaryReader = {
            info: async (context) => cancelled(path, context) ?? ok(info),
            read: async (offset, length, context) =>
                cancelled(path, context) ?? ok(bytes.subarray(offset, offset + length)),
            scanLines: async ({ startLine, endLine }, context) => {
                const error = cancelled(path, context);

                if (error !== undefined) {
                    return error;
                }

                const scanner = new LineScanner(startLine, endLine);

                scanner.push(bytes);

                return ok(scanner.finish());
            },
            close: async () => {},
        };

        return cancelled(path, context) ?? ok(reader);
    };

    return new Proxy(base, {
        get(target, property) {
            if (property === "exists") {
                return exists;
            }

            if (property === "openBinaryReader") {
                return openBinaryReader;
            }

            const value = Reflect.get(target, property, target) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

function cancelled(path: string, context: Context) {
    return context.abortSignal?.aborted
        ? err<never, FileError>(new FileError("aborted", "The operation was aborted", path))
        : undefined;
}
