/**
 * A theme folder's format: its id, `theme.json`, `colors.toml`, the files it may serve, and its limits. The theme gallery
 * reads entries by the same rules (`gallery/entry.ts`), so a theme it installs is one this reads.
 */
import { extname } from "node:path";
import { INVISIBLE_CLASS } from "../fence.ts";
import { parseColors } from "../omarchy.ts";
import { atLeast } from "../versions.ts";
import { THEME_API } from "../../../web/theme-surface.js";

/** The version of the theme surface (tokens, parts, states) this Pi Pocket offers, from `web/theme-surface.js`. */
export { THEME_API };

/** A theme's id: its folder's name. */
export const THEME_ID = /^[a-z0-9][a-z0-9-]{1,47}$/;

export const THEME_LIMITS = {
    /** `theme.json` and `colors.toml`, each, in bytes. */
    small: 8 * 1024,
    /** All of a theme's CSS, in bytes. */
    css: 256 * 1024,
    /** A font or an image, in bytes. */
    asset: 4 * 1024 * 1024,
    /** Everything it serves, in bytes. */
    total: 16 * 1024 * 1024,
    /** Files it serves. */
    files: 200,
    /** Folders deep, under its own. */
    depth: 4,
    /** Entries looked at in its folder, at most: past this, it is too big to read. */
    walk: 2000,
} as const;

/** The fonts and images a theme may load, by their ending. */
export const ASSET_TYPES: Record<string, string> = {
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
};

export const assetType = (file: string): string | undefined =>
    ASSET_TYPES[extname(file).toLowerCase()];

/** Why a theme cannot be used as it is. */
export class ThemeProblem extends Error {}

export interface Manifest {
    themeApi: number;
    name: string;
    description?: string;
    author?: string;
    version?: string;
    minPocket?: string;
}

const UNSAFE = new RegExp(`[\\p{Zl}\\p{Zp}${INVISIBLE_CLASS}]`, "u");
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

/** One line of plain text, at most `max` characters. */
export function plainLine(value: unknown, where: string, max: number): string {
    if (typeof value !== "string" || value.trim() === "" || value.length > max) {
        throw new ThemeProblem(`${where} is not text of 1 to ${max} characters`);
    }

    if (UNSAFE.test(value)) {
        throw new ThemeProblem(`${where} has control or invisible characters in it`);
    }

    return value.trim();
}

/** `theme.json`, read strictly. Fields it does not know are left out, so a newer theme still reads here. */
export function parseManifest(text: string, pocketVersion: string): Manifest {
    let value: unknown;

    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new ThemeProblem(`theme.json is not JSON: ${(error as Error).message}`);
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ThemeProblem("theme.json is not an object");
    }

    const fields = value as Record<string, unknown>;
    const api = fields.themeApi;

    if (typeof api !== "number" || !Number.isInteger(api) || api < 1) {
        throw new ThemeProblem("theme.json has no themeApi (1)");
    }

    if (api > THEME_API) {
        throw new ThemeProblem(`it needs theme API ${api}: this Pi Pocket has ${THEME_API}`);
    }

    const manifest: Manifest = { themeApi: api, name: plainLine(fields.name, "Its name", 60) };

    if (fields.description !== undefined) {
        manifest.description = plainLine(fields.description, "Its description", 200);
    }

    if (fields.author !== undefined) {
        manifest.author = plainLine(fields.author, "Its author", 60);
    }

    for (const key of ["version", "minPocket"] as const) {
        if (fields[key] !== undefined) {
            if (typeof fields[key] !== "string" || !VERSION.test(fields[key])) {
                throw new ThemeProblem(`theme.json's ${key} is not a version`);
            }

            manifest[key] = fields[key];
        }
    }

    if (manifest.minPocket !== undefined && !atLeast(pocketVersion, manifest.minPocket)) {
        throw new ThemeProblem(`it needs Pi Pocket ${manifest.minPocket} or newer`);
    }

    return manifest;
}

/** A palette from `colors.toml`, Omarchy's format: it needs a background and a foreground. */
export function parseThemeColors(text: string): Record<string, string> {
    const colors = parseColors(text);

    if (colors.background === undefined || colors.foreground === undefined) {
        throw new ThemeProblem("colors.toml has no background or no foreground");
    }

    return colors;
}

/** A palette as `colors.toml`, its mode first, as Omarchy writes one. */
export function colorsToml(colors: Record<string, string>): string {
    const keys = Object.keys(colors).sort((a, b) => (a === "mode" ? -1 : b === "mode" ? 1 : 0));

    return `${keys.map((key) => `${key} = "${colors[key]}"`).join("\n")}\n`;
}

/** An id for a new theme called `name`: its letters and digits, joined by `-`, and not one of `taken`. */
export function newThemeId(name: string, taken: (id: string) => boolean): string {
    const base =
        name
            .normalize("NFKD")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40)
            .replace(/-+$/, "") || "theme";
    const padded = base.length < 2 ? `${base}-theme` : base;

    for (let n = 1; ; n++) {
        const id = n === 1 ? padded : `${padded}-${n}`;

        if (!taken(id)) {
            return id;
        }
    }
}
