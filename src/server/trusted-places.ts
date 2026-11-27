/**
 * The places that Pi's own settings name and that Pi loads as code, instructions, or settings for every session: the
 * resource paths (`skills`, `prompts`, `extensions`, `themes`, and the local `packages`), the programs it runs
 * (`shellPath`, `npmCommand`, `selfUpdateCommand`), and what the MCP servers of `mcp.json` run. They are read from the
 * files each time, with the loader's own rules: `~` is the home folder, and a relative path is relative to Pi's folder,
 * where the settings file is. A path that is not there yet counts. A file that cannot be read or understood throws:
 * what it names cannot be known, so the caller does not count it as clean.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** A name that is a scheme (`npm:`, `git:`, `builtin:`, `https:`), not a path; `file:` is a path. */
const SCHEME = /^(?!file:)[a-z][a-z0-9+.-]+:/i;
const GLOB = /[*?[{(]/;
/** Resource lists whose entries are paths, and the settings that are one program each. */
const RESOURCES = ["skills", "prompts", "extensions", "themes"] as const;
const PROGRAMS = ["shellPath", "npmCommand", "selfUpdateCommand"] as const;

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

/** One configured entry as a path, or none: a scheme, an exclusion, or a name that is not a path. */
function place(entry: unknown, agentDir: string, home: string, mustHaveSlash = false): string[] {
    if (typeof entry !== "string") {
        return [];
    }

    let path = entry
        .trim()
        .replace(/^\+/, "")
        .replace(/^file:(\/\/)?/, "");

    if (path === "" || /^[!-]/.test(path) || SCHEME.test(path)) {
        return [];
    }

    if (mustHaveSlash && !/[\\/]/.test(path) && !path.startsWith("~")) {
        return [];
    }

    path = path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

    // A pattern names every match below its fixed part: that folder is the place.
    const glob = path.search(GLOB);

    if (glob !== -1) {
        path = path.slice(0, glob).replace(/[^\\/]*$/, "");
    }

    return path === "" ? [] : [resolve(agentDir, path)];
}

/** The configured places of Pi's settings and MCP file, as paths. */
export function configuredPlaces(agentDir: string, home: string): string[] {
    const settings = read(join(agentDir, "settings.json")) ?? {};
    const at = (entry: unknown, mustHaveSlash = false) =>
        place(entry, agentDir, home, mustHaveSlash);
    const found: string[] = [];

    for (const name of RESOURCES) {
        const list = settings[name];

        found.push(...(Array.isArray(list) ? list.flatMap((entry) => at(entry)) : []));
    }

    const packages = settings.packages;

    for (const each of Array.isArray(packages) ? packages : []) {
        found.push(
            ...at(
                typeof each === "object" && each !== null
                    ? (each as { source?: unknown }).source
                    : each,
            ),
        );
    }

    for (const name of PROGRAMS) {
        const value = settings[name];

        found.push(...at(Array.isArray(value) ? value[0] : value, true));
    }

    const servers = read(join(agentDir, "mcp.json"))?.mcpServers;

    for (const server of Object.values(
        typeof servers === "object" && servers !== null ? servers : {},
    )) {
        const { command, args } = (server ?? {}) as { command?: unknown; args?: unknown };

        for (const part of [command, ...(Array.isArray(args) ? args : [])]) {
            found.push(...at(part, true));
        }
    }

    return [...new Set(found)];
}
