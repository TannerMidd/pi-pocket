/**
 * What the Gondolin module needs of a micro-VM, as a small interface: a driver starts VMs, and a VM runs commands and
 * moves files. The real driver is Gondolin's (`real-driver.ts`); the tests use a fake one. The interface has nothing
 * of Gondolin in it, so a different VM can sit behind it.
 */

/** A guest path's metadata. */
export interface GuestStat {
    readonly kind: "file" | "directory" | "symlink" | "other";
    readonly size: number;
    readonly mtimeMs: number;
}

/** An error with a Node-style `code` (`ENOENT`, `EACCES`, `ENOTDIR`, `EISDIR`, …), as the guest's file system gave it. */
export interface GuestError extends Error {
    code?: string;
}

/** Files of the guest. Paths are absolute and in the guest. */
export interface GuestFs {
    readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array, signal?: AbortSignal): Promise<void>;
    /** `follow` false: a symbolic link is reported as one (`lstat`). */
    stat(path: string, follow: boolean, signal?: AbortSignal): Promise<GuestStat>;
    list(path: string, signal?: AbortSignal): Promise<string[]>;
    mkdir(path: string, recursive: boolean, signal?: AbortSignal): Promise<void>;
    remove(
        path: string,
        options: { recursive: boolean; force: boolean },
        signal?: AbortSignal,
    ): Promise<void>;
    rename(from: string, to: string, signal?: AbortSignal): Promise<void>;
}

export interface GuestChunk {
    readonly stream: "stdout" | "stderr";
    readonly data: Uint8Array;
}

/** A command running in the guest. */
export interface GuestProcess {
    /** Its output as it comes. It ends when the command ends. */
    output(): AsyncIterable<GuestChunk>;
    /** The exit code (128 + n when a signal n ended it). It rejects when the VM went away. */
    readonly result: Promise<{ exitCode: number }>;
    write(data: string | Uint8Array): void;
    end(): void;
}

export interface GuestExecOptions {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    /** Stopping it ends the command in the guest. */
    readonly signal?: AbortSignal;
    /** Keep stdin open for `write`. */
    readonly stdin?: boolean;
}

export interface GuestVm {
    readonly id: string;
    readonly fs: GuestFs;
    /** `argv[0]` is an absolute path in the guest. */
    exec(argv: string[], options?: GuestExecOptions): GuestProcess;
    /** The process id of the VM's runner on this machine, for cleanup after a crash. */
    hostPid(): number | null;
    /** Called once when the VM ends without `close` (the runner died). */
    onExit(listener: (reason: string) => void): void;
    close(): Promise<void>;
}

export type NetworkMode = "off" | "allowlist" | "open";
export type MountMode = "rw" | "ro";
export type Backend = "auto" | "krun" | "qemu";

/** What a VM is started with. Chosen by the module from the owner's settings; the driver does as it says. */
export interface VmSpec {
    /** Shown in Gondolin's own session list. */
    readonly label: string;
    readonly backend: Backend;
    /** The session's folder: mounted in the guest at this same path. */
    readonly cwd: string;
    readonly mount: MountMode;
    /** More folders mounted read-only at their own paths (the session's uploads, the skills it uses). */
    readonly readOnlyMounts: readonly string[];
    /**
     * Every git directory that the folder reaches (`git.ts`). The guest reads them and never writes them: the ones
     * outside the folder are read only mounts at their own paths, the ones inside are refused in the folder's provider.
     */
    readonly gitDirs: readonly string[];
    /** Folders that git in the guest trusts (`safe.directory`). */
    readonly safeDirectories: readonly string[];
    readonly network: { readonly mode: NetworkMode; readonly allowedHosts: readonly string[] };
    readonly cpus: number;
    readonly memoryMb: number;
    readonly diskMb: number;
    /** Where the image store is, and which image. */
    readonly image: string;
}

export interface CheckLine {
    readonly name: string;
    readonly ok: boolean;
    /** What was found, or what to do. */
    readonly detail: string;
    /** One of several ways to run: it does not decide whether a VM can start (the line `Back end` does). */
    readonly optional?: true;
}

/** What the host has for running VMs. `ok` is true when a VM can start. */
export interface HostCheck {
    readonly ok: boolean;
    readonly lines: readonly CheckLine[];
    /** The back end that would run, when one can. */
    readonly backend?: "krun" | "qemu";
    /** Images in the store, by name. */
    readonly images: readonly {
        readonly name: string;
        readonly browser: boolean;
        readonly git?: boolean;
    }[];
}

export interface SetupOptions {
    /** Also build the image with a browser. */
    readonly browser: boolean;
}

export interface SandboxDriver {
    check(settings: { backend: Backend; image: string }): Promise<HostCheck>;
    /** Install the package and fetch (or build) the image. Reports each step. */
    setup(
        options: SetupOptions,
        progress: (line: string) => void,
        signal: AbortSignal,
    ): Promise<void>;
    /** Remove the image store and the package. */
    remove(): Promise<void>;
    start(spec: VmSpec, signal?: AbortSignal): Promise<GuestVm>;
}
