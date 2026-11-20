import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

/** `O_RDONLY | O_NONBLOCK` where the system has it: a pipe swapped in for the file does not hold the reader. */
export const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

function linkError(path: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`ELOOP: a link is not followed, open '${path}'`), {
        code: "ELOOP",
        path,
    });
}

function same(before: Stats, after: Stats): boolean {
    return before.dev === after.dev && before.ino === after.ino;
}

/**
 * Opens a file, never through a link as its last part, on every system. `O_NOFOLLOW` does that where it exists; it
 * does not exist on Windows. So the path is also checked with `lstat` first, and the file opened must be the file
 * checked (device and inode), which refuses a link that takes the file's place between the check and the open.
 */
export function openNoFollowSync(path: string, flags: number = READ_FLAGS): number {
    const before = lstatSync(path);

    if (before.isSymbolicLink()) {
        throw linkError(path);
    }

    const fd = openSync(path, flags | (constants.O_NOFOLLOW ?? 0));

    try {
        if (!same(before, fstatSync(fd))) {
            throw linkError(path);
        }
    } catch (error) {
        closeSync(fd);

        throw error;
    }

    return fd;
}

/** `openNoFollowSync`, as a `FileHandle`. */
export async function openNoFollow(path: string, flags: number = READ_FLAGS): Promise<FileHandle> {
    const before = await lstat(path);

    if (before.isSymbolicLink()) {
        throw linkError(path);
    }

    const handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0));

    try {
        if (!same(before, await handle.stat())) {
            throw linkError(path);
        }
    } catch (error) {
        await handle.close();

        throw error;
    }

    return handle;
}
