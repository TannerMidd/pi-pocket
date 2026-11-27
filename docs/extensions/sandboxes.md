# Sandboxes for sessions

A module can give sessions a sandbox: the file and shell tools of a session run in an environment that the module makes (a micro-VM, a container), not on this machine. The built-in Gondolin sandbox (`extensions/gondolin.ts`) is the first user. [Sandboxes](../sandbox.md) tells what people see.

**Experimental, since 0.31.0.** It can change in a minor release, but never in a patch release ([API stability](policies/api-stability.md#experimental)). A module for an older server checks that `host.sandbox` is there.

## What core keeps, and what the module keeps

Core keeps what a module cannot keep safe ([Core or extension](policies/core-or-extension.md), C1, C2, C4):

- **The setting of each session**, in its own stored document (`pocket.sandbox`). It lasts across restarts, forks, subagents, and linked sessions: a session that a sandboxed session starts is sandboxed too.
- **Fail closed.** A sandboxed session never runs a file or shell call on this machine. With no provider registered, or when the provider's environment throws, each call fails with the reason.
- **The gate.** A `beforeTool` hook stops the tools that would run on the host. `read`, `write`, `edit`, and `bash` go through the environment, so they are the provider's. A few tools only change Pi Pocket's own state (`ask`, `ui`, `memory`, `schedule`, `tool_search`, `subagent`, `codemode`). Every other tool is a host tool, and it is stopped unless the provider's `hostTools()` says `"allow"`. `browser` is the provider's browser or nothing.
- **No host secrets.** What `host.commandEnv` adds to host commands is not added to a sandboxed session's. Values that `host.hide` hides still leave every output.
- **Who may.** `host.sandbox.set` checks that the person sees the session and may drive it, and asks the provider. A change is one step at a time for a session, and its tool calls wait while it runs: turning on stores the setting only when nothing runs on this machine, and turning off stores it only after `release` resolves.

The module keeps the sandbox itself: the VM, what it mounts, its network, its lifecycle, and the words for the people.

## Register a provider

```typescript
web.onDispose(
    host.sandbox.register({
        mayChoose: (person) => person.role === "owner",
        newSessions: () => false,
        hostTools: () => "block",
        problem: () => (ready ? undefined : "The sandbox is not set up."),
        env: (target) => makeEnvironment(target),
        release: async (conversationId) => {
            /* stop the VM and what runs in it, and wait until it is gone */
        },
        changed: (conversationId, on) => {
            /* tell the module's own screens: the setting is stored */
        },
    }),
);
```

- `env(target)` returns an `ExecutionEnv` ([Pi Durable](https://github.com/earendil-works/pi-durable)). It returns at once: start the VM when the first call needs it. A call that cannot get one returns its error result with the reason. `target` has `conversationId`, `rootId` (the session: one VM serves it and its subagents), `cwd`, and `uploadDir`. Use `rootId` to find the VM.
- `browser(target)` (optional) gives a `{ problem(), launch(flags) }`. `launch` starts a Chromium in the sandbox with Pi Pocket's flags and returns `{ input, output, stop, exited }`: the DevTools pipe (`--remote-debugging-pipe`) as streams that only the server holds. Do not open a port on this machine for it.
- `release(conversationId)` (optional) is called when a session's sandbox is about to go off. Stop the VM and what runs in it, and resolve **only when teardown has finished**: core stores `off` after it, and until then the session's folder stays confined and its tool calls wait. If it rejects, the sandbox stays on and the person sees the message. `changed(conversationId, on)` runs after the setting is stored, for the module's own bookkeeping; it cannot stop the change.
- `mayChoose(person)`, `newSessions()`, `hostTools()`, and `problem()` are read at each use. `problem()` says why a session cannot be put in the sandbox now.
- `folderProblem(cwd)` (optional) says why a folder may not be a sandboxed session's folder (it holds sign-ins or keys). Core asks when a session is put in the sandbox and for the folder of a linked session.
- `otherFolders()` (optional) says whether a linked session that a sandboxed session starts may use a folder other than its parent's. Without it, it may not.
- `host.sandbox.keepOn(conversationId, reason)`: a VM of the session may still run though the provider could not close it. The session's sandbox stays on, with `reason`, until a provider's `release` of it succeeds; with no provider, turning it off is refused. A provider that goes away calls it for each such session, after it waited for its VMs and before it unregisters.
- `host.sandbox.unsupported()` says why this machine cannot run a sandbox (today: anything but Linux), or undefined. Core refuses to turn a session's sandbox on then, and a provider reports it in its check and offers no Set up.
- `jobs(target)` (optional) gives the session's `background` tasks as `{ start, output, list, jobs, stop }`, each answering with the words Pi reads. The tasks run in the sandbox. Without it, the `background` tool is blocked in a sandboxed session; with it, the tool calls `host.sandbox.jobs(conversationId)` and never starts a process on this machine.
- The newest live registration wins. The returned function removes that registration only, in any order: one that ended never comes back.

## Set a session's sandbox

`host.sandbox.set(conversationId, { id, role }, on)` puts a session and its subagents in the sandbox, or takes them out, for `person`. Core refuses when the person cannot see or drive the session, when `mayChoose` says no, when `problem()` says the host cannot run it, when the session is on a remote workspace, and, for a guest, when the owner chose the sandbox. `host.sandbox.get(conversationId)` reads `{ on, by, at }`.

## Rules for a provider

- Give the environment **only** the folder of the session (and its uploads, read only). Give it no sign-ins, no token, no keys, and none of the server's variables.
- A path outside the mounted folder is a path in the sandbox, never on this machine.
- A file the guest may not write because the host runs programs from it (every git directory) stays out of its reach, and a writable folder that holds git's hooks or included configuration does not start.
- Never fall back to the host. A call that cannot run fails, with the reason.
- Tell people what runs where. Core stops host tools, but a provider's own words are what people read.

Gondolin's design (`docs/design/gondolin-sandbox.md` in the repository) shows one choice of each of these.
