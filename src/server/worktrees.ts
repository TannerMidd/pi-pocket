/**
 * A session can work in a git worktree of its own: a checkout of the same repository, on a branch of its own, in
 * Pi Pocket's data folder. Its changes stay apart from the folder it came from and from other sessions, and a fork in
 * a worktree tries another approach without touching the first. A worktree starts with the folder's files as they
 * are: the last commit, uncommitted changes, and new files. Ignored files, such as node_modules, are not copied.
 */
import { randomUUID } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { describe, HttpError } from "./errors.ts";
import { git, GitError } from "./git.ts";
import {
    copyFileAsync,
    type FolderRef,
    type Hostfs,
    lstatAsync,
    mkdir,
    mkdirAsync,
    own,
} from "./hostfs.ts";
import { workspaceScheme } from "./paths.ts";

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
async function repositoryOf(folder: FolderRef): Promise<string | undefined> {
    return git(folder, ["rev-parse", "--show-toplevel"]).then(
        (root) => root.trim(),
        () => undefined,
    );
}

/** Copy the repository's new (untracked, not ignored) files into the worktree. Returns the ones left out for size. */
async function copyNewFiles(root: FolderRef, into: FolderRef): Promise<string[]> {
    const skipped: string[] = [];
    let copied = 0;

    for (const path of (
        await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    ).split("\0")) {
        if (path === "") {
            continue;
        }

        // Each file is read from the folder's own descriptor, so a link the guest swapped in is not followed.
        const from = root.at(path);
        const stats = await lstatAsync(from).catch(() => undefined);

        if (stats === undefined || !stats.isFile()) {
            continue;
        }

        if (copied + stats.size > MAX_COPIED_BYTES) {
            skipped.push(path);
            continue;
        }

        const target = into.at(path);

        await mkdirAsync(target.parent()!, { recursive: true });
        await copyFileAsync(from, target);
        copied += stats.size;
    }

    return skipped;
}

/**
 * Make a worktree for a session that works in `cwd`, under `folder`, named after `label`. Returns it, the folder
 * inside it that matches `cwd`, and the new files too big to copy.
 */
export async function createWorktree(
    host: Hostfs,
    cwd: string,
    folder: string,
    label: string,
    guard?: { root(): void; created(tree: Worktree): void; check(tree: Worktree): void },
): Promise<{ worktree: Worktree; cwd: string; skipped: string[] }> {
    if (workspaceScheme(cwd) !== undefined) {
        throw new HttpError(400, "Remote workspaces do not support worktrees.");
    }

    const here = host.folder(cwd);
    const top = await repositoryOf(here);

    if (top === undefined) {
        throw new HttpError(
            400,
            `${cwd} is not in a git repository, so it cannot have a worktree.`,
        );
    }

    // Where `cwd` is within the repository, as git sees it: `cwd` may be reached through a symbolic link, `root` not.
    const root = host.folder(top);
    const within = (await git(here, ["rev-parse", "--show-prefix"])).trim();

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

    if (guard === undefined) {
        mkdir(own(folder), { recursive: true });
    } else {
        guard.root();
    }

    await git(root, ["worktree", "add", "-b", worktree.branch, worktree.path, "HEAD"]);
    guard?.created(worktree);

    try {
        // Uncommitted changes to tracked files, as a commit object that changes nothing here; empty when there are none.
        const changes = (await git(root, ["stash", "create"])).trim();

        if (changes !== "") {
            await git(host.folder(worktree.path), ["stash", "apply", changes]);
        }

        const skipped = await copyNewFiles(root, host.folder(worktree.path));

        return { worktree, cwd: resolve(worktree.path, within), skipped };
    } catch (error) {
        await discardWorktree(host, worktree, () => guard?.check(worktree)).catch(() => undefined);

        throw new HttpError(500, `The worktree could not be set up: ${describe(error)}`);
    }
}

/**
 * A path as the system has it: links resolved, and on Windows the long name of each part with its case on disk, so
 * that `C:\Users\RUNNER~1` and `C:\Users\runneradmin` (or a path git gives with `/`) compare equal. The path itself
 * when it does not exist.
 */
function real(host: Hostfs, path: string): string {
    return host.real(path, { native: true }) ?? resolve(path);
}

/** Whether a folder is the worktree's or one inside it, also when reached through a symbolic link. */
export function inWorktree(host: Hostfs, worktree: Worktree, cwd: string): boolean {
    const base = real(host, worktree.path);
    const folder = real(host, cwd);

    return folder === base || folder.startsWith(base + sep);
}

/**
 * Where each folder of a worktree is in the folder it was made from: the same place in the repository, and the
 * session's folder as it was given. A folder that is only in the worktree maps to the session's folder.
 */
export async function sourceFolders(
    host: Hostfs,
    worktree: Worktree,
): Promise<(cwd: string) => string> {
    const root = await repositoryOf(host.folder(worktree.source));
    const original = host.has(worktree.source) ? real(host, worktree.source) : undefined;

    return (cwd) => {
        if (root === undefined) {
            return worktree.source;
        }

        const mapped = resolve(root, relative(real(host, worktree.path), real(host, cwd)));

        return !host.has(mapped) || real(host, mapped) === original ? worktree.source : mapped;
    };
}

/**
 * Remove a worktree's folder; its branch stays, with whatever was committed on it. One with uncommitted changes is
 * kept, unless `force`.
 */
export async function removeWorktree(
    host: Hostfs,
    worktree: Worktree,
    force: boolean,
    check?: () => void,
): Promise<void> {
    check?.();

    if (!host.has(worktree.path)) {
        return;
    }

    const top = await repositoryOf(host.folder(worktree.source));

    if (top === undefined) {
        throw new HttpError(409, `${worktree.source} is not in a git repository anymore.`);
    }

    check?.();

    try {
        await git(host.folder(top), [
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
    host: Hostfs,
    worktree: Worktree,
    check?: () => void,
): Promise<void> {
    await removeWorktree(host, worktree, true, check);
    const root = await repositoryOf(host.folder(worktree.source));

    if (root !== undefined) {
        await git(host.folder(root), ["branch", "-D", worktree.branch]);
    }
}
