/**
 * This server's build: a short hash of its own code and its package (with the versions of what it depends on, as locked). Tabs keep
 * sessions as a server sends them, and a session's entries are as this code projects them (`projection.ts`): a tab's
 * cached session is good for any server with the same build, so it lasts across a restart, but not across new code.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./config.ts";

/** The files the build covers, in a fixed order: the package and its lock, and the server's code. */
function buildFiles(): string[] {
    const files = [join(APP_ROOT, "package.json"), join(APP_ROOT, "package-lock.json")];

    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        )) {
            const path = join(dir, entry.name);

            if (entry.isDirectory()) {
                walk(path);
            } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
                files.push(path);
            }
        }
    };

    walk(join(APP_ROOT, "src", "server"));
    files.push(join(APP_ROOT, "web", "fingerprint.js"));

    return files;
}

/** The build of the code in `APP_ROOT` as it is now: 16 hex digits. */
export function serverBuild(): string {
    const hash = createHash("sha256");

    for (const file of buildFiles()) {
        hash.update(file.slice(APP_ROOT.length));
        hash.update("\0");

        try {
            hash.update(readFileSync(file));
        } catch {
            // Gone as it was listed: counts as empty.
        }

        hash.update("\0");
    }

    return hash.digest("hex").slice(0, 16);
}
