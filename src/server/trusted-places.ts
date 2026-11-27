/**
 * The places that Pi's own settings name and that Pi loads or runs for every session: the resource paths (`skills`,
 * `prompts`, `extensions`, `themes`, and the local `packages`), and the programs it runs, with every argument of each
 * (`shellPath`, `npmCommand`, `selfUpdateCommand`, and what the MCP servers of `mcp.json` run). They are read from the
 * files each time. A path is resolved as Pi resolves one: `resolvePath` of `utils/paths.js` in
 * `@earendil-works/pi-coding-agent`, which the package does not export, so it is mirrored here (`~`, then a `file://`
 * address decoded as `fileURLToPath` does, then relative to the settings file's folder); and a source is local unless
 * it starts with what `isLocalPath` of the same file refuses. A path that is not there yet counts. A file that cannot
 * be read or understood throws: what it names cannot be known, so the caller does not count it as clean.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What Pi's `isLocalPath` takes for a source that is not a path. */
const NOT_LOCAL = /^(npm|git|github|http|https|ssh|builtin):/;
const GLOB = /[*?[{(]/;
/** Resource lists whose entries are paths, and the settings that are one program each. */
const RESOURCES = ["skills", "prompts", "extensions", "themes"] as const;
const PROGRAMS = ["shellPath", "npmCommand", "selfUpdateCommand"] as const;
/** An argument that may name a file: absolute, relative with a dot, in the home folder, or an address. */
const PATH_LIKE = /^(\/|\.\.?\/|~(\/|$)|file:\/\/)/;

function read(file: string): Record<string, unknown> | undefined {
    if (!existsSync(file)) {
        return undefined;
    }

    const found: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

    if (typeof found !== "object" || found === null || Array.isArray(found)) {
        throw new Error(`${file} does not hold an object`);
    }

    return found as Record<string, unknown>;
}

/** Pi's `resolvePath(input, base, { homeDir, trim: true })`. */
function resolveLikePi(input: string, base: string, home: string): string {
    let path = input.trim();

    if (path === "~") {
        path = home;
    } else if (path.startsWith("~/")) {
        path = join(home, path.slice(2));
    } else if (/^file:\/\//.test(path)) {
        path = fileURLToPath(path);
    }

    return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

/** A pattern names every match below its fixed part: that folder is the place. */
function fixedPart(path: string): string {
    const glob = path.search(GLOB);

    return glob === -1 ? path : path.slice(0, glob).replace(/[^\\/]*$/, "");
}

/** The configured places of Pi's settings and MCP file, as paths. `cwd` is where a relative program argument may start. */
export function configuredPlaces(agentDir: string, home: string, cwd: string): string[] {
    const settings = read(join(agentDir, "settings.json")) ?? {};
    const found: string[] = [];

    /** A resource entry: a path from the settings file's folder; an exclusion or a package source is not one. */
    const resource = (entry: unknown) => {
        if (typeof entry !== "string") {
            return;
        }

        const path = entry.trim().replace(/^\+/, "");

        if (path !== "" && !/^[!-]/.test(path) && !NOT_LOCAL.test(path)) {
            const fixed = fixedPart(path);

            if (fixed !== "") {
                found.push(resolveLikePi(fixed, agentDir, home));
            }
        }
    };

    /** A program, and each argument of it that may be a file: from the settings file's folder, and from the cwd. */
    const program = (words: unknown) => {
        for (const word of Array.isArray(words) ? words : [words]) {
            if (typeof word === "string" && PATH_LIKE.test(word.trim())) {
                found.push(resolveLikePi(word, agentDir, home), resolveLikePi(word, cwd, home));
            }
        }
    };

    for (const name of RESOURCES) {
        const list = settings[name];

        for (const entry of Array.isArray(list) ? list : []) {
            resource(entry);
        }
    }

    for (const each of Array.isArray(settings.packages) ? settings.packages : []) {
        resource(
            typeof each === "object" && each !== null
                ? (each as { source?: unknown }).source
                : each,
        );
    }

    for (const name of PROGRAMS) {
        program(settings[name]);
    }

    const servers = read(join(agentDir, "mcp.json"))?.mcpServers;

    for (const server of Object.values(
        typeof servers === "object" && servers !== null ? servers : {},
    )) {
        const { command, args } = (server ?? {}) as { command?: unknown; args?: unknown };

        program([command, ...(Array.isArray(args) ? args : [])]);
    }

    return [...new Set(found)];
}
