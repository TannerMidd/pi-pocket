# Sandbox v2: design

Status: **design, no code.** This replaces the closed PR #415 (`feat/gondolin-sandbox`, head `322a8780`). That PR is a reference. Pieces of its code return only as small stacked PRs, and each is reviewed again (section 6).

Why a new start: the design was decided while #415 was being fixed. Most late findings were entry points that missed the shared lock. This document states the design first, so critics can attack it before code exists.

Terms. **Guest**: the VM and everything in it. **Tree**: a session and all its subagents. **Group**: the trees whose folders overlap. **Plain**: not sandboxed.

## 1. Threat model and boundary

**Decided.** Linux only (macOS and Windows say "not supported yet"). Gondolin micro-VM (krun), one VM per session, browser and background tasks inside it, network allow-list, Open, or Off. Host tools blocked by default.

**Protected:** the host outside the shared folder. That means `~/.ssh`, Pi sign-ins, Pocket's data and token, other folders, the LAN and `localhost`. Also protected: code the owner runs on the host (Pi, Pocket, Git, extensions) from being changed by the guest.

**Adversary:** the guest. Model output and prompt injection run in it. The guest can write every byte of the shared work tree. A person who can steer already has the owner's power over Pi: the sandbox limits Pi, not people.

**Trust model.** Git's own. The work tree is untrusted. Every git dir is trusted.

**Not protected (documented limits):**

1. Project scripts the person runs (`npm test`, `make`).
2. Global config that runs relative programs.
3. Git's own path access to the work tree.
4. A repository created while the VM runs. It is guarded by the `.git` name only; the next VM finds the rest. A bare repository built by the guest is not blocked.
5. A bind mount made outside the guest's reach.
6. Files from a finished sandbox. They are untrusted, like a cloned repository.
7. Anything inside the folder: the guest reads `.env` and can plant a backdoor in source.
8. A bug in Gondolin, libkrun, or the guest kernel. This is a VM, not a proof.
9. Data sent to an allowed host. Open mode allows any public host.
10. Races with another host process that swaps paths. The descriptor walk in 4.2 closes the ones Pocket itself can cause.

## 2. One state machine

### 2.1 State

One class, `Sandboxes` (core, `src/server/sandbox.ts`), owns this state for each **tree**:

| Field        | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `on`         | Stored. One `pocket.sandbox` doc **on the session root** (`{ on, by, at }`).    |
| `phase`      | In memory: `stable`, `turning-on`, `turning-off`, `suspended`.                  |
| `folders`    | The stated cwd of each conversation in the tree, and its device/inode identity. |
| `leases`     | Live host-touching work: tool calls, `!`, goal checks, browser launches, tasks. |
| `hostWork`   | Work that runs without a lease: schedules, hooks, repo watches, background.     |
| `reservedBy` | The pending transition that reserves the group, if any.                         |

Subagents never read their own doc. The effective setting of any conversation is its **root's** doc (`rootOf`). A child's doc is ignored, so a child cannot be stale. Forks copy the doc in the commit that makes them (kind unchanged: conversation scope, `latest`, fork `current`).

### 2.2 Invariants

- **I1 No mixing.** In one group, every live tree is sandboxed or none is. Overlap is judged by stated path **and** by device/inode (walk from `/`, following links only outside sandboxed folders).
- **I2 Tree-uniform.** One setting per tree. It follows from `rootOf`.
- **I3 Live means host work too.** An archived tree counts as live while `hostWork` is not empty.
- **I4 Fail closed.** A sandboxed conversation never gets a host `ExecutionEnv`. If the provider is missing, revoked, or broken, every call fails with the reason.
- **I5 Release order.** Revoke, prove gone, then commit. Never the reverse.
- **I6 One writer.** Only the admission point writes `pocket.sandbox`, and the `cwd`, `archived`, and removal fields of the session list. A source test enforces this. A post-commit audit checks I1; a violation blocks VM starts and tells the owner.
- **I7 Unknown is alive.** A process counts as gone only when proved.

### 2.3 The admission point

There is one exclusive queue (`exclusive`) and one function, `admit(tx, request)`. A request is `{ kind, tree, cwd?, on?, user }`. `admit` reads the group, checks I1–I3 and the preconditions (trusted places, folder problem, who may choose, host work), and edits the `tx` it is given. It returns refuse (HTTP 409 with the reason), or commit.

The queue is held only for a **plan or a commit**, never across a VM close. Long steps run between two short holds, and the group is **reserved** meanwhile (section 3). Every transition in 2.4 calls `admit` inside the same `tx` that stores its own change. No other code path may store those fields.

### 2.4 Every entry point

| Entry point                                                | Request kind | What `admit` does                                                                                                                |
| ---------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Create (`createSession`: API, PiP, extension `host`)       | `join`       | New tree joins its group. Group sandboxed: starts sandboxed if the person may choose, else refused. New-session setting applies. |
| Fork (`commands.fork`)                                     | `join`       | Copies the source doc in the same commit, then as create.                                                                        |
| Terminal continue (`continuePiSession`)                    | `join`       | As create, with the cwd of the Pi terminal file.                                                                                 |
| Linked start (`linked-sessions.ts` `start`)                | `join`       | Inherits the parent's doc. Another folder only if allowed, and still sandboxed.                                                  |
| Subagent spawn                                             | `child`      | Child joins its root's tree in the commit that makes it. It reads the root doc, so no copy can be stale.                         |
| Move or configure (`configure({ cwd })`, any conversation) | `move`       | Release first if the VM mounts the old folder. Then `join` for the new folder. A child's move is a move of the whole tree.       |
| Worktree add (create with `worktree`)                      | `join`       | The worktree folder is the new cwd. The worktree's git dir stays read-only to the guest.                                         |
| Worktree remove                                            | `move`       | Release (the VM mounts the folder to be deleted), delete, then `join` the original folder.                                       |
| Archive                                                    | `leave`      | Release the VM. Host work keeps the tree live (2.5).                                                                             |
| Unarchive                                                  | `join`       | Whole tree, children too. The stored doc applies; refused if the group would mix.                                                |
| Remove (`session-cleanup.ts`)                              | `leave`      | Needs archived and idle. Release before the folders are touched.                                                                 |
| Turn on                                                    | `on`         | Section 3.                                                                                                                       |
| Turn off                                                   | `off`        | Section 3.                                                                                                                       |
| Server start                                               | `reconcile`  | Audits every group for I1. Reaps recorded runners (4.5). A mixed group blocks VM starts and notifies the owner.                  |
| Module enable                                              | `reconcile`  | Provider registers. Revocation marks clear. VMs start lazily.                                                                    |
| Module disable                                             | `suspend`    | Revoke all, prove all gone, then unregister. A VM that cannot be proved gone keeps its session `suspended` (I4).                 |

PiP conversations and `ssh://` workspaces have no folder here. A sandbox on an `ssh://` folder is refused.

### 2.5 Archived sessions that still have host work

Archive does not stop schedules, hooks, repo watches, or background tasks. So an archived plain tree with `hostWork` stays a **live member** of its group (I3). It blocks turn-on beside it, and blocks a sandboxed join of its folder. It leaves the group only when `hostWork` is empty. A leftover daemon of an ended task counts as work. `hostWork` is read from the task graph **and** the background records.

An archived sandboxed tree has no VM (archive released it) and no host work. It leaves the group. Unarchive is a full `join`.

## 3. Turn-on and turn-off

**Barrier.** Every host-touching action first takes a **lease** from `Sandboxes`: `lease(tree, kind)`. Tool calls, `!`, goal checks, browser launches, task starts, and confined file access all take one. A lease is granted only in `stable` phase. In any other phase it **waits**, then re-resolves the environment from the new state. `env()` is the only source of an `ExecutionEnv`, and it takes the lease. So no call can begin on the old side after a commit.

**Turn on.**

1. Plan (short hold): check preconditions, group, a **fresh** trusted-places walk, and `hostWork`. Set `phase = turning-on` and reserve the group.
2. Wait out the barrier. Leases that are host-executing: **refuse** with a 409 naming them. Nothing is killed silently.
3. Commit (short hold): re-check I1 (reservation makes it hold), then store `on` for the root. Children need no write.
4. Phase `stable`. Release the reservation.

A refused turn-on never has a VM. Nothing starts before step 3.

**Turn off.** (A session that Joins a reserved group is refused with a retry message.)

1. Plan: check the group. Reserve it. `phase = turning-off`. The final overlap check is **here**, before anything is revoked.
2. **Revoke**: the provider marks the tree revoked. No lease, browser, shell, or task can start a VM. The mark outlives the VM entry.
3. **Prove gone**: stop jobs and pages, close the VM, and show the runner dead by its recorded identity. Retry. Kill the process group only when the identity still matches.
4. Commit: store `off`. Clear the reservation. Clear the revocation only when core stores `on` again.

**Failures.** If step 3 cannot be proved, the phase becomes `suspended`. The stored value stays `on`. Calls fail closed with the reason. The owner can retry turn-off, or resume (clear the revocation). The group stays reserved against plain joins. A failed turn-off therefore never leaves a half state: stored `on` is always honoured, either by a VM or by a refusal.

## 4. Component contracts

### 4.1 Core sandbox state (`sandbox.ts`)

Owns: the doc, `phase`, the exclusive queue, `admit`, leases, groups, `rootOf`, the platform gate, and `host.sandbox` (register, get, set, release, keepOn). It never imports Gondolin.

- Contract with a provider: `env`, `release` (resolves only after teardown; a rejection keeps the sandbox on), `jobs`, `browser`, `folderProblem`, `mayChoose`. `release` is in `types/pocket.d.ts` and in `docs/extensions/sandboxes.md` from the first PR.
- Registrations live in a removable list. The newest live one serves. A disposed provider never returns.
- A conversation of a sandboxed tree gets either the provider's env or a **failing** env. Never the host env.

### 4.2 Confined file access (`confined.ts`)

Every Pocket host read, write, list, or delete in a folder that a sandboxed tree uses goes through one API. It opens the folder once, then walks one name at a time with `openat` and `O_NOFOLLOW`. It refuses every link and every name that is not a plain name. It fails closed off Linux and on any error. Callers hold a lease.

Covered: Files, Changes (including undo), uploads, the file viewer, `@` mentions, images, downloads, option values, `/skill` expansion, and the loaders for project skills, prompts, and context files (regular files only; size and count caps). Confinement is decided on the **requested** path, **before** any link is resolved.

### 4.3 Trusted places (`trusted-places.ts`)

A read-write sandbox is refused when Pi or Pocket code, config, or instructions are reachable inside the shared folder. Reachable means: the folder is, holds, or lies inside a trusted place, or a link under a trusted place leads into or through the folder.

Trusted places are: Pocket's install, data, extension, and theme folders; `~/.pi`, `~/.agents`, `~/.ssh`, `~/.gnupg`, and similar private places; every path named in Pi's `settings.json` and `mcp.json` (skills, prompts, extensions, themes, packages, path-valued commands, MCP commands and path-like args), resolved with Pi's rules, **missing targets included**. The managed `worktrees` folder is allowed.

The walk follows no links in the shared folder. Links under trusted roots are followed once each (device/inode; cycles end). **A walk that cannot finish refuses.** That covers an entry cap, a time cap, an unreadable folder, and an unparsable settings file. An unfinished first look is a refusal. The extension loader refuses a module whose real path lies in a sandboxed folder. The walk is fresh at turn-on and rechecked before any VM start.

### 4.4 The Git boundary (Design A)

Git's own model, nothing more:

- **Every git dir is read-only to the guest, through any path.** Outside the folder it is a read-only mount. Inside it, the folder's provider returns `EROFS` for every write (open for write, mkdir, rmdir, unlink, rename, link, symlink, chmod, copy). Hard links are checked at both ends. A folder that holds a git dir cannot be renamed.
- **No `.git` name may be written**, by Git's equivalence rules (case, trailing dots and spaces, NTFS short names, streams, HFS+ ignorable characters).
- **Which git dirs.** A descriptor walk of the folder (no links) finds each `.git` entry, each folder named by a `.git` file (with or without a back-pointer), each linked worktree's common dir, and bare-looking folders. Host Git is asked about the repository above the folder. A folder that cannot be read refuses a read-write VM. A session folder that is or lies inside a git dir is refused.
- **Repository-scope config** (local and worktree, submodules and bare repos too, listed with an explicit `--git-dir`) may hold only keys in `DATA_KEYS`, an allow-list. Any other key means read-only for that VM. Global and system config belong to the machine.
- **Hooks and includes** are checked along the full link chain: the hooks dir, each hook, each config file (existing or not), each `include` and `includeIf` target (`~`, `~user`, relative forms exactly as Git expands them). Each name is `lstat`'d and each link read, with no lexical clean-up. If any step lies in the folder outside a git dir, the VM is read-only. A link inside any git dir that leads into or through the folder also refuses. If Git cannot be asked, the VM is read-only.
- **No per-file deny or allow lists** for git internals. Every such list went stale in #415.
- **Guest Git reads, never writes.** One message says to commit on the host. `GIT_OPTIONAL_LOCKS=0`. Commits happen on the host.
- **Host Git runs hardened:** no inherited `GIT_*`, `safe.bareRepository=explicit`, the repository pinned, filters neutralised for sandboxed folders, `runGh` stripped too.
- Files with `nlink > 1` are never changed in place (`EPERM`).

### 4.5 The VM driver and its lifecycle (module `pocket-gondolin`)

The driver sits behind a `SandboxDriver` interface (a fake in tests). Gondolin is not a dependency; Set up installs it into `<data>/gondolin`. No port is opened on the host.

**Per entry:** `generation` (a start under way checks it), one `closing` promise (every later end waits), `stuck`, and `revoked`.

**Runner ledger.** The runner's identity (pid, start time, command line from `/proc`) is recorded **the moment the runner exists**, before the boot ends. A boot that fails carries its VM, and it is closed with the same proof. The ledger is written atomically (temp file, fsync, rename). A record that cannot be read or written refuses every start and release. It is never taken for empty. Every `release` also ends recorded runners of that session that the manager does not hold. A process of another identity is never killed.

**Proof of gone.** Three answers: gone, alive, unknown. Unknown counts as alive. A failed close is retried. A runner that outlives the close is killed with its process group, only when its identity still matches.

**Launcher (recommended; open decision).** Start the runner through `setpriv --pdeathsig=KILL`, so a dead server takes its VMs with it. Without it, a crash leaves a runner until the next start reaps it.

**Where the ledger lives (recommended: core).** Then `release` and `suspend` can prove gone even when the module is off or broken.

Also: no throw may escape an event, timer, or callback. A failure keeps the record, still ends the VM, tells the session, and goes to the module's notice. Idle stop, folder-change stop, and crash handling follow the same one lifecycle. A VM records its own rules and mount. Stricter settings stop a looser VM before any call uses it. A VM mounted for another folder is replaced.

### 4.6 The host tool gate

An **allow list** in core. A tool not listed is a host tool and is blocked.

- Allowed: `ask`, `ui`, `memory`, `schedule`, `tool_search`, `subagent`, `team`, `codemode` (its calls pass the gate again), plan and goal tools, and `artifact` **without any path anywhere** in the arguments (including `assets[].path`, at any depth).
- Routed to the VM: `bash`, `read`, `write`, `edit`, `!`, goal checks, `background`, `browser`.
- Blocked by default: session tools, `design_*`, `watch_pr`, MCP tools, other extensions' tools. The owner may allow them (setting).
- Team: a child is sandboxed in the parent's folder. A child may reach only sandboxed sessions.

## 5. Findings from #415, by class

Each class names the element that makes it **impossible**, not only fixed. The last three Greptile findings on `322a8780` had no reply yet. They are in A, and they are the reason for the redesign. Rounds that only Tanner's review requests describe (the second and third reviews of the Git rules, the trusted-roots rounds) are included too.

**A. An entry point missed the shared lock or part of the tree** (the root cause of the redesign).

| Finding (#415)                                                                     | Element                                              |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| New children miss the sandbox (spawn races turn-on)                                | `rootOf`: a child has no doc of its own              |
| Existing children miss the sandbox (unarchive of a root)                           | `rootOf`, plus whole-tree `join` on unarchive        |
| Archived work bypasses folder protection                                           | I3: archived trees with `hostWork` stay in the group |
| Failed turn-off disables the VM (final check after release)                        | Final check **before** revoke; `suspended` phase     |
| Host work survives sandboxing                                                      | Turn-on refuses while host work or leases exist      |
| Moved sessions keep old mounts                                                     | `move` releases, and a VM records its mount          |
| Subagent moves, worktree removal, linked starts (later reviews and `hostfs17` WIP) | The table in 2.4; I6 source test                     |
| Host pages survive sandboxing; browser launches, goal checks, `linkedFolder` races | Leases: everything takes one                         |

**B. Host Git or Pocket runs guest-written code.**

| Finding (#415)                                                                                               | Element                                                                                            |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `commondir` writable; custom hooks path; receive hooks; submodule hooks; separate git dir; sequencer state   | Every git dir read-only as a whole (4.4)                                                           |
| fsmonitor and other scripts named in config; included settings; `~user` includes                             | Repo-scope key allow-list; exact include expansion                                                 |
| Effective-value, dangling-link, and `..` normalisation findings                                              | Link-chain walk with no lexical clean-up; refuse only paths the guest can change; no per-key rules |
| Split-index fails under an allow-list of files                                                               | No file lists at all                                                                               |
| Links inside git dirs; bare and nested repositories; the repository above; missing config paths; `nlink` > 1 | Descriptor walk, chain checks, `EPERM`                                                             |
| Inherited `GIT_*`; Pocket's own Git trusting config                                                          | Hardened host Git                                                                                  |

**C. Host reads or writes follow a guest link.**

| Finding (#415)                                                       | Element                                     |
| -------------------------------------------------------------------- | ------------------------------------------- |
| Mentioned links expose host files; images, downloads, viewer         | Confined API, decided on the requested path |
| Skills, prompts, context files, option values, `/skill` loaded by Pi | Confined loaders only                       |
| Artifacts expose host files through `assets[].path`                  | Gate: no path anywhere                      |

**D. Trusted code reachable from the folder.**

| Finding (#415)                                                                                   | Element                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Home mounts expose secrets; trusted roots; links under trusted roots                             | Trusted places (4.3), walk refuses if unfinished |
| Config-named paths in `settings.json` and `mcp.json`; configured arguments; the extension loader | Same set, Pi's resolution rules; resolve hook    |

**E. VM lifecycle and records.**

| Finding (#415)                                                                                | Element                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Turn-off finishes before teardown; a second stop returns early; close errors swallowed        | Release order (I5), `closing` promise            |
| Crashed VMs stay marked running; VM cleanup errors escape                                     | One lifecycle; nothing throws out of an event    |
| Pid reuse, retried close, unreadable `/proc`, damaged record, disposal                        | Identity ledger, I7, atomic records, `suspended` |
| Calls lose their VM to the idle timer; new tasks end themselves; parallel starts lose records | One entry lifecycle; reserve before spawn        |
| Finished tasks keep memory; the VM list goes stale                                            | Bounded task records; coalesced change events    |
| Reload restores a dead provider; the public `release` type was missing                        | Registration list; types in PR 1                 |

**F. Rules drift.** Stricter settings leave a looser VM running: the VM records its own rules, and every call compares them first (4.5).

**G. Small and test findings.** First command used `sh`; Remove offered Set up; running text lost spaces (htm); tests piped through `tail` and passed on failure; macOS runs failed. Elements: pick the shell after ready; UI states tested with real htm; exit codes captured before pipes; Linux-only tests skip with a reason, and the platform seam is a constructor option, not a global.

## 6. Stacked PRs

Each PR reviews alone and keeps the app working. Tests listed must fail before the change.

1. **Core state and admission.** `sandbox.ts` (state, phases, leases, `rootOf`, `admit`, `exclusive`), the doc kind `pocket.sandbox`, the platform gate, the failing env, `release` and `keepOn` types and docs, and every entry point in 2.4 (`commands.ts`, `app.ts`, `linked-sessions.ts`, `subagents.ts`, `session-cleanup.ts`, `docs.ts`) against a fake provider. _Fail first:_ an entry-point test per row; the I6 source test; `one-folder.test.ts` and `sandbox-transitions.test.ts` cases (spawn race, unarchive tree, archived work, failed turn-off). _Salvage:_ `sandbox.ts` `admit`, `exclusive`, overlap; `hostfs17` tree logic.
2. **Confined host file access.** `confined.ts` plus every host reader and writer, the loaders, and `/skill`. _Fail first:_ `host-confinement*.test.ts`, `host-races.test.ts`, `confined-loaders.test.ts`, mention-link case. _Salvage:_ `confined.ts`.
3. **Trusted places and the tool gate.** `trusted-places.ts`, the loader resolve hook, the gate allow-list, the artifact rule. _Fail first:_ `trusted-roots.test.ts`; unfinished walk refuses; artifact `assets[].path`. _Salvage:_ `trusted-places.ts`.
4. **The Git boundary.** `policy.ts`, `git.ts` (guard, config allow-list, link-chain walk), hardened host Git in `git.ts`/`github.ts`. Testable on real folders without a VM. _Fail first:_ `gondolin-policy.test.ts`, `gondolin-git.test.ts`, the `.git` equivalence table. _Salvage:_ `policy.ts`, `git.ts` (the allow-list and chain walk only).
5. **VM driver, lifecycle, ledger.** `real-driver.ts`, `manager.ts`, the ledger, module shell `gondolin.ts` (off by default), guest env, Set up and the Linux check. _Fail first:_ `gondolin-lifecycle.test.ts`, `gondolin-close.test.ts`, `gondolin-env.test.ts`. _Salvage:_ `manager.ts`, `real-driver.ts`, `guest-env.ts`.
6. **Features in the VM.** Background tasks (`jobs.ts`), the browser in the VM, the sheet, settings, `team` rules. _Fail first:_ `gondolin-review.test.ts` (jobs), `gondolin-setup-ui.test.ts`. _Salvage:_ `jobs.ts`, `index.js`.

## 7. Test plan

**Deterministic gates (every OS unless marked):**

- Admission: one test per row of 2.4, plus a **source test** that fails if any file other than the admission module stores the guarded fields.
- Phases: held-gate tests for the barrier, the reservation, failed turn-off to `suspended`, and the release order.
- Fake driver: the leases, crash, close failure, and revocation. No test waits on time; gates are held in the fake.
- Policy tables: `.git` equivalence; config key allow-list; link chain compared with `realpath`/`readlink -f` on disk. _(Linux)_
- Confined walk: races and link swaps. _(Linux; the fail-closed guard runs everywhere by faking the platform.)_
- The platform gate: darwin, win32, freebsd refuse, via a constructor option.
- UI: each sheet state rendered with real htm; no two words run together.

**Real-VM tests (opt-in, Linux, KVM, package and image present; skip with a reason otherwise):** boot and exec; a SIGKILLed runner is noticed; release proves the runner gone; the git boundary with guest-written hooks that the host then does not run; a move while a task holds the VM; the browser in the VM; network modes. The PR states what ran.

**Linux only:** `/proc` identity tests, `openat` walks, real VM tests. **All platforms:** state machine, gate, fake-driver tests. CI runs the full suite on each PR's head; locally, run only the touched areas.

## 8. Open decisions for Tanner

1. **Launcher:** `setpriv --pdeathsig=KILL` (recommended) or none.
2. **Ledger home:** core (recommended) or the module.
3. **Archive with host work:** count as live (recommended) or stop its host work on archive.
4. **Turn-on with host work:** refuse (recommended; as #415) or offer to stop it.
5. **A mixed group at server start** (from before the rule): block VMs and notify (recommended) or auto-archive the plain side.
