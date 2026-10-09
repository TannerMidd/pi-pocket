/**
 * `/api`: the routes the web app calls. Each needs a signed-in person, and each but a GET needs the `X-Pocket` header,
 * which a form on another site cannot send. A conversation's routes are in `conversation-routes.ts`.
 */
import { readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import QRCode from "qrcode";
import { MAX_PEEKS } from "../app.ts";
import {
    type Auth,
    COOKIE,
    clearAuthCookie,
    INVITE_MINUTES,
    type InviteGrant,
    type InviteMinutes,
    origin,
    parseCookies,
    quickTunnelHost,
} from "../auth.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import { desktopTheme, wallpaperFile } from "../omarchy.ts";
import { runningNow } from "../running.ts";
import { serveImage } from "./assets.ts";
import { browserRoutes } from "./browser-routes.ts";
import { conversationRoutes } from "./conversation-routes.ts";
import { createEventStreams } from "./events.ts";
import { type ApiRequest, conversationId, type HttpOptions, json, readJson } from "./io.ts";
import { pushRoutes } from "./push-routes.ts";

/** This machine's non-internal IPv4 addresses, for invite links other devices on its networks can open. */
function lanAddresses(): string[] {
    return Object.values(networkInterfaces())
        .flat()
        .filter((net) => net !== undefined && net.family === "IPv4" && !net.internal)
        .map((net) => net!.address);
}

/** The `/api` routes. Each HTTP handler makes its own, and its event streams live as long as it does. */
export function createApi(options: HttpOptions, auth: Auth) {
    const { app } = options;
    const { events, poll } = createEventStreams(app);

    const requireUser = (request: IncomingMessage): User => {
        const user = auth.user(request);

        if (user === undefined) {
            throw new HttpError(401, "Sign in first");
        }

        return user;
    };

    const requireOwner = (user: User): void => {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }
    };

    /**
     * What an invite may grant: viewers and people invited to one session cannot invite anyone, and only the owner can
     * sign a device in as the owner (never for one session).
     */
    const inviteGrant = (user: User, body: { role?: unknown; session?: unknown }): InviteGrant => {
        if (body.role === "owner") {
            requireOwner(user);

            return { role: "owner" };
        }

        if (user.role === "viewer" || user.sessions !== undefined) {
            throw new HttpError(403, "Only people with access to every session can invite others.");
        }

        const role = body.role === "viewer" ? "viewer" : "guest";

        if (body.session === undefined || body.session === null) {
            return { role };
        }

        const session = conversationId(String(body.session));

        if (!app.sessions(user).some((each) => each.id === Number(session))) {
            throw new HttpError(400, "No such session");
        }

        return { role, session: String(session) };
    };

    /** How long an invite lasts, in minutes: one of `INVITE_MINUTES`, 15 when not said. */
    const inviteMinutes = (body: { minutes?: unknown }): InviteMinutes => {
        if (body.minutes === undefined) {
            return 15;
        }

        const minutes = INVITE_MINUTES.find((each) => each === body.minutes);

        if (minutes === undefined) {
            throw new HttpError(400, "An invite lasts 15 minutes, an hour, a day, or a week.");
        }

        return minutes;
    };

    /** A guest signed in by a cookie set on a Cloudflare quick tunnel can only come back through it: remember which one. */
    const noteTunnel = (request: IncomingMessage, user: User): void => {
        if (
            user.role === "owner" ||
            user.tunnel !== undefined ||
            !parseCookies(request.headers.cookie)[COOKIE]
        ) {
            return;
        }

        const tunnel = quickTunnelHost(request);

        if (tunnel !== undefined) {
            app.config.updateUser(user.id, { tunnel });
        }
    };

    return async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        parts: string[],
    ): Promise<void> => {
        const method = request.method ?? "GET";
        const user = requireUser(request);

        noteTunnel(request, user);

        if (method !== "GET" && request.headers["x-pocket"] !== "1") {
            throw new HttpError(403, "Missing X-Pocket header");
        }

        const [first, second, third, fourth] = parts;
        const route: ApiRequest = { app, request, response, url, user };

        if (first === "events" && method === "GET") {
            return events(request, response, url, user);
        }

        if (first === "poll" && method === "GET") {
            return poll(request, response, url, user);
        }

        if (first === "me" && method === "GET") {
            return json(response, 200, await app.hello(user));
        }

        if (first === "me" && method === "POST") {
            const body = await readJson<{ name?: string }>(request);
            const name = String(body.name ?? "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 40);

            if (name === "") {
                throw new HttpError(400, "Name is empty");
            }

            app.rename(user, name);

            return json(response, 200, { ok: true });
        }

        if (first === "logout" && method === "POST") {
            clearAuthCookie(response);

            return json(response, 200, { ok: true });
        }

        if (first === "users" && second === undefined && method === "GET") {
            return json(response, 200, app.people(user));
        }

        if (first === "users" && second !== undefined && third === "remove" && method === "POST") {
            app.removeUser(user, second);

            return json(response, 200, { ok: true });
        }

        if (first === "users" && second !== undefined && third === undefined && method === "POST") {
            app.setAccess(user, second, await readJson(request));

            return json(response, 200, app.people(user));
        }

        if (first === "visibility" && method === "POST") {
            const body = await readJson<{ tab?: unknown; visible?: unknown }>(request);

            app.setVisible(user, String(body.tab ?? ""), body.visible !== false);

            return json(response, 200, { ok: true });
        }

        // The sessions a connection shows as peek tiles on screen now: they get `peek` events until it sends another list.
        if (first === "peeks" && method === "POST") {
            const body = await readJson<{ connection?: unknown; ids?: unknown; seq?: unknown }>(
                request,
            );

            if (!Array.isArray(body.ids)) {
                throw new HttpError(400, "ids must be a list of session ids");
            }

            if (body.seq !== undefined && !Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            app.setPeeks(
                user,
                String(body.connection ?? ""),
                body.ids.slice(0, MAX_PEEKS).map((id) => conversationId(String(id))),
                body.seq as number | undefined,
            );

            return json(response, 200, { ok: true });
        }

        if (first === "push") {
            return pushRoutes(route, second);
        }

        // The Omarchy desktop's theme, for the app's "Follow desktop" look: colors say nothing about the sessions here, so
        // everyone signed in gets them. The wallpaper may be a personal photo: only the owner gets that.
        if (first === "theme" && second === undefined && method === "GET") {
            const theme = await desktopTheme();

            return json(response, 200, {
                theme:
                    theme === null
                        ? null
                        : { ...theme, wallpaper: theme.wallpaper && user.role === "owner" },
            });
        }

        if (first === "theme" && second === "wallpaper" && method === "GET") {
            if (user.role !== "owner") {
                throw new HttpError(403, "Only the owner sees the desktop's wallpaper");
            }

            const file = await wallpaperFile();

            if (file === undefined) {
                throw new HttpError(404, "No wallpaper");
            }

            return serveImage(request, response, file);
        }

        if (first === "running" && method === "GET") {
            return json(response, 200, await runningNow(app, user));
        }

        if (first === "spend" && method === "GET") {
            return json(response, 200, app.spend.summary(user));
        }

        if (first === "spend" && method === "POST") {
            const body = await readJson<{ session?: unknown; person?: unknown; budget?: unknown }>(
                request,
            );

            if (body.session !== undefined) {
                await app.spend.setSessionBudget(
                    user,
                    conversationId(String(body.session)),
                    body.budget,
                );
            } else if (typeof body.person === "string") {
                app.spend.setPersonBudget(user, body.person, body.budget);
            } else {
                throw new HttpError(400, "Say which session or person");
            }

            return json(response, 200, app.spend.summary(user));
        }

        if (first === "sessions" && second === undefined && method === "GET") {
            return json(response, 200, app.sessions(user));
        }

        // Pi's sessions from the terminal, which the owner can continue here.
        if (first === "pi-sessions" && second === undefined && method === "GET") {
            return json(response, 200, await app.piSessions.list(user));
        }

        if (first === "pi-sessions" && second === "preview" && method === "GET") {
            return json(
                response,
                200,
                await app.piSessions.preview(user, url.searchParams.get("path") ?? ""),
            );
        }

        if (first === "pi-sessions" && second === "continue" && method === "POST") {
            const body = await readJson<{ path?: unknown }>(request);

            if (typeof body.path !== "string") {
                throw new HttpError(400, "path is required");
            }

            return json(response, 200, await app.commands.continuePiSession(user, body.path));
        }

        if (first === "sessions" && second === undefined && method === "POST") {
            const body = await readJson<{ cwd?: string; title?: string; worktree?: unknown }>(
                request,
            );

            return json(response, 200, await app.commands.createSession(user, body));
        }

        if (first === "sessions" && second !== undefined && method === "POST") {
            const body = await readJson<{ title?: string; archived?: boolean }>(request);

            await app.commands.updateSession(conversationId(second), user, body);

            return json(response, 200, { ok: true });
        }

        if (first === "c" && second !== undefined) {
            const id = conversationId(second);

            app.requireSee(user, id);

            if (third === "browser") {
                return browserRoutes(route, id, fourth, options.listen.port);
            }

            return conversationRoutes(route, id, parts);
        }

        if (first === "approvals" && second !== undefined && method === "POST") {
            const body = await readJson<{ allow?: boolean }>(request);

            if (!(await app.answerApproval(second, body.allow === true, user))) {
                throw new HttpError(404, "That approval is no longer pending");
            }

            return json(response, 200, { ok: true });
        }

        if (first === "fs" && method === "GET") {
            app.requireSteer(user);

            if (user.sessions !== undefined) {
                throw new HttpError(403, "You were invited to one session.");
            }

            const requested = url.searchParams.get("path") || "~";
            const path = app.workspace.checkDirectory(requested);
            const showHidden = url.searchParams.get("hidden") === "1";
            const dirs: { name: string; path: string }[] = [];

            for (const entry of readdirSync(path, { withFileTypes: true })) {
                if (!showHidden && entry.name.startsWith(".")) {
                    continue;
                }

                let isDir = entry.isDirectory();

                if (entry.isSymbolicLink()) {
                    try {
                        isDir = statSync(join(path, entry.name)).isDirectory();
                    } catch {
                        isDir = false;
                    }
                }

                if (isDir) {
                    dirs.push({ name: entry.name, path: join(path, entry.name) });
                }
            }

            dirs.sort((a, b) => a.name.localeCompare(b.name));
            const recent = [...new Set(app.sessions(user).map((session) => session.cwd))].slice(
                0,
                8,
            );

            return json(response, 200, {
                path,
                parent: dirname(path) === path ? null : dirname(path),
                home: homedir(),
                dirs: dirs.slice(0, 1000),
                recent,
            });
        }

        // A new folder, from the folder picker: it opens in the picker, ready to use.
        if (first === "fs" && second === undefined && method === "POST") {
            const body = await readJson<{ path?: unknown }>(request);

            if (typeof body.path !== "string") {
                throw new HttpError(400, "Name the folder to make.");
            }

            return json(response, 200, { path: app.workspace.makeFolder(user, body.path) });
        }

        if (first === "settings" && method === "POST") {
            const body = await readJson<{ approvalRule?: unknown }>(request);

            if (body.approvalRule !== undefined) {
                await app.setApprovalRule(user, body.approvalRule);
            }

            return json(response, 200, { ok: true });
        }

        if (first === "extensions" && second === undefined && method === "GET") {
            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "extensions" &&
            second !== undefined &&
            third === undefined &&
            method === "POST"
        ) {
            requireOwner(user);
            const body = await readJson<{ enabled?: unknown }>(request);

            if (typeof body.enabled !== "boolean") {
                throw new HttpError(400, "enabled must be true or false");
            }

            await app.setExtensionEnabled(user, second, body.enabled);

            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "extensions" &&
            second !== undefined &&
            third === "reload" &&
            method === "POST"
        ) {
            requireOwner(user);
            await app.reloadExtension(second);

            return json(response, 200, await app.extensions(user));
        }

        if (first === "providers" && second === undefined && method === "GET") {
            return json(response, 200, app.providers.list());
        }

        if (
            first === "providers" &&
            second !== undefined &&
            third === "login" &&
            method === "POST"
        ) {
            requireOwner(user);
            const body = await readJson<{ type?: string }>(request);

            return json(response, 200, {
                flowId: app.providers.startLogin(
                    user,
                    second,
                    body.type === "oauth" ? "oauth" : "api_key",
                ),
            });
        }

        if (
            first === "providers" &&
            second !== undefined &&
            third === "logout" &&
            method === "POST"
        ) {
            requireOwner(user);
            await app.providers.logout(second);

            return json(response, 200, { ok: true });
        }

        if (first === "auth" && second !== undefined && third === "cancel" && method === "POST") {
            app.providers.cancelLogin(user, second);

            return json(response, 200, { ok: true });
        }

        if (first === "auth" && second !== undefined && third !== undefined && method === "POST") {
            const body = await readJson<{ value?: string; cancel?: boolean }>(request);

            app.providers.answerLogin(
                user,
                second,
                third,
                body.cancel === true ? undefined : String(body.value ?? ""),
            );

            return json(response, 200, { ok: true });
        }

        if (first === "invite" && second === "cancel" && method === "POST") {
            const body = (await readJson(request)) as { code?: unknown };

            if (typeof body.code !== "string") {
                throw new HttpError(400, "Say which invite.");
            }

            // Only whoever made it ends it; for anyone else it stays as it was, and nothing says whether it exists.
            auth.cancelInvite(body.code, user);

            return json(response, 200, { ok: true });
        }

        if (first === "invite" && second === undefined && method === "POST") {
            const body = (await readJson(request)) as {
                role?: unknown;
                session?: unknown;
                minutes?: unknown;
            };
            const grant = inviteGrant(user, body);
            const invite = auth.createInvite(user, grant, inviteMinutes(body));
            const here = origin(request);
            const loopback = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(
                here,
            );
            const wildcard = options.listen.host === "0.0.0.0" || options.listen.host === "::";
            const lan =
                loopback && wildcard
                    ? lanAddresses().map((address) => `http://${address}:${options.listen.port}`)
                    : [];
            // A tunnel the launcher started is the way in for other devices.
            const tunnel = loopback ? app.access?.url : undefined;
            const base = tunnel ?? lan[0] ?? here;
            const link = `${base}/join/${invite.code}`;
            // An invite whose QR code could not be made is never shown: it ends rather than stay live, unseen.
            const svg = await QRCode.toString(link, {
                type: "svg",
                margin: 1,
                color: { dark: "#000000", light: "#ffffff" },
            }).catch((error: unknown) => {
                auth.cancelInvite(invite.code, user);

                throw error;
            });

            return json(response, 200, {
                ...invite,
                grant,
                url: link,
                svg,
                alternatives: (tunnel === undefined ? lan.slice(1) : lan).map(
                    (address) => `${address}/join/${invite.code}`,
                ),
                // Only this device can open a loopback link.
                local: loopback && lan.length === 0 && tunnel === undefined,
                ...(app.access === undefined ? {} : { access: app.access }),
            });
        }

        if (first === "restart" && method === "POST") {
            requireOwner(user);

            if (!app.supervised) {
                throw new HttpError(
                    409,
                    "Start Pi Pocket with bin/pi-pocket.js to restart from the app.",
                );
            }

            json(response, 200, { ok: true });
            setTimeout(() => options.restart(), 100);

            return;
        }

        throw new HttpError(404, "Unknown API route");
    };
}
