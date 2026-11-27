/**
 * Git for the sandbox: which repository folders a session's VM needs besides its own folder, and the guest's own git
 * configuration. A session on a git worktree has a `.git` file that names a folder of the main repository, outside the
 * session's folder: the VM mounts that folder too, at its host path, with the same protections as a `.git` folder
 * inside the session's folder (`policy.ts`).
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** What the guest's git says when someone pushes or fetches with credentials: the VM has none. */
export const NO_CREDENTIALS =
    "pi-pocket sandbox: this sandbox has no credentials, so git cannot sign in to a remote. Push, or fetch from a private repository, from the host.";

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function real(path: string): string | undefined {
    try {
        return realpathSync(path);
    } catch {
        return undefined;
    }
}

function read(path: string): string | undefined {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
}

/** A folder that is a git directory: a `HEAD`, and `objects` (or, for a linked worktree, a `commondir` file). */
function looksLikeGitDir(folder: string): boolean {
    return (
        existsSync(join(folder, "HEAD")) &&
        (isDirectory(join(folder, "objects")) || existsSync(join(folder, "commondir")))
    );
}

function inside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** The first line of a `.git` file: `gitdir: <path>`. */
function gitdirOf(file: string, cwd: string): string | undefined {
    const text = read(file);
    const match = text === undefined ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);

    return match === null ? undefined : resolve(cwd, match[1]!);
}

export interface GitMounts {
    /** Git directories outside the session's folder to mount at their own host paths, with the `.git` protections. */
    readonly gitDirs: readonly string[];
    /** Folders that git in the guest must trust (`safe.directory`): the session's folder and these repositories. */
    readonly safeDirectories: readonly string[];
}

/**
 * The git directories a VM needs for a session working in `cwd`. Only a `.git` file that git itself wrote counts: the
 * folder it names must hold a repository whose own record points back at `cwd` (a worktree's `gitdir` file, or a
 * separate git directory's `core.worktree`). A `.git` file that names anything else mounts nothing, so a file in the
 * folder cannot make the sandbox share another folder.
 */
export function gitMounts(cwd: string): GitMounts {
    const safe = [cwd];
    const none = { gitDirs: [], safeDirectories: safe };
    const dotGit = join(cwd, ".git");
    let kind: "file" | "other";

    try {
        kind = statSync(dotGit).isFile() ? "file" : "other";
    } catch {
        return none;
    }

    if (kind !== "file") {
        return none;
    }

    const named = gitdirOf(dotGit, cwd);
    const own = named === undefined ? undefined : real(named);
    const here = real(cwd);

    if (own === undefined || here === undefined || !looksLikeGitDir(own)) {
        return none;
    }

    const found = new Set<string>();
    const commondir = read(join(own, "commondir"));

    if (commondir !== undefined) {
        // A linked worktree: `<main>/.git/worktrees/<name>`, whose `gitdir` file names this folder's `.git` file.
        const back = read(join(own, "gitdir"))?.trim();

        if (
            back === undefined ||
            real(isAbsolute(back) ? back : resolve(own, back)) !== real(dotGit)
        ) {
            return none;
        }

        const common = real(resolve(own, commondir.trim()));

        if (
            common === undefined ||
            !looksLikeGitDir(common) ||
            !isDirectory(join(common, "refs"))
        ) {
            return none;
        }

        found.add(common);

        if (!inside(own, common)) {
            found.add(own);
        }
    } else {
        // A repository whose git directory is kept elsewhere (a submodule's): its config names this folder.
        const config = read(join(own, "config"));
        const tree =
            config === undefined ? undefined : /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(config)?.[1];

        if (tree === undefined || real(resolve(own, tree)) !== here) {
            return none;
        }

        found.add(own);
    }

    const gitDirs = [...found].filter((path) => !inside(path, here) && !inside(here, path));

    return {
        gitDirs,
        safeDirectories: [
            cwd,
            ...gitDirs.flatMap((path) => (path.endsWith(`${sep}.git`) ? [dirname(path)] : [])),
        ],
    };
}

/** What the guest's git says when someone rebases: the state of a rebase is held (`policy.ts`). */
export const NO_REBASE =
    "pi-pocket sandbox: git keeps the state of a rebase, of git am, and of a cherry-pick or revert of several commits in files that git runs commands from, so this sandbox may not write them. Rebase from the host: ask the person to run it there.";

/** What the guest's git says when it needs to write a part of the repository that is the host's. */
export const NO_GIT_WRITE =
    "pi-pocket sandbox: git may write only objects, refs, logs, the index, HEAD, and the files of a commit or a merge in a repository folder. Its configuration, hooks, remotes, worktrees, submodules, and maintenance are the host's: ask the person to change them from the host.";

/**
 * The guest's `git`, in `/usr/local/bin` before the real one: `rebase` and `am` say at once what they cannot do, and
 * `pull`, `cherry-pick`, and `revert` add it when they fail because of the held state. Everything else is the real git.
 */
export const GIT_WRAPPER = [
    "#!/bin/sh",
    "# pi-pocket sandbox: git, with a clear word for what the sandbox cannot do.",
    "real=/usr/bin/git",
    '[ -x "$real" ] || { echo "git: not found" >&2; exit 127; }',
    "cmd=",
    "skip=0",
    'for arg in "$@"; do',
    '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
    '  case "$arg" in',
    "    -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env) skip=1 ;;",
    "    -*) ;;",
    '    *) cmd="$arg"; break ;;',
    "  esac",
    "done",
    'case "$cmd" in',
    `  rebase|am) echo ${JSON.stringify(NO_REBASE)} >&2; exit 1 ;;`,
    "  pull|cherry-pick|revert|config|remote|worktree|submodule|init|clone|gc|maintenance|repack|prune|notes|sparse-checkout|branch|checkout|switch)",
    '    log=$(mktemp) || exec "$real" "$@"',
    '    "$real" "$@" 2>"$log"; code=$?',
    '    cat "$log" >&2',
    '    if grep -qiE "rebase-merge|rebase-apply|sequencer" "$log"; then',
    `      echo ${JSON.stringify(NO_REBASE)} >&2`,
    '      [ "$code" -eq 0 ] && code=1',
    '    elif [ "$code" -ne 0 ] && grep -qiE "permission denied|could not lock config|could not create|read-only" "$log"; then',
    `      echo ${JSON.stringify(NO_GIT_WRITE)} >&2`,
    "    fi",
    '    rm -f "$log"',
    '    exit "$code" ;;',
    "esac",
    'exec "$real" "$@"',
    "",
].join("\n");

/** What the VM's `/etc/gitconfig` holds: trust for the mounted folders, a default author, and no way to sign in. */
export function guestGitConfig(safeDirectories: readonly string[]): string {
    const quote = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;
    const message = `echo ${JSON.stringify(NO_CREDENTIALS)} >&2; exit 1`;

    return [
        "[safe]",
        ...safeDirectories.map((path) => `\tdirectory = ${quote(path)}`),
        "[user]",
        "\tname = Pi (sandbox)",
        "\temail = pi-sandbox@localhost",
        "[credential]",
        `\thelper = ${quote(`!f() { ${message}; }; f`)}`,
        "[core]",
        `\tsshCommand = ${quote(`f() { ${message}; }; f`)}`,
        "",
    ].join("\n");
}
