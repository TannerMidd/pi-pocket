/**
 * The HTTP server's one request handler: the API (`http/api.ts`), artifacts, the sign-in pages, extensions' browser
 * modules and public pages, and the web app's own files. Each part lives in `http/`; this file routes a request to it and turns what it
 * throws into an answer.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, normalize, sep } from "node:path";
import type { PocketApp } from "./app.ts";
import { Auth } from "./auth.ts";
import { describe, HttpError } from "./errors.ts";
import { createApi } from "./http/api.ts";
import { artifact } from "./http/artifacts.ts";
import { publicArtifactBundle } from "./http/artifact-assets.ts";
import { extensionFile } from "./http/extension-routes.ts";
import { hookRoute } from "./http/hook-routes.ts";
import { linkRoute } from "./http/link-routes.ts";
import { serveApp, serveFile, VENDOR, WEB } from "./http/assets.ts";
import { type HttpOptions, json } from "./http/io.ts";
import { join as joinPage, login, sharePage } from "./http/sign-in.ts";
import { themeFile } from "./http/theme-routes.ts";
import { localeCookie, requestLocale, type RequestLocale } from "./ui-locales.ts";

/** Which `?noext=` values turn safe mode off, as `web/safe-mode.js` has them: any other value turns it on. */
const SAFE_OFF: ReadonlySet<string> = new Set(["0", "false", "off", "no"]);

/**
 * The language of a page outside the app: one catalog snapshot and one language, fixed for this request, even while the
 * page waits for a session's title. A page opened with `?noext=1` shows English and keeps the person's choice.
 */
function pageLocale(app: PocketApp, request: IncomingMessage, url: URL): RequestLocale {
    const safe = url.searchParams.has("noext")
        ? !SAFE_OFF.has((url.searchParams.get("noext") ?? "").trim().toLowerCase())
        : false;

    return requestLocale(app.webs.locales.snapshot(), localeCookie(request.headers.cookie), safe);
}

/**
 * The app's own UI text in other languages (`ui-locales.ts`): the catalog that its tabs and sign-in pages read. It is
 * public, as those pages are, so it answers before any sign-in, and no cache keeps it.
 */
function uiLocales(app: PocketApp, request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
        throw new HttpError(405, "Only GET answers the UI catalog");
    }

    const snapshot = app.webs.locales.snapshot();

    response.setHeader("cache-control", "no-store");
    json(response, 200, { revision: snapshot.revision, locales: snapshot.locales });
}

export function createHandler(options: HttpOptions) {
    const { app } = options;
    const auth = new Auth(app.config);
    const api = createApi(options, auth);

    return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const url = new URL(request.url ?? "/", "http://pocket.local");

        try {
            let path: string;

            try {
                path = decodeURIComponent(url.pathname);
            } catch {
                throw new HttpError(400, "Bad path");
            }

            const parts = path.split("/").filter((part) => part !== "");

            response.setHeader("x-content-type-options", "nosniff");

            // The UI catalog, before the API's checks: the sign-in pages and every tab read it, signed in or not.
            // Exactly `/ui-locales.json`, and only a GET.
            if (parts.length === 1 && parts[0] === "ui-locales.json") {
                return uiLocales(app, request, response);
            }

            if (parts[0] === "api") {
                return await api(request, response, url, parts.slice(1));
            }

            // Webhooks: posts from other services, let in by the hook's secret, not by a sign-in.
            if (parts[0] === "hook" && parts[1] !== undefined) {
                return await hookRoute(app, request, response, parts[1], parts[2]);
            }

            // An artifact published to anyone with its address: the token is the whole of the access, no sign-in.
            // `/pub/<token>` is the page, and `/pub/<token>/<name>` one of its bundle's files (`http/artifact-assets.ts`).
            if (parts[0] === "pub") {
                const token = parts.length >= 2 ? parts[1] : undefined;
                const name = parts.slice(2).join("/");

                return await publicArtifactBundle(
                    app,
                    request,
                    response,
                    token,
                    name,
                    url.searchParams,
                );
            }

            // A page an extension module shows to anyone with its link: the token is the whole of the access, no sign-in.
            // Exactly `/l/<token>`.
            if (parts[0] === "l") {
                const token = parts.length === 2 ? parts[1] : undefined;

                return await linkRoute(app, request, response, token, url);
            }

            if (parts[0] === "a") {
                return await artifact(
                    app,
                    response,
                    parts.slice(1),
                    auth.user(request),
                    url.searchParams,
                );
            }

            // An extension module's browser module, for the people it is for (`extension-web.ts`).
            if (parts[0] === "x" && parts[1] !== undefined) {
                return extensionFile(app, request, response, parts.slice(1), auth.user(request));
            }

            // A theme's files, for everyone signed in (`themes.ts`): not the folders under web/themes/ as they are.
            if (parts[0] === "themes") {
                return themeFile(app, request, response, parts.slice(1), auth.user(request));
            }

            if (parts[0] === "vendor" && parts[1] !== undefined && VENDOR[parts[1]] !== undefined) {
                return await serveFile(
                    request,
                    response,
                    VENDOR[parts[1]]!,
                    "text/javascript; charset=utf-8",
                );
            }

            if (parts[0] === "login" && (request.method === "GET" || request.method === "POST")) {
                return await login(auth, request, response, url, pageLocale(app, request, url));
            }

            if (parts[0] === "join" && parts[1] !== undefined) {
                return await joinPage(
                    app,
                    auth,
                    request,
                    response,
                    parts[1],
                    pageLocale(app, request, url),
                );
            }

            // Shares from other apps go to the service worker (web/sw.js). One that reaches the server came before the
            // worker was installed on this device; nothing here knows where it should go.
            if (parts[0] === "share" && request.method === "POST") {
                return sharePage(response, pageLocale(app, request, url));
            }

            // The web app: index.html for app routes, files from web/ otherwise.
            if (parts.length === 0 || parts[0] === "s") {
                return serveApp(response);
            }

            const file = normalize(join(WEB, ...parts));

            if (!file.startsWith(WEB + sep)) {
                throw new HttpError(404, "Not found");
            }

            if (file === join(WEB, "index.html")) {
                return serveApp(response);
            }

            return await serveFile(request, response, file);
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500;

            if (status === 500) {
                console.error(error);
            }

            if (response.headersSent) {
                response.end();

                return;
            }

            json(response, status, {
                error: describe(error),
            });
        }
    };
}
