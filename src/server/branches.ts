/**
 * A session's git branch: the one its folder has checked out, read from the repository's HEAD file so a view can show
 * it on every update, and the branches it could switch to, for the branch sheet. Switching is `git switch`: changes
 * not yet committed go along to the other branch, and git refuses when the switch would overwrite them.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseStatus } from "./changes.ts";
import { type FolderAccess, localAccess } from "./folder-access.ts";
import { GitError } from "./git.ts";

/** What a folder has checked out: a branch (one with no commits yet included), or a commit with no branch. */
export type Head = { branch: string } | { detached: string };

export type LocalBranch = {
    name: string;
    current: boolean;
    /** When its last commit was made, in milliseconds; absent for a branch with no commits yet. */
    at?: number;
    subject?: string;
    /** The remote branch it follows: how far ahead and behind it is, or `gone` when the remote branch was deleted. */
    upstream?: { name: string; ahead: number; behind: number; gone: boolean };
    /** The folder of another worktree that has it checked out: git switches to it only there. */
    worktree?: string;
};

export type RemoteBranch = { name: string; at: number; subject: string };

export type Branches = {
    head: Head | undefined;
    /** Newest first, at most `MAX_BRANCHES`. */
    local: LocalBranch[];
    /** Remote branches with no local branch of their name: switching to one makes a local branch that follows it. */
    remote: RemoteBranch[];
    /** Branches left out of the lists, past the most each shows. */
    more: number;
    /** Files with changes not yet committed, which go along to the branch switched to. */
    changed: number;
};

/** What `branchesIn` reads of each ref. */
const FIELDS = [
    "%(refname)",
    "%(committerdate:unix)",
    "%(subject)",
    "%(upstream:short)",
    "%(upstream:track,nobracket)",
    "%(worktreepath)",
];

/** The most branches each list has, newest first: the picker searches what it has. */
const MAX_BRANCHES = 1000;
const GIT_TIMEOUT_MS = 15_000;
const gitIn = (access: FolderAccess) => (cwd: string, args: string[]) =>
    access.git(cwd, args, { timeoutMs: GIT_TIMEOUT_MS });

/**
 * Where a folder's repository keeps its files: `.git` in it or a folder above, or where a worktree's `.git` file says.
 * Never throws: views ask on every update, and a folder that cannot be read (no permission, a link in a loop, a lost
 * mount) is in no repository as far as they can tell.
 */
export function gitDirOf(cwd: string): string | undefined {
    for (let folder = cwd; ; folder = dirname(folder)) {
        const dotGit = join(folder, ".git");

        try {
            const found = statSync(dotGit, { throwIfNoEntry: false });

            if (found?.isDirectory()) {
                return dotGit;
            }

            if (found?.isFile()) {
                const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"));

                return pointer ? resolve(folder, pointer[1]!.trim()) : undefined;
            }
        } catch {
            return undefined;
        }

        if (dirname(folder) === folder) {
            return undefined;
        }
    }
}

/** What a repository has checked out, from its HEAD file, without running git. */
export function headOf(gitDir: string): Head | undefined {
    let head: string;

    try {
        head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    } catch {
        return undefined;
    }

    const ref = /^ref: refs\/heads\/(.+)$/.exec(head);

    if (ref) {
        return { branch: ref[1]! };
    }

    return /^[0-9a-f]{40,64}$/.test(head) ? { detached: head.slice(0, 7) } : undefined;
}

/**
 * What a folder has checked out, asked of git: for a folder on another computer, whose HEAD file is not here to read.
 * One command, and a second only for a commit with no branch. Undefined in no repository; throws when the computer
 * cannot be reached.
 */
export async function headIn(
    cwd: string,
    access: FolderAccess,
    timeoutMs = GIT_TIMEOUT_MS,
): Promise<Head | undefined> {
    let branch: string;

    try {
        // The branch, also one with no commits yet; nothing (exit 1) when no branch is checked out.
        branch = (
            await access.git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
                allowExit: [1],
                timeoutMs,
            })
        ).trim();
    } catch (error) {
        if (error instanceof GitError) {
            return undefined;
        }

        throw error;
    }

    if (branch !== "") {
        return { branch };
    }

    const commit = await access
        .git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], { timeoutMs })
        .then(
            (id) => id.trim(),
            (error: unknown) => {
                if (error instanceof GitError) {
                    return "";
                }

                throw error;
            },
        );

    return /^[0-9a-f]{40,64}$/.test(commit) ? { detached: commit.slice(0, 7) } : undefined;
}

/** `%(upstream:track,nobracket)`: "ahead 2, behind 1", "gone", or nothing when it is even. */
function readTrack(track: string): { ahead: number; behind: number; gone: boolean } {
    return {
        ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
        gone: track === "gone",
    };
}

/** The branches of the repository `cwd` is in, for the branch sheet, on the machine `access` reaches. */
export async function branchesIn(
    cwd: string,
    access: FolderAccess = localAccess,
): Promise<Branches> {
    const git = gitIn(access);
    // Here the HEAD file is read; elsewhere git says, along with the rest.
    const here = access.id === localAccess.id;
    const gitDir = here ? gitDirOf(cwd) : undefined;
    const [head, refs, status] = await Promise.all([
        here ? (gitDir === undefined ? undefined : headOf(gitDir)) : headIn(cwd, access),
        git(cwd, [
            "for-each-ref",
            "--sort=-committerdate",
            // Every field ends in NUL, so a newline in one (a worktree's folder can have one) is just text.
            `--format=${FIELDS.join("%00")}%00`,
            "refs/heads",
            "refs/remotes",
        ]),
        git(cwd, ["status", "--porcelain=v1", "-z"]),
    ]);
    const checkedOut = head !== undefined && "branch" in head ? head.branch : undefined;
    const fields = FIELDS;
    const local: LocalBranch[] = [];
    const remote: RemoteBranch[] = [];

    const values = refs.split("\0");

    for (let index = 0; index + fields.length <= values.length; index += fields.length) {
        const [first = "", at = "", subject = "", upstream = "", track = "", worktree = ""] =
            values.slice(index, index + fields.length);
        // Git ends each ref's line with a newline, which starts the next one's first field.
        const ref = first.replace(/^\n/, "");

        if (ref.startsWith("refs/heads/")) {
            const name = ref.slice("refs/heads/".length);
            const current = name === checkedOut;

            local.push({
                name,
                current,
                at: Number(at) * 1000,
                subject,
                ...(upstream === "" ? {} : { upstream: { name: upstream, ...readTrack(track) } }),
                // Checked out in another worktree, as this folder's own branch is in this one.
                ...(worktree === "" || current ? {} : { worktree }),
            });
        } else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) {
            remote.push({
                name: ref.slice("refs/remotes/".length),
                at: Number(at) * 1000,
                subject,
            });
        }
    }

    // A branch with no commits yet has no ref to list.
    if (checkedOut !== undefined && !local.some((branch) => branch.current)) {
        local.unshift({ name: checkedOut, current: true });
    }

    // A remote branch that a local one follows, or shares its name with, is that branch.
    const known = new Set(local.flatMap((branch) => [branch.name, branch.upstream?.name]));
    const others = remote.filter(
        (branch) => !known.has(branch.name) && !known.has(localName(branch.name)),
    );

    return {
        head,
        local: local.slice(0, MAX_BRANCHES),
        remote: others.slice(0, MAX_BRANCHES),
        more: Math.max(0, local.length - MAX_BRANCHES) + Math.max(0, others.length - MAX_BRANCHES),
        changed: parseStatus(status).length,
    };
}

/** The local name for a remote branch: `origin/fix/login` is `fix/login`. */
export const localName = (remote: string) => remote.slice(remote.indexOf("/") + 1);

/** Whether a git command succeeds: false when git says no, and an error when the computer cannot be reached. */
const succeeds = (cwd: string, args: string[], access: FolderAccess): Promise<boolean> =>
    gitIn(access)(cwd, args).then(
        () => true,
        (error: unknown) => {
            if (error instanceof GitError) {
                return false;
            }

            throw error;
        },
    );

/** Whether git takes a name for a branch: no spaces, no `..`, not starting with `-`, and the rest of git's rules. */
export async function validBranchName(
    cwd: string,
    name: string,
    access: FolderAccess = localAccess,
): Promise<boolean> {
    if (name === "" || name.startsWith("-")) {
        return false;
    }

    return succeeds(cwd, ["check-ref-format", "--branch", name], access);
}

/** Whether `name` (such as `origin/fix`) is one of the repository's remote branches. */
export async function isRemoteBranch(
    cwd: string,
    name: string,
    access: FolderAccess = localAccess,
): Promise<boolean> {
    if (name === "" || name.startsWith("-")) {
        return false;
    }

    return succeeds(
        cwd,
        ["rev-parse", "--verify", "--quiet", `refs/remotes/${name}^{commit}`],
        access,
    );
}

/**
 * Switch the folder `cwd` to a branch: one there already, a new one made from what is checked out (`create`), or a
 * new one following a remote branch (`track`, such as `origin/fix`, which `isRemoteBranch` has checked). Git's own
 * words say why it could not.
 */
export async function switchBranch(
    cwd: string,
    target: { name: string; create?: boolean; track?: string },
    access: FolderAccess = localAccess,
): Promise<void> {
    const args =
        target.track !== undefined
            ? // As a whole ref the remote branch cannot be taken for an option.
              ["switch", "--create", target.name, "--track", `refs/remotes/${target.track}`]
            : target.create === true
              ? ["switch", "--create", target.name]
              : ["switch", "--no-guess", target.name];

    try {
        await gitIn(access)(cwd, args);
    } catch (error) {
        if (!(error instanceof GitError)) {
            throw error;
        }

        throw new GitError(
            error instanceof Error ? cleanMessage(error.message) : String(error),
            error instanceof GitError ? error.exitCode : undefined,
        );
    }
}

/** Git's message without its hints and its closing "Aborting": what went wrong, and the files it names. */
function cleanMessage(message: string): string {
    return message
        .split("\n")
        .filter((line) => !/^(hint:|Aborting$)/.test(line.trim()))
        .map((line) => line.replace(/^(error|fatal): /, ""))
        .join("\n")
        .trim();
}
