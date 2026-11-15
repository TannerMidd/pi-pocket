/** Files for the relay: what Pi sends is read from its session's folder only, and what it fetches is kept there. */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { workspaceScheme } from "../../paths.ts";
import type { RelayOutFile } from "./types.ts";

/** What one reply sends in all, whatever the connector's caps: the relay holds it in memory while it sends. */
export const MAX_REPLY_BYTES = 100 * 1024 * 1024;

/** Where a fetched attachment goes, in the session's folder. */
export const FETCH_FOLDER = ".relay";

export const TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".zip": "application/zip",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".svg": "image/svg+xml",
};

export const EXTENSIONS: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
};

export const inside = (root: string, path: string): boolean =>
    path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** A name from outside, safe as one file name: no folders, no leading dots, no odd characters. */
export function safeName(name: string, fallback = "file"): string {
    const clean = name
        .replace(/[^A-Za-z0-9._ -]/g, "_")
        .replace(/^[.\s]+/, "")
        .trim()
        .slice(0, 100);

    return clean === "" ? fallback : clean;
}

export async function folderOf(cwd: string | undefined): Promise<string> {
    if (cwd === undefined || cwd === "" || workspaceScheme(cwd) !== undefined) {
        throw new Error("Files work only in a session whose folder is on this machine.");
    }

    return realpath(cwd);
}

/** Pi's paths, read with every check: in the session's folder (links too), not hidden, not the server's data. */
export async function readFiles(
    cwd: string | undefined,
    dataDir: string,
    paths: readonly string[],
    caps: { max: number; maxBytes: number },
): Promise<RelayOutFile[]> {
    if (paths.length > caps.max) {
        throw new Error(`This connector sends ${caps.max} files at most: nothing was sent.`);
    }

    const root = await folderOf(cwd);
    const data = await realpath(dataDir).catch(() => resolve(dataDir));
    const files: RelayOutFile[] = [];
    let total = 0;

    for (const path of paths) {
        const shown = JSON.stringify(path).slice(0, 120);
        const real = await realpath(resolve(root, path)).catch(() => undefined);

        if (real === undefined) {
            throw new Error(`No file ${shown} in this session's folder: nothing was sent.`);
        }

        const parts = relative(root, real).split(sep);

        if (
            !inside(root, real) ||
            real === root ||
            (inside(data, real) && (!inside(data, root) || root === data))
        ) {
            throw new Error(
                `${shown} is outside this session's folder: the relay sends only files in it. Nothing was sent.`,
            );
        }

        if (
            parts.some(
                (part, index) => part.startsWith(".") && !(index === 0 && part === FETCH_FOLDER),
            )
        ) {
            throw new Error(
                `${shown} is in a hidden file or folder, which can hold secrets: the relay does not send it. Nothing was sent.`,
            );
        }

        const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);

        try {
            const stat = await handle.stat();

            if (!stat.isFile()) {
                throw new Error(`${shown} is not a file: nothing was sent.`);
            }

            if (stat.size > caps.maxBytes || stat.size === 0) {
                throw new Error(
                    `${shown} is ${stat.size === 0 ? "empty" : `${Math.ceil(stat.size / 1048576)} MB`}: this connector sends files of ${Math.floor(caps.maxBytes / 1048576)} MB at most. Nothing was sent.`,
                );
            }

            total += stat.size;

            if (total > MAX_REPLY_BYTES) {
                throw new Error(
                    `These files are more than ${MAX_REPLY_BYTES / 1048576} MB in all: the relay sends that much in one reply at most. Nothing was sent.`,
                );
            }

            const name = safeName(basename(real));
            const data = await handle.readFile();

            files.push({
                name,
                type: TYPES[extname(name).toLowerCase()] ?? "application/octet-stream",
                // The file's own bytes, not a copy.
                data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            });
        } finally {
            await handle.close();
        }
    }

    return files;
}
