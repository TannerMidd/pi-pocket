/** Paths as people write them (`~/project`, `D:\work`) and as activity lines show them. */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import nodePath, { relative, sep } from "node:path";

/** `~` and `~/x` (and `~\x` on Windows) to absolute paths; anything else unchanged. */
export function expandHome(written: string, home = homedir(), paths = nodePath): string {
    if (written === "~") {
        return home;
    }

    if (written.startsWith("~/") || (paths.sep === "\\" && written.startsWith("~\\"))) {
        return paths.join(home, written.slice(2));
    }

    return written;
}

/**
 * A folder as people type it, made whole: `~` paths expanded, and on Windows a bare drive (`D:`) is that drive's
 * top folder (`D:\`), not the folder last used on it. Relative paths are left to the caller to resolve.
 */
export function expandFolder(written: string, home = homedir(), paths = nodePath): string {
    const expanded = expandHome(written, home, paths);

    return paths.sep === "\\" && /^[A-Za-z]:$/.test(expanded) ? `${expanded}\\` : expanded;
}

/** The folder `folder` is in, or null at a root (`/`, `D:\`, `\\server\share\`). */
export function parentFolder(folder: string, paths = nodePath): string | null {
    const parent = paths.dirname(folder);

    return parent === folder ? null : parent;
}

/** How long the drive check waits for a drive that does not answer (a mapped network drive that is offline). */
const DRIVE_WAIT_MS = 1500;

/** Whether `folder` is a folder there now. */
const isFolder = (folder: string): Promise<boolean> =>
    stat(folder).then(
        (found) => found.isDirectory(),
        () => false,
    );

/**
 * The top folders of this machine, for the folder picker's places: `/` on Linux and macOS; on Windows each drive that
 * is there now (`C:\`, `D:\`, …), A to Z, checked all at once. A drive that fails, or does not answer in `wait`
 * milliseconds, is left out.
 */
export async function rootFolders(
    platform: NodeJS.Platform = process.platform,
    isThere: (folder: string) => Promise<boolean> = isFolder,
    wait = DRIVE_WAIT_MS,
): Promise<string[]> {
    if (platform !== "win32") {
        return ["/"];
    }

    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<false>((done) => {
        timer = setTimeout(() => done(false), wait);
    });
    const letters = Array.from(
        { length: 26 },
        (_, index) => `${String.fromCharCode(65 + index)}:\\`,
    );

    try {
        const there = await Promise.all(
            letters.map((drive) => Promise.race([isThere(drive).catch(() => false), late])),
        );

        return letters.filter((_, index) => there[index]);
    } finally {
        clearTimeout(timer);
    }
}

/** How long this machine's top folders are kept between listings: a drive plugged in shows within this. */
const ROOTS_KEPT_MS = 10_000;

let roots: { at: number; list: Promise<string[]> } | undefined;

/** This machine's top folders (`rootFolders`), checked again at most every 10 seconds. */
export function machineRoots(): Promise<string[]> {
    if (roots === undefined || Date.now() - roots.at > ROOTS_KEPT_MS) {
        roots = { at: Date.now(), list: rootFolders() };
    }

    return roots.list;
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
