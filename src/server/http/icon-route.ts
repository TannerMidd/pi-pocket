/** `/app-icon.png?frame=&card=&ring1=&ring2=&pi=&size=&maskable=1`: the app icon in those colors (hex, no `#`), as `icon-render.ts` draws it. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "../errors.ts";
import { storedIconColors } from "../icon-store.ts";
import { APP_ICON, type IconColors, MIN_ICON, renderIcon } from "../icon-render.ts";

/** The largest icon the route draws: no sign-in is needed, and the drawing runs on the main thread. */
const MAX_SIZE = 192;
const CACHE = 32;
/** New drawings a second, for the whole server: a client that changes a color in each request never finds one kept. */
const DRAWS_PER_SECOND = 8;
const drawn = new Map<string, Buffer>();
const budget = { second: 0, draws: 0 };

/**
 * `renderIcon` with the size capped, and the last icons drawn kept (the least recently used goes first). Null for colors
 * that are not hex; "busy" when this second's drawings are used up.
 */
function draw(colors: IconColors, size: number, maskable = false): Buffer | null | "busy" {
    const n = Math.min(MAX_SIZE, Math.max(MIN_ICON, Math.round(size)));
    const key = `${Object.values(colors).join(".").toLowerCase()}/${n}/${maskable}`;
    const kept = drawn.get(key);

    if (kept !== undefined) {
        drawn.delete(key);
        drawn.set(key, kept);

        return kept;
    }

    const second = Math.floor(Date.now() / 1000);

    if (budget.second !== second) {
        budget.second = second;
        budget.draws = 0;
    }

    if (budget.draws >= DRAWS_PER_SECOND) {
        return "busy";
    }

    const png = renderIcon(colors, n, maskable);

    if (png !== null) {
        budget.draws++;
        drawn.set(key, png);

        if (drawn.size > CACHE) {
            drawn.delete(drawn.keys().next().value!);
        }
    }

    return png;
}

export function iconRoute(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
        throw new HttpError(405, "Method not allowed");
    }

    const colors = { ...APP_ICON };

    for (const name of Object.keys(colors) as (keyof IconColors)[]) {
        const value = url.searchParams.get(name);

        if (value !== null) {
            colors[name] = `#${value}`;
        }
    }

    const size = Number(url.searchParams.get("size") ?? 180);

    if (!Number.isFinite(size)) {
        throw new HttpError(400, "The size is a number");
    }

    const png = draw(colors, size, url.searchParams.get("maskable") === "1");

    if (png === "busy") {
        response.writeHead(503, { "retry-after": "1", "cache-control": "no-store" });
        response.end();

        return;
    }

    if (png === null) {
        throw new HttpError(400, "Colors are 3 or 6 hex digits");
    }

    // The colors are in the address, so a copy never goes stale.
    response.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "cache-control": "public, max-age=31536000, immutable",
    });
    response.end(request.method === "HEAD" ? undefined : png);
}

const HEX = "(?:[0-9a-f]{3}|[0-9a-f]{6})";
const COOKIE = new RegExp(`(?:^|;\\s*)pocket_icon=(${HEX}(?:\\.${HEX}){4})(?:;|$)`, "i");

/** The colors in the request's `pocket_icon` cookie (`frame.card.ring1.ring2.pi`, which `web/app-icon.js` keeps), or null. */
function cookieColors(request: IncomingMessage, dataDir: string): string[] | null {
    return (
        COOKIE.exec(request.headers.cookie ?? "")?.[1]?.split(".") ??
        storedIconColors(dataDir) ??
        null
    );
}

/** The icon for a request with no cookie, as a phone's own fetch of the icon is: the owner's colors, else the file. */
export function appleTouchIcon(
    request: IncomingMessage,
    response: ServerResponse,
    dataDir: string,
): boolean {
    const colors = cookieColors(request, dataDir);

    if (colors === null) {
        return false;
    }

    const [frame, card, ring1, ring2, pi] = colors as [string, string, string, string, string];
    const png = draw(
        {
            frame: `#${frame}`,
            card: `#${card}`,
            ring1: `#${ring1}`,
            ring2: `#${ring2}`,
            pi: `#${pi}`,
        },
        180,
    );

    // Too many drawings this second: the app's own icon file goes instead.
    if (png === null || png === "busy") {
        return false;
    }

    response.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
    response.end(request.method === "HEAD" ? undefined : png);

    return true;
}

const address = (colors: string[], size: number, maskable = false) => {
    const [frame, card, ring1, ring2, pi] = colors as [string, string, string, string, string];
    const query = new URLSearchParams({ frame, card, ring1, ring2, pi, size: String(size) });

    if (maskable) {
        query.set("maskable", "1");
    }

    return `/app-icon.png?${query}`;
};

/**
 * The home-screen icon's address for the colors in the cookie, or the owner's, or null. iOS may read the icon from the page
 * as served, so the page carries it.
 */
export function iconAddress(request: IncomingMessage, dataDir: string): string | null {
    const colors = cookieColors(request, dataDir);

    return colors === null ? null : address(colors, 180);
}

/**
 * The web app manifest with the icons and colors of the cookie, or null without one (the file is served as it is).
 * iOS and Android read the manifest's icons too, and an icon there that is not the page's own wins over it.
 */
export function manifestFor(
    request: IncomingMessage,
    file: string,
    dataDir: string,
): string | null {
    const colors = cookieColors(request, dataDir);

    if (colors === null) {
        return null;
    }

    const manifest = JSON.parse(file) as Record<string, unknown>;
    const icon = (size: number, maskable: boolean) => ({
        src: address(colors, size, maskable),
        sizes: `${size}x${size}`,
        type: "image/png",
        ...(maskable ? { purpose: "maskable" } : {}),
    });

    return JSON.stringify({
        ...manifest,
        background_color: `#${colors[0]}`,
        theme_color: `#${colors[0]}`,
        icons: [icon(192, false), icon(192, true)],
    });
}
