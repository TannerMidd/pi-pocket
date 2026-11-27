/**
 * One-way workspace seeding into a Gondolin micro-VM: creates a clean, filtered single-commit snapshot of a local
 * repository or folder (or clones an HTTPS git URL inside the VM) into `/workspace` on the VM's private disk.
 *
 * Security invariants:
 * - The host directory is NEVER mounted read-write into the VM.
 * - Local Git repositories NEVER transfer raw Git history (which could contain historically deleted `.env` or secret
 *   files): only the current filtered file tree is copied into a fresh initial commit inside `/workspace`.
 * - Secret-like files (`.env`, `.env.*`, `*.pem`, `*.key`) and symlinks/special files are excluded consistently across
 *   committed, staged, and working-tree files. Every path component is checked with `lstatSync` and `realpathSync` so
 *   a symlinked intermediate folder can never copy external host files into the VM.
 * - Executable permissions (`100755` / `+x`) are preserved before creating the initial guest commit.
 * - Oversized repositories fail explicitly with a clear error rather than silently seeding an incomplete tree.
 * - Returns the guest's initial `baseCommit` SHA so later diff/export compares against that fixed base even after the
 *   agent creates new commits inside the VM.
 */
import { execFile } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import type { GuestVm } from "./guest.ts";

const execFileAsync = promisify(execFile);

export const MAX_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_SNAPSHOT_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = 10_000;

const SKIP_DIRS = new Set([
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    "dist",
    "build",
]);

function within(candidate: string, root: string): boolean {
    const cleanRoot = root.endsWith("/") ? root.slice(0, -1) : root;

    return candidate === cleanRoot || candidate.startsWith(`${cleanRoot}/`);
}

/** Whether a relative path should be excluded from one-way seeding into an untrusted sandbox. */
export function isExcludedSeedPath(relativePath: string): boolean {
    const parts = relativePath.replace(/\\/g, "/").split("/");

    for (const part of parts) {
        if (part === "" || part === "." || part === ".." || SKIP_DIRS.has(part)) {
            return true;
        }
    }

    const base = parts.at(-1) ?? "";

    return /^\.env($|\.)/i.test(base) || /\.(pem|key|p12|pfx)$/i.test(base);
}

/**
 * Safely reads `relPath` beneath canonical `sourceRoot`, verifying EVERY intermediate path component with `lstatSync`
 * (rejecting any symlinked directory or file) and confirming `realpathSync` stays within `sourceRoot`.
 * Throws if a regular file exceeds `maxFileBytes`; returns `undefined` if missing or symlink/non-regular.
 */
function readConfinedHostFile(
    sourceRoot: string,
    relPath: string,
    maxFileBytes: number,
): { bytes: Uint8Array; executable: boolean } | undefined {
    const parts = relPath.split("/");
    let current = sourceRoot;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;

        if (part === "" || part === "." || part === "..") {
            return undefined;
        }

        current = join(current, part);

        let st;

        try {
            st = lstatSync(current);
        } catch {
            return undefined;
        }

        if (st.isSymbolicLink()) {
            return undefined;
        }

        const isLast = i === parts.length - 1;

        if (!isLast) {
            if (!st.isDirectory()) {
                return undefined;
            }
        } else {
            if (!st.isFile()) {
                return undefined;
            }

            const real = realpathSync(current);

            if (!within(real, sourceRoot)) {
                return undefined;
            }

            if (st.size > maxFileBytes) {
                throw new Error(
                    `Cannot seed sandbox: "${relPath}" is ${(st.size / 1024 / 1024).toFixed(1)} MiB, exceeding the ${maxFileBytes / 1024 / 1024} MiB per-file snapshot limit.`,
                );
            }

            return {
                bytes: new Uint8Array(readFileSync(real)),
                executable: (st.mode & 0o111) !== 0,
            };
        }
    }

    return undefined;
}

/**
 * Checks that a host folder chosen for one-way seeding is a real directory and not a sensitive system/credential root.
 * Returns the canonical real path.
 */
export function validateSeedSource(folder: string, dataDir: string): string {
    const trimmed = folder.trim();

    if (trimmed === "") {
        throw new Error("Choose a folder to seed the sandbox from.");
    }

    const expanded =
        trimmed === "~"
            ? homedir()
            : trimmed.startsWith("~/")
              ? join(homedir(), trimmed.slice(2))
              : trimmed;
    let real: string;

    try {
        real = realpathSync(resolve(expanded));
    } catch {
        throw new Error(`Folder does not exist: ${trimmed}`);
    }

    if (!lstatSync(real).isDirectory()) {
        throw new Error(`Not a directory: ${trimmed}`);
    }

    const home = realpathSync(homedir());
    const forbiddenExact = new Set(["/", home]);
    const forbiddenSubtrees = [
        join(home, ".ssh"),
        join(home, ".gnupg"),
        join(home, ".pi"),
        join(home, ".pi-pocket"),
        join(home, ".aws"),
        join(home, ".kube"),
        join(home, ".docker"),
        resolve(dataDir),
    ];

    if (forbiddenExact.has(real)) {
        throw new Error(
            "Refusing to seed a sandbox from `/` or your entire home directory. Pick a project folder.",
        );
    }

    for (const root of forbiddenSubtrees) {
        if (within(real, root)) {
            throw new Error(
                `Refusing to seed a sandbox from sensitive folder "${root}". Pick a project folder.`,
            );
        }
    }

    return real;
}

/** Validates an HTTPS git URL for in-VM cloning (blocks `file://`, `ssh://`, and `-` option injection). */
export function validateGitUrl(raw: string): string {
    const trimmed = raw.trim();

    if (trimmed === "" || trimmed.startsWith("-") || /[\s\0]/.test(trimmed)) {
        throw new Error("Enter a valid https:// git repository URL.");
    }

    let parsed: URL;

    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error("Enter a valid https:// git repository URL.");
    }

    if (parsed.protocol !== "https:") {
        throw new Error("Only https:// git repository URLs are allowed.");
    }

    return parsed.href;
}

async function execInGuest(
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

function cleanGitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};

    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith("GIT_") && value !== undefined) {
            env[key] = value;
        }
    }

    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_ATTR_NOSYSTEM = "1";

    return env;
}

async function configureGuestGit(vm: GuestVm, signal?: AbortSignal): Promise<void> {
    await execInGuest(
        vm,
        [
            "/bin/sh",
            "-c",
            'if command -v git >/dev/null 2>&1; then git config --global user.name "Pi Sandbox" && git config --global user.email "sandbox@localhost" && git config --global safe.directory /workspace; fi',
        ],
        "/",
        signal,
    );
}

async function restoreGuestExecutables(
    vm: GuestVm,
    guestPaths: readonly string[],
    signal?: AbortSignal,
): Promise<void> {
    const batchSize = 100;

    for (let i = 0; i < guestPaths.length; i += batchSize) {
        signal?.throwIfAborted();
        // Every path is rooted under `/workspace/`, never option-like (`-`), so `chmod +x` works on both BusyBox/GNU and BSD.
        const batch = guestPaths.slice(i, i + batchSize).filter((p) => p.startsWith("/workspace/"));

        if (batch.length === 0) {
            continue;
        }

        const res = await execInGuest(vm, ["chmod", "+x", ...batch], "/", signal);

        if (res.exitCode !== 0) {
            throw new Error(
                `Failed to restore executable permissions in sandbox: ${res.stderr.trim() || res.stdout.trim()}`,
            );
        }
    }
}

async function guestHeadCommit(vm: GuestVm, signal?: AbortSignal): Promise<string | undefined> {
    const rev = await execInGuest(
        vm,
        [
            "/bin/sh",
            "-c",
            "if command -v git >/dev/null 2>&1 && [ -d /workspace/.git ]; then git -C /workspace rev-parse --verify HEAD 2>/dev/null; fi",
        ],
        "/",
        signal,
    );
    const sha = rev.stdout.trim();

    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : undefined;
}

async function initGuestSnapshotRepo(
    vm: GuestVm,
    message: string,
    executables: readonly string[],
    signal?: AbortSignal,
): Promise<string | undefined> {
    if (executables.length > 0) {
        await restoreGuestExecutables(vm, executables, signal);
    }

    await execInGuest(
        vm,
        [
            "/bin/sh",
            "-c",
            'if command -v git >/dev/null 2>&1; then git -C /workspace init -q && git -C /workspace add -A && git -C /workspace commit -q --allow-empty -m "$1"; fi',
            "sh",
            message,
        ],
        "/",
        signal,
    );

    return guestHeadCommit(vm, signal);
}

const SEED_GIT_FLAGS = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "safe.bareRepository=explicit",
] as const;

/**
 * Seeds `/workspace` inside `vm` from an empty directory, a local host repo/folder (filtered one-way snapshot, never a
 * live mount and never raw `.git` history), or an HTTPS git URL cloned inside the VM.
 *
 * Returns `{ baseCommit }` — the fixed initial commit SHA inside `/workspace` used as the diff base for export.
 */
export async function seedWorkspace(
    vm: GuestVm,
    options:
        | { kind: "empty" }
        | { kind: "git"; repoUrl: string }
        | {
              kind: "repo";
              sourcePath: string;
              includeUncommitted?: boolean;
              limits?: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number };
          },
    signal?: AbortSignal,
): Promise<{ baseCommit?: string }> {
    await vm.fs.mkdir("/workspace", true, signal);
    await configureGuestGit(vm, signal);

    if (options.kind === "empty") {
        const baseCommit = await initGuestSnapshotRepo(vm, "Empty sandbox", [], signal);

        return { ...(baseCommit === undefined ? {} : { baseCommit }) };
    }

    if (options.kind === "git") {
        const url = validateGitUrl(options.repoUrl);
        const cloned = await execInGuest(
            vm,
            ["git", "clone", "--depth", "1", "--", url, "/workspace"],
            "/",
            signal,
        );

        if (cloned.exitCode !== 0) {
            throw new Error(
                `Could not clone ${url} inside the sandbox: ${cloned.stderr.trim() || cloned.stdout.trim()}`,
            );
        }

        const baseCommit = await guestHeadCommit(vm, signal);

        return { ...(baseCommit === undefined ? {} : { baseCommit }) };
    }

    const maxFiles = options.limits?.maxFiles ?? MAX_SNAPSHOT_FILES;
    const maxFileBytes = options.limits?.maxFileBytes ?? MAX_SNAPSHOT_FILE_BYTES;
    const maxTotalBytes = options.limits?.maxTotalBytes ?? MAX_SNAPSHOT_TOTAL_BYTES;

    // Local repo or plain folder: build a filtered single-commit snapshot (no raw .git history or excluded secrets).
    const sourcePath = realpathSync(options.sourcePath);
    const isGitRepo = await execFileAsync(
        "git",
        [...SEED_GIT_FLAGS, "rev-parse", "--verify", "HEAD"],
        {
            cwd: sourcePath,
            env: cleanGitEnv(),
        },
    ).then(
        () => true,
        () => false,
    );

    let copiedFiles = 0;
    let copiedBytes = 0;
    const executables: string[] = [];

    const checkLimits = (relPath: string, nextBytes: number) => {
        if (nextBytes > maxFileBytes) {
            throw new Error(
                `Cannot seed sandbox: "${relPath}" is ${(nextBytes / 1024 / 1024).toFixed(1)} MiB, exceeding the ${maxFileBytes / 1024 / 1024} MiB per-file snapshot limit.`,
            );
        }

        if (copiedFiles + 1 > maxFiles) {
            throw new Error(
                `Cannot seed sandbox: source exceeds the ${maxFiles}-file snapshot limit. Clone via https:// inside the VM or pick a smaller folder.`,
            );
        }

        if (copiedBytes + nextBytes > maxTotalBytes) {
            throw new Error(
                `Cannot seed sandbox: source exceeds the ${maxTotalBytes / 1024 / 1024} MiB total snapshot limit. Clone via https:// inside the VM or pick a smaller folder.`,
            );
        }
    };

    if (isGitRepo) {
        // When includeUncommitted is enabled, read the Git index (`ls-files --stage`) so newly staged files and staged
        // renames are included alongside HEAD-tracked files; otherwise read HEAD's tree (`ls-tree`).
        const gitArgs =
            options.includeUncommitted === true
                ? [...SEED_GIT_FLAGS, "ls-files", "--stage", "-z"]
                : [...SEED_GIT_FLAGS, "ls-tree", "-r", "-z", "HEAD"];
        const { stdout: lsOut } = await execFileAsync("git", gitArgs, {
            cwd: sourcePath,
            env: cleanGitEnv(),
            maxBuffer: maxTotalBytes,
        });

        const seenPaths = new Set<string>();

        for (const entry of lsOut.split("\0")) {
            if (entry === "") {
                continue;
            }

            signal?.throwIfAborted();

            const tab = entry.indexOf("\t");

            if (tab < 0) {
                continue;
            }

            const meta = entry.slice(0, tab).split(" ");
            const relPath = entry.slice(tab + 1);

            if (seenPaths.has(relPath)) {
                continue;
            }

            const mode = meta[0];
            // `ls-tree` format: "<mode> <type> <sha>"; `ls-files --stage` format: "<mode> <sha> <stage>".
            const isBlob =
                options.includeUncommitted === true
                    ? mode === "100644" || mode === "100755"
                    : meta[1] === "blob" && (mode === "100644" || mode === "100755");

            if (!isBlob || isExcludedSeedPath(relPath)) {
                continue;
            }

            seenPaths.add(relPath);

            let bytes: Uint8Array;
            let executable = mode === "100755";

            if (options.includeUncommitted === true) {
                // Confined working-tree read: rejects any symlink in intermediate folders or the file itself.
                const confined = readConfinedHostFile(sourcePath, relPath, maxFileBytes);

                if (confined === undefined) {
                    continue;
                }

                bytes = confined.bytes;
                executable = executable || confined.executable;
            } else {
                const obj = meta[2];

                if (!obj || !/^[0-9a-f]{40,64}$/i.test(obj)) {
                    continue;
                }

                const { stdout: blob } = await execFileAsync(
                    "git",
                    [...SEED_GIT_FLAGS, "cat-file", "blob", obj],
                    {
                        cwd: sourcePath,
                        env: cleanGitEnv(),
                        encoding: "buffer",
                        maxBuffer: maxFileBytes + 4096,
                    },
                ).catch((error: unknown) => {
                    const code = (error as { code?: string }).code;

                    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
                        throw new Error(
                            `Cannot seed sandbox: "${relPath}" exceeds the ${maxFileBytes / 1024 / 1024} MiB per-file snapshot limit.`,
                        );
                    }

                    throw error;
                });

                bytes = new Uint8Array(blob);
            }

            checkLimits(relPath, bytes.byteLength);

            const guestPath = posix.join("/workspace", relPath);
            const guestParent = posix.dirname(guestPath);

            if (guestParent !== "/workspace") {
                await vm.fs.mkdir(guestParent, true, signal);
            }

            await vm.fs.writeFile(guestPath, bytes, signal);

            if (executable) {
                executables.push(guestPath);
            }

            copiedFiles++;
            copiedBytes += bytes.byteLength;
        }

        const baseCommit = await initGuestSnapshotRepo(
            vm,
            "Initial workspace snapshot",
            executables,
            signal,
        );

        return { ...(baseCommit === undefined ? {} : { baseCommit }) };
    }

    // Plain folder snapshot: copy regular non-secret files safely without following symlinks.
    const walk = async (hostDir: string, relDir: string): Promise<void> => {
        signal?.throwIfAborted();
        const guestDir = relDir === "" ? "/workspace" : posix.join("/workspace", relDir);

        await vm.fs.mkdir(guestDir, true, signal);

        for (const entry of readdirSync(hostDir)) {
            const relPath = relDir === "" ? entry : posix.join(relDir, entry);

            if (isExcludedSeedPath(relPath)) {
                continue;
            }

            const hostPath = join(hostDir, entry);
            const stat = lstatSync(hostPath);

            // Never follow symlinks or open FIFOs/devices/sockets.
            if (stat.isSymbolicLink()) {
                continue;
            }

            if (stat.isDirectory()) {
                await walk(hostPath, relPath);
            } else if (stat.isFile()) {
                checkLimits(relPath, stat.size);
                const bytes = readFileSync(hostPath);
                const guestPath = posix.join("/workspace", relPath);

                await vm.fs.writeFile(guestPath, new Uint8Array(bytes), signal);

                if ((stat.mode & 0o111) !== 0) {
                    executables.push(guestPath);
                }

                copiedFiles++;
                copiedBytes += bytes.byteLength;
            }
        }
    };

    await walk(sourcePath, "");
    const baseCommit = await initGuestSnapshotRepo(
        vm,
        "Initial workspace snapshot",
        executables,
        signal,
    );

    return { ...(baseCommit === undefined ? {} : { baseCommit }) };
}
