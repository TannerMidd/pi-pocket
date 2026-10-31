/**
 * Updates of Pi Pocket itself (`app.updates`, `host.updates`). It reads the newest release (GitHub's releases of the
 * repository in `package.json`, or the repository's version tags), downloads its commit into the checkout as a ref of
 * its own, and says what stands in the way of an update: a server without its launcher, a copy that is not a git
 * checkout or that it cannot write, changes that are not committed, commits the release does not have, or a Node.js
 * the release does not run on. An update installs the release's packages beside the checkout first (`npm ci`, only
 * when its lock file differs), notes the update in `.pocket-update/pending.json` (`update-state.ts`), puts the packages
 * in place, moves the checkout forward to the release's commit (never over a change of its own), and restarts. When
 * the new version starts, `recover` notes that it did; when it does not, the launcher goes back to the version before.
 * Global npm installs use the registry's latest version with GitHub's notes. They stage a complete package beside the
 * live one, then swap the package folders. Local installs and npx caches require their own npm command instead.
 * The `updates` extension module shows it to the owner, and checks and installs on a timer.
 */
import { execFile } from "node:child_process";
import { constants, lstatSync, readFileSync } from "node:fs";
import { access, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { npmCommand, npmInstallKind, npmWritable, type InstallKind } from "./npm-install.ts";
import { describe, HttpError } from "./errors.ts";
import { stageNpmUpdate } from "./npm-update.ts";
import { git, GitError } from "./git.ts";
import {
    clearPending,
    finishPending,
    finishNpmPending,
    restorePackage,
    swapInPackage,
    type PendingUpdate,
    readOutcome,
    readPending,
    recordOutcome,
    restoreModules,
    swapInModules,
    finishPartial,
    type UpdateOutcome,
    updatePaths,
    writePending,
} from "./update-state.ts";
import { atLeast, compareReleases } from "./versions.ts";

/** A release: its tag (`v0.23.0`), version, and notes (undefined when only the tag was found). */
export type Release = {
    tag: string;
    version: string;
    name: string;
    /** Markdown from the release; undefined when the release had no page to read (only its tag). */
    notes?: string;
    url?: string;
    publishedAt?: string;
    beta?: boolean;
    /** The notes have a `[!WARNING]` alert: a step that cannot be undone, or one that needs care. */
    warning: boolean;
    /**
     * GitHub did not answer, so the release came from its tag: it may have notes, and a warning in them, that Pi Pocket
     * could not read. An update to it is treated as one with a warning: the owner's word first, and no going back.
     */
    unread?: boolean;
    /** The npm release's Node.js requirement, checked before staging. */
    node?: string;
};

/** The release may need care: its notes warn, or Pi Pocket could not read them to know. */
export function needsCare(release: Release): boolean {
    return release.warning || release.unread === true;
}

export type UpdateStatus = {
    /** The running version, and the checkout's commit and branch (null when detached). */
    version: string;
    installKind: InstallKind;
    commit?: string;
    branch?: string | null;
    /** Where releases come from. */
    repository: string;
    beta: boolean;
    latest?: Release;
    checkedAt?: number;
    /** Why the last check failed. */
    error?: string;
    /** A newer release than the running version, that this checkout does not have yet. */
    available: boolean;
    /** What stops an update now, in words for the owner. */
    blockers: string[];
    /** What to know before updating. */
    cautions: string[];
    /** The update installs new packages. */
    packages: boolean;
    /** Sessions Pi works in now. */
    busy: number;
    /** The step of an update under way. */
    step?: string;
    last?: UpdateOutcome;
    /** The launcher can restart the server, and go back when a new version does not start. */
    supervised: boolean;
    rollback: boolean;
};

export interface UpdatesOptions {
    appRoot: string;
    version: string;
    /** The launcher runs the server: it can restart it. */
    supervised: boolean;
    /** The launcher goes back to the version before when a new one does not start. */
    rollback: boolean;
    /** An older launcher can undo git updates but does not know the sibling npm update state. */
    npmRollback?: boolean;
    restart: () => void;
    /**
     * Stop reloading what changes on disk (web files, extension modules) just before git moves the checkout, so the
     * running server does not load the new version's files; false starts again after an update that failed.
     */
    quiesce?: (paused: boolean) => void;
    /** How many sessions Pi works in now. */
    busy: () => number;
    log: (line: string) => void;
    /** The git address releases come from; `package.json`'s repository when not given. */
    repository?: string;
    beta?: boolean;
    /** Tests give the newest release here, rather than asking GitHub. `beta` says whether the channel is on. */
    releases?: (signal?: AbortSignal, beta?: boolean) => Promise<Release | undefined>;
    now?: () => number;
}

/** A release's tag: only these are taken, so the tag is safe in a refspec and its version is a version. */
const TAG = /^v?(\d{1,4}\.\d{1,4}\.\d{1,4}(-beta\.\d{1,4})?)$/;
const STABLE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
/** Where the release's commit is kept in the checkout: a ref of the updater's own, never a branch or tag of yours. */
const TARGET_REF = "refs/pocket-update/target";
/** The most of a release's notes kept. */
const MAX_NOTES = 60_000;
const NPM_TIMEOUT_MS = 20 * 60_000;
const FETCH_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_REPOSITORY = "https://github.com/TannerMidd/pi-pocket.git";

/** `package.json`'s repository, as a git address. */
export function repositoryOf(appRoot: string): string {
    try {
        const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
            repository?: string | { url?: string };
        };
        const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;

        return typeof url === "string" && url !== ""
            ? url.replace(/^git\+/, "")
            : DEFAULT_REPOSITORY;
    } catch {
        return DEFAULT_REPOSITORY;
    }
}

/**
 * Why a repository address is not one updates fetch from, or undefined. Only https, ssh, `git@host:path`, and a local
 * path or `file://` address: never one git could read as an option, or a remote helper that runs a command.
 */
export function repositoryProblem(url: string): string | undefined {
    const plain = /^(https:\/\/|ssh:\/\/|file:\/\/|git@[\w.-]+:[\w./~-]|\/)/.test(url);

    return plain && !/[\s\0]/.test(url)
        ? undefined
        : `Updates do not fetch from ${JSON.stringify(url.slice(0, 80))}: give an https, ssh, or local address.`;
}

/** `owner` and `name` of a repository on GitHub, or undefined for one elsewhere. */
export function githubRepository(url: string): { owner: string; name: string } | undefined {
    const match = /^(?:git\+)?https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);

    return match === null ? undefined : { owner: match[1]!, name: match[2]! };
}

export function newer(version: string, than: string): boolean {
    return (compareReleases(version, than) ?? 0) > 0;
}

/** Node.js `version` meets an `engines.node` of the form `>=22.19`; any other form is not checked. */
export function nodeMeets(range: unknown, version: string): boolean {
    const match =
        typeof range === "string"
            ? /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim())
            : null;

    if (match === null) {
        return true;
    }

    return atLeast(version, `${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}`);
}

/** The release notes warn: GitHub's `[!WARNING]` or `[!CAUTION]` alert, as the release notes guide asks for. */
export function notesWarn(notes: string | undefined): boolean {
    return notes !== undefined && /^\s*>\s*\[!(WARNING|CAUTION)\]/im.test(notes);
}

function releaseOf(tag: string, fields: Partial<Release>): Release | undefined {
    const match = TAG.exec(tag);

    if (match === null) {
        return undefined;
    }

    return {
        name: tag,
        ...fields,
        tag,
        version: match[1]!,
        ...(match[2] === undefined ? {} : { beta: true }),
        warning: notesWarn(fields.notes),
    };
}

async function githubGet(
    repository: { owner: string; name: string },
    path: string,
    signal?: AbortSignal,
): Promise<unknown> {
    const timeout = AbortSignal.timeout(20_000);
    const response = await fetch(
        `https://api.github.com/repos/${repository.owner}/${repository.name}/${path}`,
        {
            headers: {
                accept: "application/vnd.github+json",
                "user-agent": "pi-pocket-updates",
                "x-github-api-version": "2022-11-28",
            },
            signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        },
    );

    if (response.status === 404) {
        return undefined;
    }

    if (!response.ok) {
        throw new Error(`GitHub answered ${response.status} for the newest release`);
    }

    return response.json();
}

function githubReleaseOf(
    repository: { owner: string; name: string },
    body: Record<string, unknown>,
): Release | undefined {
    const notes = typeof body.body === "string" ? body.body : "";
    const foundTag = typeof body.tag_name === "string" ? body.tag_name : "";
    const page = `https://github.com/${repository.owner}/${repository.name}/releases/tag/${foundTag}`;
    const release = releaseOf(foundTag, {
        name:
            typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : foundTag,
        notes: notes.slice(0, MAX_NOTES),
        url: page,
        ...(typeof body.published_at === "string" ? { publishedAt: body.published_at } : {}),
    });

    // Read all notes for safety, even when only the first part is displayed.
    return release === undefined ? undefined : { ...release, warning: notesWarn(notes) };
}

async function githubRelease(
    repository: { owner: string; name: string },
    signal?: AbortSignal,
    tag?: string,
): Promise<Release | undefined> {
    const body = (await githubGet(
        repository,
        `releases/${tag === undefined ? "latest" : `tags/${encodeURIComponent(tag)}`}`,
        signal,
    )) as Record<string, unknown> | undefined;

    if (body === undefined) {
        return undefined;
    }

    const release = githubReleaseOf(repository, body);

    if (release === undefined) {
        throw new Error(
            `The release's tag is not a version: ${String(body.tag_name ?? "").slice(0, 40)}`,
        );
    }

    return release;
}

/** The highest version wins, not the latest one made: a fix for an older line may come later. */
export function newestOfReleases(
    repository: { owner: string; name: string },
    list: unknown,
): Release | undefined {
    let best: Release | undefined;

    for (const body of Array.isArray(list) ? list : []) {
        if (typeof body !== "object" || body === null || body.draft === true) {
            continue;
        }

        const release = githubReleaseOf(repository, body as Record<string, unknown>);

        if (release !== undefined && (best === undefined || newer(release.version, best.version))) {
            best = release;
        }
    }

    return best;
}

async function githubNewestRelease(
    repository: { owner: string; name: string },
    signal?: AbortSignal,
): Promise<Release | undefined> {
    return newestOfReleases(
        repository,
        await githubGet(repository, "releases?per_page=30", signal),
    );
}

export function pickNpmVersion(
    body: {
        "dist-tags"?: Record<string, unknown>;
        versions?: Record<string, unknown>;
    },
    beta = false,
): string {
    const tags = body["dist-tags"];
    const found: string[] = [];
    let problem: string | undefined;

    if (typeof tags?.latest !== "string" || !STABLE.test(tags.latest)) {
        problem = "npm's latest dist-tag is not a release version.";
    } else if (body.versions?.[tags.latest] === undefined) {
        problem = "npm's latest dist-tag has no published package metadata.";
    } else {
        found.push(tags.latest);
    }

    if (
        beta &&
        typeof tags?.beta === "string" &&
        TAG.test(tags.beta) &&
        !tags.beta.startsWith("v") &&
        body.versions?.[tags.beta] !== undefined
    ) {
        found.push(tags.beta);
    }

    if (found.length === 0) {
        throw new Error(problem ?? "npm's latest dist-tag is not a release version.");
    }

    return found.reduce((best, each) => (newer(each, best) ? each : best));
}

export async function npmRelease(
    repository: { owner: string; name: string } | undefined,
    signal?: AbortSignal,
    beta = false,
): Promise<Release> {
    const timeout = AbortSignal.timeout(20_000);
    const response = await fetch("https://registry.npmjs.org/pi-pocket", {
        headers: {
            accept: "application/vnd.npm.install-v1+json",
            "user-agent": "pi-pocket-updates",
        },
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });

    if (!response.ok) {
        throw new Error(`npm answered ${response.status} for the newest release`);
    }

    const body = (await response.json()) as {
        "dist-tags"?: Record<string, unknown>;
        versions?: Record<string, { engines?: { node?: unknown } }>;
    };
    const version = pickNpmVersion(body, beta);
    const manifest = body.versions![version]!;
    const tag = `v${version}`;
    const node = manifest.engines?.node;
    const fields = typeof node === "string" ? { node } : {};

    if (repository !== undefined) {
        const notes = await githubRelease(repository, signal, tag).catch(() => undefined);

        if (notes?.version === version) {
            return { ...notes, ...fields };
        }
    }

    return {
        tag,
        version,
        name: tag,
        warning: false,
        unread: true,
        ...(repository === undefined
            ? {}
            : {
                  url: `https://github.com/${repository.owner}/${repository.name}/releases/tag/${tag}`,
              }),
        ...fields,
    };
}

export function newestTag(output: string, beta = false): Release | undefined {
    let best: Release | undefined;

    for (const line of output.split("\n")) {
        const tag = /\trefs\/tags\/(\S+)$/.exec(line)?.[1];
        const release = tag === undefined ? undefined : releaseOf(tag, {});

        if (
            release !== undefined &&
            (beta || release.beta !== true) &&
            (best === undefined || newer(release.version, best.version))
        ) {
            best = release;
        }
    }

    return best;
}

async function tagRelease(
    repository: string,
    cwd: string,
    beta: boolean,
): Promise<Release | undefined> {
    return newestTag(
        await git(cwd, ["ls-remote", "--tags", "--refs", "--", repository], {
            timeoutMs: FETCH_TIMEOUT_MS,
        }),
        beta,
    );
}

/**
 * The paths `git status --porcelain=v1 -z` names: "XY path", and for a rename or copy the path it came from after it,
 * which is left out. Names come as they are, whatever characters they hold.
 */
export function changedFiles(status: string): string[] {
    const parts = status.split("\0").filter((each) => each !== "");
    const paths: string[] = [];

    for (let at = 0; at < parts.length; at++) {
        const entry = parts[at]!;

        paths.push(entry.slice(3));

        if (entry[0] === "R" || entry[0] === "C") {
            at++;
        }
    }

    return paths;
}

/** The oldest git updates work with: `--pathspec-from-file` came in 2.26. */
const MIN_GIT = "2.26.0";

/**
 * What a failed program said, in its last lines; npm's help for the command, which it prints after the error itself
 * (from the command's summary, the line before `Usage:`, on), is left out, so the cause shows.
 */
export function failureLines(output: string): string {
    const lines = output
        .split("\n")
        .map((line) => line.replace(/^npm (error|ERR!)/, "").trim())
        .filter((line) => line !== "");
    const usage = lines.findIndex((line) => line === "Usage:");

    return (usage > 0 ? lines.slice(0, usage - 1) : lines).slice(-6).join("\n");
}

/** Run a program; its last lines of output are the error when it fails. */
function run(file: string, args: string[], cwd: string, timeoutMs: number, shell = false) {
    return new Promise<void>((done, fail) => {
        execFile(
            file,
            args,
            {
                cwd,
                timeout: timeoutMs,
                maxBuffer: 32 * 1024 * 1024,
                shell,
                env: {
                    ...process.env,
                    npm_config_update_notifier: "false",
                    npm_config_fund: "false",
                },
            },
            (error, stdout, stderr) => {
                if (error === null) {
                    done();

                    return;
                }

                const said = failureLines(`${stderr}\n${stdout}`);

                fail(new Error(said || error.message));
            },
        );
    });
}

type Local =
    | { git: false }
    | {
          git: true;
          commit: string;
          branch: string | null;
          dirty: string[];
          writable: boolean;
      };

type Target = { tag: string; commit: string; problem?: string };

export class Updates {
    readonly #options: UpdatesOptions;
    readonly #root: string;
    readonly repository: string;
    readonly #listeners = new Set<(status: UpdateStatus) => void>();
    #latest: Release | undefined;
    #beta: boolean;
    /** The last check asked npm, not GitHub. */
    #fromNpm = false;
    #checkedAt: number | undefined;
    #error: string | undefined;
    #target: Target | undefined;
    #targetError: string | undefined;
    #checking: Promise<void> | undefined;
    #step: string | undefined;
    #npmKind: Promise<InstallKind> | undefined;
    #knownKind: InstallKind = "unknown";

    async #installKind(local: Local): Promise<InstallKind> {
        this.#knownKind = local.git ? "git" : await (this.#npmKind ??= npmInstallKind(this.#root));

        return this.#knownKind;
    }

    constructor(options: UpdatesOptions) {
        this.#options = options;
        this.#root = resolve(options.appRoot);
        this.repository = options.repository ?? repositoryOf(this.#root);
        this.#beta = options.beta === true;
    }

    get beta(): boolean {
        return this.#beta;
    }

    /** A running pre-release is never offered an older version, whatever the channel. */
    setBeta(on: boolean): void {
        if (on === this.#beta) {
            return;
        }

        this.#beta = on;

        if (!on && this.#latest?.beta === true) {
            this.#latest = undefined;
            this.#target = undefined;
            this.#targetError = undefined;
        }

        void this.#changed();
    }

    get #now(): number {
        return (this.#options.now ?? Date.now)();
    }

    #canRollBack(kind: InstallKind): boolean {
        return (
            this.#options.rollback && (kind !== "npm-global" || this.#options.npmRollback === true)
        );
    }

    /** Hear each change: a check, and each step of an update. Returns how to stop. */
    subscribe(listener: (status: UpdateStatus) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /** Each change's number: a status read for an older change is not sent after a newer one. */
    #changes = 0;

    async #changed(): Promise<void> {
        if (this.#listeners.size === 0) {
            return;
        }

        const change = ++this.#changes;
        const status = await this.status().catch(() => undefined);

        if (status === undefined || change !== this.#changes) {
            return;
        }

        for (const listener of this.#listeners) {
            try {
                listener(status);
            } catch (error) {
                this.#options.log(`An updates listener failed: ${describe(error)}`);
            }
        }
    }

    #setStep(step: string | undefined): void {
        this.#step = step;
        void this.#changed();
    }

    /** The checkout: its commit and branch, files changed and not committed, and whether this user can write it. */
    async #local(): Promise<Local> {
        const root = this.#root;
        let top: string;

        try {
            top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
        } catch {
            return { git: false };
        }

        if ((await realpath(top).catch(() => top)) !== (await realpath(root).catch(() => root))) {
            return { git: false };
        }

        const commit = (await git(root, ["rev-parse", "HEAD"])).trim();
        const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(
            (out) => out.trim() || null,
            () => null,
        );
        const dirty = changedFiles(
            await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]),
        );
        const gitDir = (await git(root, ["rev-parse", "--git-dir"])).trim();
        const writable = await Promise.all([
            access(root, constants.W_OK),
            access(isAbsolute(gitDir) ? gitDir : join(root, gitDir), constants.W_OK),
        ]).then(
            () => true,
            () => false,
        );

        return { git: true, commit, branch, dirty, writable };
    }

    #git: Promise<string | undefined> | undefined;

    /** The version of git here, as `2.45.1`; undefined when it does not say one. */
    #gitVersion(): Promise<string | undefined> {
        this.#git ??= git(this.#root, ["--version"]).then(
            (out) => /(\d+\.\d+\.\d+)/.exec(out)?.[1],
            () => undefined,
        );

        return this.#git;
    }

    async #isAncestor(older: string, younger: string): Promise<boolean> {
        try {
            await git(this.#root, ["merge-base", "--is-ancestor", older, younger]);

            return true;
        } catch (error) {
            if (error instanceof GitError && error.exitCode === 1) {
                return false;
            }

            throw error;
        }
    }

    /**
     * The lock files of two commits name other packages. Pi Pocket's own version is in its lock file too, and changes
     * with each release: that alone installs nothing. A lock file that cannot be read counts as different.
     */
    async #packagesDiffer(from: string, to: string): Promise<boolean> {
        const lock = async (commit: string) => {
            const parsed = JSON.parse(
                await git(this.#root, ["show", `${commit}:package-lock.json`]),
            ) as { version?: unknown; packages?: Record<string, { version?: unknown }> };

            delete parsed.version;

            if (parsed.packages?.[""] !== undefined) {
                delete parsed.packages[""].version;
            }

            return JSON.stringify(parsed);
        };

        try {
            return (await lock(from)) !== (await lock(to));
        } catch {
            return true;
        }
    }

    /** The paths a move between two commits adds, and the others it changes or deletes. */
    async #switchPaths(from: string, to: string): Promise<{ added: string[]; other: string[] }> {
        const parts = (
            await git(this.#root, ["diff", "--name-status", "--no-renames", "-z", from, to])
        )
            .split("\0")
            .filter((each) => each !== "");
        const added: string[] = [];
        const other: string[] = [];

        for (let at = 0; at + 1 < parts.length; at += 2) {
            (parts[at] === "A" ? added : other).push(parts[at + 1]!);
        }

        return { added, other };
    }

    /**
     * A file of the owner's (ignored, or not tracked) where the release adds one: in the way of the update. A folder
     * there is in the way only when it holds something git does not track, since the release removes what it tracks.
     */
    async #inTheWay(added: string[]): Promise<string | undefined> {
        const there: string[] = [];

        for (const path of added) {
            let folder: boolean;

            try {
                folder = lstatSync(join(this.#root, path)).isDirectory();
            } catch {
                continue;
            }

            const own = folder
                ? (
                      await git(this.#root, [
                          "ls-files",
                          "--others",
                          "--directory",
                          "-z",
                          "--",
                          path,
                      ])
                  ).trim() !== ""
                : true;

            if (own) {
                there.push(path);
            }
        }

        return there.length === 0
            ? undefined
            : `A file of yours is where the new version has one (${there.slice(0, 3).join(", ")}). Move it away first.`;
    }

    /** What the owner sees: the versions, and what stands in the way of an update. */
    async status(): Promise<UpdateStatus> {
        // While an update changes the checkout, reading it would race with git: the step says what goes on.
        if (this.#step !== undefined && this.#step !== "Checking") {
            return {
                version: this.#options.version,
                installKind: this.#knownKind,
                repository: this.repository,
                beta: this.#beta,
                ...(this.#latest === undefined ? {} : { latest: this.#latest }),
                ...(this.#checkedAt === undefined ? {} : { checkedAt: this.#checkedAt }),
                available: true,
                blockers: [],
                cautions: [],
                packages: false,
                busy: this.#options.busy(),
                step: this.#step,
                supervised: this.#options.supervised,
                rollback: this.#canRollBack(this.#knownKind),
            };
        }

        const local = await this.#local().catch((): Local => ({ git: false }));
        const installKind = await this.#installKind(local);
        const latest = this.#latest;
        const busy = this.#options.busy();
        let available = latest !== undefined && newer(latest.version, this.#options.version);
        const blockers: string[] = [];
        const cautions: string[] = [];
        let packages = false;

        if (available && latest !== undefined) {
            const dist = latest.beta === true ? "beta" : "latest";

            if (!this.#options.supervised) {
                blockers.push(
                    "Pi Pocket runs without its launcher, so it cannot restart itself. Start it with `npm start` (or `bin/pi-pocket.js`) to update from the app.",
                );
            }

            const gitVersion = local.git ? await this.#gitVersion() : undefined;

            if (installKind === "npm-global") {
                packages = true;

                if (!this.#canRollBack(installKind)) {
                    blockers.push(
                        "This launcher cannot recover npm updates. Quit Pi Pocket and start it again before updating from the app.",
                    );
                }

                if (!(await npmWritable(this.#root))) {
                    blockers.push(
                        `The server's user cannot write to ${this.#root} and its global node_modules folder. Update it as the user who owns it with \`npm install -g pi-pocket@${dist}\` (a system install may need sudo).`,
                    );
                }

                if (!nodeMeets(latest.node, process.versions.node)) {
                    blockers.push(
                        `${latest.tag} needs Node.js ${latest.node}, and this server runs ${process.versions.node}. Update Node.js first.`,
                    );
                }
            } else if (!local.git) {
                blockers.push(
                    installKind === "npm-local"
                        ? `This is a local npm install. Update it with \`npm install pi-pocket@${dist}\` in that project, then start it again.`
                        : installKind === "npx"
                          ? `This copy runs with npx. Stop it, then run \`npx pi-pocket@${dist}\`.`
                          : "This copy of Pi Pocket is not a git checkout. Update it the way you installed it.",
                );
            } else if (gitVersion !== undefined && !atLeast(gitVersion, MIN_GIT)) {
                blockers.push(
                    `Updates need git ${MIN_GIT} or newer, and this machine has ${gitVersion}. Update git first.`,
                );
            } else {
                if (!local.writable) {
                    blockers.push(
                        `The server's user cannot write to ${this.#root}. Update it as the user who owns it.`,
                    );
                }

                if (local.dirty.length > 0) {
                    const files = local.dirty.slice(0, 3).join(", ");

                    blockers.push(
                        `${local.dirty.length === 1 ? "1 file has" : `${local.dirty.length} files have`} changes that are not committed (${files}${local.dirty.length > 3 ? ", …" : ""}). Commit them, or put them aside with \`git stash\`, first.`,
                    );
                }

                const target = this.#target;

                if (target?.tag !== latest.tag) {
                    if (local.writable) {
                        blockers.push(
                            this.#targetError ??
                                `${latest.tag} is not downloaded yet: check again.`,
                        );
                    }
                } else if (target.problem !== undefined) {
                    blockers.push(target.problem);
                } else if (await this.#isAncestor(target.commit, local.commit).catch(() => false)) {
                    // A checkout ahead of the release (main, after it) has it already.
                    available = false;
                } else {
                    if (!(await this.#isAncestor(local.commit, target.commit).catch(() => false))) {
                        blockers.push(
                            `This checkout has commits that ${latest.tag} does not have${local.branch === null ? "" : ` (on ${local.branch})`}. Update it by hand with git.`,
                        );
                    }

                    packages = await this.#packagesDiffer(local.commit, target.commit);

                    const inTheWay = await this.#inTheWay(
                        (
                            await this.#switchPaths(local.commit, target.commit).catch(
                                () => undefined,
                            )
                        )?.added ?? [],
                    );

                    if (inTheWay !== undefined) {
                        blockers.push(inTheWay);
                    }
                }
            }

            if (readPending(this.#root) !== undefined) {
                blockers.push("An update is under way. Restart the server to finish it.");
            }
        }

        if (available) {
            if (latest?.beta === true) {
                cautions.push(
                    "This is a beta version: it may have bugs that the stable release does not. Turn off Beta updates (Menu → Extensions → Installed → Pi Pocket updates) to get stable releases only; the next stable release still updates a beta.",
                );
            }

            if (latest?.warning === true) {
                cautions.push(
                    "The release notes have a warning. Read it, and back up the data folder, before you update. If this version does not start, Pi Pocket does not go back by itself.",
                );
            }

            if (latest?.unread === true) {
                cautions.push(
                    "Pi Pocket could not read this version's release notes, so it cannot tell whether they warn of a step that cannot be undone. Read them on GitHub, and back up the data folder, before you update. If this version does not start, Pi Pocket does not go back by itself.",
                );
            } else if (latest?.notes === undefined) {
                cautions.push("Pi Pocket found this version's tag, but not its release notes.");
            }

            if (packages) {
                cautions.push(
                    installKind === "npm-global"
                        ? "The update stages a complete npm install before switching versions: this can take a few minutes."
                        : "The update installs new packages (`npm ci`): this can take a few minutes.",
                );
            }

            if (busy > 0) {
                cautions.push(
                    `Pi works in ${busy === 1 ? "1 session" : `${busy} sessions`} now. Work continues after the restart, but a tool call that it cuts off comes back as interrupted.`,
                );
            }

            if (this.#options.supervised && !this.#options.rollback) {
                cautions.push(
                    "The launcher started before this updater: if the new version does not start, it does not go back by itself. Quit Pi Pocket and start it again to get that.",
                );
            }
        } else {
            blockers.length = 0;
        }

        return {
            version: this.#options.version,
            installKind,
            ...(local.git ? { commit: local.commit, branch: local.branch } : {}),
            repository: this.repository,
            beta: this.#beta,
            ...(latest === undefined ? {} : { latest }),
            ...(this.#checkedAt === undefined ? {} : { checkedAt: this.#checkedAt }),
            ...(this.#error === undefined ? {} : { error: this.#error }),
            available,
            blockers,
            cautions,
            packages,
            busy,
            ...(this.#step === undefined ? {} : { step: this.#step }),
            ...(() => {
                const last = readOutcome(this.#root);

                return last === undefined ? {} : { last };
            })(),
            supervised: this.#options.supervised,
            rollback: this.#canRollBack(installKind),
        };
    }

    /** Read the newest release again, and download its commit. One check at a time: a second waits for the first. */
    async check(signal?: AbortSignal): Promise<UpdateStatus> {
        this.#checking ??= this.#check(signal).finally(() => {
            this.#checking = undefined;
        });
        await this.#checking;
        void this.#changed();

        return this.status();
    }

    async #check(signal?: AbortSignal): Promise<void> {
        try {
            const found = await this.#findRelease(signal);
            // The channel may be turned off while the look goes on: a pre-release it found is not offered.
            const release = found?.beta === true && !this.#beta ? undefined : found;

            this.#latest = release;
            this.#error = undefined;

            if (release !== undefined && newer(release.version, this.#options.version)) {
                await this.#prepare(release);
            }
        } catch (error) {
            this.#error = describe(error);

            // npm is the only word on what an npm install can get: a version it no longer confirms is not offered.
            if (this.#fromNpm) {
                this.#latest = undefined;
            }
        } finally {
            this.#checkedAt = this.#now;
        }
    }

    async #findRelease(signal?: AbortSignal): Promise<Release | undefined> {
        const problem = repositoryProblem(this.repository);

        if (problem !== undefined) {
            throw new Error(problem);
        }

        const kind = await this.#installKind(await this.#local());
        const beta = this.#beta;

        this.#fromNpm = kind === "npm-global" || kind === "npm-local" || kind === "npx";

        if (this.#options.releases !== undefined) {
            return this.#options.releases(signal, beta);
        }

        const github = githubRepository(this.repository);

        if (this.#fromNpm) {
            return npmRelease(github, signal, beta);
        }

        let failed: unknown;

        if (github !== undefined) {
            try {
                const found = beta
                    ? await githubNewestRelease(github, signal)
                    : await githubRelease(github, signal);

                // GitHub may not mark a beta tag as a pre-release: only the beta channel takes it.
                if (found !== undefined && (beta || found.beta !== true)) {
                    return found;
                }
            } catch (error) {
                failed = error;
            }
        }

        // No release page (or GitHub did not answer): the tags give the newest version, without its notes.
        try {
            const tagged = await tagRelease(this.repository, this.#root, beta);

            // GitHub failed, rather than said there is no release: notes may exist, with a warning Pi Pocket cannot see.
            if (failed !== undefined && github !== undefined && tagged !== undefined) {
                return {
                    ...tagged,
                    unread: true,
                    url: `https://github.com/${github.owner}/${github.name}/releases/tag/${tagged.tag}`,
                };
            }

            return tagged;
        } catch (error) {
            throw new Error(
                failed === undefined ? describe(error) : `${describe(failed)}; ${describe(error)}`,
            );
        }
    }

    /** Download the release's commit into the checkout, and check that this server can run it. */
    async #prepare(release: Release): Promise<void> {
        this.#targetError = undefined;
        const local = await this.#local();

        if (!local.git || !local.writable) {
            return;
        }

        try {
            await git(
                this.#root,
                [
                    "fetch",
                    "--quiet",
                    "--no-tags",
                    "--",
                    this.repository,
                    `+refs/tags/${release.tag}:${TARGET_REF}`,
                ],
                { timeoutMs: FETCH_TIMEOUT_MS },
            );
            const commit = (
                await git(this.#root, ["rev-parse", "--verify", `${TARGET_REF}^{commit}`])
            ).trim();
            const pkg = JSON.parse(await git(this.#root, ["show", `${commit}:package.json`])) as {
                version?: unknown;
                engines?: { node?: unknown };
            };
            let problem: string | undefined;

            if (pkg.version !== release.version) {
                problem = `${release.tag} holds version ${String(pkg.version)}, not ${release.version}: Pi Pocket does not install it.`;
            } else if (!nodeMeets(pkg.engines?.node, process.versions.node)) {
                problem = `${release.tag} needs Node.js ${String(pkg.engines?.node)}, and this server runs ${process.versions.node}. Update Node.js first.`;
            } else if (
                !(await git(this.#root, ["cat-file", "-e", `${commit}:package-lock.json`]).then(
                    () => true,
                    () => false,
                ))
            ) {
                problem = `${release.tag} has no package-lock.json: Pi Pocket does not install it.`;
            }

            this.#target = {
                tag: release.tag,
                commit,
                ...(problem === undefined ? {} : { problem }),
            };
        } catch (error) {
            this.#target = undefined;
            this.#targetError = `Could not download ${release.tag}: ${describe(error)}`;
        }
    }

    /**
     * Update to the newest release, and restart. It checks again first, and refuses (409) while anything stands in the
     * way, a warning that `confirmWarning` does not accept, or sessions at work that `allowBusy` does not accept.
     */
    async apply(
        options: {
            confirmWarning?: boolean;
            allowBusy?: boolean;
            by?: string;
            /** Asked again once the packages installed, which can take minutes: a reason to stop now, or undefined. */
            stillWanted?: () => string | undefined;
        } = {},
    ): Promise<{ restarting: true; version: string }> {
        if (this.#step !== undefined) {
            throw new HttpError(409, `An update is under way: ${this.#step.toLowerCase()}.`);
        }

        if (readPending(this.#root) !== undefined) {
            throw new HttpError(409, "An update is under way. Restart the server to finish it.");
        }

        this.#setStep("Checking");

        try {
            const status = await this.check();
            const latest = this.#latest;
            const target = this.#target;

            if (!status.available || latest === undefined) {
                throw new HttpError(409, "Pi Pocket is up to date.");
            }

            if (status.blockers.length > 0) {
                throw new HttpError(409, status.blockers[0]!);
            }

            if (needsCare(latest) && options.confirmWarning !== true) {
                throw new HttpError(
                    409,
                    latest.warning
                        ? "The release notes have a warning: read it, then confirm that you did."
                        : "Pi Pocket could not read the release notes: read them on GitHub, then confirm that you did.",
                );
            }

            if (status.busy > 0 && options.allowBusy !== true) {
                throw new HttpError(409, "Pi works in a session now: update when it is done.");
            }

            const stillWanted = () =>
                options.stillWanted?.() ??
                (this.#options.busy() > 0 && options.allowBusy !== true
                    ? "Pi started to work in a session: update when it is done."
                    : undefined);

            if (status.installKind === "npm-global") {
                return await this.#applyNpm(latest, stillWanted, options.by);
            }

            if (
                target === undefined ||
                status.commit === undefined ||
                status.branch === undefined
            ) {
                throw new HttpError(409, `${latest.tag} is not downloaded: check again.`);
            }

            this.#options.log(
                `Updating Pi Pocket from ${this.#options.version} to ${latest.version}${options.by === undefined ? "" : ` (${options.by})`}.`,
            );

            if (status.packages) {
                this.#setStep("Installing packages");

                try {
                    await this.#install(target.commit);
                } catch (error) {
                    // Noted, so an install by itself does not try the same release again and again.
                    recordOutcome(
                        this.#root,
                        {
                            tag: latest.tag,
                            fromVersion: this.#options.version,
                            toVersion: latest.version,
                        },
                        `The update to ${latest.version} did not install its packages, so Pi Pocket stays at ${this.#options.version}: ${describe(error)}`,
                        this.#now,
                    );

                    throw error;
                }
            }

            const reason = stillWanted();

            if (reason !== undefined) {
                throw new HttpError(409, reason);
            }

            const pending: PendingUpdate = {
                v: 1,
                tag: latest.tag,
                fromVersion: this.#options.version,
                toVersion: latest.version,
                from: status.commit,
                to: target.commit,
                branch: status.branch,
                modules: status.packages,
                oneWay: needsCare(latest),
                phase: "packages",
                at: this.#now,
            };

            // The checkout as it was checked, a moment ago: nothing of the owner's in what the move changes.
            const now = await this.#local();
            const paths = await this.#switchPaths(status.commit, target.commit);
            const blocker =
                !now.git || now.commit !== status.commit || now.branch !== status.branch
                    ? "The checkout changed while the update got ready: check again."
                    : now.dirty.length > 0
                      ? `Files changed while the update got ready (${now.dirty.slice(0, 3).join(", ")}): commit them, or put them aside with \`git stash\`, first.`
                      : await this.#inTheWay(paths.added);

            if (blocker !== undefined) {
                throw new HttpError(409, blocker);
            }

            this.#setStep(`Switching to ${latest.tag}`);
            this.#options.quiesce?.(true);

            try {
                writePending(this.#root, pending);

                if (status.packages) {
                    swapInModules(this.#root);
                }

                writePending(this.#root, { ...pending, phase: "switching" });
                // Never over a file of yours: an ignored file where the release has one stops the update.
                await git(
                    this.#root,
                    status.branch === null
                        ? [
                              "checkout",
                              "--quiet",
                              "--no-overwrite-ignore",
                              "--detach",
                              target.commit,
                          ]
                        : [
                              "merge",
                              "--quiet",
                              "--ff-only",
                              "--no-overwrite-ignore",
                              "--no-edit",
                              target.commit,
                          ],
                );
            } catch (error) {
                // Git checks before it writes: a move it refused left the checkout as it was. One that failed while it
                // wrote (a full disk) may have left some of the release's files: then the update stays noted, reloads
                // stay paused, and the restart puts the files before back (`recover`), or the launcher does.
                const head = (await git(this.#root, ["rev-parse", "HEAD"]).catch(() => "")).trim();
                const touched = new Set([...paths.added, ...paths.other]);
                const left = changedFiles(
                    await git(this.#root, [
                        "status",
                        "--porcelain=v1",
                        "-z",
                        "--untracked-files=no",
                    ]).catch(() => "?? unknown\0"),
                );
                const clean =
                    head === status.commit &&
                    !left.some((path) => touched.has(path) || path === "unknown") &&
                    (await this.#inTheWay(paths.added)) === undefined;

                if (!clean) {
                    this.#options.log(
                        `The update to ${latest.version} stopped part way: ${describe(error)}`,
                    );

                    throw new HttpError(
                        500,
                        `The update to ${latest.version} stopped part way (${describe(error)}). Restart the server (menu → Restart server): Pi Pocket then puts the version before back.`,
                    );
                }

                if (status.packages) {
                    restoreModules(this.#root);
                }

                finishPending(
                    this.#root,
                    pending,
                    false,
                    `The update to ${latest.version} failed: ${describe(error)}`,
                    this.#now,
                );
                this.#options.quiesce?.(false);

                throw new HttpError(
                    500,
                    `The update to ${latest.version} failed: ${describe(error)}`,
                );
            }

            this.#setStep("Restarting");
            // A moment for the answer and the step to reach the tabs.
            setTimeout(() => this.#options.restart(), 500);

            return { restarting: true, version: latest.version };
        } catch (error) {
            this.#setStep(undefined);
            await rm(updatePaths(this.#root).staging, { recursive: true, force: true }).catch(
                () => {},
            );

            throw error;
        }
    }

    /** Stage a self-contained global package, then move it into the unchanged global bin link's target. */
    async #applyNpm(
        latest: Release,
        stillWanted: () => string | undefined,
        by?: string,
    ): Promise<{ restarting: true; version: string }> {
        const pending: PendingUpdate = {
            v: 1,
            kind: "npm-global",
            tag: latest.tag,
            fromVersion: this.#options.version,
            toVersion: latest.version,
            from: this.#options.version,
            to: latest.version,
            branch: null,
            modules: false,
            oneWay: needsCare(latest),
            phase: "packages",
            at: this.#now,
        };

        this.#options.log(
            `Updating Pi Pocket from ${pending.fromVersion} to ${pending.toVersion}${by === undefined ? "" : ` (${by})`}.`,
        );
        // Someone started to work while npm staged the package: nothing failed, so no outcome is noted (as for git),
        // and an install by itself tries this release again once the sessions are quiet.
        let declined = false;

        writePending(this.#root, pending);

        try {
            this.#setStep("Installing packages");
            await stageNpmUpdate(this.#root, latest.version);
            const reason = stillWanted();

            if (reason !== undefined) {
                declined = true;

                throw new HttpError(409, reason);
            }

            this.#setStep(`Switching to ${latest.tag}`);
            this.#options.quiesce?.(true);
            swapInPackage(this.#root);
        } catch (error) {
            // No new server ran yet, so even a warning release can safely restore the package here.
            // If restoration fails, keep the pending state and stopped watchers for launcher recovery.
            try {
                if (!restorePackage(this.#root)) {
                    throw new Error("The previous npm package is missing.");
                }

                if (declined) {
                    clearPending(this.#root);
                } else {
                    finishPending(
                        this.#root,
                        pending,
                        false,
                        `The update to ${latest.version} failed, so Pi Pocket stays at ${pending.fromVersion}: ${describe(error)}`,
                        this.#now,
                    );
                }

                this.#options.quiesce?.(false);
            } catch (restoreError) {
                throw new HttpError(
                    500,
                    `The update stopped part way (${describe(error)}), and restoring the package failed (${describe(restoreError)}). Restart the server to recover the previous version.`,
                );
            }

            if (error instanceof HttpError) {
                throw error;
            }

            throw new HttpError(500, `The npm update failed: ${describe(error)}`);
        }

        this.#setStep("Restarting");
        setTimeout(() => this.#options.restart(), 500);

        return { restarting: true, version: latest.version };
    }

    /** The release's packages, installed in `staging/` from its lock file, while the checkout stays as it is. */
    async #install(commit: string): Promise<void> {
        const { staging } = updatePaths(this.#root);

        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { recursive: true });

        for (const file of ["package.json", "package-lock.json"]) {
            await writeFile(
                join(staging, file),
                await git(this.#root, ["show", `${commit}:${file}`]),
            );
        }

        const { file, shell } = npmCommand();

        try {
            // Through a shell (Windows' npm.cmd), a path with spaces needs its quotes.
            await run(
                shell ? `"${file}"` : file,
                ["ci", "--no-audit", "--no-fund"],
                staging,
                NPM_TIMEOUT_MS,
                shell,
            );
        } catch (error) {
            throw new HttpError(500, `Installing the new packages failed: ${describe(error)}`);
        }
    }

    /**
     * At the start, after everything else opened: an update the server restarted for has started, so it is done. One
     * that stopped before it moved the checkout gets its packages back. Leftovers of an install go.
     */
    async recover(): Promise<UpdateOutcome | undefined> {
        // Only a server under the launcher updates: another one (a test's, or one run by hand) leaves the files be.
        if (!this.#options.supervised) {
            return undefined;
        }

        const paths = updatePaths(this.#root);
        const pending = readPending(this.#root);

        if (pending === undefined) {
            await rm(paths.staging, { recursive: true, force: true });

            return undefined;
        }

        if (pending.kind === "npm-global") {
            const outcome = finishNpmPending(this.#root, pending, this.#now);

            if (outcome.ok) {
                await rm(paths.previous, { recursive: true, force: true }).catch(() => {});
            }

            await rm(paths.staging, { recursive: true, force: true });
            this.#options.log(outcome.message);

            return outcome;
        }

        const head = (await git(this.#root, ["rev-parse", "HEAD"]).catch(() => "")).trim();
        let outcome: UpdateOutcome;
        let restart = false;

        if (head === pending.to) {
            outcome = finishPending(
                this.#root,
                pending,
                true,
                `Pi Pocket updated from ${pending.fromVersion} to ${pending.toVersion}.`,
                this.#now,
            );
            void rm(paths.previous, { recursive: true, force: true }).catch(() => {});
        } else if (head === pending.from) {
            // Files change under a server that runs: nothing reloads them now, and a restart starts on the right ones.
            this.#options.quiesce?.(true);
            outcome = finishPartial(this.#root, pending, this.#now);
            restart = true;
        } else {
            outcome = finishPending(
                this.#root,
                pending,
                false,
                `The checkout changed during the update to ${pending.toVersion}, so Pi Pocket did not finish it.`,
                this.#now,
            );
        }

        await rm(paths.staging, { recursive: true, force: true });
        this.#options.log(outcome.message);

        if (restart) {
            this.#options.restart();
        }

        return outcome;
    }
}
