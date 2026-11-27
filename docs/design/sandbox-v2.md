# Sandbox v2: design

Status: **design, no code. Revision 3**, after two rounds of critic review. This replaces the closed PR #415 (`feat/gondolin-sandbox`, head `322a8780`). That PR is a reference. Pieces of its code return only as small stacked PRs, and each is reviewed again (section 6).

Why a new start: the design was decided while #415 was being fixed. Most late findings were entry points that missed the shared lock, and host code that opened a path by convention, not by structure. This document makes both structural.

Terms. **Guest**: the VM and everything in it. **Tree**: a session and all its subagents. **Group**: the trees whose folders overlap. **Plain**: not sandboxed. **Sandboxed folder**: a folder that a sandboxed tree uses.

## 1. Threat model and boundary

**Decided.** Linux only (macOS and Windows say "not supported yet"). Gondolin micro-VM (krun), one VM per session, browser and background tasks inside it, network allow-list, Open, or Off. Host tools blocked by default.

**Protected:** the host outside the shared folder: `~/.ssh`, Pi sign-ins, Pocket's data and token, other folders, the LAN, `localhost`. Also protected: code the owner runs on the host (Pi, Pocket, Git, extensions) from being changed by the guest, and plain sessions from guest-written instructions.

**Adversary:** the guest. Model output and prompt injection run in it. The guest writes every byte of the shared work tree, including names, links, FIFOs, and files that look like config. A person who can steer already has the owner's power over Pi: the sandbox limits Pi, not people.

**Trust model.** Git's own. The work tree is untrusted. Every git dir is trusted.

**Documented limits:** project scripts that the person runs; global config that runs relative programs; Git's own path access to the work tree; a repository created while the VM runs (guarded by the `.git` name only; a bare repository built by the guest is not blocked); a bind mount; files from a finished sandbox (untrusted, like a cloned repository). Also: guest text that reaches **PiP** through follows and transcripts (fenced and labelled as data, as `fence.ts` does today; it is not a boundary); **terminal Pi** or any other tool that the person runs in the same folder, which Pocket cannot see; a **drop-in extension** that imports `node:fs` itself; anything inside the folder (the guest reads `.env`); a bug in Gondolin, libkrun, or the kernel; data sent to an allowed host; races from another host process.

## 2. One state machine

### 2.1 State

One class, `Sandboxes` (core, `src/server/sandbox.ts`), owns this state for each tree:

| Field        | Meaning                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `on`         | Stored. One `pocket.sandbox` doc **on the session root** (`{ on, by, at }`).                                                                   |
| `phase`      | In memory: `stable`, `turning-on`, `turning-off`, `moving`, `suspended`.                                                                       |
| `folder`     | **One** folder per conversation: `AgentDoc.cwd`, which execution uses (2.2, I6).                                                               |
| `leases`     | Live work, each with a kind, a **bound folder**, and a revoke handler (section 3).                                                             |
| `tickets`    | Pending VM spawns: the **spawn barrier** (section 3).                                                                                          |
| `workItems`  | Anything that can make work later: schedules, hooks, repo watches, background records, surviving processes. Each records its **bound folder**. |
| `reservedBy` | The pending operation that reserves a group, if any.                                                                                           |

Subagents never read their own doc. The effective setting of a conversation is its **root's** doc (`rootOf`). A child's doc is ignored, so it cannot be stale. A fork copies the doc in the commit that makes it (kind unchanged: conversation scope, `latest`, fork `current`).

### 2.2 Invariants

- **I1 No mixing.** In one group, every live tree is sandboxed or none is. Overlap is judged by stated path **and** by device/inode (a walk from `/`, following links only outside sandboxed folders).
- **I2 Tree-uniform.** One setting per tree, through `rootOf`.
- **I3 Live means able to work.** A tree is live when it is not archived, or when it has any `workItems`. This holds for sandboxed trees too. A leftover daemon of an ended task counts. Group membership is the tree's current folder **plus the bound folder of every live lease and work item**, so a plain move cannot drop the old folder while work uses it.
- **I4 Fail closed.** A sandboxed conversation never gets a host `ExecutionEnv`. A missing, revoked, or broken provider makes every call fail at once, with the reason.
- **I5 Release order.** Revoke, prove gone, then commit. Never the reverse.
- **I6 One writer, two stores.** The folder is stored twice: `AgentDoc.cwd` (execution) and `SessionsDoc.items[*].cwd` (the list). Only the admission point writes `pocket.sandbox`, either cwd, `archived`, and removal. A move writes **both cwds in one `tx`** (PiP's configure path already writes `AgentDoc` in a `tx`). A source test covers both stores. A post-commit audit checks I1 and that the two cwds agree. A violation blocks VM starts and tells the owner.
- **I7 Unknown is alive.** A process counts as gone only when proved.
- **I8 Work is admitted.** Every start, resumption, or delivery of work passes a lease or a delivery check whose grant checks I1 (2.3).
- **I9 One spawn barrier.** Launch, release, replacement, and recovery share one barrier. No release commits until every pending spawn is confirmed or proved unable to spawn (section 3).

### 2.3 The admission point

One exclusive queue (`exclusive`) and one function, `admit(tx, request)`. It reads the group, checks I1–I3 and the preconditions (trusted places, folder problem, who may choose, work), edits the `tx` it is given, and returns refuse (HTTP 409 with the reason) or commit. The queue is held only for a plan or a commit, never across a VM close. Long steps run between two short holds, and the group is **reserved** meanwhile.

**Work admission.** Making `workItems` in a tree that is not live (a schedule, hook, or watch on an archived tree, or a resume of a paused one) is a `work-add` request. It makes the tree live, and it is refused when the group is sandboxed and the tree is plain. Every execution then ends in a **lease**: a schedule delivery, a hook, a watch, a task, a tool call. **A lease grant checks I1 for the tree's group at that moment, not only the phase.** A tree that is plain in a sandboxed group is denied. **Deliveries.** A delivery only queues a message, and the turn's tool calls take their own leases. Even so, every durable delivery passes one check, `Sandboxes.deliver(tree)`, called from one wrapper around `conversation.submit`. A source test closes the list of `.submit(` callers. The check runs inside the delivering commit, reads memory only, and never waits. If the phase is not `stable` or I1 fails, the commit **defers**: the item and its checkpoint stay, the retry backs off, and one activity note is added. Nothing is deleted. A crash resumes the same item by its request id.

### 2.4 Every entry point

| Entry point                                                                             | Request                | What `admit` does                                                                                                              |
| --------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Create (API, PiP, extension `host`)                                                     | `join`                 | New tree joins its group: sandboxed if the person may choose, else refused. New-session setting applies.                       |
| Fork                                                                                    | `join`                 | Copies the source doc in the same commit, then as create.                                                                      |
| Terminal continue (`continuePiSession`)                                                 | `join`                 | As create.                                                                                                                     |
| Subagent reporter and courier delivery (`extensions/subagents.ts`, direct `submit`)     | `deliver`              | Same tree. The check above, and `rootOf` decides the environment. A test per phase: queued or deferred, never run on the host. |
| First message of a session made by an extension (`extension-sessions.ts`)               | `join`, then `deliver` | The join commits first. The message is sent only after, so its tools are sandboxed from the start.                             |
| Linked start                                                                            | `join`                 | Inherits the parent's doc. Another folder only if allowed, and still sandboxed.                                                |
| Subagent spawn                                                                          | `child`                | Joins its root's tree in the commit that makes it. It reads the root doc.                                                      |
| Move or configure (`configure({ cwd })`, any conversation)                              | `move`                 | Reserves the **union of the old and new groups** first. Release, then commit both cwds and `join`. Section 3.                  |
| Project model default (`projectModelDefault`)                                           | none                   | Runs **after** admission. A sandboxed tree never reads project settings (4.2).                                                 |
| Worktree add                                                                            | `join`                 | The worktree is the new cwd. Its git dir stays read-only to the guest.                                                         |
| Worktree remove                                                                         | `move`                 | Release, delete the folder, then `join` the original folder.                                                                   |
| Archive (person, `updateSession`)                                                       | `leave`                | Release the VM. Membership does not change by itself (2.5).                                                                    |
| Linked archive and unarchive (`linked-sessions.ts` own `tx`)                            | `leave`/`join`         | The same `admit` inside that `tx`. No second code path.                                                                        |
| Unarchive                                                                               | `join`                 | Whole tree, children too. Refused if the group would mix.                                                                      |
| Remove (`session-cleanup.ts`)                                                           | `leave`                | Needs archived and idle. Release before folders are touched.                                                                   |
| Schedule, hook, watch: add, resume, deliver                                             | `work-add`/lease       | Section 2.3.                                                                                                                   |
| Turn on, turn off                                                                       | `on`, `off`            | Section 3.                                                                                                                     |
| Module settings change (`setExtensionSettings`)                                         | `rules`                | Stricter rules `suspend` looser VMs **before** new calls can use them. Every VM lease compares its rules first.                |
| Settings or MCP file change                                                             | `rules`                | Trusted set is re-read. A read-write tree that now overlaps it is `suspended` (4.3).                                           |
| Module enable                                                                           | `reconcile`            | Provider registers. Revocation clears only after recovery proves no recorded runner is alive (4.5).                            |
| Module disable, manual reload (`reloadExtension`), auto reload or removal (`reload.ts`) | `suspend`              | Revoke all, prove all gone, then replace or unregister. Replacement is awaited and serialised after the old teardown.          |
| Server start                                                                            | `reconcile`            | Audits groups for I1. Reaps recorded runners before any VM start or revocation clear. A mixed group blocks VMs.                |
| Server shutdown (`app.close`)                                                           | `suspend`              | Revoke all, prove gone within a bound. Anything unproved stays in the ledger for the next start.                               |

PiP conversations and `ssh://` workspaces have no folder here. A sandbox on an `ssh://` folder is refused.

### 2.5 Archive and work

**One rule, for plain and sandboxed trees: archive never changes group membership by itself.** Membership is "not archived, or has `workItems`" (I3). Archive does two things in its own commit (the person's, and the linked-session one, both through `admit`): it releases a sandboxed tree's VM, and it records the tree's schedules and hooks as they are. Repeating schedules keep running on an archived session, as today (`schedules.ts`, and the `repeating` count in the linked archive reply).

- An archived **plain** tree with `workItems` stays in its group. It blocks turn-on beside it and a sandboxed join of its folder. Adding an item to an archived tree is a `work-add` (2.3), refused if the group is sandboxed and the tree is plain.
- An archived **sandboxed** tree with `workItems` stays in its group too. Its VM is released at archive. A delivery that the schedule makes passes `deliver`, and the turn's first tool call starts a new VM under a lease. This is an admitted start, not a leak.
- An archived tree with **no** `workItems` leaves its group. Unarchive is a full `join`, children included.
- **Pending deliveries and recovery.** A delivery in flight at archive finishes or defers by 2.3. After a restart the same items resume. A tree that is `suspended` defers its deliveries until the owner resumes it.

## 3. Transitions

**Leases are operation-scoped.** `env()` returns a **handle**. Each call through the handle takes its own lease, so a cached environment never carries an old grant.

| Lease kind   | Lifetime                                                                | Revoke handler (required to issue)                        |
| ------------ | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| call         | One tool call, to its result                                            | Abort the call in the guest                               |
| exec         | A `!` command, to exit                                                  | Kill the process group                                    |
| file         | One confined host operation                                             | Fail with `EBUSY`                                         |
| page         | A browser page, until it closes                                         | Close the page. **Releasing the launch lease closes it.** |
| task         | A background task, to its end                                           | Stop it, and wait for it                                  |
| spawn        | A VM start, from the **ticket** to its confirm or its proof of no spawn | Abort the start; the barrier waits for it                 |
| host (plain) | A host-executing call or process                                        | None: turn-on **refuses** while any exists                |

Every lease records the **bound folder** it was granted for (device/inode). It keeps that folder in its group until it ends. A VM lease without a revoke handler cannot be issued (a type requirement). Leases are granted only in `stable`. In `turning-*` and `moving` they **wait**, with a bound (default 60 s), then fail. In `suspended` they fail **at once**. After the wait they re-resolve the environment from the new state.

**Turn on.** (1) Plan, short hold: preconditions, group, a **fresh** trusted-places check, `workItems`. Reserve the group. `phase = turning-on`. (2) Drain: a host-executing lease or live host work is **refused** with a 409 that names it. Nothing is killed silently. (3) Commit, short hold: re-check I1, store `on` on the root. (4) `stable`, and the reservation clears. A refusal at any step sets `stable` at once. Nothing was revoked, so there is nothing to roll back.

**Turn off.** (1) Plan: the overlap check is **here**, before revoke. Reserve the group. (2) **Revoke**: no ticket, lease, page, shell, or task can start a VM. The mark outlives the VM entry. (3) **Drain the spawn barrier**, then **prove gone**: run each revoke handler, close the VM, show the runner dead by its recorded identity, retry. (4) Commit `off`. A **successful turn-off restores `stable`**. A failed step 3 or 4 sets `suspended`: stored `on` stays, every call fails at once with the reason, and the group stays reserved against plain joins. The owner retries turn-off or resumes. A failed turn-off never leaves a half state.

**Move.** (1) Plan: reserve the union of the old and new groups **before** any async preparation (`resolveCwd`, Git, the trusted walk). `phase = moving`. A **plain** tree is refused while any lease, task, daemon, hook, or watch is bound to the old folder (`background.ts` processes survive restarts and task end, so the bound folder stays in the old group). Stop the work, or wait. (2) A sandboxed tree is released as in turn-off. (3) The worktree-remove folder is deleted only after the release is proved. (4) Commit both cwds and `join`. If a step fails after release, the tree is `suspended` with its old cwd, and a retry or resume recovers it. A join of a reserved group is refused with a retry message.

**Spawn barrier and handshake (crash-atomic).** One barrier, `SpawnBarrier`, is shared by launch, release, replacement, and recovery.

1. **Ticket.** A launch first calls `barrier.enter(tree)`. It fails at once if the tree is revoked (checked in the same tick). Otherwise it holds a ticket in state `pending`.
2. **Intent.** The launch writes an intent record (session, a unique `intentId`) to the ledger.
3. **Last look.** Immediately before it calls the driver's `start`, the launch checks `ticket.aborted` and sets `ticket.spawnCalled = true` in the same tick. An aborted ticket settles as `void`, with proof: it never called `start`.
4. **Start.** The runner command line carries `--pocket-intent=<intentId>`. The driver reports the runner at once. The ticket becomes `confirmed(identity)`, and the confirm record (pid, start time, command line) is written.
5. **Release.** It sets `revoked`, aborts every ticket, and **waits for every ticket to settle**. A ticket settles when its start returned or failed (the package spawns nothing after that). A ticket with `spawnCalled = false` is proved void. A ticket with `spawnCalled = true` also needs a `/proc` scan for its marker; a runner found joins the prove-gone set. A start that does not settle within the bound leaves the tree `suspended`: unknown is alive.
6. **Recovery and replacement.** Recovery of an intent without a confirm scans `/proc` for the marker. A scan that cannot finish means unknown, so alive. Replacement of the provider waits for the old provider's barrier to drain, and the new provider starts at a new generation. Enabling the module clears revocation only after recovery.

Ledger writes are **serialised** through one queue. This closes the race where a start wrote its intent, waited, and spawned after release had committed `off`: release cannot commit while that ticket is pending.

## 4. Component contracts

### 4.1 Core sandbox state (`sandbox.ts`)

Owns: the doc, phases, the queue, `admit`, leases, groups, `rootOf`, the platform gate, the tool gate, the readiness gate, and the runner ledger (4.5). It never imports Gondolin.

**Readiness gate.** Turn-on requires every component of the sandbox to be registered: gate, host file access, trusted places, Git boundary, driver, **jobs, browser, the `team` rule, and the MCP launch point resolved** (decision 14). **`admit` checks readiness on every `join`**, not only at turn-on, so a session that would start sandboxed in a sandboxed group is refused while the gate is closed. The last PR registers the last of them. Until all are present, turn-on is refused ("not available yet"). So a PR that lands part of the work cannot enable anything.

**Provider contract:** `env`, `release` (resolves only after teardown; a rejection keeps the sandbox on), `jobs`, `browser`, `folderProblem`, `mayChoose`. Registration is **awaited and serialised** against the old provider's teardown. The newest live registration serves. A disposed provider never returns. `host.sandbox` is **not** on the public `host` object, in the types, or in the docs until the last PR. The built-in module reaches it through an internal option. **A routed tool with no route fails closed.** If `jobs` or `browser` is absent, `background` and `browser` are blocked, and `team` stays blocked until its rule exists.

### 4.2 Host file access is structural (`hostfs.ts`, `FolderRef`)

**One module touches the file system for host code.** `node:fs`, `node:fs/promises`, and `node:child_process` imports are allowed only in `hostfs.ts`, the hardened Git runner, and an allow-list of files that touch only Pocket's own data, install, config, or system locations. An ESLint rule and a source test enforce the list. A second source test: **no `git` spawn exists outside the one hardened runner.**

**Census.** `docs/design/sandbox-v2-census.md` lists all 77 files that import those modules at base `690ebd74`: 41 `own`, 23 `convert`, 10 `split`, and 3 `wrapper`. It also lists the **indirect** users (`design/guide.ts` through `readDesignSystemText`, `heic.ts`, `repo-watches.ts`, `browser/*`). The list comes from `rg -l --glob 'src/server/**/*.ts' -e 'from "(node:)?(fs|fs/promises|child_process)"'`. **CI keeps it current:** PR 2 turns the table into `src/server/fs-census.json`, and `test/fs-census.test.ts` scans the tree (static imports, `import()`, `require`) and fails on an unlisted importer, a stale entry, or a `convert` or `split` file that still imports a primitive. Indirect users are forced to convert by types: a helper that touches a session folder takes a `FolderRef`, and its callers stop compiling until they have one. The lint covers `src/server/extensions/*` (built-in modules). **Drop-in extensions** are the owner's code and run with the owner's rights; the lint cannot reach them. The `host` file APIs they use are `hostfs`-backed. A drop-in that imports `node:fs` itself is a documented limit.

**`FolderRef`.** `app.folderOf(id)` replaces `cwdOf` for host code. It returns an opaque object (path, device, inode, group state). It has no `toString`, `valueOf`, or `Symbol.toPrimitive`. `fs` rejects it at compile time and at run time. Access is `hostfs.open(folderRef, relativeName)`: a descriptor walk, one name at a time, refusing every link and every odd name, failing closed on any error.

**How the walk is built in Node.** Node has no `openat`, `unlinkat`, or `mkdirat`. Linux gives the same through `/proc/self/fd/<N>/<name>`, where `N` is the descriptor of the directory reached so far and `<name>` is **one** component. The kernel resolves the magic link to that directory, so nothing before the name can be swapped. The last component is opened with `O_NOFOLLOW` (and `O_DIRECTORY` for a step). `unlink`, `mkdir`, `rename`, and `rmdir` on such a path act on that name only. Where the walk must look before it opens (classification case 2), it opens with `O_PATH` and uses `fstat`; the parent is `/proc/self/fd/<N>/..`, which is the real parent of that directory. A non-Linux platform, or a `/proc` that is not mounted, **fails closed**. A native `openat2` helper is rejected: no new native dependency. PR 2 tests every operation on a swap race.

**The enforcer for the guest's own file operations.** The VM's folder bridge runs **in the server process**. Gondolin's `RealFSProvider` works on path strings, so v2 does not use it. A `GuardedFs` (module `pocket-gondolin`, built on `hostfs`) implements every operation the bridge asks for. It walks from the folder's descriptor, so the bridge has the same confinement as host file access. It applies the Git policy of 4.4: `EROFS` on git dirs and `.git` names, and `EPERM` on a file with `nlink > 1`. A bug here is a host bug, so its tests are the same swap-race and link tests as `hostfs`. Open decision 12. Labels for UI text come from a `Display` object, not from a string a call can pass to `fs`.

**Confinement by identity, for every requester.** A raw path from **any** conversation or person (a plain session, the owner's viewer, an absolute path, an alias) is classified, not matched by text:

1. If the path starts with a sandboxed folder's **stated** path: redo it as `FolderRef` plus the remainder, with the confined walk.
2. Otherwise open it, then climb with `..` by descriptor, comparing device/inode with every sandboxed folder. If it passes through one, **refuse** (a link leads into a sandboxed folder).

The test file runs aliases (`/alias -> /project`, `/alias/sub`), a nested root replaced by a link, a parent swap, and `stat`/`fstat` disagreement.

**Pi's loaders take paths** (`loadSkills`, `loadSkillsFromDir`, `loadProjectContextFiles`, prompt templates). For a sandboxed folder, Pocket does **not** reimplement them. It reads the candidate files through the confined walk (regular files only; size and count caps; FIFOs and `/dev/zero` never opened, via `O_NONBLOCK` and `fstat`) into an immutable snapshot under `<data>/snapshots/`, then runs **Pi's own loaders on the snapshot**. Results map the snapshot root back to the folder path, which the guest mounts at the same place. `test/skills.test.ts` already compares Pocket's results with Pi's loaders. The same cases run on the snapshot, plus `.pi/skills/.gitignore -> /dev/zero`, `AGENTS.md -> ~/.ssh/id_rsa`, and `/skill` expansion.

**Inventory of host paths that read or run something in a folder.** Each is converted in PR 2, and the source tests keep the list closed.

| Place                                                                        | Decision                                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `project-model.ts` (`readFileSync(cwd/.pi/settings.json)`)                   | A sandboxed tree **never reads** project settings: a link, a FIFO, or a guest-picked model. The owner's defaults apply. |
| `files.ts` `git check-ignore`                                                | Hardened Git runner.                                                                                                    |
| `worktrees.ts` `copyNewFiles` (TOCTOU), `worktree add`, `stash apply`        | Source files copied by `hostfs` from the folder's descriptor. Git through the hardened runner.                          |
| `branches.ts` `switchBranch` (`post-checkout`)                               | Hardened runner, hooks off for sandboxed folders.                                                                       |
| `branches.ts` `gitDirOf`, `headOf`; `workspace.ts` `#gitDir`                 | Through `hostfs`, under a `file` lease.                                                                                 |
| `workspace.ts` `makeFolder`; Changes undo                                    | `mkdirat`, `unlinkat` from the folder's descriptor.                                                                     |
| Files, viewer, uploads, mentions, images, downloads, option values, `/skill` | Through `hostfs`.                                                                                                       |

### 4.3 Trusted places

A read-write sandbox is refused when Pi or Pocket code, config, or instructions are reachable in the shared folder. Reachable means: the folder is, holds, or lies inside a trusted place, or a link under a trusted place leads into or through it.

**Trusted places:** Pocket's install, data, extension, and theme folders (the managed `worktrees` folder is allowed); `~/.pi`, `~/.agents`, `~/.ssh`, `~/.gnupg` and similar; **every directory in the server's `PATH`**; and every path in Pi's `settings.json` and `mcp.json`. Each configured key has **one stated base**:

| Key                                                | Base                                                        |
| -------------------------------------------------- | ----------------------------------------------------------- |
| skills, extensions, themes, packages               | `agentDir` (as `skills.ts` resolves them)                   |
| prompt `paths` (`prompts.ts:104`)                  | `cwd` in Pi; checked against **both** `cwd` and `agentDir`  |
| `shellPath`, `npmCommand`, `selfUpdateCommand`     | Absolute, or looked up on `PATH` (so the `PATH` dirs apply) |
| MCP `command`, and path-like args and `file:` URLs | As Pi resolves them, including `--opt=/path`, `-r/x`, `%73` |

Missing targets are included. Project `.pi/settings.json` of a sandboxed folder is **never read**.

**The walk.** It follows no link in the shared folder. A link under a trusted root is followed once (device/inode; cycles end). **A walk that cannot finish refuses**: an entry cap, a time cap, an unreadable folder, an unparsable settings file. **Entry cap plan:** `node_modules` would hit any cap. The walk therefore covers `node_modules` at the positions Node resolves (`node_modules/*` and `node_modules/@scope/*`), and walks everything else fully. Results are cached per directory by its mtime. The first look is a refusal until it finishes. **Excluded as data, not code:** `.git/objects`, `~/.pi/agent/sessions`, `<data>/uploads`, and browser profiles under the data folder. Pocket itself makes no link there. Relative or empty `PATH` entries resolve against the server's own cwd, so that folder counts as trusted too, and they are ignored for tool lookup (4.7).

**When it runs.** At turn-on (fresh), before any VM start, **and on every change of `settings.json` or `mcp.json`** (a `rules` transition). It also runs **before an extension load**, which the resolve hook refuses when the module lies in a sandboxed folder. **MCP launch:** the resolve hook cannot stop a process spawn, and MCP servers are not started by code in this repository. PR 3 first finds the one place that spawns them. If Pocket can own it, that place calls `Sandboxes.launchCheck(command, args)` through a `hostfs` spawn wrapper, and the census test covers it. If it is outside Pocket, the enforcement is the change-time check: a `mcp.json` or `settings.json` change that makes a trusted path overlap a read-write tree **suspends** that tree. The doc then says plainly that no launch-time check exists. Open decision 14.

### 4.4 The Git boundary (Design A)

- **Every git dir is read-only to the guest, through any path.** Outside the folder: a read-only mount. Inside it: `EROFS` for open for write, mkdir, rmdir, unlink, rename, link, symlink, chmod, copy. Hard links are checked at both ends. A folder holding a git dir cannot be renamed.
- **No `.git` name may be written**, by Git's equivalence rules (case, trailing dots and spaces, NTFS short names, streams, HFS+ ignorable characters).
- **Which git dirs:** a descriptor walk (no links) finds each `.git` entry, each folder a `.git` file names (with or without a back-pointer), each linked worktree's common dir, submodules, and bare-looking folders. Host Git is asked about the repository above the folder, and the global and system config are audited even when the folder holds no repository. A session folder that is or lies inside a git dir is refused.
- **Repository-scope config** (local and worktree; submodules, bare and nested repos; explicit `--git-dir`) may hold only `DATA_KEYS`. Any other key makes the VM read-only. Empty config files and `GIT_CONFIG_*` count: the audit and execution use the same Git environment.
- **Hooks and includes** are checked along the full link chain with `lstat` and `readlink`, no lexical clean-up, and Git's own expansion of `~`, `~user`, and relative includes. A step in the folder outside a git dir makes the VM read-only. A link inside any git dir that leads into the folder refuses. If Git cannot be asked, read-only.
- **No per-file lists** for git internals. Files with `nlink > 1` are never changed in place (`EPERM`).
- **Guest Git reads, never writes.** One message says to commit on the host. `GIT_OPTIONAL_LOCKS=0`.
- **Pocket's own Git, in sandboxed folders only:** pin `--git-dir`, `-c core.hooksPath=/dev/null`, strip every `GIT_*`, `safe.bareRepository=explicit`, neutralise filters, and set `core.fsmonitor=false`. This is one hardened runner (4.2). Plain bare-repo setups are untouched.

### 4.5 The VM driver and its lifecycle (module `pocket-gondolin`)

Behind a `SandboxDriver` interface (a fake in tests). Gondolin is not a dependency: Set up installs it into `<data>/gondolin`. The host opens no port.

**Per entry:** `generation`, one `closing` promise, `stuck`, `revoked`. A VM records its rules and mount. Stricter rules stop a looser VM before a call uses it. A VM for another folder is replaced.

**Runner ledger (in core).** Written by the spawn barrier and handshake (section 3), atomically (temp file, fsync, rename), through one queue. A record that cannot be read or written refuses every start and release. It is never taken for empty. Every `release` also ends this session's recorded runners that no manager holds. A process of another identity is never killed. Revocation clears only after recovery proves that nothing recorded is alive.

**Proof of gone:** gone, alive, or unknown. Unknown is alive. A failed close is retried. A runner that outlives the close is killed with its process group, only when its identity still matches.

**Launcher (recommended; open decision).** Start the runner through `setpriv --pdeathsig=KILL`, with the intent marker on its command line. A dead server then takes its VMs, and recovery can find a runner that has no confirm. Without it, recovery relies on the marker scan alone.

No throw escapes an event, timer, or callback. A failure keeps the record, still ends the VM, tells the session, and goes to the module's notice. Idle stop, folder-change stop, and crash handling use the one lifecycle.

### 4.6 The host tool gate

An **allow list** in core. An unlisted tool is a host tool and is blocked.

- Allowed: `ask`, `ui`, `schedule`, `tool_search`, `subagent`, `codemode` (its calls pass the gate again), plan and goal tools, and `artifact` with **no path anywhere** in its arguments (`assets[].path` too).
- **`memory`:** from a sandboxed tree it may write **session scope only**. Project and everywhere scopes are refused: they feed plain sessions' prompts.
- Routed to the VM: `bash`, `read`, `write`, `edit`, `!`, goal checks, `background`, `browser`.
- Blocked by default: session tools, `design_*`, `watch_pr`, MCP tools, other extensions' tools, and **extension slash commands**. The owner may allow them (setting).
- `team`: **blocked until the last PR**, which adds its rule: a child is sandboxed in the parent's folder and reaches only sandboxed sessions. The gate is an allow list **and** a route check: a tool without a route fails closed.

### 4.7 Implementation notes carried to code review

- **One `git`.** Resolve an absolute `git` path **once** at start. Ignore relative and empty `PATH` entries for every lookup (they mean the server's cwd).
- **Filters and attributes.** In sandboxed folders Pocket's Git runs with `--attr-source` set to the empty tree (or an equivalent), `-c core.attributesFile=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, and a **pinned `--work-tree`** as well as `--git-dir`. A global filter then cannot run on guest content through a guest `.gitattributes`.
- **Walk bounds.** The trusted walk excludes `.git/objects`, `~/.pi/agent/sessions`, `<data>/uploads`, and browser profiles (4.3).
- **Migration.** The `pocket.sandbox` doc keeps the shape `{ on, by, at }`. At server start a stored `on` doc is audited like any other (I1) and starts `suspended` if the readiness gate is not met. The live database has none today, so a test with a synthetic stored doc covers it. The old build's `gondolin/vms.json` is imported as confirmed ledger records. A file in an unknown shape refuses VM starts until the owner clears it.
- **Guest text and plain sessions.** The limits in section 1 are listed on the sandbox sheet. `team` and `session_send` cannot reach plain sessions from a sandboxed tree (4.6).

### 4.8 Implementation review checklist

Every implementation-level item from the two critics' reviews. Each PR's description ticks the items it owns.

**Deliveries (PR 1).**

- The `deliver` wrapper does not exist yet. It must convert **every** direct `submit`. A scan of the base finds these callers: `commands.ts`, `turn-notes.ts`, `schedules.ts`, `background.ts`, `resend.ts`, `extensions/subagents.ts` (both the reporter and the courier), `extensions/agent-teams.ts`, `extension-sessions.ts`, `linked-sessions.ts`, `inbox.ts` (the webhook inbox), `extension-commands.ts`, `watches.ts`, `repo-watches.ts`, `shell.ts`, `pip.ts`, `http/conversation-routes.ts`. Several of them go through `commands.submit`. The `.submit(` source test lists them and fails on a new one.
- **Deferral keeps checkpoints and batches.** `background.ts` must not mark a deferred report as told. `resend.ts` must not finish a deferred task. A deferred courier batch stays whole and keeps its batch number.
- `admit` checks the readiness gate on every `join` (4.1).

**Reload and providers (PR 1, PR 5).**

- `reload.ts` stages the replacement before the old module's cleanup. For providers this changes to: awaited teardown, a barrier drain, then a **generation check** before the new provider serves. Applies to manual reload, auto reload, removal, and disable.

**Recovery and ledger (PR 5).**

- An unfinished `/proc` scan counts as **unknown**, which is alive.
- The ledger keeps its records after any failure. A failed write or read never empties it.
- A spawn that never settles within the bound leaves the tree `suspended`.

**Census (PR 2).**

- `git.ts`, `github.ts`, `reveal.ts`, and `processes.ts` need a **named spawn wrapper**. They cannot just lose `child_process`. The census marks them `wrapper` or `split`.
- `secrets.ts` is `split`. `upload-references.ts` is `own`. `browser/*` is `own` in every row, and the host browser is refused for sandboxed trees.
- The census test also catches: calls into Pi's own loaders (`loadProjectContextFiles`, `loadSkills`, `loadSkillsFromDir`); `createRequire` (`lancet.ts`, `extension-document-imports.ts`); `process.getBuiltinModule`; `process.binding`; and packages that wrap fs or spawn.

**Git (PR 2, PR 4).**

- `gh` runs Git itself. Treat it like Git: `runGh` has the same environment, flags, and version gate as `runGit`.
- `--attr-source` needs **Git 2.40 or later**. A version gate runs at start. **Fail closed:** below 2.40, Pocket's own Git in a sandboxed folder is refused, with the version in the message. The only fallback is a Git-written empty attributes snapshot: `-c core.attributesFile=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, and a bare `--git-dir` plus `--work-tree` over a snapshot made by `hostfs`. If that is not built, the refusal stands. Nothing falls back to plain Git.
- Resolve the absolute `git` path once. Ignore relative and empty `PATH` entries (4.7).

**`hostfs` and `GuardedFs` (PR 2, PR 4).**

- **`hostfs` on plain folders.** It confines only folders that a sandboxed tree uses. For every other folder it behaves as today: links are followed, and the error codes are the same. A **plain-session parity test** in PR 2 runs the existing file, changes, and viewer cases on a plain folder, with and without `hostfs`, and compares results.
- **`GuardedFs` and guest-made special files.** A **link** the guest makes is stored as a link and never followed on the host: reads of it return the link, and a path through it is refused by the descriptor walk. A **FIFO** or a device node is never opened on the host. A `stat` on it works. An `open` returns `ENXIO`, so the bridge cannot block on it. A guest `mknod` is refused with `EPERM`, except for a regular file. A socket is refused the same way. A test makes each kind in the guest-side API and checks the host side stays unblocked.
- Both pieces fail closed off Linux and without `/proc`.

**Trusted places and MCP (PR 3).**

- Find the MCP spawn. Record the answer for readiness. Never read a sandboxed folder's project MCP config.
- Entry-cap plan and exclusions as in 4.3.

## 5. Findings from #415, by class

Each class names the element that makes it **impossible**. Sources: Greptile on GitHub (G), and the independent reviews at `640919a8` through `322a8780` (I), from `independent-review-findings.md`.

**A. An entry point missed the lock, the tree, or the group.**

| Finding                                                                                                                                                                                                                                        | Element                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| G: new children miss the sandbox; existing children miss it (unarchive)                                                                                                                                                                        | `rootOf`; whole-tree `join`                                                                |
| G: archived work bypasses protection. I: archived work counts                                                                                                                                                                                  | I3, `work-add`, lease grant checks I1                                                      |
| G: failed turn-off disables the VM                                                                                                                                                                                                             | Check before revoke; `suspended`                                                           |
| G: host work survives sandboxing. I: in-flight `background` start crosses activation; goal checks outside the tool path                                                                                                                        | Leases for every kind of work; refuse while any exists                                     |
| G: moved sessions keep old mounts. I: subagent moves bypass admission; a move releases the old folder before the VM stops; archive shutdown not awaited                                                                                        | `move`, union reservation, release first, VM records its mount                             |
| G: host pages survive. I: a browser launch recreates an unrevoked entry; a launch bypasses an unfinished scan                                                                                                                                  | Page lease; revoke closes it; the revoke mark outlives the entry                           |
| I: transitions publish before checks; a call starts a VM during enable; disable lifts confinement before teardown                                                                                                                              | Phases, barrier, I5                                                                        |
| Round 2: a start writes its intent, waits, and spawns after release commits `off`                                                                                                                                                              | I9: the spawn barrier. Release cannot commit while a ticket is pending                     |
| I: an existing environment starts a replacement VM during shutdown; revocation disappears with its entry                                                                                                                                       | Handle takes a lease per call; mark outlives the entry                                     |
| I: guest instructions enter plain sessions that share the folder                                                                                                                                                                               | I1, no mixing                                                                              |
| Later reviews: schedule delivery, linked archive, reload, shutdown, settings publication, project model read                                                                                                                                   | Rows of 2.4                                                                                |
| Round 2: a plain move drops the old folder while a task or daemon survives (`background.ts`); archive semantics differ between 2.4 and 2.5; durable deliveries in `extensions/subagents.ts` and `extension-sessions.ts` call `submit` directly | Bound folders (I3); one archive rule (2.5); `deliver` wrapper and a closed `.submit(` list |

**B. Host Git or Pocket runs guest-written code.**

| Finding                                                                                                                                                                                                               | Element                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| G: `commondir`; custom hooks path; receive hooks; submodule hooks; separate git dir; fsmonitor and other scripts. I: sequencer, `pager.<cmd>`, `core.gitProxy`, `interactive.diffFilter`, `gpg.ssh.defaultKeyCommand` | Every git dir read-only whole; repo-scope key allow-list    |
| G: effective value; dangling and `..` links; `~user` includes; split index. I: include expansion differs from Git; empty config; `GIT_CONFIG_*`                                                                       | Link-chain walk, no clean-up; no lists; one Git environment |
| I: discovery visits only cwd; a session rooted at `.git/hooks`; subfolder skips the parent; nested and existing bare repos; the containing repo; global and system includes with no repo                              | Full descriptor discovery; session in a git dir refused     |
| I: a writable link in the chain swaps later; hard links; a hook links to project code                                                                                                                                 | Chain walk inside git dirs; `nlink > 1`                     |
| I: clean filters run in Changes' `git status`; husky scripts                                                                                                                                                          | Hardened runner in sandboxed folders; husky is a limit      |

**C. Host reads or writes follow a guest link.**

| Finding                                                                                                                                           | Element                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| G: mentioned links, images, downloads. I: owner file viewer; prompt loading (`AGENTS.md -> id_rsa`)                                               | `hostfs` + `FolderRef`; snapshot loaders    |
| I: parent swap; `stat`/`fstat` agree on an outside file; listing reopens a checked name; Changes undo deletes outside                             | Descriptor walk, `unlinkat`                 |
| I: nested root redirected by a link; aliases bypass confinement                                                                                   | Identity classification for every requester |
| I: skill discovery reads `/dev/zero`; `/skill` expansion unrestricted                                                                             | Confined reads, `O_NONBLOCK`, snapshot      |
| G: artifacts read `assets[].path`                                                                                                                 | Gate: no path anywhere                      |
| Critic 2: `project-model.ts`, `check-ignore`, `copyNewFiles`, `switchBranch`, `gitDirOf`, `makeFolder`                                            | The inventory in 4.2                        |
| Round 2: `design/guide.ts`, `design/files.ts`, `skills.ts` `existsSync`, project MCP config, `github`, `heic`, `reveal`, `browser/*`, `processes` | The census (4.2) and type-forced conversion |

**D. Trusted code reachable from the folder.**

| Finding                                                                                                                                                       | Element                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| G: home mounts expose secrets. I: live code reload overlaps install or extension folders; extension source reached by links; linked trusted dirs hide content | Trusted places; walk follows trusted links     |
| I: configured skill and prompt paths by pathname; command args, `file:` URLs, `%73kills`; inline options `--require=`, `-r/x`                                 | One stated base per key; Pi's resolution rules |
| Critic 2: `PATH`, later settings changes, MCP and extension launch                                                                                            | Live trusted view; launch-time check           |
| I: test seams (platform, driver) usable in production                                                                                                         | Constructor options only, no globals           |

**E. VM lifecycle and records.**

| Finding                                                                                                                                     | Element                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| G: turn-off before teardown; crashed VMs stay running; cleanup errors escape; calls lose their VM; task races; parallel starts; stale lists | I5, one lifecycle, reserve before spawn               |
| I: failed-close retry loses the pid; cancelled starts and failed boots lose runners; an empty entry bypasses orphan checks                  | Spawn handshake with intent; release sweeps ledger    |
| I: inspection errors count as gone; records corrupt or non-atomic; disposal unregisters before shutdown                                     | I7; atomic ledger; awaited provider replacement       |
| Round 2: an old record or `vms.json` of another shape                                                                                       | Import as confirmed records, else refuse starts (4.7) |
| G: reload restores a dead provider; the `release` type missing                                                                              | Registration list; typed from PR 1                    |

**F. Drift and small findings.** Stricter settings leave a looser VM: the rules transition and a rules check at every grant. First command in `sh`: choose the shell after ready. UI text and states: test with real htm. Piped exit codes in tests: capture before the pipe. macOS runs: Linux-only tests skip with a reason.

## 6. Stacked PRs

Each PR reviews alone and **ships safe with the sandbox off**: the readiness gate (4.1) refuses turn-on until the last PR registers the last component.

1. **Core state, admission, gate.** `sandbox.ts` (state, phases, leases with bound folders, `rootOf`, `admit`, `exclusive`, `deliver`, readiness gate), the `pocket.sandbox` kind, the **allow-list tool gate with its route check** (`team`, `background`, and `browser` blocked until their routes exist), the fail-closed env, a trusted-places stub that **refuses by default**, every entry point in 2.4 against a fake provider. `host.sandbox` stays internal. Files: `sandbox.ts`, `commands.ts`, `app.ts`, `linked-sessions.ts`, `schedules.ts`, `hooks.ts`, `repo-watches.ts`, `extensions/subagents.ts`, `extension-sessions.ts`, `session-cleanup.ts`, `reload.ts`, `docs.ts`. _Fail first:_ a race test per row of 2.4; the I6 source test over both cwd stores; the `.submit(` source test; an archived tree gaining work; a plain move with a surviving task. _Salvage:_ `admit`, `exclusive`, overlap; `hostfs17` tree logic.
2. **Structural host file access, census, hardened Git runner.** `hostfs.ts` (the `/proc/self/fd` walk), `FolderRef`, the lint rule, `fs-census.json` and its test, both source tests, snapshot loaders, the `project-model.ts` rule, the conversion of the 23 `convert` and 10 `split` files, and the named spawn wrappers (`runGit`, `runGh`, `reveal`, `spawnIn`). _Fail first:_ alias, parent-swap, FIFO, `/dev/zero`, `AGENTS.md` link, mention-link cases; the census test; the two source tests. _Salvage:_ `confined.ts`.
3. **Trusted places.** `trusted-places.ts`, `PATH`, per-key bases, the bounded and cached walk, the settings-change `rules` transition, the MCP launch finding, the resolve hook. _Fail first:_ `trusted-roots.test.ts`, an unfinished walk, a `node_modules` tree, a changed `mcp.json`. _Salvage:_ `trusted-places.ts`.
4. **The Git boundary and `GuardedFs`.** `policy.ts`, the config audit, the link-chain walk, descriptor discovery, and `GuardedFs` on `hostfs`, tested on real folders with no VM. _Fail first:_ `.git` equivalence table; the key allow-list; link chains against `readlink -f`; swap races on `GuardedFs`. _Salvage:_ `policy.ts`, and from `git.ts` the allow-list and chain walk only.
5. **Driver, barrier, ledger.** The Gondolin adapter over `GuardedFs`, `manager.ts`, the core ledger, `SpawnBarrier`, the module shell (off by default), guest env, Linux check. _Fail first:_ intent, wait, release, spawn (the I9 race); a crash between intent and confirm; failed close; unreadable `/proc`; serialised provider replacement. _Salvage:_ `manager.ts`, `real-driver.ts`, `guest-env.ts`.
6. **Features and enable.** Background tasks, the browser in the VM, the sheet, settings, the `team` rule. Public `host.sandbox` types and docs. This PR registers `jobs`, `browser`, and `team`, and **the readiness gate passes here, not before**. _Fail first:_ jobs races, sheet states, the `team` rule. _Salvage:_ `jobs.ts`, `index.js`.

## 7. Test plan

**Deterministic gates (every OS unless marked):** a race test per row of 2.4, with gates held in the fake driver so nothing waits on time; the phase tests (barrier, reservation, rollback, `suspended` fails at once, bounded wait); lease lifetimes (a page, a task, a cached handle); the spawn barrier (intent, wait, release, spawn; a start that never settles); a plain move with surviving work; archive with schedules in both kinds of tree; a delivery in every phase; both source tests plus the I6 test; policy tables (`.git` equivalence, key allow-list); link chains against `realpath` on disk (Linux); the confined walk and identity classification (Linux, with the fail-closed guard everywhere); the platform gate through a constructor option; Pi-loader parity on snapshots; each sheet state rendered with real htm.

**Real-VM tests (opt-in; Linux with KVM, the package, and an image; skip with a reason):** boot and exec; SIGKILLed runner noticed; release proves the runner gone; kill the server between intent and confirm, then recover; the Git boundary with a guest-written hook that the host then does not run; a move while a task holds the VM; the browser; network modes. The PR says what ran.

**Linux only:** `/proc` identity, the `/proc/self/fd` walk, real VM. **All platforms:** state machine, gate, fake driver. CI runs the full suite on each head; locally run only the touched areas.

## 8. Open decisions for Tanner

1. **Launcher:** `setpriv --pdeathsig=KILL` with an intent marker. _Recommend yes._
2. **Ledger home.** _Recommend core._
3. **Archived tree with work items.** _Recommend it stays live, plain or sandboxed_ (2.5); a sandboxed one gets a new VM only for admitted work. The alternative pauses its schedules and hooks on archive.
4. **Turn-on with host work.** _Recommend refuse._
5. **A mixed group at server start.** _Recommend block VMs and tell the owner._
6. **`memory` from a sandboxed tree.** _Recommend session scope only._ The alternative holds project scope for approval, labelled.
7. **Pi loaders on a sandboxed folder.** _Recommend snapshots plus Pi's own loaders._ The alternative reimplements them.
8. **`node_modules` in the trusted walk.** _Recommend depth-2 positions plus an mtime cache._ The alternative is a high cap, and it risks refusing every machine.
9. **Hooks off for Pocket's own Git in sandboxed folders.** _Recommend yes;_ the cost is that husky hooks do not run on Pocket's worktree and branch switches there.
10. **Project `.pi/settings.json` of a sandboxed folder.** _Recommend never read._
11. **Extension slash commands in a sandboxed tree.** _Recommend blocked until the extension says it is inert._
12. **The guest bridge.** _Recommend our own `GuardedFs` on `hostfs`_ over wrapping Gondolin's `RealFSProvider`. The cost is more code in PR 4 and PR 5.
13. **Guest text reaching PiP.** _Recommend a documented limit_ (fenced and labelled data). The alternative removes PiP's host tools after it reads a sandboxed transcript.
14. **MCP launch point.** _Recommend_ finding the spawn in PR 3 and routing it through `launchCheck`. If it lives outside Pocket, accept the change-time check alone and say so. Either way, a sandboxed folder's **project-level MCP config is never read**, the same as decision 10 for `settings.json`. "MCP launch point resolved" is a readiness-gate component: the gate stays closed until PR 3 records which of the two cases holds.
