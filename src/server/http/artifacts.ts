/** `/a/:conversation/:artifact/:version`: an artifact as its own page, in a sandbox with no way into the app. */
import type { ServerResponse } from "node:http";
import { marked } from "marked";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import { conversationId, escapeHtml, send } from "./io.ts";

/** Artifacts get an opaque origin even when opened in their own tab: no cookies, no access to the app. */
const ARTIFACT_CSP =
    "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-downloads; frame-ancestors 'self'";

export async function artifact(
    app: PocketApp,
    response: ServerResponse,
    parts: string[],
    user: User | undefined,
): Promise<void> {
    if (user === undefined) {
        throw new HttpError(401, "Sign in first");
    }

    const [conv, id, version] = parts;

    if (id === undefined) {
        throw new HttpError(404, "No artifact");
    }

    app.requireSee(user, conversationId(conv));
    const found = await app.artifactBody(
        conversationId(conv),
        id,
        version === undefined || version === "latest" ? undefined : Number(version),
    );
    const headers = {
        "content-security-policy": ARTIFACT_CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
    };

    if (found.meta.type === "svg") {
        return send(response, 200, found.content, "image/svg+xml", headers);
    }

    if (found.meta.type === "markdown") {
        const rendered = await marked.parse(found.content);
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(found.meta.title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1.2rem;color:#a9b1d6;background:#13141c}h1,h2,h3,strong{color:#c0caf5}a{color:#7aa2f7}pre{background:#0e0e14;border:1px solid #292e42;padding:.8rem;overflow:auto}code{font-family:ui-monospace,monospace;color:#c0caf5}table{border-collapse:collapse}td,th{border:1px solid #292e42;padding:.3rem .5rem}blockquote{border-left:2px solid #3b4261;margin-left:0;padding-left:.8rem;color:#7a82ad}img{max-width:100%}</style></head><body>${rendered}</body></html>`;

        return send(response, 200, html, "text/html; charset=utf-8", headers);
    }

    return send(response, 200, found.content, "text/html; charset=utf-8", headers);
}
