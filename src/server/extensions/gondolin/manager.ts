/**
 * The VMs of sandboxed sessions: one for each session (its subagents share it), started by the first call that needs
 * it, stopped when idle, archived, or turned off, and never replaced by the host when one cannot start.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { GuestEnv } from "./guest-env.ts";
import { gitConfigProblem, gitMounts } from "./git.ts";
import type {
    Backend,
    GuestExecOptions,
    GuestVm,
    HostCheck,
    NetworkMode,
    SandboxDriver,
    VmSpec,
} from "./guest.ts";

export interface SandboxSettings {
    readonly backend: Backend;
    readonly mount: "rw" | "ro";
    readonly network: NetworkMode;
    readonly allowedHosts: readonly string[];
    readonly cpus: number;
    readonly memoryMb: number;
    readonly diskMb: number;
    /** Minutes without a call before a VM stops; 0: never. */
    readonly idleMinutes: number;
    /** The most VMs at once. */
    readonly maxVms: number;
    readonly image: string;
}

export interface VmTarget {
    readonly rootId: number;
    readonly cwd: string;
    readonly uploadDir: string | undefined;
    /** Folders of the skills the session uses, outside its folder: mounted read only. */
    readonly skillDirs?: readonly string[];
}

export type Phase = "starting" | "running" | "stopped" | "error";

/** What the sheet shows of one session's VM. */
export interface VmState {
    readonly phase: Phase;
    readonly cwd: string;
    readonly mount: "rw" | "ro";
    readonly network: NetworkMode;
    /** The VM's size while it lives; the settings' otherwise. */
    readonly cpus: number;
    readonly memoryMb: number;
    /** The hosts the VM reaches (network mode allow list): the rules it started with. */
    readonly allowedHosts: readonly string[];
    /** The VM runs with rules the settings have since changed (looser ones: stricter ones end it). */
    readonly stale: boolean;
    readonly startedAt?: number;
    readonly stoppedAt?: number;
    /** Why it stopped, or why it could not start. */
    readonly note?: string;
    readonly busy: number;
}

interface Entry {
    target: VmTarget;
    vm?: GuestVm;
    starting?: Promise<GuestVm>;
    /** Counts the ends of this entry's VM: a start that began before one must not keep its VM (`#end`). */
    generation: number;
    /** The session's sandbox is going (`release`): no call starts a VM for it any more. */
    revoked?: boolean;
    /** The close of the VM, and the wait for a start under way, that an end began: every later end waits for it. */
    closing?: Promise<void>;
    /** A VM that could not be closed: no new one starts until a later end closes it. */
    stuck?: { vm: GuestVm; error: string };
    busy: number;
    shell: string;
    last: number;
    timer?: NodeJS.Timeout;
    phase: Phase;
    startedAt?: number;
    stoppedAt?: number;
    note?: string;
    spec?: VmSpec;
    /** The session's folder or uploads changed since the VM started: it mounts the old ones, so no call may use it. */
    moved?: boolean;
    /** The folder and uploads that the VM mounts: the target it started with. */
    mounted?: VmTarget;
    envs: Map<string, GuestEnv>;
    /** Chromium's trust in the sandbox network's certificate authority, done once for each VM. */
    trusted?: Promise<void>;
}

/** The pipe of a Chromium that runs in a VM, as `Browsers` takes it. */
export interface BrowserLink {
    input: Readable;
    output: Writable;
    stop(): void;
    exited: Promise<void>;
}

export interface ManagerOptions {
    readonly driver: SandboxDriver;
    readonly settings: () => SandboxSettings;
    readonly log: (line: string) => void;
    /** A file that lists the runner processes of VMs this server started, to end ones that a crash left behind. */
    readonly pidFile: string;
    readonly now?: () => number;
    /** The command line of a process, or undefined: how a stale runner is told from a process that reused its id. */
    readonly inspect?: (pid: number) => Promise<string | undefined>;
    readonly kill?: (pid: number) => void;
    /** Called when the state of a VM changes. */
    readonly onChange?: (rootId: number) => void;
    /** Called when a VM goes from idle to working or back (the owner's list says which). */
    readonly onActivity?: (rootId: number) => void;
    /** Called when a VM ends, for whatever reason, with its session and the reason: what ran in it ended too. */
    readonly onEnded?: (rootId: number, reason: string) => void;
    /** Why a folder may not be mounted (`policy.ts`), or undefined. A session's own folder that fails never starts. */
    readonly folderProblem?: (path: string, kind: "folder" | "git" | "skill") => string | undefined;
}

/** What a person reads when git would run code that the sandbox can write (`git.ts`). */
const WRITABLE_CODE = (problem: string) =>
    `The sandbox did not start. ${problem} Make the sandbox folder read only (Menu → Sandbox: a read only folder works with git, hooks included), or change the setting: hooks and included files belong outside the project, and a program belongs in your global git configuration.`;

const STRICTER = "the owner made the sandbox's rules stricter";

function sessionLabel(rootId: number, cwd: string): string {
    return `pi-pocket #${rootId} ${cwd.split("/").filter(Boolean).at(-1) ?? ""}`.trim();
}

export function psInspect(pid: number): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile("ps", ["-o", "args=", "-p", String(pid)], (error, stdout) =>
            resolve(error === null && stdout.trim() !== "" ? stdout.trim() : undefined),
        );
    });
}

/** A VM that was made with looser rules than the settings now say: more network, more hosts, or a writable folder. */
function looserThanSettings(spec: VmSpec, settings: SandboxSettings): boolean {
    const rank = { off: 0, allowlist: 1, open: 2 } as const;
    const hosts = new Set(settings.allowedHosts);

    return (
        (spec.mount === "rw" && settings.mount === "ro") ||
        rank[settings.network] < rank[spec.network.mode] ||
        (spec.network.mode === "allowlist" &&
            settings.network === "allowlist" &&
            spec.network.allowedHosts.some((host) => !hosts.has(host)))
    );
}

/** A VM that finished starting with rules the settings made stricter meanwhile: it ends and starts again. */
class RulesChanged extends Error {}

/** The VM was stopped, or its session's sandbox went, while it started: it closed what it made. */
class Stopped extends Error {
    constructor() {
        super("The sandbox was stopped while it started.");
    }
}

export class SandboxManager {
    readonly #options: ManagerOptions;
    readonly #entries = new Map<number, Entry>();
    #stopped = false;

    constructor(options: ManagerOptions) {
        this.#options = options;
    }

    #now(): number {
        return this.#options.now?.() ?? Date.now();
    }

    /** The environment for a session's calls. It starts the VM when a call needs it. */
    envFor(conversationId: number, target: VmTarget): ExecutionEnv {
        const entry = this.#entry(target);
        const key = `${conversationId}:${target.cwd}`;
        let env = entry.envs.get(key);

        if (env === undefined) {
            const rootId = target.rootId;

            env = new GuestEnv(
                `gondolin:${rootId}`,
                target.cwd,
                {
                    ready: (signal) => this.#ready(rootId, signal, target),
                    busy: () => this.#busy(rootId),
                    touch: () => this.#touch(rootId),
                },
                () => this.#entries.get(rootId)?.shell ?? "/bin/sh",
            );
            entry.envs.set(key, env);
        }

        return env;
    }

    #entry(target: VmTarget): Entry {
        let entry = this.#entries.get(target.rootId);

        if (entry === undefined) {
            entry = {
                target,
                busy: 0,
                generation: 0,
                shell: "/bin/sh",
                last: this.#now(),
                phase: "stopped",
                envs: new Map(),
            };
            this.#entries.set(target.rootId, entry);
        } else if (entry.target.cwd !== target.cwd || entry.target.uploadDir !== target.uploadDir) {
            // The session's folder changed: this VM mounts the old one. A new one starts at the next call.
            entry.target = target;
            entry.envs.clear();
            entry.trusted = undefined;

            if (entry.vm !== undefined || entry.starting !== undefined) {
                // Whatever holds the VM (a task, a browser) keeps it up, but the next call replaces it: `#ready`.
                entry.moved = true;
            }

            if (entry.vm !== undefined && entry.busy === 0) {
                void this.stop(target.rootId, "the session's folder changed");
            }
        }

        return entry;
    }

    #ended(rootId: number, reason: string): void {
        try {
            this.#options.onEnded?.(rootId, reason);
        } catch (error) {
            this.#options.log(`sandbox: an end listener failed: ${String(error)}`);
        }
    }

    #changed(rootId: number): void {
        try {
            this.#options.onChange?.(rootId);
        } catch (error) {
            this.#options.log(`sandbox: a change listener failed: ${String(error)}`);
        }
    }

    #activity(rootId: number): void {
        try {
            this.#options.onActivity?.(rootId);
        } catch (error) {
            this.#options.log(`sandbox: an activity listener failed: ${String(error)}`);
        }
    }

    #busy(rootId: number): () => void {
        const entry = this.#entries.get(rootId);

        if (entry === undefined) {
            return () => {};
        }

        entry.busy++;
        this.#touch(rootId);

        if (entry.busy === 1) {
            this.#activity(rootId);
        }

        let ended = false;

        return () => {
            if (!ended) {
                ended = true;
                entry.busy--;
                this.#touch(rootId);

                if (entry.busy === 0) {
                    this.#activity(rootId);
                }
            }
        };
    }

    #touch(rootId: number): void {
        const entry = this.#entries.get(rootId);

        if (entry === undefined) {
            return;
        }

        entry.last = this.#now();
        this.#schedule(rootId, entry);
    }

    #schedule(rootId: number, entry: Entry): void {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        const minutes = this.#options.settings().idleMinutes;

        if (entry.vm === undefined || !(minutes > 0)) {
            return;
        }

        entry.timer = setTimeout(
            () => {
                if (entry.busy > 0) {
                    this.#schedule(rootId, entry);
                } else if (this.#now() - entry.last >= minutes * 60_000) {
                    void this.stop(rootId, `idle for ${minutes} minutes`);
                } else {
                    this.#schedule(rootId, entry);
                }
            },
            Math.max(1000, minutes * 60_000 - (this.#now() - entry.last)),
        );
        entry.timer.unref?.();
    }

    async #ready(rootId: number, signal?: AbortSignal, expect?: VmTarget): Promise<GuestVm> {
        const entry = this.#entries.get(rootId);

        if (entry === undefined) {
            throw new Error("The sandbox for this session is gone. Try again.");
        }

        // A call made for a folder that the session has left must not run in the VM of the one it works in now.
        if (
            expect !== undefined &&
            (expect.cwd !== entry.target.cwd || expect.uploadDir !== entry.target.uploadDir)
        ) {
            throw new Error(
                `This call was meant for ${expect.cwd}, but the session works in ${entry.target.cwd} now, so it did not run. Try it again.`,
            );
        }

        if (this.#stopped) {
            throw new Error("The sandbox module is stopping, so nothing ran.");
        }

        if (entry.revoked === true) {
            throw new Error("The sandbox for this session is being turned off, so nothing ran.");
        }

        // The VM that ended is really gone before another starts, and before this call is judged again.
        if (entry.closing !== undefined) {
            await entry.closing.catch(() => undefined);

            return this.#ready(rootId, signal, expect);
        }

        if (entry.stuck !== undefined) {
            throw new Error(
                "The sandbox's earlier VM could not be closed, so no new one starts. Stop it from the sheet, then try again.",
            );
        }

        if (entry.vm !== undefined) {
            if (
                entry.moved === true ||
                (entry.mounted !== undefined &&
                    (entry.mounted.cwd !== entry.target.cwd ||
                        entry.mounted.uploadDir !== entry.target.uploadDir))
            ) {
                // The VM mounts the folder that the session had: it ends (with what runs in it), and a new one starts.
                await this.stop(rootId, "the session's folder changed");

                return this.#ready(rootId, signal);
            }

            if (
                entry.spec === undefined ||
                !looserThanSettings(entry.spec, this.#options.settings())
            ) {
                return entry.vm;
            }

            // Stricter settings end a VM made with looser rules before any call uses it: the check that
            // `enforce` makes on a settings change may not have run yet.
            await this.stop(rootId, STRICTER);

            return this.#ready(rootId, signal);
        }

        entry.starting ??= this.#start(rootId, entry).finally(() => {
            entry.starting = undefined;
        });

        if (signal === undefined) {
            return entry.starting;
        }

        return Promise.race([
            entry.starting,
            new Promise<never>((_, reject) => {
                signal.addEventListener("abort", () => reject(new Error("aborted")), {
                    once: true,
                });
            }),
        ]);
    }

    /** Start the VM with the settings as they are now; again when they get stricter while it starts. */
    async #start(rootId: number, entry: Entry): Promise<GuestVm> {
        const generation = entry.generation;

        for (let attempt = 1; ; attempt++) {
            try {
                return await this.#startOnce(rootId, entry, generation);
            } catch (error) {
                if (!(error instanceof RulesChanged) || attempt >= 3) {
                    throw error instanceof RulesChanged
                        ? new Error(
                              "The sandbox could not start: its rules kept changing while it started.",
                          )
                        : error;
                }
            }
        }
    }

    async #startOnce(rootId: number, entry: Entry, generation: number): Promise<GuestVm> {
        // Whether this start still counts: not once the module stopped, the session's sandbox went, or an end began.
        const live = () =>
            !this.#stopped && entry.revoked !== true && entry.generation === generation;

        if (!live()) {
            throw new Stopped();
        }

        const settings = this.#options.settings();
        const holders = [...this.#entries.entries()].filter(
            ([id, other]) =>
                id !== rootId &&
                (other.vm !== undefined ||
                    other.starting !== undefined ||
                    other.closing !== undefined),
        );

        if (holders.length >= settings.maxVms) {
            const names = holders
                .map(
                    ([id, other]) =>
                        `session #${id} (${other.target.cwd}, ${other.busy > 0 || other.starting !== undefined ? "working" : "idle"})`,
                )
                .join("; ");
            const message = `The sandbox could not start: ${holders.length} sandboxes already run, and the most is ${settings.maxVms}: ${names}. The owner can stop an idle one in the sandbox sheet (Menu → Sandbox → Running sandboxes), or raise "Sandboxes at once" in Menu → Extensions → Gondolin sandbox.`;

            entry.phase = "error";
            entry.note = message;
            this.#changed(rootId);

            throw new Error(message);
        }

        const target = entry.target;

        entry.moved = false;
        const problem = this.#options.folderProblem?.(target.cwd, "folder");

        if (problem !== undefined) {
            entry.phase = "error";
            entry.note = `The sandbox could not start: ${problem}`;
            this.#changed(rootId);

            throw new Error(entry.note);
        }

        entry.phase = "starting";
        entry.note = undefined;
        this.#changed(rootId);

        try {
            const git = await gitMounts(target.cwd);
            const usable = (folders: readonly string[], kind: "git" | "skill") =>
                folders.filter((folder) => {
                    const why = this.#options.folderProblem?.(folder, kind);

                    if (why !== undefined) {
                        this.#options.log(`sandbox: ${folder} is not mounted: ${why}`);
                    }

                    return why === undefined;
                });
            const spec: VmSpec = {
                label: sessionLabel(rootId, target.cwd),
                backend: settings.backend,
                cwd: target.cwd,
                mount: settings.mount,
                readOnlyMounts: [
                    ...(target.uploadDir === undefined ? [] : [target.uploadDir]),
                    ...usable(target.skillDirs ?? [], "skill"),
                ],
                gitDirs: usable(git.gitDirs, "git"),
                safeDirectories: git.safeDirectories,
                network: { mode: settings.network, allowedHosts: [...settings.allowedHosts] },
                cpus: settings.cpus,
                memoryMb: settings.memoryMb,
                diskMb: settings.diskMb,
                image: settings.image,
            };

            entry.spec = spec;

            // Git runs hooks, and reads configuration, with the user's rights: a place the guest can write must not
            // hold them. Nothing is assumed when git cannot be asked.
            const problem =
                settings.mount !== "rw"
                    ? undefined
                    : git.unreadable !== undefined
                      ? `Pi Pocket could not look inside ${git.unreadable} for repositories, so it cannot guard their git directories.`
                      : await gitConfigProblem(target.cwd, git).catch(
                            (error: unknown) =>
                                `Pi Pocket could not ask git about this folder's hooks and configuration (${error instanceof Error ? error.message : String(error)}).`,
                        );

            if (problem !== undefined) {
                throw new Error(WRITABLE_CODE(problem));
            }

            if (!live()) {
                throw new Stopped();
            }

            const vm = await this.#options.driver.start(spec);
            let shell = "/bin/sh";

            if (!live()) {
                await this.#discard(entry, vm);

                throw new Stopped();
            }

            try {
                const chunks: string[] = [];
                const probe = vm.exec(["/bin/sh", "-c", "command -v bash || true"]);

                for await (const chunk of probe.output()) {
                    if (chunk.stream === "stdout") {
                        chunks.push(Buffer.from(chunk.data).toString("utf8"));
                    }
                }

                await probe.result;
                shell = chunks.join("").trim() || "/bin/sh";
            } catch {
                // a VM that cannot run a probe cannot run a command: the next call says so
            }

            if (!live()) {
                await this.#discard(entry, vm);

                throw new Stopped();
            }

            if (
                looserThanSettings(spec, this.#options.settings()) ||
                entry.target.cwd !== target.cwd ||
                entry.target.uploadDir !== target.uploadDir
            ) {
                // The rules got stricter, or the session moved to another folder, while the VM started.
                await this.#discard(entry, vm);

                throw new RulesChanged();
            }

            entry.vm = vm;
            entry.mounted = target;
            entry.trusted = undefined;
            entry.shell = shell;
            entry.phase = "running";
            entry.startedAt = this.#now();
            entry.stoppedAt = undefined;
            entry.note = undefined;
            this.#remember(vm);
            vm.onExit((reason) => {
                if (entry.vm === vm) {
                    entry.vm = undefined;
                    entry.phase = "stopped";
                    entry.stoppedAt = this.#now();
                    entry.note = `The sandbox ended: ${reason}`;
                    this.#forget(vm);
                    this.#ended(rootId, `the sandbox ended: ${reason}`);
                    this.#changed(rootId);
                }
            });
            this.#touch(rootId);
            this.#changed(rootId);

            return vm;
        } catch (error) {
            if (error instanceof RulesChanged || error instanceof Stopped) {
                throw error;
            }

            const message = `The sandbox could not start: ${error instanceof Error ? error.message : String(error)}`;

            entry.phase = "error";
            entry.note = message;
            this.#options.log(`sandbox: ${message}`);
            this.#changed(rootId);

            throw new Error(message);
        }
    }

    /**
     * Start Chromium in a session's VM and give the pipe that speaks the DevTools protocol with it: the browser's fd 3
     * reads what `output` is given and fd 4 writes `input`, over the command's own stdin and stdout. Nothing listens on
     * this machine. `flags` are the ones Pi Pocket gives every browser; the sandbox adds its own. HTTPS pages need the
     * sandbox network's certificate authority in Chromium's store: it is added once for each VM.
     */
    async launchBrowser(target: VmTarget, flags: readonly string[]): Promise<BrowserLink> {
        const rootId = target.rootId;
        const entry = this.#entry(target);
        const vm = await this.#ready(rootId, undefined, target);

        entry.trusted ??= (async () => {
            const done = this.#busy(rootId);

            try {
                await vm.exec([
                    "/bin/sh",
                    "-c",
                    "mkdir -p $HOME/.pki/nssdb && { [ -f $HOME/.pki/nssdb/cert9.db ] || certutil -d sql:$HOME/.pki/nssdb -N --empty-password; } && certutil -d sql:$HOME/.pki/nssdb -A -t 'C,,' -n gondolin -i /etc/gondolin/mitm/ca.crt",
                ]).result;
            } catch (error) {
                this.#options.log(
                    `sandbox: could not trust the network's certificate: ${String(error)}`,
                );
            } finally {
                done();
            }
        })();
        await entry.trusted;

        const stop = new AbortController();
        const done = this.#busy(rootId);
        const profile = `/tmp/pocket-browser-${Date.now().toString(36)}`;
        // fd 3 is read from the command's stdin and fd 4 goes to its stdout; the browser's own stdout goes to stderr.
        const script = `exec "$0" "$@" 3<&0 4>&1 1>&2`;
        const process_ = vm.exec(
            [
                "/bin/sh",
                "-c",
                script,
                "chromium-browser",
                ...flags,
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                `--user-data-dir=${profile}`,
                "about:blank",
            ],
            { signal: stop.signal, stdin: true },
        );
        const input = new Readable({ read() {} });
        const output = new Writable({
            write(chunk: Buffer, _encoding, callback) {
                try {
                    process_.write(chunk);
                    callback();
                } catch (error) {
                    callback(error as Error);
                }
            },
        });
        const exited = (async () => {
            try {
                for await (const chunk of process_.output()) {
                    if (chunk.stream === "stdout") {
                        input.push(Buffer.from(chunk.data));
                    }
                }

                await process_.result;
            } catch {
                // the VM went away, or the browser was stopped: the same to whoever drives it
            } finally {
                done();
                input.push(null);
            }
        })();

        return { input, output, stop: () => stop.abort(), exited };
    }

    /** Close a VM that no entry holds. One that cannot be closed is kept (`stuck`), so that a later end tries again. */
    async #discard(entry: Entry, vm: GuestVm): Promise<void> {
        try {
            await vm.close();
        } catch (error) {
            entry.stuck = { vm, error: String(error) };
            this.#options.log(`sandbox: closing a VM failed: ${String(error)}`);
        }
    }

    /**
     * End what a session's entry holds: a start under way and its VM. It finishes when both are really gone, and
     * rejects when a VM could not be closed (it is kept, and the next end closes it again). Each end waits for the one
     * before it, so a second `stop` does not return while the first still closes. True when this call ended a VM or a start.
     */
    async #end(rootId: number, entry: Entry, why: string): Promise<boolean> {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        const { vm, starting } = entry;
        const began = vm !== undefined || starting !== undefined;

        if (began) {
            entry.generation++;
            entry.vm = undefined;
            entry.phase = "stopped";
            entry.stoppedAt = this.#now();
            entry.note = `Stopped: ${why}.`;
            this.#changed(rootId);

            if (vm !== undefined) {
                this.#ended(rootId, why);
            }
        }

        if (began || entry.stuck !== undefined) {
            const before = entry.closing;
            const closing = (async () => {
                await before?.catch(() => undefined);
                // A start under way closes the VM it made (`#startOnce`): wait for that, and for a close that failed.
                await starting?.catch(() => undefined);

                for (const each of [entry.stuck?.vm, vm]) {
                    if (each !== undefined) {
                        entry.stuck = undefined;

                        try {
                            await each.close();
                            this.#forget(each);
                        } catch (error) {
                            entry.stuck = { vm: each, error: String(error) };

                            throw error;
                        }
                    }
                }
            })();

            const settled = () => {
                if (entry.closing === closing) {
                    entry.closing = undefined;
                }
            };

            entry.closing = closing;
            closing.then(settled, settled);
        }

        await entry.closing;

        return began;
    }

    /** Stop a session's VM. Commands that run in it end, and it is gone when this returns. The next call starts a new one. */
    async stop(rootId: number, why: string): Promise<boolean> {
        const entry = this.#entries.get(rootId);

        if (entry === undefined) {
            return false;
        }

        try {
            return await this.#end(rootId, entry, why);
        } catch (error) {
            this.#options.log(`sandbox: closing a VM failed: ${String(error)}`);

            return true;
        }
    }

    /**
     * A session's sandbox is going: no call of the session starts a VM from now on, what runs finishes ending, and the
     * VM is really gone when this returns. It rejects when the VM could not be closed; the session stays revoked, and a
     * later `release` closes it again.
     */
    async release(rootId: number, why: string): Promise<void> {
        const entry = this.#entries.get(rootId);

        if (entry === undefined) {
            // This manager holds no VM of the session. A runner of an earlier one (a module that loaded again) may be
            // its VM: it ends now, or the release fails.
            await this.reapStale();
            const left = this.#orphans();

            if (left.length > 0) {
                throw new Error(
                    `a runner that an earlier sandbox started (process ${left.join(", ")}) could not be ended`,
                );
            }

            return;
        }

        entry.revoked = true;
        await this.#end(rootId, entry, why);
        this.#entries.delete(rootId);
    }

    /**
     * Stop every VM, and finish when each is really gone. Returns the sessions whose VM could not be closed, with why:
     * those VMs may still run.
     */
    async stopAll(why: string): Promise<Map<number, string>> {
        this.#stopped = true;
        await Promise.all([...this.#entries.keys()].map((rootId) => this.stop(rootId, why)));

        return new Map(
            [...this.#entries.entries()].flatMap(([rootId, entry]) =>
                entry.stuck === undefined ? [] : [[rootId, entry.stuck.error] as const],
            ),
        );
    }

    /** Allow starting again after `stopAll` (a module that loaded again). */
    resume(): void {
        this.#stopped = false;
    }

    state(rootId: number): VmState | undefined {
        const entry = this.#entries.get(rootId);

        if (entry === undefined) {
            return undefined;
        }

        const settings = this.#options.settings();
        const alive = entry.vm !== undefined;
        // The rules and the size of a VM are shown while it lives or starts: after it ended, the settings are the answer.
        const spec = alive || entry.starting !== undefined ? entry.spec : undefined;
        const network = spec?.network.mode ?? settings.network;
        const allowedHosts = spec?.network.allowedHosts ?? settings.allowedHosts;
        const mount = spec?.mount ?? settings.mount;

        return {
            phase: entry.phase,
            cwd: entry.target.cwd,
            mount,
            network,
            cpus: spec?.cpus ?? settings.cpus,
            memoryMb: spec?.memoryMb ?? settings.memoryMb,
            allowedHosts,
            stale:
                alive &&
                (mount !== settings.mount ||
                    network !== settings.network ||
                    allowedHosts.join(" ") !== settings.allowedHosts.join(" ")),
            ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
            ...(entry.stoppedAt === undefined ? {} : { stoppedAt: entry.stoppedAt }),
            ...(entry.note === undefined ? {} : { note: entry.note }),
            busy: entry.busy,
        };
    }

    /** Every VM that runs or starts, for the owner's list. */
    vms(): { rootId: number; cwd: string; phase: Phase; busy: number; startedAt?: number }[] {
        return [...this.#entries.entries()]
            .filter(([, entry]) => entry.vm !== undefined || entry.starting !== undefined)
            .map(([rootId, entry]) => ({
                rootId,
                cwd: entry.target.cwd,
                phase: entry.phase,
                busy: entry.busy,
                ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
            }));
    }

    /**
     * Stop the VMs that run with looser rules than the settings now say: a network that is off now, fewer hosts, a
     * folder that is read only now. The calls that ran in them end, as a stop ends them. Looser settings change nothing
     * until a VM starts again (`state` says so). Returns the sessions it stopped.
     */
    async enforce(): Promise<number[]> {
        const settings = this.#options.settings();
        const stopped: number[] = [];

        for (const [rootId, entry] of [...this.#entries.entries()]) {
            const spec = entry.spec;

            if (entry.vm === undefined || spec === undefined) {
                continue;
            }

            if (looserThanSettings(spec, settings) && (await this.stop(rootId, STRICTER))) {
                stopped.push(rootId);
            }
        }

        return stopped;
    }

    /** Keep a session's VM from stopping while something that runs in it (a background task) needs it. */
    hold(target: VmTarget): () => void {
        this.#entry(target);

        return this.#busy(target.rootId);
    }

    /** Start a command in a session's VM, as its shell runs it; the VM starts first when it is not there. */
    async spawnShell(target: VmTarget, command: string, options: GuestExecOptions = {}) {
        this.#entry(target);
        const vm = await this.#ready(target.rootId, undefined, target);
        const shell = this.#entries.get(target.rootId)?.shell ?? "/bin/sh";

        return vm.exec([shell, "-lc", command], options);
    }

    get running(): number {
        return [...this.#entries.values()].filter((entry) => entry.vm !== undefined).length;
    }

    // ─── Runners that a crash left behind ───────────────────────────────────

    #pids(): { pid: number; vm: string }[] {
        try {
            const list = JSON.parse(readFileSync(this.#options.pidFile, "utf8")) as unknown;

            return Array.isArray(list)
                ? list.filter(
                      (item): item is { pid: number; vm: string } =>
                          typeof item?.pid === "number" && typeof item?.vm === "string",
                  )
                : [];
        } catch {
            return [];
        }
    }

    #writePids(list: { pid: number; vm: string }[]): void {
        try {
            mkdirSync(dirname(this.#options.pidFile), { recursive: true });
            writeFileSync(this.#options.pidFile, JSON.stringify(list));
        } catch (error) {
            this.#options.log(
                `sandbox: could not write ${this.#options.pidFile}: ${String(error)}`,
            );
        }
    }

    #remember(vm: GuestVm): void {
        const pid = vm.hostPid();

        if (pid !== null) {
            this.#writePids([
                ...this.#pids().filter((item) => item.pid !== pid),
                { pid, vm: vm.id },
            ]);
        }
    }

    #forget(vm: GuestVm): void {
        const pid = vm.hostPid();

        if (pid !== null) {
            this.#writePids(this.#pids().filter((item) => item.pid !== pid));
        }
    }

    /**
     * End runners of VMs that no entry holds: an earlier server left them running (it crashed, or was killed), or a
     * VM of an earlier module could not be closed. A process counts only when its command line still names Gondolin's
     * runner or QEMU: a number that another program reuses is left alone. A runner that is still there after the kill
     * stays in the pid file (`#orphans`).
     */
    async reapStale(): Promise<number> {
        const inspect = this.#options.inspect ?? psInspect;
        const kill =
            this.#options.kill ??
            ((pid: number) => {
                process.kill(pid, "SIGKILL");
            });
        const named = async (pid: number) =>
            /gondolin-krun-runner|qemu-system/.test((await inspect(pid)) ?? "");
        const held = new Set(
            [...this.#entries.values()]
                .flatMap((entry) => [entry.vm, entry.stuck?.vm])
                .map((vm) => vm?.hostPid()),
        );
        const kept: { pid: number; vm: string }[] = [];
        let reaped = 0;

        for (const item of this.#pids()) {
            if (held.has(item.pid)) {
                kept.push(item);
            } else if (await named(item.pid)) {
                try {
                    kill(item.pid);
                    reaped++;
                } catch {
                    // gone already
                }

                // A killed process is gone a moment later: its parent has to collect it.
                let alive = await named(item.pid);

                for (let wait = 0; alive && wait < 20; wait++) {
                    await new Promise((resolve) => setTimeout(resolve, 25));
                    alive = await named(item.pid);
                }

                if (alive) {
                    kept.push(item);
                }
            }
        }

        this.#writePids(kept);

        return reaped;
    }

    /** The runners that no entry holds and that are still there: a session's VM may be among them. */
    #orphans(): number[] {
        const held = new Set(
            [...this.#entries.values()]
                .flatMap((entry) => [entry.vm, entry.stuck?.vm])
                .map((vm) => vm?.hostPid()),
        );

        return this.#pids()
            .map((item) => item.pid)
            .filter((pid) => !held.has(pid));
    }

    async check(): Promise<HostCheck> {
        const settings = this.#options.settings();

        return this.#options.driver.check({ backend: settings.backend, image: settings.image });
    }
}
