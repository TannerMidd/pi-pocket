/**
 * A session can work in a git worktree of its own: a checkout of the same repository, on a branch of its own, in
 * Pi Pocket's data folder here or on its computer. Its changes stay apart from the folder it came from and from
 * other sessions. It starts with the last commit, uncommitted changes, and new files; ignored files are not copied.
 */
import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { RemoteInfo } from "@earendil-works/pi-env";
import { describe, HttpError } from "./errors.ts";
import { type FolderAccess, localAccess, remoteAccess } from "./folder-access.ts";
import { GitError } from "./git.ts";
import { workspaceScheme } from "./paths.ts";

export type Worktree = {
    /** The worktree's folder. */
    path: string;
    branch: string;
    /** The folder the session came from, where it goes back to when the worktree is removed. */
    source: string;
};

/** The same worktree steps on either disk: git and path rules, with folders and copies on that disk only. */
export type WorktreeAccess = FolderAccess & {
    mkdir(path: string): Promise<void>;
    copyFile(from: string, to: string): Promise<void>;
};

const localWorktrees: WorktreeAccess = {
    ...localAccess,
    async mkdir(path) {
        await mkdir(path, { recursive: true });
    },
    copyFile,
};

/** No Node file operation reaches a session's computer: even the copied bytes use its approved environment. */
export function remoteWorktrees(env: ExecutionEnv, info: Pick<RemoteInfo, "os">): WorktreeAccess {
    const context = BACKGROUND_CONTEXT;

    return {
        ...remoteAccess(env, info),
        async mkdir(path) {
            getOrThrow(await env.createDir(path, { recursive: true }, context));
        },
        async copyFile(from, to) {
            const reader = getOrThrow(
                await env.openBinaryReader(from, { noFollow: true }, context),
            );

            try {
                getOrThrow(await env.writeFile(to, new Uint8Array(), context));

                // Stay below the runner's frame limit, including when one new file uses the whole 50 MiB budget.
                for (let offset = 0; ;) {
                    const bytes = getOrThrow(await reader.read(offset, 1024 * 1024, context));

                    if (bytes.length === 0) {
                        break;
                    }

                    getOrThrow(await env.appendFile(to, bytes, context));
                    offset += bytes.length;
                }
            } finally {
                await reader.close(context);
            }
        },
    };
}

/** How many bytes of new files a new worktree gets, all together; any file that would go past it is left out. */
const MAX_COPIED_BYTES = 50 * 1024 * 1024;

/** The top folder of the repository `cwd` is in, or undefined when it is in none. */
async function repositoryOf(cwd: string, access: FolderAccess): Promise<string | undefined> {
    try {
        return (await access.git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    } catch (error) {
        if (error instanceof GitError) {
            return undefined;
        }

        throw error;
    }
}

/** Copy the repository's new (untracked, not ignored) files into the worktree. Returns the ones left out for size. */
async function copyNewFiles(root: string, into: string, access: WorktreeAccess): Promise<string[]> {
    const skipped: string[] = [];
    let copied = 0;

    for (const path of (
        await access.git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    ).split("\0")) {
        if (path === "") {
            continue;
        }

        const from = access.path.join(root, path);
        const stats = await access.info(from).catch(() => undefined);

        if (stats === undefined || stats.kind !== "file") {
            continue;
        }

        if (copied + stats.size > MAX_COPIED_BYTES) {
            skipped.push(path);
            continue;
        }

        await access.mkdir(access.path.dirname(access.path.join(into, path)));
        await access.copyFile(from, access.path.join(into, path));
        copied += stats.size;
    }

    return skipped;
}

/**
 * Make a worktree for a session that works in `cwd`, under `folder`, named after `label`. Returns it, the folder
 * inside it that matches `cwd`, and the new files too big to copy.
 */
export async function createWorktree(
    cwd: string,
    folder: string,
    label: string,
    access: WorktreeAccess = localWorktrees,
): Promise<{ worktree: Worktree; cwd: string; skipped: string[] }> {
    if (workspaceScheme(cwd) !== undefined) {
        throw new HttpError(400, "Remote workspaces do not support worktrees.");
    }

    const root = await repositoryOf(cwd, access);

    if (root === undefined) {
        throw new HttpError(
            400,
            `${cwd} is not in a git repository, so it cannot have a worktree.`,
        );
    }

    // The runner approves `cwd`, not its ancestors. Never widen that permission to reach a repository above it.
    if (access.id !== "" && access.path.relative(await access.realpath(cwd), root) !== "") {
        throw new HttpError(
            400,
            "The repository root is outside the session's approved folder. Start in the repository root to make a worktree.",
        );
    }

    // Where `cwd` is within the repository, as git sees it: `cwd` may be reached through a symbolic link, `root` not.
    const within = (await access.git(cwd, ["rev-parse", "--show-prefix"])).trim();

    if (
        !(await access.git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
            () => true,
            (error: unknown) => {
                if (error instanceof GitError) {
                    return false;
                }

                throw error;
            },
        ))
    ) {
        throw new HttpError(400, "The repository has no commits yet: commit once, then try again.");
    }

    const slug =
        label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "session";
    const name = `${slug}-${randomUUID().slice(0, 6)}`;
    const worktree: Worktree = {
        path: access.path.join(folder, name),
        branch: `pocket/${name}`,
        source: cwd,
    };

    await access.mkdir(folder);
    await access.git(root, ["worktree", "add", "-b", worktree.branch, worktree.path, "HEAD"]);

    try {
        // Uncommitted changes to tracked files, as a commit object that changes nothing here; empty when there are none.
        const changes = (await access.git(root, ["stash", "create"])).trim();

        if (changes !== "") {
            await access.git(worktree.path, ["stash", "apply", changes]);
        }

        const skipped = await copyNewFiles(root, worktree.path, access);

        return { worktree, cwd: access.path.resolve(worktree.path, within), skipped };
    } catch (error) {
        await discardWorktree(worktree, access).catch(() => undefined);

        throw new HttpError(500, `The worktree could not be set up: ${describe(error)}`);
    }
}

/** Whether a folder is the worktree's or one inside it, also when reached through a symbolic link. */
export async function inWorktree(
    worktree: Worktree,
    cwd: string,
    access: FolderAccess = localAccess,
): Promise<boolean> {
    const real = (path: string) => access.realpath(path).catch(() => access.path.resolve(path));
    const [base, folder] = await Promise.all([real(worktree.path), real(cwd)]);
    const relative = access.path.relative(base, folder);

    return (
        relative === "" ||
        (!relative.startsWith(".." + access.path.sep) &&
            relative !== ".." &&
            !access.path.isAbsolute(relative))
    );
}

/**
 * Where each folder of a worktree is in the folder it was made from: the same place in the repository, and the
 * session's folder as it was given. A folder that is only in the worktree maps to the session's folder.
 */
export async function sourceFolders(
    worktree: Worktree,
    access: FolderAccess = localAccess,
): Promise<(cwd: string) => Promise<string>> {
    const root = await repositoryOf(worktree.source, access);
    const original = await access.realpath(worktree.source).catch(() => undefined);

    return async (cwd) => {
        if (root === undefined) {
            return worktree.source;
        }

        const mapped = access.path.resolve(root, access.path.relative(worktree.path, cwd));

        return mapped === original ||
            !(await access.info(mapped).then(
                () => true,
                () => false,
            ))
            ? worktree.source
            : mapped;
    };
}

/**
 * Remove a worktree's folder; its branch stays, with whatever was committed on it. One with uncommitted changes is
 * kept, unless `force`.
 */
export async function removeWorktree(
    worktree: Worktree,
    force: boolean,
    access: FolderAccess = localAccess,
): Promise<void> {
    if (
        !(await access.info(worktree.path).then(
            () => true,
            (error: unknown) => {
                const code = (error as NodeJS.ErrnoException).code;

                if (code === "ENOENT" || code === "ENOTDIR") {
                    return false;
                }

                throw error;
            },
        ))
    ) {
        return;
    }

    const root = await repositoryOf(worktree.source, access);

    if (root === undefined) {
        throw new HttpError(409, `${worktree.source} is not in a git repository anymore.`);
    }

    try {
        await access.git(root, [
            "worktree",
            "remove",
            ...(force ? ["--force"] : []),
            worktree.path,
        ]);
    } catch (error) {
        const message = describe(error);

        // Git runs in English here (see git.ts), so its words can be matched.
        if (!force && error instanceof GitError && /modified or untracked files/.test(message)) {
            throw new HttpError(409, "The worktree has uncommitted changes.");
        }

        throw new HttpError(500, `The worktree could not be removed: ${message}`);
    }
}

/** Undo a worktree that a session never got: its folder and its branch. */
export async function discardWorktree(
    worktree: Worktree,
    access: FolderAccess = localAccess,
): Promise<void> {
    await removeWorktree(worktree, true, access);
    const root = await repositoryOf(worktree.source, access);

    if (root !== undefined) {
        await access.git(root, ["branch", "-D", worktree.branch]);
    }
}
