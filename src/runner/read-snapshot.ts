/** A bounded, per-call snapshot for Pi's read tool. Both sides fall back to pi-env if there is no snapshot. */
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename } from "node:path";

export const READ_SNAPSHOT = "pocket-read-snapshot";
export const MAX_SNAPSHOT_BYTES = 8 * 1024;

/** Like the path probe of `read`: do not open a symlink, non-file or large file on the fast path. */
export async function snapshotCandidate(path: string): Promise<BigIntStats | undefined> {
    const info = await lstat(path, { bigint: true }).catch(() => undefined);

    return info?.isFile() && info.size <= BigInt(MAX_SNAPSHOT_BYTES) ? info : undefined;
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
    return (
        after.isFile() &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs
    );
}

/** Called only for the path that passed the gate. Never return bytes from an unstable file. */
export async function captureSnapshot(path: string, before: BigIntStats, signal: AbortSignal) {
    try {
        signal.throwIfAborted();
        const file = await open(
            path,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );

        try {
            signal.throwIfAborted();

            if (!sameFile(before, await file.stat({ bigint: true }))) {
                return;
            }

            // One byte past the reported size distinguishes EOF from growth or a virtual file with a fake size.
            const bytes = Buffer.allocUnsafe(Number(before.size) + 1);
            let length = 0;

            while (length < bytes.length) {
                signal.throwIfAborted();
                const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);

                if (bytesRead === 0) {
                    break;
                }

                length += bytesRead;
            }

            if (
                length !== Number(before.size) ||
                !sameFile(before, await file.stat({ bigint: true })) ||
                (await realpath(path)) !== path ||
                !sameFile(before, await lstat(path, { bigint: true }))
            ) {
                return;
            }

            signal.throwIfAborted();

            return {
                name: basename(path),
                mtimeMs: Number(before.mtimeNs) / 1e6,
                bytes: bytes.subarray(0, length),
            };
        } finally {
            await file.close();
        }
    } catch {
        // The usual tool path handles errors, cancellation and any retry. A failed probe is not file data.
        return undefined;
    }
}
