/**
 * Git in Pocket's own folders (its install, its update state): as Pocket has always run it, without a file system
 * monitor or optional locks, in English. It is not for a session's folder: that takes `git` in `git.ts`, which hardens
 * Git where a sandboxed session works. This file imports only Node's modules, so the launcher can import it through
 * `update-state.ts`, and it is the one place besides `git.ts` that starts `git`.
 */
import { execFile, spawnSync } from "node:child_process";

export type GitOptions = {
    /** Exit codes besides 0 that still mean success. */
    allowExit?: number[];
    timeoutMs?: number;
    maxBuffer?: number;
    /** What to write to git's standard input. */
    input?: string;
    /** Paths are taken literally unless this is false (a command that is given globs). */
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

/** What the runner asks of a process, for a test to see and a caller to run. */
export type GitPlan = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

export function execute(planned: GitPlan, opts: GitOptions): Promise<string> {
    const { allowExit = [], timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024 } = opts;

    return new Promise((resolve, reject) => {
        const child = execFile(
            planned.command,
            planned.args,
            { cwd: planned.cwd, timeout: timeoutMs, maxBuffer, env: planned.env },
            (error, stdout, stderr) => {
                const code = typeof error?.code === "number" ? error.code : undefined;

                if (error === null || (code !== undefined && allowExit.includes(code))) {
                    resolve(stdout);
                } else {
                    reject(new GitError(stderr.trim() || error.message, code));
                }
            },
        );

        if (opts.input !== undefined) {
            // Git may exit before it reads its input; the callback above reports why.
            child.stdin!.on("error", () => {});
            child.stdin!.end(opts.input);
        }
    });
}

/** Run git in one of Pocket's own folders (its install): as it always was. Never a session's folder. */
export function gitOwn(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
    return execute(
        {
            command: "git",
            args: ["-c", "core.fsmonitor=false", ...args],
            cwd,
            env: {
                ...process.env,
                GIT_LITERAL_PATHSPECS: "1",
                GIT_OPTIONAL_LOCKS: "0",
                LC_ALL: "C",
            },
        },
        opts,
    );
}

/** Synchronous git in one of Pocket's own folders. */
export function gitOwnSync(
    cwd: string,
    args: string[],
    opts: {
        input?: string;
        env?: NodeJS.ProcessEnv;
        encoding?: "utf8" | "buffer";
        maxBuffer?: number;
    } = {},
) {
    return spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd,
        ...(opts.input === undefined ? {} : { input: opts.input }),
        ...(opts.encoding === "buffer" ? {} : { encoding: "utf8" as const }),
        timeout: 60_000,
        ...(opts.maxBuffer === undefined ? {} : { maxBuffer: opts.maxBuffer }),
        env: { ...process.env, LC_ALL: "C", ...opts.env },
    });
}
