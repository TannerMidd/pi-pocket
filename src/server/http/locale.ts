/** One immutable UI-language snapshot per HTTP request, shared by sign-in pages and module handlers. */
import type { IncomingMessage } from "node:http";
import type { PocketApp } from "../app.ts";
import { localeCookie, requestLocale, type RequestLocale } from "../ui-locales.ts";

/** The same safe-mode choices as the browser: every other explicit value turns safe mode on. */
const SAFE_OFF: ReadonlySet<string> = new Set(["0", "false", "off", "no"]);

export function pageLocale(app: PocketApp, request: IncomingMessage, url: URL): RequestLocale {
    const safe = url.searchParams.has("noext")
        ? !SAFE_OFF.has((url.searchParams.get("noext") ?? "").trim().toLowerCase())
        : false;

    return requestLocale(app.webs.locales.snapshot(), localeCookie(request.headers.cookie), safe);
}
