/**
 * Sandboxed sessions, core state (sandbox v2, `docs/design/sandbox-v2.md`). A sandboxed tree (a session and its
 * subagents) runs its file and shell tools in a micro-VM, never on this machine. This module owns what an extension
 * cannot keep safe: the stored setting, the phases of a change, the admission point every entry point passes, the
 * leases that every piece of work holds, the readiness gate, the tool gate, and the environment that fails closed.
 * It never imports a VM package: a provider (a later PR) comes in through `register`.
 *
 * Nothing in this build can turn a sandbox on: the readiness gate (`readiness`) stays closed until every component of
 * the design is registered, and the last PR registers the last of them.
 */
import { BACKGROUND_CONTEXT, type Context, withCancel } from "@earendil-works/chord/context";
import {
    AgentDoc,
    configure,
    type ConversationId,
    LiveDoc,
    type Tx,
} from "@earendil-works/pi-durable";
import { type ExecutionEnv, ok } from "@earendil-works/pi-durable/env";
import type { PocketApp } from "./app.ts";
import type { Role, User } from "./config.ts";
import { type SessionMeta, SandboxDoc, SessionsDoc, SubagentsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { foldersOverlap, within } from "./folder-overlap.ts";
import {
    failedEnv,
    FILE_CALLS,
    hostToolBlocked,
    INERT_TOOLS,
    namesPath,
    RESOURCE_CALLS,
    ROUTED_BY_PROVIDER,
    ROUTED_TOOLS,
    TEAM_TOOL,
} from "./sandbox-tools.ts";
import { workFromDoc, type WorkEntry } from "./sandbox-work.ts";
import { workspaceScheme } from "./paths.ts";

const context = BACKGROUND_CONTEXT;

/** Where a tree stands in a change of its sandbox (design 2.1). `stable` is the only phase that grants a lease. */
export type Phase = "stable" | "turning-on" | "turning-off" | "moving" | "suspended";

/**
 * What the sandbox needs before it may turn on (design 4.1). Each PR registers its own, and the last registers the
 * last: until then every turn-on, and every join of a sandboxed group, is refused with "not available yet".
 */
export const READINESS_COMPONENTS = [
    "gate",
    "hostfs",
    "trusted-places",
    "git-boundary",
    "driver",
    "jobs",
    "browser",
    "team-rule",
    "mcp-launch",
] as const;
export type Component = (typeof READINESS_COMPONENTS)[number];

/** What a provider needs to know to serve one conversation. */
export interface SandboxTarget {
    readonly conversationId: ConversationId;
    /** The session: one VM serves it and its subagents. */
    readonly rootId: ConversationId;
    /** The folder the conversation works in, as a path on this machine. */
    readonly cwd: string;
}

export interface SandboxPerson {
    readonly id: string;
    readonly role: Role;
}

/** What a module gives core so that trees can run in its sandbox. Internal: not on `host`, not in the public types. */
export interface SandboxProvider {
    /** Whether this person may choose a sandbox (the owner always may). */
    mayChoose(person: SandboxPerson): boolean;
    /** Why a folder may not be a sandbox's folder, or undefined. */
    folderProblem?(cwd: string): string | undefined;
    /** The environment of one conversation's tools. */
    env(target: SandboxTarget): ExecutionEnv;
    /** Stop the VM of a session and what runs in it; resolves only after teardown. A rejection keeps the sandbox on. */
    release(rootId: ConversationId): Promise<void>;
    /** Background commands in the VM (a later PR). Without it, `background` is blocked. */
    jobs?(target: SandboxTarget): unknown;
    /** The browser in the VM (a later PR). Without it, `browser` is blocked. */
    browser?(target: SandboxTarget): unknown;
    /** Whether the rules the VMs run by are now stricter than the ones a running VM was made with. */
    stricter?(): boolean;
}

/** The trusted-places check (design 4.3). A later PR replaces the stub, which refuses every folder. */
export interface TrustedPlaces {
    /** Why `folder` may not be shared read-write, or undefined when it may. A check that cannot finish refuses. */
    check(folder: string): Promise<string | undefined>;
}

const refusesByDefault: TrustedPlaces = {
    check: (folder) =>
        Promise.resolve(
            `The places that this server and Pi load code from are not checked in this build, so ${folder} cannot be shared with a sandbox.`,
        ),
};

export type LeaseKind = "call" | "exec" | "file" | "page" | "task" | "spawn" | "host";
type VmKind = Exclude<LeaseKind, "host">;

/** A VM lease cannot be issued without a revoke handler (design 3): the type asks for it. */
export type LeaseRequest =
    | {
          kind: VmKind;
          /** The folder the work is bound to; the conversation's own when absent. */
          folder?: string;
          revoke: (reason: string) => void | Promise<void>;
      }
    | { kind: "host"; folder?: string; what?: string };

export interface Lease {
    readonly kind: LeaseKind;
    /** Whether the tree was sandboxed when the lease was granted. */
    readonly sandboxed: boolean;
    /** Ends the lease. Calling it again does nothing. */
    end(): void;
}

type LeaseRecord = {
    root: number;
    conversation: number;
    kind: LeaseKind;
    folder: string;
    what: string;
    revoke: ((reason: string) => void | Promise<void>) | undefined;
    ended: Promise<void>;
    finish: () => void;
};

/** What a change of the sandbox asks `admit` (design 2.3 and 2.4). */
export type Request =
    | {
          kind: "join";
          id: ConversationId;
          user: User;
          /** The session's catalogue entry, written here (invariant I6: one writer). Absent for PiP. */
          entry: SessionMeta;
          /** A session this one copies (a fork, a linked start): its tree's setting is copied in this commit. */
          copyFrom?: ConversationId;
          /**
           * With `copyFrom` sandboxed: the only folder the new session may work in (a linked start works in its
           * starter's folder, or one inside it; other folders are for a later setting).
           */
          sameFolder?: string;
      }
    | { kind: "child"; parent: ConversationId }
    | {
          kind: "move";
          user: User;
          /** Each conversation that moves, and where. The tree is the first one's. */
          moves: readonly { id: ConversationId; cwd: string }[];
          /** The session's entry follows the first move. */
          entry?: boolean;
      }
    | { kind: "leave"; id: ConversationId }
    | { kind: "remove"; id: ConversationId }
    | { kind: "enter"; id: ConversationId }
    | { kind: "work-add"; id: ConversationId; what: string }
    | { kind: "on"; id: ConversationId; user: User }
    | { kind: "off"; id: ConversationId; user: User };

/** A change that may stop a VM first (`Sandboxes.change`). */
export type ChangeSpec =
    | {
          kind: "move";
          user: User;
          /** The session the move is for (its tree is reserved). */
          id: ConversationId;
          /** The new folder as it was asked for, reserved before anything is looked up. */
          early?: readonly string[];
          /** Whether the session's own entry follows the move. Default true. */
          entry?: boolean;
      }
    | { kind: "leave" | "remove" | "enter"; id: ConversationId };

export type ChangeSteps<T> = {
    /** For a move: each conversation that moves and where, or a function that finds them (after the reservation). */
    moves?:
        | readonly { id: ConversationId; cwd: string }[]
        | (() => Promise<readonly { id: ConversationId; cwd: string }[]>);
    /** Runs after the VM is proved gone and before the commit (the folder of a removed worktree goes here). */
    afterRelease?: () => Promise<void>;
    commit: (tx: Tx) => Promise<T>;
    /** Whether the commit found nothing to change (a repeat of a call): admission then writes nothing. */
    skipAdmit?: (done: T) => boolean;
};

/** Options that only a constructor takes: nothing global, so a test seam cannot reach production. */
export interface SandboxOptions {
    /** The machine's platform; only tests name another. */
    platform?: string;
    /** Components that are present at open (tests; a later PR registers its own through `provide`). */
    components?: readonly Component[];
    trustedPlaces?: TrustedPlaces;
    /** How long a lease waits for a change to end, in milliseconds. Default 60 s. */
    waitMs?: number;
    /** How long a release waits for calls to stop, in milliseconds. Default 30 s. */
    drainMs?: number;
    /** How long a deferred delivery waits before it asks again, in milliseconds. */
    deferMs?: number;
    /** A timer, for tests that must not wait: resolves after `ms`, or when `signal` aborts. */
    timer?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * The delivery was not made now: nothing was deleted, and a durable caller asks again after `retryMs`. It is a 409 for
 * every other caller, so a person's message that meets a changing sandbox gets the reason and can try again.
 */
export class Deferred extends HttpError {
    readonly retryMs: number;

    constructor(reason: string, retryMs: number) {
        super(409, `${reason} Nothing was sent; try again in a moment.`);
        this.retryMs = retryMs;
    }
}

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal.aborted) {
            resolve();

            return;
        }

        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };

        const timer = setTimeout(done, ms);

        timer.unref?.();
        signal.addEventListener("abort", done, { once: true });
    });

type Reservation = { folders: string[]; roots: Set<number>; what: string };

export class Sandboxes {
    readonly #app: PocketApp;
    readonly #platform: string;
    readonly #present: Set<Component>;
    readonly #trusted: TrustedPlaces;
    readonly #waitMs: number;
    readonly #drainMs: number;
    readonly #deferMs: number;
    readonly #timer: (ms: number, signal: AbortSignal) => Promise<void>;
    /** Live registration; the newest serves. Undefined: no module. */
    #provider: { provider: SandboxProvider; owner: string | undefined } | undefined;
    /**
     * Registrations, replacements, and teardowns of the provider run one at a time, in order (design 4.1): a new provider
     * is installed only after the old one's teardown succeeded.
     */
    #serial: Promise<unknown> = Promise.resolve();
    /** Counts every change of the provider: an environment handle made under another generation is stale. */
    #generation = 0;
    /**
     * `lifecycle`: set by a provider change or by start; only a provider change or a reconcile clears it. Any other suspension
     * (a failed release, a failed step) needs an explicit recovery.
     */
    readonly #phases = new Map<number, { phase: Phase; reason?: string; lifecycle?: true }>();
    /**
     * The revision of each tree's phase: it counts every write, `stable` ones too, and never goes back or goes away (a
     * record that is deleted at `stable` could be told from a later one by nothing). A step that waits keeps the revision it
     * saw, or the one its own write made, and writes only while it is still the current one.
     */
    readonly #revisions = new Map<number, number>();
    /** The transitions under way (a change, a turn-on or turn-off, a resume, the rules): a provider change waits for them. */
    readonly #active = new Set<Promise<unknown>>();
    /** One release attempt for each tree at a time: a retry joins it, and a late one never follows a recovery. */
    readonly #releasing = new Map<number, Promise<void>>();
    readonly #changed = new Set<() => void>();
    /** Which roots are sandboxed, kept in step with their documents. */
    readonly #on = new Set<number>();
    readonly #leases = new Set<LeaseRecord>();
    readonly #reservations = new Set<Reservation>();
    /** What can make work later, by the document it comes from (`sandbox-work.ts`). */
    readonly #work = new Map<string, (WorkEntry & { folder: string })[]>();
    /** The folder each work item was first seen in: it stays in its tree's group while it lives (I3). */
    readonly #bound = new Map<string, string>();
    #exclusive: Promise<unknown> = Promise.resolve();
    /** What an audit found wrong (I1, I6); while set, no VM starts. */
    #blocked: string | undefined;
    /**
     * Counts every change that can alter a group: a setting, a folder, a session, live work, a lease, a phase. The answer
     * of `#grantProblem` is kept for one epoch (and a short while, as a folder may change on disk), so a call of a
     * plain tree does not walk every session when nothing changed.
     */
    #epoch = 0;
    readonly #granted = new Map<
        number,
        { epoch: number; at: number; problem: string | undefined }
    >();

    constructor(app: PocketApp, options: SandboxOptions = {}) {
        this.#app = app;
        this.#platform = options.platform ?? process.platform;
        this.#present = new Set<Component>(["gate", ...(options.components ?? [])]);
        this.#trusted = options.trustedPlaces ?? refusesByDefault;
        this.#waitMs = options.waitMs ?? 60_000;
        this.#drainMs = options.drainMs ?? 30_000;
        this.#deferMs = options.deferMs ?? 5_000;
        this.#timer = options.timer ?? delay;
    }

    // ─── Readiness and registration ─────────────────────────────────────────

    /** Why this machine cannot run a sandbox, or undefined: the guarantee is kept only where it can be enforced. */
    unsupported(): string | undefined {
        return this.#platform === "linux" ? undefined : "The sandbox runs on Linux only for now.";
    }

    /** A component of the design is registered (a later PR calls this). */
    provide(component: Component): void {
        this.#present.add(component);
    }

    /** Whether every component is present; when not, which are missing. */
    readiness(): { ready: boolean; missing: Component[] } {
        const missing = READINESS_COMPONENTS.filter((each) => !this.#present.has(each));

        return { ready: missing.length === 0, missing };
    }

    #notReady(): string | undefined {
        const { ready, missing } = this.readiness();

        return ready
            ? undefined
            : `The sandbox is not available yet in this build (missing: ${missing.join(", ")}).`;
    }

    get provider(): SandboxProvider | undefined {
        return this.#provider?.provider;
    }

    /**
     * Use `provider` until `unregister` is called. Awaited and serialised after the teardown of the provider that left;
     * it then reconciles, which lets the trees that waited for a module go on. The newest registration serves.
     */
    async register(
        provider: SandboxProvider,
        owner?: string,
    ): Promise<{ unregister: () => Promise<void> }> {
        return this.#serialised(async () => {
            const old = this.#provider;

            // A live provider is stopped first: its trees are suspended, its calls revoked, its VMs proved gone. When that
            // cannot be proved the old provider stays, and the new one is not installed.
            if (old !== undefined && old.provider !== provider) {
                try {
                    await this.#stop(old, true, "the sandbox module is being replaced");
                } catch (error) {
                    throw new HttpError(
                        409,
                        `The sandbox that is running could not be stopped, so the new one was not installed: ${describeError(error)}`,
                    );
                }
            }

            const mine = { provider, owner };

            this.#provider = mine;
            this.#generation++;

            if (provider.env !== undefined) {
                this.#present.add("driver");
            }

            if (provider.jobs !== undefined) {
                this.#present.add("jobs");
            }

            if (provider.browser !== undefined) {
                this.#present.add("browser");
            }

            await this.reconcile();

            return {
                unregister: () =>
                    this.#serialised(async () => {
                        if (this.#provider === mine) {
                            await this.#stop(mine, true, "the sandbox module went away");
                        }
                    }),
            };
        });
    }

    #serialised<T>(work: () => Promise<T>): Promise<T> {
        const run = this.#serial.then(work, work);

        this.#serial = run.then(
            () => undefined,
            () => undefined,
        );

        return run;
    }

    /**
     * Suspend every tree, revoke every lease, and prove every VM gone (I5). A failure throws, leaves the trees suspended
     * with the reason, and keeps the provider. `leave`: the provider goes after the proof.
     */
    async #stop(mine: { provider: SandboxProvider }, leave: boolean, why: string): Promise<void> {
        // A provider change never ends, or overwrites, a transition that it does not own: it waits until they are done.
        await this.#quiet();
        const roots = [...this.#on];

        // Only a tree that is stable, or suspended by a provider change, is suspended here; a suspension that another
        // transition left (a failed release, the rules) keeps its record, and the VM is stopped all the same.
        const owned = new Map<number, number>();

        for (const root of roots) {
            const current = this.#phases.get(root);

            if (current === undefined || current.lifecycle === true) {
                owned.set(root, this.#setPhase(root, "suspended", why, true));
            }
        }

        try {
            await this.#release(roots, why);
        } catch (error) {
            for (const [root, token] of owned) {
                this.#setIf(
                    root,
                    token,
                    "suspended",
                    `it could not be stopped (${describeError(error)})`,
                );
            }

            throw error;
        }

        if (leave && this.#provider === mine) {
            this.#provider = undefined;
            this.#generation++;
        }
    }

    // ─── What the app tells us as documents commit ──────────────────────────

    /** A document changed (`app.ts` calls this as documents commit, and while it recovers). */
    noteDoc(kind: string, id: ConversationId | undefined, value: unknown): void {
        // The sessions, their folders, and their subagents (a tree's folders are its conversations') change groups.
        if (
            kind === SessionsDoc.definition.kind ||
            kind === AgentDoc.definition.kind ||
            kind === SubagentsDoc.definition.kind
        ) {
            this.#epoch++;
        }

        if (kind === SandboxDoc.definition.kind && id !== undefined) {
            this.#epoch++;

            if ((value as { on?: boolean } | null)?.on === true) {
                this.#on.add(Number(id));
            } else {
                this.#on.delete(Number(id));
            }

            return;
        }

        if (kind === LiveDoc.definition.kind && id !== undefined) {
            // A run that ended leaves no call in flight: a call whose result hook did not run ends its lease here.
            if ((value as { run?: unknown } | null)?.run === undefined) {
                this.#runEnded(Number(id));
            }

            return;
        }

        const found = workFromDoc(kind, id, value, (root) => this.#rootOfNumber(root));

        if (found === undefined) {
            return;
        }

        const entries = found.entries.map((entry) => {
            const key = `${found.source}\u0000${entry.key}`;
            const folder = entry.folder ?? this.#bound.get(key) ?? this.#folderOfRoot(entry.root);

            this.#bound.set(key, folder);

            return { ...entry, folder };
        });
        const keep = new Set(entries.map((entry) => `${found.source}\u0000${entry.key}`));

        for (const key of this.#bound.keys()) {
            if (key.startsWith(`${found.source}\u0000`) && !keep.has(key)) {
                this.#bound.delete(key);
            }
        }

        this.#epoch++;

        if (entries.length === 0) {
            this.#work.delete(found.source);
        } else {
            this.#work.set(found.source, entries);
        }
    }

    #rootOfNumber(id: number): number {
        return Number(this.#app.rootOf(id as unknown as ConversationId));
    }

    #folderOfRoot(root: number): string {
        return this.#app.cwdOf(root as unknown as ConversationId);
    }

    /** Whether a tree is sandboxed, as stored (memory). */
    isOn(id: ConversationId): boolean {
        return this.#on.has(this.#rootOfNumber(Number(id)));
    }

    /** How many calls wait for a phase to end (tests look that none is left behind). */
    get waiting(): number {
        return this.#changed.size;
    }

    /** Whether any tree is sandboxed. A server with none pays nothing for the rest of this module. */
    get any(): boolean {
        return this.#on.size > 0;
    }

    phaseOf(id: ConversationId): Phase {
        return this.#phases.get(this.#rootOfNumber(Number(id)))?.phase ?? "stable";
    }

    /** Whether a sandboxed tree works in `cwd`, in a folder that holds it, or in one inside it: no project file is read there. */
    sandboxedAt(cwd: string): boolean {
        return (
            this.#on.size > 0 &&
            [...this.#on].some((root) =>
                this.#treeFolders(root).some((folder) => foldersOverlap(folder, cwd)),
            )
        );
    }

    /** The stated folders that sandboxed trees work in. */
    folders(): string[] {
        return [...this.#on].flatMap((root) => this.#treeFolders(root));
    }

    // ─── The queue ──────────────────────────────────────────────────────────

    /**
     * Run `work` alone among the changes that decide which trees share a folder: making a session, moving it, bringing
     * it back from the archive, and turning its sandbox on or off. It is held only for a plan or a commit, never across
     * a VM close.
     */
    exclusive<T>(work: () => Promise<T>): Promise<T> {
        const run = this.#exclusive.then(work, work);

        this.#exclusive = run.then(
            () => undefined,
            () => undefined,
        );

        return run;
    }

    // ─── Phases ─────────────────────────────────────────────────────────────

    /** Run a transition, and let a provider change see it under way (it waits for it, and never ends its phase). */
    #track<T>(work: () => Promise<T>): Promise<T> {
        const run = work();
        const done = () => void this.#active.delete(run);

        this.#active.add(run);
        run.then(done, done);

        return run;
    }

    async #quiet(): Promise<void> {
        while (this.#active.size > 0) {
            await Promise.allSettled([...this.#active]);
        }
    }

    #revision(root: number): number {
        return this.#revisions.get(root) ?? 0;
    }

    /** Write a phase, and answer the tree's new revision. */
    #setPhase(root: number, phase: Phase, reason?: string, lifecycle = false): number {
        this.#epoch++;
        const token = this.#revision(root) + 1;

        this.#revisions.set(root, token);

        if (phase === "stable") {
            this.#phases.delete(root);
            this.#told.delete(root);
        } else {
            this.#phases.set(root, {
                phase,
                ...(reason === undefined ? {} : { reason }),
                ...(lifecycle ? { lifecycle: true as const } : {}),
            });
        }

        for (const listener of [...this.#changed]) {
            listener();
        }

        // A transition that held the tree while the rules changed ends: the rules are checked for it now.
        if (phase === "stable" && this.#rulesRecheck.delete(root)) {
            queueMicrotask(() => {
                this.rules("the rules changed while it was changing", [root]).catch(
                    (error: unknown) =>
                        this.#app.log(
                            `Sandbox rules could not be applied: ${describeError(error)}`,
                        ),
                );
            });
        }

        return token;
    }

    /**
     * Write a phase only when the tree's revision is still `token`: the one its writer made, or the one it saw before it
     * waited. An async step checks this after every await before it writes, so it never clears or replaces a phase that
     * another transition owns, also one that began and ended while it waited. Answers the new revision, or undefined.
     */
    #setIf(
        root: number,
        token: number | undefined,
        phase: Phase,
        reason?: string,
        lifecycle = false,
    ): number | undefined {
        return this.#revision(root) === token
            ? this.#setPhase(root, phase, reason, lifecycle)
            : undefined;
    }

    #reserve(reservation: Reservation): void {
        this.#epoch++;
        this.#reservations.add(reservation);
    }

    #unreserve(reservation: Reservation): void {
        this.#epoch++;
        this.#reservations.delete(reservation);
    }

    /**
     * Wait until the tree's phase is `stable`, then run `grant` in the same tick (nothing can change between). In a
     * `turning-*` or `moving` phase this waits, with a bound; in `suspended` it fails at once, with the reason.
     */
    async #whenStable<T>(root: number, grant: () => T): Promise<T> {
        if (!this.#phases.has(root)) {
            return grant();
        }

        const stop = new AbortController();
        let timedOut = false;
        const bound = this.#timer(this.#waitMs, stop.signal).then(() => {
            timedOut = !stop.signal.aborted;
        });

        try {
            for (;;) {
                const at = this.#phases.get(root);

                if (at === undefined) {
                    return grant();
                }

                if (at.phase === "suspended") {
                    throw new HttpError(
                        409,
                        `This session's sandbox is suspended, so nothing ran: ${at.reason ?? "it was stopped"}`,
                    );
                }

                if (timedOut) {
                    throw new HttpError(
                        409,
                        "The sandbox of this session is changing and did not finish in time. Try again.",
                    );
                }

                let wake!: () => void;

                try {
                    await Promise.race([
                        bound,
                        new Promise<void>((resolve) => {
                            wake = resolve;
                            this.#changed.add(wake);
                        }),
                    ]);
                } finally {
                    // Whichever branch ended the wait, its callback goes.
                    this.#changed.delete(wake);
                }
            }
        } finally {
            stop.abort();
        }
    }

    // ─── Groups ─────────────────────────────────────────────────────────────

    #conversationsOf(root: number): number[] {
        return this.#app.conversationsOf(root as unknown as ConversationId).map(Number);
    }

    /** The folders of a tree: where its conversations work now, and where live work is bound (invariant I3). */
    #treeFolders(root: number): string[] {
        const found = new Set<string>();

        for (const conversation of this.#conversationsOf(root)) {
            found.add(this.#app.cwdOf(conversation as unknown as ConversationId));
        }

        for (const entries of this.#work.values()) {
            for (const entry of entries) {
                if (entry.root === root) {
                    found.add(entry.folder);
                }
            }
        }

        for (const lease of this.#leases) {
            if (lease.root === root) {
                found.add(lease.folder);
            }
        }

        return [...found].filter((folder) => workspaceScheme(folder) === undefined);
    }

    /** Whether a tree has work that can start more: not archived work items, or a lease (design 2.2, I3). */
    #hasWork(root: number): boolean {
        for (const entries of this.#work.values()) {
            if (entries.some((entry) => entry.root === root)) {
                return true;
            }
        }

        for (const lease of this.#leases) {
            if (lease.root === root) {
                return true;
            }
        }

        return false;
    }

    /** What stops a plain tree from leaving its folder behind: leases, tasks, daemons, hooks, watches bound there. */
    #boundWork(root: number, folder: string): string[] {
        const found: string[] = [];

        for (const entries of this.#work.values()) {
            for (const entry of entries) {
                if (entry.root === root && entry.kind !== "schedule" && entry.folder === folder) {
                    found.push(entry.what);
                }
            }
        }

        for (const lease of this.#leases) {
            if (lease.root === root && lease.folder === folder) {
                found.push(lease.what);
            }
        }

        return found;
    }

    /**
     * The other live trees whose folders overlap `folders`: not archived, or with work. A tree with no folder (PiP, a
     * remote workspace) is in no group.
     */
    #overlapping(
        items: Readonly<Record<string, SessionMeta>>,
        self: number,
        folders: readonly string[],
    ): { root: number; label: string }[] {
        const found: { root: number; label: string }[] = [];

        for (const [key, meta] of Object.entries(items)) {
            const root = Number(key);

            if (
                root === self ||
                meta.pip !== undefined ||
                workspaceScheme(meta.cwd) !== undefined ||
                (meta.archived === true && !this.#hasWork(root))
            ) {
                continue;
            }

            const there = this.#treeFolders(root);
            const direct = this.#conversationsOf(root).map((each) =>
                this.#app.cwdOf(each as unknown as ConversationId),
            );
            const reaches = (list: readonly string[]) =>
                folders.some((mine) => list.some((theirs) => foldersOverlap(mine, theirs)));

            if (reaches(there) || folders.some((mine) => foldersOverlap(mine, meta.cwd))) {
                // Work that stays behind keeps its tree here: say so, so the person knows what to stop.
                const left = reaches(direct) ? [] : this.#workNames(root, folders);

                found.push({
                    root,
                    label: `#${key} (${meta.title ?? meta.cwd}${left.length === 0 ? "" : `; ${left.slice(0, 2).join(", ")} still runs here`})`,
                });
            }
        }

        return found;
    }

    /** The live work of a tree that is bound to one of `folders`, in words. */
    #workNames(root: number, folders: readonly string[]): string[] {
        const found: string[] = [];
        const here = (folder: string) => folders.some((mine) => foldersOverlap(mine, folder));

        for (const entries of this.#work.values()) {
            for (const entry of entries) {
                if (entry.root === root && here(entry.folder)) {
                    found.push(entry.what);
                }
            }
        }

        for (const lease of this.#leases) {
            if (lease.root === root && here(lease.folder)) {
                found.push(lease.what);
            }
        }

        return found;
    }

    #named(list: readonly { label: string }[]): string {
        const first = list
            .slice(0, 3)
            .map((each) => each.label)
            .join(", ");

        return list.length > 3 ? `${first} and ${list.length - 3} more` : first;
    }

    /** A reservation that covers `folders` and is not `own`, as the words a refused request gets. */
    #reservedProblem(folders: readonly string[], own?: Reservation): string | undefined {
        for (const reserved of this.#reservations) {
            if (
                reserved !== own &&
                reserved.folders.some((held) => folders.some((mine) => foldersOverlap(held, mine)))
            ) {
                return `A change of the sandbox is under way for this folder (${reserved.what}). Try again in a moment.`;
            }
        }

        return undefined;
    }

    /** Why `root`, with the folders it uses, may not be in the sandbox state `on` beside the live trees there. */
    #mixing(
        sharing: readonly { label: string; boxed: boolean }[],
        on: boolean,
    ): string | undefined {
        const wrong = sharing.filter((each) => each.boxed !== on);

        if (wrong.length === 0) {
            return undefined;
        }

        return on
            ? `${this.#named(wrong)} ${wrong.length === 1 ? "uses" : "use"} this folder, or one inside it or around it, without a sandbox. While any session is sandboxed, no session may share its folder without one. Put them in the sandbox, or archive them, and then try again.`
            : `${this.#named(wrong)} ${wrong.length === 1 ? "is" : "are"} in a sandbox and ${wrong.length === 1 ? "uses" : "use"} this folder, or one inside it or around it. A session without a sandbox may not share it. Turn those off first, or archive them.`;
    }

    /** The audit after a commit: I1 for every live tree, and the two stores of each folder agree (I6). */
    audit(): string[] {
        const problems: string[] = [];
        const items = this.#app.sessionCatalogue();

        for (const [key, meta] of Object.entries(items)) {
            const root = Number(key);

            if (meta.pip !== undefined || workspaceScheme(meta.cwd) !== undefined) {
                continue;
            }

            const own = this.#app.cwdOf(root as unknown as ConversationId);

            if (own !== meta.cwd) {
                problems.push(
                    `Session #${key} has two folders on record (${meta.cwd} and ${own}).`,
                );
            }
        }

        if (this.#on.size > 0) {
            for (const root of this.#on) {
                const meta = items[String(root)];

                // An archived tree with no work is not in its group (I3): it cannot mix with a session that is.
                if (meta === undefined || (meta.archived === true && !this.#hasWork(root))) {
                    continue;
                }

                const mixed = this.#overlapping(items, root, this.#treeFolders(root)).filter(
                    (each) => !this.#on.has(each.root),
                );

                if (mixed.length > 0) {
                    problems.push(
                        `Session #${root} is in a sandbox and shares its folder with ${this.#named(mixed)}, without one.`,
                    );
                }
            }
        }

        return problems;
    }

    /** Run the audit and block, or unblock, VM starts; tells the owner once per change of the answer. */
    #audited(): void {
        const problems = this.audit();
        const now = problems.length === 0 ? undefined : problems.join(" ");

        if (now !== this.#blocked) {
            this.#blocked = now;
            this.#epoch++;

            if (now !== undefined) {
                this.#app.ownerNotice(
                    "warning",
                    `Sandboxes are blocked until this is fixed: ${now}`,
                );
            }
        }
    }

    // ─── Admission ──────────────────────────────────────────────────────────

    async #isOn(tx: Tx, root: number): Promise<boolean> {
        return (await tx.doc(SandboxDoc, root as unknown as ConversationId)).on === true;
    }

    /** Why a person may not choose a sandbox, or undefined. */
    #mayChoose(user: User): string | undefined {
        return user.role === "owner" || this.provider?.mayChoose(user) === true
            ? undefined
            : "Only the owner can choose the sandbox for a session.";
    }

    /**
     * What the folder, the trusted places, and the readiness gate say about `cwd` now, or undefined when the folder may be
     * shared. A check that cannot finish refuses.
     */
    async #folderProblem(cwd: string): Promise<string | undefined> {
        return (
            this.unsupported() ??
            this.#notReady() ??
            (workspaceScheme(cwd) === undefined
                ? undefined
                : "A sandbox does not support a remote workspace.") ??
            this.provider?.folderProblem?.(cwd) ??
            (await this.#trusted.check(cwd))
        );
    }

    /**
     * The rules for the conversations of a sandboxed tree, with the folders they would have (`resulting` overrides what
     * `cwdOf` says): each lies inside the session's folder (one VM serves the tree), is no remote workspace, and may be shared.
     * A turn-on and a move of a sandboxed tree ask it the same way, so the two cannot drift apart. Undefined when all hold.
     */
    async #treeProblem(
        root: number,
        rootCwd: string,
        resulting: ReadonlyMap<number, string>,
    ): Promise<string | undefined> {
        for (const conversation of this.#app.conversationsOf(root as unknown as ConversationId)) {
            const id = Number(conversation);

            if (id === root) {
                continue;
            }

            const there = resulting.get(id) ?? this.#app.cwdOf(conversation);

            if (workspaceScheme(there) !== undefined || !within(rootCwd, there)) {
                return `The subagent #${id} works in ${there}, outside the session's folder (${rootCwd}): a subagent of a sandboxed session works inside the session's folder. Move it into ${rootCwd}, or stop it, and then try again.`;
            }

            const refused = await this.#problemOf(there);

            if (refused !== undefined) {
                return `The subagent #${id} works in ${there}, which cannot be shared with a sandbox: ${refused}`;
            }
        }

        return undefined;
    }

    /** `#folderProblem`, with a check that throws taken as a refusal that says so. */
    async #problemOf(cwd: string): Promise<string | undefined> {
        try {
            return await this.#folderProblem(cwd);
        } catch (error) {
            return `The folder could not be checked (${describeError(error)}), so it is not known to be safe to share.`;
        }
    }

    /** What must hold before a tree may be (or join) sandboxed in `cwd`, or undefined when it may. */
    async #sandboxProblem(cwd: string, user: User): Promise<string | undefined> {
        return (
            this.unsupported() ??
            this.#notReady() ??
            (this.provider === undefined ? "The sandbox module is off." : undefined) ??
            this.#mayChoose(user) ??
            (workspaceScheme(cwd) === undefined
                ? undefined
                : "A sandbox does not support a remote workspace.") ??
            this.provider?.folderProblem?.(cwd) ??
            (await this.#trusted.check(cwd))
        );
    }

    /**
     * The one admission point: it reads the group, checks invariants I1–I3 and what the request needs, edits the `tx` it
     * is given, and refuses with a 409 or lets the commit go on. Call inside `exclusive`. With no sandbox anywhere it
     * only writes what it owns (the catalogue entry, the folders, the archive flag) and refuses nothing.
     */
    async admit(tx: Tx, request: Request): Promise<void> {
        switch (request.kind) {
            case "join":
                return this.#admitJoin(tx, request);
            case "child":
                return this.#admitChild(request);
            case "move":
                return this.#admitMove(tx, request);

            case "leave": {
                const meta = (await tx.doc(SessionsDoc)).items[String(request.id)];

                if (meta === undefined) {
                    throw new HttpError(404, "Not a session");
                }

                meta.archived = true;

                return;
            }

            case "remove":
                delete (await tx.doc(SessionsDoc)).items[String(request.id)];

                return;
            case "enter":
                return this.#admitEnter(tx, request);
            case "work-add":
                return this.#admitWork(tx, request);
            case "on":
                return this.#admitOn(tx, request);
            case "off":
                return this.#admitOff(tx, request);
        }
    }

    async #admitJoin(tx: Tx, request: Extract<Request, { kind: "join" }>): Promise<void> {
        const sessions = await tx.doc(SessionsDoc);
        const id = Number(request.id);
        const cwd = request.entry.cwd;
        const folder = request.entry.pip === undefined && workspaceScheme(cwd) === undefined;
        const copies =
            request.copyFrom !== undefined &&
            (await this.#isOn(tx, this.#rootOfNumber(Number(request.copyFrom))));

        if (copies && request.sameFolder !== undefined && !within(request.sameFolder, cwd)) {
            throw new HttpError(
                409,
                `This session runs in a sandbox, so a session it starts works in its folder (${request.sameFolder}), not in ${cwd}.`,
            );
        }

        if (folder && (this.#on.size > 0 || copies)) {
            const reserved = this.#reservedProblem([cwd]);

            if (reserved !== undefined) {
                throw new HttpError(409, reserved);
            }

            const sharing = await Promise.all(
                this.#overlapping(sessions.items, id, [cwd]).map(async (each) => ({
                    ...each,
                    boxed: await this.#isOn(tx, each.root),
                })),
            );
            const wanted = copies || sharing.some((each) => each.boxed);

            if (wanted) {
                const because = copies
                    ? "This session copies a sandboxed one, so it runs in a sandbox too"
                    : `${this.#named(sharing.filter((each) => each.boxed))} ${sharing.filter((each) => each.boxed).length === 1 ? "is" : "are"} in a sandbox and use${sharing.filter((each) => each.boxed).length === 1 ? "s" : ""} this folder, or one inside it or around it, so a session here must run in a sandbox too`;
                const problem = await this.#sandboxProblem(cwd, request.user);

                if (problem !== undefined) {
                    throw new HttpError(409, `${because}, but it cannot be put in one: ${problem}`);
                }

                const refused = this.#mixing(sharing, true);

                if (refused !== undefined) {
                    throw new HttpError(409, refused);
                }

                Object.assign(await tx.doc(SandboxDoc, request.id), {
                    on: true,
                    by: request.user.id,
                    at: Date.now(),
                });
            }
        } else if (!folder && copies) {
            throw new HttpError(
                409,
                "A sandbox does not support a session without a folder here (PiP or a remote workspace).",
            );
        }

        sessions.items[String(id)] = request.entry;

        // One writer, two stores (I6): the agent's folder is the entry's.
        if ((await tx.doc(AgentDoc, request.id)).cwd !== cwd) {
            await configure(tx, request.id, { cwd });
        }
    }

    #admitChild(request: Extract<Request, { kind: "child" }>): void {
        const at = this.#phases.get(this.#rootOfNumber(Number(request.parent)));

        if (at === undefined) {
            return;
        }

        throw new HttpError(
            409,
            at.phase === "suspended"
                ? `This session's sandbox is suspended, so it cannot start a subagent: ${at.reason ?? "it was stopped"}`
                : "The sandbox of this session is changing, so it cannot start a subagent now. Try again in a moment.",
        );
    }

    async #admitMove(tx: Tx, request: Extract<Request, { kind: "move" }>): Promise<void> {
        const first = request.moves[0];

        if (first === undefined) {
            return;
        }

        const root = this.#rootOfNumber(Number(first.id));
        const sessions = await tx.doc(SessionsDoc);
        const boxed = await this.#isOn(tx, root);
        const target = request.moves.find((each) => Number(each.id) === root);

        if (this.#on.size > 0 || boxed) {
            await this.#checkMove(tx, request, { root, boxed, target, items: sessions.items });
        }

        // One writer, two stores (I6): every folder that moves is written in this one commit.
        for (const move of request.moves) {
            await configure(tx, move.id, { cwd: move.cwd });
        }

        const meta = sessions.items[String(root)];

        if (request.entry !== false && meta !== undefined && target !== undefined) {
            meta.cwd = target.cwd;
        }
    }

    /** What a move needs when any sandbox exists: the join checks of the new place (design 2.4, `move`). */
    async #checkMove(
        tx: Tx,
        request: Extract<Request, { kind: "move" }>,
        at: {
            root: number;
            boxed: boolean;
            target: { id: ConversationId; cwd: string } | undefined;
            items: Readonly<Record<string, SessionMeta>>;
        },
    ): Promise<void> {
        const { root, boxed, target, items } = at;

        for (const move of request.moves) {
            if (boxed && workspaceScheme(move.cwd) !== undefined) {
                throw new HttpError(409, "A sandbox does not support a remote workspace.");
            }
        }

        // One VM serves a tree: every conversation of a sandboxed tree, as the move leaves it, is looked at with the rules a
        // turn-on uses, not only the folders that move.
        if (boxed) {
            const resulting = new Map(request.moves.map((move) => [Number(move.id), move.cwd]));
            const problem = await this.#treeProblem(
                root,
                target?.cwd ?? this.#folderOfRoot(root),
                resulting,
            );

            if (problem !== undefined) {
                throw new HttpError(409, problem);
            }
        }

        // Every folder that moves joins its new group: the session's own, and a subagent's too.
        for (const move of request.moves) {
            if (workspaceScheme(move.cwd) !== undefined) {
                continue;
            }

            const reserved = this.#reservedProblem([move.cwd], this.#reservationOf(root));

            if (reserved !== undefined) {
                throw new HttpError(409, reserved);
            }

            const others = await Promise.all(
                this.#overlapping(items, root, [move.cwd]).map(async (each) => ({
                    ...each,
                    boxed: await this.#isOn(tx, each.root),
                })),
            );
            const refused = this.#mixing(others, boxed);

            if (refused !== undefined) {
                throw new HttpError(
                    409,
                    boxed
                        ? refused
                        : `${refused} A session cannot move into a sandboxed folder without a sandbox: put it in the sandbox first.`,
                );
            }

            if (boxed) {
                const problem = await this.#sandboxProblem(move.cwd, request.user);

                if (problem !== undefined) {
                    throw new HttpError(
                        409,
                        `This folder cannot be shared with a sandbox: ${problem}`,
                    );
                }
            }
        }

        if (boxed || target === undefined || workspaceScheme(target.cwd) !== undefined) {
            return;
        }

        // A plain tree keeps its old folder in its group while work is bound there (I3). Once any sandbox exists, a
        // move that leaves such work behind is refused (design 3, Move): stop the work, or wait.
        const old = this.#folderOfRoot(root);
        const bound = this.#boundWork(root, old);

        if (bound.length > 0 && !foldersOverlap(old, target.cwd)) {
            throw new HttpError(
                409,
                `This session still has work bound to ${old}: ${bound.slice(0, 3).join("; ")}. Stop it, or wait until it ends, and then move the session.`,
            );
        }
    }

    async #admitEnter(tx: Tx, request: Extract<Request, { kind: "enter" }>): Promise<void> {
        const sessions = await tx.doc(SessionsDoc);
        const root = Number(request.id);

        if (this.#on.size > 0) {
            const boxed = await this.#isOn(tx, root);
            const reserved = this.#reservedProblem(
                this.#treeFolders(root),
                this.#reservationOf(root),
            );

            if (reserved !== undefined) {
                throw new HttpError(409, reserved);
            }

            const others = await Promise.all(
                this.#overlapping(sessions.items, root, this.#treeFolders(root)).map(
                    async (each) => ({ ...each, boxed: await this.#isOn(tx, each.root) }),
                ),
            );
            const refused = this.#mixing(others, boxed);

            if (refused !== undefined) {
                throw new HttpError(409, `It cannot be brought back from the archive. ${refused}`);
            }
        }

        const meta = sessions.items[String(root)];

        if (meta === undefined) {
            throw new HttpError(404, "Not a session");
        }

        meta.archived = false;
    }

    async #admitWork(tx: Tx, request: Extract<Request, { kind: "work-add" }>): Promise<void> {
        if (this.#on.size === 0) {
            return;
        }

        const root = this.#rootOfNumber(Number(request.id));
        const sessions = await tx.doc(SessionsDoc);
        const meta = sessions.items[String(root)];

        // A live tree is in its group already; a tree that left it (archived, no work) joins it again with this item.
        if (
            meta === undefined ||
            meta.pip !== undefined ||
            meta.archived !== true ||
            this.#hasWork(root)
        ) {
            return;
        }

        // A tree that gains work joins its group again: a change that reserves the folder (a turn-off of a neighbour, say)
        // has to be finished first, or the gain could break the rule that change checked.
        const reserved = this.#reservedProblem(this.#treeFolders(root), this.#reservationOf(root));

        if (reserved !== undefined) {
            throw new HttpError(409, `${request.what} cannot be added now. ${reserved}`);
        }

        const boxed = await this.#isOn(tx, root);
        const others = await Promise.all(
            this.#overlapping(sessions.items, root, this.#treeFolders(root)).map(async (each) => ({
                ...each,
                boxed: await this.#isOn(tx, each.root),
            })),
        );
        const refused = this.#mixing(others, boxed);

        if (refused !== undefined) {
            throw new HttpError(
                409,
                `${request.what} would make this archived session live again beside others in its folder. ${refused}`,
            );
        }
    }

    #reservationOf(root: number): Reservation | undefined {
        return [...this.#reservations].find((each) => each.roots.has(root));
    }

    /** What still runs on this machine for a tree: host leases, and work that survives (background tasks). */
    #hostWork(root: number): string[] {
        const found: string[] = [];

        for (const lease of this.#leases) {
            if (lease.root === root && lease.kind === "host") {
                found.push(lease.what);
            }
        }

        for (const entries of this.#work.values()) {
            for (const entry of entries) {
                if (entry.root === root && (entry.kind === "task" || entry.kind === "daemon")) {
                    found.push(entry.what);
                }
            }
        }

        return found;
    }

    async #admitOn(tx: Tx, request: Extract<Request, { kind: "on" }>): Promise<void> {
        const root = Number(request.id);
        const sessions = await tx.doc(SessionsDoc);
        const meta = sessions.items[String(root)];

        if (meta === undefined) {
            throw new HttpError(404, "Not a session");
        }

        const own = this.#reservationOf(root);
        const others = await Promise.all(
            this.#overlapping(sessions.items, root, this.#treeFolders(root)).map(async (each) => ({
                ...each,
                boxed: await this.#isOn(tx, each.root),
            })),
        );
        const reserved = this.#reservedProblem(this.#treeFolders(root), own);
        const refused = reserved ?? this.#mixing(others, true);

        if (refused !== undefined) {
            throw new HttpError(409, refused);
        }

        Object.assign(await tx.doc(SandboxDoc, request.id), {
            on: true,
            by: request.user.id,
            at: Date.now(),
        });
    }

    async #admitOff(tx: Tx, request: Extract<Request, { kind: "off" }>): Promise<void> {
        const doc = await tx.doc(SandboxDoc, request.id);
        const refused = this.#ownerChose(doc, request.user);

        if (refused !== undefined) {
            throw new HttpError(403, refused);
        }

        // The overlap that the plan checked is checked again where `off` is stored: nothing may have become live beside it.
        const sessions = await tx.doc(SessionsDoc);
        const boxed = (
            await Promise.all(
                this.#overlapping(
                    sessions.items,
                    Number(request.id),
                    this.#treeFolders(Number(request.id)),
                ).map(async (each) => ({ ...each, boxed: await this.#isOn(tx, each.root) })),
            )
        ).filter((each) => each.boxed);

        if (boxed.length > 0) {
            throw new HttpError(409, this.#mixing(boxed, false)!);
        }

        Object.assign(doc, { on: false, by: request.user.id, at: Date.now() });
    }

    #ownerChose(doc: { on?: boolean; by?: string }, user: User): string | undefined {
        return user.role !== "owner" &&
            doc.by !== undefined &&
            this.#app.config.userById(doc.by)?.role === "owner"
            ? "The owner chose this sandbox: only the owner can turn it off."
            : undefined;
    }

    // ─── Changes with a release ─────────────────────────────────────────────

    /**
     * A change that may have to stop a VM first (a move, archive, or removal of a sandboxed session; bringing a session
     * back): reserve, revoke, prove gone, and only then commit (I5). `commit` is the entry point's own commit body; it
     * runs in the hold, before `admit` writes with the request. The reservation of a move covers the union of the old and the
     * new group **before** any async preparation (`moves` as a function, and `early`, the folder as asked). With no
     * sandbox anywhere it is just the hold and the commit. A step that fails after the release leaves the tree
     * `suspended` with its old folder and setting, and a refusal (a 4xx) leaves it as it was.
     */
    change<T>(spec: ChangeSpec, steps: ChangeSteps<T>): Promise<T> {
        return this.#track(() => this.#change(spec, steps));
    }

    async #change<T>(spec: ChangeSpec, steps: ChangeSteps<T>): Promise<T> {
        const root = this.#rootOfNumber(Number(spec.id));

        const resolve = async (): Promise<Request> => {
            if (spec.kind !== "move") {
                return { kind: spec.kind, id: spec.id };
            }

            const moves =
                typeof steps.moves === "function" ? await steps.moves() : (steps.moves ?? []);

            return {
                kind: "move",
                user: spec.user,
                moves,
                ...(spec.entry === undefined ? {} : { entry: spec.entry }),
            };
        };

        const commit = (request: Request) =>
            this.exclusive(() =>
                this.#app.harness
                    .commit(async (tx) => {
                        // The entry point's own writes read the state as it was; admission then writes what it owns.
                        const done = await steps.commit(tx);

                        if (steps.skipAdmit?.(done) !== true) {
                            await this.admit(tx, request);
                        }

                        return done;
                    }, context)
                    .finally(() => this.#audited()),
            );

        // No shortcut for a server with no sandbox: a first turn-on could succeed while this prepares, and the change would end
        // without it. Every change reserves its folders and marks its tree before any preparation.
        const releases = spec.kind !== "enter" && this.#on.has(root);
        const reservation: Reservation = {
            folders: [
                ...this.#treeFolders(root),
                ...(spec.kind === "move" ? (spec.early ?? []) : []),
                ...(spec.kind === "move" && Array.isArray(steps.moves)
                    ? steps.moves.map((each) => each.cwd)
                    : []),
            ],
            roots: new Set([root]),
            what: `#${root}`,
        };

        // The token of this change's phase record: only it may end it.
        let token: number | undefined;

        // (1) Plan, in a short hold: reserve the union of the old and the new group before anything else.
        await this.exclusive(() => {
            const reserved = this.#reservedProblem(reservation.folders);

            if (reserved !== undefined) {
                throw new HttpError(409, reserved);
            }

            if (this.#phases.has(root)) {
                throw new HttpError(
                    409,
                    "The sandbox of this session is changing. Try again in a moment.",
                );
            }

            this.#reserve(reservation);
            token = this.#setPhase(root, "moving");

            return Promise.resolve();
        });

        // Set once the release began: a failure after that leaves the tree suspended until a recovery succeeds.
        let released = false;

        try {
            const request = await resolve();

            if (request.kind === "move") {
                // What preparation found (the folder as it really is) joins the reservation, if no one holds it.
                const added = request.moves.map((each) => each.cwd);
                const reserved = this.#reservedProblem(added, reservation);

                if (reserved !== undefined) {
                    throw new HttpError(409, reserved);
                }

                reservation.folders.push(...added);
            }

            // Admission is tried first, in a commit that is rolled back: a refused destination stops here, before a VM
            // is stopped or a folder is deleted.
            await this.#validate(request);

            if (releases) {
                released = true;
                await this.#release([root], "the session is being changed");
            }

            await steps.afterRelease?.();
            released = releases;

            const done = await commit(request);

            // A removed session is no sandboxed tree (its document may stay in storage).
            if (request.kind === "remove") {
                this.#on.delete(root);
            }

            this.#unreserve(reservation);
            this.#setIf(root, token, "stable");

            return done;
        } catch (error) {
            if (released) {
                // Section 3: a step that fails after the release leaves the tree suspended, with its old folder and
                // setting, and its group reserved, until an explicit recovery (`resume`) proves the teardown.
                this.#setIf(root, token, "suspended", describeError(error));
            } else {
                this.#unreserve(reservation);
                this.#setIf(root, token, "stable");
            }

            throw error instanceof HttpError
                ? error
                : new HttpError(409, `The session stays as it was: ${describeError(error)}`);
        }
    }

    /** Run admission for `request` in a commit that is rolled back: it throws what the real commit would refuse with. */
    async #validate(request: Request): Promise<void> {
        const rollback = new Error("validated");

        await this.exclusive(() =>
            this.#app.harness
                .commit(async (tx) => {
                    await this.admit(tx, request);

                    throw rollback;
                }, context)
                .catch((error: unknown) => {
                    if (error !== rollback) {
                        throw error;
                    }
                }),
        );
    }

    // ─── Leases ─────────────────────────────────────────────────────────────

    /** Why a lease may not be granted for `root` now (I1 at this moment, and a blocked audit), or undefined. */
    #grantProblem(root: number): string | undefined {
        const boxed = this.#on.has(root);

        if (boxed && this.#blocked !== undefined) {
            return `Sandboxes are blocked until this is fixed: ${this.#blocked}`;
        }

        if (!boxed && this.#on.size === 0) {
            return undefined;
        }

        // PiP has no folder in a group: it is plain beside whatever is sandboxed.
        if (this.#app.sessionMeta(root as unknown as ConversationId)?.pip !== undefined) {
            return undefined;
        }

        // A tree that is not live (archived, no work) gains work with a grant: a change that reserves its folder comes first.
        const meta = this.#app.sessionMeta(root as unknown as ConversationId);

        if (meta?.archived === true && !this.#hasWork(root)) {
            const reserved = this.#reservedProblem(
                this.#treeFolders(root),
                this.#reservationOf(root),
            );

            if (reserved !== undefined) {
                return reserved;
            }
        }

        const known = this.#granted.get(root);
        const now = Date.now();

        if (known !== undefined && known.epoch === this.#epoch && now - known.at < 2_000) {
            return known.problem;
        }

        const problem = this.#groupProblem(root, boxed);

        this.#granted.set(root, { epoch: this.#epoch, at: now, problem });

        return problem;
    }

    #groupProblem(root: number, boxed: boolean): string | undefined {
        const items = this.#app.sessionCatalogue();
        const folders = this.#treeFolders(root);
        const wrong = this.#overlapping(items, root, folders).filter(
            (each) => this.#on.has(each.root) !== boxed,
        );

        if (wrong.length === 0) {
            return undefined;
        }

        return boxed
            ? `This session is in a sandbox, and ${this.#named(wrong)} shares its folder without one, so nothing ran.`
            : `${this.#named(wrong)} ${wrong.length === 1 ? "is" : "are"} in a sandbox and share${wrong.length === 1 ? "s" : ""} this session's folder, so this session may not work there without one.`;
    }

    /**
     * Take a lease for a conversation's work. Leases are granted only in `stable`; in `turning-*` and `moving` this
     * waits, and in `suspended` it fails at once. The grant checks I1 for the tree's group at this moment. The lease
     * keeps its bound folder in the tree's group until it ends.
     */
    async lease(conversation: ConversationId, request: LeaseRequest): Promise<Lease> {
        const root = this.#rootOfNumber(Number(conversation));

        return this.#whenStable(root, () => {
            const problem = this.#grantProblem(root);

            if (problem !== undefined) {
                throw new HttpError(409, problem);
            }

            return this.#grant(root, Number(conversation), request);
        });
    }

    #grant(root: number, conversation: number, request: LeaseRequest): Lease {
        let finish!: () => void;
        const ended = new Promise<void>((resolve) => (finish = resolve));
        const record: LeaseRecord = {
            root,
            conversation,
            kind: request.kind,
            folder: request.folder ?? this.#app.cwdOf(conversation as unknown as ConversationId),
            what:
                request.kind === "host" && request.what !== undefined
                    ? request.what
                    : `a ${request.kind} lease`,
            revoke: request.kind === "host" ? undefined : request.revoke,
            ended,
            finish,
        };

        // What a cached admission depends on: the settings, the sessions and their folders, the subagents, the live work,
        // the leases, the reservations, the phases, and the audit. Each of them advances the epoch when it changes. A lease
        // changes it when it makes its tree live (the first one), or is bound outside its conversation's folder.
        const wasLive = this.#hasWork(root);
        const elsewhere =
            record.folder !== this.#app.cwdOf(conversation as unknown as ConversationId);

        this.#leases.add(record);

        if (!wasLive || elsewhere) {
            this.#epoch++;
        }

        return {
            kind: request.kind,
            sandboxed: this.#on.has(root),
            end: () => {
                if (this.#leases.delete(record)) {
                    // The last one ends: the tree may stop being live.
                    if (elsewhere || !this.#hasWork(root)) {
                        this.#epoch++;
                    }

                    record.finish();
                }
            },
        };
    }

    /** Leases that are live now, for a tree: what a turn-on or a move would have to wait for. */
    leasesOf(id: ConversationId): { kind: LeaseKind; folder: string; what: string }[] {
        const root = this.#rootOfNumber(Number(id));

        return [...this.#leases]
            .filter((lease) => lease.root === root)
            .map(({ kind, folder, what }) => ({ kind, folder, what }));
    }

    // ─── Deliveries ─────────────────────────────────────────────────────────

    /**
     * May a delivery to this tree be made now? Reads memory only and never waits: it runs inside the delivering
     * commit. Not in `stable`, or with I1 broken for the tree's group, the commit defers: the item and its checkpoint
     * stay, and the caller asks again later.
     */
    deliver(id: ConversationId): { ok: true } | { ok: false; reason: string; retryMs: number } {
        const root = this.#rootOfNumber(Number(id));
        const at = this.#phases.get(root);

        if (at !== undefined) {
            return {
                ok: false,
                reason:
                    at.phase === "suspended"
                        ? `This session's sandbox is suspended: ${at.reason ?? "it was stopped"}`
                        : "The sandbox of this session is changing.",
                retryMs: this.#deferMs,
            };
        }

        const problem = this.#grantProblem(root);

        return problem === undefined
            ? { ok: true }
            : { ok: false, reason: problem, retryMs: this.#deferMs };
    }

    /** `deliver` as a throw: what the one wrapper around `conversation.submit` calls (`deliver.ts`). */
    requireDelivery(id: ConversationId): void {
        const verdict = this.deliver(id);

        if (!verdict.ok) {
            this.noteDeferred(id, verdict.reason);

            throw new Deferred(verdict.reason, verdict.retryMs);
        }
    }

    /** What was told about a deferred delivery, by session: one note for each wait, not one for each try. */
    readonly #told = new Map<number, string>();

    /** A delivery was deferred: the session gets one note for the wait (the item itself stays where it was). */
    noteDeferred(id: ConversationId, reason: string): void {
        const root = this.#rootOfNumber(Number(id));

        if (this.#told.get(root) === reason) {
            return;
        }

        this.#told.set(root, reason);
        this.#app.notice("info", reason, root as unknown as ConversationId);
    }

    /** How long a deferred delivery waits, as the caller's back-off. */
    get deferMs(): number {
        return this.#deferMs;
    }

    // ─── Release (I5) ───────────────────────────────────────────────────────

    /**
     * Revoke, then prove gone: every lease of these trees is revoked and ended, and then the provider closes the VM.
     * Throws when something does not stop, or the provider cannot close: the setting stays on, and nothing was lost.
     * The callers set a phase before they call, so no new lease is granted meanwhile.
     */
    async #release(roots: readonly number[], reason: string): Promise<void> {
        // One bound on the whole attempt: a revoke handler that never settles, a lease that never ends, or a provider that
        // never closes leaves the caller with a failure (the tree stays suspended), not with a wait that never ends.
        const stop = new AbortController();
        const timeout = this.#timer(this.#drainMs, stop.signal).then(() =>
            stop.signal.aborted
                ? new Promise<never>(() => {})
                : Promise.reject(
                      new Error(
                          "the release did not finish in time, so it is not known to be gone",
                      ),
                  ),
        );
        const attempt = Promise.all(roots.map((root) => this.#releaseOne(root, reason)));

        // The attempt may fail after the bound: that failure is no one's to handle any more.
        attempt.catch(() => undefined);

        try {
            await Promise.race([attempt, timeout]);
        } finally {
            stop.abort();
        }
    }

    /**
     * Wait until no release is in flight for the tree (also one that a bound gave up on), and answer why it failed, if it
     * did. Nothing reopens a tree while a release runs: every path that would restore `stable` waits here first.
     */
    async #idle(root: number): Promise<Error | undefined> {
        while (this.#releasing.has(root)) {
            try {
                await this.#releasing.get(root);
            } catch (error) {
                return error instanceof Error ? error : new Error(String(error));
            }
        }

        return undefined;
    }

    /**
     * The release of one tree: one attempt at a time. A retry, or a recovery, joins the attempt that is under way (also one
     * that the bound gave up on), so a late release never runs after a recovery has reopened the tree.
     */
    #releaseOne(root: number, reason: string): Promise<void> {
        const going = this.#releasing.get(root);

        if (going !== undefined) {
            return going;
        }

        const run = this.#releaseAttempt([root], reason).finally(() => {
            if (this.#releasing.get(root) === run) {
                this.#releasing.delete(root);
            }
        });

        this.#releasing.set(root, run);
        run.catch(() => undefined);

        return run;
    }

    async #releaseAttempt(roots: readonly number[], reason: string): Promise<void> {
        const mine = [...this.#leases].filter((lease) => roots.includes(lease.root));
        const failures: string[] = [];

        await Promise.all(
            mine.map(async (lease) => {
                try {
                    await lease.revoke?.(reason);
                } catch (error) {
                    failures.push(describeError(error));
                }
            }),
        );
        await Promise.all(mine.map((lease) => lease.ended));

        if (failures.length > 0) {
            throw new Error(failures.join("; "));
        }

        for (const root of roots) {
            await this.provider?.release(root as unknown as ConversationId);
        }
    }

    // ─── Turn on, turn off, resume ──────────────────────────────────────────

    /** Put a session in the sandbox. The readiness gate refuses it in this build. */
    turnOn(id: ConversationId, user: User): Promise<void> {
        return this.#track(() => this.#turnOn(id, user));
    }

    async #turnOn(id: ConversationId, user: User): Promise<void> {
        const app = this.#app;
        const root = Number(id);

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (app.parentOf(id) !== undefined) {
            throw new HttpError(
                400,
                "The sandbox is set for the whole session, in its main conversation.",
            );
        }

        if (this.#on.has(root)) {
            return;
        }

        const reservation: Reservation = { folders: [], roots: new Set([root]), what: `#${root}` };

        let token: number | undefined;

        // (1) Plan, in a short hold: the preconditions, a fresh trusted-places check, and the reservation.
        await this.exclusive(async () => {
            const cwd = app.cwdOf(id);
            const problem = await this.#sandboxProblem(cwd, user);

            if (problem !== undefined) {
                throw new HttpError(409, problem);
            }

            // Every conversation of the tree, not the root only: one VM serves them all, in the session's folder.
            const treeProblem = await this.#treeProblem(root, cwd, new Map());

            if (treeProblem !== undefined) {
                throw new HttpError(409, treeProblem);
            }

            // A VM that is still being stopped is not a place to start another in.
            if (this.#releasing.has(root)) {
                throw new HttpError(
                    409,
                    "The VM of this session is still being stopped. Try again in a moment.",
                );
            }

            if (this.#phases.get(root) !== undefined) {
                throw new HttpError(
                    409,
                    "The sandbox of this session is changing. Try again in a moment.",
                );
            }

            reservation.folders = this.#treeFolders(root);

            const reserved = this.#reservedProblem(reservation.folders);

            if (reserved !== undefined) {
                throw new HttpError(409, reserved);
            }

            this.#reserve(reservation);
            token = this.#setPhase(root, "turning-on");
        });

        try {
            // (2) Drain: host work is refused, never killed silently.
            const host = this.#hostWork(root);

            if (host.length > 0) {
                throw new HttpError(
                    409,
                    `This session still runs work on this machine: ${host.join("; ")}. A sandbox cannot take that work over. Stop it, or wait until it ends, and then turn the sandbox on.`,
                );
            }

            // (3) Commit, in a short hold: I1 again, and the setting on the root.
            await this.exclusive(() =>
                app.harness.commit((tx) => this.admit(tx, { kind: "on", id, user }), context),
            );

            // Pages of this machine's browser end now: a sandboxed session has none of its own.
            await Promise.all(
                app
                    .conversationsOf(id)
                    .map((each) => app.browsers.close(Number(each)).catch(() => undefined)),
            );
        } finally {
            // (4) A refusal at any step sets `stable` at once: nothing was revoked, so nothing rolls back.
            this.#unreserve(reservation);
            this.#setIf(root, token, "stable");
            this.#audited();
        }
    }

    /**
     * Take a session out of the sandbox: check the overlap before anything is revoked, revoke, prove gone, then commit.
     * A failed release or commit leaves the tree `suspended` with its setting on: every call fails at once with the
     * reason, and the group stays reserved against plain joins. A later turn-off, or `resume`, retries.
     */
    turnOff(id: ConversationId, user: User): Promise<void> {
        return this.#track(() => this.#turnOff(id, user));
    }

    async #turnOff(id: ConversationId, user: User): Promise<void> {
        const app = this.#app;
        const root = Number(id);

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (app.parentOf(id) !== undefined) {
            throw new HttpError(
                400,
                "The sandbox is set for the whole session, in its main conversation.",
            );
        }

        const reservation: Reservation = { folders: [], roots: new Set([root]), what: `#${root}` };
        let token: number | undefined;

        // (1) Plan: the overlap check is here, before any revoke.
        await this.exclusive(async () => {
            if (!this.#on.has(root)) {
                throw new HttpError(409, "This session is not in a sandbox.");
            }

            const doc = await app.harness.snapshot(SandboxDoc, id, context);
            const refused = this.#ownerChose(doc ?? {}, user);

            if (refused !== undefined) {
                throw new HttpError(403, refused);
            }

            const current = this.#phases.get(root);

            if (current !== undefined && current.phase !== "suspended") {
                throw new HttpError(
                    409,
                    "The sandbox of this session is changing. Try again in a moment.",
                );
            }

            reservation.folders = this.#treeFolders(root);

            const items = app.sessionCatalogue();
            const boxed = this.#overlapping(items, root, reservation.folders).filter((each) =>
                this.#on.has(each.root),
            );

            if (boxed.length > 0) {
                throw new HttpError(
                    409,
                    this.#mixing(
                        boxed.map((each) => ({ ...each, boxed: true })),
                        false,
                    )!,
                );
            }

            // A retry from `suspended` replaces the reservation that the failed attempt kept.
            this.#dropReservations(root);
            this.#reserve(reservation);
            token = this.#setPhase(root, "turning-off");
        });

        try {
            // (2) and (3): revoke, drain, prove gone.
            await this.#release([root], "the sandbox is being turned off");
        } catch (error) {
            this.#setIf(
                root,
                token,
                "suspended",
                `it could not be stopped (${describeError(error)})`,
            );

            throw new HttpError(
                409,
                `The sandbox could not be stopped, so it stays on and is suspended: ${describeError(error)}`,
            );
        }

        try {
            // (4) Commit off.
            await this.exclusive(() =>
                app.harness.commit((tx) => this.admit(tx, { kind: "off", id, user }), context),
            );
            this.#dropReservations(root);
            this.#setIf(root, token, "stable");
        } catch (error) {
            this.#setIf(
                root,
                token,
                "suspended",
                `the setting could not be stored (${describeError(error)})`,
            );

            throw error;
        } finally {
            this.#audited();
        }
    }

    /** The owner resumes a suspended tree: it retries the release, and goes back to `stable` when that works. */
    resume(id: ConversationId): Promise<void> {
        return this.#track(() => this.#resume(id));
    }

    async #resume(id: ConversationId): Promise<void> {
        const root = Number(id);
        const at = this.#phases.get(root);

        if (at?.phase !== "suspended") {
            return;
        }

        const token = this.#setPhase(root, "turning-off", at.reason);

        try {
            await this.#release([root], "the sandbox is resuming");
        } catch (error) {
            this.#setIf(root, token, "suspended", describeError(error));

            throw new HttpError(409, `It could not be resumed: ${describeError(error)}`);
        }

        // The teardown is proved. Before work is let in again, the folder, the trusted places, and the gate are asked again:
        // a suspension that the rules made (a trusted place now reaches the folder) stays, with its reason. A check that
        // throws is a refusal too: the tree is never left half way.
        const problem = await this.#problemOf(this.#folderOfRoot(root));

        if (problem !== undefined) {
            this.#setIf(root, token, "suspended", problem);

            throw new HttpError(409, `It could not be resumed: ${problem}`);
        }

        // Nothing reopens while a release runs (another change of the rules may have started one).
        const late = await this.#idle(root);

        if (late !== undefined) {
            this.#setIf(
                root,
                token,
                "suspended",
                `it could not be stopped (${describeError(late)})`,
            );

            throw new HttpError(409, `It could not be resumed: ${describeError(late)}`);
        }

        // The reservation that the failure kept goes, so the group is free again.
        if (this.#revision(root) === token) {
            this.#dropReservations(root);
            this.#setPhase(root, "stable");
        }
    }

    #dropReservations(root: number): void {
        for (const reservation of [...this.#reservations]) {
            if (reservation.roots.has(root)) {
                this.#reservations.delete(reservation);
            }
        }
    }

    // ─── Rules, recovery, reload, shutdown ──────────────────────────────────

    /**
     * Rules that decide what a VM may do changed (the module's settings, Pi's settings or an MCP file; the files are
     * watched by a later PR). The synchronous part stops every call at once, so none runs under the old rules; the
     * answer says when the trees are checked again. A tree whose folder the trusted places now reach stays suspended;
     * with stricter rules a looser VM is stopped, and the next call starts one under the new rules.
     */
    rules(reason: string, only?: readonly number[]): Promise<void> {
        const tag = `its rules changed (${reason})`;
        const mine = new Map<number, number>();

        for (const root of only ?? [...this.#on]) {
            if (!this.#on.has(root)) {
                continue;
            }

            // The newest rules win. A tree that is stable, or that an earlier rules change suspended and no one wrote since, is
            // taken over: its record is written again, so the earlier run sees that it is not current and stops. A tree in
            // another transition is checked again when that transition ends.
            if (!this.#phases.has(root) || this.#rulesOwned.get(root) === this.#revision(root)) {
                const revision = this.#setPhase(root, "suspended", tag);

                mine.set(root, revision);
                this.#rulesOwned.set(root, revision);
            } else {
                this.#rulesRecheck.add(root);
            }
        }

        if (mine.size === 0) {
            return Promise.resolve();
        }

        // Each step asks whether the record it made is still the current one, and writes only then.
        const still = (root: number) => this.#revision(root) === mine.get(root);

        const write = (root: number, phase: Phase, why?: string) => {
            const next = this.#setIf(root, mine.get(root), phase, why);

            if (next === undefined) {
                return;
            }

            mine.set(root, next);

            if (phase === "stable") {
                this.#rulesOwned.delete(root);
            } else {
                this.#rulesOwned.set(root, next);
            }
        };

        // Not in the queue of changes: a release is never held there. The revisions keep the runs apart.
        return this.#track(async () => {
            for (const root of [...mine.keys()]) {
                if (!still(root)) {
                    continue;
                }

                const problem = await this.#problemOf(this.#folderOfRoot(root));

                if (!still(root)) {
                    continue;
                }

                try {
                    // A folder that may not be shared any more: what runs in it is stopped, and proved gone, before this
                    // ends. A stricter rule stops a looser VM the same way.
                    if (problem !== undefined || this.provider?.stricter?.() === true) {
                        await this.#release(
                            [root],
                            problem === undefined
                                ? "the rules got stricter"
                                : "the folder may not be shared any more",
                        );
                    }

                    // A release that an earlier rules change started may still run: the tree stays closed until it has
                    // ended, and when it failed the tree stays suspended with that reason.
                    const late = await this.#idle(root);

                    if (!still(root)) {
                        continue;
                    }

                    if (late !== undefined) {
                        write(
                            root,
                            "suspended",
                            `${problem ?? "Its VM was being stopped"} It could not be stopped (${describeError(late)}).`,
                        );
                        continue;
                    }

                    write(root, problem === undefined ? "stable" : "suspended", problem);
                } catch (error) {
                    write(
                        root,
                        "suspended",
                        problem === undefined
                            ? describeError(error)
                            : `${problem} Its VM could not be stopped (${describeError(error)}).`,
                    );
                }
            }
        });
    }

    /** Trees whose suspension the rules wrote and no one has written since, by the revision of that record. */
    readonly #rulesOwned = new Map<number, number>();
    /** Trees that the rules skipped because another transition held them: checked again when it ends. */
    readonly #rulesRecheck = new Set<number>();

    /**
     * The settings of `module` changed. When it serves the sandbox, every call stops at once and the `rules` transition
     * runs, and the module hears of the change (`notify`) only after that; for any other module it hears at once.
     */
    rulesOf(module: string, notify: () => void): void {
        if (this.#provider?.owner !== module) {
            notify();

            return;
        }

        void this.rules(`the settings of ${module}`).then(notify, (error: unknown) => {
            this.#app.log(`Sandbox rules could not be applied: ${describeError(error)}`);
            notify();
        });
    }

    /**
     * Server start, and a module that came on: audit I1 and the two stores of each folder (a mixed group blocks every
     * VM and tells the owner), and set each stored sandbox up as `stable`, or `suspended` when the readiness gate or a
     * folder check refuses it. The runner ledger that reaps old VMs is a later PR's.
     */
    async reconcile(): Promise<void> {
        this.#audited();

        for (const root of [...this.#on]) {
            const current = this.#phases.get(root);

            // Only a start, or a suspension that a provider change made, is this module's to clear: a tree another transition
            // owns, or one a failed release left suspended, waits for its own recovery.
            if (
                current !== undefined &&
                !(current.phase === "suspended" && current.lifecycle === true)
            ) {
                continue;
            }

            // The revision seen before the wait must still be the current one afterwards: a transition that began, or began
            // and ended, meanwhile owns the tree, and it is left as it is.
            const seen = this.#revision(root);
            const missing = await this.#problemOf(this.#folderOfRoot(root));

            if (!this.#on.has(root)) {
                continue;
            }

            // Not while a release runs for the tree; a release that failed keeps it suspended, with its reason.
            const late = missing === undefined ? await this.#idle(root) : undefined;

            if (late !== undefined) {
                this.#setIf(
                    root,
                    seen,
                    "suspended",
                    `it could not be stopped (${describeError(late)})`,
                );
                continue;
            }

            this.#setIf(root, seen, missing === undefined ? "stable" : "suspended", missing, true);
        }
    }

    /**
     * A module is about to be replaced, turned off, or removed: every tree it serves is `suspended`, every lease is
     * revoked, and the VMs are proved gone, before the new version registers or the module leaves. A failure throws,
     * and the provider stays: the caller keeps the old module. `leave`: the provider goes too, after the proof. A new
     * registration waits for this teardown (`register`), and reconciles the trees that waited.
     */
    async suspendOwner(owner: string, leave: boolean): Promise<void> {
        await this.#serialised(async () => {
            const mine = this.#provider;

            if (mine === undefined || mine.owner !== owner) {
                return;
            }

            await this.#stop(mine, leave, "the sandbox module is being replaced or turned off");
        });
    }

    /** The server stops: every tree is suspended and every VM is stopped, within a bound. */
    async shutdown(): Promise<void> {
        const roots = [...this.#on];

        for (const root of roots) {
            this.#setPhase(root, "suspended", "the server is stopping");
        }

        await this.#release(roots, "the server is stopping").catch((error: unknown) => {
            this.#app.log(`Sandboxes did not all stop: ${describeError(error)}`);
        });
    }

    // ─── Environments ───────────────────────────────────────────────────────

    /**
     * The environment of a conversation of a sandboxed tree. It never reaches the host (I4): with no provider, an
     * unready gate, a suspended tree, or a folder problem, every call fails at once and says why. Each call takes its
     * own lease, so a cached environment never carries an old grant.
     */
    env(id: ConversationId, cwd: string, hops = 0): ExecutionEnv {
        const root = this.#rootOfNumber(Number(id));
        const provider = this.provider;

        if (workspaceScheme(cwd) !== undefined) {
            return failedEnv(cwd, "A sandbox does not support a remote workspace.");
        }

        const at = this.#phases.get(root);

        if (at?.phase === "suspended") {
            return failedEnv(
                cwd,
                `This session's sandbox is suspended, so nothing ran: ${at.reason ?? "it was stopped"}`,
            );
        }

        if (provider === undefined) {
            return failedEnv(
                cwd,
                "This session runs in a sandbox, but the sandbox module is off or not available, so nothing ran. Ask the owner to turn the sandbox off for this session.",
            );
        }

        const not = this.#notReady();

        if (not !== undefined) {
            return failedEnv(cwd, `${not} Nothing ran.`);
        }

        let inner: ExecutionEnv;

        try {
            inner = provider.env({
                conversationId: id,
                rootId: root as unknown as ConversationId,
                cwd,
            });
        } catch (error) {
            return failedEnv(
                cwd,
                `The sandbox could not start, so nothing ran: ${describeError(error)}`,
            );
        }

        return this.#handle(id, cwd, inner, true, hops);
    }

    /** The environment of a plain conversation: each call holds a `host` lease, so a turn-on can see work in flight. */
    hostEnv(id: ConversationId, cwd: string, inner: ExecutionEnv, hops = 0): ExecutionEnv {
        return this.#handle(id, cwd, inner, false, hops);
    }

    /**
     * An environment as a handle: each call takes its own lease, in `stable`, and checks the tree is still in the state
     * the handle was made for. When it is not (it was turned on or off while the call waited), the call is made on the
     * environment that the new state gives (`app.envFor`) and never on the old one.
     */
    #handle(
        id: ConversationId,
        cwd: string,
        inner: ExecutionEnv,
        boxed: boolean,
        hops: number,
    ): ExecutionEnv {
        const app = this.#app;
        const generation = this.#generation;
        const failure = (message: string, property: string) =>
            (
                Reflect.get(failedEnv(cwd, message), property) as
                    ((...args: unknown[]) => unknown) | undefined
            )?.();

        return new Proxy(inner, {
            get: (target, property) => {
                const value: unknown = Reflect.get(target, property, target);

                if (
                    typeof value !== "function" ||
                    typeof property !== "string" ||
                    !(FILE_CALLS.has(property) || property === "exec")
                ) {
                    return typeof value === "function"
                        ? (value as (...args: unknown[]) => unknown).bind(target)
                        : value;
                }

                return async (...args: unknown[]) => {
                    const at = args.findIndex(
                        (each) =>
                            typeof each === "object" &&
                            each !== null &&
                            "abortSignal" in each &&
                            typeof (each as { value?: unknown }).value === "function",
                    );
                    const cancel =
                        !boxed || at === -1 ? undefined : withCancel(args[at] as Context);
                    const kind: VmKind = property === "exec" ? "exec" : "file";
                    // A reader or a watcher is used after its open returns: its lease lasts until it is closed.
                    const resource = RESOURCE_CALLS[property];
                    let closeResource: (() => Promise<void>) | undefined;
                    let lease: Lease;

                    try {
                        lease = await this.lease(
                            id,
                            boxed
                                ? {
                                      kind,
                                      folder: cwd,
                                      revoke: (reason) => {
                                          cancel?.cancel(new Error(reason));

                                          return closeResource?.();
                                      },
                                  }
                                : { kind: "host", folder: cwd, what: `a ${property} call` },
                        );
                    } catch (error) {
                        return failure(describeError(error), property);
                    }

                    // What the handle was made for is looked at again at every call: the state of the tree, its folder,
                    // and the provider. When any changed, the call goes to the environment that the new state gives.
                    // The folder is compared by its path here. PR 2 adds its identity (`pinnedRoot`, the descriptor of the
                    // folder that `hostfs` opened): a swap of the folder under the same path then makes the handle stale too.
                    if (
                        lease.sandboxed !== boxed ||
                        this.#generation !== generation ||
                        this.#app.cwdOf(id) !== cwd
                    ) {
                        lease.end();

                        if (hops >= 2) {
                            return failure(
                                "The sandbox of this session changed again and again, so nothing ran.",
                                property,
                            );
                        }

                        const again = app.envFor(id, hops + 1) as unknown as Record<
                            string,
                            (...call: unknown[]) => unknown
                        >;

                        return again[property]!(...args);
                    }

                    let result: unknown;

                    try {
                        const call = [...args];

                        if (cancel !== undefined) {
                            call[at] = cancel.context;
                        }

                        result = await (value as (...call: unknown[]) => unknown).apply(
                            target,
                            call,
                        );
                    } catch (error) {
                        lease.end();

                        throw error;
                    }

                    const opened = (result as { ok?: boolean; value?: unknown } | undefined)?.ok
                        ? (result as { value: Record<string, unknown> }).value
                        : undefined;

                    if (resource === undefined || opened === undefined) {
                        lease.end();

                        return result;
                    }

                    const done = opened[resource] as
                        ((context: Context) => Promise<void>) | undefined;

                    // A revoke closes the resource itself, and the lease ends with it.
                    closeResource = async () => {
                        try {
                            await done?.call(opened, context);
                        } finally {
                            lease.end();
                        }
                    };

                    return ok(
                        new Proxy(opened, {
                            get: (held, name) => {
                                const member: unknown = Reflect.get(held, name, held);

                                if (name === resource && typeof member === "function") {
                                    return async (...closing: unknown[]) => {
                                        try {
                                            return await (
                                                member as (...call: unknown[]) => unknown
                                            ).apply(held, closing);
                                        } finally {
                                            lease.end();
                                        }
                                    };
                                }

                                return typeof member === "function"
                                    ? (member as (...call: unknown[]) => unknown).bind(held)
                                    : member;
                            },
                        }),
                    );
                };
            },
        });
    }

    // ─── Tool calls ─────────────────────────────────────────────────────────

    /** The host leases of calls in flight that are not env calls, by the call's task: ended by `toolEnded`. */
    readonly #toolLeases = new Map<string, { lease: Lease; conversation: number }>();

    /**
     * The tool hook of every call (`app.ts`): wait for a stable tree, then decide. A sandboxed tree gets the gate. A
     * plain tree gets a `host` lease for a call that runs on this machine without the environment (the browser, MCP,
     * and the rest), so that a turn-on sees it in flight; the call that is an environment's takes its lease there.
     * Returns the words of a block, or undefined to let the call run.
     */
    async beforeTool(
        conversation: ConversationId,
        taskId: string,
        tool: string,
        args: unknown,
    ): Promise<string | undefined> {
        const root = this.#rootOfNumber(Number(conversation));

        // The common case: no sandbox anywhere, nothing changing.
        if (this.#on.size === 0 && !this.#phases.has(root) && !this.#toolNeedsLease(tool)) {
            return undefined;
        }

        try {
            return await this.#whenStable(root, () => {
                if (this.#on.has(root)) {
                    return this.gate(tool, args);
                }

                // Every call of a plain tree checks I1 for its group at this moment, as a lease grant does: also a call
                // that needs no host lease.
                const problem = this.#grantProblem(root);

                if (problem !== undefined) {
                    return problem;
                }

                if (this.#toolNeedsLease(tool) && !this.#toolLeases.has(taskId)) {
                    this.#toolLeases.set(taskId, {
                        lease: this.#grant(root, Number(conversation), {
                            kind: "host",
                            what: `a ${tool} call that is running`,
                        }),
                        conversation: Number(conversation),
                    });
                }

                return undefined;
            });
        } catch (error) {
            return describeError(error);
        }
    }

    #toolNeedsLease(tool: string): boolean {
        return !ROUTED_TOOLS.has(tool) && !INERT_TOOLS.has(tool);
    }

    /** A call ended (`afterTool`), or the conversation's run did: its lease ends. */
    toolEnded(taskId: string): void {
        this.#toolLeases.get(taskId)?.lease.end();
        this.#toolLeases.delete(taskId);
    }

    #runEnded(conversation: number): void {
        for (const [taskId, held] of this.#toolLeases) {
            if (held.conversation === conversation) {
                this.toolEnded(taskId);
            }
        }
    }

    // ─── The tool gate ──────────────────────────────────────────────────────

    /**
     * Why a tool call of a sandboxed tree may not run, or undefined when it may. An allow list, and a route check: an
     * unlisted tool is a host tool and is blocked; a routed tool with no route is blocked, never run on the host.
     */
    gate(tool: string, args: unknown): string | undefined {
        if (ROUTED_TOOLS.has(tool)) {
            return undefined;
        }

        const route = ROUTED_BY_PROVIDER[tool];

        if (route !== undefined) {
            return this.provider?.[route] === undefined
                ? `${hostToolBlocked(tool)} The sandbox here has no route for ${tool} yet.`
                : undefined;
        }

        if (tool === TEAM_TOOL) {
            return this.#present.has("team-rule")
                ? undefined
                : `${hostToolBlocked(tool)} Linked sessions from a sandboxed session are not available yet.`;
        }

        if (tool === "artifact") {
            return namesPath(args)
                ? `${hostToolBlocked(tool)} An artifact made from a file reads the host's file: send its content instead.`
                : undefined;
        }

        if (tool === "memory") {
            const call = (args ?? {}) as { action?: unknown; scope?: unknown };

            return call.action === "list" || (call.action === "add" && call.scope === "session")
                ? undefined
                : 'A sandboxed session may keep session lessons only: it feeds sessions without a sandbox otherwise. Use scope "session".';
        }

        return INERT_TOOLS.has(tool) ? undefined : hostToolBlocked(tool);
    }
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
