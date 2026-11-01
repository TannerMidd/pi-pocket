/**
 * HEIC and HEIF photos as JPEG, which models and browsers read. The decoder is WebAssembly and
 * takes a second or more, so it runs in a worker of its own (`heic-worker.ts`) with a time and a
 * memory limit: a huge or broken file stops there and the server goes on.
 */
import { Worker } from "node:worker_threads";

/** The types of such photos. */
export const HEIC_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence"]);

/** The longest a conversion runs, and the most memory (in MB) of the worker's own heap. */
const LIMIT = { ms: 30_000, heapMb: 512 };
/**
 * The most pixels a photo may have: decoded, 4 bytes each (64 million is 256 MB), so a tiny file
 * cannot ask for more.
 */
const MAX_PIXELS = 64_000_000;

/**
 * The bytes of every top-level `meta` box of a HEIF file, which hold its `ispe` boxes (and not the
 * image data).
 */
function metaOf(view: Buffer): Buffer {
    const found: Buffer[] = [];
    let at = 0;

    while (at + 16 <= view.length) {
        const size = view.readUInt32BE(at);
        const end =
            size === 0
                ? view.length
                : size === 1
                  ? at + Number(view.readBigUInt64BE(at + 8))
                  : at + size;

        if (view.toString("latin1", at + 4, at + 8) === "meta") {
            found.push(view.subarray(at, end));
        }

        if (end <= at) {
            break;
        }

        at = end;
    }

    return Buffer.concat(found);
}

/**
 * The most pixels any `ispe` (image spatial extent) box in the `meta` box names: a width and a
 * height, 32 bits each.
 */
function pixelsOf(bytes: Uint8Array): number {
    const view = metaOf(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    let most = 0;

    for (let at = view.indexOf("ispe"); at !== -1; at = view.indexOf("ispe", at + 4)) {
        if (at + 16 <= view.length) {
            most = Math.max(most, view.readUInt32BE(at + 8) * view.readUInt32BE(at + 12));
        }
    }

    return most;
}

/** The end of the last conversion that was asked for: the next one starts after it. */
let last: Promise<unknown> = Promise.resolve();

/**
 * A HEIC or HEIF file converted to JPEG. It fails for a broken file, a photo too big, or a
 * conversion too slow. One runs at a time: the memory of the decoder (WebAssembly, so outside the
 * heap limit) is about 1 GB for 64 million pixels.
 */
export function heicToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
    const pixels = pixelsOf(bytes);

    // A HEIF image always has an `ispe` box: with none that can be read, its size is not known.
    if (pixels === 0) {
        return Promise.reject(new Error("the photo's size cannot be read"));
    }

    if (pixels > MAX_PIXELS) {
        return Promise.reject(new Error("the photo has too many pixels"));
    }

    const done = last.then(
        () => convertInWorker(bytes),
        () => convertInWorker(bytes),
    );

    last = done;

    return done;
}

function convertInWorker(bytes: Uint8Array): Promise<Uint8Array> {
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
