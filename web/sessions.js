// Session list (drawer and home screen) and the sign-in screen.
import { useState } from "preact/hooks";
import { Avatar } from "./chat.js";
import { canSteer, collab, navigate, openSheet, scoped, sessionUnread, store } from "./store.js";
import { html, Icon, shortPath, timeAgo } from "./ui.js";

/** The session list on its way: rows shaped like sessions, lit in turn. */
function LoadingSessions() {
	return html`<div role="status" aria-label="Loading sessions">
		${[72, 54, 64, 46, 58].map(
			(width, index) => html`<div class="session-placeholder" aria-hidden="true" style=${`--width: ${width}%; --delay: ${index * 0.12}s`}><span></span><span></span></div>`,
		)}
	</div>`;
}

export function SessionList({ compact = false }) {
	const { sessions, sessionsLoaded, conversationId, server, me } = store.state;
	const canStart = canSteer() && !scoped();
	const [query, setQuery] = useState("");
	const [archived, setArchived] = useState(false);
	const needle = query.trim().toLowerCase();
	const shown = sessions.filter(
		(session) =>
			Boolean(session.archived) === archived &&
			(needle === "" || `${session.title ?? ""} ${session.cwd} ${session.model ?? ""}`.toLowerCase().includes(needle)),
	);
	return html`<div class=${`sessions ${compact ? "compact" : ""}`}>
		<div class="sessions-head">
			<span class="brand">π <span>Pocket</span></span>
			${canStart && html`<button class="button primary small" onClick=${() => openSheet({ type: "cwd", mode: "new" })}><${Icon} name="plus" size=${16} /> New</button>`}
		</div>
		<label class="search"><${Icon} name="search" size=${16} /><input placeholder="Search sessions" value=${query} onInput=${(event) => setQuery(event.currentTarget.value)} /></label>
		<div class="session-items">
			${!sessionsLoaded && html`<${LoadingSessions} />`}
			${sessionsLoaded && shown.length === 0 && html`<div class="muted pad">${archived ? "No archived sessions." : needle ? "No matches." : "No sessions yet. Start one with New."}</div>`}
			${shown.map(
				(session) => html`<button class=${`session ${session.id === conversationId ? "active" : ""}`} onClick=${() => navigate(session.id)}>
					<div class="session-title">${session.title ?? "New session"}</div>
					<div class="session-meta">
						<span class="mono">${shortPath(session.cwd, server?.home)}</span>
						${session.model && html`<span class="mono">${session.model}</span>`}
					</div>
					<div class="session-side">
						${session.waiting ? html`<span class="badge warn" title="Waiting for approval">!</span>` : session.busy ? html`<span class="pulse" title="Working"></span>` : null}
						${collab() && sessionUnread(session) && html`<span class="unread-dot" title="New chat messages"></span>`}
						<span class="muted small">${timeAgo(session.updatedAt)}</span>
					</div>
					${collab() && session.people?.length > 0 &&
					html`<div class="session-people">${session.people.filter((person) => person.id !== me?.id).slice(0, 4).map((person) => html`<${Avatar} key=${person.id} person=${person} size=${18} />`)}</div>`}
				</button>`,
			)}
		</div>
		<div class="sessions-foot">
			<button class="foot-item" onClick=${() => setArchived(!archived)}>${archived ? "← Active sessions" : "Archived"}</button>
			<button class="foot-item" onClick=${() => openSheet({ type: "running" })}>Running now</button>
			<button class="foot-item" onClick=${() => openSheet({ type: "providers" })}><${Icon} name="key" size=${16} /> Providers</button>
			${collab()
				? html`<button class="foot-item" onClick=${() => openSheet({ type: "people" })}><${Icon} name="users" size=${16} /> People${canStart ? " & invites" : ""}</button>`
				: html`<button class="foot-item" onClick=${() => openSheet({ type: "invite" })}><${Icon} name="users" size=${16} /> Sign in another device</button>`}
			<button class="foot-item muted" onClick=${() => openSheet({ type: "name" })}>Signed in as ${me?.role === "owner" ? `${me.name} (owner)` : me?.role === "viewer" ? `${me?.name} (view only)` : me?.name}</button>
		</div>
	</div>`;
}

export function Drawer() {
	if (!store.state.drawer) return null;
	return html`<div class="overlay drawer-overlay" onClick=${(event) => event.target === event.currentTarget && store.set({ drawer: false })}>
		<aside class="drawer"><${SessionList} compact=${true} /></aside>
	</div>`;
}

export function SignIn() {
	const [value, setValue] = useState("");
	const go = () => {
		const text = value.trim();
		if (!text) return;
		try {
			const url = new URL(text, location.origin);
			if (url.pathname.startsWith("/join/") || url.searchParams.has("token")) {
				location.href = `${url.pathname}${url.search}`;
				return;
			}
		} catch {
			// not a URL
		}
		// Invite codes are ten lowercase letters and digits, and phones capitalize the first letter typed. Tokens are longer.
		// The invite sheet shows a code in two groups, so spaces typed or copied between them are dropped.
		const code = text.toLowerCase().replace(/\s+/g, "");
		location.href = /^[a-z0-9]{10}$/.test(code) ? `/join/${code}` : `/login?token=${encodeURIComponent(text)}`;
	};
	return html`<div class="signin">
		<div class="pi big">π</div>
		<h1>Pi Pocket</h1>
		<p class="muted">Open the sign-in link Pi Pocket printed when it started, or an invite from a signed-in device. You can also paste the link, the token, or an invite code here.</p>
		<div class="row">
			<input value=${value} placeholder="Link, token, or invite code" autocapitalize="none" autocorrect="off" autocomplete="off" spellcheck=${false} onInput=${(event) => setValue(event.currentTarget.value)} onKeyDown=${(event) => event.key === "Enter" && go()} />
			<button class="button primary" onClick=${go}>Sign in</button>
		</div>
	</div>`;
}
