// Shared bits: htm binding, markdown, formatting, icons, the bottom sheet, and small controls (switches, menu rows).

import DOMPurify from "dompurify";
import htm from "htm";
import { marked } from "marked";
import { Component, h } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { highlight, langOf } from "./highlight.js";
import { actions, filesShown, notify, openSheet, store } from "./store.js";

export const html = htm.bind(h);

// ─── Images ──────────────────────────────────────────────────────────────────────

const currentConversation = () => store.state.view.conversation?.id;

/** An image file on the server (absolute, `~/…`, or relative to the session's folder), shown through the app. */
export const fileUrl = (path, conversationId = currentConversation()) =>
    `/api/c/${conversationId}/file?path=${encodeURIComponent(path)}`;

/** The `index`th image stored in a message: a pasted image or one a tool returned. */
export const entryImageUrl = (entryId, index, conversationId = currentConversation()) =>
    `/api/c/${conversationId}/image/${entryId}/${index}`;

/** Where the browser loads `![alt](src)` from. Web and data URLs stay; paths and file:// URLs point at the server. */
function imageSource(src, conversationId) {
    const value = String(src ?? "").trim();

    if (value === "" || conversationId === undefined || conversationId === null) {
        return value;
    }

    if (value.startsWith("/api/") || value.startsWith("/a/")) {
        return value;
    }

    const file = /^file:\/\//i.test(value);
    // A Windows path (C:\shot.png) is not a URL scheme.
    const drive = /^[a-z]:[\\/]/i.test(value);

    if (!file && !drive && /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) {
        return value;
    }

    // file:///C:/shot.png names C:/shot.png.
    let path = file
        ? value.replace(/^file:\/\/(localhost)?/i, "").replace(/^\/([a-z]:)/i, "$1")
        : value;

    try {
        path = decodeURIComponent(path);
    } catch {
        // keep it as written
    }

    return fileUrl(path, conversationId);
}

/** A tappable image thumbnail that opens full screen, or a chip when the image cannot load. */
export function Thumb({ src, alt = "image" }) {
    const [broken, setBroken] = useState(false);

    if (broken) {
        return html`<span class="chip" title="This image could not be loaded">🖼 ${alt}</span>`;
    }

    return html`<button
        class="thumb"
        type="button"
        onClick=${() => openSheet({ type: "image", src, alt })}
    >
        <img
            src=${src}
            alt=${alt}
            loading="lazy"
            decoding="async"
            onError=${() => setBroken(true)}
        />
    </button>`;
}

// ─── Markdown ──────────────────────────────────────────────────────────────────

marked.setOptions({ gfm: true, breaks: false });

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text as HTML that shows it as written. */
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** A fence's language as it may be kept: a short name of safe characters, or nothing. */
const FENCE_NAME = /^[\w+#.-]{1,24}$/;

marked.use({
    renderer: {
        // Task list boxes as characters: the sanitizer drops form controls.
        checkbox: ({ checked }) => (checked ? "☑ " : "☐ "),
        // A code block keeps its language as data (the sanitizer drops classes), for colors and a label.
        code({ text, lang, escaped }) {
            const name = (lang ?? "").trim().split(/\s+/)[0];
            const attribute = FENCE_NAME.test(name) ? ` data-lang="${name}"` : "";

            return `<pre${attribute}><code>${escaped ? text : escapeHtml(text)}</code></pre>\n`;
        },
    },
});

/**
 * Replies are untrusted: a file or page Pi read can steer what it writes. No forms or controls, no media that loads by
 * itself, and no style, class, or id hooks that could lay a fake screen over the app.
 */
const PURIFY = {
    FORBID_TAGS: [
        "form",
        "input",
        "button",
        "select",
        "textarea",
        "dialog",
        "style",
        "audio",
        "video",
        "source",
        "track",
        "picture",
    ],
    // `data-path` is the app's own mark for file paths (`sanitize`): a reply may not set it.
    FORBID_ATTR: [
        "style",
        "class",
        "id",
        "srcset",
        "background",
        "poster",
        "action",
        "formaction",
        "data-path",
    ],
    RETURN_DOM_FRAGMENT: true,
};

/** Images the app serves for a conversation (files, stored images, artifacts), or inline data. Nothing else loads. */
const localImage = (src) =>
    /^\/api\/c\/\d+\/(file\?|image\/)/.test(src) ||
    /^\/a\/\d+\//.test(src) ||
    /^data:image\//i.test(src);

/** Code blocks past this size show without colors: coloring them would hold up the conversation. */
export const COLOR_LIMIT = 200_000;
/** Code blocks longer than this many lines fold to their first lines, once they are written whole. */
const LONG_CODE = 40;

/**
 * What a code block shows besides its code, if anything: `html` (a page, previewed), `svg` (an image), or `diff`. Its
 * fence names it; a page or an image without a name is known by how it starts.
 */
function richKind(name, source) {
    const lang = name.toLowerCase();

    if (lang === "html" || lang === "htm" || lang === "xhtml") {
        return "html";
    }

    if (lang === "diff" || lang === "patch") {
        return "diff";
    }

    if (
        lang === "svg" ||
        ((lang === "xml" || lang === "") && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(source))
    ) {
        return "svg";
    }

    if (lang === "" && /^\s*(<!doctype html|<html[\s>])/i.test(source)) {
        return "html";
    }

    return undefined;
}

/**
 * A code block as the app draws it: its language and a copy button above it (or the button alone, over it), its code
 * colored, and a long one folded. A block that shows something besides its code is marked with its kind for
 * `markdownParts`.
 */
function codeBlock(pre, fold) {
    const source = pre.textContent ?? "";
    const name = FENCE_NAME.test(pre.dataset.lang ?? "") ? pre.dataset.lang : "";
    const lang = langOf(name);
    const code = pre.querySelector("code") ?? pre;
    const wrap = document.createElement("div");
    const copy = document.createElement("button");
    const kind = richKind(name, source);

    // The highlighter's output is the source, escaped, in spans of its own: nothing from the reply becomes markup.
    if (lang && source.length <= COLOR_LIMIT) {
        code.innerHTML = highlight(source, lang);
    }

    wrap.className = "code";
    copy.className = "copy";
    copy.type = "button";
    copy.dataset.copy = "";
    copy.textContent = "Copy";
    pre.replaceWith(wrap);

    if (kind) {
        wrap.dataset.kind = kind;
        wrap.dataset.lang = name;
    }

    if (name) {
        const head = document.createElement("div");
        const label = document.createElement("span");

        head.className = "code-head";
        label.className = "code-lang";
        label.textContent = name;
        head.append(label, copy);
        wrap.append(head, pre);
    } else {
        wrap.append(copy, pre);
    }

    const lines = source.split("\n").length;

    if (fold && lines > LONG_CODE) {
        const more = document.createElement("button");

        wrap.classList.add("long");
        more.className = "code-more";
        more.type = "button";
        more.dataset.more = "";
        more.textContent = `Show all ${lines} lines`;
        wrap.append(more);
    }
}

/**
 * Sanitized HTML, changed only through the DOM afterwards: editing the sanitized string could turn text inside an
 * attribute into markup. An image from another site becomes a link, since its address could carry data out the moment
 * it loads, and code blocks are drawn by `codeBlock` (folded when long, if `fold`). Returns the element holding it.
 */
function sanitize(html, fold) {
    const fragment = DOMPurify.sanitize(html, PURIFY);

    // `src/app.ts` in a reply opens the file: inline code that is a path, not code blocks.
    for (const code of fragment.querySelectorAll("code")) {
        if (!code.closest("pre, a") && looksLikePath(code.textContent ?? "")) {
            code.dataset.path = code.textContent;
        }
    }

    for (const pre of fragment.querySelectorAll("pre")) {
        codeBlock(pre, fold);
    }

    for (const image of fragment.querySelectorAll("img")) {
        const src = image.getAttribute("src") ?? "";

        if (localImage(src)) {
            continue;
        }

        const label = `🖼 ${image.getAttribute("alt") || "image"}`;
        let host;

        try {
            host = /^https?:\/\//i.test(src) ? new URL(src).host : undefined;
        } catch {
            host = undefined;
        }

        // Inside a link already, or not a web address: the label alone.
        if (host === undefined || image.closest("a")) {
            image.replaceWith(label);
            continue;
        }

        const link = document.createElement("a");

        link.href = src;
        link.textContent = label;
        link.title = `Image from ${host}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        image.replaceWith(link);
    }

    const holder = document.createElement("div");

    holder.append(fragment);

    return holder;
}

/**
 * The parts of rendered markdown: runs of HTML, and between them the top-level code blocks that show more than code
 * (`{ kind, lang, source, html }`), for `Markdown` to draw with the component `setRichBlock` gave it.
 */
function partsOf(holder) {
    const parts = [];
    let run = "";

    for (const node of holder.childNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && node.matches(".code[data-kind]")) {
            if (run.trim() !== "") {
                parts.push({ html: run });
            }

            run = "";
            parts.push({
                kind: node.dataset.kind,
                lang: node.dataset.lang,
                source: node.querySelector("pre")?.textContent ?? "",
                html: node.outerHTML,
            });
            continue;
        }

        run +=
            node.nodeType === Node.ELEMENT_NODE
                ? node.outerHTML
                : escapeHtml(node.textContent ?? "");
    }

    if (run.trim() !== "" || parts.length === 0) {
        parts.push({ html: run });
    }

    return parts;
}

/** A reply that is a whole HTML page, not in a code block: shown as one, so it can be previewed rather than mangled. */
function fencePage(text) {
    if (!/^\s*(<!doctype html|<html[\s>])/i.test(text)) {
        return text;
    }

    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
    const fence = "`".repeat(longest + 1);

    return `${fence}html\n${text.trim()}\n${fence}`;
}

/** The conversation whose markdown is being sanitized, for image paths relative to its folder. */
let rendering = null;

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    // Before the URL check, so file:// and plain paths become app URLs instead of being dropped.
    if (node.nodeName === "IMG" && data.attrName === "src") {
        data.attrValue = imageSource(data.attrValue, rendering);
    }
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
    } else if (node.tagName === "IMG") {
        node.setAttribute("loading", "lazy");
        node.setAttribute("decoding", "async");
    }
});

const markdownCache = new Map();

const MARKDOWN_CACHE = 500;

/**
 * Markdown as sanitized parts (`partsOf`). Cached, least recently used out first: a transcript renders its rows in
 * order, and evicting the oldest insert would miss on every row once a thread outgrew the cache. Text still changing
 * (`cache` false) is not kept, and its long code blocks are not folded while they grow.
 */
function markdownParts(text, conversationId = currentConversation(), cache = true) {
    const key = `${conversationId ?? ""}\u0000${text}`;
    let out = markdownCache.get(key);

    if (out !== undefined) {
        markdownCache.delete(key);
        markdownCache.set(key, out);

        return out;
    }

    rendering = conversationId ?? null;
    out = partsOf(sanitize(marked.parse(fencePage(text), { async: false }), cache));
    rendering = null;

    if (cache) {
        if (markdownCache.size >= MARKDOWN_CACHE) {
            markdownCache.delete(markdownCache.keys().next().value);
        }

        markdownCache.set(key, out);
    }

    return out;
}

/** What draws a code block that shows more than code (`rich.js`), given once at load: ui.js does not import it. */
let RichBlock = null;

export function setRichBlock(component) {
    RichBlock = component;
}

/**
 * Rendered markdown. `cache={false}` for text that is still changing, such as a streaming answer: its pages, images, and
 * diffs show as code until it is whole.
 */
export function Markdown({ text, class: className = "", cache = true }) {
    const parts = markdownParts(text, undefined, cache);

    if (parts.length === 1 && parts[0].kind === undefined) {
        return html`<div
            class=${`md ${className}`}
            dangerouslySetInnerHTML=${{ __html: parts[0].html }}
        ></div>`;
    }

    return html`<div class=${`md ${className}`}>
        ${parts.map((part, index) =>
            part.kind === undefined || RichBlock === null
                ? html`<div
                      key=${index}
                      class="md-part"
                      dangerouslySetInnerHTML=${{ __html: part.html }}
                  ></div>`
                : html`<${RichBlock} key=${index} ...${part} streaming=${!cache} />`,
        )}
    </div>`;
}

/** File types common enough that `name.ext` alone is surely a file, not code like `store.state`. */
const FILE_TYPES = new Set(
    "ts tsx js jsx mjs cjs json jsonc md mdx txt css scss html htm py rs go java kt rb php cs c h cc cpp hpp swift sh bash zsh fish yml yaml toml ini cfg conf env lock sql xml svg png jpg jpeg gif webp pdf vue svelte astro lua zig dart ex exs erl hs ml nix gradle csv log diff patch".split(
        " ",
    ),
);

/**
 * Whether inline code names a file: `src/app.ts`, `./run.sh`, `~/notes.md`, `app.ts:42`, `package.json`. A path with
 * folders needs an extension of some kind; a bare name needs a common one.
 */
function looksLikePath(text) {
    if (text.length > 300) {
        return false;
    }

    // Anchored at home, the top, or here: `~/.bashrc`, `/etc/hosts`, `./run`.
    if (
        /^(?:~|\.{1,2}|)\/[\w@.+-]+(?:\/[\w@.+-]+)*(?::\d+(?:-\d+)?)?$/.test(text) &&
        text !== "/"
    ) {
        return true;
    }

    if (/^(?:Makefile|Dockerfile|LICENSE|\.gitignore|\.env(?:\.\w+)?)$/.test(text)) {
        return true;
    }

    const match =
        /^((?:[\w@.+-]+\/)*)([\w@+-][\w@.+-]*\.([A-Za-z0-9]{1,10}))(?::\d+(?:-\d+)?)?$/.exec(text);

    return match !== null && (match[1] !== "" || FILE_TYPES.has(match[3].toLowerCase()));
}

/**
 * Open a file (or folder) of the session in the viewer: in the Files tile while it is open, otherwise in a sheet.
 * `path:42` opens it at line 42.
 */
export function openFile(path) {
    const match = /^(.*?):(\d+)(?:-\d+)?$/.exec(path);
    const target = { path: match ? match[1] : path, line: match ? Number(match[2]) : undefined };

    if (filesShown()) {
        store.set((state) => ({
            sheet: null,
            filesTab: "files",
            filesTarget: { ...target, n: (state.filesTarget?.n ?? 0) + 1 },
        }));

        return;
    }

    openSheet({ type: "file", id: target.path, line: target.line });
}

/** File paths in rendered markdown open in the viewer. */
document.addEventListener("click", (event) => {
    const code = event.target.closest?.(".md code[data-path]");

    if (!code || getSelection()?.toString()) {
        return;
    }

    event.stopPropagation();
    openFile(code.dataset.path);
});

/** Images in rendered markdown open full screen, unless they are links. */
document.addEventListener("click", (event) => {
    const image = event.target.closest?.(".md img");

    if (!image || image.closest("a") || image.classList.contains("broken")) {
        return;
    }

    openSheet({ type: "image", src: image.currentSrc || image.src, alt: image.alt });
});

/** A markdown image that cannot load says so instead of showing a broken icon. */
document.addEventListener(
    "error",
    (event) => {
        const image = event.target;

        if (
            image?.tagName !== "IMG" ||
            !image.closest(".md") ||
            image.classList.contains("broken")
        ) {
            return;
        }

        image.classList.add("broken");
        const note = document.createElement("span");

        note.className = "image-missing";
        note.textContent = `🖼 ${image.alt || "Image"} could not be loaded`;
        image.after(note);
    },
    true,
);

/** Copy buttons inside rendered markdown, handled once for the whole page. */
document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-copy]");

    if (!button) {
        return;
    }

    const pre = button.closest(".code")?.querySelector("pre");

    copyText(pre?.innerText ?? "").then(
        () => {
            button.textContent = "Copied";
            setTimeout(() => (button.textContent = "Copy"), 1200);
        },
        () => notify("error", "Could not copy."),
    );
});

/** A long code block's button shows all of it, and folds it again. */
document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-more]");
    const block = button?.closest(".code");

    if (!block) {
        return;
    }

    const open = block.classList.toggle("open");

    button.textContent = open
        ? "Fold"
        : `Show all ${block.querySelector("pre")?.textContent.split("\n").length ?? ""} lines`;
});

/** Copy text, with a fallback for plain-http addresses, where the clipboard API does not exist. */
export async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text);
    }

    const area = document.createElement("textarea");

    area.value = text;
    area.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");

    area.remove();

    if (!ok) {
        throw new Error("Could not copy.");
    }
}

export function formatTokens(count) {
    if (count === undefined || count === null) {
        return "?";
    }

    if (count >= 1_000_000) {
        return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
    }

    if (count >= 1000) {
        return `${Math.round(count / 1000)}k`;
    }

    return String(count);
}

export function formatBytes(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A time ahead, on this device's clock: "14:30" today, "Mon 09:00" this week, "Oct 20 09:00" later. */
export function formatWhen(ms) {
    const at = new Date(ms);
    const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    if (at.toDateString() === new Date().toDateString()) {
        return time;
    }

    const day =
        ms - Date.now() < 6 * 86_400_000
            ? at.toLocaleDateString([], { weekday: "short" })
            : at.toLocaleDateString([], { month: "short", day: "numeric" });

    return `${day} ${time}`;
}

export function timeAgo(ms) {
    const seconds = Math.max(0, (Date.now() - ms) / 1000);

    if (seconds < 45) {
        return "now";
    }

    if (seconds < 3600) {
        return `${Math.round(seconds / 60)}m`;
    }

    if (seconds < 86400) {
        return `${Math.round(seconds / 3600)}h`;
    }

    if (seconds < 86400 * 30) {
        return `${Math.round(seconds / 86400)}d`;
    }

    return new Date(ms).toLocaleDateString();
}

/** Markdown as plain text, for one-line previews such as a quote: no emphasis, code ticks, or markers. */
export function plainText(markdown) {
    return String(markdown ?? "")
        .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/gm, "$1$2")
        .replace(/^[ \t]{0,3}(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+\.[ \t]+)/gm, "");
}

/** What separates a message to Pi from the list of files attached to it, which the server adds. */
export const ATTACHMENTS_HEADING = "\n\nAttached files (saved on the server):\n";

/** What a person wrote in a message to Pi, without the list of attached files. */
export function writtenText(entry) {
    return entry.text.split(ATTACHMENTS_HEADING)[0];
}

/** What Pi wrote in a reply: its text blocks, without thinking or tool calls. */
export function replyText(entry) {
    return entry.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** `~/x` for paths under home. */
export function shortPath(path, home) {
    if (!path) {
        return "";
    }

    if (home && (path === home || path.startsWith(`${home}/`))) {
        return `~${path.slice(home.length)}`;
    }

    return path;
}

const ICONS = {
    menu: "M3 6h18M3 12h18M3 18h18",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    close: "M6 6l12 12M18 6L6 18",
    send: "M12 19V5M5 12l7-7 7 7",
    stop: "M7 7h10v10H7z",
    clip: "M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9",
    plus: "M12 5v14M5 12h14",
    artifact: "M4 5h16v14H4zM4 9h16M8 5v4",
    folder: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z",
    file: "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5",
    back: "M15 18l-6-6 6-6",
    chevron: "M9 6l6 6-6 6",
    down: "M6 9l6 6 6-6",
    search: "M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3",
    shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
    external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5",
    key: "M15 7a4 4 0 11-3.9 4.9L3 20v-3h3v-3h3l1.1-1.1A4 4 0 0115 7z",
    users: "M16 20v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 11a4 4 0 100-8 4 4 0 000 8zM22 20v-1a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8",
    sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
    chat: "M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z",
    fork: "M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9",
    command: "M9 6a3 3 0 10-3 3h12a3 3 0 10-3-3v12a3 3 0 103-3H6a3 3 0 103 3z",
    sidebar: "M4 4h16v16H4zM9 4v16",
    tiles: "M3 5h12v14H3zM17 5h4v6h-4zM17 13h4v6h-4z",
    pin: "M9 4h6M10 4v6l-3 4h10l-3-4V4M12 14v6",
    palette:
        "M12 3a9 9 0 100 18c1 0 1.5-.8 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 005-5c0-4.4-4-7.8-9-7.8zM7.5 12.5h.01M9.5 8h.01M14.5 8h.01M17 11.5h.01",
    pulse: "M3 12h4l2-6 4 12 2-6h6",
    keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
    swatch: "M4 4h7v16H4zM11 9l6-4 3 5-9 6M11 16h9v4h-9",
    home: "M3 11l9-7 9 7M5 10v10h14V10",
    archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
    unarchive: "M3 4h18v4H3zM5 8v12h14V8M12 18v-6M9 15l3-3 3 3",
    check: "M5 12l5 5L20 7",
    logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
    globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3.5 9h17M3.5 15h17M12 3a14 14 0 010 18M12 3a14 14 0 000 18",
    reload: "M20 12a8 8 0 11-2.3-5.7M20 4v5h-5",
    phone: "M8 3h8a1 1 0 011 1v16a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1zM11 18h2",
    tablet: "M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM11 17h2",
    monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
    terminal: "M4 5h16v14H4zM8 10l2 2-2 2M12 14h4",
    fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
};

/** Text with the letters at `hits` (indexes) marked, as matches of what someone searched for. */
export function Marked({ text, hits }) {
    if (!hits || hits.length === 0) {
        return text;
    }

    const set = new Set(hits);
    const parts = [];
    let run = "";
    let lit = false;

    for (let index = 0; index < text.length; index++) {
        const on = set.has(index);

        if (on !== lit && run !== "") {
            parts.push(lit ? html`<mark>${run}</mark>` : run);
            run = "";
        }

        lit = on;
        run += text[index];
    }

    if (run !== "") {
        parts.push(lit ? html`<mark>${run}</mark>` : run);
    }

    return parts;
}

export function Icon({ name, size = 20, class: className = "" }) {
    return html`<svg
        class=${`icon ${className}`}
        width=${size}
        height=${size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    >
        <path d=${ICONS[name] ?? ""} />
    </svg>`;
}

/**
 * The app's loaders, after Omarchy's: a quadrant block that steps around a square like a terminal spinner, a flat bar
 * that eases toward 70% the way Omarchy's boot screen does while it waits, and a sweep of square cells for "thinking".
 */
export function Spinner({ label = "Working" }) {
    return html`<span class="spinner" role="img" aria-label=${label}></span>`;
}

/** A spinner with a short line about what is loading, for sheets and panels. */
export function Loader({ label = "Loading" }) {
    return html`<div class="loader" role="status">
        <${Spinner} label=${label} />
        <span>${label}…</span>
    </div>`;
}

/** The full-screen loader: π over Omarchy's boot bar, and what is happening under it. */
export function Boot({ caption = "starting", detail = "", inline = false }) {
    return html`<div class=${`boot ${inline ? "inline" : ""}`} role="status" aria-live="polite">
        <div class="boot-mark" aria-hidden="true">π</div>
        <div class="boot-bar" aria-hidden="true"><span></span></div>
        <div class="boot-caption">${caption}</div>
        ${detail && html`<div class="boot-detail">${detail}</div>`}
    </div>`;
}

/** Pi is working on an answer: a block sweeping across square cells. */
export function Thinking() {
    return html`<div class="thinking" role="status" aria-label="Pi is thinking">
        <span></span>
        <span></span>
        <span></span>
        <span></span>
        <span></span>
        <span></span>
        <span></span>
        <span></span>
    </div>`;
}

/**
 * Keep showing a value for `ms` after it goes away (null or undefined), so what it shows can animate out. Returns the
 * value to show and whether it is leaving.
 */
export function usePresence(value, ms = 200) {
    const [kept, setKept] = useState(value ?? null);
    const [leaving, setLeaving] = useState(false);
    const timer = useRef(0);

    useEffect(() => {
        clearTimeout(timer.current);

        if (value !== null && value !== undefined) {
            setKept(value);
            setLeaving(false);
        } else if (kept !== null) {
            if (document.documentElement.dataset.motion === "reduced") {
                setKept(null);

                return;
            }

            setLeaving(true);
            timer.current = setTimeout(() => {
                setKept(null);
                setLeaving(false);
            }, ms);
        }
    }, [value]);
    useEffect(() => () => clearTimeout(timer.current), []);

    return value !== null && value !== undefined
        ? [value, false]
        : [kept, leaving || kept !== null];
}

/**
 * Where a sliding indicator goes: the offset and size of the element matching `selector` inside `ref`, measured after
 * every render. null when there is none, or it is in a folded group. `instant` is true the first time it shows, so it
 * appears in place instead of sliding in from the top.
 */
export function useSlide(ref, selector, axis = "y") {
    const [box, setBox] = useState(null);
    const hidden = useRef(true);

    const measure = () => {
        const target = ref.current?.querySelector(selector);
        const next =
            target && !target.closest(".closed")
                ? axis === "y"
                    ? { at: target.offsetTop, size: target.offsetHeight }
                    : { at: target.offsetLeft, size: target.offsetWidth }
                : null;

        setBox((box) => (next?.at === box?.at && next?.size === box?.size ? box : next));
    };

    useLayoutEffect(measure);
    // Rows move without a render while a group folds, or the window resizes: measure again when they settle.
    useEffect(() => {
        const host = ref.current;

        if (!host) {
            return;
        }

        const settle = (event) => event.target !== host && measure();

        host.addEventListener("transitionend", settle);
        const observer =
            typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;

        observer?.observe(host);

        return () => {
            host.removeEventListener("transitionend", settle);
            observer?.disconnect();
        };
    }, [ref.current]);
    const instant = hidden.current;

    useEffect(() => {
        hidden.current = box === null;
    });

    return box === null ? null : { ...box, instant };
}

/** The bar a `useSlide` box draws. */
export function Slide({ box, axis = "y" }) {
    if (!box) {
        return null;
    }

    const style =
        axis === "y"
            ? `transform:translateY(${box.at}px);height:${box.size}px`
            : `transform:translateX(${box.at}px);width:${box.size}px`;

    return html`<span
        class=${`slide-${axis} ${box.instant ? "instant" : ""}`}
        style=${style}
        aria-hidden="true"
    ></span>`;
}

/** Keys as they are on this device: ⌘ on Apple keyboards, Ctrl elsewhere. */
export const APPLE = /Mac|iPhone|iPad/.test(navigator.platform ?? "");

const MOD = APPLE ? "⌘" : "Ctrl";

/** A keyboard shortcut as key caps: `Keys keys="Mod K"`. */
export function Keys({ keys }) {
    return keys.split(" ").map((key) => html`<kbd>${key === "Mod" ? MOD : key}</kbd>`);
}

/**
 * Something inside failed to render: show nothing there instead of taking the whole app down. A new `reset` value (the
 * sheet opened again) tries again.
 */
export class Boundary extends Component {
    state = { failed: false };

    componentDidCatch(error) {
        console.error(error);
        this.setState({ failed: true });
    }

    componentDidUpdate(previous) {
        if (this.state.failed && previous.reset !== this.props.reset) {
            this.setState({ failed: false });
        }
    }

    render({ children }, { failed }) {
        return failed ? null : children;
    }
}

/** A bottom sheet on phones, a centered dialog on wide screens. */
export function Sheet({ title, onClose, children, wide = false, actions = null }) {
    const ref = useRef(null);

    useEffect(() => {
        const onKey = (event) => event.key === "Escape" && onClose();

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [onClose]);
    // Keys go to the sheet, not the message box behind it, unless something inside already took focus.
    useEffect(() => {
        if (ref.current && !ref.current.contains(document.activeElement)) {
            ref.current.focus({ preventScroll: true });
        }
    }, []);

    return html`<div
        class="overlay"
        onClick=${(event) => event.target === event.currentTarget && onClose()}
    >
        <section
            class=${`sheet ${wide ? "wide" : ""}`}
            ref=${ref}
            role="dialog"
            aria-modal="true"
            aria-label=${title}
            tabindex="-1"
        >
            <header class="sheet-head">
                <div class="grip"></div>
                <h2>${title}</h2>
                ${actions}
                <button class="icon-button" onClick=${onClose} aria-label="Close">
                    <${Icon} name="close" />
                </button>
            </header>
            <div class="sheet-body">${children}</div>
        </section>
    </div>`;
}

/**
 * Where a menu opens from the control `selector` names: above it and aligned with it, within what shows of the page (a
 * phone's keyboard can cover it), and as tall as its rows need up to a menu's height. Null, for the middle of the
 * screen, when the control is gone or scrolled away, or has too little room above it.
 */
export function popAnchor(selector) {
    const rect = document.querySelector(selector)?.getBoundingClientRect();

    if (!rect || rect.width === 0) {
        return null;
    }

    const top = visualViewport?.offsetTop ?? 0;
    const bottom = top + (visualViewport?.height ?? innerHeight);
    const at = Math.min(rect.top, bottom - 8);
    const room = at - top - 14;

    if (rect.bottom < top || room < 220) {
        return null;
    }

    const width = Math.min(420, innerWidth - 16);

    return {
        left: Math.max(8, Math.min(rect.left, innerWidth - width - 8)),
        bottom: innerHeight - at + 6,
        width,
        height: Math.min(540, room),
    };
}

/** A `popAnchor` as a menu's style: nothing for the middle of the screen. */
export const anchorStyle = (anchor) =>
    anchor
        ? `left:${anchor.left}px;bottom:${anchor.bottom}px;width:${anchor.width}px;max-height:${anchor.height}px`
        : "";

/** The short name of a model for chips: "Claude Opus 5.5" stays, long ids lose their date suffix. */
export function modelLabel(agent) {
    if (!agent?.model) {
        return "No model";
    }

    return agent.modelName ?? agent.model.modelId.replace(/-\d{8}$/, "");
}

/** An on and off switch, named for screen readers by `label`. */
export function Switch({ on, disabled, label, onChange }) {
    return html`<button
        type="button"
        role="switch"
        aria-checked=${on ? "true" : "false"}
        aria-label=${label}
        class=${`switch ${on ? "on" : ""}`}
        disabled=${disabled}
        onClick=${onChange}
    >
        <span></span>
    </button>`;
}

/** A row in a menu: a label, an optional hint on the right, and what a tap does. */
export function item(label, run, hint) {
    return html`<button class="list-item" onClick=${run}>
        <span>${label}</span>
        ${hint && html`<span class="muted small">${hint}</span>`}
    </button>`;
}
