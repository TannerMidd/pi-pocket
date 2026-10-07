/**
 * `/a/:conversation/:artifact/:version`: an artifact as its own page, in a sandbox with no way into the app. `/a/frame`:
 * the page that runs HTML from a reply, once someone taps Run, in the same sandbox.
 */
import type { ServerResponse } from "node:http";
import { marked } from "marked";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { HttpError } from "../errors.ts";
import { conversationId, escapeHtml, send } from "./io.ts";

/** Artifacts get an opaque origin even when opened in their own tab: no cookies, no access to the app. */
const ARTIFACT_CSP =
    "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-downloads; frame-ancestors 'self'";

/**
 * The page a reply's HTML runs in once someone taps Run (`web/run-frame.js`). It runs only what its parent sends it, and
 * only as the app's own sandboxed frame: with an opaque origin, from a parent at the app's address. The HTML then
 * replaces the page and reports its height, so the frame fits it. Like an artifact, it can reach the network, not the
 * app.
 */
export const RUN_FRAME = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preview</title></head><body><script>
(() => {
    if (self.origin !== "null" || window.parent === window) {
        return;
    }

    // The page's height is its body's with its margins: the document's own is never less than the frame. "fills" says
    // the page is as tall as its frame, as a page sized by it (100vh) is.
    const size = '<script>(() => { const post = () => { const body = document.body; const style = body && getComputedStyle(body); const height = body ? body.scrollHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom) : document.documentElement.scrollHeight; parent.postMessage({ type: "pocket-run-size", height: Math.ceil(height), fills: document.documentElement.scrollHeight <= innerHeight + 1 && height >= innerHeight - 1 }, "*"); }; new ResizeObserver(post).observe(document.documentElement); addEventListener("load", post); post(); })();<' + '/script>';

    // Only the app's own page may send it HTML. location.origin is this page's address, not its opaque origin.
    addEventListener("message", (event) => {
        const data = event.data;

        if (event.source !== window.parent || event.origin !== location.origin || data?.type !== "pocket-run" || typeof data.html !== "string") {
            return;
        }

        document.open();
        document.write(data.html + size);
        document.close();
    });
    parent.postMessage({ type: "pocket-run-ready" }, "*");
})();
</script></body></html>`;

export async function artifact(
    app: PocketApp,
    response: ServerResponse,
    parts: string[],
    user: User | undefined,
): Promise<void> {
    if (user === undefined) {
        throw new HttpError(401, "Sign in first");
    }

    if (parts.length === 1 && parts[0] === "frame") {
        return send(response, 200, RUN_FRAME, "text/html; charset=utf-8", {
            "content-security-policy": ARTIFACT_CSP,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "cache-control": "no-cache",
        });
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
