/**
 * Sandbox registry, lazy VM lifecycle, workspace snapshot persistence across restarts/idle stops, diff extraction,
 * and orphan PID reaping for `pocket-gondolin`.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { DEFAULT_IMAGE } from "./driver.ts";
import {
    type Backend,
    type GuestVm,
    type NetworkMode,
    type SandboxDriver,
    parseAllowedHosts,
} from "./guest.ts";
import { GuestEnv, type GuestLease } from "./guest-env.ts";
import { inspectPatch, MAX_PATCH_BYTES, type PatchInspection } from "./patch.ts";
import { seedWorkspace, validateGitUrl, validateSeedSource } from "./seed.ts";

export const SANDBOX_SCHEME = "gondolin";

export interface SandboxSettings {
    backend: Backend;
    image: string;
    networkMode: NetworkMode;
    allowedHosts: string[];
    memoryMb: number;
    cpus: number;
    diskMb: number;
    idleMinutes: number;
}

export type SandboxSource =
    | { kind: "empty" }
    | { kind: "git"; repoUrl: string }
    | { kind: "repo"; sourcePath: string; includeUncommitted?: boolean };

export interface SandboxRecord {
    id: string;
    name: string;
    createdAt: number;
    source: SandboxSource;
    networkMode?: NetworkMode;
    allowedHosts?: string[];
    seeded: boolean;
    /** Initial seed commit SHA in `/workspace` used as the fixed base for diff/export. */
    baseCommit?: string;
    hasSnapshot: boolean;
}

export interface SandboxSummary {
    id: string;
    cwd: string;
    name: string;
    createdAt: number;
    source: SandboxSource;
    networkMode: NetworkMode;
    allowedHosts: string[];
    state: "stopped" | "starting" | "running";
    hasSnapshot: boolean;
}

interface RunningEntry {
    vm?: GuestVm;
    starting?: Promise<GuestVm>;
    busy: number;
    stopping: boolean;
    idleWaiters: Set<() => void>;
    activeAborts: Set<AbortController>;
    shell: string;
    lastActiveAt: number;
    idleTimer?: NodeJS.Timeout;
    closing?: Promise<void>;
}

const SANDBOX_ID_PATTERN = /^[a-z0-9][a-z0-9-]{3,47}$/;
const MAX_AGENTS_MD_BYTES = 32 * 1024;
const DEFAULT_CAPTURE_MAX_BYTES = 1 * 1024 * 1024;

export function sandboxUri(id: string): string {
    return `${SANDBOX_SCHEME}://${id}/workspace`;
}

/** Parses `gondolin://<id>/workspace` (or `gondolin://<id>`), returning the validated sandbox id or undefined. */
export function parseSandboxUri(cwd: string): string | undefined {
    const trimmed = cwd.trim();
    const prefix = `${SANDBOX_SCHEME}://`;

    if (!trimmed.toLowerCase().startsWith(prefix)) {
        return undefined;
    }

    const rest = trimmed.slice(prefix.length);
    const slash = rest.indexOf("/");
    const id = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
    const subpath = slash === -1 ? "/workspace" : rest.slice(slash);

    if (!SANDBOX_ID_PATTERN.test(id)) {
        return undefined;
    }

    if (subpath !== "" && subpath !== "/" && subpath !== "/workspace") {
        return undefined;
    }

    return id;
}

function writeJsonAtomic(file: string, value: unknown): void {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;

    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
}

async function execCapture(
    vm: GuestVm,
    argv: string[],
    cwd?: string,
    signal?: AbortSignal,
    maxBytes = DEFAULT_CAPTURE_MAX_BYTES,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();

    if (signal?.aborted) {
        controller.abort();
    } else {
        signal?.addEventListener("abort", onAbort, { once: true });
    }

    const proc = vm.exec(argv, {
        ...(cwd === undefined ? {} : { cwd }),
        signal: controller.signal,
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;
    const pump = (async () => {
        for await (const chunk of proc.output()) {
            totalBytes += chunk.data.byteLength;

            if (totalBytes > maxBytes) {
                exceeded = true;
                controller.abort();
                break;
            }

            if (chunk.stream === "stderr") {
                errChunks.push(Buffer.from(chunk.data));
            } else {
                outChunks.push(Buffer.from(chunk.data));
            }
        }
    })();

    try {
        const [res] = await Promise.allSettled([proc.result, pump]);

        if (exceeded) {
            throw new Error(
                `Sandbox command output exceeded the ${Math.max(1, Math.round(maxBytes / 1024 / 1024))} MiB limit.`,
            );
        }

        if (res.status === "rejected") {
            throw res.reason;
        }

        return {
            exitCode: res.value.exitCode,
            stdout: Buffer.concat(outChunks).toString("utf8"),
            stderr: Buffer.concat(errChunks).toString("utf8"),
        };
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }
}

export class SandboxManager {
    readonly #dir: string;
    readonly #dataDir: string;
    readonly #driver: SandboxDriver;
    readonly #getSettings: () => SandboxSettings;
    readonly #onChange: () => void;
    readonly #onWarning: (message: string) => void;
    readonly #records = new Map<string, SandboxRecord>();
    readonly #running = new Map<string, RunningEntry>();
    readonly #envs = new Map<string, GuestEnv>();
    readonly #pids = new Map<string, { pid: number; identity: string }>();
    #disposed = false;

    constructor(options: {
        dir: string;
        dataDir: string;
        driver: SandboxDriver;
        settings: () => SandboxSettings;
        onChange?: () => void;
        onWarning?: (message: string) => void;
    }) {
        this.#dir = options.dir;
        this.#dataDir = options.dataDir;
        this.#driver = options.driver;
        this.#getSettings = options.settings;
        this.#onChange = options.onChange ?? (() => undefined);
        this.#onWarning = options.onWarning ?? (() => undefined);

        mkdirSync(this.#dir, { recursive: true });
        this.#loadRecords();
        this.#reapOrphans();
    }

    get driver(): SandboxDriver {
        return this.#driver;
    }

    #recordsFile(): string {
        return join(this.#dir, "sandboxes.json");
    }

    #runLedgerFile(): string {
        return join(this.#dir, "run.json");
    }

    #sandboxDir(id: string): string {
        return join(this.#dir, "sandboxes", id);
    }

    #snapshotFile(id: string): string {
        return join(this.#sandboxDir(id), "workspace.tar.gz");
    }

    #loadRecords(): void {
        try {
            const parsed = JSON.parse(readFileSync(this.#recordsFile(), "utf8")) as {
                sandboxes?: SandboxRecord[];
            };

            for (const record of parsed.sandboxes ?? []) {
                if (typeof record.id === "string" && SANDBOX_ID_PATTERN.test(record.id)) {
                    this.#records.set(record.id, {
                        ...record,
                        hasSnapshot: existsSync(this.#snapshotFile(record.id)),
                    });
                }
            }
        } catch {
            // fresh install
        }
    }

    #saveRecords(): void {
        mkdirSync(this.#dir, { recursive: true });
        writeJsonAtomic(this.#recordsFile(), { sandboxes: [...this.#records.values()] });
    }

    #saveRunLedger(): void {
        mkdirSync(this.#dir, { recursive: true });
        writeJsonAtomic(this.#runLedgerFile(), {
            pids: Object.fromEntries(this.#pids.entries()),
        });
    }

    #reapOrphans(): void {
        try {
            const parsed = JSON.parse(readFileSync(this.#runLedgerFile(), "utf8")) as {
                pids?: Record<string, { pid?: unknown; identity?: unknown } | number>;
            };

            for (const entry of Object.values(parsed.pids ?? {})) {
                if (
                    entry !== null &&
                    typeof entry === "object" &&
                    typeof entry.pid === "number" &&
                    typeof entry.identity === "string" &&
                    entry.identity !== ""
                ) {
                    this.#driver.reapOrphan?.(entry.pid, entry.identity);
                }
            }

            rmSync(this.#runLedgerFile(), { force: true });
        } catch {
            // no prior ledger
        }
    }

    get(id: string): SandboxRecord | undefined {
        return this.#records.get(id);
    }

    list(): SandboxSummary[] {
        const defaults = this.#getSettings();

        return [...this.#records.values()]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((record) => {
                const entry = this.#running.get(record.id);
                const state: SandboxSummary["state"] =
                    entry?.vm !== undefined
                        ? "running"
                        : entry?.starting !== undefined
                          ? "starting"
                          : "stopped";

                return {
                    id: record.id,
                    cwd: sandboxUri(record.id),
                    name: record.name,
                    createdAt: record.createdAt,
                    source: record.source,
                    networkMode: record.networkMode ?? defaults.networkMode,
                    allowedHosts: record.allowedHosts ?? defaults.allowedHosts,
                    state,
                    hasSnapshot: record.hasSnapshot,
                };
            });
    }

    create(options: {
        name?: string;
        source?: SandboxSource;
        networkMode?: NetworkMode;
        allowedHosts?: string[];
    }): SandboxRecord {
        if (this.#disposed) {
            throw new Error("Sandbox manager is shut down.");
        }

        const id = `sb-${randomBytes(6).toString("hex")}`;
        const rawSource = options.source ?? { kind: "empty" };
        let source: SandboxSource;

        if (rawSource.kind === "repo") {
            const canonical = validateSeedSource(rawSource.sourcePath, this.#dataDir);

            source = {
                kind: "repo",
                sourcePath: canonical,
                ...(rawSource.includeUncommitted === true ? { includeUncommitted: true } : {}),
            };
        } else if (rawSource.kind === "git") {
            source = { kind: "git", repoUrl: validateGitUrl(rawSource.repoUrl) };
        } else {
            source = { kind: "empty" };
        }

        const record: SandboxRecord = {
            id,
            name: (options.name?.trim() || id).slice(0, 80),
            createdAt: Date.now(),
            source,
            ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
            ...(options.allowedHosts === undefined
                ? {}
                : { allowedHosts: parseAllowedHosts(options.allowedHosts) }),
            seeded: false,
            hasSnapshot: false,
        };

        mkdirSync(this.#sandboxDir(id), { recursive: true });
        this.#records.set(id, record);
        this.#saveRecords();
        this.#onChange();

        return record;
    }

    async resolveCwd(cwd: string, signal?: AbortSignal): Promise<string> {
        signal?.throwIfAborted();
        const id = parseSandboxUri(cwd);

        if (id === undefined || !this.#records.has(id)) {
            throw new Error(
                `Unknown Gondolin sandbox "${cwd}". Create a sandbox from Menu → Sandbox (Gondolin).`,
            );
        }

        return sandboxUri(id);
    }

    env(cwd: string): ExecutionEnv {
        const id = parseSandboxUri(cwd);

        if (id === undefined || !this.#records.has(id)) {
            throw new Error(`Unknown Gondolin sandbox "${cwd}".`);
        }

        let env = this.#envs.get(id);

        if (env === undefined) {
            env = new GuestEnv(
                `gondolin:${id}`,
                "/workspace",
                {
                    acquire: (kind, signal) => this.#acquire(id, kind, signal),
                    touch: () => this.#touch(id),
                },
                () => this.#running.get(id)?.shell ?? "/bin/sh",
            );
            this.#envs.set(id, env);
        }

        return env;
    }

    #entry(id: string): RunningEntry {
        let entry = this.#running.get(id);

        if (entry === undefined) {
            entry = {
                busy: 0,
                stopping: false,
                idleWaiters: new Set(),
                activeAborts: new Set(),
                shell: "/bin/sh",
                lastActiveAt: Date.now(),
            };
            this.#running.set(id, entry);
        }

        return entry;
    }

    async #acquire(id: string, kind: "fs" | "exec", signal?: AbortSignal): Promise<GuestLease> {
        const existing = this.#running.get(id);

        if (existing?.stopping === true) {
            throw new Error("Sandbox is stopping.");
        }

        const vm = await this.ensureRunning(id, signal);
        const entry = this.#entry(id);

        if (this.#disposed || entry.stopping || entry.vm !== vm) {
            throw new Error("Sandbox is stopping.");
        }

        entry.busy++;
        entry.lastActiveAt = Date.now();
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;

        const stopController = new AbortController();

        if (kind === "exec") {
            entry.activeAborts.add(stopController);
        }

        let done = false;

        return {
            vm,
            stopSignal: stopController.signal,
            release: () => {
                if (done) {
                    return;
                }

                done = true;
                entry.activeAborts.delete(stopController);
                entry.busy = Math.max(0, entry.busy - 1);
                entry.lastActiveAt = Date.now();

                if (entry.busy === 0) {
                    for (const wake of entry.idleWaiters) {
                        wake();
                    }

                    entry.idleWaiters.clear();
                }

                this.#scheduleIdle(id, entry);
            },
        };
    }

    async #waitForIdle(entry: RunningEntry, timeoutMs?: number): Promise<void> {
        if (entry.busy === 0) {
            return;
        }

        await new Promise<void>((resolve) => {
            let timer: NodeJS.Timeout | undefined;

            const wake = () => {
                if (timer !== undefined) {
                    clearTimeout(timer);
                }

                entry.idleWaiters.delete(wake);
                resolve();
            };

            entry.idleWaiters.add(wake);

            if (timeoutMs !== undefined) {
                timer = setTimeout(wake, timeoutMs);
                timer.unref();
            }
        });
    }

    #touch(id: string): void {
        const entry = this.#running.get(id);

        if (entry !== undefined) {
            entry.lastActiveAt = Date.now();
            this.#scheduleIdle(id, entry);
        }
    }

    #scheduleIdle(id: string, entry: RunningEntry): void {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;

        if (entry.vm === undefined || entry.busy > 0 || entry.stopping || this.#disposed) {
            return;
        }

        const idleMs = Math.max(1, this.#getSettings().idleMinutes) * 60_000;

        entry.idleTimer = setTimeout(() => {
            void this.stop(id).catch((error: unknown) => {
                this.#onWarning(
                    `Gondolin sandbox ${id} stayed running because saving /workspace failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
        }, idleMs);
        entry.idleTimer.unref();
    }

    async ensureRunning(id: string, signal?: AbortSignal): Promise<GuestVm> {
        if (this.#disposed) {
            throw new Error("Gondolin sandbox extension is disabled.");
        }

        const record = this.#records.get(id);

        if (record === undefined) {
            throw new Error(`Sandbox "${id}" does not exist.`);
        }

        const entry = this.#entry(id);

        if (entry.closing !== undefined) {
            await entry.closing;
        }

        if (entry.vm !== undefined) {
            this.#touch(id);

            return entry.vm;
        }

        if (entry.starting === undefined) {
            const settings = this.#getSettings();
            const networkMode = record.networkMode ?? settings.networkMode;
            const allowedHosts = record.allowedHosts ?? settings.allowedHosts;

            entry.starting = (async () => {
                const vm = await this.#driver.start(
                    {
                        sandboxId: id,
                        label: `pi-pocket:${id}`,
                        backend: settings.backend,
                        image: settings.image || DEFAULT_IMAGE,
                        memoryMb: settings.memoryMb,
                        cpus: settings.cpus,
                        diskMb: settings.diskMb,
                        network: {
                            mode: networkMode,
                            // Preserve an explicitly empty allow-list (deny all hosts); defaults come from readSettings().
                            allowedHosts: networkMode === "allowlist" ? [...allowedHosts] : [],
                        },
                    },
                    signal,
                    (runner) => {
                        const pid = runner.hostPid();
                        const identity = runner.hostIdentity?.();

                        if (pid !== null && identity !== undefined) {
                            this.#pids.set(id, { pid, identity });
                            this.#saveRunLedger();
                        }
                    },
                );

                try {
                    // Pick bash when available in the guest image, else sh.
                    const hasBash = await execCapture(
                        vm,
                        ["/bin/sh", "-c", "command -v bash >/dev/null 2>&1"],
                        "/",
                        signal,
                    );

                    entry.shell = hasBash.exitCode === 0 ? "/bin/bash" : "/bin/sh";

                    // Restore persisted workspace snapshot if present, otherwise seed once.
                    const snap = this.#snapshotFile(id);

                    if (existsSync(snap)) {
                        await this.#restoreWorkspaceSnapshot(vm, snap, signal);
                    } else {
                        const seedOptions =
                            record.source.kind === "repo"
                                ? { ...record.source, dataDir: this.#dataDir }
                                : record.source;
                        const seeded = await seedWorkspace(vm, seedOptions, signal);

                        record.seeded = true;

                        if (seeded.baseCommit !== undefined) {
                            record.baseCommit = seeded.baseCommit;
                        }

                        this.#saveRecords();
                    }

                    vm.onExit(() => {
                        if (entry.vm === vm) {
                            entry.vm = undefined;
                            clearTimeout(entry.idleTimer);
                            entry.idleTimer = undefined;
                            this.#pids.delete(id);
                            this.#saveRunLedger();
                            this.#onChange();
                        }
                    });

                    entry.vm = vm;
                    entry.lastActiveAt = Date.now();
                    this.#scheduleIdle(id, entry);
                    this.#onChange();

                    return vm;
                } catch (error) {
                    await vm.close().catch(() => undefined);
                    this.#pids.delete(id);
                    this.#saveRunLedger();

                    throw error;
                }
            })().finally(() => {
                entry.starting = undefined;
                this.#onChange();
            });
            this.#onChange();
        }

        return entry.starting;
    }

    /** Saves `/workspace` into `<data>/gondolin/sandboxes/<id>/workspace.tar.gz` before stopping the VM. */
    async #saveWorkspaceSnapshot(id: string, vm: GuestVm): Promise<void> {
        const packed = await execCapture(
            vm,
            ["/bin/sh", "-c", "tar -czf /tmp/pocket-workspace.tar.gz -C /workspace ."],
            "/",
        );

        if (packed.exitCode !== 0) {
            await vm.fs
                .remove("/tmp/pocket-workspace.tar.gz", { recursive: false, force: true })
                .catch(() => undefined);

            throw new Error(
                `Could not snapshot /workspace (tar exited ${packed.exitCode}): ${packed.stderr.trim() || "unknown error"}`,
            );
        }

        let bytes: Uint8Array;

        try {
            bytes = await vm.fs.readFile("/tmp/pocket-workspace.tar.gz");
        } finally {
            await vm.fs
                .remove("/tmp/pocket-workspace.tar.gz", { recursive: false, force: true })
                .catch(() => undefined);
        }

        const dir = this.#sandboxDir(id);

        mkdirSync(dir, { recursive: true });
        const target = this.#snapshotFile(id);
        const tmp = `${target}.${process.pid}.tmp`;

        writeFileSync(tmp, bytes, { mode: 0o600 });
        renameSync(tmp, target);

        const record = this.#records.get(id);

        if (record !== undefined) {
            record.hasSnapshot = true;
            this.#saveRecords();
        }
    }

    async #restoreWorkspaceSnapshot(
        vm: GuestVm,
        snapshotPath: string,
        signal?: AbortSignal,
    ): Promise<void> {
        await vm.fs.mkdir("/workspace", true, signal);
        const bytes = readFileSync(snapshotPath);

        await vm.fs.writeFile("/tmp/pocket-workspace.tar.gz", new Uint8Array(bytes), signal);
        const unpacked = await execCapture(
            vm,
            [
                "/bin/sh",
                "-c",
                "tar -xzf /tmp/pocket-workspace.tar.gz -C /workspace && rm -f /tmp/pocket-workspace.tar.gz",
            ],
            "/",
            signal,
        );

        if (unpacked.exitCode !== 0) {
            throw new Error(`Failed to restore sandbox workspace snapshot: ${unpacked.stderr}`);
        }
    }

    /**
     * Checkpoints `/workspace` and closes the VM cleanly. When `saveSnapshot` is enabled (the default) and saving
     * fails, the VM is kept running and the error is re-thrown so unsaved work is never silently discarded (unless
     * `force: true` is passed during server shutdown).
     */
    async stop(
        id: string,
        options: { saveSnapshot?: boolean; force?: boolean } = {},
    ): Promise<void> {
        const entry = this.#running.get(id);

        if (entry === undefined) {
            return;
        }

        entry.stopping = true;
        entry.closing ??= (async () => {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = undefined;

            let vm = entry.vm;

            if (vm === undefined && entry.starting !== undefined) {
                vm = await entry.starting.catch(() => undefined);
            }

            // Block new work (via `entry.stopping`), cancel interruptible commands, and wait for all active file writes
            // and commands to settle before snapshotting so no successful write is ever discarded on close.
            for (const ctrl of [...entry.activeAborts]) {
                ctrl.abort();
            }

            await this.#waitForIdle(entry, options.force === true ? 5_000 : undefined);

            if (vm !== undefined) {
                if (options.saveSnapshot !== false) {
                    try {
                        await this.#saveWorkspaceSnapshot(id, vm);
                    } catch (error) {
                        if (options.force !== true) {
                            entry.stopping = false;
                            this.#scheduleIdle(id, entry);

                            throw error;
                        }

                        this.#onWarning(
                            `Gondolin sandbox ${id} stopped during shutdown without saving /workspace: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }
                }

                await vm.close().catch(() => undefined);
            }

            entry.vm = undefined;
            entry.stopping = false;
            this.#pids.delete(id);
            this.#saveRunLedger();
            this.#onChange();
        })().finally(() => {
            entry.closing = undefined;
            entry.stopping = false;
        });

        await entry.closing;
    }

    async disposeWorkspace(cwd: string): Promise<void> {
        const id = parseSandboxUri(cwd);

        if (id !== undefined) {
            await this.stop(id, { saveSnapshot: true });
        }
    }

    async reset(id: string): Promise<void> {
        const record = this.#records.get(id);

        if (record === undefined) {
            throw new Error(`Sandbox "${id}" does not exist.`);
        }

        await this.stop(id, { saveSnapshot: false });
        rmSync(this.#snapshotFile(id), { force: true });
        record.hasSnapshot = false;
        record.seeded = false;
        delete record.baseCommit;
        this.#saveRecords();
        this.#onChange();
    }

    async remove(id: string): Promise<void> {
        await this.stop(id, { saveSnapshot: false });
        this.#records.delete(id);
        this.#running.delete(id);
        this.#envs.delete(id);
        rmSync(this.#sandboxDir(id), { recursive: true, force: true });
        this.#saveRecords();
        this.#onChange();
    }

    /** Reads `/workspace/AGENTS.md` from inside the VM (only when already running), bounded and never touching host FS. */
    async readGuestAgentsMd(cwd: string): Promise<string | undefined> {
        const id = parseSandboxUri(cwd);

        if (id === undefined) {
            return undefined;
        }

        const entry = this.#running.get(id);

        if (entry?.vm === undefined || entry.stopping) {
            return undefined;
        }

        let lease: GuestLease;

        try {
            lease = await this.#acquire(id, "fs");
        } catch {
            return undefined;
        }

        try {
            const bytes = await lease.vm.fs.readFile("/workspace/AGENTS.md");
            const sliced = bytes.subarray(0, MAX_AGENTS_MD_BYTES);
            const text = Buffer.from(sliced).toString("utf8").trim();

            return text === "" ? undefined : text;
        } catch {
            return undefined;
        } finally {
            lease.release();
        }
    }

    /**
     * Extracts a unified diff (all commits since the initial seed plus any staged/unstaged/untracked changes) from
     * `/workspace` inside the VM and runs security inspection.
     */
    async diff(id: string, signal?: AbortSignal): Promise<PatchInspection> {
        const lease = await this.#acquire(id, "exec", signal);
        const controller = new AbortController();
        const onAbort = () => controller.abort();

        if (signal?.aborted || lease.stopSignal.aborted) {
            controller.abort();
        } else {
            signal?.addEventListener("abort", onAbort, { once: true });
            lease.stopSignal.addEventListener("abort", onAbort, { once: true });
        }

        try {
            const record = this.#records.get(id);
            const base =
                record?.baseCommit !== undefined && /^[0-9a-f]{40,64}$/i.test(record.baseCommit)
                    ? record.baseCommit
                    : "HEAD";
            const out = await execCapture(
                lease.vm,
                [
                    "/bin/sh",
                    "-c",
                    'if ! command -v git >/dev/null 2>&1 || [ ! -d /workspace/.git ]; then echo "NO_GIT" >&2; exit 2; fi; git -C /workspace -c core.hooksPath=/dev/null -c core.fsmonitor=false add -N -A >/dev/null 2>&1; git -C /workspace -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.quotepath=false -c diff.external= -c diff.mnemonicPrefix=false -c diff.noprefix=false diff --no-ext-diff --no-color "$1"',
                    "sh",
                    base,
                ],
                "/workspace",
                controller.signal,
                MAX_PATCH_BYTES + 1,
            );

            if (out.exitCode !== 0) {
                throw new Error(
                    out.stderr.includes("NO_GIT")
                        ? "This sandbox does not have a git repository in /workspace."
                        : `Could not read diff from sandbox: ${out.stderr.trim() || out.stdout.trim()}`,
                );
            }

            return inspectPatch(out.stdout);
        } finally {
            signal?.removeEventListener("abort", onAbort);
            lease.stopSignal.removeEventListener("abort", onAbort);
            lease.release();
        }
    }

    async closeAll(): Promise<void> {
        this.#disposed = true;
        const ids = [...this.#running.keys()];

        await Promise.allSettled(
            ids.map((id) => this.stop(id, { saveSnapshot: true, force: true })),
        );
        this.#envs.clear();
    }
}
