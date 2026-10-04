// Pi Pocket web app. No build step: edit a file under web/ and every open browser reloads.
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { PeopleButton } from "./chat.js";
import { Composer } from "./composer.js";
import { Launcher } from "./launcher.js";
import { registerWorker, updateBadge } from "./notify.js";
import { Drawer, Rail, ResizeHandle, SessionList, SignIn, Splash, workspaceOrder } from "./sessions.js";
import { takeShare } from "./share.js";
import { Sheets } from "./sheets.js";
import { canSteer, dismiss, navigate, notify, openSheet, scoped, start, store } from "./store.js";
import { prefs, setPrefs, startTheme } from "./theme.js";
import { Transcript } from "./transcript.js";
import { APPLE, Boot, html, Icon, shortPath, usePresence } from "./ui.js";

function Topbar() {
	const { view, server } = store.state;
	const conversation = view.conversation;
	const artifacts = view.artifacts?.length ?? 0;
	const subtitle =
		conversation?.kind === "subagent"
			? `subagent of ${conversation.parent?.title ?? "?"}`
			: conversation?.worktree
				? `⎇ ${conversation.worktree.branch}`
				: shortPath(view.agent?.cwd ?? conversation?.cwd, server?.home);
	const busySubagents = (view.subagents ?? []).filter((agent) => agent.busy).length;
	return html`<header class=${`topbar ${view.live.busy ? "busy" : ""}`}>
		<button class="icon-button" aria-label="Sessions" onClick=${() => store.set({ drawer: true })}><${Icon} name="menu" /></button>
		<button class="title" onClick=${() => conversation && openSheet({ type: "menu" })}>
			<div class="title-main"><span>${conversation?.title ?? store.state.sessions.find((session) => session.id === store.state.conversationId)?.title ?? "Loading…"}</span></div>
			<div class="title-sub mono">${subtitle}</div>
		</button>
		${busySubagents > 0 && html`<button class="icon-button" title="Subagents working" onClick=${() => openSheet({ type: "menu" })}><span class="pulse"></span><span class="count">${busySubagents}</span></button>`}
		<${PeopleButton} />
		<button class="icon-button badge-host" aria-label="Artifacts" onClick=${() => openSheet({ type: "artifacts" })}>
			<${Icon} name="artifact" />${artifacts > 0 && html`<span class="badge">${artifacts}</span>`}
		</button>
		<button class="icon-button" aria-label="Menu" onClick=${() => openSheet({ type: "menu" })}><${Icon} name="more" /></button>
	</header>`;
}

/** Notices, Omarchy's notification style: each slides in, counts down, and slides out when it goes. */
function Notices() {
	const { notices } = store.state;
	const [gone, setGone] = useState([]);
	const before = useRef(notices);
	useEffect(() => {
		const removed = before.current.filter((notice) => !notices.some((each) => each.id === notice.id));
		before.current = notices;
		if (removed.length === 0) return;
		setGone((list) => [...list, ...removed]);
		setTimeout(() => setGone((list) => list.filter((notice) => !removed.includes(notice))), 160);
	}, [notices]);
	const all = [...notices, ...gone.filter((notice) => !notices.some((each) => each.id === notice.id))].sort((a, b) => a.id - b.id);
	if (all.length === 0) return null;
	return html`<div class="notices" role="status" aria-live="polite">${all.map((notice) => {
		const leaving = !notices.includes(notice);
		return html`<button key=${notice.id} class=${`notice ${notice.level} ${leaving ? "leaving" : ""}`} style=${`--life:${notice.level === "error" ? 9 : 4.5}s`} onClick=${() => {
			dismiss(notice.id);
			notice.action?.();
		}}>${notice.message}</button>`;
	})}</div>`;
}

/** The launcher, kept on screen a moment after it closes so it can fade out. */
function LauncherHost() {
	const [open, leaving] = usePresence(store.state.launcher || null, 150);
	return open ? html`<${Launcher} leaving=${leaving} />` : null;
}

function App() {
	const state = store.state;
	useEffect(() => {
		document.title = state.view.conversation?.title ? `${state.view.conversation.title} · Pi Pocket` : "Pi Pocket";
	}, [state.view.conversation?.title]);
	if (state.me === undefined) return html`<${Boot} caption=${state.notices.some((notice) => notice.level === "error") ? "waiting for the server" : "starting"} /><${Notices} />`;
	if (state.me === null) return html`<${SignIn} /><${Notices} />`;
	const inConversation = state.conversationId !== null;
	const rail = prefs().sidebar === "rail";
	return html`<div class=${`layout ${inConversation ? "" : "home"}`}>
		<aside class="sidebar window">${rail ? html`<${Rail} />` : html`<${SessionList} />`}${!rail && html`<${ResizeHandle} />`}</aside>
		<div class="pane window">
			${inConversation
				? html`<${Topbar} /><${Transcript} key=${state.conversationId} />${state.view.conversation && !state.missing && html`<${Composer} key=${state.conversationId} />`}`
				: html`<div class="home-list"><${SessionList} /></div><${Splash} />`}
		</div>
		<${Drawer} />
		<${Sheets} />
		<${LauncherHost} />
		<${Notices} />
	</div>`;
}

// ─── Windows and keys ───────────────────────────────────────────────────────────

/** Which window has focus, as Hyprland shows it: the one under the mouse (Omarchy's follow_mouse), or that took a tap or a key. */
function focusWindow(event) {
	if (event.type === "pointerover" && event.pointerType !== "mouse") return;
	const win = event.target.closest?.(".window");
	if (!win) return;
	const name = win.classList.contains("sidebar") ? "sidebar" : "pane";
	if (document.documentElement.dataset.focus !== name) document.documentElement.dataset.focus = name;
}
document.addEventListener("pointerover", focusWindow, true);
document.addEventListener("pointerdown", focusWindow, true);
document.addEventListener("focusin", focusWindow, true);

const typingIn = (target) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const wide = () => matchMedia("(min-width: 960px)").matches;

/** Go to the session `by` places away in workspace order, wrapping around. */
function step(by) {
	const order = workspaceOrder();
	if (order.length === 0) return;
	const at = order.findIndex((session) => session.id === store.state.conversationId);
	navigate(order[(at + by + order.length) % order.length].id);
}

addEventListener("keydown", (event) => {
	if (event.isComposing) return;
	if (event.key === "Alt") document.documentElement.dataset.alt = "on";
	// Cmd on Apple keyboards, where Ctrl+K and Ctrl+B edit text; Ctrl elsewhere.
	const mod = APPLE ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	const key = event.key.toLowerCase();
	if (!store.state.me) return;
	if (mod && !event.altKey && !event.shiftKey && key === "k") {
		event.preventDefault();
		store.set({ launcher: !store.state.launcher, drawer: false });
		return;
	}
	if (mod && !event.altKey && !event.shiftKey && key === "b") {
		event.preventDefault();
		if (wide()) setPrefs({ sidebar: prefs().sidebar === "rail" ? "open" : "rail" });
		else store.set({ drawer: !store.state.drawer });
		return;
	}
	// Option types characters on Apple keyboards, and AltGr does on many layouts: no Alt shortcuts there while typing.
	const altTypes = event.getModifierState?.("AltGraph") || (APPLE && typingIn(event.target));
	if (event.altKey && !event.ctrlKey && !event.metaKey && !altTypes) {
		const digit = /^Digit([1-9])$/.exec(event.code);
		if (digit) {
			const session = workspaceOrder()[Number(digit[1]) - 1];
			event.preventDefault();
			if (session) navigate(session.id);
			return;
		}
		if (event.code === "ArrowDown" || event.code === "ArrowUp") {
			event.preventDefault();
			step(event.code === "ArrowDown" ? 1 : -1);
			return;
		}
		if (event.code === "KeyN" && canSteer() && !scoped()) {
			event.preventDefault();
			openSheet({ type: "cwd", mode: "new" });
			return;
		}
	}
	if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey && !typingIn(event.target) && !store.state.sheet && !store.state.launcher) {
		event.preventDefault();
		openSheet({ type: "shortcuts" });
	}
});
const altUp = () => delete document.documentElement.dataset.alt;
addEventListener("keyup", (event) => event.key === "Alt" && altUp());
addEventListener("blur", altUp);

// The whole tree re-renders from the store; Preact's diff keeps that cheap. Batched per microtask.
startTheme();
const root = document.getElementById("app");
let queued = false;
store.subscribe(() => {
	if (queued) return;
	queued = true;
	queueMicrotask(() => {
		queued = false;
		render(html`<${App} />`, root);
	});
});
render(html`<${App} />`, root);
// A notification's link can ask for the chat: `/s/12?chat=1`.
if (new URLSearchParams(location.search).has("chat")) {
	history.replaceState({}, "", location.pathname);
	store.set({ sheet: { type: "chat" } });
}
// The worker shows notifications and receives what other apps share; it needs a secure page (https or localhost).
registerWorker();
store.subscribe(updateBadge);
start();
// Something shared from another app: the service worker kept it, and redirected here to choose where it goes.
const shared = new URLSearchParams(location.search).get("share");
if (shared !== null) {
	history.replaceState({}, "", location.pathname);
	takeShare(shared).then(
		(share) => (share ? store.set({ sheet: { type: "share", share } }) : notify("error", "What was shared did not arrive. Share it again.")),
		() => notify("error", "What was shared could not be read. Share it again."),
	);
}
