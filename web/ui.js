// Shared bits: htm binding, markdown, formatting, icons, and the bottom sheet.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { openSheet, store } from "./store.js";

export const html = htm.bind(h);

// ─── Images ──────────────────────────────────────────────────────────────────────

const currentConversation = () => store.state.view.conversation?.id;

/** An image file on the server (absolute, `~/…`, or relative to the session's folder), shown through the app. */
export const fileUrl = (path, conversationId = currentConversation()) => `/api/c/${conversationId}/file?path=${encodeURIComponent(path)}`;

/** The `index`th image stored in a message: a pasted image or one a tool returned. */
export const entryImageUrl = (entryId, index, conversationId = currentConversation()) => `/api/c/${conversationId}/image/${entryId}/${index}`;

/** Where the browser loads `![alt](src)` from. Web and data URLs stay; paths and file:// URLs point at the server. */
export function imageSource(src, conversationId) {
	const value = String(src ?? "").trim();
	if (value === "" || conversationId === undefined || conversationId === null) return value;
	if (value.startsWith("/api/") || value.startsWith("/a/")) return value;
	const file = /^file:\/\//i.test(value);
	if (!file && /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return value;
	let path = file ? value.replace(/^file:\/\/(localhost)?/i, "") : value;
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
	if (broken) return html`<span class="chip" title="This image could not be loaded">🖼 ${alt}</span>`;
	return html`<button class="thumb" type="button" onClick=${() => openSheet({ type: "image", src, alt })}>
		<img src=${src} alt=${alt} loading="lazy" decoding="async" onError=${() => setBroken(true)} />
	</button>`;
}

// ─── Markdown ──────────────────────────────────────────────────────────────────

marked.setOptions({ gfm: true, breaks: false });

/** The conversation whose markdown is being sanitized, for image paths relative to its folder. */
let rendering = null;

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
	// Before the URL check, so file:// and plain paths become app URLs instead of being dropped.
	if (node.nodeName === "IMG" && data.attrName === "src") data.attrValue = imageSource(data.attrValue, rendering);
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

/** Markdown to sanitized HTML, with copy buttons on code blocks. Cached: streaming re-renders the same text often. */
export function markdown(text, conversationId = currentConversation()) {
	const key = `${conversationId ?? ""}\u0000${text}`;
	let out = markdownCache.get(key);
	if (out === undefined) {
		rendering = conversationId ?? null;
		const clean = DOMPurify.sanitize(marked.parse(text, { async: false }));
		rendering = null;
		out = clean.replaceAll("<pre>", '<div class="code"><button class="copy" data-copy type="button">Copy</button><pre>').replaceAll("</pre>", "</pre></div>");
		if (markdownCache.size > 400) markdownCache.delete(markdownCache.keys().next().value);
		markdownCache.set(key, out);
	}
	return out;
}

export function Markdown({ text, class: className = "" }) {
	return html`<div class=${`md ${className}`} dangerouslySetInnerHTML=${{ __html: markdown(text) }}></div>`;
}

/** Images in rendered markdown open full screen, unless they are links. */
document.addEventListener("click", (event) => {
	const image = event.target.closest?.(".md img");
	if (!image || image.closest("a") || image.classList.contains("broken")) return;
	openSheet({ type: "image", src: image.currentSrc || image.src, alt: image.alt });
});

/** A markdown image that cannot load says so instead of showing a broken icon. */
document.addEventListener(
	"error",
	(event) => {
		const image = event.target;
		if (image?.tagName !== "IMG" || !image.closest(".md") || image.classList.contains("broken")) return;
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
	if (!button) return;
	const pre = button.parentElement.querySelector("pre");
	navigator.clipboard?.writeText(pre?.innerText ?? "").then(() => {
		button.textContent = "Copied";
		setTimeout(() => (button.textContent = "Copy"), 1200);
	});
});

export function formatTokens(count) {
	if (count === undefined || count === null) return "?";
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
	if (count >= 1000) return `${Math.round(count / 1000)}k`;
	return String(count);
}

export function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(ms) {
	const seconds = Math.max(0, (Date.now() - ms) / 1000);
	if (seconds < 45) return "now";
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
	if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)}d`;
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

/** `~/x` for paths under home. */
export function shortPath(path, home) {
	if (!path) return "";
	if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
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
};

export function Icon({ name, size = 20, class: className = "" }) {
	return html`<svg class=${`icon ${className}`} width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${ICONS[name] ?? ""} /></svg>`;
}

export function Spinner() {
	return html`<span class="spinner" aria-label="working"></span>`;
}

/** A bottom sheet on phones, a centered dialog on wide screens. */
export function Sheet({ title, onClose, children, wide = false, actions = null }) {
	const ref = useRef(null);
	useEffect(() => {
		const onKey = (event) => event.key === "Escape" && onClose();
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [onClose]);
	return html`<div class="overlay" onClick=${(event) => event.target === event.currentTarget && onClose()}>
		<section class=${`sheet ${wide ? "wide" : ""}`} ref=${ref} role="dialog" aria-label=${title}>
			<header class="sheet-head">
				<div class="grip"></div>
				<h2>${title}</h2>
				${actions}
				<button class="icon-button" onClick=${onClose} aria-label="Close"><${Icon} name="close" /></button>
			</header>
			<div class="sheet-body">${children}</div>
		</section>
	</div>`;
}

/** The short name of a model for chips: "Claude Opus 5.5" stays, long ids lose their date suffix. */
export function modelLabel(agent) {
	if (!agent?.model) return "No model";
	return agent.modelName ?? agent.model.modelId.replace(/-\d{8}$/, "");
}
