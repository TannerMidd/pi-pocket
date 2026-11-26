/**
 * What the sandbox allows, as data and small functions: which files of the folder the guest may not write, which hosts
 * the network allows by default, and what runs where. The sheet shows the same table that the gate uses.
 */
import { SANDBOX_INERT_TOOLS, SANDBOX_ROUTED_TOOLS } from "../../sandbox.ts";

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
 * Whether the guest may not write `path` (absolute inside the folder, `/`-separated). The git rule keeps what the
 * host's own `git` runs from the guest's hands: a repository's config (an `fsmonitor`, a `pager`, an `sshCommand` run as
 * the owner when Pi Pocket's Changes panel or the owner's shell uses git), its hooks, its `info` folder, the files that
 * name filters and submodules, and any change to an entry named `.git` (a swap of the whole repository folder). The
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

/** A predicate for Gondolin's `ShadowProvider`: true for a path the guest may not write (nor read: it looks missing). */
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
            what: "background, session and team tools, design tools, MCP and other extensions' tools",
            where: host,
            note:
                hostTools === "allow"
                    ? "The owner allowed host tools: these run on this machine, outside the VM."
                    : "These run on this machine, outside the VM, so they are blocked.",
        },
    ];
}
