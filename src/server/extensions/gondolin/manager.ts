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
    DEFAULT_ALLOWED_HOSTS,
    type Backend,
    type GuestVm,
    type NetworkMode,
    type SandboxDriver,
    parseAllowedHosts,
} from "./guest.ts";
import { GuestEnv } from "./guest-env.ts";
import { inspectPatch, type PatchInspection } from "./patch.ts";
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
    shell: string;
    lastActiveAt: number;
    idleTimer?: NodeJS.Timeout;
    closing?: Promise<void>;
}

const SANDBOX_ID_PATTERN = /^[a-z0-9][a-z0-9-]{3,47}$/;
const MAX_AGENTS_MD_BYTES = 32 * 1024;

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
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = vm.exec(argv, {
        ...(cwd === undefined ? {} : { cwd }),
        ...(signal === undefined ? {} : { signal }),
    });
    let stdout = "";
    let stderr = "";
    const pump = (async () => {
        for await (const chunk of proc.output()) {
            const text = Buffer.from(chunk.data).toString("utf8");

            if (chunk.stream === "stderr") {
                stderr += text;
            } else {
                stdout += text;
            }
        }
    })();
    const [res] = await Promise.all([proc.result, pump]);

    return { exitCode: res.exitCode, stdout, stderr };
}

export class SandboxManager {
    readonly #dir: string;
    readonly #dataDir: string;
    readonly #driver: SandboxDriver;
    readonly #getSettings: () => SandboxSettings;
    readonly #onChange: () => void;
    readonly #records = new Map<string, SandboxRecord>();
    readonly #running = new Map<string, RunningEntry>();
    readonly #envs = new Map<string, GuestEnv>();
    readonly #pids = new Map<string, number>();
    #disposed = false;

    constructor(options: {
        dir: string;
        dataDir: string;
        driver: SandboxDriver;
        settings: () => SandboxSettings;
        onChange?: () => void;
    }) {
        this.#dir = options.dir;
        this.#dataDir = options.dataDir;
        this.#driver = options.driver;
        this.#getSettings = options.settings;
        this.#onChange = options.onChange ?? (() => undefined);

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
                pids?: Record<string, number>;
            };

            for (const pid of Object.values(parsed.pids ?? {})) {
                if (typeof pid === "number") {
                    this.#driver.reapOrphan?.(pid);
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
                    ready: (signal) => this.ensureRunning(id, signal),
                    busy: () => this.#markBusy(id),
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
            entry = { busy: 0, shell: "/bin/sh", lastActiveAt: Date.now() };
            this.#running.set(id, entry);
        }

        return entry;
    }

    #markBusy(id: string): () => void {
        const entry = this.#entry(id);

        entry.busy++;
        entry.lastActiveAt = Date.now();
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;

        let done = false;

        return () => {
            if (done) {
                return;
            }

            done = true;
            entry.busy = Math.max(0, entry.busy - 1);
            entry.lastActiveAt = Date.now();
            this.#scheduleIdle(id, entry);
        };
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

        if (entry.vm === undefined || entry.busy > 0 || this.#disposed) {
            return;
        }

        const idleMs = Math.max(1, this.#getSettings().idleMinutes) * 60_000;

        entry.idleTimer = setTimeout(() => {
            void this.stop(id).catch(() => undefined);
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
                            allowedHosts:
                                networkMode === "allowlist"
                                    ? allowedHosts.length > 0
                                        ? allowedHosts
                                        : [...DEFAULT_ALLOWED_HOSTS]
                                    : [],
                        },
                    },
                    signal,
                    (runner) => {
                        const pid = runner.hostPid();

                        if (pid !== null) {
                            this.#pids.set(id, pid);
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
                        await seedWorkspace(vm, record.source, signal);
                        record.seeded = true;
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
            return;
        }

        const bytes = await vm.fs.readFile("/tmp/pocket-workspace.tar.gz");

        await vm.fs
            .remove("/tmp/pocket-workspace.tar.gz", { recursive: false, force: true })
            .catch(() => undefined);

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

    /** Checkpoints `/workspace` and closes the VM cleanly. */
    async stop(id: string, options: { saveSnapshot?: boolean } = {}): Promise<void> {
        const entry = this.#running.get(id);

        if (entry === undefined) {
            return;
        }

        entry.closing ??= (async () => {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = undefined;

            let vm = entry.vm;

            if (vm === undefined && entry.starting !== undefined) {
                vm = await entry.starting.catch(() => undefined);
            }

            if (vm !== undefined) {
                if (options.saveSnapshot !== false) {
                    await this.#saveWorkspaceSnapshot(id, vm).catch(() => undefined);
                }

                await vm.close().catch(() => undefined);
            }

            entry.vm = undefined;
            this.#pids.delete(id);
            this.#saveRunLedger();
            this.#onChange();
        })().finally(() => {
            entry.closing = undefined;
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

        const vm = this.#running.get(id)?.vm;

        if (vm === undefined) {
            return undefined;
        }

        try {
            const bytes = await vm.fs.readFile("/workspace/AGENTS.md");
            const sliced = bytes.subarray(0, MAX_AGENTS_MD_BYTES);
            const text = Buffer.from(sliced).toString("utf8").trim();

            return text === "" ? undefined : text;
        } catch {
            return undefined;
        }
    }

    /** Extracts a unified diff (tracked + untracked files) from `/workspace` inside the VM and runs security inspection. */
    async diff(id: string, signal?: AbortSignal): Promise<PatchInspection> {
        const vm = await this.ensureRunning(id, signal);
        // Stage untracked files with intent-to-add (`git add -N`) in a clean read-only way so `git diff HEAD` captures new files too.
        const out = await execCapture(
            vm,
            [
                "/bin/sh",
                "-c",
                'if ! command -v git >/dev/null 2>&1 || [ ! -d /workspace/.git ]; then echo "NO_GIT" >&2; exit 2; fi; git -C /workspace add -N -A >/dev/null 2>&1; git -C /workspace -c diff.mnemonicPrefix=false -c diff.noprefix=false diff --no-ext-diff --no-color HEAD',
            ],
            "/workspace",
            signal,
        );

        if (out.exitCode !== 0) {
            throw new Error(
                out.stderr.includes("NO_GIT")
                    ? "This sandbox does not have a git repository in /workspace."
                    : `Could not read diff from sandbox: ${out.stderr.trim() || out.stdout.trim()}`,
            );
        }

        return inspectPatch(out.stdout);
    }

    async closeAll(): Promise<void> {
        this.#disposed = true;
        const ids = [...this.#running.keys()];

        await Promise.allSettled(ids.map((id) => this.stop(id, { saveSnapshot: true })));
        this.#envs.clear();
    }
}
