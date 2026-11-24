/**
 * Attached images, made small enough for the model. Making one takes a second or more (`resizeImage`), so it starts as
 * the upload ends (`prepareModelImage`), while the person still writes: the message that sends it finds it ready
 * (`issuedModelImage`). A file not prepared (after a restart, or one that left the cache) is made then.
 */
import { readFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { HEIC_TYPES, heicToJpeg } from "./heic.ts";
import { type BoundUpload, withUploadBytes } from "./upload-content.ts";

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

/**
 * An image for the model, and the note for its attachment line when the model gets something other
 * than the file.
 */
export type ModelImage = { image: ImageContent; note?: string };

type IssuedImage = BoundUpload & { mime: string };
const cacheKey = ({ path, mime, content }: IssuedImage) =>
    JSON.stringify([path, mime, content.size, content.sha256]);
const prepared = new Map<string, Promise<ModelImage>>();
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

/**
 * An image file for the model, at most 2000 pixels a side as Pi's read tool sends images: models refuse bigger ones once
 * a conversation holds many, and then every request fails until they leave its context. A HEIC or
 * HEIF photo is made JPEG first. The note says what differs from the file: the format, then the
 * size in the words of Pi's read tool.
 */
async function convert(bytes: Uint8Array, mimeType: string): Promise<ModelImage> {
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
}

function makeIssued(file: IssuedImage, first: boolean) {
    return inTurn(() => withUploadBytes(file, (bytes) => convert(bytes, file.mime)), first);
}

/** Start making an uploaded image ready for the model, if it is one. */
export function prepareModelImage(file: IssuedImage): void {
    const key = cacheKey(file);

    if (!forModel(file.mime, file.content.size) || prepared.has(key) || queue.length >= AHEAD) {
        return;
    }

    const made = makeIssued(file, false);

    made.catch(() => {
        if (prepared.get(key) === made) {
            prepared.delete(key);
        }
    });
    prepared.set(key, made);

    while (prepared.size > KEPT) {
        prepared.delete(prepared.keys().next().value!);
    }
}

/** Reuse only a conversion of the bytes and MIME from the validated upload receipt. */
export async function issuedModelImage(file: IssuedImage): Promise<ModelImage> {
    if (!forModel(file.mime, file.content.size)) {
        throw new Error("Not an inline image");
    }

    const made = prepared.get(cacheKey(file));

    if (made !== undefined) {
        try {
            return await made;
        } catch {
            // Retry a failed background conversion at send time.
        }
    }

    return makeIssued(file, true);
}

/** Convert a workspace image or a buffer already verified by the caller. */
export function modelImage(source: string | Buffer, mimeType: string): Promise<ModelImage> {
    return inTurn(
        async () => convert(typeof source === "string" ? await readFile(source) : source, mimeType),
        true,
    );
}
