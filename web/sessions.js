// Session list (sidebar, drawer, and home screen), the folded rail, the wide home screen, and the sign-in screen.
import { useRef, useState } from "preact/hooks";
import { Avatar, initials } from "./chat.js";
import { canSteer, collab, navigate, openSheet, scoped, sessionUnread, store } from "./store.js";
import { isPinned, paletteOf, prefs, setPrefs, togglePin } from "./theme.js";
import { html, Icon, Keys, shortPath, Slide, timeAgo, useSlide, usePresence } from "./ui.js";

/** The session list on its way: rows shaped like sessions, lit in turn. */
function LoadingSessions() {
	return html`<div role="status" aria-label="Loading sessions">
		${[72, 54, 64, 46, 58].map(
			(width, index) => html`<div class="session-placeholder" aria-hidden="true" style=${`--width: ${width}%; --delay: ${index * 0.12}s`}><span></span><span></span></div>`,
		)}
	</div>`;
}

/**
 * Sessions in "workspace" order, as Alt+1…9 and the rail number them: pinned ones first (in the order they were
 * pinned), then the rest, newest first. Archived sessions are left out.
 */
export function workspaceOrder(state = store.state) {
	const active = state.sessions.filter((session) => !session.archived);
	const pinned = state.pinned.map((id) => active.find((session) => session.id === id)).filter(Boolean);
	return [...pinned, ...active.filter((session) => !pinned.includes(session))];
}

const CLOSED_KEY = "pocket.closedGroups";
const readClosed = () => {
	try {
		return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]"));
	} catch {
		return new Set();
	}
};

const DAY = 86_400_000;

/** Which day bucket a time falls in, in this device's time zone. */
function dayGroup(ms) {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const start = today.getTime();
	if (ms >= start) return "Today";
	if (ms >= start - DAY) return "Yesterday";
	if (ms >= start - 6 * DAY) return "This week";
	if (ms >= start - 29 * DAY) return "This month";
	return "Earlier";
}

/** `~/Development/pi-pocket` with its last part bold, for a folder group's name. */
function FolderName({ path }) {
	const at = path.lastIndexOf("/");
	if (at <= 0) return html`<b>${path}</b>`;
	return html`${path.slice(0, at + 1)}<b>${path.slice(at + 1)}</b>`;
}

/** The text with what matched the search marked. */
function Highlight({ text, needle }) {
	if (!needle) return text;
	const at = text.toLowerCase().indexOf(needle);
	if (at === -1) return text;
	return html`${text.slice(0, at)}<mark>${text.slice(at, at + needle.length)}</mark>${text.slice(at + needle.length)}`;
}

function SessionRow({ session, index, number, needle }) {
	const { conversationId, server, me } = store.state;
	const pinned = isPinned(session.id);
	const unread = collab() && sessionUnread(session);
	const state = session.waiting
		? html`<span class="state-warn" title="Waiting for approval">!</span>`
		: session.busy
			? html`<span class="mini-sweep" title="Working"><i></i><i></i><i></i></span>`
			: html`<span class="state-idle"></span>`;
	const people = collab() ? (session.people ?? []).filter((person) => person.id !== me?.id).slice(0, 4) : [];
	return html`<div class=${`session-row ${session.id === conversationId ? "active" : ""}`} style=${`--i:${index}`}>
		<button class="session" onClick=${() => navigate(session.id)} title=${session.title ?? "New session"}>
			<span class="session-state">${state}</span>
			<span class="session-main">
				<span class="session-title"><${Highlight} text=${session.title ?? "New session"} needle=${needle} /></span>
				<span class="session-meta">
					<span class="mono"><${Highlight} text=${shortPath(session.cwd, server?.home)} needle=${needle} /></span>
					${session.worktree ? html`<span class="mono">⎇ ${session.worktree.branch}</span>` : session.model && html`<span class="mono">${session.model}</span>`}
				</span>
			</span>
			<span class="session-side">
				${unread && html`<span class="unread-dot" title="New chat messages"></span>`}
				<span class="session-time">${timeAgo(session.updatedAt)}</span>
				${number !== undefined && number < 9 && html`<kbd class="session-num">${number + 1}</kbd>`}
			</span>
			${people.length > 0 && html`<span class="session-people">${people.map((person) => html`<${Avatar} key=${person.id} person=${person} size=${18} />`)}</span>`}
		</button>
		<button class=${`session-pin ${pinned ? "on" : ""}`} title=${pinned ? "Unpin" : "Pin to the top"} aria-label=${pinned ? "Unpin" : "Pin"} onClick=${() => togglePin(session.id)}>
			<${Icon} name="pin" size=${14} />
		</button>
	</div>`;
}

/** Sessions in groups: pinned, then by day or by folder. While searching, one flat list of matches. */
function groupsOf(shown, { tab, needle, home, pinned }) {
	if (needle !== "" || tab === "archived") return [{ key: "flat", label: needle ? "Matches" : "Archived", rows: shown }];
	const groups = [];
	const pins = shown.filter((session) => pinned.includes(session.id));
	if (pins.length > 0) groups.push({ key: "pinned", label: "Pinned", rows: pins });
	const rest = shown.filter((session) => !pinned.includes(session.id));
	const byKey = new Map();
	for (const session of rest) {
		const key = tab === "folders" ? `dir:${session.cwd}` : `day:${dayGroup(session.updatedAt)}`;
		if (!byKey.has(key)) byKey.set(key, { key, label: tab === "folders" ? html`<${FolderName} path=${shortPath(session.cwd, home)} />` : dayGroup(session.updatedAt), rows: [] });
		byKey.get(key).rows.push(session);
	}
	return [...groups, ...byKey.values()];
}

const TABS = [
	["recent", "Recent"],
	["folders", "Folders"],
	["archived", "Archived"],
];

export function SessionList({ compact = false }) {
	const { sessions, sessionsLoaded, server, me, pinned } = store.state;
	const canStart = canSteer() && !scoped();
	const [query, setQuery] = useState("");
	const [tab, setTabState] = useState(() => (prefs().group === "folder" ? "folders" : "recent"));
	const [closed, setClosed] = useState(readClosed);
	const list = useRef(null);
	const tabs = useRef(null);
	const needle = query.trim().toLowerCase();
	const archived = tab === "archived";
	const setTab = (next) => {
		setTabState(next);
		if (next !== "archived") setPrefs({ group: next === "folders" ? "folder" : "recent" });
	};
	const shown = sessions.filter(
		(session) =>
			Boolean(session.archived) === archived &&
			(needle === "" || `${session.title ?? ""} ${session.cwd} ${shortPath(session.cwd, server?.home)} ${session.model ?? ""}`.toLowerCase().includes(needle)),
	);
	const groups = groupsOf(shown, { tab, needle, home: server?.home, pinned });
	const numbers = new Map(workspaceOrder().map((session, index) => [session.id, index]));
	const toggleGroup = (key) => {
		const next = new Set(closed);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
		setClosed(next);
	};
	const indicator = useSlide(list, ".session-row.active");
	const tabBar = useSlide(tabs, "button.on", "x");
	const busy = sessions.filter((session) => session.busy).length;
	let index = 0;
	return html`<div class=${`sessions ${compact ? "compact" : ""}`}>
		<div class="sessions-head">
			<span class="brand">π <span>Pocket</span></span>
			<button class="icon-button" title="Launcher" aria-label="Open the launcher" onClick=${() => store.set({ launcher: true, drawer: false })}><${Icon} name="command" size=${18} /></button>
			${!compact && html`<button class="icon-button" title="Fold the sidebar" aria-label="Fold the sidebar" onClick=${() => setPrefs({ sidebar: "rail" })}><${Icon} name="sidebar" size=${18} /></button>`}
			${canStart && html`<button class="button primary small new-button" onClick=${() => openSheet({ type: "cwd", mode: "new" })}><${Icon} name="plus" size=${16} /> New</button>`}
		</div>
		<label class="search">
			<${Icon} name="search" size=${16} />
			<input placeholder="Search sessions" value=${query} onInput=${(event) => setQuery(event.currentTarget.value)} onKeyDown=${(event) => event.key === "Escape" && setQuery("")} />
			${query
				? html`<button class="icon-button small" aria-label="Clear" onClick=${() => setQuery("")}><${Icon} name="close" size=${14} /></button>`
				: html`<span class="search-keys" title="Launcher" onClick=${(event) => {
						event.preventDefault();
						store.set({ launcher: true, drawer: false });
					}}><${Keys} keys="Mod K" /></span>`}
		</label>
		<div class="session-tabs" role="tablist" ref=${tabs}>
			${TABS.map(([key, label]) => html`<button role="tab" aria-selected=${tab === key} class=${tab === key ? "on" : ""} onClick=${() => setTab(key)}>${label}</button>`)}
			<${Slide} box=${tabBar} axis="x" />
		</div>
		<div class="session-items" ref=${list}>
			<${Slide} box=${indicator} />
			${!sessionsLoaded && html`<${LoadingSessions} />`}
			${sessionsLoaded && shown.length === 0 && html`<div class="sessions-empty">${archived ? "No archived sessions." : needle ? "No matches." : "No sessions yet. Start one with New."}</div>`}
			${groups.map((group) => {
				const isClosed = closed.has(group.key) && group.key !== "flat";
				return html`<section class=${`session-group ${isClosed ? "closed" : ""}`} key=${`${tab}:${group.key}`}>
					${group.key !== "flat" || needle
						? html`<button class="group-head" onClick=${() => group.key !== "flat" && toggleGroup(group.key)} aria-expanded=${!isClosed}>
								<span class="group-name">${group.label}</span>
								<span class="group-count">${group.rows.length}</span>
								${group.key !== "flat" && html`<${Icon} name="down" size=${12} />`}
							</button>`
						: null}
					<div class="group-body"><div>
						${group.rows.map((session) => html`<${SessionRow} key=${session.id} session=${session} index=${index++} number=${numbers.get(session.id)} needle=${needle} />`)}
					</div></div>
				</section>`;
			})}
		</div>
		<div class="sessions-foot">
			<div class="foot-tiles">
				<button class=${`foot-tile ${busy > 0 ? "lit" : ""}`} title="Everything Pi is doing" onClick=${() => openSheet({ type: "running" })}>
					${busy > 0 ? html`<span class="mini-sweep"><i></i><i></i><i></i></span>` : html`<${Icon} name="pulse" size=${16} />`}
					Running${busy > 0 && html`<span class="tile-count">${busy}</span>`}
				</button>
				<button class="foot-tile" title="Model providers" onClick=${() => openSheet({ type: "providers" })}><${Icon} name="key" size=${16} /> Providers</button>
				${collab()
					? html`<button class="foot-tile" title=${canStart ? "People and invites" : "People"} onClick=${() => openSheet({ type: "people" })}><${Icon} name="users" size=${16} /> People</button>`
					: html`<button class="foot-tile" title="Sign in another device" onClick=${() => openSheet({ type: "invite" })}><${Icon} name="users" size=${16} /> Devices</button>`}
				<button class="foot-tile" title="Theme, tiling, motion" onClick=${() => openSheet({ type: "appearance" })}><${Icon} name="palette" size=${16} /> Theme</button>
			</div>
			<button class="me-row" title="Your name" onClick=${() => openSheet({ type: "name" })}>
				${me && html`<${Avatar} person=${me} size=${22} />`}
				<span class="me-name">${me?.name}</span>
				<span class="me-role">${me?.role === "owner" ? "owner" : me?.role === "viewer" ? "view only" : "guest"}</span>
			</button>
		</div>
	</div>`;
}

/** The sidebar folded: Pi, new, the launcher, then numbered sessions like Waybar's workspaces. */
export function Rail() {
	const { conversationId } = store.state;
	const canStart = canSteer() && !scoped();
	const items = useRef(null);
	const order = workspaceOrder();
	const indicator = useSlide(items, ".ws.active");
	return html`<div class="rail">
		<button class="rail-brand" title="Unfold the sidebar" aria-label="Unfold the sidebar" onClick=${() => setPrefs({ sidebar: "open" })}>π</button>
		${canStart && html`<button class="icon-button" title="New session" aria-label="New session" onClick=${() => openSheet({ type: "cwd", mode: "new" })}><${Icon} name="plus" size=${18} /></button>`}
		<button class="icon-button" title="Launcher" aria-label="Open the launcher" onClick=${() => store.set({ launcher: true })}><${Icon} name="command" size=${18} /></button>
		<div class="rail-items" ref=${items}>
			<${Slide} box=${indicator} />
			${order.map(
				(session, index) => html`<button
					key=${session.id}
					class=${`ws ${session.id === conversationId ? "active" : ""} ${session.busy ? "busy" : ""} ${session.waiting ? "waiting" : ""}`}
					style=${`--i:${index}`}
					title=${`${session.title ?? "New session"}${index < 9 ? `  (Alt ${index + 1})` : ""}`}
					onClick=${() => navigate(session.id)}
				>
					${index < 9 ? index + 1 : initials(session.title ?? "New session")}
					${collab() && sessionUnread(session) && html`<span class="unread-dot"></span>`}
				</button>`,
			)}
		</div>
		<div class="rail-foot">
			<button class="icon-button" title="Running now" onClick=${() => openSheet({ type: "running" })}><${Icon} name="pulse" size=${18} /></button>
			<button class="icon-button" title="Appearance" onClick=${() => openSheet({ type: "appearance" })}><${Icon} name="palette" size=${18} /></button>
			<button class="icon-button" title="Unfold the sidebar" aria-label="Unfold the sidebar" onClick=${() => setPrefs({ sidebar: "open" })}><${Icon} name="sidebar" size=${18} /></button>
		</div>
	</div>`;
}

/** Drag the sidebar's right edge to resize it; a double click puts it back to its usual width. */
export function ResizeHandle() {
	const start = (event) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const root = document.documentElement;
		const sidebar = event.currentTarget.parentElement;
		const left = sidebar.getBoundingClientRect().left;
		let width = prefs().sidebarWidth;
		root.classList.add("resizing");
		const move = (each) => {
			width = Math.round(Math.min(520, Math.max(260, each.clientX - left)));
			root.style.setProperty("--sidebar-w", `${width}px`);
		};
		const stop = () => {
			root.classList.remove("resizing");
			removeEventListener("pointermove", move);
			removeEventListener("pointerup", stop);
			removeEventListener("pointercancel", stop);
			setPrefs({ sidebarWidth: width });
		};
		addEventListener("pointermove", move);
		addEventListener("pointerup", stop);
		addEventListener("pointercancel", stop);
	};
	return html`<div class="resize-handle" role="separator" aria-orientation="vertical" title="Drag to resize" onPointerDown=${start} onDblClick=${() => setPrefs({ sidebarWidth: 300 })}></div>`;
}

export function Drawer() {
	const [open, leaving] = usePresence(store.state.drawer || null, 200);
	if (!open) return null;
	return html`<div class=${leaving ? "leaving" : ""} inert=${leaving}>
		<div class="overlay drawer-overlay" onClick=${(event) => event.target === event.currentTarget && store.set({ drawer: false })}>
			<aside class="drawer"><${SessionList} compact=${true} /></aside>
		</div>
	</div>`;
}

const LOGO = [
	"▗▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▖",
	"▝▀▀▀▜██▀▀▀▀▀▀██▛▀▀▀▘",
	"    ▐██      ██▌   ",
	"    ▐██      ██▌   ",
	"    ▐██      ██▌   ",
	"    ▐██      ██▌   ",
	"   ▗██▘      ▝██▄▖ ",
	"  ▝▀▀          ▀▀▀▘",
].join("\n");

/** The home screen on wide screens: what fastfetch shows for a machine, for this Pi Pocket. */
export function Splash() {
	const { me, sessions, models, server, guard } = store.state;
	const palette = paletteOf();
	const p = prefs();
	const busy = sessions.filter((session) => session.busy).length;
	const recent = workspaceOrder().slice(0, 5);
	const rows = [
		["theme", `${palette.name}${p.theme === "desktop" && palette.desktop ? " (desktop)" : ""}`],
		["layout", `${p.tiling ? "tiled windows" : "flat"}, sidebar ${p.sidebar === "rail" ? "folded" : "open"}`],
		["sessions", `${sessions.filter((session) => !session.archived).length}${busy > 0 ? `, ${busy} running` : ""}`],
		["models", String(models.length)],
		["folder", shortPath(server?.defaultCwd, server?.home) || "~"],
		["guard", guard?.enabled ? (guard.available === false ? "failed to load" : "Lancet Guard on") : "off"],
		["you", `${me?.name ?? "?"} (${me?.role ?? "?"})`],
	];
	const colors = ["--o-red", "--o-yellow", "--o-green", "--o-cyan", "--o-blue", "--o-magenta", "--o-accent", "--o-fg"];
	const canStart = canSteer() && !scoped();
	let line = 0;
	return html`<div class="splash">
		<div class="fetch">
			<pre class="fetch-logo" aria-hidden="true">${LOGO}</pre>
			<div class="fetch-info">
				<div class="fetch-title" style=${`--i:${line++}`}><b>${(me?.name ?? "you").toLowerCase().replace(/\s+/g, "-")}</b>@<b>pi-pocket</b></div>
				<div class="fetch-rule" style=${`--i:${line++}`}>${"─".repeat(30)}</div>
				${rows.map(([key, value]) => html`<dl class="fetch-row" style=${`--i:${line++}`}><dt>${key}</dt><dd>${value}</dd></dl>`)}
				<div class="fetch-colors" style=${`--i:${line++}`}>${colors.map((name) => html`<span style=${`background:var(${name})`}></span>`)}</div>
			</div>
		</div>
		<div class="splash-actions">
			${canStart && html`<button class="button primary" onClick=${() => openSheet({ type: "cwd", mode: "new" })}><${Icon} name="plus" size=${16} /> New session <${Keys} keys="Alt N" /></button>`}
			<button class="button" onClick=${() => store.set({ launcher: true })}><${Icon} name="command" size=${16} /> Launcher <${Keys} keys="Mod K" /></button>
			<button class="button" onClick=${() => openSheet({ type: "appearance" })}><${Icon} name="palette" size=${16} /> Appearance</button>
		</div>
		${recent.length > 0 &&
		html`<div class="splash-recent">
			<div class="group-title">Jump back in</div>
			${recent.map(
				(session, index) => html`<button class="list-item" onClick=${() => navigate(session.id)}>
					<span><kbd>${index + 1}</kbd>${session.title ?? "New session"}</span>
					<span class="muted small mono">${session.busy ? "working · " : ""}${timeAgo(session.updatedAt)}</span>
				</button>`,
			)}
		</div>`}
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
