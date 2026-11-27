/**
 * What the host's `git` reads as configuration or runs as code, when it lies inside a sandbox's folder. The guest may
 * not write these files: the repository's config is read only to it, but the config can point at files of the folder
 * (`core.hooksPath = .githooks`, `include.path = ../extra.cfg`, `core.fsmonitor = ./watch.sh`, a `filter` driver that
 * is a script of the project), and a guest that rewrites such a file runs code on this machine at the next `git
 * checkout` or `git status`. So the config is read here, on the host, and what it names inside the folder is protected.
 * (`policy.ts` protects `.git`'s own files; this protects what the config adds.)
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** A path of this machine that the guest may not write: the path itself, and, for a folder (`tree`), all below it. */
export interface ExecPath {
    readonly path: string;
    readonly tree: boolean;
}

export interface ConfigEntry {
    /** The file the value comes from, as git says it (`file:.git/config`), or other origins (`command line:`). */
    readonly origin: string;
    /** The key as git lists it: section and name in lower case, a subsection as written. */
    readonly key: string;
    readonly value: string;
}

/** Where relative paths in the config are taken from, and what is inside the sandbox. */
export interface ExecContext {
    /** The folder git ran in: the origins of config files are relative to it. */
    readonly cwd: string;
    /** The top of the working tree (where hooks, filters, and aliases run), when git says. */
    readonly top?: string;
    /** The git directory. */
    readonly gitDir?: string;
    /** The folders that the VM mounts: only paths inside them matter. */
    readonly mounts: readonly string[];
    readonly home?: string;
}

/** Keys whose value is a command, or the path of one. */
const COMMANDS: readonly RegExp[] = [
    /^core\.(fsmonitor|sshcommand|editor|pager|askpass|alternaterefscommand|gitproxy)$/,
    /^sequence\.editor$/,
    /^diff\.external$/,
    /^gpg\..*(program|defaultkeycommand)$/,
    /^credential\.(.*\.)?helper$/,
    /^uploadpack\.packobjectshook$/,
    /^diff\..+\.(command|textconv)$/,
    /^merge\..+\.(driver|recursivedriver)$/,
    /^filter\..+\.(clean|smudge|process)$/,
    /^(difftool|mergetool|browser|man)\..+\.(cmd|path)$/,
    /^web\.browser$/,
    /^remote\..+\.(uploadpack|receivepack|vcs|proxy)$/,
    /^pager\..+$/,
    /^(trailer|guitool)\..+\.cmd$/,
    /^sendemail\..*(cmd|command)$/,
];

/** Keys whose value is a file that git reads as configuration (not a command). */
const FILES: readonly RegExp[] = [
    /^core\.(attributesfile|excludesfile)$/,
    /^gpg\.ssh\.allowedsignersfile$/,
];

function commandValue(key: string, value: string): boolean {
    if (/^(alias\..+|submodule\..+\.update)$/.test(key)) {
        return value.trimStart().startsWith("!");
    }

    return COMMANDS.some((pattern) => pattern.test(key));
}

function inside(child: string, parent: string): boolean {
    const a = child.toLowerCase();
    const b = parent.toLowerCase();

    return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

function canonical(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** The words of a shell command, without quotes and the shell's punctuation. */
function words(command: string): string[] {
    return (command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [])
        .map((word) => word.replace(/^["'(!$]+|["';&|)]+$/g, ""))
        .filter((word) => word !== "" && !word.startsWith("-"));
}

/** A command's words that may be files of the folder: a path, or the name of a file that exists there. */
function fileWords(command: string, bases: readonly string[]): string[] {
    const found: string[] = [];

    for (const word of words(command)) {
        for (const text of word.includes("=")
            ? [word, word.slice(word.indexOf("=") + 1)]
            : [word]) {
            if (text === "") {
                continue;
            }

            const pathLike = text.includes("/") || text.startsWith("~");
            const named =
                !pathLike &&
                (/\.[A-Za-z0-9]{1,6}$/.test(text) ||
                    bases.some((base) => existsSync(join(base, text))));

            if (pathLike || named) {
                found.push(text);
            }
        }
    }

    return found;
}

/** A place that a value of the configuration may mean: as written out, and as the file system walks the text. */
interface Where {
    readonly path: string;
    /** The absolute text before any `..` is taken out: a link followed by `..` leads somewhere else than the text. */
    readonly raw: string;
}

/** `path` as the places that it may mean: absolute ones as they are, relative ones from each base. */
function candidates(path: string, bases: readonly string[], home: string): Where[] {
    if (path === "~" || path.startsWith("~/")) {
        return [{ path: join(home, path.slice(1)), raw: `${home}${path.slice(1)}` }];
    }

    return isAbsolute(path)
        ? [{ path: resolve(path), raw: path }]
        : bases.map((base) => ({ path: resolve(base, path), raw: `${base}${sep}${path}` }));
}

/** The file that an entry comes from, as git wrote it and made absolute, with nothing taken out of the text. */
function originText(cwd: string, entry: ConfigEntry): string {
    const path = entry.origin.slice(5);

    return isAbsolute(path) ? path : `${cwd}${sep}${path}`;
}

/** What a value of the configuration is: the key, its text, and where it was set, for what a person reads. */
function describe(entry: ConfigEntry, origin: string | undefined): string {
    return `git's ${entry.key} (${JSON.stringify(entry.value)}${origin === undefined ? "" : `, set in ${origin}`})`;
}

/** Whether `path` is below one of `roots`, and not one of them. */
function below(path: string, roots: readonly string[]): boolean {
    return roots.some((root) => inside(path, root) && path.toLowerCase() !== root.toLowerCase());
}

/** What `follow` says: where a path ends, and why it may not be used when it passes through a mount in a way that cannot be held. */
export interface Followed {
    readonly physical: string;
    readonly problem?: string;
}

/**
 * Follow `raw` as the kernel does, one component at a time, and say where it ends. Nothing is taken out of the text
 * first: `..` is the parent of the place reached so far, which has no link in it (so `link/..` is the parent of what the
 * link leads to), a relative link is read from the folder that holds it, an absolute one from the root, and a link that
 * leads nowhere is read as written. At most 40 links are followed, as the kernel allows. A component that is missing
 * ends the walk as written; `..` after one inside a mount is refused (the guest could make that component a link).
 *
 * A path is refused (`problem`) when a mount is passed by way of a link:
 * - a link that lies in a mount (the guest may make it, or point it elsewhere);
 * - a link that leads into a mount, or whose target text goes through one (a link outside, to a place inside).
 * A plain path that enters a mount, such as `.githooks`, and a link of the owner's outside the mounts that leads to a
 * folder above or beside them (`/tmp` on macOS), are followed without a word.
 */
export function follow(raw: string, roots: readonly string[]): Followed {
    let hops = 0;
    let problem: string | undefined;

    /** Walk `text` from `start` (a place with no link in it); `through`: any step into a mount is a problem. */
    const walk = (text: string, start: string, through: boolean): string => {
        let at = start;
        let missing = false;
        const parts = text.split(sep);

        while (parts.length > 0 && problem === undefined) {
            const part = parts.shift()!;

            if (part === "" || part === ".") {
                continue;
            }

            if (part === "..") {
                if (missing && roots.some((root) => inside(at, root))) {
                    problem = `uses .. after a place that is not there (${at}), which the guest could make a link`;

                    break;
                }

                at = dirname(at);
            } else {
                const next = join(at, part);
                let target: string | undefined;

                try {
                    target = lstatSync(next).isSymbolicLink() ? readlinkSync(next) : undefined;
                } catch (error) {
                    if (
                        (error as { code?: string }).code === "ENOENT" ||
                        (error as { code?: string }).code === "ENOTDIR"
                    ) {
                        missing = true;
                        at = next;

                        continue;
                    }

                    problem = `cannot be read (${next})`;

                    break;
                }

                if (target === undefined) {
                    at = next;
                } else {
                    if (++hops > 40) {
                        problem = `goes through too many links (${next})`;

                        break;
                    }

                    if (below(next, roots)) {
                        problem = `goes through a link in the folder (${next}), which the guest may change`;

                        break;
                    }

                    // Where the link leads: its text, read from the folder that holds it (or from the root).
                    const end = walk(target, isAbsolute(target) ? sep : at, true);

                    if (problem !== undefined) {
                        break;
                    }

                    if (roots.some((root) => inside(end, root))) {
                        problem = `reaches into the folder through a link (${next} leads to ${end})`;

                        break;
                    }

                    at = end;
                }
            }

            if (through && roots.some((root) => inside(at, root))) {
                problem = `goes through the folder by way of a link (${at})`;

                break;
            }
        }

        return at;
    };

    const physical = walk(raw, sep, false);

    return problem === undefined ? { physical } : { physical, problem };
}

/** The first link inside `dir` that leads below a mount but out of `dir`, or that leads nowhere; undefined when none. */
function linkOut(dir: string, roots: readonly string[]): string | undefined {
    let budget = 5000;

    const walk = (folder: string): string | undefined => {
        let names: string[];

        try {
            names = readdirSync(folder);
        } catch {
            return undefined;
        }

        for (const name of names) {
            const child = join(folder, name);

            if (--budget < 0) {
                return `${dir} holds too many entries to check`;
            }

            let stats;

            try {
                stats = lstatSync(child);
            } catch {
                continue;
            }

            if (stats.isSymbolicLink()) {
                let real: string;

                try {
                    real = realpathSync(child);
                } catch {
                    return `${child} is a link that leads nowhere`;
                }

                if (below(real, roots) && !inside(real, dir)) {
                    return `${child} is a link to ${real}, which the guest may write`;
                }
            } else if (stats.isDirectory()) {
                const found = walk(child);

                if (found !== undefined) {
                    return found;
                }
            }
        }

        return undefined;
    };

    return walk(dir);
}

/** What the host's git would read or run inside the mounts, and what makes holding it impossible. */
export interface ExecPlan {
    readonly paths: ExecPath[];
    /** Why the folder cannot be shared at all: a path git uses reaches it through a link, or is the folder itself. */
    readonly problems: string[];
}

/** Keys that hold a list: every entry counts. The others have one value, and the last entry is the one git uses. */
const LISTS = [/^(include|includeif\..+)\.path$/, /^credential\.(.*\.)?helper$/];

/** The entries that git uses: for a key with one value the last one (the order is git's, from the weakest scope to the strongest). */
function effective(entries: readonly ConfigEntry[]): ConfigEntry[] {
    const last = new Map<string, number>();

    entries.forEach((entry, index) => {
        if (!LISTS.some((pattern) => pattern.test(entry.key))) {
            last.set(entry.key, index);
        }
    });

    return entries.filter(
        (entry, index) =>
            LISTS.some((pattern) => pattern.test(entry.key)) || last.get(entry.key) === index,
    );
}

/** The files of the folder that git would read as configuration, or run, given its configuration. */
export function execPathsOf(entries: readonly ConfigEntry[], context: ExecContext): ExecPath[] {
    return execPlan(entries, context).paths;
}

export function execPlan(entries: readonly ConfigEntry[], context: ExecContext): ExecPlan {
    const home = context.home ?? homedir();
    const real = context.mounts.map(canonical);
    const roots = [...new Set([...context.mounts.map((mount) => resolve(mount)), ...real])];
    const bases = [...new Set([context.top, context.cwd].filter((base) => base !== undefined))];
    const out = new Map<string, ExecPath>();
    const problems: string[] = [];

    /** Hold `where`: refuse when it reaches the folder through a link, else hold it and the way to it. */
    const hold = (
        where: Where,
        tree: boolean,
        entry: ConfigEntry,
        origin: string | undefined,
        hooks = false,
    ) => {
        const { physical, problem } = follow(where.raw, roots);

        if (problem !== undefined) {
            problems.push(
                `${describe(entry, origin)} ${problem}, so the guest could make git run its files`,
            );

            return;
        }

        const mount = real.find((each) => inside(physical, each));

        if (hooks) {
            const whole = real.find((each) => physical.toLowerCase() === each.toLowerCase());
            const around = real.find((each) => inside(each, physical) && !inside(physical, each));

            if (whole !== undefined || around !== undefined) {
                problems.push(
                    `${describe(entry, origin)} is ${whole === undefined ? "a folder that holds" : "the folder"} ${whole ?? around}${whole === undefined ? "" : " itself"}, so any file in it could be a hook that git runs on this machine`,
                );

                return;
            }
        }

        if (mount === undefined) {
            return;
        }

        let target = physical;
        let held = tree || isDirectory(physical);

        if (!existsSync(physical)) {
            // The guest could make the path, or a folder or a link that leads to it: the top missing folder is held.
            let top = physical;

            for (
                let up = dirname(top);
                inside(up, mount) && up.toLowerCase() !== mount.toLowerCase() && !existsSync(up);
                up = dirname(up)
            ) {
                top = up;
            }

            target = top;
            held = true;
        }

        if (target.toLowerCase() !== mount.toLowerCase()) {
            out.set(target.toLowerCase(), { path: target, tree: held });
        }

        // Every folder on the way is held as itself: it cannot be moved, removed, or made a link, though the files that
        // it holds besides stay the guest's.
        for (
            let up = dirname(physical);
            inside(up, mount) && up.toLowerCase() !== mount.toLowerCase();
            up = dirname(up)
        ) {
            if (existsSync(up) && !out.has(up.toLowerCase())) {
                out.set(up.toLowerCase(), { path: up, tree: false });
            }
        }

        if (held && isDirectory(physical)) {
            const out_ = linkOut(physical, roots);

            if (out_ !== undefined) {
                problems.push(
                    `${describe(entry, origin)}: ${out_}, so the guest could make git run its files`,
                );
            }
        }
    };

    // A config file inside the folder is configuration that the guest could write: every entry's file, used or not.
    for (const entry of entries) {
        if (entry.origin.startsWith("file:")) {
            hold(
                {
                    path: resolve(context.cwd, entry.origin.slice(5)),
                    raw: originText(context.cwd, entry),
                },
                false,
                entry,
                undefined,
            );
        }
    }

    for (const entry of effective(entries)) {
        const key = entry.key;
        const originFile = entry.origin.startsWith("file:")
            ? resolve(context.cwd, entry.origin.slice(5))
            : undefined;

        if (/^(include|includeif\..+)\.path$/.test(key)) {
            // Relative to the file that holds the directive; a missing file is read when it appears.
            const from =
                originFile === undefined ? context.cwd : dirname(originText(context.cwd, entry));

            for (const where of candidates(entry.value, [from], home)) {
                hold(where, false, entry, originFile);
            }

            continue;
        }

        if (key === "core.hookspath") {
            // Relative to where hooks run (the top of the working tree), and to the git directory: git reads hooks of a
            // push into the repository from there, whatever the repository is. Both are held.
            const hooks = [
                ...(context.top === undefined ? [] : [context.top]),
                ...(context.gitDir === undefined ? [] : [context.gitDir]),
            ];

            if (hooks.length === 0) {
                hooks.push(context.cwd);
            }

            for (const where of candidates(entry.value, hooks, home)) {
                hold(where, true, entry, originFile, true);
            }

            continue;
        }

        if (FILES.some((pattern) => pattern.test(key))) {
            for (const where of candidates(entry.value, bases, home)) {
                hold(where, false, entry, originFile);
            }

            continue;
        }

        if (commandValue(key, entry.value)) {
            for (const word of fileWords(entry.value, bases)) {
                for (const where of candidates(word, bases, home)) {
                    hold(where, false, entry, originFile);
                }
            }
        }
    }

    return { paths: [...out.values()], problems };
}

/** Git's own list of what the configuration says here, as entries: `git config --list --show-origin -z`. */
export function parseConfigList(output: string): ConfigEntry[] {
    const parts = output.split("\0");
    const entries: ConfigEntry[] = [];

    for (let index = 0; index + 1 < parts.length; index += 2) {
        const text = parts[index + 1]!;
        const newline = text.indexOf("\n");

        entries.push({
            origin: parts[index]!,
            key: newline === -1 ? text : text.slice(0, newline),
            value: newline === -1 ? "" : text.slice(newline + 1),
        });
    }

    return entries;
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
    const env: NodeJS.ProcessEnv = {};

    // Only what git needs to find its configuration: not a variable that points it somewhere else.
    for (const name of ["PATH", "HOME", "XDG_CONFIG_HOME", "USERPROFILE", "SystemRoot"]) {
        if (process.env[name] !== undefined) {
            env[name] = process.env[name];
        }
    }

    env.GIT_OPTIONAL_LOCKS = "0";
    env.GIT_TERMINAL_PROMPT = "0";

    return new Promise((resolvePromise) => {
        execFile(
            "git",
            args,
            { cwd, env, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => resolvePromise(error === null ? stdout : undefined),
        );
    });
}

/**
 * What the host's git reads or runs inside `mounts` for a session in `cwd`: asked of git itself, so that what the
 * owner's configuration says now is what counts. A folder that is no repository still has the global configuration.
 */
export async function gitExecPlan(
    cwd: string,
    mounts: readonly string[],
    home?: string,
): Promise<ExecPlan> {
    const listed = await git(cwd, ["config", "--list", "--show-origin", "-z"]);

    if (listed === undefined) {
        return { paths: [], problems: [] };
    }

    const where = (await git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]))?.split(
        "\n",
    );
    const top = where?.[0] === undefined || where[0] === "" ? undefined : where[0];
    const gitDir = where?.[1] === undefined || where[1] === "" ? undefined : where[1];

    return execPlan(parseConfigList(listed), {
        cwd,
        ...(top === undefined ? {} : { top }),
        ...(gitDir === undefined ? {} : { gitDir }),
        mounts,
        ...(home === undefined ? {} : { home }),
    });
}

/**
 * The paths that the guest may not write, as a VM asks for them: kept up to date from git's own list, at most once in
 * `every` ms and only when a VM is used. A path that the configuration names after the VM started is held from then on;
 * what the guest wrote there before is not undone.
 */
export async function gitExecPaths(
    cwd: string,
    mounts: readonly string[],
    home?: string,
): Promise<ExecPath[]> {
    return (await gitExecPlan(cwd, mounts, home)).paths;
}

export class GitExecGuard {
    readonly #cwd: string;
    readonly #mounts: readonly string[];
    readonly #every: number;
    readonly #home: string | undefined;
    #paths: readonly ExecPath[] = [];
    #problem: string | undefined;
    #at = 0;
    #loading: Promise<void> | undefined;

    constructor(cwd: string, mounts: readonly string[], every = 1000, home?: string) {
        this.#cwd = cwd;
        this.#mounts = mounts;
        this.#every = every;
        this.#home = home;
    }

    get paths(): readonly ExecPath[] {
        return this.#paths;
    }

    /** Why the folder cannot be shared as git is set up now (its hooks folder is the folder itself), or undefined. */
    get problem(): string | undefined {
        return this.#problem;
    }

    /** Read git's list again when it is older than `every` ms; `force` reads it now. */
    refresh(force = false): Promise<void> {
        if (this.#loading !== undefined) {
            return this.#loading;
        }

        if (!force && Date.now() - this.#at < this.#every) {
            return Promise.resolve();
        }

        this.#loading = gitExecPlan(this.#cwd, this.#mounts, this.#home)
            .then(({ paths, problems }) => {
                this.#problem = problems[0];
                const known = new Map(this.#paths.map((each) => [each.path.toLowerCase(), each]));

                // A path stays held after the configuration stops naming it: the guest cannot gain a write by a
                // change that is made and then undone.
                for (const each of paths) {
                    known.set(each.path.toLowerCase(), each);
                }

                this.#paths = [...known.values()];
                this.#at = Date.now();
            })
            .finally(() => {
                this.#loading = undefined;
            });

        return this.#loading;
    }

    /**
     * Whether `path` (below `root`, a mount, as the guest names it: `/`-separated from the mount's top) is held. The
     * same names as the host's file system gives, in lower case, so a case-insensitive one is no way round.
     */
    protects(root: string, path: string): boolean {
        const full = join(root, path).toLowerCase();

        return this.#paths.some((each) => {
            const held = each.path.toLowerCase();

            return full === held || (each.tree && full.startsWith(held + sep));
        });
    }
}
