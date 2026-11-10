/**
 * Which repository a session's folder is a checkout of: its `origin` remote, in one form for every way to write it
 * (`git@host:a/b.git`, `https://user:token@Host/a/b`, `ssh://git@host:22/a/b` are all `host/a/b`), without the user
 * name or token a URL can carry. A copy of a session to another computer finds the same repository there by it
 * (`commands.ts` `copyPlace`). Looking it up never holds anything up: it has a short time limit, and any failure (no
 * git, no remote, a computer that is offline) is no repository.
 */
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { git } from "./git.ts";

/** How long the lookup may take. */
const REPO_MS = 3000;

/**
 * A remote's URL in the form repositories are matched by: `host/path`, the host in lower case, without a scheme, user,
 * password, port, `.git`, or slashes at the ends. A local path stays a path. Undefined when there is nothing to match.
 */
export function normalizeRemote(url: string): string | undefined {
    const text = url.trim();

    if (text === "" || /[\u0000-\u001f\u007f]/.test(text)) {
        return undefined;
    }

    let host: string;
    let path: string;
    const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(text);
    // `[user@]host:path`, as ssh and git write it; not `C:\x` (a Windows path) or a URL.
    const scp = scheme === null ? /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)(.+)$/.exec(text) : null;

    if (scheme !== null) {
        if (scheme[1]!.toLowerCase() === "file") {
            return stripped(scheme[3] ?? "");
        }

        // What is before the last `@` is a user name, maybe with a password or token: never kept.
        const authority = scheme[2]!.slice(scheme[2]!.lastIndexOf("@") + 1);

        host = authority.replace(/:\d*$/, "");
        path = scheme[3] ?? "";
    } else if (scp !== null) {
        host = scp[1]!;
        path = scp[2]!;
    } else {
        return stripped(text);
    }

    const rest = stripped(path.replace(/^\/+/, ""));

    if (host === "" || rest === undefined) {
        return undefined;
    }

    return `${host.toLowerCase()}/${rest}`;
}

/** A path without slashes at its end or `.git`; undefined when nothing is left. */
function stripped(path: string): string | undefined {
    const trimmed = path
        .replace(/[\\/]+$/, "")
        .replace(/\.git$/i, "")
        .replace(/[\\/]+$/, "");

    return trimmed === "" ? undefined : trimmed;
}

/** Wait at most `ms` for `promise`; undefined when it takes longer or fails. */
function within<T>(promise: Promise<T | undefined>, ms: number): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;

    return Promise.race([
        promise.catch(() => undefined),
        new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

/** The repository of folder `cwd` on this machine. */
export function localRepo(cwd: string): Promise<string | undefined> {
    return within(
        git(cwd, ["remote", "get-url", "origin"], { timeoutMs: REPO_MS }).then(normalizeRemote),
        REPO_MS,
    );
}

/** The repository of folder `cwd` on another computer, by one `git` command run there through its environment. */
export function remoteRepo(
    env: ExecutionEnv,
    cwd: string,
    context: Context,
): Promise<string | undefined> {
    return remoteGit(env, cwd, ["remote", "get-url", "origin"], context).then((output) =>
        output === undefined ? undefined : normalizeRemote(output),
    );
}

/** A short git lookup on another computer; no shell, and no repository when it fails or times out. */
export function remoteGit(
    env: ExecutionEnv,
    cwd: string,
    args: string[],
    context: Context,
): Promise<string | undefined> {
    let output = "";

    return within(
        env
            .exec(
                ["git", ...args],
                {
                    cwd,
                    timeout: REPO_MS / 1000,
                    onOutput: (text, _context, info) => {
                        if (info.stream === "stdout" && output.length < 4096) {
                            output += text;
                        }
                    },
                },
                context,
            )
            .then((result) =>
                result.ok && result.value.exitCode === 0 ? output.trim() : undefined,
            ),
        REPO_MS,
    );
}
