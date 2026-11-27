/** A fork can read the bytes of an attachment, not the current occupant of its name. */
import { createHash } from "node:crypto";
import { HttpError } from "./errors.ts";
import { openNoFollow, own, type Place } from "./hostfs.ts";

export const MAX_UPLOAD = 50 * 1024 * 1024;
export type UploadContent = { size: number; sha256: string };
export type BoundUpload = { path: string; content: UploadContent };
/** A file the viewer or a route may read: a place in a folder (confined where a sandboxed tree works), or a bound upload. */
export type ReadableFile = Place | BoundUpload;

export function uploadContent(value: unknown): UploadContent | undefined {
    const c = value as Partial<UploadContent> | undefined;

    return c &&
        typeof c.size === "number" &&
        Number.isSafeInteger(c.size) &&
        c.size >= 0 &&
        c.size <= MAX_UPLOAD &&
        typeof c.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(c.sha256)
        ? { size: c.size, sha256: c.sha256 }
        : undefined;
}

export function sameContent(a: UploadContent | undefined, b: UploadContent | undefined): boolean {
    return a !== undefined && b !== undefined && a.size === b.size && a.sha256 === b.sha256;
}

const CHUNK = 64 * 1024;
let retained = 0;

/** Only the buffer we hash can be returned to a reader. Metadata checks alone use one scratch chunk. */
async function readMatching(file: BoundUpload, keep: boolean): Promise<Buffer | undefined> {
    const expected = uploadContent(file.content);

    if (!expected) {
        return undefined;
    }

    const handle = await openNoFollow(own(file.path));

    try {
        const info = await handle.stat();

        if (!info.isFile() || info.size !== expected.size) {
            return undefined;
        }

        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(keep ? info.size : Math.min(CHUNK, info.size));
        let position = 0;

        while (position < info.size) {
            const offset = keep ? position : 0;
            const length = Math.min(CHUNK, info.size - position);
            const { bytesRead } = await handle.read(buffer, offset, length, position);

            if (bytesRead === 0) {
                return undefined;
            }

            hash.update(buffer.subarray(offset, offset + bytesRead));
            position += bytesRead;
        }

        return hash.digest("hex") === expected.sha256 && (await handle.stat()).size === info.size
            ? buffer
            : undefined;
    } finally {
        await handle.close();
    }
}

export async function matchesUpload(file: BoundUpload): Promise<boolean> {
    return (await readMatching(file, false).catch(() => undefined)) !== undefined;
}

/** Keep at most two maximum-size inherited files in flight. The consumer must finish using the bytes before it returns. */
export async function withUploadBytes<T>(
    file: BoundUpload,
    use: (bytes: Buffer) => Promise<T>,
): Promise<T> {
    const content = uploadContent(file.content);

    if (!content) {
        throw new HttpError(404, "File not found");
    }

    if (retained + content.size > 2 * MAX_UPLOAD) {
        throw new HttpError(503, "Other attachment reads are in progress. Try again.");
    }

    retained += content.size;

    try {
        const bytes = await readMatching(file, true).catch(() => undefined);

        if (bytes === undefined) {
            throw new HttpError(404, "File not found");
        }

        return await use(bytes);
    } finally {
        retained -= content.size;
    }
}
