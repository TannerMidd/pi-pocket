/**
 * The Gondolin driver: it starts micro-VMs through the `@earendil-works/gondolin` package, which Set up installs into the
 * module's own folder (`<data>/gondolin`), never into Pi Pocket's. Nothing here runs until the owner chose Set up or a
 * session asks for a VM; the package is imported then, not when the server starts.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    accessSync,
    constants,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statfsSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { protectedMatcher } from "./policy.ts";
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
    SetupOptions,
    VmSpec,
} from "./guest.ts";

/** The package version Set up installs: pinned, so what runs is what was reviewed. */
export const GONDOLIN_VERSION = "0.14.0";
/** The image everyone gets, and the one with a browser that Set up builds on request. */
export const PLAIN_IMAGE = "alpine-base:latest";
export const BROWSER_IMAGE = "pocket-browser:latest";
/** The packages the browser image adds to the plain one. */
const BROWSER_PACKAGES = ["chromium", "ttf-freefont", "nss-tools"];

type Library = any;

function onPath(name: string): string | undefined {
    for (const folder of (process.env.PATH ?? "").split(delimiter)) {
        const candidate = join(folder, name);

        try {
            accessSync(candidate, constants.X_OK);

            return candidate;
        } catch {
            // try the next folder
        }
    }

    return undefined;
}

function kvm(): boolean {
    try {
        accessSync("/dev/kvm", constants.R_OK | constants.W_OK);

        return true;
    } catch {
        return false;
    }
}

function nodeAtLeast(major: number, minor: number): boolean {
    const [have, have2] = process.versions.node.split(".").map(Number);

    return have! > major || (have === major && have2! >= minor);
}

/** Node-style codes, from the words Gondolin's file errors carry (`…: ENOENT: no such file …`). */
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

class GondolinVm implements GuestVm {
    readonly id: string;
    readonly fs: GuestFs;
    readonly #vm: any;
    #closed = false;
    readonly #exits: ((reason: string) => void)[] = [];

    constructor(vm: any) {
        this.#vm = vm;
        this.id = String(vm.id);
        this.fs = wrapFs(vm, async (script, ...args) => {
            try {
                return (await vm.exec(["/bin/sh", "-c", script, ...args])).exitCode as number;
            } catch {
                return 1;
            }
        });
    }

    hostPid(): number | null {
        return this.#vm.getHostPid();
    }

    onExit(listener: (reason: string) => void): void {
        this.#exits.push(listener);
    }

    /** Called by the driver when the runner went away without a close. */
    ended(reason: string): void {
        if (!this.#closed) {
            this.#closed = true;

            for (const listener of this.#exits) {
                listener(reason);
            }
        }
    }

    exec(argv: string[], options: GuestExecOptions = {}): GuestProcess {
        const marker = randomUUID();

        // Gondolin ends the stream when its signal fires but leaves the guest's process running: end it here, by the
        // marker that each process and its children carry in their environment.
        const kill = () => {
            void this.#vm
                .exec([
                    "/bin/sh",
                    "-c",
                    'me=$$; for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = "$me" ] && continue; if tr "\\0" "\\n" < "$d/environ" 2>/dev/null | grep -qx "PI_POCKET_EXEC=$0"; then kill -9 "$p" 2>/dev/null; fi; done',
                    marker,
                ])
                .catch(() => undefined);
        };

        options.signal?.addEventListener("abort", kill, { once: true });

        const process_ = this.#vm.exec(argv, {
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            env: { ...options.env, PI_POCKET_EXEC: marker },
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            stdout: "pipe",
            stderr: "pipe",
            ...(options.stdin === true ? { stdin: true } : {}),
        });
        const result = Promise.resolve(process_).then((done: { exitCode: number }) => ({
            exitCode: done.exitCode,
        }));

        result.catch(() => undefined);

        return {
            output: async function* (): AsyncGenerator<GuestChunk> {
                for await (const chunk of process_.output()) {
                    yield { stream: chunk.stream, data: chunk.data };
                }
            },
            result,
            write: (data) => process_.write(typeof data === "string" ? data : Buffer.from(data)),
            end: () => process_.end(),
        };
    }

    async close(): Promise<void> {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        await this.#vm.close();
    }
}

export class GondolinDriver implements SandboxDriver {
    readonly #dir: string;
    #library: Promise<Library> | undefined;

    /** `dir` is the module's folder in the data folder: the package, and the image store, live in it. */
    constructor(dir: string) {
        this.#dir = dir;
    }

    /** Where the images are: Gondolin's own variable when the owner set it, else the module's folder. */
    get imageStore(): string {
        return process.env.GONDOLIN_IMAGE_STORE ?? join(this.#dir, "images");
    }

    #packageFile(): string {
        return join(
            this.#dir,
            "node_modules",
            "@earendil-works",
            "gondolin",
            "dist",
            "src",
            "index.js",
        );
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
                    "Gondolin is not installed. Open Menu → Extensions → Gondolin sandbox and tap Set up.",
                ),
            );
        }

        // The image store is the module's own: Gondolin reads this variable each time it needs the store.
        process.env.GONDOLIN_IMAGE_STORE ??= join(this.#dir, "images");
        this.#library ??= import(pathToFileURL(this.#packageFile()).href).catch(
            (error: unknown) => {
                this.#library = undefined;

                throw error;
            },
        );

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
        const krunPlatform = platform === "linux-x64" || platform === "darwin-arm64";
        const krunRunner = krunPlatform && existsSync(runner);
        const krunHardware = process.platform === "darwin" ? true : kvm();
        const qemu = onPath(
            process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64",
        );
        const accel = process.platform === "darwin" ? true : kvm();

        lines.push({
            name: "libkrun",
            optional: true,
            ok: krunPlatform && krunRunner && krunHardware,
            detail: !krunPlatform
                ? `No prebuilt libkrun runner for ${platform}.`
                : !krunRunner
                  ? "The libkrun runner package is not installed. Tap Set up."
                  : !krunHardware
                    ? "No access to /dev/kvm: add your user to the kvm group, or turn on virtualization."
                    : "Ready (uses KVM or the macOS hypervisor).",
        });
        lines.push({
            name: "QEMU",
            optional: true,
            ok: qemu !== undefined && accel,
            detail:
                qemu === undefined
                    ? process.platform === "darwin"
                        ? "Not installed: `brew install qemu`. Pi Pocket does not install system packages."
                        : "Not installed: install your distribution's QEMU package (for example `qemu-system-x86` on Debian). Pi Pocket does not install system packages."
                    : !accel
                      ? "Found, but /dev/kvm is not readable and writable: a VM would be far too slow."
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
                  : qemuOk
                    ? "qemu"
                    : krunOk
                      ? "krun"
                      : undefined;

        return { ...(backend === undefined ? {} : { backend }), lines };
    }

    async check(settings: { backend: Backend; image: string }): Promise<HostCheck> {
        const lines: CheckLine[] = [];
        const supported = process.platform === "linux" || process.platform === "darwin";

        lines.push({
            name: "Operating system",
            ok: supported,
            detail: supported
                ? `${process.platform} ${process.arch}`
                : "Gondolin runs on Linux and macOS only. On Windows, run Pi Pocket inside WSL 2.",
        });
        lines.push({
            name: "Node.js",
            ok: nodeAtLeast(22, 19),
            detail: `${process.versions.node} (Gondolin needs 22.19 or newer)`,
        });
        const installed = this.installed();

        lines.push({
            name: "Gondolin package",
            ok: installed,
            detail: installed
                ? `${GONDOLIN_VERSION}, in ${this.#dir}`
                : `Not installed. Tap Set up: it installs @earendil-works/gondolin@${GONDOLIN_VERSION} into ${this.#dir}.`,
        });
        const backend = supported ? this.#backend(settings.backend) : { lines: [] };

        lines.push(...backend.lines);
        lines.push({
            name: "Back end",
            ok: backend.backend !== undefined,
            detail:
                backend.backend === undefined
                    ? settings.backend === "auto"
                        ? "Neither libkrun nor QEMU can run here."
                        : `The back end you chose (${settings.backend}) cannot run here.`
                    : `Will use ${backend.backend}.`,
        });
        const images = installed ? this.#images() : [];
        const chosen = images.find((image) => image.name === settings.image);

        lines.push({
            name: "Image",
            ok: chosen !== undefined,
            detail:
                chosen !== undefined
                    ? `${chosen.name}${chosen.browser ? " (with a browser)" : ""}`
                    : `The image ${settings.image} is not in the store. Tap Set up.`,
        });

        try {
            mkdirSync(this.#dir, { recursive: true });
            const stats = statfsSync(this.#dir);
            const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;

            lines.push({
                name: "Disk",
                ok: freeGb >= 2,
                detail: `${freeGb.toFixed(1)} GB free where the image and VM disks live.`,
            });
        } catch {
            // no number to show
        }

        return {
            ok: lines.every((line) => line.ok || line.optional === true),
            lines,
            ...(backend.backend === undefined ? {} : { backend: backend.backend }),
            images,
        };
    }

    #images(): { name: string; browser: boolean }[] {
        const refs = join(this.imageStore, "refs");
        const found: { name: string; browser: boolean }[] = [];

        try {
            for (const name of readdirSync(refs)) {
                for (const tag of readdirSync(join(refs, name))) {
                    const reference = `${name}:${tag}`;
                    const arches = readdirSync(join(refs, name, tag));
                    const link = join(refs, name, tag, arches[0] ?? "");
                    let browser = false;

                    try {
                        const manifest = JSON.parse(
                            readFileSync(join(link, "manifest.json"), "utf8"),
                        ) as { config?: { alpine?: { rootfsPackages?: string[] } } };

                        browser =
                            manifest.config?.alpine?.rootfsPackages?.includes("chromium") === true;
                    } catch {
                        // no manifest: not a browser image as far as we know
                    }

                    found.push({ name: reference, browser });
                }
            }
        } catch {
            // no store yet
        }

        return found;
    }

    async setup(
        options: SetupOptions,
        progress: (line: string) => void,
        signal: AbortSignal,
    ): Promise<void> {
        mkdirSync(this.#dir, { recursive: true });

        if (!this.installed()) {
            progress(`Installing @earendil-works/gondolin@${GONDOLIN_VERSION} into ${this.#dir} …`);
            writeFileSync(
                join(this.#dir, "package.json"),
                JSON.stringify({ name: "pocket-gondolin", private: true }),
            );
            await run(
                process.platform === "win32" ? "npm.cmd" : "npm",
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

        if (!this.#images().some((image) => image.name === PLAIN_IMAGE)) {
            progress(`Downloading the guest image ${PLAIN_IMAGE} (about 110 MB) …`);
            await library.ensureImageSelector(PLAIN_IMAGE);
        }

        signal.throwIfAborted();

        if (options.browser && !this.#images().some((image) => image.name === BROWSER_IMAGE)) {
            await this.#buildBrowserImage(library, progress, signal);
        }

        progress("Set up is done.");
    }

    /**
     * The image with Chromium: Gondolin 0.14's own build gives a krun kernel that does not boot, so we build only the
     * root disk with it, and put that disk into the published image's directory, which has a kernel that boots.
     */
    async #buildBrowserImage(
        library: Library,
        progress: (line: string) => void,
        signal: AbortSignal,
    ): Promise<void> {
        const work = mkdtempSync(join(tmpdir(), "pocket-gondolin-build-"));

        try {
            progress("Building the image with a browser (downloads about 250 MB of packages) …");
            const config = library.getDefaultBuildConfig() as {
                alpine: { rootfsPackages: string[] };
            };

            config.alpine.rootfsPackages = [
                ...new Set([...config.alpine.rootfsPackages, ...BROWSER_PACKAGES]),
            ];
            const built = join(work, "built");

            await library.buildAssets(config, { outputDir: built, verbose: false });
            signal.throwIfAborted();
            progress("Putting the new root disk into the published image …");
            const plain = library.resolveImageSelector(PLAIN_IMAGE);
            const mix = join(work, "mix");

            mkdirSync(mix);

            for (const name of readdirSync(plain.assetDir)) {
                copyFileSync(join(plain.assetDir, name), join(mix, name));
            }

            copyFileSync(join(built, "rootfs.ext4"), join(mix, "rootfs.ext4"));
            const manifest = JSON.parse(readFileSync(join(mix, "manifest.json"), "utf8")) as {
                buildId: string;
                config: { alpine: { rootfsPackages: string[] } };
                checksums: { rootfs: string };
            };

            manifest.buildId = randomUUID();
            manifest.checksums.rootfs = await sha256(join(mix, "rootfs.ext4"));
            manifest.config.alpine.rootfsPackages = config.alpine.rootfsPackages;
            writeFileSync(join(mix, "manifest.json"), JSON.stringify(manifest, null, 2));
            const imported = library.importImageFromDirectory(mix) as {
                buildId: string;
                arch: string;
            };

            library.setImageRef(BROWSER_IMAGE, imported.buildId, imported.arch);
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    }

    async remove(): Promise<void> {
        this.#library = undefined;
        rmSync(this.#dir, { recursive: true, force: true });
    }

    async start(spec: VmSpec, signal?: AbortSignal): Promise<GuestVm> {
        const library = await this.#load();
        const check = await this.check({ backend: spec.backend, image: spec.image });

        if (!check.ok || check.backend === undefined) {
            const why = check.lines
                .filter((line) => !line.ok)
                .map((line) => `${line.name}: ${line.detail}`);

            throw new Error(`This machine cannot run the sandbox. ${why.join(" ")}`);
        }

        const { VM, RealFSProvider, ReadonlyProvider, ShadowProvider, createHttpHooks } = library;

        const real = (folder: string, readOnly: boolean): unknown => {
            const base = new RealFSProvider(folder);

            return readOnly ? new ReadonlyProvider(base) : base;
        };

        const matcher = protectedMatcher(spec.protect);
        const folder =
            spec.mount === "rw" && spec.protect.length > 0
                ? new ShadowProvider(real(spec.cwd, false), {
                      shouldShadow: (context: { op: string; path: string }) => matcher(context),
                      writeMode: "deny",
                  })
                : real(spec.cwd, spec.mount === "ro");
        const mounts: Record<string, unknown> = { [spec.cwd]: folder };

        for (const extra of spec.readOnlyMounts) {
            if (extra !== spec.cwd && existsSync(extra)) {
                mounts[extra] = real(extra, true);
            }
        }

        const network =
            spec.network.mode === "off"
                ? {}
                : spec.network.mode === "open"
                  ? createHttpHooks({})
                  : createHttpHooks({ allowedHosts: [...spec.network.allowedHosts] });
        const vm = await VM.create({
            sandbox: {
                vmm: check.backend,
                imagePath: spec.image,
                memory: `${spec.memoryMb}M`,
                cpus: spec.cpus,
                ...(spec.network.mode === "off" ? { netEnabled: false } : {}),
            },
            rootfs: { size: spec.diskMb * 1024 * 1024 },
            vfs: { mounts },
            ...(spec.network.mode === "off" ? {} : { httpHooks: network.httpHooks }),
            env: {},
            sessionLabel: spec.label,
        });

        if (signal?.aborted) {
            await vm.close().catch(() => undefined);
            signal.throwIfAborted();
        }

        // Make the VM boot now, so the first call does not pay for it unseen and a broken VM shows here.
        await vm.start();

        return new GondolinVm(vm);
    }
}

function sha256(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");

        createReadStream(file)
            .on("data", (chunk) => hash.update(chunk))
            .on("error", reject)
            .on("end", () => resolve(hash.digest("hex")));
    });
}

function run(
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
                if (line.trim() !== "") {
                    tail = `${tail}\n${line}`.slice(-2000);
                    progress(line.trim().slice(0, 300));
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
