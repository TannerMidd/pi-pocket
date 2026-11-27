/**
 * Git as Pi Pocket runs it for itself (Changes, branches, worktrees, the file list). A work tree is untrusted, as a
 * cloned repository is: what a guest writes there can steer git, so every call is held to the repository the folder is
 * known to be in. It runs without a file system monitor, without optional locks so it never gets in the way of Pi's own
 * git commands, with paths taken literally, and in English, so a failure can be told from another by what git says.
 * Git is told the repository (`GIT_DIR`, `GIT_WORK_TREE`), never finds one by itself in a folder a guest can write
 * (`safe.bareRepository=explicit`, `GIT_CEILING_DIRECTORIES`), and runs none of the clean, smudge, and process filters
 * that the configuration defines: a `.gitattributes` in the work tree chooses a filter, and a filter is a program.
 */
import { execFile } from "node:child_process";
import { dirname } from "node:path";

export type GitOptions = {
    /** Exit codes besides 0 that still mean success. */
    allowExit?: number[];
    timeoutMs?: number;
    maxBuffer?: number;
    /** Written to git's standard input. */
    input?: string;
    /** Whether a path names itself (the default), or may be a pattern, as `check-ignore` takes names. */
    literalPaths?: boolean;
};

/** A git command that failed, with what git said (or why it did not run) as its message. */
export class GitError extends Error {
    /** Git's exit code; undefined when it did not get to exit (a timeout, or no git). */
    readonly exitCode: number | undefined;

    constructor(message: string, exitCode: number | undefined) {
        super(message);
        this.exitCode = exitCode;
    }
}

/** The variables that choose a repository, an index, or objects: git is told them by Pi Pocket, never by what runs it. */
const REPOSITORY_VARIABLES = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

const HARDENING = ["-c", "core.fsmonitor=false", "-c", "safe.bareRepository=explicit"];

/** How long a repository, and the filters its configuration defines, are remembered: a burst of calls asks git once. */
const KEEP_MS = 3_000;
const KEPT = 64;

type Repository = { gitDir: string; workTree: string };

function run(
    cwd: string,
    args: string[],
    env: Record<string, string>,
    {
        allowExit = [],
        timeoutMs = 60_000,
        maxBuffer = 16 * 1024 * 1024,
        input,
        literalPaths = true,
    }: GitOptions,
): Promise<string> {
    const base = { ...process.env };

    for (const name of REPOSITORY_VARIABLES) {
        delete base[name];
    }

    return new Promise((resolve, reject) => {
        const child = execFile(
            "git",
            [...HARDENING, ...args],
            {
                cwd,
                timeout: timeoutMs,
                maxBuffer,
                env: {
                    ...base,
                    GIT_LITERAL_PATHSPECS: literalPaths ? "1" : "0",
                    GIT_OPTIONAL_LOCKS: "0",
                    LC_ALL: "C",
                    ...env,
                },
            },
            (error, stdout, stderr) => {
                const code = typeof error?.code === "number" ? error.code : undefined;

                if (error === null || (code !== undefined && allowExit.includes(code))) {
                    resolve(stdout);
                } else {
                    reject(new GitError(stderr.trim() || error.message, code));
                }
            },
        );

        // Git may exit before it reads its input: the callback above reports why.
        child.stdin!.on("error", () => {});
        child.stdin!.end(input);
    });
}

const kept = new Map<string, { at: number; value: Promise<unknown> }>();

function remember<T>(key: string, make: () => Promise<T>): Promise<T> {
    const known = kept.get(key);

    if (known !== undefined && Date.now() - known.at < KEEP_MS) {
        return known.value as Promise<T>;
    }

    const value = make();

    kept.set(key, { at: Date.now(), value });

    value.catch(() => {
        if (kept.get(key)?.value === value) {
            kept.delete(key);
        }
    });

    if (kept.size > KEPT) {
        kept.delete(kept.keys().next().value!);
    }

    return value;
}

/** The repository `cwd` is in, or undefined when it is in none that git finds without looking at a bare one. */
function repositoryOf(cwd: string): Promise<Repository | undefined> {
    return remember(`repository\0${cwd}`, async () => {
        try {
            const [gitDir, workTree] = (
                await run(cwd, ["rev-parse", "--absolute-git-dir", "--show-toplevel"], {}, {})
            )
                .split("\n")
                .filter((line) => line !== "");

            return gitDir === undefined || workTree === undefined
                ? undefined
                : { gitDir, workTree };
        } catch {
            return undefined;
        }
    });
}

/** `-c filter.<name>.<setting>=` for every filter the configuration defines, so none runs. */
function withoutFilters(repository: Repository): Promise<string[]> {
    return remember(`filters\0${repository.gitDir}`, async () => {
        const out = await run(
            repository.workTree,
            ["config", "--null", "--name-only", "--get-regexp", "^filter\\."],
            { GIT_DIR: repository.gitDir, GIT_WORK_TREE: repository.workTree },
            { allowExit: [1] },
        );
        const names = new Set<string>();

        for (const key of out.split("\0")) {
            const name = key.slice("filter.".length, key.lastIndexOf("."));

            if (key.startsWith("filter.") && name !== "") {
                names.add(name);
            }
        }

        return [...names].flatMap((name) =>
            ["clean", "smudge", "process"]
                .map((setting) => `filter.${name}.${setting}=`)
                .concat(`filter.${name}.required=false`)
                .flatMap((setting) => ["-c", setting]),
        );
    });
}

/** Run git in `cwd` and return what it printed. */
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
    const repository = await repositoryOf(cwd);

    if (repository === undefined) {
        return run(cwd, args, {}, options);
    }

    return run(
        cwd,
        [...(await withoutFilters(repository)), ...args],
        {
            GIT_DIR: repository.gitDir,
            GIT_WORK_TREE: repository.workTree,
            GIT_CEILING_DIRECTORIES: dirname(repository.workTree),
        },
        options,
    );
}
