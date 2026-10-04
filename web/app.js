// Pi Pocket web app. No build step: edit a file under web/ and every open browser reloads.
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { PeopleButton } from "./chat.js";
import { Composer } from "./composer.js";
import { registerWorker, updateBadge } from "./notify.js";
import { Drawer, SessionList, SignIn } from "./sessions.js";
import { takeShare } from "./share.js";
import { Sheets } from "./sheets.js";
import { dismiss, notify, openSheet, start, store } from "./store.js";
import { Transcript } from "./transcript.js";
import { Boot, html, Icon, shortPath } from "./ui.js";


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
	return html`<header class="topbar">
		<button class="icon-button" aria-label="Sessions" onClick=${() => store.set({ drawer: true })}><${Icon} name="menu" /></button>
		<button class="title" onClick=${() => conversation && openSheet({ type: "menu" })}>
			<div class="title-main">${conversation?.title ?? store.state.sessions.find((session) => session.id === store.state.conversationId)?.title ?? "Loading…"}</div>
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

function Notices() {
	const { notices } = store.state;
	if (notices.length === 0) return null;
	return html`<div class="notices">${notices.map(
		(notice) => html`<button class=${`notice ${notice.level}`} onClick=${() => {
			dismiss(notice.id);
			notice.action?.();
		}}>${notice.message}</button>`,
	)}</div>`;
}

function App() {
	const state = store.state;
	useEffect(() => {
		document.title = state.view.conversation?.title ? `${state.view.conversation.title} · Pi Pocket` : "Pi Pocket";
	}, [state.view.conversation?.title]);
	if (state.me === undefined) return html`<${Boot} caption=${state.notices.some((notice) => notice.level === "error") ? "waiting for the server" : "starting"} /><${Notices} />`;
	if (state.me === null) return html`<${SignIn} />`;
	const inConversation = state.conversationId !== null;
	return html`<div class=${`layout ${inConversation ? "" : "home"}`}>
		<aside class="sidebar"><${SessionList} /></aside>
		<div class="pane">
			${inConversation
				? html`<${Topbar} /><${Transcript} key=${state.conversationId} />${state.view.conversation && !state.missing && html`<${Composer} key=${state.conversationId} />`}`
				: html`<div class="home-list"><${SessionList} /></div>`}
		</div>
		<${Drawer} />
		<${Sheets} />
		<${Notices} />
	</div>`;
}

// The whole tree re-renders from the store; Preact's diff keeps that cheap. Batched per microtask.
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
