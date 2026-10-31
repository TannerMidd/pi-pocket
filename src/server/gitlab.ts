/**
 * GitLab through the `glab` command, signed in by `GITLAB_TOKEN` and pointed at its instance by
 * `GITLAB_HOST`: the same job as `github.ts` does for GitHub, for repository watches on a GitLab
 * host. A call runs in the project's folder and names `projects/:fullpath`, which `glab` fills in
 * from the repository of its working directory; no host is passed, so the remote decides.
 *
 * `glab` writes a config folder before it reads the token, and the server may run as a user that
 * does not own `$HOME`, so `GLAB_CONFIG_DIR` always points at a folder Pi Pocket owns.
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { describe, HttpError } from "./errors.ts";
import { snippet } from "./projection.ts";

/** Runs `glab` with arguments, in a folder; resolves to what it printed, or rejects with what it said went wrong. */
export type Glab = (args: string[], cwd?: string, timeoutMs?: number) => Promise<string>;

const GLAB_TIMEOUT_MS = 60_000;

/** The config folder `glab` writes into: inside Pi Pocket's data folder, which the server owns. */
let configDir: string | undefined;

/** Point `glab` at a writable config folder. Called once, with Pi Pocket's data folder. */
export function setGlabConfigDir(dir: string): void {
    configDir = dir;
}

function configFolder(): string {
    const dir = configDir ?? process.env.GLAB_CONFIG_DIR ?? "/tmp/pi-pocket-glab";

    mkdirSync(dir, { recursive: true });

    return dir;
}

/** The `glab` on this machine, never asking anything: watches run with nobody there to answer. */
export const runGlab: Glab = (args, cwd, timeoutMs = GLAB_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
        execFile(
            "glab",
            args,
            {
                ...(cwd === undefined ? {} : { cwd }),
                timeout: timeoutMs,
                maxBuffer: 64 * 1024 * 1024,
                env: {
                    ...process.env,
                    GLAB_CONFIG_DIR: configFolder(),
                    // Nobody is there to answer a prompt, and no page lasts forever.
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
                            "GitLab's glab command is not installed here. Install it, then set GITLAB_TOKEN and GITLAB_HOST.",
                        ),
                    );
                }

                const said = String(stderr).trim().split("\n").at(-1) ?? "";

                reject(new Error(snippet(said || error.message, 300)));
            },
        );
    });

/** Whether the environment can reach GitLab: a token, and the command. */
export function gitlabReady(): { ready: boolean; why?: string } {
    const token = (process.env.GITLAB_TOKEN ?? "").trim();

    if (token === "") {
        return {
            ready: false,
            why: "GITLAB_TOKEN is not set, so glab has no token: set it in the environment.",
        };
    }

    // A GitHub token here is a mix-up in the environment, and GitLab answers it with a bare 401 that
    // says nothing about why. Name it instead: a watch set up with one would fail at every look.
    if (/^(github_pat_|ghp_|gho_|ghs_)/.test(token)) {
        return {
            ready: false,
            why: "GITLAB_TOKEN holds a GitHub token, not a GitLab one: GitLab needs a token that begins with glpat-.",
        };
    }

    return { ready: true };
}

/** The GitLab path of a repository named `host/group/project`, or `group/project`; a subgroup stays whole. */
export function projectOf(repo: string): string {
    const parts = repo.split("/");

    // A leading part with a dot in it is a host (`gl.mycorp.com/group/project`); one without is a group.
    return parts.length > 2 && /[.:]/.test(parts[0]!) ? parts.slice(1).join("/") : repo;
}

/** A project's issues, opened, newest first. */
export type GlIssue = {
    iid: number;
    title?: string;
    description?: string | null;
    web_url?: string;
    state?: string;
    created_at?: string;
    author?: { username?: string; name?: string } | null;
    labels?: string[];
    assignees?: ({ username?: string } | null)[] | null;
};

/** A project's merge request. */
export type GlMerge = {
    iid: number;
    title?: string;
    description?: string | null;
    web_url?: string;
    state?: string;
    draft?: boolean;
    created_at?: string;
    source_branch?: string;
    target_branch?: string;
    author?: { username?: string } | null;
    labels?: string[];
    assignees?: ({ username?: string } | null)[] | null;
};

/** A pipeline of a project. */
export type GlPipeline = {
    id: number;
    status?: string;
    ref?: string;
    sha?: string;
    source?: string;
    web_url?: string;
    created_at?: string;
    updated_at?: string;
};

/** A project's release. */
export type GlRelease = {
    tag_name?: string;
    name?: string;
    description?: string | null;
    description_html?: string | null;
    upcoming_release?: boolean;
    released_at?: string;
    created_at?: string;
    _links?: { self?: string };
};

/** A note on an issue or a merge request. */
export type GlNote = {
    id: number;
    body?: string;
    created_at?: string;
    system?: boolean;
    author?: { username?: string } | null;
    noteable_type?: string;
    noteable_iid?: number;
};

/** What a GitLab call needs from a watch: its project, and where its folder is. */
export type GlTarget = {
    /** `group/project`, with any subgroup. */
    project: string;
    /** The folder the command runs in: `:fullpath` is filled from it. */
    cwd: string;
};

/**
 * `glab api` for the project in `cwd`, with `:fullpath` resolved from that folder's remote. The
 * endpoint starts after `projects/:fullpath/`: `issues?state=opened`.
 */
export function projectApi(...rest: string[]): string[] {
    return ["api", `projects/:fullpath/${rest.join("/")}`, "--paginate"];
}

/**
 * The items of a paginated list. With `--paginate`, `glab` prints one JSON array for each page
 * after another, not one array of everything, so the pages are read in turn and joined. A single
 * page is one array, and an endpoint that answers with one object is that object.
 */
export function parsePages<T>(printed: string): T[] {
    const items: T[] = [];
    const text = printed.trim();
    let at = 0;

    while (at < text.length) {
        const end = endOfValue(text, at);
        const page = JSON.parse(text.slice(at, end)) as unknown;

        items.push(...(Array.isArray(page) ? (page as T[]) : [page as T]));
        at = end;

        while (at < text.length && /\s/.test(text[at]!)) {
            at += 1;
        }
    }

    return items;
}

/**
 * Where the JSON value that starts at `at` ends: the first point past its opening bracket where the
 * brackets balance again. `glab` prints compact JSON, so a bracket outside a string is structure.
 */
function endOfValue(text: string, at: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = at; index < text.length; index += 1) {
        const char = text[index]!;

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
        } else if (char === '"') {
            inString = true;
        } else if (char === "[" || char === "{") {
            depth += 1;
        } else if (char === "]" || char === "}") {
            depth -= 1;

            if (depth === 0) {
                return index + 1;
            }
        } else if (depth === 0 && /\s/.test(char)) {
            // A bare value, such as a number: it ends at the first space.
            return index;
        }
    }

    return text.length;
}

/** Ask GitLab for the project's repository, to learn whether the token may push to it. */
export async function projectInfo(
    glab: Glab,
    target: GlTarget,
): Promise<{ path: string; defaultBranch: string; push: boolean }> {
    let found: {
        path_with_namespace?: string;
        default_branch?: string | null;
        permissions?: { project_access?: { access_level?: number } | null } | null;
        _links?: { self?: string };
    };

    try {
        found = JSON.parse(await glab(["api", "projects/:fullpath"], target.cwd)) as typeof found;
    } catch (error) {
        const said = describe(error);

        throw new HttpError(
            /not found|404/i.test(said) ? 404 : 502,
            /not found|404/i.test(said)
                ? `${target.project} is not tracked on ${gitlabName()}.`
                : `GitLab could not be asked about ${target.project}: ${said}`,
        );
    }

    const path = found.path_with_namespace ?? target.project;

    if (path !== target.project) {
        throw new HttpError(502, `GitLab named ${target.project} oddly: ${snippet(path, 100)}.`);
    }

    // Developer and above can push. Maintainer is 40, Developer 30.
    const level = found.permissions?.project_access?.access_level ?? 0;

    return {
        path,
        defaultBranch: found.default_branch ?? "main",
        push: level >= 30,
    };
}

/** The GitLab host this environment speaks to, for messages. */
export function gitlabName(): string {
    return (process.env.GITLAB_HOST ?? "").trim() || "gitlab.com";
}

/** Whether a GitLab access level may push to the project: Developer (30) and above. */
export const mayPush = (level: number | null | undefined): boolean => (level ?? 0) >= 30;

/**
 * Whether `username` may push to the project: a member with Developer or above, or its owner.
 * Asked of one member, so a large project does not list every one. Undefined when it cannot be
 * told. Asked at most ten minutes per person, as the GitHub side does.
 */
const access = new Map<string, { push: boolean | undefined; at: number }>();
const ACCESS_MS = 10 * 60_000;
const UNTOLD_MS = 60_000;
const MAX_ACCESS = 2_000;

export async function memberMayPush(
    glab: Glab,
    target: GlTarget,
    username: string,
): Promise<boolean | undefined> {
    if (!/^[A-Za-z0-9][\w.-]{0,254}$/.test(username)) {
        return false;
    }

    const key = `${target.project} ${username}`.toLowerCase();
    const had = access.get(key);
    const now = Date.now();

    if (had !== undefined && now - had.at < (had.push === undefined ? UNTOLD_MS : ACCESS_MS)) {
        return had.push;
    }

    let push: boolean | undefined;

    try {
        // By name, because the member endpoint wants a numeric id, and a name is what a note carries.
        // `query` is a search: it can match part of a name, so only the exact member counts.
        const found = parsePages<{ username?: string; access_level?: number }>(
            await glab(
                ["api", `projects/:fullpath/members/all?query=${encodeURIComponent(username)}`],
                target.cwd,
            ),
        );
        const one = found.find((each) => each.username === username);

        push = one === undefined ? undefined : mayPush(one.access_level);
    } catch {
        push = undefined;
    }

    access.delete(key);
    access.set(key, { push, at: now });

    if (access.size > MAX_ACCESS) {
        access.delete(access.keys().next().value!);
    }

    return push;
}
