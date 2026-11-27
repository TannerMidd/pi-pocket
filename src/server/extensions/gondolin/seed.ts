/**
 * One-way workspace seeding into a Gondolin micro-VM: creates a clean, filtered single-commit snapshot of a local
 * repository or folder (or clones an HTTPS git URL inside the VM) into `/workspace` on the VM's private disk.
 *
 * Security invariants:
 * - The host directory is NEVER mounted read-write into the VM.
 * - Local Git repositories NEVER transfer raw Git history (which could contain historically deleted `.env` or secret
 *   files): only the current filtered file tree is copied into a fresh initial commit inside `/workspace`.
 * - Secret-like files (`.env`, `.env.*`, `*.pem`, `*.key`) and symlinks/special files are excluded consistently across
 *   both committed and uncommitted files.
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

const MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 2_000;

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
    signal?: AbortSignal,
): Promise<string | undefined> {
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
        | { kind: "repo"; sourcePath: string; includeUncommitted?: boolean },
    signal?: AbortSignal,
): Promise<{ baseCommit?: string }> {
    await vm.fs.mkdir("/workspace", true, signal);
    await configureGuestGit(vm, signal);

    if (options.kind === "empty") {
        const baseCommit = await initGuestSnapshotRepo(vm, "Empty sandbox", signal);

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

    // Local repo or plain folder: build a filtered single-commit snapshot (no raw .git history or excluded secrets).
    const sourcePath = options.sourcePath;
    const isGitRepo = await execFileAsync(
        "git",
        ["-c", "core.hooksPath=/dev/null", "rev-parse", "--verify", "HEAD"],
        { cwd: sourcePath, env: cleanGitEnv() },
    ).then(
        () => true,
        () => false,
    );

    let copiedFiles = 0;
    let copiedBytes = 0;

    if (isGitRepo) {
        // List tracked files in HEAD (regular files only, never symlinks 120000 or submodules 160000).
        const { stdout: lsOut } = await execFileAsync(
            "git",
            ["-c", "core.hooksPath=/dev/null", "ls-tree", "-r", "-z", "HEAD"],
            { cwd: sourcePath, env: cleanGitEnv(), maxBuffer: MAX_SNAPSHOT_TOTAL_BYTES },
        );

        const entries = lsOut.split("\0").filter((entry) => entry !== "");

        for (const entry of entries) {
            signal?.throwIfAborted();

            const tab = entry.indexOf("\t");

            if (tab < 0) {
                continue;
            }

            const meta = entry.slice(0, tab).split(" ");
            const mode = meta[0];
            const type = meta[1];
            const relPath = entry.slice(tab + 1);

            // Regular blobs only (100644 / 100755); skip symlinks (120000), submodules (160000), and excluded secrets.
            if (
                type !== "blob" ||
                (mode !== "100644" && mode !== "100755") ||
                isExcludedSeedPath(relPath)
            ) {
                continue;
            }

            if (copiedFiles >= MAX_SNAPSHOT_FILES) {
                break;
            }

            let bytes: Uint8Array;

            if (options.includeUncommitted === true) {
                // Read current host working-tree bytes if still a regular non-symlink file; skip if deleted.
                const hostFile = join(sourcePath, relPath);

                try {
                    const st = lstatSync(hostFile);

                    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_SNAPSHOT_FILE_BYTES) {
                        continue;
                    }

                    bytes = new Uint8Array(readFileSync(hostFile));
                } catch {
                    continue;
                }
            } else {
                // Read exact blob from HEAD without running host smudge/clean filters.
                const obj = meta[2];

                if (!obj || !/^[0-9a-f]{40,64}$/i.test(obj)) {
                    continue;
                }

                const { stdout: blob } = await execFileAsync(
                    "git",
                    ["-c", "core.hooksPath=/dev/null", "cat-file", "blob", obj],
                    {
                        cwd: sourcePath,
                        env: cleanGitEnv(),
                        encoding: "buffer",
                        maxBuffer: MAX_SNAPSHOT_FILE_BYTES + 1024,
                    },
                ).catch(() => ({ stdout: null }));

                if (blob === null || blob.byteLength > MAX_SNAPSHOT_FILE_BYTES) {
                    continue;
                }

                bytes = new Uint8Array(blob);
            }

            if (copiedBytes + bytes.byteLength > MAX_SNAPSHOT_TOTAL_BYTES) {
                continue;
            }

            const guestPath = posix.join("/workspace", relPath);
            const guestParent = posix.dirname(guestPath);

            if (guestParent !== "/workspace") {
                await vm.fs.mkdir(guestParent, true, signal);
            }

            await vm.fs.writeFile(guestPath, bytes, signal);
            copiedFiles++;
            copiedBytes += bytes.byteLength;
        }

        const baseCommit = await initGuestSnapshotRepo(vm, "Initial workspace snapshot", signal);

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
                if (
                    stat.size > MAX_SNAPSHOT_FILE_BYTES ||
                    copiedFiles >= MAX_SNAPSHOT_FILES ||
                    copiedBytes + stat.size > MAX_SNAPSHOT_TOTAL_BYTES
                ) {
                    continue;
                }

                const bytes = readFileSync(hostPath);

                await vm.fs.writeFile(
                    posix.join("/workspace", relPath),
                    new Uint8Array(bytes),
                    signal,
                );
                copiedFiles++;
                copiedBytes += bytes.byteLength;
            }
        }
    };

    await walk(sourcePath, "");
    const baseCommit = await initGuestSnapshotRepo(vm, "Initial workspace snapshot", signal);

    return { ...(baseCommit === undefined ? {} : { baseCommit }) };
}
