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
 * A Markdown artifact's look, from a few colors: the browser's light or dark by default, the app's theme when the
 * viewer names it (`markdownTheme`). The rest mixes from them as style.css does: code on the darker ground, quieter
 * quotes, faint lines.
 */
const MARKDOWN_STYLE =
    ":root{color-scheme:dark;--bg:#1a1b26;--fg:#a9b1d6;--text:#c0caf5;--accent:#7aa2f7;--code:#13141c}" +
    "@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#fafafa;--fg:#383a42;--text:#1f2329;--accent:#2e6fd8;--code:#f0f0f1}}" +
    "body{--line:color-mix(in srgb,var(--fg) 15%,var(--bg));font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1.2rem;color:var(--fg);background:var(--bg)}" +
    "h1,h2,h3,strong{color:var(--text)}a{color:var(--accent)}pre{background:var(--code);border:1px solid var(--line);padding:.8rem;overflow:auto}code{font-family:ui-monospace,monospace;color:var(--text)}" +
    "table{border-collapse:collapse}td,th{border:1px solid var(--line);padding:.3rem .5rem}" +
    "blockquote{border-left:2px solid color-mix(in srgb,var(--fg) 30%,var(--bg));margin-left:0;padding-left:.8rem;color:color-mix(in oklab,var(--fg) 70%,var(--bg))}img{max-width:100%}";

const HEX = /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The app's theme for a Markdown artifact, as CSS after `MARKDOWN_STYLE`: the artifact's page cannot see it, in a
 * sandbox with an origin of its own, so the viewer names it in the address (`?mode=light&bg=eff1f5&fg=…`). Only
 * hex colors pass; without a background and a foreground, nothing does, and the page keeps the browser's light or dark.
 */
function markdownTheme(query: URLSearchParams): string {
    const color = (name: string) => {
        const value = query.get(name);

        return value !== null && HEX.test(value) ? `#${value}` : undefined;
    };

    const bg = color("bg");
    const fg = color("fg");

    if (bg === undefined || fg === undefined) {
        return "";
    }

    const mode = query.get("mode");
    const vars = {
        "color-scheme": mode === "light" || mode === "dark" ? mode : undefined,
        "--bg": bg,
        "--fg": fg,
        "--text": color("text") ?? fg,
        "--accent": color("accent") ?? fg,
        "--code": color("code") ?? bg,
    };

    return `:root{${Object.entries(vars)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => `${name}:${value}`)
        .join(";")}}`;
}

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
    query = new URLSearchParams(),
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
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(found.meta.title)}</title><style>${MARKDOWN_STYLE}${markdownTheme(query)}</style></head><body>${rendered}</body></html>`;

        return send(response, 200, html, "text/html; charset=utf-8", headers);
    }

    return send(response, 200, found.content, "text/html; charset=utf-8", headers);
}
