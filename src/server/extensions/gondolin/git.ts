/**
 * Git for the sandbox, by Git's own trust model: the work tree is untrusted, as a cloned repository is, and every git
 * directory is trusted. The guest may write the work tree and never a git directory. This file finds the git
 * directories that a folder reaches, checks (before a VM starts with the folder writable) that git cannot be made to
 * run code that lies in the work tree, and holds the guest's own git settings.
 */
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
    gitProtected,
    holdsGitDir,
    isDirectory,
    isDotGit,
    looksLikeGitDir,
    within,
} from "./policy.ts";

const run = promisify(execFile);

/** What the guest's git says when someone pushes or fetches with credentials: the VM has none. */
export const NO_CREDENTIALS =
    "pi-pocket sandbox: this sandbox has no credentials, so git cannot sign in to a remote. Push, or fetch from a private repository, from the host.";

/** What the guest's git says when it needs to write a git directory: the guest may not. */
export const NO_GIT_WRITE =
    "pi-pocket sandbox: Git metadata is read only here. Ask the person to commit (or change branches, config, remotes) on the host.";

/** The guest's `git`, in `/usr/local/bin` before the real one: the real git, and one word more when it could not write. */
export const GIT_WRAPPER = [
    "#!/bin/sh",
    "real=/usr/bin/git",
    '[ -x "$real" ] || { echo "git: not found" >&2; exit 127; }',
    'log=$(mktemp) || exec "$real" "$@"',
    '"$real" "$@" 2>"$log"; code=$?',
    'cat "$log" >&2',
    'if [ "$code" -ne 0 ] && grep -qiE "read-only file system|permission denied|insufficient permission|unable to (create|write|append)|could not (lock|create|write)" "$log"; then',
    `  echo ${JSON.stringify(NO_GIT_WRITE)} >&2`,
    "fi",
    'rm -f "$log"',
    'exit "$code"',
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

/**
 * The git directories that the `.git` entry `dotGit` leads to: its own (a `.git` folder, or the folder that a `.git`
 * file names, with a back-pointer or without: `git init --separate-git-dir` leaves none), and the common one of a
 * linked worktree; undefined when it leads to none. A linked worktree whose record does not point back at the
 * `.git` file is guarded only where it lies inside `here` (the folder): a `.git` file cannot make the sandbox share
 * another folder as a worktree.
 */
function gitDirsOf(dotGit: string, here: string | undefined): string[] | undefined {
    let stat;

    try {
        stat = statSync(dotGit);
    } catch {
        return undefined;
    }

    let own: string | undefined;

    if (stat.isDirectory()) {
        own = real(dotGit);
    } else {
        const text = read(dotGit);
        const match = text === undefined ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);

        own = match === null ? undefined : real(resolve(dirname(dotGit), match[1]!));
    }

    if (own === undefined || !looksLikeGitDir(own)) {
        return undefined;
    }

    const commondir = read(join(own, "commondir"));

    if (commondir === undefined) {
        return [own];
    }

    const back = read(join(own, "gitdir"))?.trim();
    const common = real(resolve(own, commondir.trim()));
    const dirs =
        common !== undefined && looksLikeGitDir(common) && isDirectory(join(common, "refs"))
            ? within(own, common)
                ? [common]
                : [common, own]
            : [own];

    if (back !== undefined && real(isAbsolute(back) ? back : resolve(own, back)) === real(dotGit)) {
        return dirs;
    }

    const kept = dirs.filter((dir) => here !== undefined && within(dir, here));

    return kept.length === 0 ? undefined : kept;
}

/** Host Git, as the person's own would run in `tree`: no `GIT_*` variable of this server decides where or how. */
async function git(tree: string, args: string[]): Promise<string> {
    const env = { ...process.env };

    for (const name of Object.keys(env)) {
        if (name.startsWith("GIT_")) {
            delete env[name];
        }
    }

    try {
        const { stdout } = await run("git", ["-C", tree, ...args], {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            timeout: 30_000,
            env,
        });

        return stdout;
    } catch (error) {
        const detail = (error as { stderr?: string }).stderr?.trim();

        throw Object.assign(
            new Error(
                `git ${args.slice(0, 2).join(" ")} failed in ${tree}: ${detail || (error as Error).message}`,
            ),
            { status: (error as { code?: unknown }).code },
        );
    }
}

export interface GitMounts {
    /** Every git directory that the folder reaches, as real paths: inside the folder, outside it, or around it. */
    readonly gitDirs: readonly string[];
    /** The folders where git runs for this one: each work tree below it, and the folder itself when a repository holds it. */
    readonly trees: readonly string[];
    /** Folders that git in the guest must trust (`safe.directory`). */
    readonly safeDirectories: readonly string[];
    /** A folder that could not be read: a git directory below it would not be known. */
    readonly unreadable?: string;
}

/**
 * The git directories that a VM for `cwd` reaches. The folder is walked, links not followed, for every `.git` entry
 * (a repository of its own, a submodule, one that keeps its git directory elsewhere, a linked worktree) and every
 * folder that is a git directory itself (a bare repository): each is guarded, inside the folder or outside it.
 * Host git is asked whether a repository holds the folder from above, as it finds one when run there. What a
 * repository creates while the VM runs is guarded by name (`.git`) only; the next VM finds the rest. It rejects when
 * git cannot answer.
 */
export async function gitMounts(cwd: string): Promise<GitMounts> {
    const here = real(cwd);
    const gitDirs = new Set<string>();
    const trees = new Set<string>();
    let unreadable: string | undefined;
    const pending = here === undefined ? [] : [cwd];

    while (pending.length > 0) {
        await Promise.all(
            pending.splice(0, 32).map(async (folder) => {
                let entries;

                try {
                    entries = await readdir(folder, { withFileTypes: true });
                } catch {
                    unreadable ??= folder;

                    return;
                }

                const names = new Set(entries.map((entry) => entry.name));

                if (["HEAD", "objects", "refs"].every((name) => names.has(name))) {
                    gitDirs.add(real(folder) ?? folder);

                    return;
                }

                for (const entry of entries) {
                    const dirs = isDotGit(entry.name)
                        ? gitDirsOf(join(folder, entry.name), here)
                        : undefined;

                    if (dirs !== undefined) {
                        dirs.forEach((dir) => gitDirs.add(dir));
                        trees.add(folder);
                    } else if (entry.isDirectory() && !isDotGit(entry.name)) {
                        pending.push(join(folder, entry.name));
                    }
                }
            }),
        );
    }

    try {
        await git(cwd, ["rev-parse", "--git-dir"]);
        trees.add(cwd);
    } catch (error) {
        // Git's own "fatal" (exit 128): no repository that it can use holds the folder, so no hook or program runs.
        if ((error as { status?: unknown }).status !== 128) {
            throw error;
        }
    }

    const outside = [...gitDirs].filter((dir) => here === undefined || !within(dir, here));

    return {
        gitDirs: [...gitDirs].sort(),
        trees: [...trees].sort(),
        safeDirectories: [
            ...new Set([
                cwd,
                ...trees,
                ...outside.flatMap((dir) => (dir.endsWith(`${sep}.git`) ? [dirname(dir)] : [])),
            ]),
        ],
        ...(unreadable === undefined ? {} : { unreadable }),
    };
}

/**
 * Every place that the kernel touches on the way to `path`: each name on the way, and each link that it follows, with
 * the names after it. `..` after a link leads out of the place that the link leads to, not out of the link's folder.
 * A name that does not exist yet is a place too.
 */
function visits(path: string): string[] {
    const seen: string[] = [];
    const queue = path.split("/");
    let at = "/";
    let links = 0;

    while (queue.length > 0) {
        const part = queue.shift()!;

        if (part === "" || part === ".") {
            continue;
        }

        if (part === "..") {
            at = dirname(at);
            continue;
        }

        const next = join(at, part);
        let target: string | undefined;

        seen.push(next);

        try {
            target = readlinkSync(next);
        } catch {
            at = next;
            continue;
        }

        if (++links > 40) {
            throw new Error(`too many links on the way to ${path}`);
        }

        queue.unshift(...target.split("/"));

        if (isAbsolute(target)) {
            at = "/";
        }
    }

    return seen;
}

interface ConfigValue {
    readonly scope: string;
    readonly origin: string;
    readonly key: string;
    readonly value: string;
}

/** Git's `config --list --show-origin --show-scope --null`: `scope NUL origin NUL key NL value NUL`. */
function parseConfig(list: string): ConfigValue[] {
    const parts = list.split("\0");
    const values: ConfigValue[] = [];

    if (parts.pop() !== "" || parts.length % 3 !== 0) {
        throw new Error("git's configuration list has an unexpected shape");
    }

    for (let at = 0; at < parts.length; at += 3) {
        const text = parts[at + 2]!;
        const newline = text.indexOf("\n");

        if (parts[at] === "") {
            throw new Error("git did not say which scope a configuration value comes from");
        }

        values.push({
            scope: parts[at]!,
            origin: parts[at + 1]!,
            key: newline === -1 ? text : text.slice(0, newline),
            value: newline === -1 ? "" : text.slice(newline + 1),
        });
    }

    return values;
}

/**
 * The only keys that the repository's own configuration (local or worktree scope) may set when the folder is
 * writable: settings that are plain data in git-config's documentation. Git writes the first group when it makes or
 * clones a repository (the format, the file system's traits, the work tree, a line-ending choice); a remote's address
 * and refspec, a branch's upstream and rebase mode, a submodule's address, and whether it is active, record where
 * things are; a person's name, email, and signing key, the repository extensions, the default branch, and `pull`,
 * `push`, and `fetch` choices are values and never a program or a file to read. Any other key could name a program
 * or a file of the folder, which the guest could rewrite and git would then run with the user's rights, so it is
 * not on the list: a list of what to forbid kept missing keys.
 */
const DATA_KEYS =
    /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|worktree)|remote\..+\.(url|pushurl|fetch)|branch\..+\.(remote|pushremote|merge|mergeoptions|rebase|description)|user\..+|extensions\..+|init\.defaultbranch|pull\.rebase|push\.default|fetch\.prune|lfs\.repositoryformatversion|submodule\.active|submodule\..+\.(url|active))$/i;

/**
 * Why git, run on this machine, could run what the guest writes, or undefined. The guest may write the folder
 * outside the git directories, and git runs hooks and programs, and reads configuration, with the user's rights. So
 * none of these may lie there, or pass through a place there (a link that the guest could change; a folder that
 * holds a git directory cannot be moved, so it is not such a place): the hooks
 * folder and each hook in it, each configuration file git reads, and each file that one includes (also one that is
 * not there yet). The repository's own configuration may set only plain data (`DATA_KEYS`); the global and system
 * configuration are the machine's. A read only folder has no such risk. It rejects when git cannot answer.
 */
export async function gitConfigProblem(
    cwd: string,
    trees: readonly string[],
    gitDirs: readonly string[],
): Promise<string | undefined> {
    const root = real(cwd) ?? cwd;
    const guarded = gitProtected(root, gitDirs);
    const home = process.env.HOME ?? homedir();

    const exposed = (path: string): string | undefined =>
        visits(path).find(
            (place) =>
                within(place.toLowerCase(), root.toLowerCase()) &&
                place.toLowerCase() !== root.toLowerCase() &&
                !guarded(place) &&
                !holdsGitDir(place, gitDirs),
        );

    for (const tree of trees) {
        const hooks = (
            await git(tree, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
        ).trim();
        let names: string[] = [];

        try {
            names = readdirSync(hooks).filter((name) => !name.endsWith(".sample"));
        } catch {
            // no hooks folder: nothing runs from it
        }

        for (const path of [hooks, ...names.map((name) => join(hooks, name))]) {
            const found = exposed(path);

            if (found !== undefined) {
                return `Git would run hooks from ${hooks}, and ${found} on the way to ${path} is in the sandbox folder, where the sandbox can write it.`;
            }
        }

        const list = await git(tree, [
            "config",
            "--list",
            "--show-origin",
            "--show-scope",
            "--null",
        ]);

        for (const { scope, origin, key, value } of parseConfig(list)) {
            if ((scope === "local" || scope === "worktree") && !DATA_KEYS.test(key)) {
                return `The repository's own configuration sets ${key} (in ${origin.replace(/^file:/, "")}). A writable sandbox folder allows only plain data there, because git can run a program, or read a file, that the sandbox could rewrite.`;
            }

            if (!origin.startsWith("file:")) {
                continue;
            }

            const file = origin.slice(5);
            const from = isAbsolute(file) ? file : `${tree}/${file}`;
            const files = [from];

            if (/^include(if\..+)?\.path$/i.test(key)) {
                files.push(
                    value.startsWith("~/")
                        ? join(home, value.slice(2))
                        : isAbsolute(value)
                          ? value
                          : `${dirname(from)}/${value}`,
                );
            }

            for (const path of files) {
                const found = exposed(path);

                if (found !== undefined) {
                    return `Git reads ${path} as configuration (${key} in ${from}), and ${found} on the way to it is in the sandbox folder, where the sandbox can write it.`;
                }
            }
        }
    }

    return undefined;
}
