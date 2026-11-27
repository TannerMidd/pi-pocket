/**
 * What the sandbox allows, as data and small functions: which paths the guest may not write (a `.git` entry, a git
 * directory), which hosts the network allows by default, and what runs where. The sheet shows the same table that the gate uses.
 */
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { SANDBOX_INERT_TOOLS, SANDBOX_ROUTED_TOOLS } from "../../sandbox.ts";

/** Where this machine keeps what a sandbox must never share. */
export interface PrivatePlaces {
    readonly home: string;
    /** Pi Pocket's data folder (`PI_POCKET_DIR`): sign-ins, the token, every session's files. */
    readonly dataDir: string;
    /** Pi's folder (`~/.pi/agent`): sign-ins. */
    readonly agentDir: string;
}

/** Folders of the home folder that hold sign-ins and keys: a sandbox shares none, and none that is inside one. */
const PRIVATE_FOLDERS = [
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".pi",
    ".pass" + "word-store",
    ".net" + "rc",
    ".config/gcloud",
    ".config/gh",
];
/** Folders that hold other programs' data and tokens: a sandbox shares none, but may share one inside them. */
const BROAD_FOLDERS = [".config", ".local/share", ".local/state", ".cache", ".mozilla", ".agents"];

function canonical(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

export function within(child: string, parent: string): boolean {
    return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Why a sandbox may not mount `path`, or undefined when it may. A sandbox shares a folder with the guest whole, so a
 * folder that is, or holds, the home folder or a place that keeps sign-ins and keys would hand those to it. `kind`
 * "folder" is the session's own folder, a git directory, "skill" a skill folder that is read only: those may lie inside
 * Pi's own `skills` folder, and nothing else of Pi's folder.
 */
export function folderProblem(
    path: string,
    places: PrivatePlaces,
    kind: "folder" | "skill" = "folder",
): string | undefined {
    const target = canonical(path);
    const home = canonical(places.home);
    const data = canonical(places.dataDir);
    const agent = canonical(places.agentDir);
    const closed = [...PRIVATE_FOLDERS.map((name) => join(home, name)), data, agent].map(canonical);
    const broad = BROAD_FOLDERS.map((name) => join(home, name)).map(canonical);
    const say = (what: string) =>
        `${path} is, or holds, ${what}, which keeps sign-ins and keys: a sandbox cannot share it. Use a project folder inside it.`;

    if (within(home, target)) {
        return say("your home folder");
    }

    for (const place of [...closed, ...broad]) {
        if (within(place, target)) {
            return say(place);
        }
    }

    if (kind === "skill") {
        return undefined;
    }

    // The data folder keeps the sessions' own worktrees: those are project folders.
    if (within(target, join(data, "worktrees"))) {
        return undefined;
    }

    for (const place of closed) {
        if (within(target, place)) {
            return say(place);
        }
    }

    return undefined;
}

/** Code points that HFS+ ignores when it compares names: `.g\u200cit` is `.git` there. */
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * Whether a file name is `.git` under Git's own equivalence rules (`verify_path`, `is_ntfs_dotgit`, `is_hfs_dotgit`):
 * any case, NTFS trailing dots and spaces and data streams, the NTFS short name `git~1`, and HFS+ ignorable code points.
 */
export function isDotGit(name: string): boolean {
    return (
        name.replace(HFS_IGNORABLE, "").toLowerCase() === ".git" ||
        /^(\.git|git~\d+)[ .]*(:.*)?$/i.test(name)
    );
}

/** Whether any component of `path` (separated by `/` or `\`) is a `.git` entry. */
export function hasDotGit(path: string): boolean {
    return path.split(/[\\/]/).some(isDotGit);
}

function lower(path: string): string {
    return path.toLowerCase();
}

/**
 * What the guest may never write, as a predicate on host paths: every git directory (`gitDirs`, real paths), and, in
 * the folder `root`, every entry below a name that is `.git`. The guest reads all of it. Case is ignored, so a file
 * system that folds case gives no way round.
 */
export function gitProtected(root: string, gitDirs: readonly string[]): (path: string) => boolean {
    const dirs = gitDirs.map(lower);
    const top = lower(root);

    return (path) => {
        const here = lower(path);

        return (
            dirs.some((dir) => within(here, dir)) ||
            (within(here, top) && hasDotGit(here.slice(top.length)))
        );
    };
}

/** Whether `path` holds a git directory: moving it would move the directory to a name that nothing guards. */
export function holdsGitDir(path: string, gitDirs: readonly string[]): boolean {
    return gitDirs.some((dir) => within(lower(dir), lower(path)));
}

/** The hosts a sandbox may reach by default: package registries and GitHub. The owner edits the list. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
    "registry.npmjs.org",
    "*.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "static.crates.io",
    "index.crates.io",
    "proxy.golang.org",
    "rubygems.org",
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    "dl-cdn.alpinelinux.org",
];

export interface WhereRow {
    readonly what: string;
    readonly where: "sandbox" | "host" | "blocked";
    readonly note: string;
}

/** What runs where in a sandboxed session, for the sheet. `hostTools` is the owner's setting. */
export function whereTable(hostTools: "block" | "allow"): WhereRow[] {
    const host = hostTools === "allow" ? "host" : "blocked";

    return [
        {
            what: [...SANDBOX_ROUTED_TOOLS].join(", "),
            where: "sandbox",
            note: "Pi's file and shell tools, `!` commands, and Done when checks run in the VM.",
        },
        {
            what: "subagents, codemode",
            where: "sandbox",
            note: "Their own tool calls go through the same rules.",
        },
        {
            what: [...SANDBOX_INERT_TOOLS]
                .filter((tool) => tool !== "subagent" && tool !== "codemode")
                .join(", "),
            where: "host",
            note: "They only change Pi Pocket's own state. They run in the server.",
        },
        {
            what: "artifact (content), Files, Changes, the file viewer",
            where: "host",
            note: "Pi Pocket reads the shared folder itself, for people. Not Pi's commands.",
        },
        {
            what: "browser, the Browser panel",
            where: "sandbox",
            note: "A Chromium inside the VM (needs the image With browser), with the sandbox's network rules. This machine's browser is never used for a sandboxed session.",
        },
        {
            what: "background",
            where: "sandbox",
            note: "Its processes run in the VM and keep it up. They end with the VM (a restart of Pi Pocket ends it, and Pi is told), and never resume. A server there is reached by the browser in the sandbox at localhost.",
        },
        {
            what: "team (start, send, list)",
            where: "sandbox",
            note: "A linked session that a sandboxed session starts runs in a sandbox of its own, with the same rules and in the same folder (the owner can allow other folders). It can message only sandboxed linked sessions and the session that started it.",
        },
        {
            what: "session tools, design tools, watch_pr, MCP and other extensions' tools",
            where: host,
            note:
                hostTools === "allow"
                    ? "The owner allowed host tools: these run on this machine, outside the VM."
                    : "These run on this machine, outside the VM, so they are blocked.",
        },
    ];
}
