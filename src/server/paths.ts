/** Paths as people write them (`~/project`) and as activity lines show them. */
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

/** `~` and `~/x` to absolute paths; anything else unchanged. */
export function expandHome(path: string): string {
    if (path === "~") {
        return homedir();
    }

    if (path.startsWith("~/")) {
        return join(homedir(), path.slice(2));
    }

    return path;
}

/** `~/x` for paths under home. */
export function homePath(path: string): string {
    const home = homedir();

    return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** A path as people read it in a session: relative to its folder when inside it, else `~/x` or absolute. */
export function displayPath(path: string, cwd: string): string {
    return path.startsWith(cwd + sep) ? relative(cwd, path) : homePath(path);
}

/**
 * The scheme of a workspace URI (`ssh://host/path`), lower case, or undefined for a local path.
 * It needs 2 characters or more and `://`, so a Windows drive (`C:\work`, `D:`) stays a path.
 */
export function workspaceScheme(cwd: string): string | undefined {
    return /^([a-z][a-z0-9+.-]+):\/\//i.exec(cwd)?.[1]?.toLowerCase();
}
