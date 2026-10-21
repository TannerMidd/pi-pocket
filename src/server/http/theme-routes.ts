/**
 * `/themes/:id/:rev/…`: a theme's files, for everyone signed in (`themes.ts`). Its CSS as it was checked, from memory;
 * its fonts and images from disk, opened as they were checked. Any version in the address serves the files as they are
 * now: the version is there so a changed theme gets a new address.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import { THEME_LIMITS } from "../themes/format.ts";
import { sniffImage } from "./assets.ts";
import { readChecked, send, SVG_CSP } from "./io.ts";

export function themeFile(
    app: PocketApp,
    request: IncomingMessage,
    response: ServerResponse,
    parts: string[],
    user: User | undefined,
): void {
    if (user === undefined) {
        throw new HttpError(401, "Sign in first");
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");

        throw new HttpError(405, "Files are only read");
    }

    const [id, rev, ...path] = parts;
    const served = id === undefined ? undefined : app.themes.file(id, rev, path);

    if (served === undefined) {
        // A theme a browser kept, that is not here now (removed, or broken since a restart): its stylesheet is empty, so
        // the page loads the app's own look with no error in its console.
        if (path.at(-1)?.toLowerCase().endsWith(".css")) {
            send(response, 200, "", "text/css; charset=utf-8", {
                "cache-control": "private, no-cache",
                "x-content-type-options": "nosniff",
            });

            return;
        }

        throw new HttpError(404, "Not found");
    }

    const found = served.file;
    const headers = {
        // Only as the type it says: a stylesheet or a font is never read as anything else.
        "x-content-type-options": "nosniff",
        // The version in the address is the files' hash: under the current one, nothing else will ever be served, so the
        // browser keeps it. An older address serves what is there now, and asks each time.
        "cache-control": served.current
            ? "private, max-age=31536000, immutable"
            : "private, no-cache",
        // Another site's page may not use it: the sign-in cookie would go along with the request.
        "cross-origin-resource-policy": "same-origin",
    };

    if ("css" in found) {
        send(response, 200, found.css, "text/css; charset=utf-8", headers);

        return;
    }

    const body = readChecked(found, THEME_LIMITS.asset);

    // What it holds must be what its name says: a font, or an image of that kind.
    const sniffed =
        found.type === "font/woff2"
            ? body.subarray(0, 4).toString("latin1") === "wOF2"
                ? "font/woff2"
                : undefined
            : sniffImage(body.subarray(0, 1024));

    if (sniffed !== found.type) {
        throw new HttpError(415, "That file is not what its name says");
    }

    send(response, 200, body, found.type, {
        ...headers,
        ...(found.type === "image/svg+xml" ? { "content-security-policy": SVG_CSP } : {}),
    });
}
