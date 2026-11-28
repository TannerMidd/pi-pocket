# Execution environments for workspaces

A workspace provider lets a module run a session in an address such as `ssh://host/path`. A workspace address has a scheme of 2 characters or more, then `://`: `C:\work` and `D:` stay local paths. Pi Pocket stores the provider's canonical address in the session. It passes that address to the provider's `env` method for execution. It does not use the local machine when a provider is missing.

The interface is experimental since 0.28.0. It can change in a minor release. A module must check that `host.registerWorkspaceProvider` exists when it supports older servers.

```ts
const remove = host.registerWorkspaceProvider("ssh", {
    env(cwd) {
        return makeExecutionEnv(cwd);
    },
    async resolveCwd(cwd, signal) {
        signal?.throwIfAborted();
        return canonicalRemoteAddress(cwd, signal);
    },
});

web.onDispose(remove);
```

The provider must keep the `ssh` scheme in the canonical address. The resolver can receive an abort signal. It should stop work when that signal aborts. In 0.28, session creation and settings do not pass one yet. The `env` method must return promptly. It can defer network work until execution.

Use `request.createSession({ cwd })` from an owner-only route to start a session. Only the owner can start a session on a workspace address, or move one there: Pi Pocket refuses a guest in session creation, in a session's settings, in a linked session's folder (given or taken from its source), and in a fork or a message sent again from a remote session. A guest can still steer a remote session that the owner shares. The provider remains responsible for validating the remote host and path. Pi Pocket blocks its local file and Git actions for non-local workspace addresses: Files, Changes, branches, uploads, background tasks, artifact files, the design system and design exports, file paths in the browser, and pull request watches. Worktrees are not supported for remote workspaces. The system prompt leaves out this machine's AGENTS.md files and skills: the provider's module adds the remote project's context.

When a provider is missing or unloaded, Pi Pocket refuses execution. A module that registers the same scheme replaces the active provider. Its disposer removes only that registration, so an earlier provider can resume.

## Isolated sandbox workspaces

Since 0.31.0 (experimental), a provider can set `isolated: true` to mark its scheme as an untrusted sandbox boundary (for example `gondolin://`). Core then enforces isolation regardless of which extensions are enabled:

- Only `ExecutionEnv` tools (`read`, `write`, `edit`, `bash`) and pure Pocket tools (`ask`, `ui`, `tool_search`, `subagent`, `codemode`, `schedule`, `goal`, `plan`, inline `artifact`, and session-scoped `memory`) may run. The host browser, host MCP tools, project/global memory writes, and arbitrary host tools are blocked.
- Host `commandEnv` variables are never injected into the workspace's `ExecutionEnv` (output secret redaction still runs).
- Sessions cannot be moved into or out of an isolated workspace, and isolated sessions cannot start or message non-isolated linked sessions.
- If a workspace URI's provider is disabled or unloaded, core treats it as isolated and fails closed until the provider returns.
- Implement `disposeWorkspace?(cwd)` to stop or clean up workspace resources when no active session remains on `cwd`.
