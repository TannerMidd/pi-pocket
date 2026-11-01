/**
 * People's profile pictures, kept as files in the data folder (`avatars/<person id>`). The person's record holds only a
 * version (when the picture was set), which is in the picture's address so a browser never shows a stale one.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./errors.ts";
import { sniffImage } from "./http/assets.ts";

/** The most a stored picture can be. The web app shrinks pictures to a few KB before it sends them. */
export const MAX_AVATAR = 512 * 1024;

/** Types the picture may have: not SVG (script), not formats some browsers cannot draw. */
const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const folder = (dataDir: string) => join(dataDir, "avatars");
// Person ids are made by the server (`config.ts`); the check keeps a bad id from leaving the folder.
const fileOf = (dataDir: string, userId: string) =>
    join(folder(dataDir), userId.replace(/[^\w-]/g, "_"));

/** Keep a picture for a person; throws HttpError when it is not an image of an allowed type. */
export function saveAvatar(dataDir: string, userId: string, bytes: Buffer): void {
    if (bytes.length === 0) {
        throw new HttpError(400, "No picture was sent");
    }

    const type = sniffImage(bytes.subarray(0, 1024));

    if (type === undefined || !TYPES.has(type)) {
        throw new HttpError(415, "A picture is a PNG, JPEG, WebP, or GIF image");
    }

    mkdirSync(folder(dataDir), { recursive: true });
    writeFileSync(fileOf(dataDir, userId), bytes, { mode: 0o600 });
}

/** The picture and its type, or undefined when the person has none. */
export function readAvatar(
    dataDir: string,
    userId: string,
): { bytes: Buffer; type: string } | undefined {
    if (!existsSync(fileOf(dataDir, userId))) {
        return undefined;
    }

    const bytes = readFileSync(fileOf(dataDir, userId));
    const type = sniffImage(bytes.subarray(0, 1024));

    return type === undefined ? undefined : { bytes, type };
}

export function removeAvatar(dataDir: string, userId: string): void {
    rmSync(fileOf(dataDir, userId), { force: true });
}
