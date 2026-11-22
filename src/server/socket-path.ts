/**
 * The server's Unix socket (`--socket`), for a reverse proxy on the same machine. The socket's folder is the security
 * boundary: an administrator makes it, owned by the server's user (or root) and writable by nobody else, so no other
 * Unix user can take the address while the server restarts, as one can take a free TCP port. The launcher imports
 * `parseSocketPath` and `socketArgument`, so this file imports nothing of the server's.
 */
import { chmodSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { dirname, isAbsolute, normalize } from "node:path";

/** The socket cannot be used as configured. The message names paths only. */
export class SocketPathError extends Error {}

/**
 * Check `--socket` / `PI_POCKET_SOCKET`. Empty means unset, as for the other environment options; an empty `--socket`
 * argument never gets here (`socketArgument`), so it cannot fall back to a TCP port.
 */
export function parseSocketPath(value: string | undefined): string | undefined {
    if (value === undefined || value === "") {
        return undefined;
    }

    if (process.platform === "win32") {
        throw new SocketPathError("--socket needs a Unix system");
    }

    if (!isAbsolute(value) || normalize(value) !== value || value.endsWith("/")) {
        throw new SocketPathError(
            "--socket must be an absolute, normalized file path (no . or .. segments)",
        );
    }

    // A Unix socket address holds 108 bytes on Linux and 104 on macOS, with the final zero byte.
    const limit = process.platform === "darwin" ? 103 : 107;

    if (Buffer.byteLength(value) > limit) {
        throw new SocketPathError(
            `--socket path ${value} is ${Buffer.byteLength(value)} bytes long; this system allows ${limit} at most. Use a shorter path.`,
        );
    }

    return value;
}

function othersMayWrite(stat: { uid: number; mode: number }, sticky: boolean): boolean {
    if (stat.uid !== process.getuid!() && stat.uid !== 0) {
        return true;
    }

    // In a sticky folder (/tmp) only an entry's owner can rename or remove it.
    return (stat.mode & 0o022) !== 0 && !(sticky && (stat.mode & 0o1000) !== 0);
}

/**
 * Check the folder, and remove a stale socket that no server answers on, before listening. Refuses a folder that is a
 * symlink or reached through one, that another user owns, or that its group or others may write; and a folder above it
 * that another user could rename or replace (a sticky one, such as /tmp, is fine). Refuses any entry at the path that
 * is not a socket: it never follows a symlink or removes another kind of file.
 */
export async function prepareSocketPath(path: string): Promise<void> {
    const folder = dirname(path);
    let stat;

    try {
        stat = lstatSync(folder);
    } catch (error) {
        throw new SocketPathError(
            `The socket folder ${folder} is not usable (${(error as NodeJS.ErrnoException).code}). An administrator creates it.`,
        );
    }

    if (!stat.isDirectory() || realpathSync(folder) !== folder) {
        throw new SocketPathError(
            `The socket folder ${folder} must be a real folder, not a symlink or a path through one.`,
        );
    }

    if (stat.uid !== process.getuid!() && stat.uid !== 0) {
        throw new SocketPathError(
            `The socket folder ${folder} must be owned by this user or root.`,
        );
    }

    if (othersMayWrite(stat, false)) {
        throw new SocketPathError(
            `The socket folder ${folder} must not be writable by its group or others (for example mode 2750).`,
        );
    }

    for (let above = dirname(folder); ; above = dirname(above)) {
        if (othersMayWrite(lstatSync(above), true)) {
            throw new SocketPathError(
                `${above}, above the socket folder, must be owned by this user or root, and writable by no one else (or sticky, as /tmp is).`,
            );
        }

        if (above === dirname(above)) {
            break;
        }
    }

    let entry;

    try {
        entry = lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
        }

        throw error;
    }

    if (!entry.isSocket()) {
        throw new SocketPathError(`${path} exists and is not a socket: remove it by hand.`);
    }

    if (await answers(path)) {
        throw Object.assign(new Error(`${path} is in use`), { code: "EADDRINUSE" });
    }

    // Only this user and root can change entries in the checked folder, so the entry is still the stale socket.
    unlinkSync(path);
}

function answers(path: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const probe = connect({ path });

        probe.once("connect", () => {
            probe.destroy();
            resolve(true);
        });
        probe.once("error", (error: NodeJS.ErrnoException) => {
            probe.destroy();

            if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
                resolve(false);
            } else {
                reject(error);
            }
        });
    });
}

/** The value of a `--socket` argument: an empty one (an unset shell variable) is refused, never taken as unset. */
export function socketArgument(value: string): string {
    if (value === "") {
        throw new SocketPathError("--socket needs a path; it is empty");
    }

    return value;
}

/**
 * After listening: check that the new file is this process's socket, and open it to the folder's group (the reverse
 * proxy's). Other users cannot reach it, since the folder lets them in no further than its group.
 */
export function claimSocket(path: string): void {
    const stat = lstatSync(path);

    if (!stat.isSocket() || stat.uid !== process.getuid!()) {
        throw new SocketPathError(`${path} is not the socket this server made.`);
    }

    chmodSync(path, 0o660);
}
