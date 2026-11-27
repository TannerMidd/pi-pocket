/**
 * What the sandbox allows, as data and small functions: which files of the folder the guest may not write, which hosts
 * the network allows by default, and what runs where. The sheet shows the same table that the gate uses.
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

function within(child: string, parent: string): boolean {
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

/** Operations that change an entry, as Gondolin's file system names them. */
const CHANGES = new Set([
    "mkdir",
    "rmdir",
    "unlink",
    "rename",
    "link",
    "symlink",
    "chmod",
    "truncate",
    "open-write",
    "write",
]);

/**
 * Whether `rest`, the path below a git folder, is a file that points Git at another folder: with it the host's `git`
 * would read the config and hooks of a folder that the guest made. They are `commondir` (where the shared config, hooks,
 * and objects are) of the repository, of a linked worktree (`worktrees/<name>/`), or of a submodule (`modules/<name>/`,
 * nested ones too); the `gitdir` of a linked worktree or a submodule; and the lists of other object stores. A branch
 * or a worktree named like one of them is no such file: only the places Git looks at count.
 */
function redirectsGit(rest: string[]): boolean {
    let inner = rest;
    let nested = false;

    while ((inner[0] === "worktrees" || inner[0] === "modules") && inner.length >= 3) {
        inner = inner.slice(2);
        nested = true;
    }

    const name = inner.join("/");

    return (
        name === "commondir" ||
        (nested && name === "gitdir") ||
        name === "objects/info/alternates" ||
        name === "objects/info/http-alternates"
    );
}

/**
 * Whether the guest may not write `path` (absolute inside the folder, `/`-separated). The git rule keeps what the
 * host's own `git` runs from the guest's hands: a repository's config (an `fsmonitor`, a `pager`, an `sshCommand` run as
 * the owner when Pi Pocket's Changes panel or the owner's shell uses git), its hooks, its `info` folder, the files that
 * name filters and submodules, the files that point Git at another folder (`commondir`, a linked worktree's `gitdir`,
 * `objects/info/alternates`), and any change to an entry named `.git` (a swap of the whole repository folder). The
 * guest still reads everything except these files, which look missing to it.
 */
function gitProtected(segments: string[], op: string): boolean {
    const last = segments.at(-1);

    if (last === ".gitmodules" || last === ".gitattributes") {
        return true;
    }

    if (last === ".git" && CHANGES.has(op)) {
        return true;
    }

    for (let at = 0; at < segments.length - 1; at++) {
        if (segments[at] !== ".git") {
            continue;
        }

        const next = segments[at + 1]!;

        if (
            next === "config" ||
            next === "config.worktree" ||
            next === "hooks" ||
            next === "info"
        ) {
            return true;
        }

        if (redirectsGit(segments.slice(at + 1))) {
            return true;
        }

        // Submodules and linked worktrees keep their own config and hooks below `.git/modules` and `.git/worktrees`.
        if (
            (next === "modules" || next === "worktrees") &&
            segments
                .slice(at + 2)
                .some(
                    (part) =>
                        part === "config" ||
                        part === "config.worktree" ||
                        part === "hooks" ||
                        part === "info",
                )
        ) {
            return true;
        }
    }

    return false;
}

/** A predicate for the paths the guest may not write: it still reads them (`real-driver.ts` refuses the writes). */
export function protectedMatcher(
    rules: readonly string[],
): (context: { op: string; path: string; flags?: string }) => boolean {
    const git = rules.includes("git");

    return ({ op, path }) => {
        if (!git) {
            return false;
        }

        // Case-insensitive file systems (macOS, Windows) must not give a way round it.
        const segments = path
            .toLowerCase()
            .split("/")
            .filter((part) => part !== "" && part !== ".");

        return gitProtected(segments, op);
    };
}

/**
 * The same rules for a mount whose root is a `.git` folder itself (the main repository's, for a session on a worktree):
 * its `config`, `hooks`, and `info` are as protected as those of a `.git` folder inside the session's folder.
 */
export function gitDirMatcher(
    rules: readonly string[],
): (context: { op: string; path: string; flags?: string }) => boolean {
    const inner = protectedMatcher(rules);

    return ({ op, path, flags }) =>
        inner({
            op,
            path: `/.git/${path.replace(/^\/+/, "")}`,
            ...(flags === undefined ? {} : { flags }),
        });
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
