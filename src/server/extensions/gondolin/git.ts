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
