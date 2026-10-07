/**
 * What changed in a session's folder, to review on a phone: the files Pi wrote or edited in the session (read from
 * its tool calls, so nothing new is stored), and, when the folder is in a git repository, every uncommitted change
 * there, with each file's diff on request.
 */
import { realpathSync } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { type GitOptions, git as runGit } from "./git.ts";
import type { ClientEntry } from "./projection.ts";

/** How a file changed, as git sees it: `new` is a file git does not track yet. */
export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "new";

export type ChangedFile = {
    /** Relative to the repository's top folder. */
    path: string;
    kind: ChangeKind;
    /** Lines added and removed; absent for binary files and new ones. */
    added?: number;
    removed?: number;
    /** Pi wrote or edited it in this session. */
    byPi: boolean;
    /**
     * Changes whenever the file does (its size and modification time), so a browser knows its diff is new even when
     * the counts stay the same; absent for a file that is gone.
     */
    version?: string;
};

export type Changes = {
    /**
     * The repository the folder is in, absent when it is in none: its top folder, its branch, and `head`, the last
     * commit's id, which the diffs are against. Both are absent before the first commit.
     */
    repo?: { root: string; branch?: string; head?: string };
    files: ChangedFile[];
    /** Changed files left out of `files`, past the most it lists. */
    more: number;
    /** Files Pi wrote or edited that git shows no change for (committed since, or no repository), with Pi's last call. */
    piOnly: { path: string; entryId: number }[];
};

const MAX_FILES = 500;
const MAX_DIFF = 300_000;
const GIT_TIMEOUT_MS = 15_000;

/** Git for the Changes sheet: quick, with room for a long diff. */
const git = (cwd: string, args: string[], options: GitOptions = {}) =>
    runGit(cwd, args, { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF * 4, ...options });
/**
 * Diffs as the viewer reads them, whatever a person's git config says: no external diff program or text conversion, no
 * colors, git's usual `a/` and `b/` before the paths (`diff.mnemonicPrefix` and `diff.noprefix` change them), and
 * three unchanged lines around each change, so fewer after the last one say where the file ends (`web/diff.js`).
 */
const DIFF_FLAGS = [
    "-U3",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
];

const EDITORS = new Set(["write", "edit"]);
/** The codemode tool's name (`extensions/codemode.ts`): its results list the calls a script made. */
const CODEMODE = "codemode";

/** Resolve a possibly missing path through its nearest existing ancestor. */
function realpathWithMissingTail(path: string): string {
    const missing: string[] = [];
    let ancestor = path;

    while (true) {
        try {
            return resolve(realpathSync(ancestor), ...missing);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code !== "ENOENT" && code !== "ENOTDIR") {
                return path;
            }

            const parent = dirname(ancestor);

            if (parent === ancestor) {
                return path;
            }

            missing.unshift(basename(ancestor));
            ancestor = parent;
        }
    }
}

/** Resolve a recorded tool path lexically, canonicalizing it only for repository-backed sessions. */
function piEditPath(cwd: string, path: string, canonicalize: boolean): string {
    const absolute = resolve(cwd, path);

    if (!canonicalize) {
        return absolute;
    }

    return realpathWithMissingTail(absolute);
}

/**
 * The files Pi wrote or edited, by absolute path, with the newest of its replies that did: its own calls, and the
 * ones its codemode scripts made, which their results list.
 */
function piEdits(
    entries: readonly ClientEntry[],
    cwd: string,
    canonicalize = false,
): Map<string, number> {
    const edits = new Map<string, number>();
    /** The reply that made each tool call, by call id. */
    const callers = new Map<string, number>();

    for (const entry of entries) {
        if (entry.kind === "assistant") {
            for (const block of entry.blocks) {
                if (block.type !== "toolCall") {
                    continue;
                }

                callers.set(block.id, entry.id);
                const path = block.args.path;

                if (EDITORS.has(block.name) && typeof path === "string" && path !== "") {
                    edits.set(piEditPath(cwd, path, canonicalize), entry.id);
                }
            }
        } else if (entry.kind === "toolResult" && entry.name === CODEMODE) {
            const calls = (entry.details as { calls?: unknown } | undefined)?.calls;

            if (!Array.isArray(calls)) {
                continue;
            }

            for (const call of calls as { name?: unknown; status?: unknown; path?: unknown }[]) {
                if (
                    typeof call.name !== "string" ||
                    !EDITORS.has(call.name) ||
                    call.status !== "ok" ||
                    typeof call.path !== "string" ||
                    call.path === ""
                ) {
                    continue;
                }

                edits.set(
                    piEditPath(cwd, call.path, canonicalize),
                    callers.get(entry.callId) ?? entry.id,
                );
            }
        }
    }

    return edits;
}

function kindOf(code: string): ChangeKind {
    if (code === "??") {
        return "new";
    }

    if (code.includes("R")) {
        return "renamed";
    }

    if (code.includes("A")) {
        return "added";
    }

    if (code.includes("D")) {
        return "deleted";
    }

    return "modified";
}

/** `git status --porcelain=v1 -z`: each change, and the path a renamed or copied file had (`from`), in a field of its own. */
export function parseStatus(output: string): { code: string; path: string; from?: string }[] {
    const fields = output.split("\0");
    const changes: { code: string; path: string; from?: string }[] = [];

    for (let at = 0; at < fields.length; at++) {
        const field = fields[at]!;

        if (field.length < 4) {
            continue;
        }

        const code = field.slice(0, 2);
        const path = field.slice(3);

        if (code.includes("R") || code.includes("C")) {
            at++;
            changes.push({ code, path, from: fields[at] });
        } else {
            changes.push({ code, path });
        }
    }

    return changes;
}

/** `git diff --numstat -z`: lines added and removed per path; binary files have none. */
export function parseNumstat(output: string): Map<string, { added?: number; removed?: number }> {
    const fields = output.split("\0");
    const counts = new Map<string, { added?: number; removed?: number }>();

    for (let at = 0; at < fields.length; at++) {
        const [added = "", removed = "", path = ""] = fields[at]!.split("\t");

        if (added === "") {
            continue;
        }

        // A rename leaves the path empty and gives the old and the new one as the next two fields.
        const name = path === "" ? fields[(at += 2)] : path;

        if (name === undefined) {
            break;
        }

        counts.set(name, added === "-" ? {} : { added: Number(added), removed: Number(removed) });
    }

    return counts;
}

/** A file's size and modification time, one of which changes when it does; undefined when it is not there. */
async function versionOf(file: string): Promise<string | undefined> {
    try {
        const info = await lstat(file);

        return `${info.size}:${info.mtimeMs}`;
    } catch {
        return undefined;
    }
}

/** Where a folder is in its repository, as git writes paths: `app/` for the folder app, empty at the top. */
async function prefixOf(cwd: string): Promise<string> {
    return (await git(cwd, ["rev-parse", "--show-prefix"])).trim();
}

/**
 * The changes in a folder's repository, with the files Pi edited according to `entries`. `onlyHere` leaves out the
 * changes outside the folder: someone invited to one session sees its files only.
 */
export async function changesIn(
    cwd: string,
    entries: readonly ClientEntry[],
    onlyHere = false,
): Promise<Changes> {
    let root: string;

    try {
        root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    } catch {
        const edits = piEdits(entries, cwd);

        return {
            files: [],
            more: 0,
            piOnly: [...edits].map(([path, entryId]) => ({ path, entryId })),
        };
    }

    const edits = piEdits(entries, cwd, true);
    const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).then(
        (name) => name.trim(),
        () => undefined,
    );
    const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
        (id) => id.trim() || undefined,
        () => undefined,
    );
    const prefix = onlyHere ? await prefixOf(cwd) : "";
    const changed = parseStatus(
        await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ).filter(({ path }) => path.startsWith(prefix));
    const status = changed.slice(0, MAX_FILES);
    // Without a first commit there is nothing to compare with: every file is new.
    const counts =
        branch === undefined
            ? new Map()
            : parseNumstat(await git(root, ["diff", "HEAD", "--numstat", "-z", ...DIFF_FLAGS]));
    const versions = await Promise.all(status.map(({ path }) => versionOf(join(root, path))));
    const files = status.map(({ code, path }, index): ChangedFile => {
        const version = versions[index];

        return {
            path,
            kind: kindOf(code),
            ...counts.get(path),
            byPi: edits.has(join(root, path)),
            ...(version === undefined ? {} : { version }),
        };
    });
    const shown = new Set(files.map((file) => join(root, file.path)));
    const piOnly = [...edits]
        .filter(([path]) => !shown.has(path))
        .map(([path, entryId]) => ({ path: relative(root, path), entryId }));

    return {
        repo: {
            root,
            ...(branch === undefined ? {} : { branch }),
            ...(head === undefined ? {} : { head }),
        },
        files,
        more: changed.length - status.length,
        piOnly,
    };
}

/**
 * The diff of one changed file of the repository `cwd` is in, against the last commit; a new file's whole content.
 * Only files that git lists as changed: the path cannot point anywhere else. With `onlyHere`, only files in `cwd`.
 */
export async function diffOf(cwd: string, path: string, onlyHere = false): Promise<string> {
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const change = parseStatus(
        await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ).find((each) => each.path === path);

    // A file outside the folder is as unknown as one without changes.
    if (change === undefined || (onlyHere && !path.startsWith(await prefixOf(cwd)))) {
        throw new Error("That file has no uncommitted changes");
    }

    const hasHead = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
        () => true,
        () => false,
    );
    // `--no-index` exits with 1 when the files differ, which is the point. A renamed file is both its paths: given
    // both, git shows what changed in it, not a whole new file.
    const paths = change.from === undefined ? [path] : [change.from, path];
    const diff =
        change.code === "??" || !hasHead
            ? await git(root, ["diff", "--no-index", ...DIFF_FLAGS, "--", devNull, path], {
                  allowExit: [1],
              })
            : await git(root, ["diff", "HEAD", "-M", ...DIFF_FLAGS, "--", ...paths]);

    return diff.length > MAX_DIFF
        ? `${diff.slice(0, MAX_DIFF)}\n… the rest of the diff is left out …\n`
        : diff;
}

/**
 * Put one changed file back as the last commit has it: edits undone, a deleted file back, a new file gone. As with
 * `diffOf`, only a file git lists as changed, so the path cannot point anywhere else; with `onlyHere`, only one in
 * `cwd`. A renamed file is left alone, as undoing it changes two paths.
 */
export async function revertFile(cwd: string, path: string, onlyHere = false): Promise<ChangeKind> {
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const change = parseStatus(
        await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ).find((each) => each.path === path);

    if (change === undefined || (onlyHere && !path.startsWith(await prefixOf(cwd)))) {
        throw new Error("That file has no uncommitted changes");
    }

    // Unmerged (a conflict): both sides matter, and git is the place to choose.
    if (change.code.includes("U") || change.code === "AA" || change.code === "DD") {
        throw new Error("This file has a merge conflict: resolve it with git.");
    }

    const kind = kindOf(change.code);

    if (kind === "renamed") {
        throw new Error("A renamed file changes two paths: undo it with git.");
    }

    if (kind === "new") {
        await rm(join(root, path), { force: true });

        return kind;
    }

    const hasHead = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
        () => true,
        () => false,
    );
    const inHead =
        hasHead &&
        (await git(root, ["cat-file", "-e", `HEAD:${path}`]).then(
            () => true,
            () => false,
        ));

    if (kind === "added" && !inHead) {
        // Added since the last commit: out of the index, then gone.
        await git(root, ["rm", "--cached", "--quiet", "--force", "--", path]);
        await rm(join(root, path), { force: true });

        return kind;
    }

    if (!hasHead) {
        await git(root, ["rm", "--cached", "--quiet", "--force", "--", path]);
        await rm(join(root, path), { force: true });

        return kind;
    }

    await git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", path]);

    return kind;
}
