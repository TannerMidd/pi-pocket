/** One Pi Pocket process per data directory: a lock file in it holds the process id of the one running there. */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * Whether a lock file's process is still running Pi Pocket. A process id can be reused after a crash, so on Linux
 * (and Android) a live process must also be Node; where that cannot be read, a live process counts.
 */
function lockHolder(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return false;
    }

    try {
        process.kill(pid, 0);
    } catch {
        // Gone, or (EPERM) another user's process: Pi Pocket runs as this user, so not a holder either way.
        return false;
    }

    try {
        return /(^|\/)node[^/\0]*\0/.test(readFileSync(`/proc/${pid}/cmdline`, "latin1"));
    } catch {
        return true;
    }
}

/**
 * One process per data directory. A lock left by a process that died (killed, or its phone stopped it) is taken
 * over; created with `wx`, so of two processes starting at once only one gets it.
 */
export function takeLock(lockFile: string): void {
    if (existsSync(lockFile)) {
        const pid = Number(readFileSync(lockFile, "utf8").trim());

        if (lockHolder(pid)) {
            throw new Error(
                `Pi Pocket is already running on this data directory (pid ${pid}). If it is not, delete ${lockFile}.`,
            );
        }

        rmSync(lockFile, { force: true });
    }

    try {
        writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }

        throw new Error(
            "Pi Pocket is already running on this data directory: another one started at the same moment.",
        );
    }
}
