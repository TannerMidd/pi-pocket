/**
 * Git as Pi Pocket runs it for itself (Changes, branches, worktrees): without a file system monitor, without optional
 * locks so it never gets in the way of Pi's own git commands, with paths taken literally (a file named `*` is that
 * file, not every file), and in English, so a failure can be told from another by what git says. Programs a
 * repository configures, such as clean and smudge filters, still run, as they do for any git command there.
 *
 * This is the one hardened Git runner: no other file starts `git` or `gh` (`test/source-hostfs.test.ts`). In a folder
 * that no sandboxed session uses (a plain folder) it runs exactly as it always did. In a **sandboxed folder** the guest
 * wrote the work tree, so Git there runs with nothing the guest can name:
 * - the absolute `git` that was found once at start (a relative or empty `PATH` entry means the server's folder, and
 *   is ignored), at Git 2.40 or later: an older Git is refused, never run without `--attr-source`;
 * - `--git-dir` and `--work-tree` pinned, found by a descriptor walk, so nothing discovers a repository in the guest;
 * - every `GIT_*` variable of the server removed, and the hardened ones set;
 * - `safe.bareRepository=explicit`, `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `core.attributesFile=/dev/null`,
 *   `GIT_ATTR_NOSYSTEM`, and `--attr-source` set to the empty tree, so a guest `.gitattributes` names no filter.
 * `gh` runs Git itself, so `runGh` (`github.ts`) takes the same environment and gate from here.
 */
import { execFileSync } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
import { execute, GitError, type GitOptions, type GitPlan } from "./git-own.ts";
import {
    above,
    accessSync,
    constants,
    FolderRef,
    folderPath,
    lstat,
    readText,
    type Place,
} from "./hostfs.ts";

/** The tree with nothing in it. Git knows it in every repository, whether or not the object is stored. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** `--attr-source` and `GIT_ATTR_SOURCE` came with this Git. */
export const MIN_GIT: readonly [number, number] = [2, 40];

/** The `git` that was found: its absolute path and its version. */
export type GitBinary = { path: string; version: readonly [number, number, number] };

/** The directories of `PATH` that can be trusted to mean one place: absolute ones. */
export function absolutePath(path: string | undefined = process.env.PATH): string[] {
    return (path ?? "").split(delimiter).filter((entry) => entry !== "" && isAbsolute(entry));
}

function executable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);

        return true;
    } catch {
        return false;
    }
}

/** The first absolute `git` on the absolute entries of `PATH`; undefined when there is none. */
export function findGit(path: string | undefined = process.env.PATH): string | undefined {
    for (const folder of absolutePath(path)) {
        const candidate = join(folder, process.platform === "win32" ? "git.exe" : "git");

        if (executable(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

export function parseVersion(text: string): [number, number, number] | undefined {
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);

    return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** Whether `version` is at least `MIN_GIT`. */
export const versionOk = (version: readonly number[]): boolean =>
    version[0]! > MIN_GIT[0] || (version[0] === MIN_GIT[0] && version[1]! >= MIN_GIT[1]);

function locate(): GitBinary {
    const path = findGit();

    if (path === undefined) {
        throw new GitError(
            "git is not installed here, or is not on an absolute entry of PATH, so Git is not run in a sandboxed folder.",
            undefined,
        );
    }

    let said: string;

    try {
        said = execFileSync(path, ["--version"], {
            encoding: "utf8",
            timeout: 10_000,
            env: { PATH: absolutePath().join(delimiter), LC_ALL: "C" },
        });
    } catch {
        throw new GitError(
            `git at ${path} did not say its version, so Git is not run in a sandboxed folder.`,
            undefined,
        );
    }

    const version = parseVersion(said);

    if (version === undefined) {
        throw new GitError(
            `git at ${path} said "${said.trim().slice(0, 80)}", which has no version.`,
            undefined,
        );
    }

    return { path, version };
}

/** The environment of a sandboxed folder's Git: no `GIT_*` of the server's, and the hardened ones. */
export function hardenedEnv(literalPaths = true): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};

    for (const [name, value] of Object.entries(process.env)) {
        if (!/^GIT_/i.test(name) && name !== "PATH") {
            env[name] = value;
        }
    }

    return {
        ...env,
        PATH: absolutePath().join(delimiter),
        ...(literalPaths ? { GIT_LITERAL_PATHSPECS: "1" } : {}),
        GIT_OPTIONAL_LOCKS: "0",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
    };
}

/** The configuration that a sandboxed folder's Git never takes from the guest's work tree. */
export const HARDENED_CONFIG: readonly (readonly [string, string])[] = [
    ["core.fsmonitor", "false"],
    ["core.hooksPath", "/dev/null"],
    ["safe.bareRepository", "explicit"],
    ["core.attributesFile", "/dev/null"],
];

/** The same configuration as `GIT_CONFIG_COUNT` variables, for a program (`gh`) that runs Git and cannot be given `-c`. */
export function hardenedConfigEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(HARDENED_CONFIG.length) };

    HARDENED_CONFIG.forEach(([key, value], index) => {
        env[`GIT_CONFIG_KEY_${index}`] = key;
        env[`GIT_CONFIG_VALUE_${index}`] = value;
    });

    return env;
}

/** Where a sandboxed folder's repository is, and its work tree: the directories as the host names them. */
export type Repository = { gitDir: string; workTree: string };

const MAX_POINTER = 4096;

/**
 * The repository that holds `folder`, found by a descriptor walk (nothing is followed), up through each folder until
 * `/`. A `.git` that is a link is refused: it names nothing that can be trusted. A `.git` file names a git dir.
 */
export function findRepository(folder: FolderRef): Repository | undefined {
    let at: Place = folder.at("");

    for (let depth = 0; depth < 256; depth++) {
        const dotGit = at.child(".git");
        const shown = at.display.text;
        let info;

        try {
            info = dotGitInfo(dotGit);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EACCES") {
                throw new GitError(
                    `${dotGit.display.text} is a link, so Git is not run there.`,
                    128,
                );
            }

            throw error;
        }

        if (info === "link") {
            throw new GitError(`${dotGit.display.text} is a link, so Git is not run there.`, 128);
        }

        if (info === "folder") {
            return { gitDir: dotGit.display.text, workTree: shown };
        }

        if (info === "file") {
            const pointer = /^gitdir: (.+)$/m.exec(readText(dotGit, { max: MAX_POINTER }));

            if (pointer !== null) {
                const named = pointer[1]!.trim();

                return { gitDir: isAbsolute(named) ? named : join(shown, named), workTree: shown };
            }
        }

        const up: Place | undefined = above(at, folder.host);

        if (up === undefined) {
            return undefined;
        }

        at = up;
    }

    return undefined;
}

function dotGitInfo(place: Place): "folder" | "file" | "link" | undefined {
    try {
        const found = lstat(place, { throwIfNoEntry: false });

        return found === undefined
            ? undefined
            : found.isSymbolicLink()
              ? "link"
              : found.isDirectory()
                ? "folder"
                : found.isFile()
                  ? "file"
                  : undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw error;
    }
}

export type GitRunnerOptions = {
    /** Where git is found. Default: the first absolute `git` on `PATH`, looked up once. */
    resolve?: () => GitBinary;
};

export { GitError, gitOwn, gitOwnSync, type GitOptions, type GitPlan } from "./git-own.ts";

export type GitRunner = ReturnType<typeof createGitRunner>;

/** The Git runner. One per process in production (`git`, `gitOwn`); tests make their own with a fake `git` lookup. */
export function createGitRunner(options: GitRunnerOptions = {}) {
    const find = options.resolve ?? locate;
    let binary: GitBinary | undefined;
    let failure: GitError | undefined;

    /** The absolute `git`, resolved once. A failure is kept: it is not tried again on each call. */
    function resolved(): GitBinary {
        if (failure !== undefined) {
            throw failure;
        }

        try {
            binary ??= find();
        } catch (error) {
            failure = error instanceof GitError ? error : new GitError(String(error), undefined);

            throw failure;
        }

        return binary;
    }

    /** The process that runs `args` in `folder`: plain as ever, or hardened when a sandboxed session uses the folder. */
    function plan(folder: FolderRef, args: string[], opts: GitOptions = {}): GitPlan {
        const literal = opts.literalPaths !== false;

        if (!folder.sandboxed) {
            return {
                command: "git",
                args: [
                    "-c",
                    "core.fsmonitor=false",
                    ...(literal ? [] : ["--no-literal-pathspecs"]),
                    ...args,
                ],
                cwd: folderPath(folder),
                env: {
                    ...process.env,
                    ...(literal ? { GIT_LITERAL_PATHSPECS: "1" } : {}),
                    GIT_OPTIONAL_LOCKS: "0",
                    LC_ALL: "C",
                },
            };
        }

        const git = resolved();

        if (!versionOk(git.version)) {
            throw new GitError(
                `Git ${git.version.join(".")} is older than ${MIN_GIT.join(".")}, which Pocket needs to run Git in a sandboxed folder. Update Git, or turn the sandbox off.`,
                undefined,
            );
        }

        const repository = findRepository(folder);

        if (repository === undefined) {
            throw new GitError(
                "fatal: not a git repository (or any of the parent directories): .git",
                128,
            );
        }

        return {
            command: git.path,
            args: [
                `--git-dir=${repository.gitDir}`,
                `--work-tree=${repository.workTree}`,
                `--attr-source=${EMPTY_TREE}`,
                ...HARDENED_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
                ...(literal ? [] : ["--no-literal-pathspecs"]),
                ...args,
            ],
            cwd: folderPath(folder),
            env: hardenedEnv(literal),
        };
    }

    /** Run git in a session's folder and return what it printed. */
    function git(folder: FolderRef, args: string[], opts: GitOptions = {}): Promise<string> {
        let planned: GitPlan;

        try {
            planned = plan(folder, args, opts);
        } catch (error) {
            return Promise.reject(error);
        }

        return execute(planned, opts);
    }

    return { plan, git, resolved };
}

const runner = createGitRunner();

/** Git in a session's folder. */
export const git = runner.git;
/** The process that `git` would run, for the places that must see it (a test, `runGh`). */
export const planGit = runner.plan;
/** The one `git` of this process: found once, at Git 2.40 or later for sandboxed folders. */
export const gitBinary = runner.resolved;
