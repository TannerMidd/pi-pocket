# Sandboxes: running a session's tools in a micro-VM

By default, Pi's commands run on the machine where Pi Pocket runs, as the user who started it. A **sandbox** is an option that moves a session's tools into a small Linux virtual machine on the same machine, made by [Gondolin](https://github.com/earendil-works/gondolin). It is off until the owner turns it on, and a session uses it only when someone chooses it for that session.

A sandbox limits what a mistake, or a prompt injection that Pi reads, can do to the rest of the machine. It is not a proof: [what it protects](#what-it-protects-and-what-it-does-not) says what it does not.

## Turn it on

1. **Menu → Extensions → Gondolin sandbox**: turn it on. The owner does this. A new profile has it off.
2. Open the module's entry in the same sheet and tap **Sandbox set up** (under **Open**), or press Ctrl+K and type `sandbox`. This works with no session open, for the owner only. The Sandbox sheet opens, with **Set up** in its **This machine** part. The sheet says what it will do before it starts:
    - It installs the package `@earendil-works/gondolin` (0.14.0) into the `gondolin` folder of Pi Pocket's data folder. Nothing global, nothing outside that folder. It uses `npm install --ignore-scripts`.
    - It downloads the guest image into the same folder: about 110 MB (325 MB on disk), and then **builds the standard image with `git`** on this machine from it (about 10 seconds, 11 MB more on disk, 336 MB in all). It needs `mke2fs`, `cpio`, and `lz4` on Linux (Docker or Podman on macOS); without them Set up says so and the sandbox works without git in the VM.
    - **Set up with a browser** also builds a second image with Chromium (and git) on this machine: about 250 MB of packages, 1.2 GB on disk, a minute or two. Pi Pocket publishes no image: the images are made here. Without it, a sandboxed session has no browser.
3. Choose a session's sandbox: **Menu → Sandbox** in the session (in **This session**, with Rename and Pin) (or the **Sandbox** item in its status line once it is on). The owner always may. It is refused, with the reason, while the session still runs work on this machine (a background task, a `!` command, or a file or shell call in the middle of a run): stop it or let it end first, because a sandbox cannot take it over. Guests who steer may only when the owner turns on **People who steer may choose the sandbox**. Viewers, and people invited to one session, never.

**New sessions start in the sandbox** is a setting too (off by default).

## What runs where

| Runs in the VM                                                                                   | Stays on this machine                                                                    |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `read`, `write`, `edit`, `bash`; `!` commands; the check of Done when                            | Files, Changes, and the file viewer (they read the shared folder, for people)            |
| Calls that `codemode` and subagents make to those tools                                          | `ask`, `ui`, `memory`, `schedule`, `tool_search`: they change only Pi Pocket's own state |
| The browser: **a Chromium inside the VM** (the image with a browser)                             | Everything else is a **host tool** and is **blocked** by default (below)                 |
| `background` tasks: their processes run in the VM ([below](#background-tasks))                   |                                                                                          |
| `team` (start, send, list): the linked session is sandboxed too ([below](#linked-sessions-team)) |                                                                                          |

**Host tools** are tools that would run on this machine, outside the VM: session tools (`session_start`, …), design tools, `watch_pr`, MCP tools, other extensions' tools, and `artifact` with a `path` (its own, or an asset's). A sandboxed session cannot use them, because they would be a way out. The owner can allow them (**Host tools in sandboxed sessions**). A tool that Pi Pocket does not know is a host tool, so a new tool is blocked until it is listed.

### Background tasks

In a sandboxed session the `background` tool (start, output, list, jobs, stop) runs its commands **in the session's VM**, never on this machine. Output is captured, a task that prints nothing for its limit is stopped, Pi gets a message when one ends, and a stop ends the process in the guest. The VM **stays up** while a task runs (no idle stop). A server that a task starts is reached by the browser in the sandbox at `localhost:<port>`; Pi Pocket opens no port on this machine for it.

What a restart does: **the VM ends with the server, so the task ends**. Pi is told "ended: the server restarted", never "resumed", and the task has to be started again. The same holds when you stop the VM from the sheet, or the module goes off. Resuming a job (`jobId`, `expectedAttempt`) is not available in a sandbox. Tasks are listed by the tool in this session only; the Running now list is for tasks on this machine.

### Linked sessions (team)

A linked session that a sandboxed session starts with `team` is **sandboxed too**, with the parent's settings, in **its own VM**, in the parent's folder. `team start` with a `cwd` outside the parent's folder is refused with the reason, unless the owner turns on **Linked sessions may use other folders** (the child is still sandboxed, and a folder with sign-ins or keys is never allowed). A sandboxed session can message (`team send`) only sandboxed linked sessions and the session that started it, because a message to a session that runs on this machine would be work there. Each linked session takes one of the **Sandboxes at once**.

The sandbox sheet (tap **Sandbox**) shows this table, the state of the VM, and the settings that apply.

## What the VM sees

- **The session's folder**, at the same path as on the host, read and write by default (**The session's folder**: read only is a choice). A file that Pi writes there is on the host at once.
- **Git works** (with the images that Set up builds): `status`, `diff`, `add`, `commit`, `branch`, `log`, `stash`, `merge`, and a single `cherry-pick` work in the folder, and the commits show on the host. The index, objects, and refs are writable. **A repository's git config and hooks are read only from the VM** (`.git/config`, `.git/hooks`, `.git/info`, `.gitmodules`, `.gitattributes`, the files that point Git at another folder (`commondir`, a linked worktree's or submodule's `gitdir`, `objects/info/alternates`), and any change to an entry named `.git`, or to a folder that holds one): Pi Pocket's Changes panel and your own git commands run on the host, and a hook or an `fsmonitor` that the VM wrote would run there. The VM reads these files; a write fails with `EACCES`. So `git init`, `git clone`, `git remote add`, and `git config` (which write `.git/config`) fail inside the sandbox: run them on the host. The guest has its own git settings (`/etc/gitconfig`): the mounted folders are trusted (`safe.directory`), and the author is "Pi (sandbox)" unless the repository's own config names one.
- **No credentials enter the VM**, so `git push`, and `git fetch` from a private repository, fail with "this sandbox has no credentials … from the host": **push from the host**.
- **Rebase, `git am`, and picks of several commits fail in the VM.** Git keeps their state in `.git/rebase-merge`, `.git/rebase-apply`, and `.git/sequencer` (also under `worktrees/<name>/` and `modules/<name>/`), and runs commands from it: `git rebase --continue` on the host runs the `exec` lines of the todo list, and a VM could fake a stopped rebase to make it run its own. So those folders are read only to the VM (it reads them, and cannot create or change them), and the VM's `git` says "Rebase from the host: ask the person to run it there." for `rebase`, `am`, and a `pull`, `cherry-pick`, or `revert` that needs them. A single `git cherry-pick`, `git merge`, `git stash`, and the rest of git work. Run a rebase on the host.
- **What git's configuration names is read only too.** Pi Pocket asks git, on the host, for its configuration when a VM starts, and holds what it names inside the folder: the `core.hooksPath` folder, files that `include.path` and `includeIf` pull in (also ones that do not exist yet), and scripts that `core.fsmonitor`, `core.sshCommand`, `core.editor`, `core.pager`, `diff`, `merge`, and `filter` drivers, credential helpers, `!` aliases, and similar keys run. The VM reads them and a write fails with `EACCES`. The list is read again at the next call, at most once a second, so a change that the owner makes while the VM runs is held from then on; what the VM wrote there before is not undone, so stop the VM after pointing git at a new hooks folder. A path that the configuration named stays held. Git's own effective value decides for a setting with one value (the last one, as `git config --get` gives it), so a global value that the repository overrides counts for nothing; every `include` and credential helper counts. Paths are followed as the kernel does (a component at a time, `..` as the parent of the place reached, a link read from the folder that holds it, at most 40 links), never by tidying the text first. A path that passes through the project by way of a link (a link outside it that leads in, `..` after a link, or `..` after a place that is not there) is refused. A path that names a file or folder inside the project must be a plain one: the folder on the way, and the folder itself, are held (the VM cannot move, remove, or relink them), and if a link lies on the way, or a hooks folder holds a link to a file of the project, or the hooks folder is the whole folder (or holds it), nothing can be held, so the VM does not start (or stops at its next call) and says so; point the setting at a plain folder inside the project (for example `.githooks`), or unset it.
- **A session on a git worktree** gets the main repository's `.git` folder too, mounted at its host path with the same protections (objects, index, refs, and the worktree's own files are writable; config, hooks, info, and the pointer files `commondir`, `gitdir`, and `alternates` are read only). Only that folder: the main repository's working files are not there. A `.git` file counts only when the repository it names points back at the session's folder, so a file in the folder cannot make the sandbox share another one.
- **The session's own uploads**, read only.
- **The skills the session uses**, read only, each at its own path (for example `~/.pi/agent/skills/<name>`, `~/.agents/skills/<name>`): Pi reads their `SKILL.md` with `read`. The list is fixed when the VM starts (**Stop** in the sheet and the next call picks up new ones).
- **Nothing else**: not `~/.pi/agent` (sign-ins), not Pi Pocket's data folder or its token, not `~/.ssh`, not your home folder. **A folder that is, holds, or lies inside** your home folder, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.pi`, `~/.pi-pocket` (or the data folder), `~/.config`, `~/.kube`, `~/.docker`, and similar private places **cannot be a sandbox's folder**: choosing the sandbox is refused, and a session that already has it fails each call with the reason. A project in the home folder is fine. The VM has its own `/root` and its own variables: none of the server's, and none that extensions add to host commands.
- **The network** you choose: **Allow list** (the default: package registries and GitHub, which you can edit), **Open** (public hosts), or **Off**. The VM never reaches this machine's `localhost` or your local network. Only HTTP and HTTPS leave it.

## The browser

The `browser` tool and the Browser panel of a sandboxed session use Chromium **inside the VM**. They never use this machine's browser. The browser:

- opens a file of the shared folder at its path (`file:///…`);
- opens a server that Pi starts in the VM, at `localhost:<port>` (inside the VM);
- is subject to the sandbox's network rules: a page cannot reach this machine's servers or your local network, and under Allow list reaches only the allowed hosts;
- shows in the Browser panel as usual (a screencast over the app's own connection). Pi Pocket opens **no port** on this machine for it: the browser's DevTools pipe runs over the VM's command channel.

It needs the image with a browser (**Set up with a browser**, then **Guest image: With browser**). Without it the tool says so, and the panel shows the reason. **Browser in sandboxed sessions: Off** turns it off. The cost of the browser: a larger image (+280 MB download, +860 MB on disk), about 0.3 s more to start a VM, 1.2 s for the first page, and about 200 MB of memory more in the VM while a page is open.

## Lifecycle and limits

- One VM for each session (its subagents share it). It starts at the first call that needs it, never at module load, and takes about half a second.
- It stops when idle (30 minutes by default), when the session is archived or removed, when you turn the session's sandbox off, when the module goes off, and when the server stops. Things the VM made outside the folder go with it. Processes in it end.
- Each VM has CPUs (2), memory (2 GB), a root disk (4 GB), and the owner's **Sandboxes at once** limit (default 3, from 1 to 16). When it is full, a call that needs another VM fails with a message that names the sessions that hold VMs and how to free one: the owner stops an idle VM with **Stop** in the sandbox sheet (**Running sandboxes**), or raises the limit.
- **Stricter rules end the VM.** When the owner turns the network off, shortens the allow list, or makes the folder read only, the VMs that run with the old rules stop at once (a call that ran in one ends as interrupted). Looser rules wait for the next start: the sheet shows each VM's own rules, and says when they are older than the settings.
- **A session that moves to another folder** gets a new VM at its next call (a call made for the old folder fails, and says so): the old VM mounts the old folder, so it ends, with a task or a browser that held it (Pi is told that the task ended).
- A VM whose runner dies (a crash, a kill) is dropped at once: its slot is free, its tasks end, and the next call starts a new one.
- A restart of the server ends the VMs. A tool call that it cut off comes back as **interrupted** and does not run again. The next call starts a new VM. A runner that a crash left behind is ended at the next start.

## When it cannot start

A call that needs a VM that cannot start **fails, with the reason**, in the tool result and the transcript: "The sandbox could not start: …". It never runs on this machine instead. With the module off, a sandboxed session runs nothing either: the owner turns the module on, or turns the session's sandbox off.

The sheet's **This machine** list says what is missing, and **Check again** looks again:

| Platform                     | Works                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| Linux x86-64                 | Yes. libkrun (prebuilt, needs read and write access to `/dev/kvm`) or QEMU. Tested for real with libkrun. |
| Linux arm64                  | QEMU only (`qemu-system-aarch64`, with KVM). Not tested.                                                  |
| macOS, Apple silicon / Intel | libkrun (Apple silicon) or QEMU with HVF (`brew install qemu`). Not tested.                               |
| Windows                      | No: Gondolin does not run on Windows. Run Pi Pocket inside WSL 2 (needs nested virtualization for KVM).   |
| A container or a VM          | Only when it has `/dev/kvm`.                                                                              |

Pi Pocket never installs system packages. **Remove the package and images** in the sheet deletes the `gondolin` folder.

## What it protects, and what it does not

It protects the rest of the machine from what Pi runs: Pi's sign-ins, Pi Pocket's data and token, SSH keys, other sessions' folders, and the local network. It does **not** protect:

- **The shared folder.** Pi reads every file in it (a `.env` too) and, when it is read and write, changes them. A backdoor that Pi writes into your source is still a backdoor.
- **Against a bug in Gondolin, libkrun, QEMU, or the guest kernel.** The VM's file bridge and network proxy run inside the Pi Pocket server process, in TypeScript.
- **Tools that stay on the host**, if you allow them.
- **Data that leaves through an allowed host.** Open mode lets it leave to any public host.
- **People.** Anyone who can steer a session can still make Pi do what the session allows. The sandbox limits Pi, not people.

See [SECURITY.md](../SECURITY.md) and the design (`docs/design/gondolin-sandbox.md` in the repository).

## Known issues

- **Gondolin 0.14's own image build.** `gondolin build` makes a libkrun image that does not boot on x86-64 Linux ("Kernel doesn't fit in RAM"). Set up with a browser works around it: it builds only the root disk and puts it into the published image's directory, whose kernel boots. The standard image is the published one, unchanged.
- **`rg` and compilers are not in the images.** `git` is, when Set up could build it.
- Output of a command that is cut at its limits is not kept whole in a file (the spill file of `bash` is not available in the VM).
- The sandbox does not report file changes to Pi (`watch` is not supported); Pi Pocket does not need it.
- **Prompt templates and other files outside the folder** are not in the VM (skills are, read only). `AGENTS.md` files are read by Pi Pocket and sit in the prompt, so they work.
- **A skill added after the VM started** is read at the next start (stop the VM from the sheet).
- A file larger than 64 MB cannot be opened by the `read` tool in the VM (use `bash`).
