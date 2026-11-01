/**
 * Attached images, made small enough for the model. Making one takes a second or more (`resizeImage`), so it starts as
 * the upload ends (`prepareModelImage`), while the person still writes: the message that sends it finds it ready
 * (`modelImage`). A file not prepared (after a restart, or one that left the cache) is made then.
 */
import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { HEIC_TYPES, heicToJpeg } from "./heic.ts";

/** Attached images that also go to the model itself, when it takes images. */
export const IMAGE_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    ...HEIC_TYPES,
]);
export const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

/** How many prepared images are kept: each holds up to about 4.5 MB of base64, mostly well under 1 MB. */
const KEPT = 24;
/**
 * How many images are made at once. Decoding one takes hundreds of MB for a moment: 20 large uploads at once took the
 * server to 4.8 GB, and to 0.9 GB two at a time.
 */
const AT_ONCE = 2;
/** Uploads made ready ahead of a send wait at most this many deep; one past it is made when its message goes. */
const AHEAD = 24;

/** An image for the model, and the note for its attachment line when the model gets something other than the file. */
export type ModelImage = { image: ImageContent; note?: string };

/** A prepared image, with the file's stamp before it was read: a file changed since is read again. */
const prepared = new Map<string, { stamp: string; made: Promise<ModelImage> }>();
let running = 0;
const queue: (() => void)[] = [];

/** Run `job` when one of the `AT_ONCE` places is free; a message that waits for it goes ahead of uploads. */
function inTurn<T>(job: () => Promise<T>, first: boolean): Promise<T> {
    return new Promise((resolve, reject) => {
        const run = () => {
            running += 1;
            job()
                .then(resolve, reject)
                .finally(() => {
                    running -= 1;
                    queue.shift()?.();
                });
        };

        if (running < AT_ONCE) {
            run();
        } else if (first) {
            queue.unshift(run);
        } else {
            queue.push(run);
        }
    });
}

/** How many images are being made, and how many wait their turn. */
export function imageWork(): { running: number; waiting: number } {
    return { running, waiting: queue.length };
}

/** Whether an attached file goes to the model as an image. */
export function forModel(mime: string, size: number): boolean {
    return IMAGE_TYPES.has(mime) && size <= MAX_INLINE_IMAGE;
}

const stampOf = (info: { mtimeMs: number; size: number }) => `${info.mtimeMs}:${info.size}`;

/**
 * An image file for the model, at most 2000 pixels a side as Pi's read tool sends images: models refuse bigger ones once
 * a conversation holds many, and then every request fails until they leave its context. A HEIC or HEIF photo is made
 * JPEG first. The note says what differs from the file, in the words of Pi's read tool: the format, then the size.
 */
function make(path: string, mimeType: string, first: boolean): Promise<ModelImage> {
    return inTurn(async () => {
        let bytes: Uint8Array = await readFile(path);
        let type = mimeType;

        if (HEIC_TYPES.has(mimeType)) {
            bytes = await heicToJpeg(bytes);
            type = "image/jpeg";
        }

        const image = await resizeImage(bytes, type);

        if (image === null) {
            throw new Error("it could not be made small enough for the model");
        }

        const notes: string[] = [];

        if (image.mimeType !== mimeType) {
            notes.push(`[Image: shown to you as ${image.mimeType.split("/")[1]!.toUpperCase()}.]`);
        }

        const size = formatDimensionNote(image);

        if (size !== undefined) {
            notes.push(size);
        }

        return {
            image: { type: "image", mimeType: image.mimeType, data: image.data },
            note: notes.length === 0 ? undefined : notes.join(" "),
        };
    }, first);
}

/** Start making an uploaded image ready for the model, if it is one: its failure shows when a message sends it. */
export function prepareModelImage(path: string, mimeType: string, size: number): void {
    if (!forModel(mimeType, size) || prepared.has(path) || queue.length >= AHEAD) {
        return;
    }

    let stamp: string;

    try {
        stamp = stampOf(statSync(path));
    } catch {
        return;
    }

    const made = make(path, mimeType, false);

    made.catch(() => undefined);
    prepared.set(path, { stamp, made });

    while (prepared.size > KEPT) {
        prepared.delete(prepared.keys().next().value!);
    }
}

/** An attached image as the model gets it: the one prepared at upload while its file is unchanged, or made now. */
export async function modelImage(path: string, mimeType: string): Promise<ModelImage> {
    const entry = prepared.get(path);

    if (entry !== undefined) {
        try {
            const made = await entry.made;

            if (stampOf(await stat(path)) === entry.stamp) {
                return made;
            }
        } catch {
            // A failed one is made again, below.
        }

        prepared.delete(path);
    }

    return make(path, mimeType, true);
}
