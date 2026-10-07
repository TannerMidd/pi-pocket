/**
 * A session can work in a git worktree of its own: a checkout of the same repository, on a branch of its own, in
 * Pi Pocket's data folder. Its changes stay apart from the folder it came from and from other sessions, and a fork in
 * a worktree tries another approach without touching the first. A worktree starts with the folder's files as they
 * are: the last commit, uncommitted changes, and new files. Ignored files, such as node_modules, are not copied.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, HttpError } from "./errors.ts";
import { git, GitError } from "./git.ts";

export type Worktree = {
    /** The worktree's folder. */
    path: string;
    branch: string;
    /** The folder the session came from, where it goes back to when the worktree is removed. */
    source: string;
};

/** How many bytes of new files a new worktree gets, all together; any file that would go past it is left out. */
const MAX_COPIED_BYTES = 50 * 1024 * 1024;

/** The top folder of the repository `cwd` is in, or undefined when it is in none. */
async function repositoryOf(cwd: string): Promise<string | undefined> {
    return git(cwd, ["rev-parse", "--show-toplevel"]).then(
        (root) => root.trim(),
        () => undefined,
    );
}

/** Copy the repository's new (untracked, not ignored) files into the worktree. Returns the ones left out for size. */
async function copyNewFiles(root: string, into: string): Promise<string[]> {
    const skipped: string[] = [];
    let copied = 0;

    for (const path of (
        await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    ).split("\0")) {
        if (path === "") {
            continue;
        }

        const from = join(root, path);
        const stats = await lstat(from).catch(() => undefined);

        if (stats === undefined || !stats.isFile()) {
            continue;
        }

        if (copied + stats.size > MAX_COPIED_BYTES) {
            skipped.push(path);
            continue;
        }

        await mkdir(dirname(join(into, path)), { recursive: true });
        await copyFile(from, join(into, path));
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
): Promise<{ worktree: Worktree; cwd: string; skipped: string[] }> {
    const root = await repositoryOf(cwd);

    if (root === undefined) {
        throw new HttpError(
            400,
            `${cwd} is not in a git repository, so it cannot have a worktree.`,
        );
    }

    // Where `cwd` is within the repository, as git sees it: `cwd` may be reached through a symbolic link, `root` not.
    const within = (await git(cwd, ["rev-parse", "--show-prefix"])).trim();

    if (
        !(await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
            () => true,
            () => false,
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
    const worktree: Worktree = { path: join(folder, name), branch: `pocket/${name}`, source: cwd };

    mkdirSync(folder, { recursive: true });
    await git(root, ["worktree", "add", "-b", worktree.branch, worktree.path, "HEAD"]);

    try {
        // Uncommitted changes to tracked files, as a commit object that changes nothing here; empty when there are none.
        const changes = (await git(root, ["stash", "create"])).trim();

        if (changes !== "") {
            await git(worktree.path, ["stash", "apply", changes]);
        }

        const skipped = await copyNewFiles(root, worktree.path);

        return { worktree, cwd: resolve(worktree.path, within), skipped };
    } catch (error) {
        await discardWorktree(worktree).catch(() => undefined);

        throw new HttpError(500, `The worktree could not be set up: ${describe(error)}`);
    }
}

/** Whether a folder is the worktree's or one inside it, also when reached through a symbolic link. */
export function inWorktree(worktree: Worktree, cwd: string): boolean {
    const real = (path: string) => {
        try {
            return realpathSync(path);
        } catch {
            return resolve(path);
        }
    };

    const base = real(worktree.path);
    const folder = real(cwd);

    return folder === base || folder.startsWith(base + sep);
}

/**
 * Where each folder of a worktree is in the folder it was made from: the same place in the repository, and the
 * session's folder as it was given. A folder that is only in the worktree maps to the session's folder.
 */
export async function sourceFolders(worktree: Worktree): Promise<(cwd: string) => string> {
    const root = await repositoryOf(worktree.source);
    let original: string | undefined;

    try {
        original = realpathSync(worktree.source);
    } catch {
        original = undefined;
    }

    return (cwd) => {
        if (root === undefined) {
            return worktree.source;
        }

        const mapped = resolve(root, relative(worktree.path, cwd));

        return mapped === original || !existsSync(mapped) ? worktree.source : mapped;
    };
}

/**
 * Remove a worktree's folder; its branch stays, with whatever was committed on it. One with uncommitted changes is
 * kept, unless `force`.
 */
export async function removeWorktree(worktree: Worktree, force: boolean): Promise<void> {
    if (!existsSync(worktree.path)) {
        return;
    }

    const root = await repositoryOf(worktree.source);

    if (root === undefined) {
        throw new HttpError(409, `${worktree.source} is not in a git repository anymore.`);
    }

    try {
        await git(root, ["worktree", "remove", ...(force ? ["--force"] : []), worktree.path]);
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
export async function discardWorktree(worktree: Worktree): Promise<void> {
    await removeWorktree(worktree, true);
    const root = await repositoryOf(worktree.source);

    if (root !== undefined) {
        await git(root, ["branch", "-D", worktree.branch]);
    }
}
