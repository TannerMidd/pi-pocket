/**
 * The HTTP server's one request handler: the API (`http/api.ts`), artifacts, the sign-in pages, and the web app's own
 * files. Each part lives in `http/`; this file routes a request to it and turns what it throws into an answer.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, normalize, sep } from "node:path";
import { Auth } from "./auth.ts";
import { describe, HttpError } from "./errors.ts";
import { createApi } from "./http/api.ts";
import { artifact } from "./http/artifacts.ts";
import { serveApp, serveFile, VENDOR, WEB } from "./http/assets.ts";
import { type HttpOptions, json } from "./http/io.ts";
import { join as joinPage, login, sharePage } from "./http/sign-in.ts";

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

            if (parts[0] === "api") {
                return await api(request, response, url, parts.slice(1));
            }

            if (parts[0] === "a") {
                return await artifact(app, response, parts.slice(1), auth.user(request));
            }

            if (parts[0] === "vendor" && parts[1] !== undefined && VENDOR[parts[1]] !== undefined) {
                return serveFile(response, VENDOR[parts[1]]!, "text/javascript; charset=utf-8");
            }

            if (parts[0] === "login" && (request.method === "GET" || request.method === "POST")) {
                return await login(auth, request, response, url);
            }

            if (parts[0] === "join" && parts[1] !== undefined) {
                return await joinPage(app, auth, request, response, parts[1]);
            }

            // Shares from other apps go to the service worker (web/sw.js). One that reaches the server came before the
            // worker was installed on this device; nothing here knows where it should go.
            if (parts[0] === "share" && request.method === "POST") {
                return sharePage(response);
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

            return serveFile(response, file);
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
