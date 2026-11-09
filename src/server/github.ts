/**
 * GitHub through the `gh` command signed in on this machine: running it with nobody there to answer, naming
 * repositories and pull requests in each way people write them, and whether its account can push to a repository.
 * PR watches (`watches.ts`), repository watches (`repo-watches.ts`), and PiP's checkouts (`pip.ts`) use it. Pi and PiP
 * act on GitHub only where `gh`'s account can push: a repository named in a page or a post that is someone else's
 * would let them hand Pi work.
 */
import { execFile } from "node:child_process";
import { describe, HttpError } from "./errors.ts";
import { git } from "./git.ts";
import { snippet } from "./projection.ts";

/** Runs `gh` with arguments, in a folder; resolves to what it printed, or rejects with what it said went wrong. */
export type Gh = (args: string[], cwd?: string, timeoutMs?: number) => Promise<string>;

const GH_TIMEOUT_MS = 60_000;

/** The `gh` on this machine, never asking anything: watches run with nobody there to answer. */
export const runGh: Gh = (args, cwd, timeoutMs = GH_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
        execFile(
            "gh",
            args,
            {
                ...(cwd === undefined ? {} : { cwd }),
                timeout: timeoutMs,
                maxBuffer: 64 * 1024 * 1024,
                env: {
                    ...process.env,
                    GH_PROMPT_DISABLED: "1",
                    GH_NO_UPDATE_NOTIFIER: "1",
                    GIT_TERMINAL_PROMPT: "0",
                    NO_COLOR: "1",
                    CLICOLOR: "0",
                },
            },
            (error, stdout, stderr) => {
                if (error === null) {
                    return resolve(stdout);
                }

                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    return reject(
                        new Error(
                            "GitHub's gh command is not installed here. Install it, then sign in with gh auth login.",
                        ),
                    );
                }

                const said = String(stderr).trim().split("\n").at(-1) ?? "";

                reject(new Error(snippet(said || error.message, 300)));
            },
        );
    });

/** A repository for `gh --repo`, its host for `gh api --hostname` (none: github.com), and its `owner/name`. */
export function repoArgs(repo: string): { repo: string; host?: string; path: string } {
    const parts = repo.split("/");

    return parts.length === 3
        ? { repo, host: parts[0]!, path: `${parts[1]}/${parts[2]}` }
        : { repo, path: repo };
}

/** `gh api` for a repository's host. */
export const apiArgs = (repo: string, ...rest: string[]): string[] => {
    const { host } = repoArgs(repo);

    return ["api", ...(host === undefined ? [] : ["--hostname", host]), ...rest];
};

/** The repository of a PR, from its address: `owner/name`, with the host when it is not github.com. */
export function repoOfUrl(url: string): string {
    // The whole address, and nothing after its number: it is stored, and Pi reads it.
    const match = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/\d{1,9}$/.exec(url);
    const repo = match === null ? undefined : joined(match[1], match[2]!, match[3]!);

    if (repo === undefined) {
        throw new HttpError(400, `${snippet(url, 200)} is not a pull request's address.`);
    }

    return repo;
}

/**
 * What may name a branch, as people give it and as GitHub's answers must: what git allows (`release@2024`, `v1+hotfix`,
 * `über`), but on one line, with no quote, never an option (`-`), and none of what git forbids: `..`, `@{`, `//`, a `/`
 * or `.` at either end, `.lock` at the end, and `\ ~ ^ : ? * [`.
 */
export const BRANCH =
    /^(?![-/.])(?!.*(?:\.\.|@\{|\/\/|\/\.))(?!.*(?:[/.]|\.lock)$)(?!@$)[^\s\p{Cc}\p{Cf}\\~^:?*["'`\u201c\u201d\u2018\u2019]{1,255}$/u;

const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(:\d+)?$/;

/** `owner/name`, or `host/owner/name` off github.com, from the parts of a repository's name; undefined if they will not do. */
function joined(host: string | undefined, owner: string, name: string): string | undefined {
    const bare = name.replace(/\.git$/, "");

    // `.` and `..` would name a folder above the clone's (`repos/<owner>/<name>`), and GitHub has no such repository.
    if (
        !SEGMENT.test(owner) ||
        !SEGMENT.test(bare) ||
        [owner, bare].some((part) => part === "." || part === "..")
    ) {
        return undefined;
    }

    if (host === undefined || host.toLowerCase() === "github.com") {
        return `${owner}/${bare}`;
    }

    return HOST.test(host) ? `${host}/${owner}/${bare}` : undefined;
}

/**
 * A repository as people and git write it: `owner/name`, `host/owner/name`, its web address (or any page in it), or a
 * git remote (`git@host:owner/name.git`, `ssh://…`). Undefined for anything else.
 */
export function parseRepo(text: string): string | undefined {
    const value = text.trim().replace(/\/+$/, "");
    let match = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s#?]+)/.exec(value);

    if (match !== null) {
        return joined(match[1], match[2]!, match[3]!);
    }

    match = /^(?:ssh:\/\/)?[\w.-]+@([^:/\s]+)[:/]([^/\s]+)\/([^/\s]+)$/.exec(value);

    if (match !== null) {
        return joined(match[1], match[2]!, match[3]!);
    }

    const parts = value.split("/");

    if (parts.length === 2) {
        return joined(undefined, parts[0]!, parts[1]!);
    }

    return parts.length === 3 && HOST.test(parts[0]!)
        ? joined(parts[0], parts[1]!, parts[2]!)
        : undefined;
}

/** A pull request named as `owner/name#12` or by its address; undefined for anything else. */
export function parsePr(text: string): { repo: string; number: number } | undefined {
    const value = text.trim();
    const url = /^(https?:\/\/[^\s]+?)\/pull\/(\d{1,9})(?:[/?#]\S*)?$/.exec(value);
    const short = /^([^\s#]+)#(\d{1,9})$/.exec(value);
    const match = url ?? short;
    const repo = match === null ? undefined : parseRepo(match[1]!);

    return repo === undefined || match === null ? undefined : { repo, number: Number(match[2]) };
}

/** A PR's web address. */
export function prUrl(repo: string, number: number): string {
    const { host, path } = repoArgs(repo);

    return `https://${host ?? "github.com"}/${path}/pull/${number}`;
}

export type RepoInfo = {
    /** As GitHub spells it, with its host off github.com. */
    repo: string;
    defaultBranch: string;
    push: boolean;
    private: boolean;
};

/** Hosts `gh` is signed in to, by the `gh` that said so, and when it did: asked at most hourly. */
const signedIn = new WeakMap<Gh, Map<string, number>>();
const SIGNED_IN_MS = 3_600_000;

/**
 * A GitHub host other than github.com may be asked only when `gh` is signed in there: a host named in a page or a post
 * could otherwise answer as GitHub ("you can push", "the owner commented"), and get any `GH_ENTERPRISE_TOKEN`. Asks
 * `gh config get -h <host> user`, which reads gh's own hosts file and contacts nobody: a token in the environment does
 * not count, and is sent nowhere. Throws a 403 that says how to sign in.
 */
export async function requireHost(gh: Gh, host: string | undefined): Promise<void> {
    if (host === undefined || host.toLowerCase() === "github.com") {
        return;
    }

    const key = host.toLowerCase();
    const known = signedIn.get(gh) ?? new Map<string, number>();
    const at = known.get(key);

    if (at !== undefined && Date.now() - at < SIGNED_IN_MS) {
        return;
    }

    const user = await gh(["config", "get", "-h", host, "user"]).then(
        (out) => out.trim(),
        () => "",
    );

    if (user === "") {
        throw new HttpError(
            403,
            `This machine's gh is not signed in to ${host}: Pi and PiP reach only GitHub hosts it is signed in to (gh auth login --hostname ${host}).`,
        );
    }

    known.set(key, Date.now());
    signedIn.set(gh, known);
}

/** What GitHub says of a repository to `gh`'s account. Throws an HttpError a person can act on. */
export async function repoInfo(gh: Gh, repo: string): Promise<RepoInfo> {
    const { host } = repoArgs(repo);

    await requireHost(gh, host);
    let found: {
        full_name?: string;
        default_branch?: string;
        private?: boolean;
        permissions?: { push?: boolean; admin?: boolean };
    };

    try {
        found = JSON.parse(await gh(apiArgs(repo, `repos/${repoArgs(repo).path}`))) as typeof found;
    } catch (error) {
        const said = describe(error);

        // The host comes from the name, so the sentence says which service answered, not that GitHub did.
        throw new HttpError(
            /not found|404/i.test(said) ? 404 : 502,
            /not found|404/i.test(said)
                ? `${repo} is not tracked on ${host ?? "github.com"}, or this machine's gh account cannot see it.`
                : `GitHub could not be asked about ${repo}: ${said}`,
        );
    }

    const name = found.full_name ?? repoArgs(repo).path;
    const named = host === undefined ? name : `${host}/${name}`;
    const defaultBranch = found.default_branch ?? "main";

    // The name ends up in paths (`repos/<owner>/<name>`) and in what Pi reads: only one that reads as a repository.
    if (parseRepo(named) !== named) {
        throw new HttpError(502, `GitHub named ${repo} oddly: ${snippet(name, 100)}.`);
    }

    // So does the default branch: only one a person could have given.
    if (!BRANCH.test(defaultBranch)) {
        throw new HttpError(
            502,
            `GitHub named ${repo}'s default branch oddly: ${snippet(defaultBranch, 100)}.`,
        );
    }

    return {
        repo: named,
        defaultBranch,
        push: found.permissions?.push === true || found.permissions?.admin === true,
        private: found.private === true,
    };
}

/**
 * A repository Pi and PiP may act on: one `gh`'s account can push to. Throws a 403 for any other, saying why: what
 * comes from someone else's repository could hand Pi work as if it were yours.
 */
export async function requirePush(gh: Gh, repo: string): Promise<RepoInfo> {
    const info = await repoInfo(gh, repo);

    if (!info.push) {
        throw new HttpError(
            403,
            `This machine's gh account cannot push to ${info.repo}: Pi and PiP work only in repositories it can push to.`,
        );
    }

    return info;
}

/** The GitHub repository a folder's `origin` remote points at; undefined outside one, or for another kind of remote. */
export async function originRepo(folder: string): Promise<string | undefined> {
    const url = await git(folder, ["remote", "get-url", "origin"]).then(
        (out) => out.trim(),
        () => "",
    );

    return url === "" ? undefined : parseRepo(url);
}

/** Whether two repository names are the same repository: GitHub's names do not care about case. */
export const sameRepo = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * Runs that are CI on a branch itself: pushed to it, scheduled, started by hand or through the API, or started by
 * another workflow. A pull request's run (a fork's `main` too) or an issue's is someone else's: its title and its log
 * are theirs. Repository watches and GitHub webhooks both go by it.
 */
export const BRANCH_EVENTS: ReadonlySet<string> = new Set([
    "push",
    "schedule",
    "workflow_dispatch",
    "repository_dispatch",
    "workflow_run",
]);

/**
 * GitHub's labels for people who may be able to write to a repository: its organization's members and its
 * collaborators. Neither label says they can (a member may only read, a collaborator only triage): `canWrite` asks.
 * Write access through a team shows only as MEMBER.
 */
export const MAY_WRITE: ReadonlySet<string> = new Set(["MEMBER", "COLLABORATOR"]);

/** A login GitHub could have given: no `/`, `.`, or `?` to steer the address it goes in. Bots' (`…[bot]`) are not. */
const LOGIN = /^[A-Za-z0-9][\w-]{0,38}$/;
/** What GitHub said of who can write where, by the `gh` that asked: an answer for ten minutes, "could not tell" for one. */
const writing = new WeakMap<Gh, Map<string, { write: boolean | undefined; at: number }>>();
const WRITE_MS = 10 * 60_000;
const UNTOLD_MS = 60_000;
const MAX_WRITING = 2_000;

/**
 * Whether `login` can write to `repo` (push to it: write, maintain, or admin, through a team or the organization
 * too), as GitHub tells `gh`'s account. Undefined when it cannot be told: GitHub tells only accounts that can push
 * there themselves, and only on a host gh is signed in to. False for anything that is not a login.
 */
export async function canWrite(gh: Gh, repo: string, login: string): Promise<boolean | undefined> {
    if (!LOGIN.test(login)) {
        return false;
    }

    const known = writing.get(gh) ?? new Map<string, { write: boolean | undefined; at: number }>();
    const key = `${repo.toLowerCase()} ${login.toLowerCase()}`;
    const had = known.get(key);
    const now = Date.now();

    writing.set(gh, known);

    if (had !== undefined && now - had.at < (had.write === undefined ? UNTOLD_MS : WRITE_MS)) {
        return had.write;
    }

    let write: boolean | undefined;

    try {
        await requireHost(gh, repoArgs(repo).host);
        const found = JSON.parse(
            await gh(
                apiArgs(repo, `repos/${repoArgs(repo).path}/collaborators/${login}/permission`),
            ),
        ) as { permission?: unknown; user?: { permissions?: { push?: unknown } } | null };

        write =
            found.permission === "admin" ||
            found.permission === "write" ||
            found.user?.permissions?.push === true;
    } catch {
        write = undefined;
    }

    // Newest last, so the oldest goes first when there are too many.
    known.delete(key);
    known.set(key, { write, at: now });

    if (known.size > MAX_WRITING) {
        known.delete(known.keys().next().value!);
    }

    return write;
}

/**
 * Whether someone's words count on a repository: its owner's (a person's own repository), or a member's or a
 * collaborator's whom GitHub says can write to it. Nobody else's, and nobody's that cannot be checked.
 */
export async function fromWriter(
    gh: Gh,
    repo: string,
    association: string | undefined,
    login: string | undefined,
): Promise<boolean> {
    if (association === "OWNER") {
        return true;
    }

    return MAY_WRITE.has(association ?? "") && (await canWrite(gh, repo, login ?? "")) === true;
}

// @pi as a word of its own: not @pi-hole, @pi_bot, or @pipeline.
const FOR_PI = /(^|[^\w@])@pi(?![\w-])/i;
const QUOTED = /^\s*>.*$|```[\s\S]*?```|`[^`\n]*`/gm;

/** Whether a comment asks for Pi: @pi in its own words, not in a quote or in code. */
export const mentionsPi = (body: string): boolean => FOR_PI.test(body.replace(QUOTED, ""));

/** A GitHub login as Pi reads it: only what a login may hold (a bot's ends `[bot]`). */
export const login = (name: string | undefined): string =>
    (name ?? "").replace(/[^\w.[\]-]/g, "").slice(0, 60) || "someone";
