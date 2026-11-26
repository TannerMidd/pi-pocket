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
import type { Backend, GuestVm, HostCheck, NetworkMode, SandboxDriver, VmSpec } from "./guest.ts";

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
}

export type Phase = "starting" | "running" | "stopped" | "error";

/** What the sheet shows of one session's VM. */
export interface VmState {
    readonly phase: Phase;
    readonly cwd: string;
    readonly mount: "rw" | "ro";
    readonly network: NetworkMode;
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
    busy: number;
    shell: string;
    last: number;
    timer?: NodeJS.Timeout;
    phase: Phase;
    startedAt?: number;
    stoppedAt?: number;
    note?: string;
    spec?: VmSpec;
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
}

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
                    ready: (signal) => this.#ready(rootId, signal),
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

            if (entry.vm !== undefined && entry.busy === 0) {
                void this.stop(target.rootId, "the session's folder changed");
            }
        }

        return entry;
    }

    #changed(rootId: number): void {
        try {
            this.#options.onChange?.(rootId);
        } catch (error) {
            this.#options.log(`sandbox: a change listener failed: ${String(error)}`);
        }
    }

    #busy(rootId: number): () => void {
        const entry = this.#entries.get(rootId);

        if (entry === undefined) {
            return () => {};
        }

        entry.busy++;
        this.#touch(rootId);
        let ended = false;

        return () => {
            if (!ended) {
                ended = true;
                entry.busy--;
                this.#touch(rootId);
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

    async #ready(rootId: number, signal?: AbortSignal): Promise<GuestVm> {
        const entry = this.#entries.get(rootId);

        if (entry === undefined) {
            throw new Error("The sandbox for this session is gone. Try again.");
        }

        if (this.#stopped) {
            throw new Error("The sandbox module is stopping, so nothing ran.");
        }

        if (entry.vm !== undefined) {
            return entry.vm;
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

    async #start(rootId: number, entry: Entry): Promise<GuestVm> {
        const settings = this.#options.settings();
        const running = [...this.#entries.entries()].filter(
            ([id, other]) =>
                id !== rootId && (other.vm !== undefined || other.starting !== undefined),
        ).length;

        if (running >= settings.maxVms) {
            const message = `The sandbox could not start: ${running} sandboxes already run (the most is ${settings.maxVms}). Stop one, or ask the owner to raise the limit.`;

            entry.phase = "error";
            entry.note = message;
            this.#changed(rootId);

            throw new Error(message);
        }

        const target = entry.target;
        const spec: VmSpec = {
            label: sessionLabel(rootId, target.cwd),
            backend: settings.backend,
            cwd: target.cwd,
            mount: settings.mount,
            protect: ["git"],
            readOnlyMounts: target.uploadDir === undefined ? [] : [target.uploadDir],
            network: { mode: settings.network, allowedHosts: settings.allowedHosts },
            cpus: settings.cpus,
            memoryMb: settings.memoryMb,
            diskMb: settings.diskMb,
            image: settings.image,
        };

        entry.phase = "starting";
        entry.note = undefined;
        entry.spec = spec;
        this.#changed(rootId);

        try {
            const vm = await this.#options.driver.start(spec);
            let shell = "/bin/sh";

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

            if (this.#stopped || this.#entries.get(rootId) !== entry) {
                await vm.close().catch(() => undefined);

                throw new Error("The sandbox was stopped while it started.");
            }

            entry.vm = vm;
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
                    this.#changed(rootId);
                }
            });
            this.#touch(rootId);
            this.#changed(rootId);

            return vm;
        } catch (error) {
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
        const vm = await this.#ready(rootId);

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

    /** Stop a session's VM. Commands that run in it end. The next call starts a new one. */
    async stop(rootId: number, why: string): Promise<boolean> {
        const entry = this.#entries.get(rootId);
        const vm = entry?.vm;

        if (entry === undefined) {
            return false;
        }

        clearTimeout(entry.timer);
        entry.timer = undefined;
        const starting = entry.starting;

        if (vm === undefined && starting === undefined) {
            return false;
        }

        entry.vm = undefined;
        entry.phase = "stopped";
        entry.stoppedAt = this.#now();
        entry.note = `Stopped: ${why}.`;
        this.#changed(rootId);

        if (starting !== undefined) {
            // Whoever waits for it gets an error from `#start`, which closes the VM it made.
            this.#entries.delete(rootId);
        }

        if (vm !== undefined) {
            this.#forget(vm);

            try {
                await vm.close();
            } catch (error) {
                this.#options.log(`sandbox: closing a VM failed: ${String(error)}`);
            }
        }

        return true;
    }

    /** Forget a session's entry, as when it was removed. */
    async release(rootId: number, why: string): Promise<void> {
        await this.stop(rootId, why);
        this.#entries.delete(rootId);
    }

    async stopAll(why: string): Promise<void> {
        this.#stopped = true;
        await Promise.all([...this.#entries.keys()].map((rootId) => this.stop(rootId, why)));
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

        return {
            phase: entry.phase,
            cwd: entry.target.cwd,
            mount: entry.spec?.mount ?? settings.mount,
            network: entry.spec?.network.mode ?? settings.network,
            ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
            ...(entry.stoppedAt === undefined ? {} : { stoppedAt: entry.stoppedAt }),
            ...(entry.note === undefined ? {} : { note: entry.note }),
            busy: entry.busy,
        };
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
     * End runners of VMs that an earlier server left running (it crashed, or was killed). A process counts only when
     * its command line still names Gondolin's runner or QEMU: a number that another program reuses is left alone.
     */
    async reapStale(): Promise<number> {
        const inspect = this.#options.inspect ?? psInspect;
        const kill =
            this.#options.kill ??
            ((pid: number) => {
                process.kill(pid, "SIGKILL");
            });
        let reaped = 0;

        for (const { pid } of this.#pids()) {
            const line = await inspect(pid);

            if (line !== undefined && /gondolin-krun-runner|qemu-system/.test(line)) {
                try {
                    kill(pid);
                    reaped++;
                } catch {
                    // gone already
                }
            }
        }

        this.#writePids([]);

        return reaped;
    }

    async check(): Promise<HostCheck> {
        const settings = this.#options.settings();

        return this.#options.driver.check({ backend: settings.backend, image: settings.image });
    }
}
