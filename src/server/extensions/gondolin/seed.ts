/**
 * One-way workspace seeding into a Gondolin micro-VM: copies a snapshot of a local repository or folder (or clones an
 * HTTPS git URL inside the VM) into `/workspace` on the VM's private disk.
 *
 * The host directory is NEVER mounted read-write into the VM, so the guest can never write symlinks, FIFOs,
 * `.git/hooks`, or `.git/config` back to the host.
 */
import { execFile } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import type { GuestVm } from "./guest.ts";
import { inspectPatch } from "./patch.ts";

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

/**
 * Seeds `/workspace` inside `vm` from an empty directory, a local host repo/folder (one-way copy, never a live mount),
 * or an HTTPS git URL cloned inside the VM.
 */
export async function seedWorkspace(
    vm: GuestVm,
    options:
        | { kind: "empty" }
        | { kind: "git"; repoUrl: string }
        | { kind: "repo"; sourcePath: string; includeUncommitted?: boolean },
    signal?: AbortSignal,
): Promise<void> {
    await vm.fs.mkdir("/workspace", true, signal);
    await configureGuestGit(vm, signal);

    if (options.kind === "empty") {
        await execInGuest(
            vm,
            [
                "/bin/sh",
                "-c",
                'if command -v git >/dev/null 2>&1 && [ ! -d /workspace/.git ]; then git -C /workspace init -q && git -C /workspace commit --allow-empty -q -m "Empty sandbox"; fi',
            ],
            "/",
            signal,
        );

        return;
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

        return;
    }

    // One-way local repo or folder seed.
    const sourcePath = options.sourcePath;
    const isGitRepo = await execFileAsync(
        "git",
        ["-c", "core.hooksPath=/dev/null", "rev-parse", "--verify", "HEAD"],
        { cwd: sourcePath, env: cleanGitEnv() },
    ).then(
        () => true,
        () => false,
    );

    if (isGitRepo) {
        const hasGuestGit =
            (
                await execInGuest(
                    vm,
                    ["/bin/sh", "-c", "command -v git >/dev/null 2>&1"],
                    "/",
                    signal,
                )
            ).exitCode === 0;

        if (hasGuestGit) {
            const tempDir = mkdtempSync(join(tmpdir(), "pocket-gondolin-seed-"));
            const bundlePath = join(tempDir, "seed.bundle");

            try {
                await execFileAsync(
                    "git",
                    ["-c", "core.hooksPath=/dev/null", "bundle", "create", bundlePath, "HEAD"],
                    { cwd: sourcePath, env: cleanGitEnv(), maxBuffer: MAX_SNAPSHOT_TOTAL_BYTES },
                );
                const bundle = readFileSync(bundlePath);

                await vm.fs.writeFile("/tmp/pocket-seed.bundle", new Uint8Array(bundle), signal);
            } finally {
                rmSync(tempDir, { recursive: true, force: true });
            }

            const cloned = await execInGuest(
                vm,
                [
                    "/bin/sh",
                    "-c",
                    "rm -rf /workspace && git clone -q /tmp/pocket-seed.bundle /workspace && rm -f /tmp/pocket-seed.bundle && git -C /workspace remote remove origin",
                ],
                "/",
                signal,
            );

            if (cloned.exitCode !== 0) {
                throw new Error(
                    `Failed to unpack repository bundle in sandbox: ${cloned.stderr.trim()}`,
                );
            }

            if (options.includeUncommitted === true) {
                const { stdout: diff } = await execFileAsync(
                    "git",
                    [
                        "-c",
                        "core.hooksPath=/dev/null",
                        "-c",
                        "diff.mnemonicPrefix=false",
                        "-c",
                        "diff.noprefix=false",
                        "diff",
                        "--no-ext-diff",
                        "HEAD",
                    ],
                    { cwd: sourcePath, env: cleanGitEnv(), maxBuffer: MAX_SNAPSHOT_TOTAL_BYTES },
                );

                if (diff.trim() !== "" && inspectPatch(diff).ok) {
                    await vm.fs.writeFile(
                        "/tmp/pocket-seed.patch",
                        Buffer.from(diff, "utf8"),
                        signal,
                    );
                    await execInGuest(
                        vm,
                        [
                            "/bin/sh",
                            "-c",
                            'git -C /workspace apply --whitespace=nowarn /tmp/pocket-seed.patch && rm -f /tmp/pocket-seed.patch && git -C /workspace add -A && git -C /workspace commit -q -m "Host working-tree snapshot"',
                        ],
                        "/",
                        signal,
                    );
                }
            }

            return;
        }
    }

    // Plain folder snapshot (or guest image without git): copy regular non-secret files safely.
    let copiedFiles = 0;
    let copiedBytes = 0;

    const walk = async (hostDir: string, guestDir: string): Promise<void> => {
        signal?.throwIfAborted();
        await vm.fs.mkdir(guestDir, true, signal);

        for (const entry of readdirSync(hostDir)) {
            if (SKIP_DIRS.has(entry) || /^\.env($|\.)/i.test(entry)) {
                continue;
            }

            const hostPath = join(hostDir, entry);
            const stat = lstatSync(hostPath);

            // Never follow symlinks or open FIFOs/devices/sockets.
            if (stat.isSymbolicLink()) {
                continue;
            }

            const guestPath = posix.join(guestDir, entry);

            if (stat.isDirectory()) {
                await walk(hostPath, guestPath);
            } else if (stat.isFile()) {
                if (
                    stat.size > MAX_SNAPSHOT_FILE_BYTES ||
                    copiedFiles >= MAX_SNAPSHOT_FILES ||
                    copiedBytes + stat.size > MAX_SNAPSHOT_TOTAL_BYTES
                ) {
                    continue;
                }

                const bytes = readFileSync(hostPath);

                await vm.fs.writeFile(guestPath, new Uint8Array(bytes), signal);
                copiedFiles++;
                copiedBytes += bytes.byteLength;
            }
        }
    };

    await walk(sourcePath, "/workspace");
    await execInGuest(
        vm,
        [
            "/bin/sh",
            "-c",
            'if command -v git >/dev/null 2>&1; then git -C /workspace init -q && git -C /workspace add -A && git -C /workspace commit -q --allow-empty -m "Initial workspace snapshot"; fi',
        ],
        "/",
        signal,
    );
}
