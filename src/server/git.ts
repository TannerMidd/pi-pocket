/**
 * Git as Pi Pocket runs it for itself (Changes, branches, worktrees): without a file system monitor, without optional
 * locks so it never gets in the way of Pi's own git commands, with paths taken literally (a file named `*` is that
 * file, not every file), and in English, so a failure can be told from another by what git says. Programs a
 * repository configures, such as clean and smudge filters, still run, as they do for any git command there.
 */
import { execFile } from "node:child_process";

/** What every git command here starts with, before its own arguments. */
export const GIT_ARGS = ["-c", "core.fsmonitor=false"] as const;

/** What every git command here has in its environment, besides the usual. */
export const GIT_ENV = {
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
} as const;

/** How long a git command may take, and how much it may print, unless its caller says otherwise. */
export const GIT_TIMEOUT_MS = 60_000;
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export type GitOptions = {
    /** Exit codes besides 0 that still mean success. */
    allowExit?: number[];
    timeoutMs?: number;
    maxBuffer?: number;
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

/** Run git in `cwd` and return what it printed. */
export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
    const { allowExit = [], timeoutMs = GIT_TIMEOUT_MS, maxBuffer = GIT_MAX_BUFFER } = options;

    return new Promise((resolve, reject) => {
        execFile(
            "git",
            [...GIT_ARGS, ...args],
            {
                cwd,
                timeout: timeoutMs,
                maxBuffer,
                env: { ...process.env, ...GIT_ENV },
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
    });
}
