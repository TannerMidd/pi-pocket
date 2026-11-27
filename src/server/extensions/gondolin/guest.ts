/**
 * Small VM driver contract for `pocket-gondolin`. Tests supply an in-memory fake driver; production loads
 * `@earendil-works/gondolin` on demand from `<data>/gondolin`.
 */

export type Backend = "auto" | "krun" | "qemu";
export type NetworkMode = "off" | "allowlist" | "open";

export interface GuestStat {
    kind: "file" | "directory" | "symlink" | "other";
    size: number;
    mtimeMs: number;
}

export interface GuestChunk {
    stream: "stdout" | "stderr";
    data: Uint8Array;
}

export interface GuestError extends Error {
    code?: string;
}

export interface GuestExecOptions {
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    stdin?: boolean;
}

export interface GuestProcess {
    output(): AsyncIterable<GuestChunk>;
    result: Promise<{ exitCode: number }>;
    write(data: string | Uint8Array): void;
    end(): void;
}

export interface GuestFs {
    readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array, signal?: AbortSignal): Promise<void>;
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

export interface GuestVm {
    readonly id: string;
    readonly fs: GuestFs;
    hostPid(): number | null;
    onExit(listener: (reason: string) => void): void;
    exec(argv: string[], options?: GuestExecOptions): GuestProcess;
    /** Optional native disk checkpoint (`qcow2`), when supported by the loaded Gondolin version. */
    checkpoint?(path: string): Promise<void>;
    close(): Promise<void>;
}

export interface VmSpec {
    sandboxId: string;
    label: string;
    backend: Backend;
    image: string;
    memoryMb: number;
    cpus: number;
    diskMb: number;
    network: {
        mode: NetworkMode;
        allowedHosts: readonly string[];
    };
    /** Existing disk checkpoint path to resume from, if any. */
    checkpointPath?: string;
}

export interface CheckLine {
    name: string;
    ok: boolean;
    optional?: boolean;
    detail: string;
}

export interface HostCheck {
    ok: boolean;
    lines: CheckLine[];
    backend?: "krun" | "qemu";
    images: { name: string; git?: boolean }[];
}

export interface SandboxDriver {
    installed(): boolean;
    check(settings: { backend: Backend; image: string }): Promise<HostCheck>;
    setup(progress: (line: string) => void, signal: AbortSignal): Promise<void>;
    start(spec: VmSpec, signal?: AbortSignal, onRunner?: (vm: GuestVm) => void): Promise<GuestVm>;
    reapOrphan?(pid: number): void;
}

/** Default allow-listed hosts for package registries and GitHub API/cloning. */
export const DEFAULT_ALLOWED_HOSTS = [
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
    "github.com",
    "api.github.com",
] as const;

const LOOPBACK_OR_PRIVATE =
    /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|\[?fe80:.*\]?|\[?fc[0-9a-f]{2}:.*\]?|\[?fd[0-9a-f]{2}:.*\]?)$/i;

/**
 * Parses a comma/newline/whitespace-separated host allow-list. Strips schemes/paths if pasted as URLs, lowercases,
 * deduplicates, and silently drops loopback/private/link-local addresses so the sandbox cannot reach localhost or LAN.
 */
export function parseAllowedHosts(raw: string | readonly string[] | undefined): string[] {
    if (raw === undefined) {
        return [];
    }

    const items = typeof raw === "string" ? raw.split(/[\s,]+/) : raw;
    const out = new Set<string>();

    for (const item of items) {
        let host = item.trim().toLowerCase();

        if (host === "") {
            continue;
        }

        if (/^https?:\/\//.test(host)) {
            try {
                host = new URL(host).hostname.toLowerCase();
            } catch {
                continue;
            }
        }

        host = host.replace(/\/.*$/, "").replace(/:\d+$/, "");

        if (
            host === "" ||
            host.endsWith(".local") ||
            host.endsWith(".internal") ||
            LOOPBACK_OR_PRIVATE.test(host) ||
            !/^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
                host,
            )
        ) {
            continue;
        }

        out.add(host);
    }

    return [...out];
}
