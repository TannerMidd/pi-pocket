/**
 * The owner's app icon colors (`frame.card.ring1.ring2.pi`, hex), kept in the data folder. A phone fetches the page and
 * the icon from a session of its own that has no cookies, so the cookie of the browser (`http/icon-route.ts`) is not
 * enough there: this is what such a request gets. It is one choice for the whole server: the last device of the owner
 * that changes the look sets it, and a browser with no cookie (a guest's too) gets it. A browser with a cookie gets its own colors.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEX = "(?:[0-9a-f]{3}|[0-9a-f]{6})";

/** `frame.card.ring1.ring2.pi`, five hex colors, else false. */
export const isIconColors = (value: unknown): value is string =>
    typeof value === "string" && new RegExp(`^${HEX}(?:\\.${HEX}){4}$`, "i").test(value);

const file = (dataDir: string) => join(dataDir, "app-icon.json");

/** The colors as read from `file()` once; the page, the manifest, and the icon ask for them on every request. */
let kept: { path: string; colors: string[] | null } | undefined;

export function storedIconColors(dataDir: string): string[] | null {
    const path = file(dataDir);

    if (kept?.path === path) {
        return kept.colors;
    }

    let colors: string[] | null = null;

    if (existsSync(path)) {
        try {
            const stored = (JSON.parse(readFileSync(path, "utf8")) as { colors?: unknown }).colors;

            colors = isIconColors(stored) ? stored.split(".") : null;
        } catch (error) {
            console.warn(
                "Pi Pocket: app-icon.json could not be read; the app's own icon is used.",
                error,
            );
        }
    }

    kept = { path, colors };

    return colors;
}

export function storeIconColors(dataDir: string, colors: unknown): void {
    if (!isIconColors(colors)) {
        throw new TypeError("Colors are five hex colors joined by dots");
    }

    if (storedIconColors(dataDir)?.join(".") !== colors) {
        writeFileSync(file(dataDir), `${JSON.stringify({ colors })}\n`);
        kept = { path: file(dataDir), colors: colors.split(".") };
    }
}
