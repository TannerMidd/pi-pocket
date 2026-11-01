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

Use `request.createSession({ cwd })` from an owner-only route to start a session. Only the owner can start a session on a workspace address, or move one there: Pi Pocket refuses a guest in session creation, in a session's settings, and in a linked session's folder. The provider remains responsible for validating the remote host and path. Pi Pocket blocks its local file and Git actions for non-local workspace addresses. Worktrees are not supported for remote workspaces. The system prompt leaves out this machine's AGENTS.md files and skills: the provider's module adds the remote project's context.

When a provider is missing or unloaded, Pi Pocket refuses execution. A module that registers the same scheme replaces the active provider. Its disposer removes only that registration, so an earlier provider can resume.
