// App state, the server connection, and API calls. Components read `store.state` and re-render on `store.subscribe`.

/** A random id. crypto.randomUUID only exists on https and localhost pages; plain-http network addresses lack it. */
export function uid() {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const TAB_KEY = "pocket.tab";
export const TAB = sessionStorage.getItem(TAB_KEY) ?? uid();
sessionStorage.setItem(TAB_KEY, TAB);

const emptyView = () => ({
	conversation: null,
	entries: new Map(),
	order: [],
	live: { busy: false },
	inbox: [],
	agent: null,
	stats: { cost: 0 },
	clients: 0,
	viewers: [],
	approvals: [],
	artifacts: [],
	subagents: [],
	authors: {},
	reactions: {},
	pins: [],
	turns: { on: false, asks: [] },
	decisions: {},
});

export const store = {
	state: {
		me: undefined, // undefined: unknown, null: signed out
		users: [],
		models: [],
		guard: null,
		server: null,
		sessions: [],
		conversationId: routeConversation(),
		view: emptyView(),
		...peopleFor(routeConversation()),
		history: null,
		missing: null,
		connection: "connecting",
		notices: [],
		sheet: null,
		drawer: false,
		auth: null,
		/** A transcript message the next chat message discusses: `{ entryId, text }`. */
		chatQuote: null,
		/** Text to put into the message box to Pi: `{ text, n }`, picked up by the composer. */
		composerInsert: null,
	},
	listeners: new Set(),
	set(patch) {
		this.state = { ...this.state, ...(typeof patch === "function" ? patch(this.state) : patch) };
		for (const listener of this.listeners) listener(this.state);
	},
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	},
};

function routeConversation() {
	const match = /^\/s\/(\d+)/.exec(location.pathname);
	return match ? Number(match[1]) : null;
}

// ─── People: presence, typing, and the side chat ───────────────────────────────────

const CHAT_LIMIT = 500;
// A function declaration, not a const: the store's initial state calls it before this line runs.
function readKey(id) {
	return `pocket.chatRead.${id}`;
}

/** Fresh people state for a conversation: no one known yet, and how far this browser has read its chat. */
function peopleFor(id) {
	return { chat: [], presence: [], notes: null, chatQuote: null, chatRead: id === null ? 0 : chatReadOf(id) };
}

/** How far this browser has read a conversation's chat: the time of the newest message seen. */
export function chatReadOf(id) {
	return Number(localStorage.getItem(readKey(id)) ?? 0);
}

/** Server features the web app may use. `collab` 2 adds roles, take turns, reactions, pins, notes, mentions, push. */
export const collab = () => (store.state.server?.collab ?? 0) >= 2;
/** Viewers read and chat; they never steer Pi. */
export const canSteer = () => store.state.me?.role !== "viewer";
/** People invited to one session cannot start sessions or invite others. */
export const scoped = () => Array.isArray(store.state.me?.sessions);

/** Everything in the chat counts as read: called while the chat is open. */
export function markChatRead() {
	const { chat, chatRead, conversationId } = store.state;
	const last = chat.at(-1)?.at ?? 0;
	if (last <= chatRead || conversationId === null) return;
	localStorage.setItem(readKey(conversationId), String(last));
	store.set({ chatRead: last });
}

function applyChat(data) {
	const state = store.state;
	if (data.conversationId !== state.conversationId) return;
	const known = new Set(data.full ? [] : state.chat.map((message) => message.id));
	const added = data.messages.filter((message) => !known.has(message.id));
	store.set({ chat: (data.full ? data.messages : [...state.chat, ...added]).slice(-CHAT_LIMIT) });
	if (state.sheet?.type === "chat") {
		markChatRead();
		return;
	}
	// A full list comes on connect: only live messages from others pop up.
	const fresh = data.full ? [] : added.filter((message) => message.userId !== state.me?.id && message.kind !== "event");
	if (fresh.length === 0) return;
	const open = () => openSheet({ type: "chat" });
	if (fresh.length > 1) return notify("info", `${fresh.length} new chat messages`, open);
	const [message] = fresh;
	const name = state.users.find((user) => user.id === message.userId)?.name ?? message.name;
	const text = message.text.replace(/\s+/g, " ");
	const mentioned = message.mentions?.includes(state.me?.id);
	notify("info", `${name}${mentioned ? " mentioned you" : ""}: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`, open);
}

let typingSent = { where: null, at: 0, conversationId: null };

/** Tell others this person is typing ("chat" or "pi") or stopped (null). Renewed at most every few seconds. */
export function typing(where) {
	const id = store.state.conversationId;
	if (!store.state.server?.chat || id === null) return;
	const now = Date.now();
	const same = typingSent.conversationId === id && typingSent.where === where;
	if (same && (where === null || now - typingSent.at < 3000)) return;
	typingSent = { where, at: now, conversationId: id };
	api(`c/${id}/typing`, { where }).catch(() => {});
}

export class ApiError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

export async function api(path, body, options = {}) {
	const init = { method: body === undefined && !options.method ? "GET" : (options.method ?? "POST"), headers: { "X-Pocket": "1" } };
	if (body !== undefined) {
		if (body instanceof Blob) {
			init.body = body;
			init.headers["content-type"] = body.type || "application/octet-stream";
		} else {
			init.body = JSON.stringify(body);
			init.headers["content-type"] = "application/json";
		}
	}
	const response = await fetch(`/api/${path}`, init);
	const text = await response.text();
	let data;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { error: text };
	}
	if (!response.ok) throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
	return data;
}

let nextNotice = 1;
/** Show a short notice. With `action`, tapping it runs the action as well as dismissing it. */
export function notify(level, message, action) {
	const id = nextNotice++;
	store.set((state) => ({ notices: [...state.notices, { id, level, message, action }].slice(-4) }));
	setTimeout(() => dismiss(id), level === "error" ? 9000 : 4500);
}

export function dismiss(id) {
	store.set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
}

/** Run an action and show its error, if any, as a notice. */
export async function attempt(action) {
	try {
		return await action();
	} catch (error) {
		notify("error", error.message ?? String(error));
		return undefined;
	}
}

let source;

function applyView(data) {
	store.set((state) => {
		const base = data.full || state.view.conversation?.id !== data.conversation.id ? emptyView() : state.view;
		const entries = new Map(base.entries);
		for (const entry of data.entries) entries.set(entry.id, entry);
		const order = data.order ?? base.order;
		if (data.order) {
			const keep = new Set(data.order);
			for (const id of entries.keys()) if (!keep.has(id)) entries.delete(id);
		}
		return {
			view: {
				...base,
				conversation: data.conversation,
				entries,
				order,
				live: data.live,
				inbox: data.inbox,
				agent: data.agent,
				stats: data.stats,
				clients: data.clients,
				viewers: data.viewers,
				approvals: data.approvals,
				artifacts: data.artifacts,
				subagents: data.subagents,
				authors: data.authors,
				reactions: data.reactions ?? {},
				pins: data.pins ?? [],
				turns: data.turns ?? { on: false, asks: [] },
				decisions: data.decisions ?? {},
			},
			missing: null,
		};
	});
}

/** What the server sends, by event name. Both transports deliver the same events. */
const handlers = {
	hello: (data) => store.set({ me: data.user, users: data.users, models: data.models, guard: data.guard, server: data.server }),
	sessions: (sessions) => store.set({ sessions }),
	models: (models) => store.set({ models }),
	view: applyView,
	chat: applyChat,
	presence: (data) => data.conversationId === store.state.conversationId && store.set({ presence: data.people }),
	notes: (data) => data.conversationId === store.state.conversationId && store.set({ notes: { text: data.text, rev: data.rev, by: data.by, at: data.at } }),
	users: (users) => store.set({ users }),
	missing: (data) => store.set({ missing: data.message }),
	// A notice may link to a conversation, such as a mention elsewhere: tapping it goes there.
	notice: (data) =>
		notify(data.level, data.message, data.link ? () => navigate(data.link.conversationId, { sheet: data.link.sheet ? { type: data.link.sheet } : null }) : undefined),
	auth: (data) => handleAuth(data),
	closing: () => store.set({ connection: "closed" }),
	reload: () => {
		// A web file changed on the server. Drafts live in localStorage, so a reload loses nothing.
		setTimeout(() => location.reload(), 150);
	},
};

const TRANSPORT_KEY = "pocket.transport";
const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname);

const connected = () => store.state.connection !== "open" && store.set({ connection: "open" });

export function connect() {
	source?.close();
	store.set({ connection: "connecting" });
	const id = store.state.conversationId;
	const query = `tab=${encodeURIComponent(TAB)}${id === null ? "" : `&c=${id}`}`;
	source = localStorage.getItem(TRANSPORT_KEY) === "poll" && !local ? pollEvents(query) : streamEvents(query);
}

/** Server-sent events: one long response the server writes to as things change. */
function streamEvents(query) {
	const events = new EventSource(`/api/events?${query}`);
	let heard = false;
	const connection = {
		close() {
			clearTimeout(fallback);
			events.close();
		},
	};
	// Some tunnels (Cloudflare quick tunnels) hold the stream back. Nothing after a few seconds: poll instead, and
	// remember that for this address.
	const fallback = local
		? undefined
		: setTimeout(() => {
				if (heard || source !== connection) return;
				localStorage.setItem(TRANSPORT_KEY, "poll");
				connect();
			}, 6000);
	for (const [name, handler] of Object.entries(handlers)) {
		events.addEventListener(name, (event) => {
			if (source !== connection) return;
			heard = true;
			handler(JSON.parse(event.data));
		});
	}
	events.onopen = () => source === connection && connected();
	events.onerror = async () => {
		if (source !== connection) return;
		store.set({ connection: "closed" });
		// EventSource retries by itself; a 401 needs a sign-in instead.
		try {
			await api("me");
		} catch (error) {
			if (error.status === 401) {
				connection.close();
				store.set({ me: null });
			}
		}
	};
	return connection;
}

/** Long polling: each request waits for events and returns them; the next one acknowledges what arrived. */
function pollEvents(query) {
	let session = null;
	let ack = 0;
	let stopped = false;
	let request = null;
	const connection = {
		close() {
			stopped = true;
			request?.abort();
			if (session) fetch(`/api/poll?session=${session}&close=1`, { keepalive: true }).catch(() => {});
		},
	};
	(async () => {
		let failures = 0;
		while (!stopped) {
			request = new AbortController();
			try {
				const response = await fetch(`/api/poll?${query}${session ? `&session=${session}&ack=${ack}` : ""}`, { signal: request.signal, cache: "no-store" });
				if (response.status === 401) {
					stopped = true;
					store.set({ me: null });
					return;
				}
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const data = await response.json();
				if (stopped || source !== connection) return;
				if (data.session !== session) {
					// A new session (first poll, or the server restarted): it starts with hello and a full view.
					session = data.session;
					ack = 0;
				}
				failures = 0;
				connected();
				for (const item of data.events) {
					if (item.seq <= ack) continue;
					ack = item.seq;
					handlers[item.event]?.(item.data);
				}
			} catch {
				if (stopped) return;
				failures++;
				if (store.state.connection === "open") store.set({ connection: "closed" });
				await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 1000 * failures)));
			}
		}
	})();
	return connection;
}

function handleAuth(data) {
	store.set((state) => {
		const flow = state.auth?.flowId === data.flowId ? state.auth : { flowId: data.flowId, providerId: data.providerId, events: [], prompt: null, done: null };
		if (data.step === "prompt") return { auth: { ...flow, prompt: { id: data.promptId, ...data.prompt } } };
		if (data.step === "prompt-closed") return { auth: flow.prompt?.id === data.promptId ? { ...flow, prompt: null } : flow };
		if (data.step === "event") return { auth: { ...flow, events: [...flow.events, data.event] } };
		if (data.step === "done") {
			if (data.ok) notify("info", `Signed in to ${data.providerId}.`);
			return { auth: data.ok ? null : { ...flow, prompt: null, done: data } };
		}
		return {};
	});
}

export function navigate(conversationId, { replace = false, sheet = null } = {}) {
	const path = conversationId === null ? "/" : `/s/${conversationId}`;
	if (location.pathname !== path) history[replace ? "replaceState" : "pushState"]({}, "", path);
	if (store.state.conversationId === conversationId && source) {
		if (sheet) store.set({ sheet, drawer: false });
		return;
	}
	store.set({ conversationId, view: emptyView(), ...peopleFor(conversationId), history: null, missing: null, drawer: false, sheet });
	connect();
}

addEventListener("popstate", () => {
	const id = routeConversation();
	if (id !== store.state.conversationId) {
		store.set({ conversationId: id, view: emptyView(), ...peopleFor(id), history: null, missing: null, sheet: null, drawer: false });
		connect();
	}
});

export async function start() {
	try {
		const hello = await api("me");
		store.set({ me: hello.user, users: hello.users, models: hello.models, guard: hello.guard, server: hello.server });
		connect();
	} catch (error) {
		store.set({ me: error.status === 401 ? null : undefined });
		if (error.status !== 401) {
			notify("error", `Server unreachable: ${error.message}`);
			setTimeout(start, 3000);
		}
	}
}

// ─── Commands ───────────────────────────────────────────────────────────

const current = () => store.state.conversationId;

export const actions = {
	submit: (text, attachments, mode) =>
		api(`c/${current()}/submit`, { text, attachments, mode, requestId: uid() }),
	abort: () => api(`c/${current()}/abort`, {}),
	chat: (text, quote) => api(`c/${current()}/chat`, { text, requestId: uid(), ...(quote ? { quote: { entryId: quote.entryId } } : {}) }),
	react: (entryId, emoji) => api(`c/${current()}/react`, { entryId, emoji }),
	pin: (target) => api(`c/${current()}/pin`, target),
	saveNotes: (text, rev) => api(`c/${current()}/notes`, { text, rev }),
	turns: (action, to) => api(`c/${current()}/turns`, { action, ...(to ? { to } : {}) }),
	setAccess: (userId, patch) => api(`users/${encodeURIComponent(userId)}`, patch),
	withdraw: (submissionId) => api(`c/${current()}/withdraw`, { submissionId }),
	configure: (change) => api(`c/${current()}/configure`, change),
	compact: (instructions) => api(`c/${current()}/compact`, { instructions }),
	approve: (id, allow) => api(`approvals/${encodeURIComponent(id)}`, { allow }),
	createSession: (cwd) => api("sessions", { cwd }),
	updateSession: (id, patch) => api(`sessions/${id}`, patch),
	upload: (file) => api(`c/${current()}/upload?name=${encodeURIComponent(file.name)}`, file),
	fullEntry: (entryId) => api(`c/${current()}/entry/${entryId}`),
	history: (before) => api(`c/${current()}/history?before=${before}`),
};

export function openSheet(sheet) {
	store.set({ sheet, drawer: false });
}

/** Put text into the message box to Pi (after what is there), and close any sheet so it shows. */
export function insertIntoComposer(text) {
	store.set((state) => ({ sheet: null, composerInsert: { text, n: (state.composerInsert?.n ?? 0) + 1 } }));
}

/** Open the chat to discuss a transcript message: the next chat message quotes it. */
export function discuss(entryId, text) {
	store.set({ chatQuote: { entryId, text }, sheet: { type: "chat" }, drawer: false });
}

// Tell the server when this tab is hidden or shown: others see "away", and push notifications only reach hidden tabs.
let lastVisible = null;
function reportVisibility() {
	const visible = document.visibilityState === "visible";
	if (visible === lastVisible || !collab()) return;
	lastVisible = visible;
	api("visibility", { tab: TAB, visible }).catch(() => {});
}
document.addEventListener("visibilitychange", reportVisibility);
store.subscribe((state) => {
	// Report again after each (re)connect: the server starts every new connection as visible.
	if (state.connection !== "open") lastVisible = null;
	else if (lastVisible === null && document.visibilityState !== "visible") reportVisibility();
});

export function closeSheet() {
	store.set({ sheet: null });
}

// Per-conversation composer drafts survive reloads, including the automatic ones after a live edit.
export const drafts = {
	get: (id) => localStorage.getItem(`pocket.draft.${id ?? "home"}`) ?? "",
	set: (id, text) => {
		if (text) localStorage.setItem(`pocket.draft.${id ?? "home"}`, text);
		else localStorage.removeItem(`pocket.draft.${id ?? "home"}`);
	},
};
