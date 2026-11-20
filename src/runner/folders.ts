/** Allowed working folders belong to this computer, never to the server. */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

function comparable(folder: string, platform: NodeJS.Platform): string {
    const paths = platform === "win32" ? win32 : posix;
    const normalized = paths.normalize(folder);
    const root = paths.parse(normalized).root;
    const trimmed =
        normalized === root
            ? root
            : normalized.replace(platform === "win32" ? /[\\/]+$/ : /\/+$/, "");

    return platform === "darwin" || platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** Same folder or a descendant, not a sibling with the same prefix. */
export function folderContains(
    parent: string,
    folder: string,
    platform: NodeJS.Platform = process.platform,
): boolean {
    const left = comparable(parent, platform);
    const right = comparable(folder, platform);
    const separator = platform === "win32" ? "\\" : "/";

    return (
        right === left || right.startsWith(left.endsWith(separator) ? left : `${left}${separator}`)
    );
}

/** A root, the home folder, or an ancestor of the home folder must not be saved by an Allow answer. */
export function broadFolder(
    folder: string,
    home: string,
    platform: NodeJS.Platform = process.platform,
): boolean {
    const paths = platform === "win32" ? win32 : posix;

    return (
        comparable(folder, platform) === comparable(paths.parse(folder).root, platform) ||
        folderContains(folder, home, platform)
    );
}

/** A missing asked folder keeps the path the server gave. */
export async function realFolder(folder: string): Promise<string> {
    return realpath(folder).catch(() => folder);
}

/** Missing saved folders do not grant access, including paths through a replaced symlink. */
export async function coveredFolder(folder: string, folders: readonly string[]): Promise<boolean> {
    const home = await realFolder(homedir());

    for (const saved of folders) {
        try {
            const real = await realpath(saved);

            if (!broadFolder(real, home) && folderContains(real, folder)) {
                return true;
            }
        } catch {
            // A saved folder that no longer exists grants nothing.
        }
    }

    return false;
}

/** Compare an entry for removal, also when the saved folder no longer exists. */
export async function sameFolder(left: string, right: string): Promise<boolean> {
    const [a, b] = await Promise.all([realFolder(left), realFolder(right)]);

    return folderContains(a, b) && folderContains(b, a);
}
