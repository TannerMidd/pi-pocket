/**
 * What a sandboxed tree may call (`sandbox.ts`): the allow list of the tool gate, and the environment of a tree that
 * cannot run anything. An allow list, so a new tool is a host tool, and blocked, until someone lists it here. Salvaged
 * from the closed #415 and changed as the design asks (section 4.6): `memory` writes session scope only, `artifact`
 * names no path anywhere, and a routed tool with no route fails closed.
 */
import { ExecutionError, FileError, type ExecutionEnv, err } from "@earendil-works/pi-durable/env";

/** Tools that run through the execution environment of the conversation, so they run in the VM, or fail with a reason. */
export const ROUTED_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "bash"]);

/**
 * Tools that touch only Pi Pocket's own state, or whose own calls pass this gate again (codemode's, a subagent's). They
 * may run in a sandboxed tree. `memory` and `artifact` are listed too, and have their own argument rules (`gate`).
 */
export const INERT_TOOLS: ReadonlySet<string> = new Set([
    "ask",
    "ui",
    "tool_search",
    "schedule",
    "subagent",
    "codemode",
    "memory",
    "artifact",
]);

/**
 * Tools that have a route into the VM, and the part of the provider that serves it. With no route the tool is blocked:
 * it never falls back to the host.
 */
export const ROUTED_BY_PROVIDER: Readonly<Record<string, "jobs" | "browser">> = {
    background: "jobs",
    browser: "browser",
};

/** The tool that starts and messages linked sessions. It stays blocked until its rule exists (the last PR). */
export const TEAM_TOOL = "team";

/** The words a call stopped by the gate gets. */
export function hostToolBlocked(tool: string): string {
    return `${tool} runs on the host, outside the sandbox, so this sandboxed session cannot use it.`;
}

/**
 * Whether a tool's arguments name a path anywhere: a `path` field at any depth (an artifact's own, an asset's) that is
 * not empty. A tool that reads a path reads it on the host.
 */
export function namesPath(args: unknown, depth = 0): boolean {
    if (depth > 8 || typeof args !== "object" || args === null) {
        return false;
    }

    for (const [key, value] of Object.entries(args)) {
        if (key === "path" && value !== undefined && value !== null && value !== "") {
            return true;
        }

        if (namesPath(value, depth + 1)) {
            return true;
        }
    }

    return false;
}

/** What an `ExecutionEnv` can be asked to do with files (everything else it has is `exec`, `cleanup`, `id`, and `cwd`). */
export const FILE_CALLS: ReadonlySet<string> = new Set([
    "absolutePath",
    "joinPath",
    "readTextFile",
    "openTextLineReader",
    "readTextLines",
    "readBinaryFile",
    "openBinaryReader",
    "writeFile",
    "appendFile",
    "truncateFile",
    "flushFile",
    "renameFile",
    "fileInfo",
    "listDir",
    "openDirReader",
    "watch",
    "canonicalPath",
    "exists",
    "createDir",
    "remove",
    "createTempDir",
    "createTempFile",
]);

/** The environment of a sandboxed tree that cannot run anything: every call fails at once, and says why. */
export function failedEnv(cwd: string, message: string): ExecutionEnv {
    const file = () => Promise.resolve(err(new FileError("permission_denied", message)));
    const handlers: Record<string, unknown> = {
        id: "pocket-sandbox-unavailable",
        cwd,
        listFiles: undefined,
        cleanup: () => Promise.resolve(),
        exec: () => Promise.resolve(err(new ExecutionError("spawn_error", message))),
    };

    return new Proxy({} as ExecutionEnv, {
        // Only the calls of an environment: a `then` here would make the environment look like a promise that never ends.
        get: (_target, property) =>
            typeof property !== "string"
                ? undefined
                : Object.hasOwn(handlers, property)
                  ? handlers[property]
                  : FILE_CALLS.has(property)
                    ? file
                    : undefined,
    });
}
