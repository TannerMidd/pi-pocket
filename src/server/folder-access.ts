/**
 * A session's folder as the app's panels reach it (Files, the file viewer, Changes, branches): on this machine, or on
 * the computer a session runs on (`runners.ts`). Each way does the same few things: git, a file's size and time, a
 * file's first bytes, a folder's entries, its real path, and removing a file. On this machine they are Node's own calls,
 * as before; on another computer each goes through its pi-env daemon, and never falls back to this machine's disk.
 *
 * The link to another computer can be slow (a laptop on Wi-Fi), so its way spends few round trips: git runs there as
 * one command, a file is opened and read in one go, and nothing is read that the caller did not ask for.
 */
import { devNull } from "node:os";
import * as nodePath from "node:path";
import { posix, win32 } from "node:path";
import { lstat, open, opendir, realpath, rm, stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { isConnectionLost, type RemoteInfo } from "@earendil-works/pi-env";
import type { ExecutionEnv, FileError } from "@earendil-works/pi-durable/env";
import {
    GIT_ARGS,
    GIT_ENV,
    GIT_MAX_BUFFER,
    GIT_TIMEOUT_MS,
    GitError,
    type GitOptions,
    git as runGit,
} from "./git.ts";

export type PathKit = typeof posix;

/** What a path is, without following a link at its end: `other` is a pipe, a device, or a socket. */
export type FolderInfo = {
    kind: "file" | "directory" | "symlink" | "other";
    size: number;
    mtimeMs: number;
};

/** A file's start, following links: a folder or other kind has no bytes. */
export type Peek =
    | { kind: "directory" | "other"; size: number }
    | { kind: "file"; size: number; mtimeMs: number; bytes: Buffer };

export type FolderEntries = { entries: { name: string; dir: boolean }[]; more: boolean };

export type FolderAccess = {
    /** Which disk: the same for every folder on one machine. Empty for this machine. */
    readonly id: string;
    /** That machine's path rules (`/` or `\`). */
    readonly path: PathKit;
    /** What git takes for "no file" on that machine. */
    readonly devNull: string;
    /** Run git in `cwd`, as `git.ts` does here: its output, or a `GitError` with what git said. */
    git(cwd: string, args: string[], options?: GitOptions): Promise<string>;
    /** What a path is, like `lstat`. Throws an error with Node's code (`ENOENT`) when it is not there. */
    info(path: string): Promise<FolderInfo>;
    realpath(path: string): Promise<string>;
    /** Remove a file; one already gone is fine. */
    remove(path: string): Promise<void>;
    /** What a path is, following links, and for a regular file its first `maxBytes` bytes. */
    peek(path: string, maxBytes: number): Promise<Peek>;
    /** At most `limit` entries of a folder, unsorted; `more` when some were left, or `deadline` passed. */
    list(path: string, limit: number, deadline?: number): Promise<FolderEntries>;
    /**
     * The files under a folder, without hidden ones or `exclude`, nearest the machine when it can list them itself;
     * undefined when it cannot, so the caller walks the folder instead.
     */
    listFiles?(
        path: string,
        options: { exclude: readonly string[]; max: number; timeoutMs: number },
    ): Promise<{ files: string[]; truncated: boolean } | undefined>;
};

/**
 * The computer a folder is on could not be reached (offline, removed, or not answering): not a failure of git or of a
 * file, so no caller takes it for "no repository" or "no such file", or tries another way.
 */
export class Unreachable extends Error {}

/** An error with the code Node gives the same failure, so callers tell "not there" apart as they do here. */
function nodeError(error: FileError | Error): NodeJS.ErrnoException {
    const codes: Record<string, string> = {
        not_found: "ENOENT",
        permission_denied: "EACCES",
        not_directory: "ENOTDIR",
        is_directory: "EISDIR",
    };
    const failure: NodeJS.ErrnoException = new Error(error.message);
    const code = codes[(error as FileError).code ?? ""];

    if (code !== undefined) {
        failure.code = code;
    }

    return failure;
}

const kindOf = (info: {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}): FolderInfo["kind"] =>
    info.isDirectory()
        ? "directory"
        : info.isSymbolicLink()
          ? "symlink"
          : info.isFile()
            ? "file"
            : "other";

/** This machine's disk, through Node, exactly as the panels read it before other computers. */
export const localAccess: FolderAccess = {
    id: "",
    path: nodePath,
    devNull,
    git: runGit,

    async info(path) {
        const info = await lstat(path);

        return { kind: kindOf(info), size: info.size, mtimeMs: info.mtimeMs };
    },

    realpath: (path) => realpath(path),

    async remove(path) {
        await rm(path, { force: true });
    },

    async peek(path, maxBytes) {
        const info = await stat(path);

        // A pipe or a device would never finish reading: only regular files are opened.
        if (!info.isFile()) {
            return { kind: info.isDirectory() ? "directory" : "other", size: info.size };
        }

        if (maxBytes <= 0) {
            return { kind: "file", size: info.size, mtimeMs: info.mtimeMs, bytes: Buffer.alloc(0) };
        }

        const handle = await open(path, "r");

        try {
            const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

            return {
                kind: "file",
                size: info.size,
                mtimeMs: info.mtimeMs,
                bytes: buffer.subarray(0, bytesRead),
            };
        } finally {
            await handle.close();
        }
    },

    async list(path, limit, deadline = Number.POSITIVE_INFINITY) {
        const entries: { name: string; dir: boolean }[] = [];
        const dir = await opendir(path, { bufferSize: 256 });

        // Leaving the loop early closes the folder.
        for await (const entry of dir) {
            if (
                entries.length >= limit ||
                ((entries.length & 1023) === 1023 && Date.now() > deadline)
            ) {
                return { entries, more: true };
            }

            entries.push({ name: entry.name, dir: entry.isDirectory() });
        }

        return { entries, more: false };
    },
};

/** Margin past git's own time limit before a command that never started (a link that is away) is given up. */
const START_MARGIN_MS = 5000;

/**
 * A folder on another computer, through its environment (`RunnerEnv`). `info` is what its daemon said when it
 * connected: which path rules it has.
 */
export function remoteAccess(env: ExecutionEnv, info: Pick<RemoteInfo, "os">): FolderAccess {
    const context = BACKGROUND_CONTEXT;
    const windows = info.os === "windows";

    const fail = (error: FileError | Error): never => {
        // A failure of the link, not of the file: pi-env keeps the link's error as the cause.
        if (isConnectionLost(error.cause)) {
            throw new Unreachable(error.message);
        }

        throw nodeError(error);
    };

    return {
        id: env.id,
        path: windows ? win32 : posix,
        // Git takes this name as "no file" on every system.
        devNull: "/dev/null",

        async git(cwd, args, options = {}) {
            const {
                allowExit = [],
                timeoutMs = GIT_TIMEOUT_MS,
                maxBuffer = GIT_MAX_BUFFER,
            } = options;
            const run = withCancel(context);
            let stdout = "";
            let stderr = "";
            let bytes = 0;
            let tooMuch = false;
            // The daemon's time limit counts from when git starts; this one also covers a request that waits for a
            // computer that dropped for a moment.
            const timer = setTimeout(() => run.cancel(), timeoutMs + START_MARGIN_MS);

            try {
                const result = await env.exec(
                    ["git", ...GIT_ARGS, ...args],
                    {
                        cwd,
                        env: { ...GIT_ENV },
                        timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
                        onOutput: (text, _context, { stream }) => {
                            if (stream === "stderr") {
                                stderr += text;

                                return;
                            }

                            bytes += Buffer.byteLength(text);

                            if (bytes > maxBuffer) {
                                tooMuch = true;
                                run.cancel();

                                return;
                            }

                            stdout += text;
                        },
                    },
                    run.context,
                );

                if (tooMuch) {
                    throw new GitError(`git printed more than ${maxBuffer} bytes`, undefined);
                }

                if (!result.ok) {
                    const { code, message } = result.error;

                    // No git there, as `git.ts` says when there is none here.
                    if (code === "spawn_error" || code === "shell_unavailable") {
                        throw new GitError(message, undefined);
                    }

                    if (code === "timeout") {
                        throw new GitError(
                            `git took longer than ${Math.round(timeoutMs / 1000)} s`,
                            undefined,
                        );
                    }

                    // Aborted here (the computer did not answer in time), or the link failed: "is offline".
                    throw new Unreachable(
                        code === "aborted" ? "The computer did not answer in time." : message,
                    );
                }

                const code = result.value.exitCode;

                if (code === 0 || allowExit.includes(code)) {
                    return stdout;
                }

                throw new GitError(stderr.trim() || `git exited with code ${code}`, code);
            } finally {
                clearTimeout(timer);
            }
        },

        async info(path) {
            const found = await env.fileInfo(path, context);

            return found.ok
                ? { kind: found.value.kind, size: found.value.size, mtimeMs: found.value.mtimeMs }
                : fail(found.error);
        },

        async realpath(path) {
            const found = await env.canonicalPath(path, context);

            return found.ok ? found.value : fail(found.error);
        },

        async remove(path) {
            const removed = await env.remove(path, { force: true }, context);

            if (!removed.ok) {
                fail(removed.error);
            }
        },

        async peek(path, maxBytes) {
            // Opened first: the daemon refuses a folder or a pipe, and the file's size and its start come together.
            const opened = await env.openBinaryReader(path, undefined, context);

            if (!opened.ok) {
                if (opened.error.code === "is_directory") {
                    return { kind: "directory", size: 0 };
                }

                if (opened.error.code === "invalid") {
                    const found = await env.fileInfo(path, context);

                    return { kind: "other", size: found.ok ? found.value.size : 0 };
                }

                return fail(opened.error);
            }

            const reader = opened.value;

            try {
                const [info, read] = await Promise.all([
                    reader.info(context),
                    maxBytes > 0 ? reader.read(0, maxBytes, context) : undefined,
                ]);

                if (!info.ok) {
                    return fail(info.error);
                }

                if (read !== undefined && !read.ok) {
                    return fail(read.error);
                }

                return {
                    kind: "file",
                    size: info.value.size,
                    mtimeMs: info.value.mtimeMs,
                    bytes: read === undefined ? Buffer.alloc(0) : Buffer.from(read.value),
                };
            } finally {
                // Nothing waits for the file to close.
                void reader.close(context).catch(() => {});
            }
        },

        async list(path, limit, deadline = Number.POSITIVE_INFINITY) {
            const opened = await env.openDirReader(path, context);

            if (!opened.ok) {
                return fail(opened.error);
            }

            const reader = opened.value;
            const entries: { name: string; dir: boolean }[] = [];

            try {
                while (true) {
                    // One past the limit says whether there are more.
                    const page = await reader.next(limit + 1 - entries.length, context);

                    if (!page.ok) {
                        return fail(page.error);
                    }

                    for (const entry of page.value.entries) {
                        entries.push({ name: entry.name, dir: entry.kind === "directory" });
                    }

                    if (entries.length > limit) {
                        return { entries: entries.slice(0, limit), more: true };
                    }

                    if (page.value.done) {
                        return { entries, more: false };
                    }

                    if (Date.now() > deadline) {
                        return { entries, more: true };
                    }
                }
            } finally {
                void reader.close(context).catch(() => {});
            }
        },

        async listFiles(path, options) {
            if (env.listFiles === undefined) {
                return undefined;
            }

            const listed = await env.listFiles(
                path,
                {
                    hidden: false,
                    gitignore: false,
                    exclude: options.exclude,
                    maxEntries: options.max,
                    timeoutMs: options.timeoutMs,
                },
                context,
            );

            if (!listed.ok) {
                // A daemon older than `listFiles`: the caller walks the folder there instead.
                return listed.error.code === "not_supported" ? undefined : fail(listed.error);
            }

            return {
                files: listed.value.entries
                    .filter((entry) => entry.kind !== "directory")
                    .map((entry) => entry.path),
                truncated: listed.value.truncated,
            };
        },
    };
}
