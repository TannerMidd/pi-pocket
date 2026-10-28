# SSH Sessions

Author: Pierre Marrec. MIT license.

Create an independent Pi Pocket conversation whose `read`, `write`, `edit`, `bash`,
subagents, and shell commands use an SSH host. Pocket keeps the history, provider
credentials, and model requests on its own server. No Pi or Node installation is
needed on the remote host.

## Install

This extension needs the workspace-provider API from the accompanying Pocket
change. It refuses to load on a server that does not support that API. Restart
Pocket from its menu after installing that change; do not restart during a tool
call.

Copy `ssh-sessions.ts`, the `ssh-sessions/` browser folder, and `_ssh-sessions/`
into the Pocket data directory's `extensions/` folder. Do not copy the source
`_pocket.d.ts`: Pocket supplies its own type definitions there. Install the pinned
runtime in `extensions/_ssh-sessions/`:

```sh
npm ci --ignore-scripts --no-audit --no-fund
```

Open **Menu → Extensions → ssh-sessions** to inspect and enable it. The full
server source is `ssh-sessions.ts` plus `_ssh-sessions/{config,runtime}.ts`.
The browser source is `ssh-sessions/{index.js,style.css}`. Setup does not write to
`~/.ssh/config`, private keys, sign-ins, or the server configuration.

## Use

1. Open **SSH** in the rail or **Remote SSH session** in the menu.
2. Select a literal `Host` alias from the server account's `~/.ssh/config`.
   `Include` files are inventoried too; OpenSSH evaluates actual connection
   options, keys, users, ports, and jump hosts.
3. On first use, choose **Check SSH key**, compare the fingerprint through an
   independent channel, and explicitly accept the key. A displayed fingerprint
   alone does not authenticate a host. Changed keys are rejected, never replaced
   automatically. Trusted keys live in `<data>/ssh-sessions/known_hosts`.
4. Enter an absolute remote directory, `~`, or `~/project`, and create the session.
   The directory must already exist. Choose a model normally if Pocket has no
   default model.

The connection uses the system SSH client and its local agent. Batch mode refuses
password prompts; unlock the existing key or configure the SSH agent outside
Pocket. Agent/X11/port forwarding, configured remote/local commands, shared SSH
control sockets, and locale forwarding are disabled by `pi-env`.

The first connection deploys the packaged, SHA-256-verified `pi-env` helper into
`~/.pi/mobile/tools/` on the remote host. It verifies the binary on subsequent
connections. The SSH account grants its normal filesystem and shell permissions;
this is not a sandbox. The host's shell startup files still run.

Workspace addresses, such as `ssh://work-host/home/user`, remain in the ordinary
session state, so reopening a session or restarting Pocket retains the target.
The tools receive real remote paths, not these addresses. Disabling or removing
the provider makes remote execution fail; it never falls back to local execution.

## Version 1 boundaries

- Remote hosts: Linux, macOS, and other POSIX systems supported by `pi-env`.
  Windows is explicitly rejected by this extension.
- Git commands are supported through remote `bash`, including status, commits,
  branches, and ordinary repository operations. Only the native local Git panel
  is unavailable; this is not a ban on Git on the remote host.
- Native Files/Git panels, file uploads, and Pocket-managed worktrees are not
  remote-enabled. Use the remote coding tools instead. Browser, MCP services,
  artifacts, and model integrations remain on the Pocket server. For an artifact
  backed by a remote file, read it first and publish `content`, not `path`.
- Global Pocket instructions and remote ancestor `AGENTS.md` / `CLAUDE.md` files
  form the project context. Remote skills are not loaded automatically. Large
  instruction files fail explicitly rather than silently falling back to local
  context.
- Ordinary API providers work without a remote sign-in. Provider extensions that
  launch a CLI in the conversation's cwd need URI-workspace support themselves.
- SSH aliases with wildcard or negated patterns are not selectable. Add a literal
  alias if needed. `Match exec` and `ProxyCommand` can execute local commands,
  as with ordinary SSH; the SSH configuration must be trusted.
- There is no interactive terminal or automatic forwarding of a remote web server
  in this version. Remote shell tools still run normally.

## Checks

```sh
node --test extensions/ssh-sessions/ssh-sessions.test.ts
node --test test/remote-workspaces.test.ts
npm run check
```

The extension test uses temporary fixtures and the packaged daemon on the local
machine. It does not connect to real SSH hosts or trust their keys. Core tests use
an isolated data folder and a scripted model, with no provider calls. A first real
SSH connection still requires an independently verified fingerprint.
