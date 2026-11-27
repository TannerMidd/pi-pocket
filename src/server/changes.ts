/**
 * What changed in a session's folder, to review on a phone: the files Pi wrote or edited in the session (read from
 * its tool calls, so nothing new is stored), and, when the folder is in a git repository, every uncommitted change
 * there, with each file's diff on request.
 */
import { devNull } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { type GitOptions, git as runGit, gitOwn } from "./git.ts";
import {
    type FolderRef,
    type Hostfs,
    lstat,
    lstatAsync,
    makeTemporaryFolder,
    mkdir,
    own,
    type Place,
    readFile,
    readlink,
    rm,
    symlink,
    writeFile,
    realpath,
    rmAsync,
} from "./hostfs.ts";
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

/** Git for Changes: quick, with room for a long diff. */
const git = (folder: FolderRef, args: string[], options: GitOptions = {}) =>
    runGit(folder, args, { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF * 4, ...options });
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
function realpathWithMissingTail(host: Hostfs, path: string): string {
    const missing: string[] = [];
    let ancestor = path;

    while (true) {
        try {
            return resolve(realpath(host.at(ancestor)), ...missing);
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
function piEditPath(folder: FolderRef, path: string, canonicalize: boolean): string {
    const absolute = resolve(folder.display.text, path);

    if (!canonicalize) {
        return absolute;
    }

    return realpathWithMissingTail(folder.host, absolute);
}

/**
 * The files Pi wrote or edited, by absolute path, with the newest of its replies that did: its own calls that did not
 * fail, and the ones its codemode scripts made, which their results list.
 */
function piEdits(
    entries: readonly ClientEntry[],
    folder: FolderRef,
    canonicalize = false,
): Map<string, number> {
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
                    edits.set(piEditPath(folder, path, canonicalize), entry.id);
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
                    piEditPath(folder, call.path, canonicalize),
                    callers.get(entry.callId) ?? entry.id,
                );
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
async function versionOf(file: Place): Promise<string | undefined> {
    try {
        const info = await lstatAsync(file);

        return `${info.size}:${info.mtimeMs}`;
    } catch {
        return undefined;
    }
}

/**
 * `git diff --no-index` of a new file against nothing. In a plain folder git reads the work tree, as it always did. In a
 * sandboxed folder git never reads it: it follows a link that the guest puts in the middle of the path, which no flag
 * stops. The file is read through `hostfs` (no link followed, at most `limit` bytes) into a private scratch folder under
 * the same relative name, and git runs there, so its output names the same path. A link is copied as a link.
 */
export async function noIndexDiff(
    top: FolderRef,
    path: string,
    flags: string[],
    options: GitOptions,
    scratch: string | undefined,
    limit: number,
): Promise<string> {
    const args = ["diff", "--no-index", ...flags, "--", devNull, path];

    if (!top.sandboxed) {
        return git(top, args, options);
    }

    if (scratch === undefined) {
        throw new Error(
            "A sandboxed folder's new files are diffed from a private copy, and none is given.",
        );
    }

    mkdir(own(scratch), { recursive: true, mode: 0o700 });

    const dir = makeTemporaryFolder(own(scratch), "diff-").display.text;

    try {
        const source = top.at(path);
        const target = own(dir).child(path);
        const info = lstat(source);

        mkdir(own(dir).child(dirname(path)), { recursive: true });

        if (info.isSymbolicLink()) {
            symlink(readlink(source), target);
        } else if (info.isFile() && info.size <= limit) {
            writeFile(target, readFile(source, { max: limit }), { mode: info.mode & 0o777 });
        } else {
            throw new Error("That file is not a regular file of a size to diff.");
        }

        return await gitOwn(dir, args, { ...options, allowExit: options.allowExit });
    } finally {
        rm(own(dir), { recursive: true, force: true });
    }
}

/** Where a folder is in its repository, as git writes paths: `app/` for the folder app, empty at the top. */
async function prefixOf(folder: FolderRef): Promise<string> {
    return (await git(folder, ["rev-parse", "--show-prefix"])).trim();
}

/**
 * The changes in a folder's repository, with the files Pi edited according to `entries`. `onlyHere` leaves out the
 * changes outside the folder: someone invited to one session sees its files only.
 */
export async function changesIn(
    folder: FolderRef,
    entries: readonly ClientEntry[],
    onlyHere = false,
    /** Where private copies go for a sandboxed folder (`noIndexDiff`). */
    scratch?: string,
): Promise<Changes> {
    let root: string;

    try {
        root = (await git(folder, ["rev-parse", "--show-toplevel"])).trim();
    } catch {
        const edits = piEdits(entries, folder);

        return {
            files: [],
            more: 0,
            piOnly: [...edits].map(([path, entryId]) => ({ path, entryId })),
        };
    }

    const edits = piEdits(entries, folder, true);
    const top = folder.host.traverse(root);
    const branch = await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"]).then(
        (name) => name.trim(),
        () => undefined,
    );
    const head = await git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
        (id) => id.trim() || undefined,
        () => undefined,
    );
    const prefix = onlyHere ? await prefixOf(folder) : "";
    const changed = parseStatus(
        await git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ).filter(({ path }) => path.startsWith(prefix));
    const status = changed.slice(0, MAX_FILES);
    // Without a first commit there is nothing to compare with: every file is new.
    const counts =
        head === undefined
            ? new Map()
            : parseNumstat(await git(top, ["diff", "HEAD", "--numstat", "-z", ...DIFF_FLAGS]));

    // HEAD diffs omit untracked files. Count only the visible, permitted files; Git keeps binary, attributes,
    // symlinks and final-newline handling the same as each file's diff. No index or files are changed.
    const count = async (path: string) => {
        try {
            if ((await lstatAsync(top.at(path))).size > MAX_COUNTED_BYTES) {
                return;
            }

            const added = parseNumstat(
                await noIndexDiff(
                    top,
                    path,
                    ["--numstat", "-z", ...DIFF_FLAGS],
                    { allowExit: [1] },
                    scratch,
                    MAX_COUNTED_BYTES,
                ),
            ).get(path);

            if (added !== undefined) {
                counts.set(path, added);
            }
        } catch {
            // A file can disappear or become unreadable after status. Keep the list, with its count unknown.
        }
    };

    const uncounted = status.filter(({ code }) => code === "??" || head === undefined);
    let next = 0;

    await Promise.all(
        Array.from({ length: COUNTS_AT_ONCE }, async () => {
            while (next < uncounted.length) {
                await count(uncounted[next++]!.path);
            }
        }),
    );

    const versions = await Promise.all(status.map(({ path }) => versionOf(top.at(path))));
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
 * The diff of one changed file of the repository the folder is in, against the last commit; a new file's whole content.
 * Only files that git lists as changed: the path cannot point anywhere else. With `onlyHere`, only files in the folder.
 */
export async function diffOf(
    folder: FolderRef,
    path: string,
    onlyHere = false,
    scratch?: string,
): Promise<string> {
    const top = folder.host.traverse((await git(folder, ["rev-parse", "--show-toplevel"])).trim());
    const change = parseStatus(
        await git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ).find((each) => each.path === path);

    // A file outside the folder is as unknown as one without changes.
    if (change === undefined || (onlyHere && !path.startsWith(await prefixOf(folder)))) {
        throw new Error("That file has no uncommitted changes");
    }

    const hasHead = await git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
        () => true,
        () => false,
    );
    // `--no-index` exits with 1 when the files differ, which is the point. A renamed file is both its paths: given
    // both, git shows what changed in it, not a whole new file.
    const paths = change.from === undefined ? [path] : [change.from, path];
    const diff =
        change.code === "??" || !hasHead
            ? await noIndexDiff(
                  top,
                  path,
                  ["-U3", ...DIFF_FLAGS],
                  { allowExit: [1] },
                  scratch,
                  MAX_DIFF * 4,
              )
            : await git(top, ["diff", "HEAD", "-M", "-U3", ...DIFF_FLAGS, "--", ...paths]);

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
    folder: FolderRef,
    path: string,
    onlyHere = false,
): Promise<ChangeKind> {
    const top = folder.host.traverse((await git(folder, ["rev-parse", "--show-toplevel"])).trim());
    const change = parseStatus(
        await git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ).find((each) => each.path === path);

    if (change === undefined || (onlyHere && !path.startsWith(await prefixOf(folder)))) {
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
        await rmAsync(top.at(path), { force: true });

        return kind;
    }

    const hasHead = await git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
        () => true,
        () => false,
    );
    const inHead =
        hasHead &&
        (await git(top, ["cat-file", "-e", `HEAD:${path}`]).then(
            () => true,
            () => false,
        ));

    if (kind === "added" && !inHead) {
        // Added since the last commit: out of the index, then gone.
        await git(top, ["rm", "--cached", "--quiet", "--force", "--", path]);
        await rmAsync(top.at(path), { force: true });

        return kind;
    }

    if (!hasHead) {
        await git(top, ["rm", "--cached", "--quiet", "--force", "--", path]);
        await rmAsync(top.at(path), { force: true });

        return kind;
    }

    await git(top, ["restore", "--source=HEAD", "--staged", "--worktree", "--", path]);

    return kind;
}
