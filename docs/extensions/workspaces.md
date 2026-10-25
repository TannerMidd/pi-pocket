# Execution environments for workspaces

A workspace provider lets a module run a session in an address such as `ssh://host/path`. Pi Pocket stores the provider's canonical address in the session. It passes that address to the provider's `env` method for execution. It does not use the local machine when a provider is missing.

The interface is experimental since 0.23.0. It can change in a minor release. A module must check that `host.registerWorkspaceProvider` exists when it supports older servers.

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

The provider must keep the `ssh` scheme in the canonical address. The resolver receives an abort signal. It should stop work when that signal aborts. The `env` method must return promptly. It can defer network work until execution.

Use `request.createSession({ cwd })` from an owner-only route to start a session. The route rechecks owner access after resolution and refuses a disconnected request. The provider remains responsible for validating the remote host and path. Pi Pocket blocks its local file and Git actions for non-local workspace addresses. Worktrees are not supported for remote workspaces.

When a provider is missing or unloaded, Pi Pocket refuses execution. A module that registers the same scheme replaces the active provider. Its disposer removes only that registration, so an earlier provider can resume.
