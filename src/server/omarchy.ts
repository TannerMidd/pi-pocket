/**
 * The Omarchy desktop's current theme, for the web app's "Follow desktop" appearance. Omarchy keeps the theme in use
 * under `~/.local/state/omarchy/current` (older installs: `~/.config/omarchy/current`): its name, a `colors.toml` of
 * flat `key = "value"` lines, and a `background` link to the wallpaper. Nothing here writes; on a machine without
 * Omarchy every answer is empty.
 */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type DesktopTheme = {
    name: string;
    /** Colors by their colors.toml key, such as `accent`, `background`, or `hyprland_active_border`. */
    colors: Record<string, string>;
    /** Whether the desktop has a wallpaper the app can show. */
    wallpaper: boolean;
    /** Changes when any of the files above change: the app compares it to skip work. A hash: it says nothing about paths. */
    stamp: string;
};

/** Where Omarchy keeps its current theme, newest layout first. */
export function currentDirs(home = homedir()): string[] {
    return [join(home, ".local/state/omarchy/current"), join(home, ".config/omarchy/current")];
}

/** A color as colors.toml writes one: `#rrggbb`, `rgb(…)` or `rgba(…)`, a Hyprland gradient of those with an angle, or a mode. */
const COLOR =
    /^(?:dark|light|(?:#[0-9a-f]{3,8}|rgba?\([0-9a-f\s,.%]+\)|-?\d{1,3}deg)(?:\s+(?:#[0-9a-f]{3,8}|rgba?\([0-9a-f\s,.%]+\)|-?\d{1,3}deg)){0,7})$/i;
const KEY = /^[a-z][a-z0-9_]{0,40}$/;

/** The `key = "value"` lines of a colors.toml. Tables, comments, and anything that is not a color are skipped. */
export function parseColors(toml: string): Record<string, string> {
    const colors: Record<string, string> = {};

    for (const raw of toml.split(/\r?\n/)) {
        const line = raw.trim();

        if (line === "" || line.startsWith("#") || line.startsWith("[")) {
            continue;
        }

        const match = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);

        if (!match) {
            continue;
        }

        const key = match[1]!.toLowerCase().replace(/-/g, "_");
        const value = match[2]!.trim();

        if (KEY.test(key) && COLOR.test(value)) {
            colors[key] = value;
        }
    }

    return colors;
}

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;

/** The wallpaper file the desktop shows, if it is an image. */
export async function wallpaperFile(home = homedir()): Promise<string | undefined> {
    for (const dir of currentDirs(home)) {
        try {
            const file = await realpath(join(dir, "background"));

            if (IMAGE.test(file) && (await stat(file)).isFile()) {
                return file;
            }
        } catch {
            // not here
        }
    }

    return undefined;
}

/** The desktop's theme, or null when this machine has no Omarchy theme. */
export async function desktopTheme(home = homedir()): Promise<DesktopTheme | null> {
    for (const dir of currentDirs(home)) {
        let toml: string;
        let stamp: string;

        try {
            const file = join(dir, "theme", "colors.toml");

            toml = await readFile(file, "utf8");
            stamp = String((await stat(file)).mtimeMs);
        } catch {
            continue;
        }

        const colors = parseColors(toml);

        if (colors.background === undefined || colors.foreground === undefined) {
            continue;
        }

        const name =
            (await readFile(join(dir, "theme.name"), "utf8").catch(() => "omarchy"))
                .trim()
                .slice(0, 60) || "omarchy";
        const wallpaper = await wallpaperFile(home);
        const hash = createHash("sha256")
            .update(`${name}\0${stamp}\0${wallpaper ?? ""}`)
            .digest("base64url")
            .slice(0, 16);

        return { name, colors, wallpaper: wallpaper !== undefined, stamp: hash };
    }

    return null;
}
