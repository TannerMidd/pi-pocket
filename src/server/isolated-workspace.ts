/**
 * Core security policy for isolated sandbox workspaces (`WorkspaceProvider.isolated === true`, or any workspace URI
 * whose provider is currently unregistered). Kept in core so it cannot be turned off or bypassed by an extension.
 */

/** Tools that execute exclusively inside the workspace's `ExecutionEnv`, never on the host. */
export const ISOLATED_ENV_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "bash"]);

/**
 * Pure Pi Pocket tools that do not execute host commands or read/write host files outside Pi Durable's own storage.
 * `codemode` scripts re-enter the same `beforeTool` gate for every inner tool call.
 * `artifact` and `memory` carry additional argument checks below.
 */
export const ISOLATED_SAFE_TOOLS: ReadonlySet<string> = new Set([
    "ask",
    "ui",
    "tool_search",
    "subagent",
    "codemode",
    "schedule",
    "goal",
    "plan",
    "artifact",
    "memory",
]);

function hasArtifactPath(args: Record<string, unknown>): boolean {
    if (args.path !== undefined) {
        return true;
    }

    if (Array.isArray(args.assets)) {
        for (const asset of args.assets) {
            if (
                asset !== null &&
                typeof asset === "object" &&
                (asset as Record<string, unknown>).path !== undefined
            ) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Returns a human-readable block reason when `toolName` (with `args`) is not permitted in an isolated workspace, or
 * `undefined` when it is allowed.
 */
export function isolatedToolBlock(toolName: string, args: unknown): string | undefined {
    if (ISOLATED_ENV_TOOLS.has(toolName)) {
        return undefined;
    }

    const record =
        args !== null && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};

    if (toolName === "memory") {
        if (record.action === "list") {
            return undefined;
        }

        if (record.action === "add" && record.scope === "session") {
            return undefined;
        }

        return "Isolated sandbox workspaces can only list memory or save session-scoped lessons, not change project or global memory.";
    }

    if (toolName === "artifact") {
        if (hasArtifactPath(record)) {
            return "Isolated sandbox workspaces cannot create artifacts from host file paths. Pass inline content instead.";
        }

        return undefined;
    }

    if (ISOLATED_SAFE_TOOLS.has(toolName)) {
        return undefined;
    }

    return `Tool "${toolName}" is blocked in an isolated sandbox workspace.`;
}
