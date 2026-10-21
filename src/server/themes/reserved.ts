/**
 * The theme ids Pi Pocket keeps for itself: its built-in themes' (the folders in `web/themes/`), its palettes'
 * (`web/themes.js`), `pocket`, and `desktop`. The owner's theme folders and the gallery's themes cannot take them. Read
 * from those files each time, so a theme or palette added to the app is reserved with no list to keep.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ROOT } from "../config.ts";

export async function reservedThemeIds(appRoot = APP_ROOT): Promise<Set<string>> {
    const ids = new Set(["pocket", "desktop"]);

    try {
        for (const entry of readdirSync(join(appRoot, "web", "themes"), { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.name.startsWith(".")) {
                ids.add(entry.name);
            }
        }
    } catch {
        // No built-in themes here.
    }

    try {
        const { THEMES } = (await import(
            pathToFileURL(join(appRoot, "web", "themes.js")).href
        )) as {
            THEMES: Record<string, unknown>;
        };

        for (const id of Object.keys(THEMES)) {
            ids.add(id);
        }
    } catch {
        // No palettes here.
    }

    return ids;
}
