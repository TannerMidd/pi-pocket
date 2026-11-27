/**
 * Patch inspection and hardened host-branch application: the single explicit trust boundary between an isolated
 * Gondolin sandbox and a host repository.
 *
 * Every patch coming out of a sandbox is treated as untrusted code (like an external PR):
 * - Symlinks (`120000`), submodules (`160000`), binary patches, `.git/` paths, absolute paths, and `..` traversals are
 *   rejected outright.
 * - High-risk files (`package.json`, `.envrc`, `.gitattributes`, `.pi/**`, workflows, build scripts) are explicitly
 *   flagged for owner review.
 * - Applying creates a **new local git branch** via a disposable temporary worktree with hooks and filters disabled,
 *   never touching the owner's live working tree or index.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Maximum patch size accepted from a sandbox (10 MiB). */
export const MAX_PATCH_BYTES = 10 * 1024 * 1024;

export interface PatchFile {
    path: string;
    oldPath?: string;
    added: number;
    removed: number;
    status: "added" | "modified" | "deleted" | "renamed";
}

export interface RiskyFile {
    path: string;
    reason: string;
}

export interface PatchInspection {
    ok: boolean;
    patch: string;
    /** SHA-256 hex digest of `patch`, used to bind Apply strictly to the exact diff the owner reviewed. */
    patchHash: string;
    files: PatchFile[];
    blocked: string[];
    riskyFiles: RiskyFile[];
    totalAdded: number;
    totalRemoved: number;
}

const RISK_PATTERNS: readonly { test: (path: string) => boolean; reason: string }[] = [
    {
        test: (p) => /(^|\/)package\.json$/.test(p),
        reason: "Defines npm lifecycle scripts (preinstall/postinstall/etc.)",
    },
    {
        test: (p) => /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs)$/.test(p),
        reason: "Package manager configuration",
    },
    {
        test: (p) => /(^|\/)\.envrc$/.test(p),
        reason: "direnv executes shell commands on directory entry",
    },
    {
        test: (p) => /(^|\/)\.(gitattributes|gitmodules)$/.test(p),
        reason: "Git attributes or submodule configuration",
    },
    {
        test: (p) => /(^|\/)\.pi(\/|$)/.test(p),
        reason: "Pi project configuration, skills, or prompts",
    },
    {
        test: (p) => /(^|\/)\.(vscode|idea)(\/|$)/.test(p),
        reason: "Editor workspace settings or auto-run tasks",
    },
    {
        test: (p) => /(^|\/)\.github\/workflows\//.test(p),
        reason: "CI/CD workflow definition",
    },
    {
        test: (p) =>
            /(^|\/)(Makefile|GNUmakefile|Justfile|Dockerfile|docker-compose[^/]*\.ya?ml|setup\.py|pyproject\.toml|Cargo\.toml|build\.rs)$/.test(
                p,
            ) || /\.sh$/.test(p),
        reason: "Build script, container config, or shell script",
    },
];

/** Normalizes a diff header path (`a/foo/bar` -> `foo/bar`), handling git's quoted C-style escapes. */
function unquoteDiffPath(raw: string): string | undefined {
    const trimmed = raw.trim();

    if (trimmed === "/dev/null") {
        return undefined;
    }

    let value = trimmed;

    if (value.startsWith('"') && value.endsWith('"')) {
        // Refuse octal/hex/control escapes that could smuggle NUL or weird control chars; decode simple escapes.
        value = value.slice(1, -1).replace(/\\(["\\])/g, "$1");

        if (/\\[0-7]{1,3}|\\x|\\u|\\0/.test(value)) {
            return "\0escaped";
        }
    }

    return value.replace(/^[ab]\//, "");
}

/** Whether `path` attempts traversal, absolute escape, NUL/backslash smuggling, or `.git` metadata writes. */
function unsafePathReason(path: string): string | undefined {
    if (path === "" || path.includes("\0")) {
        return `Invalid or NUL-containing path "${path}".`;
    }

    if (path.startsWith("/") || path.includes("\\") || /^[a-zA-Z]:/.test(path)) {
        return `Absolute or backslash path "${path}" is not allowed.`;
    }

    for (const part of path.split("/")) {
        const folded = part.replace(/[. ]+$/g, "").toLowerCase();

        if (part === "" || part === "." || part === "..") {
            return `Path traversal component in "${path}" is not allowed.`;
        }

        if (folded === ".git" || folded === "git~1" || /^git~[0-9]+$/.test(folded)) {
            return `Modifying Git metadata path "${path}" is not allowed.`;
        }
    }

    return undefined;
}

/**
 * Inspects a unified git diff produced by a sandbox VM. Returns structural file stats, risk warnings, and any
 * security-blocked constructs (symlinks, submodules, binary patches, `.git/` or traversal paths).
 */
export function inspectPatch(rawPatch: string): PatchInspection {
    const blocked: string[] = [];
    const files: PatchFile[] = [];
    const riskyMap = new Map<string, string>();
    let totalAdded = 0;
    let totalRemoved = 0;

    if (Buffer.byteLength(rawPatch, "utf8") > MAX_PATCH_BYTES) {
        return {
            ok: false,
            patch: "",
            patchHash: "",
            files: [],
            blocked: [`Patch exceeds the ${MAX_PATCH_BYTES / 1024 / 1024} MiB limit.`],
            riskyFiles: [],
            totalAdded: 0,
            totalRemoved: 0,
        };
    }

    if (rawPatch.includes("\0")) {
        return {
            ok: false,
            patch: "",
            patchHash: "",
            files: [],
            blocked: ["Patch contains NUL bytes."],
            riskyFiles: [],
            totalAdded: 0,
            totalRemoved: 0,
        };
    }

    const lines = rawPatch.split("\n");
    let current: PatchFile | undefined;
    let inHunk = false;

    const recordRisk = (path: string) => {
        if (riskyMap.has(path)) {
            return;
        }

        for (const rule of RISK_PATTERNS) {
            if (rule.test(path)) {
                riskyMap.set(path, rule.reason);

                return;
            }
        }
    };

    const checkPath = (path: string | undefined) => {
        if (path === undefined) {
            return;
        }

        const reason = unsafePathReason(path);

        if (reason !== undefined) {
            blocked.push(reason);
        } else {
            recordRisk(path);
        }
    };

    for (const rawLine of lines) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line.startsWith("diff --git ")) {
            inHunk = false;
            const match = /^diff --git ("[^"]+"|\S+) ("[^"]+"|\S+)$/.exec(line);

            if (match === null) {
                blocked.push(`Malformed diff header: ${line.slice(0, 120)}`);
                current = undefined;
                continue;
            }

            const oldPath = unquoteDiffPath(match[1]!);
            const newPath = unquoteDiffPath(match[2]!);

            checkPath(oldPath);
            checkPath(newPath);

            current = {
                path: newPath ?? oldPath ?? "",
                ...(oldPath !== undefined && newPath !== undefined && oldPath !== newPath
                    ? { oldPath }
                    : {}),
                added: 0,
                removed: 0,
                status: "modified",
            };
            files.push(current);
            continue;
        }

        if (!inHunk) {
            if (line.startsWith("@@ ")) {
                inHunk = true;
                continue;
            }

            if (line === "GIT binary patch" || /^Binary files .* differ$/.test(line)) {
                blocked.push(
                    `Binary patch${current ? ` for "${current.path}"` : ""} is not allowed; apply text patches only.`,
                );
                continue;
            }

            const modeMatch =
                /^(?:new file mode|deleted file mode|old mode|new mode) ([0-7]+)$/.exec(line);

            if (modeMatch !== null) {
                const mode = modeMatch[1]!;

                if (mode === "120000") {
                    blocked.push(
                        `Symlink mode (120000)${current ? ` on "${current.path}"` : ""} is not allowed.`,
                    );
                } else if (mode === "160000") {
                    blocked.push(
                        `Submodule/gitlink mode (160000)${current ? ` on "${current.path}"` : ""} is not allowed.`,
                    );
                } else if (current !== undefined) {
                    if (line.startsWith("new file mode")) {
                        current.status = "added";
                    } else if (line.startsWith("deleted file mode")) {
                        current.status = "deleted";
                    }
                }

                continue;
            }

            if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
                const p = unquoteDiffPath(line.slice(line.indexOf("from ") + 5));

                checkPath(p);

                if (current !== undefined && p !== undefined) {
                    current.oldPath = p;
                    current.status = "renamed";
                }

                continue;
            }

            if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
                const p = unquoteDiffPath(line.slice(line.indexOf("to ") + 3));

                checkPath(p);

                if (current !== undefined && p !== undefined) {
                    current.path = p;
                    current.status = "renamed";
                }

                continue;
            }

            if (line.startsWith("--- ")) {
                checkPath(unquoteDiffPath(line.slice(4)));
                continue;
            }

            if (line.startsWith("+++ ")) {
                checkPath(unquoteDiffPath(line.slice(4)));
                continue;
            }
        } else if (current !== undefined) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
                current.added++;
                totalAdded++;
            } else if (line.startsWith("-") && !line.startsWith("---")) {
                current.removed++;
                totalRemoved++;
            }
        }
    }

    const riskyFiles: RiskyFile[] = [...riskyMap.entries()].map(([path, reason]) => ({
        path,
        reason,
    }));
    const patchHash = createHash("sha256").update(rawPatch, "utf8").digest("hex");

    return {
        ok: blocked.length === 0,
        patch: rawPatch,
        patchHash,
        files,
        blocked,
        riskyFiles,
        totalAdded,
        totalRemoved,
    };
}

/** Clean, hardened git environment: strips inherited `GIT_*` overrides and disables hooks/filters/fsmonitor. */
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

const HARDENED_GIT_FLAGS = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.autocrlf=false",
    "-c",
    "safe.bareRepository=explicit",
] as const;

async function runHardenedGit(
    cwd: string,
    args: readonly string[],
    stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
    if (stdin === undefined) {
        return execFileAsync("git", [...HARDENED_GIT_FLAGS, ...args], {
            cwd,
            env: cleanGitEnv(),
            maxBuffer: MAX_PATCH_BYTES,
        });
    }

    const { spawn } = await import("node:child_process");

    return new Promise((resolve, reject) => {
        const child = spawn("git", [...HARDENED_GIT_FLAGS, ...args], {
            cwd,
            env: cleanGitEnv(),
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("close", (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(stderr.trim() || `git ${args[0]} failed with exit code ${code}`));
            }
        });
        child.stdin.end(stdin, "utf8");
    });
}

export function validBranchName(name: string): boolean {
    return (
        name.length > 0 &&
        name.length <= 120 &&
        /^[a-zA-Z0-9._/-]+$/.test(name) &&
        !name.startsWith("-") &&
        !name.startsWith("/") &&
        !name.endsWith("/") &&
        !name.endsWith(".") &&
        !name.endsWith(".lock") &&
        !name.includes("..") &&
        !name.includes("//") &&
        !name.includes("@{")
    );
}

/**
 * Discovers every `filter.<name>.*` and `diff.<name>.*` configured across system/global/local/worktree Git config and
 * returns `-c` overrides that completely disable them so neither `checkout` nor `apply --index` can invoke external
 * filter commands (e.g. Git LFS, custom clean/smudge/process filters, or textconv drivers).
 */
async function disableFilterFlags(repoPath: string): Promise<string[]> {
    const flags: string[] = [];
    const filters = new Set<string>();
    const diffs = new Set<string>();

    const out = await runHardenedGit(repoPath, ["config", "--get-regexp", "^(filter|diff)\\."])
        .then((r) => r.stdout)
        .catch(() => "");

    for (const line of out.split("\n")) {
        const key = line.split(/\s+/, 1)[0] ?? "";
        const filterMatch = /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(key);

        if (filterMatch !== null && filterMatch[1]) {
            filters.add(filterMatch[1]);
        }

        const diffMatch = /^diff\.(.+)\.(textconv|command)$/i.exec(key);

        if (diffMatch !== null && diffMatch[1]) {
            diffs.add(diffMatch[1]);
        }
    }

    for (const name of filters) {
        flags.push(
            "-c",
            `filter.${name}.clean=`,
            "-c",
            `filter.${name}.smudge=`,
            "-c",
            `filter.${name}.process=`,
            "-c",
            `filter.${name}.required=false`,
        );
    }

    for (const name of diffs) {
        flags.push("-c", `diff.${name}.textconv=`, "-c", `diff.${name}.command=`);
    }

    return flags;
}

/**
 * Applies a validated sandbox patch onto a **brand-new local git branch** in `repoPath` using a disposable temporary
 * worktree. The repository's active working tree and index are never modified, hooks and filters are completely
 * disabled, and the final ref creation is atomic (fails if a concurrent apply created the branch first).
 */
export async function applyPatchToNewBranch(options: {
    repoPath: string;
    branchName: string;
    patch: string;
    commitMessage?: string;
}): Promise<{ branch: string; commit: string; filesChanged: number }> {
    const { repoPath, branchName, patch } = options;

    if (!validBranchName(branchName)) {
        throw new Error(`Invalid branch name "${branchName}".`);
    }

    const inspection = inspectPatch(patch);

    if (!inspection.ok) {
        throw new Error(`Patch refused for safety: ${inspection.blocked.join(" ")}`);
    }

    if (inspection.files.length === 0) {
        throw new Error("The patch contains no file changes.");
    }

    // Verify repoPath is a git repository with a HEAD commit and branch does not already exist.
    const head = (await runHardenedGit(repoPath, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
    const exists = await runHardenedGit(repoPath, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branchName}`,
    ]).then(
        () => true,
        () => false,
    );

    if (exists) {
        throw new Error(`Branch "${branchName}" already exists. Choose a new branch name.`);
    }

    const noFilters = await disableFilterFlags(repoPath);
    const worktreeRoot = mkdtempSync(join(tmpdir(), "pocket-gondolin-apply-"));
    const worktreeDir = join(worktreeRoot, "wt");

    try {
        await runHardenedGit(repoPath, [
            ...noFilters,
            "worktree",
            "add",
            "--no-checkout",
            "--detach",
            worktreeDir,
            head,
        ]);
        await runHardenedGit(worktreeDir, [...noFilters, "reset", "--hard", head]);
        await runHardenedGit(
            worktreeDir,
            [...noFilters, "apply", "--index", "--whitespace=nowarn"],
            patch,
        );

        const message =
            options.commitMessage?.trim() ||
            `Apply sandbox changes (${inspection.files.length} file${inspection.files.length === 1 ? "" : "s"})`;

        await runHardenedGit(worktreeDir, [
            ...noFilters,
            "-c",
            "user.name=Pi Pocket Sandbox",
            "-c",
            "user.email=sandbox@localhost",
            "commit",
            "--no-verify",
            "-m",
            message,
        ]);

        const commit = (await runHardenedGit(worktreeDir, ["rev-parse", "HEAD"])).stdout.trim();

        // Passing empty string as oldvalue makes update-ref atomic: fails if the branch was created concurrently.
        await runHardenedGit(repoPath, ["update-ref", `refs/heads/${branchName}`, commit, ""]);

        return { branch: branchName, commit, filesChanged: inspection.files.length };
    } finally {
        await runHardenedGit(repoPath, ["worktree", "remove", "--force", worktreeDir]).catch(
            () => undefined,
        );
        rmSync(worktreeRoot, { recursive: true, force: true });
    }
}
