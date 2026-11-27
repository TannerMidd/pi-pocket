/**
 * Git for the sandbox, by Git's own trust model: the work tree is untrusted, as a cloned repository is, and every git
 * directory is trusted. The guest may write the work tree and never a git directory. This file finds the git
 * directories that a folder reaches, checks (before a VM starts with the folder writable) that git cannot be made to
 * run code that lies in the work tree, and holds the guest's own git settings.
 */
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
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
    /** The bare repositories in the folder: git runs in each, with its own directory as the repository. */
    readonly bare: readonly string[];
    /** The git directory of the repository that holds the folder from above: checked, and not mounted. */
    readonly above?: string;
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
    const bare = new Set<string>();
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
                    bare.add(folder);

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

    let above: string | undefined;

    try {
        above = real((await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim());
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
        bare: [...bare].sort(),
        ...(above === undefined || gitDirs.has(above) ? {} : { above }),
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

/** The home folder of the user `name`, as the system's user list gives it, or undefined. */
function homeOf(name: string): string | undefined {
    try {
        if (userInfo().username === name) {
            return userInfo().homedir;
        }

        return readFileSync("/etc/passwd", "utf8")
            .split("\n")
            .map((line) => line.split(":"))
            .find((fields) => fields[0] === name && fields.length >= 6)?.[5];
    } catch {
        return undefined;
    }
}

/**
 * Where git reads an `include.path` or `includeIf.*.path` value `value` of the file `holder`, as git expands it: `~/`
 * is `$HOME`, `~user/` is that user's home folder, an absolute name is itself, and any other name is relative to the
 * folder of the file that holds it. The text is kept as it is (no `..` is taken out), so the kernel's walk of it, link
 * by link, decides where it leads. Undefined for a form that git expands in another way (`%(prefix)/`) or that cannot
 * be expanded here: it is then not known where git reads.
 */
function expandPath(value: string, holder: string): string | undefined {
    if (value.startsWith("~")) {
        const slash = value.indexOf("/");
        const name = value.slice(1, slash === -1 ? undefined : slash);
        const home = name === "" ? process.env.HOME : homeOf(name);

        return home === undefined || home === ""
            ? undefined
            : home + (slash === -1 ? "" : value.slice(slash));
    }

    if (value.startsWith("%(")) {
        return undefined;
    }

    return isAbsolute(value) ? value : `${dirname(holder)}/${value}`;
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

/** Every link below the folders `dirs`, found without following any. It rejects when a folder cannot be read. */
async function linksBelow(dirs: readonly string[]): Promise<string[]> {
    const links: string[] = [];
    const pending = dirs.filter(
        (dir) => !dirs.some((other) => other !== dir && within(dir, other)),
    );

    while (pending.length > 0) {
        await Promise.all(
            pending.splice(0, 32).map(async (folder) => {
                for (const entry of await readdir(folder, { withFileTypes: true })) {
                    const path = join(folder, entry.name);

                    if (entry.isSymbolicLink()) {
                        links.push(path);
                    } else if (entry.isDirectory()) {
                        pending.push(path);
                    }
                }
            }),
        );
    }

    return links;
}

/**
 * Why git, run on this machine, could run what the guest writes, or undefined. The guest may write the folder
 * outside the git directories, and git runs hooks and programs, and reads configuration, with the user's rights. So
 * none of these may lie there, or pass through a place there (a link that the guest could change; a folder that
 * holds a git directory cannot be moved, so it is not such a place):
 * - every link inside a git directory (its configuration, `config.worktree`, hooks, and `info` files are whatever
 *   it leads to);
 * - the hooks folder and each hook in it, and every file that git reads as configuration, whether it is there or
 *   not (the repository's own, the user's two, and the system's, which git reads at the same paths each time, and
 *   so cannot be learned from the values that git lists, an empty file having none); and each file that one of
 *   them includes.
 * The repository's own configuration may set only plain data (`DATA_KEYS`); the global and system configuration are
 * the machine's. Every repository counts: the folder's, those below it, a bare one, and the one above. A read only
 * folder has no such risk. It rejects when git cannot answer. Git runs with the server's environment less every
 * `GIT_*` variable (`git`), as the person's own git runs.
 */
export async function gitConfigProblem(cwd: string, found: GitMounts): Promise<string | undefined> {
    const root = real(cwd) ?? cwd;
    const guarded = gitProtected(root, found.gitDirs);
    const home = process.env.HOME ?? homedir();

    const exposed = (path: string): string | undefined =>
        visits(path).find(
            (place) =>
                within(place.toLowerCase(), root.toLowerCase()) &&
                place.toLowerCase() !== root.toLowerCase() &&
                !guarded(place) &&
                !holdsGitDir(place, found.gitDirs),
        );

    for (const link of await linksBelow([
        ...found.gitDirs,
        ...(found.above ? [found.above] : []),
    ])) {
        const place = exposed(link);

        if (place !== undefined) {
            return `${link} in a git directory is a link, and ${place} on the way to what it names is in the sandbox folder, where the sandbox can write it.`;
        }
    }

    for (const path of [
        join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "git", "config"),
        join(home, ".gitconfig"),
        "/etc/gitconfig",
    ]) {
        const place = exposed(path);

        if (place !== undefined) {
            return `Git reads ${path} as configuration, and ${place} on the way to it is in the sandbox folder, where the sandbox can write it.`;
        }
    }

    const repositories = [
        ...found.trees.map((tree) => ({ tree, args: [] as string[], repository: true })),
        ...found.bare.map((tree) => ({ tree, args: ["--git-dir", tree], repository: true })),
    ];

    // With no repository, the machine's configuration (and what it includes) still counts: git reads it in every one.
    if (repositories.length === 0) {
        repositories.push({ tree: cwd, args: [], repository: false });
    }

    for (const { tree, args, repository } of repositories) {
        const inside = (rest: string[]) => git(tree, [...args, ...rest]);
        const [hooks = "", ...sources] = repository
            ? (
                  await inside([
                      "rev-parse",
                      "--path-format=absolute",
                      "--git-path",
                      "hooks",
                      "--git-path",
                      "config",
                      "--git-path",
                      "config.worktree",
                  ])
              )
                  .trim()
                  .split("\n")
            : [];
        let names: string[] = [];

        try {
            names = readdirSync(hooks).filter((name) => !name.endsWith(".sample"));
        } catch {
            // no hooks folder: nothing runs from it
        }

        for (const path of repository ? [hooks, ...names.map((name) => join(hooks, name))] : []) {
            const place = exposed(path);

            if (place !== undefined) {
                return `Git would run hooks from ${hooks}, and ${place} on the way to ${path} is in the sandbox folder, where the sandbox can write it.`;
            }
        }

        for (const path of sources) {
            const place = exposed(path);

            if (place !== undefined) {
                return `Git reads ${path} as configuration, and ${place} on the way to it is in the sandbox folder, where the sandbox can write it.`;
            }
        }

        const list = await inside(["config", "--list", "--show-origin", "--show-scope", "--null"]);

        for (const { scope, origin, key, value } of parseConfig(list)) {
            if ((scope === "local" || scope === "worktree") && !DATA_KEYS.test(key)) {
                return `The repository's own configuration sets ${key} (in ${origin.replace(/^file:/, "")}). A writable sandbox folder allows only plain data there, because git can run a program, or read a file, that the sandbox could rewrite.`;
            }

            if (!origin.startsWith("file:") || !/^include(if\..+)?\.path$/i.test(key)) {
                continue;
            }

            const file = origin.slice(5);
            const from = isAbsolute(file) ? file : `${tree}/${file}`;
            const path = expandPath(value, from);

            if (path === undefined) {
                return `Git reads the file ${value} as configuration (${key} in ${from}), and Pi Pocket cannot tell where git expands that name to, so a writable sandbox folder cannot be allowed.`;
            }

            const place = exposed(path);

            if (place !== undefined) {
                return `Git reads ${path} as configuration (${key} in ${from}), and ${place} on the way to it is in the sandbox folder, where the sandbox can write it.`;
            }
        }
    }

    return undefined;
}
