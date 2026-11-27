/**
 * Git for the sandbox, by Git's own trust model: the work tree is untrusted, as a cloned repository is, and every git
 * directory is trusted. The guest may write the work tree and never a git directory. This file finds the git
 * directories that a folder reaches, checks (before a VM starts with the folder writable) that git cannot be made to
 * run code that lies in the work tree, and holds the guest's own git settings.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gitProtected } from "./policy.ts";

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

/**
 * The git directories of one work tree: its own (a `.git` folder, or the folder that a `.git` file names, with a
 * back-pointer or without: `git init --separate-git-dir` leaves none), and the common one of a linked worktree;
 * undefined when the tree is no repository. A linked worktree whose record does not point back at the tree is
 * guarded only where it lies inside `here` (the folder): a `.git` file cannot make the sandbox share another folder
 * as a worktree.
 */
function gitDirsOf(tree: string, here: string | undefined): string[] | undefined {
    const dotGit = join(tree, ".git");
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

        own = match === null ? undefined : real(resolve(tree, match[1]!));
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
            ? inside(own, common)
                ? [common]
                : [common, own]
            : [own];

    if (back !== undefined && real(isAbsolute(back) ? back : resolve(own, back)) === real(dotGit)) {
        return dirs;
    }

    const kept = dirs.filter((dir) => here !== undefined && inside(dir, here));

    return kept.length === 0 ? undefined : kept;
}

/** Runs host Git in `tree`. A failure rejects with what git said. */
async function git(tree: string, args: string[]): Promise<string> {
    try {
        const { stdout } = await run("git", ["-C", tree, ...args], {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            timeout: 30_000,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        });

        return stdout;
    } catch (error) {
        const detail = (error as { stderr?: string }).stderr?.trim();

        throw new Error(
            `git ${args.slice(0, 2).join(" ")} failed in ${tree}: ${detail || (error as Error).message}`,
        );
    }
}

/** The paths of the submodules that the index of `tree` records (git's own list: entries of mode 160000). */
async function submodulesOf(tree: string): Promise<string[]> {
    const list = await git(tree, ["-c", "core.fsmonitor=false", "ls-files", "--stage", "-z"]);

    return list
        .split("\0")
        .flatMap((line) =>
            line.startsWith("160000 ") ? [line.slice(line.indexOf("\t") + 1)] : [],
        );
}

export interface GitMounts {
    /** Every git directory that the folder reaches, as real paths: inside the folder, outside it, or around it. */
    readonly gitDirs: readonly string[];
    /** The work trees that use them: the folder, and each submodule of it. Git runs hooks and configuration for these. */
    readonly trees: readonly string[];
    /** Folders that git in the guest must trust (`safe.directory`). */
    readonly safeDirectories: readonly string[];
}

/**
 * The git directories that a VM for `cwd` reaches: the repository's own, the common directory and the `worktrees/<n>`
 * of a linked worktree, and those of each submodule (found as git lists them, and only when the submodule lies inside
 * the folder). It rejects when git cannot answer: a repository that cannot be inspected is not shared.
 */
export async function gitMounts(cwd: string): Promise<GitMounts> {
    const here = real(cwd);
    const gitDirs = new Set<string>();
    const trees: string[] = [];

    const visit = async (tree: string): Promise<void> => {
        const own = gitDirsOf(tree, here);

        if (own === undefined || trees.includes(tree)) {
            return;
        }

        trees.push(tree);
        own.forEach((dir) => gitDirs.add(dir));

        for (const path of await submodulesOf(tree)) {
            const child = join(tree, path);
            const found = real(child);

            if (here !== undefined && found !== undefined && inside(found, here)) {
                await visit(child);
            }
        }
    };

    if (here !== undefined) {
        await visit(cwd);
    }

    const outside = [...gitDirs].filter((dir) => here === undefined || !inside(dir, here));

    return {
        gitDirs: [...gitDirs],
        trees,
        safeDirectories: [
            ...(trees.length === 0 ? [cwd] : trees),
            ...outside.flatMap((dir) => (dir.endsWith(`${sep}.git`) ? [dirname(dir)] : [])),
        ],
    };
}

function missing(error: unknown): boolean {
    const code = (error as { code?: string }).code;

    return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Where `path` leads, as the kernel would follow it: the real path of what exists, a link at the end of it that leads
 * nowhere yet followed too, and then the names that do not exist yet. `..` is never taken out of the text first.
 */
function leadsTo(path: string, links = 0): string {
    const rest: string[] = [];
    let at = path;

    for (;;) {
        try {
            return join(realpathSync.native(at), ...rest);
        } catch (error) {
            if (!missing(error)) {
                throw error;
            }
        }

        let target: string | undefined;

        try {
            target = readlinkSync(at);
        } catch {
            // not a link: a name that does not exist
        }

        if (target !== undefined) {
            if (links >= 40) {
                throw new Error(`too many links on the way to ${path}`);
            }

            const base = realpathSync.native(dirname(at));

            return leadsTo(
                [isAbsolute(target) ? target : `${base}/${target}`, ...rest].join("/"),
                links + 1,
            );
        }

        const parent = dirname(at);

        if (parent === at) {
            return path;
        }

        rest.unshift(basename(at));
        at = parent;
    }
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
 * The keys whose value is a program that git runs with the user's rights (git-config's documentation): the value may
 * name a script of the folder. Git lists a section and a name in lower case, and a subsection as written.
 */
const PROGRAM_KEYS: readonly RegExp[] = [
    /^core\.(sshcommand|editor|pager|askpass|alternaterefscommand)$/i,
    /^sequence\.editor$/i,
    /^gpg\.(.+\.)?program$/i,
    /^credential\.(.+\.)?helper$/i,
    /^diff\.external$/i,
    /^diff\..+\.(command|textconv)$/i,
    /^merge\..+\.(recursive)?driver$/i,
    /^filter\..+\.(clean|smudge|process)$/i,
    /^(difftool|mergetool)\..+\.cmd$/i,
    /^remote\..+\.(uploadpack|receivepack)$/i,
    /^uploadpack\.packobjectshook$/i,
];

/** Whether the value of `key` names a program: `core.fsmonitor` does unless it is a boolean, an alias only after `!`. */
function runsProgram(key: string, value: string): boolean {
    if (/^core\.fsmonitor$/i.test(key)) {
        return !/^(true|false|yes|no|on|off|1|0)?$/i.test(value.trim());
    }

    if (/^alias\..+$/i.test(key)) {
        return value.trimStart().startsWith("!");
    }

    return PROGRAM_KEYS.some((pattern) => pattern.test(key));
}

/**
 * Why git, run on this machine, could run what the guest writes: the effective hooks folder, or a configuration file
 * that git reads or may read (an `include` or `includeIf` target, whether it exists or not), lies in the folder where
 * the guest may write; or the repository's own configuration (local or worktree scope) sets a key whose value is a
 * program (`PROGRAM_KEYS`), which may be a script of the folder. Git runs hooks and programs, and reads
 * configuration, with the user's rights. Only what the guest cannot write (the git directories) may hold them, and
 * a program is allowed in the global and system configuration, which are the machine's. Undefined when there is
 * nothing to say. A read only folder has no such risk. It rejects when git cannot answer: nothing is assumed.
 */
export async function gitConfigProblem(
    cwd: string,
    trees: readonly string[],
    gitDirs: readonly string[],
): Promise<string | undefined> {
    const root = real(cwd) ?? cwd;
    const guarded = gitProtected(root, gitDirs);
    const home = process.env.HOME ?? homedir();

    const exposed = (path: string): string | undefined => {
        const target = leadsTo(path);

        return inside(target.toLowerCase(), root.toLowerCase()) && !guarded(target)
            ? target
            : undefined;
    };

    for (const tree of trees) {
        const hooks = (
            await git(tree, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
        ).trim();
        const found = exposed(hooks);

        if (found !== undefined) {
            return `Git would run hooks from ${found}, which lies inside the sandbox folder, where the sandbox can write them.`;
        }

        const list = await git(tree, [
            "config",
            "--list",
            "--show-origin",
            "--show-scope",
            "--null",
        ]);

        for (const { scope, origin, key, value } of parseConfig(list)) {
            if ((scope === "local" || scope === "worktree") && runsProgram(key, value)) {
                return `The repository's own configuration sets ${key} (in ${origin.replace(/^file:/, "")}), and git runs what it names with your rights: it can be a script in the sandbox folder, where the sandbox can write it.`;
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
                const target = exposed(path);

                if (target !== undefined) {
                    return `Git reads ${target} as configuration (${key} in ${from}), and it lies inside the sandbox folder, where the sandbox can write it.`;
                }
            }
        }
    }

    return undefined;
}
