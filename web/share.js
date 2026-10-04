// Things shared to Pi Pocket from another app: a link, some text, a screenshot. The service worker keeps them (see
// sw.js), and this sheet puts them into the message box of a session, to send from there.
import { actions, attempt, canSteer, closeSheet, insertIntoComposer, navigate, scoped, store } from "./store.js";
import { html, Icon, Loader, shortPath, Sheet, timeAgo } from "./ui.js";

const SHARE_CACHE = "pocket-share";

/**
 * What was shared under `id`: `{ text, files }`, or null when it is gone. Taking it removes it, with anything an
 * earlier share left behind: one share is picked up at a time, as each opens the app.
 */
export async function takeShare(id) {
	if (!("caches" in globalThis)) return null;
	const cache = await caches.open(SHARE_CACHE);
	const stored = await cache.match(`/share/${id}/meta`);
	if (!stored) return null;
	const meta = await stored.json();
	const files = [];
	for (const [index, file] of meta.files.entries()) {
		const body = await cache.match(`/share/${id}/file/${index}`);
		if (body) files.push(new File([await body.blob()], file.name || `shared-${index + 1}`, { type: file.type }));
	}
	await caches.delete(SHARE_CACHE);
	return { text: shareText(meta), files };
}

/** Apps fill the title, text, and link differently, and often repeat one in another: each part once. */
export function shareText({ title = "", text = "", url = "" }) {
	const parts = [];
	for (const part of [title, text, url].map((each) => each.trim())) {
		if (part === "" || parts.some((kept) => kept.includes(part))) continue;
		// A longer part that holds one kept already replaces it.
		for (let index = parts.length - 1; index >= 0; index--) if (part.includes(parts[index])) parts.splice(index, 1);
		parts.push(part);
	}
	return parts.join("\n\n");
}

/** Where the shared things go: a new session, or one of the recent ones. */
export function ShareSheet({ share }) {
	const { sessions, sessionsLoaded, server } = store.state;
	const recent = sessions.filter((session) => !session.archived).slice(0, 8);
	const deliver = (id) => {
		navigate(id);
		insertIntoComposer(share.text, share.files);
	};
	const startNew = () =>
		attempt(async () => {
			const created = await actions.createSession(recent[0]?.cwd ?? server?.defaultCwd);
			deliver(created.id);
		});
	return html`<${Sheet} title="Share to Pi" onClose=${closeSheet}>
		${share.text && html`<p class="share-text">${share.text}</p>`}
		${share.files.length > 0 && html`<div class="attachments">${share.files.map((file) => html`<span class="chip">📎 ${file.name}</span>`)}</div>`}
		${!canSteer()
			? html`<p class="muted">You can view sessions here but not send to Pi.</p>`
			: html`<p class="muted small">It goes into the message box, so you can add to it before you send.</p>
					${!scoped() && html`<button class="list-item" onClick=${startNew}><span><${Icon} name="plus" size=${15} /> New session</span><span class="muted small mono">${shortPath(recent[0]?.cwd ?? server?.defaultCwd, server?.home)}</span></button>`}
					<div class="group-title">Recent sessions</div>
					${!sessionsLoaded && html`<${Loader} label="Loading sessions" />`}
					${recent.map(
						(session) => html`<button class="list-item" onClick=${() => deliver(session.id)}><span>${session.title ?? "New session"}</span><span class="muted small">${timeAgo(session.updatedAt)}</span></button>`,
					)}`}
	<//>`;
}
