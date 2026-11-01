/**
 * HEIC and HEIF photos as JPEG, which models and browsers read. The decoder is WebAssembly and takes a second or
 * more, so it runs in a worker of its own (`heic-worker.ts`) with a time and a memory limit: a huge or broken file
 * stops there and the server goes on.
 */
import { Worker } from "node:worker_threads";

/** The types of such photos. */
export const HEIC_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence"]);

/** The longest a conversion runs, and the most memory (in MB) of the worker's own heap. */
const LIMIT = { ms: 30_000, heapMb: 512 };
/** The most pixels a photo may have: decoded, 4 bytes each (64 million is 256 MB), so a tiny file cannot ask for more. */
const MAX_PIXELS = 64_000_000;

/** The most pixels any `ispe` (image spatial extent) box of a HEIF file names: a width and a height, 32 bits each. */
function pixelsOf(bytes: Uint8Array): number {
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    let most = 0;

    for (let at = view.indexOf("ispe"); at !== -1; at = view.indexOf("ispe", at + 4)) {
        if (at + 16 <= view.length) {
            most = Math.max(most, view.readUInt32BE(at + 8) * view.readUInt32BE(at + 12));
        }
    }

    return most;
}

/** A HEIC or HEIF file converted to JPEG. It fails for a broken file, a photo too big, or a conversion too slow. */
export function heicToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
    if (pixelsOf(bytes) > MAX_PIXELS) {
        return Promise.reject(new Error("the photo has too many pixels"));
    }

    const stopped = new Error("the photo took too much time or memory to convert");

    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./heic-worker.ts", import.meta.url), {
            workerData: { bytes },
            resourceLimits: { maxOldGenerationSizeMb: LIMIT.heapMb },
        });
        const timer = setTimeout(() => {
            reject(stopped);
            void worker.terminate();
        }, LIMIT.ms);

        worker.once("message", (reply: { jpeg?: Uint8Array; error?: string }) => {
            if (reply.jpeg === undefined) {
                reject(new Error(reply.error ?? "it is not a photo that can be converted"));
            } else {
                resolve(reply.jpeg);
            }
        });
        worker.once("error", (error: Error & { code?: string }) =>
            reject(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? stopped : error),
        );
        // The first of these settles the promise: a worker that ends with no answer was stopped.
        worker.once("exit", () => {
            clearTimeout(timer);
            reject(stopped);
        });
    });
}
