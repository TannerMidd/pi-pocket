/**
 * `/a/:conversation/:artifact/:version`: an artifact as its own page, in a sandbox with no way into the app. `/a/frame`:
 * the page that runs HTML from a reply, once someone taps Run, in the same sandbox. A published artifact (`/pub/:token`,
 * `public.ts`) serves the same page, to anyone with its address.
 */
import type { ServerResponse } from "node:http";
import { marked } from "marked";
import type { PocketApp } from "../app.ts";
import { origin } from "../auth.ts";
import type { User } from "../config.ts";
import type { ArtifactType } from "../docs.ts";
import { HttpError } from "../errors.ts";
import { ARTIFACT_INSPECT, withDeck } from "./artifact-inspect.ts";
import { conversationId, escapeHtml, send } from "./io.ts";
import { ARTIFACT_CSP, artifactAssetResponse, assetRoot, assetUser } from "./artifact-assets.ts";

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
 * The first script of every HTML artifact, and of the page a reply's HTML runs in (`RUN_FRAME`): it is what makes the
 * bridge (`web/artifact-bridge.js`) safe. Run in a frame, it opens a channel to the app and hands the app one end:
 * that channel belongs to this document, so a page the frame goes on to has no line to the app, and an answer cannot
 * reach it. The page's `parent` becomes a stand-in whose `postMessage` takes follow-ups and saved state down the channel
 * (everything else still goes to the real parent), and its answers arrive as `message` events from that stand-in, so
 * `event.source === parent` holds. A follow-up goes down only after a tap that a person made on the page (a trusted
 * event: the page cannot make one) within 5 seconds, and each tap serves one: one event counts for each (a mouse's
 * press, a finger's or pen's lift, a key's press but not its repeats), or a page could spend the tap in one event and
 * get it back from the next of the same tap (mousedown after pointerdown, touchend after pointerup). The message is copied before it is read,
 * so a getter cannot show one type to this check and another to the app. Runs outside a frame or a sandbox: nothing.
 * `rearm` puts the tap listeners back, and design mode's too, for a page that wipes them with `document.open()`.
 *
 * Design mode's page side (`ARTIFACT_INSPECT`, `artifact-inspect.ts`) starts here too, with the line to the app: the
 * app's design messages (inspect, text edit, tweaks, pins, goto) go to it and not to the page, and it sends the app
 * what a person picks or edits, the page's tweaks manifest, and a deck's slides. Only it can send them: the stand-in
 * `parent` passes the page's own messages for follow-ups and saved state, and nothing more down the line.
 */
const ARTIFACT_BRIDGE = `
    const realParent = window.parent;

    if (realParent === window || self.origin !== "null") {
        return undefined;
    }

    const realPost = realParent.postMessage.bind(realParent);
    const clone = structuredClone;
    const listen = window.addEventListener.bind(window);
    const fire = window.dispatchEvent.bind(window);
    const later = window.setTimeout.bind(window);
    const now = performance.now.bind(performance);
    const Heard = MessageEvent;
    const channel = new MessageChannel();
    const line = channel.port1;
    const toApp = line.postMessage.bind(line);
    const stand = new MessageChannel().port1;
    const address = location.origin;
    let tapped = -Infinity;

    const tap = (event) => {
        if (event.isTrusted) {
            tapped = now();
        }
    };

    const rearm = () => {
        listen("keydown", (event) => event.key !== "Escape" && !event.repeat && tap(event), true);
        listen("pointerdown", (event) => event.pointerType === "mouse" && tap(event), true);
        listen("pointerup", (event) => event.pointerType !== "mouse" && tap(event), true);
    };

    const tell = (data) => fire(new Heard("message", { data, source: stand, origin: address }));

    const design = (${ARTIFACT_INSPECT})(toApp, false);

    line.onmessage = (event) => {
        if (!design.message(event.data)) {
            tell(event.data);
        }
    };
    Object.defineProperty(stand, "postMessage", {
        value: (message, ...rest) => {
            const copy = clone(message);
            const type = copy !== null && typeof copy === "object" ? copy.type : undefined;

            if (type === "pocket-follow-up") {
                if (now() - tapped > 5000) {
                    later(() => tell({ type, ok: false, error: "Only after the person taps the page" }), 0);

                    return;
                }

                tapped = -Infinity;
                toApp(copy);
            } else if (type === "pocket-state-get" || type === "pocket-state-set") {
                toApp(copy);
            } else {
                realPost(message, ...rest);
            }
        },
    });
    Object.defineProperty(window, "parent", { get: () => stand, configurable: false });
    rearm();
    realPost({ type: "pocket-bridge" }, "*", [channel.port2]);

    return {
        realParent,
        realPost,
        rearm: () => {
            rearm();
            design.restart();
        },
    };
`;

/** The bridge as a script tag, for the start of an HTML artifact. */
const BRIDGE_TAG = `<script>(() => {${ARTIFACT_BRIDGE}})();</script>`;

/**
 * The artifact's HTML with `BRIDGE_TAG` first, before anything of the page can run. Only a doctype at the very start
 * (after a byte order mark and HTML's own white space) goes before it, so such a page keeps its mode: a doctype ends at
 * its first `>` for the browser too, so nothing in it can run. Comments are not skipped: a browser reads odd ones
 * (`<!-->`) otherwise than a pattern would, and a script that one hides would run before the bridge. A page with a
 * comment before its doctype so loads in quirks mode.
 */
export function withBridge(html: string): string {
    const start = /^\uFEFF?[\t\n\f\r ]*(?:<!doctype[^>]*>)?/i.exec(html)![0];

    return start + BRIDGE_TAG + html.slice(start.length);
}

/**
 * The page a reply's HTML runs in once someone taps Run (`web/run-frame.js`). It runs only what its parent sends it, and
 * only as the app's own sandboxed frame: with an opaque origin, from a parent at the app's address. The HTML then
 * replaces the page and reports its height, so the frame fits it. Like an artifact, it can reach the network, not the
 * app, and it has the same bridge (`ARTIFACT_BRIDGE`), which survives the page being replaced.
 */
export const RUN_FRAME = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preview</title></head><body><script>
(() => {
    const bridge = (() => {${ARTIFACT_BRIDGE}})();

    if (bridge === undefined) {
        return;
    }

    // The page's height is its body's with its margins: the document's own is never less than the frame. "fills" says
    // the page is as tall as its frame, as a page sized by it (100vh) is.
    const size = '<script>(() => { const post = () => { const body = document.body; const style = body && getComputedStyle(body); const height = body ? body.scrollHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom) : document.documentElement.scrollHeight; parent.postMessage({ type: "pocket-run-size", height: Math.ceil(height), fills: document.documentElement.scrollHeight <= innerHeight + 1 && height >= innerHeight - 1 }, "*"); }; new ResizeObserver(post).observe(document.documentElement); addEventListener("load", post); post(); })();<' + '/script>';

    // Only the app's own page may send it HTML. location.origin is this page's address, not its opaque origin.
    addEventListener("message", (event) => {
        const data = event.data;

        if (event.source !== bridge.realParent || event.origin !== location.origin || data?.type !== "pocket-run" || typeof data.html !== "string") {
            return;
        }

        document.open();
        document.write(data.html + size);
        document.close();
        // document.open() wiped the listeners, the taps' too.
        bridge.rearm();
    });
    bridge.realPost({ type: "pocket-run-ready" }, "*");
})();
</script></body></html>`;

/**
 * An artifact's body as its page: SVG as an image, Markdown rendered in the artifact's own look, HTML as it was written.
 * `/a/…` and a published one (`/pub/:token`) serve the same pages, in the same sandbox.
 */
export async function artifactResponse(
    response: ServerResponse,
    found: { meta: { type: ArtifactType; title: string }; content: string },
    query = new URLSearchParams(),
    /** False for a public link: it shows the page as it was written, and the app frames it nowhere. */
    bridge = true,
    /** A bundle root (or an HTML asset's directory), also used when the inline card fetches this page. */
    base?: string,
): Promise<void> {
    const headers = {
        "content-security-policy": ARTIFACT_CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "access-control-allow-origin": "*",
    };

    if (base !== undefined && found.meta.type === "html") {
        const start = /^\uFEFF?[\t\n\f\r ]*(?:<!doctype[^>]*>)?/i.exec(found.content)![0];

        found = {
            ...found,
            content:
                start + `<base href="${escapeHtml(base)}">` + found.content.slice(start.length),
        };
    }

    if (found.meta.type === "svg") {
        return send(response, 200, found.content, "image/svg+xml", headers);
    }

    if (found.meta.type === "markdown") {
        const rendered = await marked.parse(found.content);
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(found.meta.title)}</title>${base === undefined ? "" : `<base href="${escapeHtml(base)}">`}<style>${MARKDOWN_STYLE}${markdownTheme(query)}</style></head><body>${rendered}</body></html>`;

        return send(response, 200, html, "text/html; charset=utf-8", headers);
    }

    // The bridge's script goes in unless the browser says (in `Sec-Fetch-Dest`, which a page cannot set) that this is a
    // tab of its own or a script's fetch: those get the page as it was written. With no such header (an older browser,
    // a proxy that drops it), it goes in too, or a page could say hello itself and send follow-ups with no tap. Outside
    // a frame, it does nothing.
    const dest = response.req?.headers["sec-fetch-dest"];
    // A deck as a page of its own still shows one slide at a time (`withDeck`). A script's fetch (the inline card) gets
    // the page as it was written: the card shows it as code, and runs it in the run frame, which has the bridge.
    const content =
        dest === "empty"
            ? found.content
            : !bridge || dest === "document"
              ? withDeck(found.content)
              : withBridge(found.content);

    return send(response, 200, content, "text/html; charset=utf-8", headers);
}

export async function artifact(
    app: PocketApp,
    response: ServerResponse,
    parts: string[],
    user: User | undefined,
    query = new URLSearchParams(),
): Promise<void> {
    if (response.req.method !== "GET" && response.req.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");

        throw new HttpError(405, "Artifacts are only read");
    }

    const [conv, id, version] = parts;
    const name = parts.slice(3).join("/");
    const capability =
        conv !== undefined && id !== undefined && version !== undefined && name !== ""
            ? assetUser(app, conv, id, version)
            : undefined;

    // A capability is accepted only for manifest assets, never the main page or /a/frame.
    user = capability?.user ?? user;

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

    if (id === undefined) {
        throw new HttpError(404, "No artifact");
    }

    app.requireSee(user, conversationId(conv));
    const found = await app.artifactBody(
        conversationId(conv),
        id,
        capability?.version ??
            (version === undefined || version === "latest" ? undefined : Number(version)),
    );

    // An asset capability must never mint a fresh lifetime for itself.
    const root =
        capability === undefined
            ? assetRoot(app, conv!, id, found.version, user)
            : `/a/${encodeURIComponent(conv!)}/${encodeURIComponent(id)}/${encodeURIComponent(version!)}/`;

    if (name !== "") {
        return artifactAssetResponse(
            app,
            response,
            conversationId(conv),
            id,
            found.version,
            name,
            origin(response.req) + root + name.slice(0, name.lastIndexOf("/") + 1),
        );
    }

    const manifest = found.meta.versions.find((each) => each.version === found.version)!.assets;

    await artifactResponse(
        response,
        found,
        query,
        true,
        Object.keys(manifest ?? {}).length > 0 ? origin(response.req) + root : undefined,
    );
}
