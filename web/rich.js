// Code blocks in replies that show more than code: an HTML page previewed (and run, on a tap), an SVG image, a diff
// in the diff viewer. ui.js draws every code block as code; this module gives `Markdown` the component for these when
// it loads (`setRichBlock`), so ui.js does not import it.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { DiffBlock } from "./diff.js";
import { highlight, langOf } from "./highlight.js";
import { RunFrame, useFitHeight } from "./run-frame.js";
import { notify } from "./store.js";
import { copyText, html, setRichBlock } from "./ui.js";

// ─── A page, previewed ──────────────────────────────────────────────────────────────

/**
 * What a preview may load: nothing from anywhere, only styles and images written into the page. The frame inherits the
 * app's policy too; this narrows it further, so a page cannot even load the app's own addresses.
 */
const PREVIEW_POLICY =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";
/** A fragment of HTML gets a plain page around it: readable type on white, as a browser would show it. */
const FRAGMENT_STYLE =
    "body{margin:12px;font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2328;background:#fff}";
const MIN_HEIGHT = 40;
const MAX_HEIGHT = 1200;

/**
 * The page a preview shows, always in standards mode (a page written without a doctype would otherwise lay out in
 * quirks mode). Parsed without running or loading anything, it loses what could reach out or move it
 * elsewhere before a tap: refreshes and other `http-equiv` meta, links (stylesheets, prefetches), and bases; then the
 * preview's policy goes first in its head. A fragment gets a plain page around it.
 */
export function previewDocument(source) {
    const fragment = !/<(?:!doctype|html|head|body)[\s>]/i.test(source);
    const page = new DOMParser().parseFromString(source, "text/html");

    for (const node of page.querySelectorAll("meta[http-equiv], link, base")) {
        node.remove();
    }

    const meta = (name, value) => {
        const element = page.createElement("meta");

        element.httpEquiv = name;
        element.content = value;

        return element;
    };

    const charset = page.createElement("meta");

    charset.setAttribute("charset", "utf-8");
    page.head.prepend(
        charset,
        meta("Content-Security-Policy", PREVIEW_POLICY),
        meta("x-dns-prefetch-control", "off"),
    );

    if (fragment) {
        const style = page.createElement("style");

        style.textContent = FRAGMENT_STYLE;
        page.head.append(style);
    }

    return `<!doctype html>${page.documentElement.outerHTML}`;
}

/**
 * HTML drawn as a page, with its scripts off: a frame of its own, without `allow-scripts`, so nothing in it runs, and
 * same-origin only so the app can measure it and fit the frame to it. Tap Run (`RunFrame`) for its scripts.
 */
export function HtmlPreview({ source, title = "Preview" }) {
    const ref = useRef(null);
    const [height, fitHeight, resetFit] = useFitHeight(MIN_HEIGHT * 3, MIN_HEIGHT, MAX_HEIGHT);
    const page = useMemo(() => previewDocument(source), [source]);

    // The page's content (the bottom of its last box, which `100vh` alone does not push down), its body's padding and
    // margin, and the frame's own border.
    const fit = () => {
        const frame = ref.current;
        const body = frame?.contentDocument?.body;

        if (!body) {
            return;
        }

        const page = frame.contentDocument;
        const style = getComputedStyle(body);
        // Everything in the body, text outside any element included, and each box (for those placed out of the flow).
        const range = page.createRange();

        range.selectNodeContents(body);
        const bottom = Math.max(
            range.getBoundingClientRect().bottom,
            ...[...body.children].map((each) => each.getBoundingClientRect().bottom),
        );
        const content =
            bottom +
            page.documentElement.scrollTop +
            parseFloat(style.paddingBottom) +
            parseFloat(style.borderBottomWidth) +
            parseFloat(style.marginBottom);
        const fills = body.getBoundingClientRect().height >= frame.clientHeight - 1;

        fitHeight(content + (frame.offsetHeight - frame.clientHeight), fills);
    };

    // A narrower frame makes a taller page.
    useEffect(() => {
        const observer = new ResizeObserver(() => fit());

        observer.observe(ref.current);

        return () => observer.disconnect();
    }, []);

    return html`<iframe
        class="html-preview"
        ref=${ref}
        sandbox="allow-same-origin"
        srcdoc=${page}
        title=${title}
        style=${`height:${height}px`}
        onLoad=${() => {
            resetFit();
            fit();
        }}
    ></iframe>`;
}

// ─── Blocks ───────────────────────────────────────────────────────────────────────

const VIEW_NAMES = { html: "Preview", svg: "Image", diff: "Diff" };

/** An SVG as an image: as an image, it runs no scripts and loads nothing. Tap it to see it full screen. */
function SvgImage({ source }) {
    const [broken, setBroken] = useState(false);

    if (broken) {
        return html`<p class="muted small rich-note">This SVG could not be drawn.</p>`;
    }

    return html`<img
        class="rich-svg"
        alt="SVG image"
        src=${`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`}
        onError=${() => setBroken(true)}
    />`;
}

/**
 * A code block that shows more than code: what it draws (a page, an image, a diff) with its code a tab away. While
 * the reply is still being written it shows the code, as the page or diff is not whole yet. A page's scripts run only
 * on a tap of Run, in the artifacts' sandbox.
 */
function RichBlock({ kind, lang, source, streaming }) {
    const [view, setView] = useState("shown");
    const [running, setRunning] = useState(false);
    const code = streaming || view === "code";
    const colored = useMemo(
        () => (code ? highlight(source, langOf(lang) ?? kind) : ""),
        [code, source, lang, kind],
    );

    // A new version of the page stops the old one running.
    useEffect(() => setRunning(false), [source]);

    const copy = () =>
        copyText(source).then(
            () => notify("info", "Copied."),
            () => notify("error", "Could not copy."),
        );

    let body;

    if (code) {
        body = html`<pre><code dangerouslySetInnerHTML=${{ __html: colored }}></code></pre>`;
    } else if (kind === "html") {
        body = running
            ? html`<${RunFrame} source=${source} />`
            : html`<${HtmlPreview} source=${source} />`;
    } else if (kind === "svg") {
        body = html`<${SvgImage} source=${source} />`;
    } else {
        body = html`<${DiffBlock} text=${source} />`;
    }

    return html`<div class=${`code rich ${kind}`}>
        <div class="code-head">
            <span class="code-lang">${lang || kind}</span>
            ${
                !streaming &&
                html`<span class="rich-tabs" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected=${view === "shown" ? "true" : "false"}
                        class=${view === "shown" ? "on" : ""}
                        onClick=${() => setView("shown")}
                    >
                        ${VIEW_NAMES[kind]}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected=${view === "code" ? "true" : "false"}
                        class=${view === "code" ? "on" : ""}
                        onClick=${() => setView("code")}
                    >
                        Code
                    </button>
                </span>`
            }
            <span class="grow"></span>
            ${
                kind === "html" &&
                !code &&
                html`<button
                    type="button"
                    class=${`rich-run ${running ? "on" : ""}`}
                    title=${running ? "Stop its scripts" : "Run its scripts in a sandbox, as an artifact runs: it can reach the internet, not the app"}
                    onClick=${() => setRunning(!running)}
                >
                    ${running ? "■ Stop" : "▶ Run"}
                </button>`
            }
            <button type="button" class="copy" onClick=${copy}>Copy</button>
        </div>
        ${body}
    </div>`;
}

setRichBlock(RichBlock);

// ─── Code elsewhere ────────────────────────────────────────────────────────────────────

/** Past this size, code shows without colors: coloring it would hold up the conversation. */
const COLOR_LIMIT = 200_000;

/** Code with syntax colors for `lang` (a language, or a path to tell it by), as a `pre` with the class given. */
export function Highlighted({ text, lang, class: className = "" }) {
    const language = langOf(lang ?? "");
    const colored = useMemo(
        () => (language && text.length <= COLOR_LIMIT ? highlight(text, language) : null),
        [text, language],
    );

    return colored === null
        ? html`<pre class=${className}>${text}</pre>`
        : html`<pre class=${className} dangerouslySetInnerHTML=${{ __html: colored }}></pre>`;
}
