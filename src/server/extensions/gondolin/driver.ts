/**
 * Real `@earendil-works/gondolin` driver: installed on demand into `<data>/gondolin` (never a root dependency).
 * Supports Linux (`libkrun` or `qemu` with `/dev/kvm`) and macOS Apple Silicon (`libkrun` via Hypervisor.framework,
 * or `qemu`). Mounts NO host directories into the VM — `/workspace` lives on the VM's own private disk.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    accessSync,
    constants,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statfsSync,
    writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
    Backend,
    CheckLine,
    GuestChunk,
    GuestError,
    GuestExecOptions,
    GuestFs,
    GuestProcess,
    GuestStat,
    GuestVm,
    HostCheck,
    SandboxDriver,
    VmSpec,
} from "./guest.ts";

/** Pinned Gondolin version installed on demand by Setup. */
export const GONDOLIN_VERSION = "0.14.0";
/** Stock published Alpine guest image (reliable on both Linux and macOS Apple Silicon). */
export const DEFAULT_IMAGE = "alpine-base:latest";

type Library = any;

export function platformUnsupportedReason(
    platform = process.platform,
    arch = process.arch,
): string | undefined {
    if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
        return undefined;
    }

    if (platform === "darwin" && arch === "arm64") {
        return undefined;
    }

    return `Gondolin sandboxes are supported on Linux (x64/arm64) and macOS Apple Silicon (not ${platform}/${arch}).`;
}

function onPath(name: string): string | undefined {
    for (const folder of (process.env.PATH ?? "").split(delimiter)) {
        if (folder === "") {
            continue;
        }

        const candidate = join(folder, name);

        try {
            accessSync(candidate, constants.X_OK);

            return candidate;
        } catch {
            // try next PATH entry
        }
    }

    return undefined;
}

function hasKvm(): boolean {
    try {
        accessSync("/dev/kvm", constants.R_OK | constants.W_OK);

        return true;
    } catch {
        return false;
    }
}

function nodeAtLeast(major: number, minor: number): boolean {
    const [haveMajor = 0, haveMinor = 0] = process.versions.node.split(".").map(Number);

    return haveMajor > major || (haveMajor === major && haveMinor >= minor);
}

function guestError(error: unknown): GuestError {
    const result = (error instanceof Error ? error : new Error(String(error))) as GuestError;
    const code = /\b(E[A-Z]{3,7}):/.exec(result.message)?.[1];

    if (code !== undefined) {
        result.code = code;
    }

    return result;
}

function wrapFs(
    vm: any,
    runShell: (script: string, ...args: string[]) => Promise<number>,
): GuestFs {
    const call = async <T>(run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        } catch (error) {
            throw guestError(error);
        }
    };

    return {
        readFile: (path, signal) =>
            call(async () => new Uint8Array(await vm.fs.readFile(path, { signal }))),
        writeFile: (path, data, signal) =>
            call(() => vm.fs.writeFile(path, Buffer.from(data), { signal })),
        stat: (path, follow, signal) =>
            call(async (): Promise<GuestStat> => {
                const stats = await vm.fs.stat(path, { signal });
                const link = follow ? false : (await runShell('[ -L "$0" ]', path)) === 0;

                return {
                    kind: link
                        ? "symlink"
                        : stats.isDirectory()
                          ? "directory"
                          : stats.isFile()
                            ? "file"
                            : "other",
                    size: stats.size,
                    mtimeMs: stats.mtimeMs,
                };
            }),
        list: (path, signal) => call(() => vm.fs.listDir(path, { signal })),
        mkdir: (path, recursive, signal) => call(() => vm.fs.mkdir(path, { recursive, signal })),
        remove: (path, options, signal) =>
            call(() => vm.fs.deleteFile(path, { ...options, signal })),
        rename: (from, to, signal) => call(() => vm.fs.rename(from, to, { signal })),
    };
}

const GONDOLIN_RUNNER_PATTERN = /gondolin-krun-runner|qemu-system/;

/**
 * Returns a stable `(startTime:command)` identity string ONLY when `pid` is a live Gondolin/QEMU runner process.
 * Returns `undefined` when the process is gone, belongs to another program, or cannot be verified (fail-safe: never
 * kill an unverified PID).
 */
export function processIdentity(pid: number): string | undefined {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
        return undefined;
    }

    if (process.platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
            const closeParen = stat.lastIndexOf(")");

            if (closeParen < 0) {
                return undefined;
            }

            const fields = stat.slice(closeParen + 2).split(" ");
            const state = fields[0];
            const startTime = fields[19];

            if (
                state === "Z" ||
                state === "X" ||
                !startTime ||
                !GONDOLIN_RUNNER_PATTERN.test(cmdline)
            ) {
                return undefined;
            }

            return `linux:${startTime}:${cmdline}`;
        } catch {
            return undefined;
        }
    }

    if (process.platform === "darwin") {
        try {
            const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart=,command="], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();

            if (out === "" || !GONDOLIN_RUNNER_PATTERN.test(out)) {
                return undefined;
            }

            return `darwin:${out}`;
        } catch {
            return undefined;
        }
    }

    return undefined;
}

class GondolinVm implements GuestVm {
    readonly id: string;
    readonly fs: GuestFs;
    readonly #vm: any;
    readonly #pid: number | null;
    readonly #identity: string | undefined;
    #closed = false;
    #closing: Promise<void> | undefined;
    readonly #exits: ((reason: string) => void)[] = [];

    constructor(vm: any) {
        this.#vm = vm;
        this.#pid = typeof vm.getHostPid === "function" ? vm.getHostPid() : null;
        this.#identity = this.#pid === null ? undefined : processIdentity(this.#pid);
        this.id = String(vm.id ?? randomUUID());

        try {
            vm.server?.on?.("exit", (info: { code?: number | null; signal?: string | null }) =>
                this.#ended(
                    info?.signal
                        ? `the VM runner stopped (${info.signal})`
                        : `the VM runner exited${info?.code === undefined || info?.code === null ? "" : ` (code ${info.code})`}`,
                ),
            );
        } catch {
            // older package without exit event
        }

        this.fs = wrapFs(vm, async (script, ...args) => {
            try {
                return (await vm.exec(["/bin/sh", "-c", script, ...args])).exitCode as number;
            } catch {
                return 1;
            }
        });
    }

    hostPid(): number | null {
        return this.#pid;
    }

    hostIdentity(): string | undefined {
        return this.#identity;
    }

    onExit(listener: (reason: string) => void): void {
        this.#exits.push(listener);
    }

    #ended(reason: string): void {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        void Promise.resolve(this.#vm.close()).catch(() => undefined);

        for (const listener of this.#exits) {
            try {
                listener(reason);
            } catch {
                // listener errors must not escape runner exit events
            }
        }
    }

    exec(argv: string[], options: GuestExecOptions = {}): GuestProcess {
        const marker = randomUUID();
        let killing: Promise<void> | undefined;

        const kill = () => {
            killing = Promise.resolve()
                .then(() =>
                    this.#vm.exec([
                        "/bin/sh",
                        "-c",
                        'me=$$; for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = "$me" ] && continue; if tr "\\0" "\\n" < "$d/environ" 2>/dev/null | grep -qx "PI_POCKET_EXEC=$0"; then kill -9 "$p" 2>/dev/null; fi; done',
                        marker,
                    ]),
                )
                .then(
                    () => undefined,
                    () => undefined,
                );
        };

        options.signal?.addEventListener("abort", kill, { once: true });

        const proc = this.#vm.exec(argv, {
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            env: { ...options.env, PI_POCKET_EXEC: marker },
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            stdout: "pipe",
            stderr: "pipe",
            ...(options.stdin === true ? { stdin: true } : {}),
        });
        const result = Promise.resolve(proc).then(
            async (done: { exitCode: number }) => {
                await killing;

                return { exitCode: done.exitCode };
            },
            async (error: unknown) => {
                await killing;

                throw error;
            },
        );

        result.catch(() => undefined);

        return {
            output: async function* (): AsyncGenerator<GuestChunk> {
                for await (const chunk of proc.output()) {
                    yield { stream: chunk.stream, data: chunk.data };
                }
            },
            result,
            write: (data) => proc.write(typeof data === "string" ? data : Buffer.from(data)),
            end: () => proc.end(),
        };
    }

    async checkpoint(path: string): Promise<void> {
        if (typeof this.#vm.checkpoint === "function") {
            await this.#vm.checkpoint(path);
        }
    }

    close(): Promise<void> {
        this.#closing ??= (async () => {
            if (this.#closed) {
                return;
            }

            try {
                await this.#vm.close();
            } catch {
                // fall through to PID verification
            }

            if (
                this.#pid !== null &&
                this.#identity !== undefined &&
                processIdentity(this.#pid) === this.#identity
            ) {
                for (const target of [-this.#pid, this.#pid]) {
                    try {
                        process.kill(target, "SIGKILL");
                    } catch {
                        // already gone
                    }
                }
            }

            this.#closed = true;
        })().finally(() => {
            this.#closing = undefined;
        });

        return this.#closing;
    }
}

export class GondolinDriver implements SandboxDriver {
    readonly #dir: string;
    #library: Promise<Library> | undefined;

    constructor(dir: string) {
        this.#dir = dir;
    }

    get imageStore(): string {
        return process.env.GONDOLIN_IMAGE_STORE ?? join(this.#dir, "images");
    }

    installed(): boolean {
        try {
            const manifest = JSON.parse(
                readFileSync(
                    join(this.#dir, "node_modules", "@earendil-works", "gondolin", "package.json"),
                    "utf8",
                ),
            ) as { version?: string };

            return manifest.version === GONDOLIN_VERSION;
        } catch {
            return false;
        }
    }

    #load(): Promise<Library> {
        if (!this.installed()) {
            return Promise.reject(
                new Error(
                    "Gondolin is not installed. Open Menu → Sandbox (Gondolin) and click Set up.",
                ),
            );
        }

        process.env.GONDOLIN_IMAGE_STORE ??= join(this.#dir, "images");
        const entry = join(
            this.#dir,
            "node_modules",
            "@earendil-works",
            "gondolin",
            "dist",
            "src",
            "index.js",
        );

        this.#library ??= import(pathToFileURL(entry).href).catch((error: unknown) => {
            this.#library = undefined;

            throw error;
        });

        return this.#library;
    }

    #backend(wanted: Backend): { backend?: "krun" | "qemu"; lines: CheckLine[] } {
        const lines: CheckLine[] = [];
        const platform = `${process.platform}-${process.arch}`;
        const runner = join(
            this.#dir,
            "node_modules",
            "@earendil-works",
            `gondolin-krun-runner-${platform}`,
        );
        const krunSupported = platform === "linux-x64" || platform === "darwin-arm64";
        const krunRunner = krunSupported && existsSync(runner);
        const hwAccel = process.platform === "darwin" ? true : hasKvm();
        const qemu = onPath(
            process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64",
        );

        lines.push({
            name: "libkrun",
            optional: true,
            ok: krunSupported && krunRunner && hwAccel,
            detail: !krunSupported
                ? `No prebuilt libkrun runner for ${platform}.`
                : !krunRunner
                  ? "libkrun runner package is not installed yet. Click Set up."
                  : !hwAccel
                    ? "No read/write access to /dev/kvm (add your user to the kvm group)."
                    : process.platform === "darwin"
                      ? "Ready (Apple Hypervisor.framework)."
                      : "Ready (KVM).",
        });
        lines.push({
            name: "QEMU",
            optional: true,
            ok: qemu !== undefined && hwAccel,
            detail:
                qemu === undefined
                    ? "Not found on PATH (optional when libkrun is available)."
                    : !hwAccel
                      ? "Found, but /dev/kvm is not accessible."
                      : `Found at ${qemu}.`,
        });

        const krunOk = lines[0]!.ok;
        const qemuOk = lines[1]!.ok;
        const backend =
            wanted === "krun"
                ? krunOk
                    ? "krun"
                    : undefined
                : wanted === "qemu"
                  ? qemuOk
                      ? "qemu"
                      : undefined
                  : krunOk
                    ? "krun"
                    : qemuOk
                      ? "qemu"
                      : undefined;

        return { ...(backend === undefined ? {} : { backend }), lines };
    }

    #images(): { name: string; git?: boolean }[] {
        const refs = join(this.imageStore, "refs");
        const found: { name: string; git?: boolean }[] = [];

        try {
            for (const name of readdirSync(refs)) {
                for (const tag of readdirSync(join(refs, name))) {
                    found.push({ name: `${name}:${tag}` });
                }
            }
        } catch {
            // store not initialized yet
        }

        return found;
    }

    async check(settings: { backend: Backend; image: string }): Promise<HostCheck> {
        const lines: CheckLine[] = [];
        const unsupported = platformUnsupportedReason();

        lines.push({
            name: "Operating system",
            ok: unsupported === undefined,
            detail: unsupported ?? `${process.platform} ${process.arch}`,
        });
        lines.push({
            name: "Node.js",
            ok: nodeAtLeast(22, 19),
            detail: `${process.versions.node} (requires >= 22.19)`,
        });
        const installed = this.installed();

        lines.push({
            name: "Gondolin package",
            ok: installed,
            detail: installed
                ? `@earendil-works/gondolin@${GONDOLIN_VERSION} installed`
                : `Not installed yet. Click Set up to install @earendil-works/gondolin@${GONDOLIN_VERSION} into ${this.#dir}.`,
        });

        const backend = unsupported === undefined ? this.#backend(settings.backend) : { lines: [] };

        lines.push(...backend.lines);
        lines.push({
            name: "VM backend",
            ok: backend.backend !== undefined,
            detail:
                backend.backend !== undefined
                    ? `Will use ${backend.backend}.`
                    : settings.backend === "auto"
                      ? "Neither libkrun nor QEMU is ready on this machine."
                      : `Selected backend (${settings.backend}) is not available.`,
        });

        const images = installed ? this.#images() : [];
        const hasImage = images.some((img) => img.name === settings.image);

        lines.push({
            name: "Guest image",
            ok: hasImage,
            detail: hasImage
                ? `${settings.image} ready`
                : `${settings.image} is not downloaded yet. Click Set up.`,
        });

        try {
            mkdirSync(this.#dir, { recursive: true });
            const stats = statfsSync(this.#dir);
            const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;

            lines.push({
                name: "Disk space",
                ok: freeGb >= 2,
                detail: `${freeGb.toFixed(1)} GB free`,
            });
        } catch {
            // statfs not available
        }

        return {
            ok: lines.every((line) => line.ok || line.optional === true),
            lines,
            ...(backend.backend === undefined ? {} : { backend: backend.backend }),
            images,
        };
    }

    async setup(progress: (line: string) => void, signal: AbortSignal): Promise<void> {
        const unsupported = platformUnsupportedReason();

        if (unsupported !== undefined) {
            throw new Error(unsupported);
        }

        mkdirSync(this.#dir, { recursive: true });

        if (!this.installed()) {
            progress(`Installing @earendil-works/gondolin@${GONDOLIN_VERSION} …`);
            writeFileSync(
                join(this.#dir, "package.json"),
                JSON.stringify({ name: "pocket-gondolin", private: true }),
            );
            await runCommand(
                "npm",
                [
                    "install",
                    `@earendil-works/gondolin@${GONDOLIN_VERSION}`,
                    "--save-exact",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--no-update-notifier",
                ],
                this.#dir,
                progress,
                signal,
            );
        }

        const library = await this.#load();

        if (!this.#images().some((img) => img.name === DEFAULT_IMAGE)) {
            progress(`Downloading guest image ${DEFAULT_IMAGE} …`);
            await library.ensureImageSelector(DEFAULT_IMAGE);
        }

        signal.throwIfAborted();
        progress("Setup complete.");
    }

    async start(
        spec: VmSpec,
        signal?: AbortSignal,
        onRunner?: (vm: GuestVm) => void,
    ): Promise<GuestVm> {
        const library = await this.#load();
        const check = await this.check({ backend: spec.backend, image: spec.image });

        if (!check.ok || check.backend === undefined) {
            const why = check.lines
                .filter((line) => !line.ok && line.optional !== true)
                .map((line) => `${line.name}: ${line.detail}`);

            throw new Error(`This machine cannot start a Gondolin sandbox. ${why.join(" ")}`);
        }

        const { VM, createHttpHooks } = library;
        const network =
            spec.network.mode === "off"
                ? {}
                : spec.network.mode === "open"
                  ? createHttpHooks({})
                  : createHttpHooks({ allowedHosts: [...spec.network.allowedHosts] });

        // Strictly zero host VFS mounts: the guest operates solely on its own isolated disk.
        const vm = await VM.create({
            sandbox: {
                vmm: check.backend,
                imagePath: spec.image,
                memory: `${spec.memoryMb}M`,
                cpus: spec.cpus,
                ...(spec.network.mode === "off" ? { netEnabled: false } : {}),
            },
            rootfs: { size: spec.diskMb * 1024 * 1024 },
            vfs: { mounts: {} },
            ...(spec.network.mode === "off" ? {} : { httpHooks: network.httpHooks }),
            env: { HOME: "/root", TERM: "xterm-256color" },
            sessionLabel: spec.label,
        });

        if (signal?.aborted) {
            await vm.close().catch(() => undefined);
            signal.throwIfAborted();
        }

        let wrapped: GondolinVm | undefined;

        const own = () => {
            if (wrapped === undefined && vm.getHostPid?.() !== null) {
                wrapped = new GondolinVm(vm);
                onRunner?.(wrapped);
            }
        };

        try {
            await vm.start();
            own();
        } catch (error) {
            own();
            await (wrapped ? wrapped.close() : vm.close()).catch(() => undefined);

            throw error;
        }

        return wrapped ?? new GondolinVm(vm);
    }

    reapOrphan(pid: number, expectedIdentity: string): void {
        if (
            !Number.isSafeInteger(pid) ||
            pid <= 1 ||
            expectedIdentity === "" ||
            processIdentity(pid) !== expectedIdentity
        ) {
            return;
        }

        for (const target of [-pid, pid]) {
            try {
                process.kill(target, "SIGKILL");
            } catch {
                // already exited
            }
        }
    }
}

function runCommand(
    command: string,
    args: string[],
    cwd: string,
    progress: (line: string) => void,
    signal: AbortSignal,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal });
        let tail = "";

        const note = (data: Buffer) => {
            for (const line of data.toString("utf8").split("\n")) {
                const clean = line.trim();

                if (clean !== "") {
                    tail = `${tail}\n${clean}`.slice(-2000);
                    progress(clean.slice(0, 300));
                }
            }
        };

        child.stdout.on("data", note);
        child.stderr.on("data", note);
        child.once("error", reject);
        child.once("close", (code) =>
            code === 0
                ? resolve()
                : reject(new Error(`${command} ${args[0]} failed (${code}):${tail}`)),
        );
    });
}
