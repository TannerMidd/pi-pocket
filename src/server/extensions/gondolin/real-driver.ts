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
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    statfsSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { sandboxPlatformProblem } from "../../sandbox.ts";
import { GIT_WRAPPER, guestGitConfig } from "./git.ts";
import { gitProtected, holdsGitDir, within } from "./policy.ts";
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
/** The standard image with git added, built on this machine by Set up. The standard choice uses it when it is there. */
export const GIT_IMAGE = "pocket-base:latest";
/** The packages the browser image adds to the plain one. */
const BROWSER_PACKAGES = ["chromium", "ttf-freefont", "nss-tools"];
/** What Set up adds to every image it builds: Pi needs git in the VM for status, diff, commit, branch, log, and stash. */
const GIT_PACKAGES = ["git"];

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

/** The image a choice runs: the standard one is the published image, or the one built with git when it is there. */
export function resolveImage(
    choice: string,
    images: readonly { name: string; git?: boolean }[],
): string {
    return choice === PLAIN_IMAGE && images.some((image) => image.name === GIT_IMAGE && image.git)
        ? GIT_IMAGE
        : choice;
}

/**
 * The calls of a provider that change something, and which of their arguments name an entry that they change: `follow`
 * when a link at the end of the name is followed (a file that is opened, the source of a hard link), `moves` when the
 * entry goes away from where it is (a folder that holds a git directory may not), `inPlace` when the call changes
 * the file that the name leads to, not the name (a file with other hard links may not be changed so).
 */
const WRITES: Record<string, { at: number; follow: boolean; moves?: true; inPlace?: true }[]> = {
    open: [{ at: 0, follow: true, inPlace: true }],
    mkdir: [{ at: 0, follow: false }],
    rmdir: [{ at: 0, follow: false }],
    unlink: [{ at: 0, follow: false }],
    rename: [
        { at: 0, follow: false, moves: true },
        { at: 1, follow: false, moves: true },
    ],
    link: [
        { at: 0, follow: true },
        { at: 1, follow: false },
    ],
    symlink: [{ at: 1, follow: false }],
    chmod: [{ at: 0, follow: true, inPlace: true }],
    copyFile: [{ at: 1, follow: true, inPlace: true }],
};

/**
 * `backend` with every write into a git directory refused (`EROFS`), and every read as it is: the guest reads `.git`
 * and cannot change it. A write is refused when the path it names, or the place that path leads to, is protected
 * (`gitProtected`); renaming a folder that holds a git directory is refused too, since the directory would then lie
 * where nothing guards it. A hard link needs its source checked as well as its name: both are. A file that has other
 * hard links (`nlink` above 1) is never changed in place (`EPERM`): the other names may lie outside the folder, in a
 * package store or in a git directory. Replacing it by a rename over it, or removing its name, is allowed.
 */
function refuseWrites(
    library: Library,
    backend: any,
    root: string,
    gitDirs: readonly string[],
): unknown {
    const { isWriteFlag, normalizeVfsPath, ERRNO } = library;
    const guarded = gitProtected(root, gitDirs);

    const refuse = (code: "EROFS" | "EPERM", op: string, path: string, why: string): never => {
        const error = new Error(`${code}: ${op} '${path}' (${why})`) as Error & {
            code: string;
            errno: number;
            syscall: string;
            path: string;
        };

        error.code = code;
        error.errno = ERRNO[code];
        error.syscall = op;
        error.path = path;

        throw error;
    };

    // Where a path leads, a link followed as the file system follows it: the real path of what exists, then the names
    // that do not exist yet. `follow` false leaves the last name alone (it is the entry that the call changes).
    const leadsTo = (path: string, follow: boolean): string => {
        const rest = follow || path === "/" ? [] : [posix.basename(path)];
        let at = follow || path === "/" ? path : posix.dirname(path);

        for (;;) {
            try {
                return posix.join(backend.realpathSync(at), ...rest);
            } catch {
                if (at === "/") {
                    return path;
                }

                rest.unshift(posix.basename(at));
                at = posix.dirname(at);
            }
        }
    };

    const protectedPath = (path: string, follow: boolean, moves: boolean): boolean =>
        [normalizeVfsPath(path), leadsTo(normalizeVfsPath(path), follow)].some((vfs) => {
            const host = join(root, vfs);

            return guarded(host) || (moves && holdsGitDir(host, gitDirs));
        });

    const hasOtherLinks = (path: string): boolean => {
        try {
            const stat = lstatSync(join(root, leadsTo(normalizeVfsPath(path), true)));

            return stat.isFile() && stat.nlink > 1;
        } catch {
            return false;
        }
    };

    return new Proxy(backend, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            const name = String(property);
            const base = name.replace(/Sync$/, "");

            if (typeof value !== "function") {
                return value;
            }

            if (!Object.hasOwn(WRITES, base)) {
                return value.bind(target);
            }

            return (...args: unknown[]) => {
                const reads = base === "open" && !isWriteFlag(String(args[1] ?? "r"));

                for (const { at, follow, moves, inPlace } of reads ? [] : WRITES[base]!) {
                    const path = args[at];

                    if (typeof path !== "string") {
                        continue;
                    }

                    if (protectedPath(path, follow, moves === true)) {
                        refuse("EROFS", base, path, "git metadata is read only here");
                    }

                    if (inPlace === true && hasOtherLinks(path)) {
                        refuse(
                            "EPERM",
                            base,
                            path,
                            "this file has other hard links, so it is not changed in place: write a new file and rename it over this one",
                        );
                    }
                }

                return value.apply(target, args);
            };
        },
    });
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

/** What a VM's close needs to know about its runner process. Tests give their own. */
export interface RunnerControl {
    /**
     * Who `pid` is right now: its start time and command line, when it is a Gondolin runner or QEMU that still runs.
     * Undefined when there is no such process, it has ended, or another program has the number.
     */
    identity(pid: number): string | undefined;
    /** End the runner and its process group, as hard as there is. */
    kill(pid: number): void;
}

const hostRunner: RunnerControl = {
    identity(pid) {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            // `pid (name) state ...`: the name may hold spaces and brackets, so read from its last bracket.
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            const line = readFileSync(`/proc/${pid}/cmdline`, "utf8");

            return fields[0] !== "Z" && /gondolin-krun-runner|qemu-system/.test(line)
                ? `${fields[19]}:${line}`
                : undefined;
        } catch {
            return undefined;
        }
    },
    kill(pid) {
        for (const target of [-pid, pid]) {
            try {
                process.kill(target, "SIGKILL");
            } catch {
                // no such group, or process: gone
            }
        }
    },
};

export class GondolinVm implements GuestVm {
    readonly id: string;
    readonly fs: GuestFs;
    readonly #vm: any;
    readonly #runner: RunnerControl;
    readonly #graceMs: number;
    /** The runner, as it was when the VM started: asked once, since the package forgets it while it closes. */
    readonly #pid: number | null;
    readonly #identity: string | undefined;
    #closed = false;
    #closing: Promise<void> | undefined;
    readonly #exits: ((reason: string) => void)[] = [];

    /** `graceMs` is how long a runner that survives a close is waited for after the kill. */
    constructor(vm: any, runner: RunnerControl = hostRunner, graceMs = 5000) {
        this.#vm = vm;
        this.#runner = runner;
        this.#graceMs = graceMs;
        this.#pid = vm.getHostPid();
        this.#identity = this.#pid === null ? undefined : runner.identity(this.#pid);
        this.id = String(vm.id);

        // The runner went away (a crash, a kill): say so, so the manager drops this VM and the next call starts another.
        try {
            vm.server?.on?.("exit", (info: { code?: number | null; signal?: string | null }) =>
                this.ended(
                    info?.signal
                        ? `the VM's runner was stopped (${info.signal})`
                        : `the VM's runner exited${info?.code === undefined || info.code === null ? "" : ` (code ${info.code})`}`,
                ),
            );
        } catch {
            // an older package without the event: the VM is then noticed when a call fails
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

    onExit(listener: (reason: string) => void): void {
        this.#exits.push(listener);
    }

    /** The runner went away without a close. Gondolin could start it again on a call: it is closed for good here. */
    ended(reason: string): void {
        if (!this.#closed) {
            this.#closed = true;
            void Promise.resolve(this.#vm.close()).catch(() => undefined);

            for (const listener of this.#exits) {
                listener(reason);
            }
        }
    }

    exec(argv: string[], options: GuestExecOptions = {}): GuestProcess {
        const marker = randomUUID();

        // Gondolin ends the stream when its signal fires but leaves the guest's process running: end it here, by the
        // marker that each process and its children carry in their environment.
        let killing: Promise<void> | undefined;

        const kill = () => {
            killing = Promise.resolve(
                this.#vm.exec([
                    "/bin/sh",
                    "-c",
                    'me=$$; for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = "$me" ] && continue; if tr "\\0" "\\n" < "$d/environ" 2>/dev/null | grep -qx "PI_POCKET_EXEC=$0"; then kill -9 "$p" 2>/dev/null; fi; done',
                    marker,
                ]),
            ).then(
                () => undefined,
                () => undefined,
            );
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
        // A command that was stopped is over only when the guest's processes are: the result waits for the kill.
        const result = Promise.resolve(process_).then(
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
                for await (const chunk of process_.output()) {
                    yield { stream: chunk.stream, data: chunk.data };
                }
            },
            result,
            write: (data) => process_.write(typeof data === "string" ? data : Buffer.from(data)),
            end: () => process_.end(),
        };
    }

    /**
     * Closed means the runner is gone, which this proves: a close that failed is tried again and never counts as done
     * while the runner may run. A runner that outlives the close is killed, with its process group, and waited for;
     * one that cannot be shown gone makes the close fail.
     */
    close(): Promise<void> {
        this.#closing ??= this.#shutdown().finally(() => {
            this.#closing = undefined;
        });

        return this.#closing;
    }

    async #shutdown(): Promise<void> {
        if (this.#closed) {
            return;
        }

        let failure: unknown;

        try {
            await this.#vm.close();
        } catch (error) {
            failure = error;
        }

        // The runner is the one that started, or it is gone: a number that another program has since is not it.
        const here = () =>
            this.#pid !== null && this.#runner.identity(this.#pid) === this.#identity;

        if (this.#identity !== undefined && here()) {
            this.#runner.kill(this.#pid!);
            const until = Date.now() + this.#graceMs;

            while (here()) {
                if (Date.now() >= until) {
                    throw new Error(
                        `the VM's runner (process ${this.#pid}) is still running${failure === undefined ? "" : `: ${String(failure)}`}`,
                    );
                }

                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        }

        this.#closed = true;
    }
}

export class GondolinDriver implements SandboxDriver {
    readonly #dir: string;
    readonly #unsupported: () => string | undefined;
    #library: Promise<Library> | undefined;

    /**
     * `dir` is the module's folder in the data folder: the package, and the image store, live in it. `unsupported` says
     * why this machine cannot run a sandbox (core's answer), or undefined.
     */
    constructor(dir: string, unsupported: () => string | undefined = sandboxPlatformProblem) {
        this.#dir = dir;
        this.#unsupported = unsupported;
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
                    "Gondolin is not installed. Open the Sandbox sheet (Menu → Sandbox) and tap Set up.",
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
        const krunPlatform = platform === "linux-x64";
        const krunRunner = krunPlatform && existsSync(runner);
        const hardware = kvm();
        const qemu = onPath(
            process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64",
        );

        lines.push({
            name: "libkrun",
            optional: true,
            ok: krunPlatform && krunRunner && hardware,
            detail: !krunPlatform
                ? `No prebuilt libkrun runner for ${platform}.`
                : !krunRunner
                  ? "The libkrun runner package is not installed. Tap Set up."
                  : !hardware
                    ? "No access to /dev/kvm: add your user to the kvm group, or turn on virtualization."
                    : "Ready (uses KVM).",
        });
        lines.push({
            name: "QEMU",
            optional: true,
            ok: qemu !== undefined && hardware,
            detail:
                qemu === undefined
                    ? "Not installed: install your distribution's QEMU package (for example `qemu-system-x86` on Debian). Pi Pocket does not install system packages."
                    : !hardware
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
        const unsupported = this.#unsupported();

        lines.push({
            name: "Operating system",
            ok: unsupported === undefined,
            detail: unsupported ?? `${process.platform} ${process.arch}`,
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
        const backend = unsupported === undefined ? this.#backend(settings.backend) : { lines: [] };

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
        const resolved = resolveImage(settings.image, images);
        const chosen = images.find((image) => image.name === resolved);

        lines.push({
            name: "Image",
            ok: chosen !== undefined,
            detail:
                chosen !== undefined
                    ? `${chosen.name}${chosen.browser ? " (with a browser)" : ""}${chosen.git ? "" : " (without git: tap Set up to build the image with git)"}`
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

    #images(): { name: string; browser: boolean; git: boolean }[] {
        const refs = join(this.imageStore, "refs");
        const found: { name: string; browser: boolean; git: boolean }[] = [];

        try {
            for (const name of readdirSync(refs)) {
                for (const tag of readdirSync(join(refs, name))) {
                    const reference = `${name}:${tag}`;
                    const arches = readdirSync(join(refs, name, tag));
                    const link = join(refs, name, tag, arches[0] ?? "");
                    let browser = false;
                    let git = false;

                    try {
                        const manifest = JSON.parse(
                            readFileSync(join(link, "manifest.json"), "utf8"),
                        ) as { config?: { alpine?: { rootfsPackages?: string[] } } };
                        const packages = manifest.config?.alpine?.rootfsPackages ?? [];

                        browser = packages.includes("chromium");
                        git = packages.includes("git");
                    } catch {
                        // no manifest: not a browser image, and no git, as far as we know
                    }

                    found.push({ name: reference, browser, git });
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

        if (!this.#images().some((image) => image.name === PLAIN_IMAGE)) {
            progress(`Downloading the guest image ${PLAIN_IMAGE} (about 110 MB) …`);
            await library.ensureImageSelector(PLAIN_IMAGE);
        }

        signal.throwIfAborted();

        const have = this.#images();

        // Built here, never downloaded: the root disk of the published image plus git. Without the tools to build it,
        // the sandbox still works, with no git in the VM.
        if (!have.some((image) => image.name === GIT_IMAGE && image.git)) {
            try {
                await this.#buildImage(library, GIT_IMAGE, GIT_PACKAGES, progress, signal);
            } catch (error) {
                signal.throwIfAborted();
                progress(
                    `Could not build the image with git (${error instanceof Error ? error.message.split("\n")[0] : String(error)}). The sandbox works without git in the VM.`,
                );
            }
        }

        signal.throwIfAborted();

        if (options.browser && !have.some((image) => image.name === BROWSER_IMAGE && image.git)) {
            await this.#buildImage(
                library,
                BROWSER_IMAGE,
                [...BROWSER_PACKAGES, ...GIT_PACKAGES],
                progress,
                signal,
            );
        }

        progress("Set up is done.");
    }

    /**
     * An image with more packages than the published one: Gondolin 0.14's own build gives a krun kernel that does not
     * boot, so we build only the root disk with them, and put that disk into the published image's directory, which
     * has a kernel that boots.
     */
    async #buildImage(
        library: Library,
        name: string,
        packages: readonly string[],
        progress: (line: string) => void,
        signal: AbortSignal,
    ): Promise<void> {
        const work = mkdtempSync(join(tmpdir(), "pocket-gondolin-build-"));

        try {
            progress(`Building the image ${name} with ${packages.join(", ")} on this machine …`);
            const config = library.getDefaultBuildConfig() as {
                alpine: { rootfsPackages: string[] };
            };

            config.alpine.rootfsPackages = [
                ...new Set([...config.alpine.rootfsPackages, ...packages]),
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

            library.setImageRef(name, imported.buildId, imported.arch);
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

        const { VM, RealFSProvider, ReadonlyProvider, createHttpHooks } = library;

        const real = (folder: string, readOnly: boolean): unknown => {
            const base = new RealFSProvider(folder);

            return readOnly ? new ReadonlyProvider(base) : base;
        };

        // A git directory is read only to the guest, wherever it lies. Inside the folder, the folder's own provider
        // refuses the writes; outside it, the directory is a read only mount at its host path.
        const root = realpathSync(spec.cwd);
        const mounts: Record<string, unknown> = {
            [spec.cwd]:
                spec.mount === "rw"
                    ? refuseWrites(library, real(spec.cwd, false), root, spec.gitDirs)
                    : real(spec.cwd, true),
        };

        for (const extra of [
            ...spec.readOnlyMounts,
            ...spec.gitDirs.filter((dir) => !within(dir, root) && !within(root, dir)),
        ]) {
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
                imagePath: resolveImage(spec.image, check.images),
                memory: `${spec.memoryMb}M`,
                cpus: spec.cpus,
                ...(spec.network.mode === "off" ? { netEnabled: false } : {}),
            },
            rootfs: { size: spec.diskMb * 1024 * 1024 },
            vfs: { mounts },
            ...(spec.network.mode === "off" ? {} : { httpHooks: network.httpHooks }),
            env: { GIT_OPTIONAL_LOCKS: "0" },
            sessionLabel: spec.label,
        });

        if (signal?.aborted) {
            await vm.close().catch(() => undefined);
            signal.throwIfAborted();
        }

        // Make the VM boot now, so the first call does not pay for it unseen and a broken VM shows here.
        try {
            await vm.start();
        } catch (error) {
            await vm.close().catch(() => undefined);

            throw error;
        }

        // The guest's own git settings: trust for the mounted folders, an author, and no way to sign in.
        try {
            await vm.fs.writeFile(
                "/etc/gitconfig",
                Buffer.from(guestGitConfig(spec.safeDirectories), "utf8"),
            );
        } catch {
            // without it git in the guest says "dubious ownership": the call that needs it says so
        }

        // The guest's `git`: the real one, with one clear word when it could not write a git directory.
        try {
            await vm.fs.mkdir("/usr/local/bin", { recursive: true });
            await vm.fs.writeFile("/usr/local/bin/git", Buffer.from(GIT_WRAPPER, "utf8"));
            await vm.exec(["/bin/sh", "-c", "chmod 755 /usr/local/bin/git"]);
        } catch {
            // without it a write to a git directory fails with git's own words: it is refused either way
        }

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
