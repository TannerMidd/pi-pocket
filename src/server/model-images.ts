/**
 * Attached images, made small enough for the model. Making one takes a second or more (`resizeImage`), so it starts as
 * the upload ends (`prepareModelImage`), while the person still writes: the message that sends it finds it ready
 * (`modelImage`). A file not prepared (after a restart, or one that left the cache) is made then.
 */
import { readFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage } from "@earendil-works/pi-coding-agent";

/** Attached images that also go to the model itself, when it takes images. */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

/** How many prepared images are kept: each holds up to about 4.5 MB of base64, mostly well under 1 MB. */
const KEPT = 24;
const prepared = new Map<string, Promise<ImageContent>>();

/** Whether an attached file goes to the model as an image. */
export function forModel(mime: string, size: number): boolean {
    return IMAGE_TYPES.has(mime) && size <= MAX_INLINE_IMAGE;
}

/**
 * An image file for the model, at most 2000 pixels a side as Pi's read tool sends images: models refuse bigger ones once
 * a conversation holds many, and then every request fails until they leave its context.
 */
async function make(path: string, mimeType: string): Promise<ImageContent> {
    const image = await resizeImage(await readFile(path), mimeType);

    if (image === null) {
        throw new Error("it could not be made small enough for the model");
    }

    return { type: "image", mimeType: image.mimeType, data: image.data };
}

/** Start making an uploaded image ready for the model, if it is one: its failure shows when a message sends it. */
export function prepareModelImage(path: string, mimeType: string, size: number): void {
    if (!forModel(mimeType, size) || prepared.has(path)) {
        return;
    }

    const made = make(path, mimeType);

    made.catch(() => undefined);
    prepared.set(path, made);

    while (prepared.size > KEPT) {
        prepared.delete(prepared.keys().next().value!);
    }
}

/** An attached image as the model gets it: the one prepared at upload, or made now. */
export function modelImage(path: string, mimeType: string): Promise<ImageContent> {
    const made = prepared.get(path);

    if (made === undefined) {
        return make(path, mimeType);
    }

    // Kept for a retried send; a failed one is made again next time.
    made.catch(() => prepared.delete(path));

    return made;
}
