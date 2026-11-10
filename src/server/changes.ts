/**
 * What changed in a session's folder, to review on a phone: the files Pi wrote or edited in the session (read from
 * its tool calls, so nothing new is stored), and, when the folder is in a git repository, every uncommitted change
 * there, with each file's diff on request.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { type FolderAccess, localAccess, Unreachable } from "./folder-access.ts";
import type { GitOptions } from "./git.ts";
import type { ClientEntry } from "./projection.ts";

/** How a file changed, as git sees it: `new` is a file git does not track yet. */
export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "new";

export type ChangedFile = {
    /** Relative to the repository's top folder. */
    path: string;
    kind: ChangeKind;
    /** Lines added and removed; absent for binary files or when a count could not be read. */
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
/** Untracked files are counted again on every look, so a larger one keeps its count unknown. */
const MAX_COUNTED_BYTES = 2_000_000;
/** How many untracked files are counted at once. */
const COUNTS_AT_ONCE = 8;
const GIT_TIMEOUT_MS = 15_000;

/** Git for Changes, in the folder's machine: quick, with room for a long diff. */
const gitIn =
    (access: FolderAccess) =>
    (cwd: string, args: string[], options: GitOptions = {}): Promise<string> =>
        access.git(cwd, args, { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF * 4, ...options });
/**
 * Diffs as the viewer reads them, whatever a person's git config says: no external diff program or text conversion, no
 * colors, and git's usual `a/` and `b/` before the paths (`diff.mnemonicPrefix` and `diff.noprefix` change them).
 * Patch requests also ask for three context lines (`web/diff.js`); counts must not request patch output.
 */
const DIFF_FLAGS = [
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

/** Where a recorded path is, as it is written: the lexical path, unchanged. */
const asWritten = (path: string) => path;

/**
 * The files Pi wrote or edited, by absolute path, with the newest of its replies that did: its own calls that did not
 * fail, and the ones its codemode scripts made, which their results list. Each recorded path is resolved lexically in
 * `cwd` with the folder's path rules (`paths`), then put through `place`: for a repository, where it really is.
 */
function piEdits(
    entries: readonly ClientEntry[],
    cwd: string,
    place: (absolute: string) => string = asWritten,
    paths: FolderAccess["path"] = localAccess.path,
): Map<string, number> {
    const piEditPath = (path: string) => place(paths.resolve(cwd, path));
    const edits = new Map<string, number>();
    /** The reply that made each tool call, by call id. */
    const callers = new Map<string, number>();
    /** Calls whose results are errors: an edit that could not find its text changed nothing. */
    const failed = new Set(
        entries.flatMap((entry) =>
            entry.kind === "toolResult" && entry.isError ? [entry.callId] : [],
        ),
    );

    for (const entry of entries) {
        if (entry.kind === "assistant") {
            for (const block of entry.blocks) {
                if (block.type !== "toolCall") {
                    continue;
                }

                callers.set(block.id, entry.id);
                const path = block.args.path;

                if (
                    EDITORS.has(block.name) &&
                    !failed.has(block.id) &&
                    typeof path === "string" &&
                    path !== ""
                ) {
                    edits.set(piEditPath(path), entry.id);
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

                edits.set(piEditPath(call.path), callers.get(entry.callId) ?? entry.id);
            }
        }
    }

    return edits;
}

/**
 * The part of an entry that `piEdits` reads, or nothing when it reads none: what a session keeps of its history between
 * looks (`workspace.ts`), so each look reads only the entries added since.
 */
export function editFacts(entry: ClientEntry): ClientEntry | undefined {
    if (entry.kind === "assistant") {
        const blocks = entry.blocks.flatMap((block) =>
            block.type === "toolCall" && (EDITORS.has(block.name) || block.name === CODEMODE)
                ? [{ ...block, args: { path: block.args.path } }]
                : [],
        );

        return blocks.length === 0 ? undefined : { id: entry.id, kind: "assistant", blocks };
    }

    if (entry.kind === "toolResult" && (entry.isError || entry.name === CODEMODE)) {
        const { id, kind, callId, name, isError } = entry;
        const calls = (entry.details as { calls?: unknown } | undefined)?.calls;
        const details = Array.isArray(calls)
            ? {
                  calls: (calls as unknown[]).flatMap((call) => {
                      if (typeof call !== "object" || call === null) {
                          return [];
                      }

                      const { name, status, path } = call as Record<string, unknown>;

                      return [{ name, status, path }];
                  }),
              }
            : undefined;

        return { id, kind, callId, name, isError, text: "", details };
    }

    return undefined;
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
        const [added = "", removed = "", ...parts] = fields[at]!.split("\t");
        const path = parts.join("\t");

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
async function versionOf(
    access: FolderAccess,
    file: string,
): Promise<{ version: string; size: number } | undefined> {
    try {
        const info = await access.info(file);

        return { version: `${info.size}:${info.mtimeMs}`, size: info.size };
    } catch {
        return undefined;
    }
}

/**
 * The repository a folder is in: its top folder, as git writes it, and where the folder is in it, as git writes paths
 * (`app/` for the folder app, empty at the top). One git command, as each costs a round trip to another computer.
 */
async function repoOf(
    access: FolderAccess,
    cwd: string,
): Promise<{ root: string; prefix: string }> {
    const [root = "", prefix = ""] = (
        await gitIn(access)(cwd, ["rev-parse", "--show-toplevel", "--show-prefix"])
    ).split("\n");

    return { root: root.trim(), prefix: prefix.trim() };
}

/** Whether the repository has a commit checked out. */
const hasHeadIn = (access: FolderAccess, cwd: string): Promise<boolean> =>
    gitIn(access)(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
        () => true,
        () => false,
    );

/** Resolve a possibly missing path through its nearest existing ancestor, on the folder's machine. */
async function realpathOn(access: FolderAccess, path: string): Promise<string> {
    const paths = access.path;
    const missing: string[] = [];
    let ancestor = path;

    while (true) {
        try {
            return paths.resolve(await access.realpath(ancestor), ...missing);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code !== "ENOENT" && code !== "ENOTDIR") {
                return path;
            }

            const parent = paths.dirname(ancestor);

            if (parent === ancestor) {
                return path;
            }

            missing.unshift(paths.basename(ancestor));
            ancestor = parent;
        }
    }
}

/**
 * The files Pi edited, by where they really are in the repository: here as before, through this machine's disk; on
 * another computer through its daemon, all at once, keeping each file's newest reply.
 */
async function piEditsInRepo(
    access: FolderAccess,
    entries: readonly ClientEntry[],
    cwd: string,
): Promise<Map<string, number>> {
    if (access.id === localAccess.id) {
        return piEdits(entries, cwd, realpathWithMissingTail);
    }

    const written = piEdits(entries, cwd, asWritten, access.path);
    const placed = await Promise.all(
        [...written].map(async ([path, entryId]) => [await realpathOn(access, path), entryId]),
    );
    const edits = new Map<string, number>();

    for (const [path, entryId] of placed as [string, number][]) {
        edits.set(path, Math.max(entryId, edits.get(path) ?? 0));
    }

    return edits;
}

/** Each change git lists in a repository, as `parseStatus` reads them. */
const statusOf = async (access: FolderAccess, cwd: string) =>
    parseStatus(
        await gitIn(access)(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    );

/**
 * The changes in a folder's repository, with the files Pi edited according to `entries`. `onlyHere` leaves out the
 * changes outside the folder: someone invited to one session sees its files only. `access` is how the folder's
 * machine is reached: this one, or the computer a session runs on.
 */
export async function changesIn(
    cwd: string,
    entries: readonly ClientEntry[],
    onlyHere = false,
    access: FolderAccess = localAccess,
): Promise<Changes> {
    const git = gitIn(access);
    const paths = access.path;
    let repo: { root: string; prefix: string };

    try {
        repo = await repoOf(access, cwd);
    } catch (error) {
        // Another computer that is offline is not a folder without a repository.
        if (error instanceof Unreachable) {
            throw error;
        }

        const edits = piEdits(entries, cwd, asWritten, paths);

        return {
            files: [],
            more: 0,
            piOnly: [...edits].map(([path, entryId]) => ({ path, entryId })),
        };
    }

    const { root } = repo;
    const prefix = onlyHere ? repo.prefix : "";
    // Each is a round trip to another computer: they go together. Status and porcelain paths are the repository's,
    // wherever in it git runs.
    const [edits, branch, head, status, numstat] = await Promise.all([
        piEditsInRepo(access, entries, cwd),
        git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).then(
            (name) => name.trim(),
            () => undefined,
        ),
        git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
            (id) => id.trim() || undefined,
            () => undefined,
        ),
        statusOf(access, root),
        // Without a first commit this fails, and there is nothing to compare with: every file is new.
        git(root, ["diff", "HEAD", "--numstat", "-z", ...DIFF_FLAGS]).then(
            (output) => ({ output }),
            (error: unknown) => ({ error }),
        ),
    ]);
    const changed = status.filter(({ path }) => path.startsWith(prefix));
    const listed = changed.slice(0, MAX_FILES);
    let counts: Map<string, { added?: number; removed?: number }>;

    if (head === undefined) {
        counts = new Map();
    } else if ("output" in numstat) {
        counts = parseNumstat(numstat.output);
    } else {
        throw numstat.error;
    }

    // Each file's size and time, which also says which new files are small enough to count.
    const versions = await Promise.all(
        listed.map(({ path }) => versionOf(access, paths.join(root, path))),
    );

    // HEAD diffs omit untracked files. Count only the visible, permitted files; Git keeps binary, attributes,
    // symlinks and final-newline handling the same as each file's diff. No index or files are changed.
    const count = async (path: string, size: number | undefined) => {
        if (size === undefined || size > MAX_COUNTED_BYTES) {
            return;
        }

        try {
            const added = parseNumstat(
                await git(
                    root,
                    [
                        "diff",
                        "--no-index",
                        "--numstat",
                        "-z",
                        ...DIFF_FLAGS,
                        "--",
                        access.devNull,
                        path,
                    ],
                    {
                        allowExit: [1],
                    },
                ),
            ).get(path);

            if (added !== undefined) {
                counts.set(path, added);
            }
        } catch {
            // A file can disappear or become unreadable after status. Keep the list, with its count unknown.
        }
    };

    const uncounted = listed.flatMap(({ code, path }, index) =>
        code === "??" || head === undefined ? [{ path, size: versions[index]?.size }] : [],
    );
    let next = 0;

    // Another computer is far: more at once there, where each count waits mostly on the link.
    await Promise.all(
        Array.from(
            { length: access.id === localAccess.id ? COUNTS_AT_ONCE : COUNTS_AT_ONCE * 4 },
            async () => {
                while (next < uncounted.length) {
                    const { path, size } = uncounted[next++]!;

                    await count(path, size);
                }
            },
        ),
    );

    const files = listed.map(({ code, path }, index): ChangedFile => {
        const version = versions[index]?.version;

        return {
            path,
            kind: kindOf(code),
            ...counts.get(path),
            byPi: edits.has(paths.join(root, path)),
            ...(version === undefined ? {} : { version }),
        };
    });
    const shown = new Set(files.map((file) => paths.join(root, file.path)));
    const piOnly = [...edits]
        .filter(([path]) => !shown.has(path))
        .map(([path, entryId]) => ({ path: paths.relative(root, path), entryId }));

    return {
        repo: {
            root,
            ...(branch === undefined ? {} : { branch }),
            ...(head === undefined ? {} : { head }),
        },
        files,
        more: changed.length - listed.length,
        piOnly,
    };
}

/**
 * One changed file of the repository `cwd` is in, with what else is needed to show or undo it, in one round trip:
 * the repository, the change, and whether there is a commit. A file without changes, or outside the folder with
 * `onlyHere`, is as unknown as any: the path cannot point anywhere else.
 */
async function changeOf(access: FolderAccess, cwd: string, path: string, onlyHere: boolean) {
    const [repo, status, hasHead] = await Promise.allSettled([
        repoOf(access, cwd),
        statusOf(access, cwd),
        hasHeadIn(access, cwd),
    ]);

    if (repo.status === "rejected") {
        throw repo.reason;
    }

    if (status.status === "rejected") {
        throw status.reason;
    }

    const change = status.value.find((each) => each.path === path);

    // A file outside the folder is as unknown as one without changes.
    if (change === undefined || (onlyHere && !path.startsWith(repo.value.prefix))) {
        throw new Error("That file has no uncommitted changes");
    }

    return {
        root: repo.value.root,
        change,
        hasHead: hasHead.status === "fulfilled" && hasHead.value,
    };
}

/**
 * The diff of one changed file of the repository `cwd` is in, against the last commit; a new file's whole content.
 * Only files that git lists as changed: the path cannot point anywhere else. With `onlyHere`, only files in `cwd`.
 */
export async function diffOf(
    cwd: string,
    path: string,
    onlyHere = false,
    access: FolderAccess = localAccess,
): Promise<string> {
    const git = gitIn(access);
    const { root, change, hasHead } = await changeOf(access, cwd, path, onlyHere);
    // `--no-index` exits with 1 when the files differ, which is the point. A renamed file is both its paths: given
    // both, git shows what changed in it, not a whole new file.
    const paths = change.from === undefined ? [path] : [change.from, path];
    const diff =
        change.code === "??" || !hasHead
            ? await git(
                  root,
                  ["diff", "--no-index", "-U3", ...DIFF_FLAGS, "--", access.devNull, path],
                  {
                      allowExit: [1],
                  },
              )
            : await git(root, ["diff", "HEAD", "-M", "-U3", ...DIFF_FLAGS, "--", ...paths]);

    return diff.length > MAX_DIFF
        ? `${diff.slice(0, MAX_DIFF)}\n… the rest of the diff is left out …\n`
        : diff;
}

/**
 * Put one changed file back as the last commit has it: edits undone, a deleted file back, a new file gone. As with
 * `diffOf`, only a file git lists as changed, so the path cannot point anywhere else; with `onlyHere`, only one in
 * `cwd`. A renamed file is left alone, as undoing it changes two paths.
 */
export async function revertFile(
    cwd: string,
    path: string,
    onlyHere = false,
    access: FolderAccess = localAccess,
): Promise<ChangeKind> {
    const git = gitIn(access);
    const { root, change, hasHead } = await changeOf(access, cwd, path, onlyHere);
    const file = access.path.join(root, path);

    // Unmerged (a conflict): both sides matter, and git is the place to choose.
    if (change.code.includes("U") || change.code === "AA" || change.code === "DD") {
        throw new Error("This file has a merge conflict: resolve it with git.");
    }

    const kind = kindOf(change.code);

    if (kind === "renamed") {
        throw new Error("A renamed file changes two paths: undo it with git.");
    }

    if (kind === "new") {
        await access.remove(file);

        return kind;
    }

    const inHead =
        hasHead &&
        (await git(root, ["cat-file", "-e", `HEAD:${path}`]).then(
            () => true,
            () => false,
        ));

    if ((kind === "added" && !inHead) || !hasHead) {
        // Added since the last commit (or there is no commit): out of the index, then gone.
        await git(root, ["rm", "--cached", "--quiet", "--force", "--", path]);
        await access.remove(file);

        return kind;
    }

    await git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", path]);

    return kind;
}
