/**
 * The pages outside the app: signing in with a link, joining with an invite, and a share that arrived too early. Each
 * shows the fixed words of one language (`RequestLocale`): the catalog snapshot and the language are chosen once for
 * the request by `http.ts`, and never again while a page waits for a session's title.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import { type Auth, quickTunnelHost, setAuthCookie } from "../auth.ts";
import { HttpError } from "../errors.ts";
import type { RequestLocale } from "../ui-locales.ts";
import { conversationId, escapeHtml, readBody, send } from "./io.ts";

/** A form posted from another site, as browsers report it. Such a post must not sign this browser in or out. */
function crossSite(request: IncomingMessage): boolean {
    const site = request.headers["sec-fetch-site"];

    return site !== undefined && site !== "same-origin" && site !== "none";
}

/** Where to go after signing in: a path on this server, never `//host` or `/\host`, which browsers read as another site. */
function localPath(next: string | null): string {
    return next !== null && /^\/(?![/\\])/.test(next) ? next : "/";
}

/** A page outside the app, in the language of this request. `body` is HTML that core built and escaped already. */
function page(title: string, body: string, lang: string): string {
    return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/style.css"></head><body class="plain-page"><main class="plain">${body}</main></body></html>`;
}

/** `/login`: sign this browser in with a token from a link, after asking when it would switch accounts. */
export async function login(
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    locale: RequestLocale,
): Promise<void> {
    const posted = request.method === "POST";

    if (posted && crossSite(request)) {
        throw new HttpError(403, "Sign in from Pi Pocket's own page.");
    }

    const form = posted
        ? new URLSearchParams((await readBody(request, 10_000)).toString("utf8"))
        : url.searchParams;
    const token = form.get("token") ?? "";
    const next = localPath(form.get("next"));
    const signingIn = auth.tokenUser(token);

    if (signingIn === undefined) {
        return send(
            response,
            401,
            page(
                locale.t("signin.title", "Pi Pocket"),
                `<h1>${escapeHtml(locale.t("signin.link-expired-title", "Link expired"))}</h1><p>${escapeHtml(locale.t("signin.link-expired", "That login link is not valid. Use the link Pi Pocket prints when it starts, or ask someone signed in for a new invite."))}</p>`,
                locale.lang,
            ),
            "text/html; charset=utf-8",
        );
    }

    const current = auth.user(request);

    if (!posted && current !== undefined && current.id !== signingIn.id) {
        // Signed in as someone else: switching takes a tap, so a link on another site cannot do it unnoticed.
        return send(
            response,
            200,
            page(
                locale.t("signin.switch-page-title", "Switch account? · Pi Pocket"),
                `<h1>${escapeHtml(locale.t("signin.switch-title", "Switch account?"))}</h1><p>${escapeHtml(locale.t("signin.switch-body", "This browser is signed in as {current}. The link you opened signs it in as {next} instead.", { current: current.name, next: signingIn.name }))}</p><form method="post" action="/login"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="next" value="${escapeHtml(next)}"><button type="submit">${escapeHtml(locale.t("signin.switch-as", "Sign in as {name}", { name: signingIn.name }))}</button></form><p><a href="/">${escapeHtml(locale.t("signin.stay-as", "Stay signed in as {name}", { name: current.name }))}</a></p>`,
                locale.lang,
            ),
            "text/html; charset=utf-8",
            { "referrer-policy": "no-referrer" },
        );
    }

    setAuthCookie(request, response, token);
    response.writeHead(303, { location: next });
    response.end();

    return;
}

/** `/join/:code`: what an invite grants, and redeeming it with a name (or, for an owner invite, signing in as the owner). */
export async function join(
    app: PocketApp,
    auth: Auth,
    request: IncomingMessage,
    response: ServerResponse,
    code: string,
    locale: RequestLocale,
): Promise<void> {
    if (request.method === "POST") {
        if (crossSite(request)) {
            throw new HttpError(403, "Join from Pi Pocket's own page.");
        }

        const form = new URLSearchParams((await readBody(request, 10_000)).toString("utf8"));
        const redeemed = auth.redeem(code, form.get("name") ?? "");

        if (redeemed === undefined) {
            return send(
                response,
                410,
                page(
                    locale.t("signin.title", "Pi Pocket"),
                    `<h1>${escapeHtml(locale.t("signin.invite-expired-title", "Invite expired"))}</h1><p>${escapeHtml(locale.t("signin.invite-expired", "Ask for a new one."))}</p>`,
                    locale.lang,
                ),
                "text/html; charset=utf-8",
            );
        }

        const tunnel = quickTunnelHost(request);

        // The owner is never tied to one tunnel.
        if (tunnel !== undefined && redeemed.user.role !== "owner") {
            app.config.updateUser(redeemed.user.id, { tunnel });
        }

        setAuthCookie(request, response, redeemed.token);
        response.writeHead(303, { location: "/" });
        response.end();

        return;
    }

    const grant = auth.invite(code);

    if (grant === undefined) {
        return send(
            response,
            410,
            page(
                locale.t("signin.title", "Pi Pocket"),
                `<h1>${escapeHtml(locale.t("signin.invite-expired-title", "Invite expired"))}</h1><p>${escapeHtml(locale.t("signin.invite-used", "Each invite works once, and only until it expires. Ask for a new one."))}</p>`,
                locale.lang,
            ),
            "text/html; charset=utf-8",
        );
    }

    if (grant.role === "owner") {
        const current = auth.user(request);
        // Signed in as someone else: say so, as switching accounts does.
        const switching =
            current !== undefined && current.role !== "owner"
                ? `<p>${escapeHtml(locale.t("signin.owner-switch", "This browser is signed in as {name}. It will change to the owner.", { name: current.name }))}</p>`
                : "";

        return send(
            response,
            200,
            page(
                locale.t("signin.owner-page-title", "Sign in as owner · Pi Pocket"),
                `<h1>${escapeHtml(locale.t("signin.owner-title", "Sign in as owner"))}</h1><p>${escapeHtml(locale.t("signin.owner-body", "This device will sign in as you, the owner. It gets full control of Pi Pocket and of this machine."))}</p>${switching}<form method="post"><button type="submit">${escapeHtml(locale.t("signin.owner-sign-in", "Sign in as owner"))}</button></form>`,
                locale.lang,
            ),
            "text/html; charset=utf-8",
            { "referrer-policy": "no-referrer" },
        );
    }

    // The session's title is the person's own words: raw here, and escaped once with the sentence that holds it.
    const where =
        grant.session === undefined
            ? locale.t("signin.join-any", "every session on this server")
            : locale.t("signin.join-one", "the session “{title}”", {
                  title: await app.conversationTitle(conversationId(grant.session)),
              });
    const can =
        grant.role === "viewer"
            ? locale.t(
                  "signin.join-read",
                  "read {where} and chat with the people there, but not steer Pi",
                  { where },
              )
            : locale.t(
                  "signin.join-steer",
                  "read and steer {where}. Pi can run commands on this machine",
                  { where },
              );

    return send(
        response,
        200,
        page(
            locale.t("signin.join-title", "Join Pi Pocket"),
            `<h1>${escapeHtml(locale.t("signin.join-title", "Join Pi Pocket"))}</h1><p>${escapeHtml(locale.t("signin.join-body", "This device will be able to {can}.", { can }))}</p><form method="post"><label>${escapeHtml(locale.t("signin.name-label", "Your name"))}<input name="name" maxlength="40" autofocus required placeholder="${escapeHtml(locale.t("signin.name-placeholder", "e.g. Alex"))}"></label><button type="submit">${escapeHtml(locale.t("signin.join", "Join"))}</button></form>`,
            locale.lang,
        ),
        "text/html; charset=utf-8",
    );
}

/** `/share`: a share that reached the server, before the service worker that takes shares was installed here. */
export function sharePage(response: ServerResponse, locale: RequestLocale): void {
    return send(
        response,
        200,
        page(
            locale.t("signin.share-page-title", "Share to Pi"),
            `<h1>${escapeHtml(locale.t("signin.share-title", "Open Pi Pocket first"))}</h1><p>${escapeHtml(locale.t("signin.share-body", "Sharing works once Pi Pocket has been opened on this device over https. Open it, then share again."))}</p><p><a href="/">${escapeHtml(locale.t("signin.share-open", "Open Pi Pocket"))}</a></p>`,
            locale.lang,
        ),
        "text/html; charset=utf-8",
    );
}
