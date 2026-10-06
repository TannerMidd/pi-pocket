// App state, the server connection, and API calls. Components read `store.state` and re-render on `store.subscribe`.

/** A random id. crypto.randomUUID only exists on https and localhost pages; plain-http network addresses lack it. */
export function uid() {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    const bytes = crypto.getRandomValues(new Uint8Array(16));

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** How many transcript rows a session shows when opened; "Show earlier messages" adds this many more. */
export const TRANSCRIPT_ROWS = 60;

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
    plan: { on: false },
    schedules: [],
    goal: null,
});

export const store = {
    state: {
        me: undefined, // undefined: unknown, null: signed out
        users: [],
        models: [],
        guard: null,
        server: null,
        sessions: [],
        /** False until the server's first session list arrives: an empty list until then means "not here yet". */
        sessionsLoaded: false,
        /** Sessions on their way into the archive (true) or out of it (false), by id, until the list catches up (`sessions.js`). */
        moving: {},
        conversationId: routeConversation(),
        view: emptyView(),
        ...peopleFor(routeConversation()),
        history: null,
        /** The id of the oldest transcript entry shown, or null for the newest `TRANSCRIPT_ROWS` rows. */
        transcriptFrom: null,
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
        /** Pi's prompt templates for a conversation's folder: `{ conversationId, at, list }`. */
        templates: null,
        /** Counts the lists of files for @ mentions that arrived; the lists themselves are kept in `files.js`. */
        filesLoaded: 0,
        /** `!` commands this tab started that have no entry yet: `{ taskId, command, conversationId, at }`. */
        pendingShells: [],
        /** The session's browser page as the server last told: address, title, loading, size (`browser.js`). */
        browser: null,
        /** The Browser panel shows; kept per tab, so the reload after a live edit keeps it. */
        browserOpen: sessionStorage.getItem("pocket.browser") === "1",
        /** The People panel shows beside the conversation on wide screens; kept per tab, like the browser's. */
        peopleOpen: sessionStorage.getItem("pocket.people") === "1",
        /** The last request to show the People panel: which tab and chat message, and a count that tells requests apart. */
        peopleAsk: { tab: null, highlight: null, n: 0 },
    },
    listeners: new Set(),
    set(patch) {
        this.state = {
            ...this.state,
            ...(typeof patch === "function" ? patch(this.state) : patch),
        };

        for (const listener of this.listeners) {
            listener(this.state);
        }
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
    return {
        chat: [],
        presence: [],
        notes: null,
        chatQuote: null,
        chatRead: id === null ? 0 : chatReadOf(id),
    };
}

/** How far this browser has read a conversation's chat: the time of the newest message seen. */
export function chatReadOf(id) {
    return Number(localStorage.getItem(readKey(id)) ?? 0);
}

/** Someone else chatted in a session after this browser last read its chat. */
export function sessionUnread(session, state = store.state) {
    const read = session.id === state.conversationId ? state.chatRead : chatReadOf(session.id);

    return session.chatAt !== undefined && session.chatBy !== state.me?.id && session.chatAt > read;
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

    if (last <= chatRead || conversationId === null) {
        return;
    }

    localStorage.setItem(readKey(conversationId), String(last));
    store.set({ chatRead: last });
}

function applyChat(data) {
    const state = store.state;

    if (data.conversationId !== state.conversationId) {
        return;
    }

    const known = new Set(data.full ? [] : state.chat.map((message) => message.id));
    const added = data.messages.filter((message) => !known.has(message.id));

    store.set({ chat: (data.full ? data.messages : [...state.chat, ...added]).slice(-CHAT_LIMIT) });

    // The People panel stays open for long: on its Pinned or Notes tab, new messages still count and show a notice.
    if (state.sheet?.type === "chat" || chatLogs > 0) {
        markChatRead();

        return;
    }

    // A full list comes on connect: only live messages from others pop up.
    const fresh = data.full
        ? []
        : added.filter((message) => message.userId !== state.me?.id && message.kind !== "event");

    if (fresh.length === 0) {
        return;
    }

    const open = () => openSheet({ type: "chat" });

    if (fresh.length > 1) {
        return notify("info", `${fresh.length} new chat messages`, open);
    }

    const [message] = fresh;
    const name = state.users.find((user) => user.id === message.userId)?.name ?? message.name;
    const text = message.text.replace(/\s+/g, " ");
    const mentioned = message.mentions?.includes(state.me?.id);

    notify(
        "info",
        `${name}${mentioned ? " mentioned you" : ""}: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`,
        open,
    );
}

let typingSent = { where: null, at: 0, conversationId: null };

/** Tell others this person is typing ("chat" or "pi") or stopped (null). Renewed at most every few seconds. */
export function typing(where) {
    const id = store.state.conversationId;

    if (!store.state.server?.chat || id === null) {
        return;
    }

    const now = Date.now();
    const same = typingSent.conversationId === id && typingSent.where === where;

    if (same && (where === null || now - typingSent.at < 3000)) {
        return;
    }

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
    const init = {
        method: body === undefined && !options.method ? "GET" : (options.method ?? "POST"),
        headers: { "X-Pocket": "1" },
    };

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

    if (!response.ok) {
        throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
    }

    return data;
}

let nextNotice = 1;

/** Show a short notice. With `action`, tapping it runs the action as well as dismissing it. */
export function notify(level, message, action) {
    const id = nextNotice++;

    store.set((state) => ({
        notices: [...state.notices, { id, level, message, action }].slice(-4),
    }));
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
        const base =
            data.full || state.view.conversation?.id !== data.conversation.id
                ? emptyView()
                : state.view;
        const entries = new Map(base.entries);

        for (const entry of data.entries) {
            entries.set(entry.id, entry);
        }

        const order = data.order ?? base.order;

        if (data.order) {
            const keep = new Set(data.order);

            for (const id of entries.keys()) {
                if (!keep.has(id)) {
                    entries.delete(id);
                }
            }
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
                // The server sends these again only when they change: a missing one keeps its last value.
                artifacts: data.artifacts ?? base.artifacts,
                subagents: data.subagents ?? base.subagents,
                authors: data.authors ?? base.authors,
                reactions: data.reactions ?? base.reactions,
                pins: data.pins ?? base.pins,
                turns: data.turns ?? base.turns,
                decisions: data.decisions ?? base.decisions,
                plan: data.plan ?? base.plan,
                schedules: data.schedules ?? base.schedules,
                // No goal is null, which the server sends too: only a missing field keeps the last value.
                goal: data.goal === undefined ? base.goal : data.goal,
            },
            missing: null,
        };
    });
}

/** The `moving` marks that a session list has not caught up with yet: it still shows those sessions where they were. */
export function stillMoving(moving, sessions) {
    const next = { ...moving };

    for (const session of sessions) {
        if (next[session.id] === Boolean(session.archived)) {
            delete next[session.id];
        }
    }

    return next;
}

/** What the server sends, by event name. Both transports deliver the same events. */
const handlers = {
    hello: (data) =>
        store.set({
            me: data.user,
            users: data.users,
            models: data.models,
            guard: data.guard,
            server: data.server,
        }),
    sessions: (sessions) =>
        store.set((state) => ({
            sessions,
            sessionsLoaded: true,
            moving: stillMoving(state.moving, sessions),
        })),
    models: (models) => store.set({ models }),
    view: applyView,
    chat: applyChat,
    presence: (data) =>
        data.conversationId === store.state.conversationId && store.set({ presence: data.people }),
    notes: (data) =>
        data.conversationId === store.state.conversationId &&
        store.set({ notes: { text: data.text, rev: data.rev, by: data.by, at: data.at } }),
    browser: (data) =>
        data.conversationId === store.state.conversationId && store.set({ browser: data }),
    // Another session as its peek tile shows it (`peeks.js`): kept after it scrolls away, as the tile's last look.
    peek: (data) =>
        store.set((state) => ({ peeks: { ...state.peeks, [data.conversationId]: data } })),
    users: (users) => store.set({ users }),
    missing: (data) => store.set({ missing: data.message }),
    // A notice may link to a conversation, such as a mention elsewhere: tapping it goes there.
    notice: (data) =>
        notify(
            data.level,
            data.message,
            data.link
                ? () =>
                      navigate(data.link.conversationId, {
                          sheet: data.link.sheet ? { type: data.link.sheet } : null,
                      })
                : undefined,
        ),
    auth: (data) => handleAuth(data),
    closing: () => store.set({ connection: "closed" }),
    reload: () => {
        // A web file changed on the server. Message drafts live in localStorage and survive the reload; an unsaved notes
        // draft, attachments not yet sent, and an open provider sign-in do not.
        setTimeout(() => location.reload(), 150);
    },
};

const TRANSPORT_KEY = "pocket.transport";
const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname);
/** After an event stream stalls on this address, poll for a day, then try the stream again: one slow start is not forever. */
const POLL_FOR_MS = 24 * 60 * 60_000;

const pollHere = () => {
    const saved = localStorage.getItem(TRANSPORT_KEY) ?? "";

    // Saved before the choice had a time: a choice made now.
    if (saved === "poll") {
        localStorage.setItem(TRANSPORT_KEY, `poll:${Date.now()}`);
    }

    const [mode, at] = (localStorage.getItem(TRANSPORT_KEY) ?? "").split(":");

    return mode === "poll" && Date.now() - Number(at) < POLL_FOR_MS;
};

/** Event stream reconnects in a row that the browser gave up on, for the pause before the next one. */
let streamRetries = 0;

const connected = () => store.state.connection !== "open" && store.set({ connection: "open" });

export function connect() {
    source?.close();
    store.set({ connection: "connecting" });
    const id = store.state.conversationId;
    const query = `tab=${encodeURIComponent(TAB)}${id === null ? "" : `&c=${id}`}`;

    source = pollHere() && !local ? pollEvents(query) : streamEvents(query);
}

// A page kept for Back and Forward stays alive, frozen, and so would its stream: each holds one of the few connections a
// browser makes to a server, and after a handful nothing else loads. It closes on leaving and reconnects on return.
addEventListener("pagehide", () => {
    source?.close();
    source = null;
});
addEventListener("pageshow", (event) => {
    if (event.persisted) {
        connect();
    }
});

/** Server-sent events: one long response the server writes to as things change. */
function streamEvents(query) {
    const events = new EventSource(`/api/events?${query}`);
    /** The first batch arrived whole: the session's view, or the session list when no session is open. */
    let settled = false;
    const settles = query.includes("&c=") ? ["view", "missing"] : ["sessions"];
    const connection = {
        close() {
            clearTimeout(fallback);
            events.close();
        },
    };
    // Some tunnels hold the stream back. A Cloudflare quick tunnel passes it on in 64 KiB blocks and keeps the rest, so
    // a long session's first view can stop partway after its small first events got through. The stream counts as
    // working only once that first batch is whole; otherwise poll instead, and remember that for this address.
    const fallback = local
        ? undefined
        : setTimeout(() => {
              if (settled || source !== connection) {
                  return;
              }

              localStorage.setItem(TRANSPORT_KEY, `poll:${Date.now()}`);
              connect();
          }, 6000);

    for (const [name, handler] of Object.entries(handlers)) {
        events.addEventListener(name, (event) => {
            if (source !== connection) {
                return;
            }

            if (settles.includes(name)) {
                settled = true;
            }

            handler(JSON.parse(event.data));
        });
    }

    events.onopen = () => {
        if (source !== connection) {
            return;
        }

        streamRetries = 0;
        connected();
    };

    events.onerror = async () => {
        if (source !== connection) {
            return;
        }

        store.set({ connection: "closed" });

        // EventSource retries by itself after a network error; a 401 needs a sign-in instead.
        try {
            await api("me");
        } catch (error) {
            if (error.status === 401) {
                connection.close();
                store.set({ me: null });

                return;
            }
        }

        // It gives up for good when a retry gets an answer other than 200, such as a tunnel's 502 while the server
        // restarts. Start a new stream after a pause that grows with each try.
        if (events.readyState === EventSource.CLOSED && source === connection) {
            // A stream that failed was not held back: no reason to switch this address to polling.
            clearTimeout(fallback);
            streamRetries++;
            setTimeout(
                () => source === connection && connect(),
                Math.min(10_000, 1000 * streamRetries),
            );
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

            if (session) {
                fetch(`/api/poll?session=${session}&close=1`, { keepalive: true }).catch(() => {});
            }
        },
    };

    (async () => {
        let failures = 0;

        while (!stopped) {
            request = new AbortController();

            try {
                const response = await fetch(
                    `/api/poll?${query}${session ? `&session=${session}&ack=${ack}` : ""}`,
                    { signal: request.signal, cache: "no-store" },
                );

                if (response.status === 401) {
                    stopped = true;
                    store.set({ me: null });

                    return;
                }

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();

                if (stopped || source !== connection) {
                    return;
                }

                if (data.session !== session) {
                    // A new session (first poll, or the server restarted): it starts with hello and a full view.
                    session = data.session;
                    ack = 0;
                }

                failures = 0;
                connected();

                for (const item of data.events) {
                    if (item.seq <= ack) {
                        continue;
                    }

                    ack = item.seq;
                    handlers[item.event]?.(item.data);
                }
            } catch {
                if (stopped) {
                    return;
                }

                failures++;

                if (store.state.connection === "open") {
                    store.set({ connection: "closed" });
                }

                await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(10_000, 1000 * failures)),
                );
            }
        }
    })();

    return connection;
}

function handleAuth(data) {
    store.set((state) => {
        const flow =
            state.auth?.flowId === data.flowId
                ? state.auth
                : {
                      flowId: data.flowId,
                      providerId: data.providerId,
                      events: [],
                      prompt: null,
                      done: null,
                  };

        if (data.step === "prompt") {
            return { auth: { ...flow, prompt: { id: data.promptId, ...data.prompt } } };
        }

        if (data.step === "prompt-closed") {
            return { auth: flow.prompt?.id === data.promptId ? { ...flow, prompt: null } : flow };
        }

        if (data.step === "event") {
            return { auth: { ...flow, events: [...flow.events, data.event] } };
        }

        if (data.step === "done") {
            if (data.ok) {
                notify("info", `Signed in to ${data.providerId}.`);
            }

            return { auth: data.ok ? null : { ...flow, prompt: null, done: data } };
        }

        return {};
    });
}

export function navigate(conversationId, { replace = false, sheet = null } = {}) {
    const path = conversationId === null ? "/" : `/s/${conversationId}`;

    if (location.pathname !== path) {
        history[replace ? "replaceState" : "pushState"]({}, "", path);
    }

    if (store.state.conversationId === conversationId && source) {
        if (sheet) {
            openSheet(sheet);
        }

        return;
    }

    store.set((state) => ({
        conversationId,
        view: emptyView(),
        ...peopleFor(conversationId),
        browser: null,
        history: null,
        transcriptFrom: null,
        missing: null,
        drawer: false,
        ...sheetChange(sheet, state),
    }));
    connect();
}

addEventListener("popstate", () => {
    const id = routeConversation();

    if (id !== store.state.conversationId) {
        store.set({
            conversationId: id,
            view: emptyView(),
            ...peopleFor(id),
            browser: null,
            history: null,
            transcriptFrom: null,
            missing: null,
            sheet: null,
            drawer: false,
        });
        connect();
    }
});

export async function start() {
    try {
        const hello = await api("me");

        store.set({
            me: hello.user,
            users: hello.users,
            models: hello.models,
            guard: hello.guard,
            server: hello.server,
        });
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
    /** `inlineFiles`: the files the message mentions with @ go along with it. */
    submit: (text, attachments, mode, inlineFiles = false) =>
        api(`c/${current()}/submit`, {
            text,
            attachments,
            mode,
            requestId: uid(),
            ...(inlineFiles ? { inlineFiles } : {}),
        }),
    /** Run a command in the session's folder (`!`); `context: false` keeps it from Pi (`!!`). */
    shell: (command, context, requestId = uid()) =>
        api(`c/${current()}/shell`, { command, context, requestId }),
    stopShell: (taskId) => api(`c/${current()}/shell/${taskId}/stop`, {}),
    /** A file or folder for the viewer. */
    view: (path) => api(`c/${current()}/view?path=${encodeURIComponent(path)}`),
    /** Undo the uncommitted changes to one file. */
    revert: (path) => api(`c/${current()}/changes/revert`, { path }),
    abort: () => api(`c/${current()}/abort`, {}),
    chat: (text, quote) =>
        api(`c/${current()}/chat`, {
            text,
            requestId: uid(),
            ...(quote ? { quote: { entryId: quote.entryId } } : {}),
        }),
    react: (entryId, emoji) => api(`c/${current()}/react`, { entryId, emoji }),
    pin: (target) => api(`c/${current()}/pin`, target),
    saveNotes: (text, rev) => api(`c/${current()}/notes`, { text, rev }),
    turns: (action, to) => api(`c/${current()}/turns`, { action, ...(to ? { to } : {}) }),
    setAccess: (userId, patch) => api(`users/${encodeURIComponent(userId)}`, patch),
    withdraw: (submissionId) => api(`c/${current()}/withdraw`, { submissionId }),
    configure: (change) => api(`c/${current()}/configure`, change),
    compact: (instructions) => api(`c/${current()}/compact`, { instructions }),
    reset: (note) => api(`c/${current()}/reset`, { note }),
    setInstructions: (text) => api(`c/${current()}/instructions`, { text }),
    /** A new session with this one's history through `entryId`. */
    fork: (entryId, { worktree = false } = {}) =>
        api(`c/${current()}/fork`, { entryId, ...(worktree ? { worktree } : {}) }),
    /** Send a message to Pi again in a fork that ends just before it: `{ text }` edits it, `{ model }` picks another model. */
    resend: (entryId, change = {}) => api(`c/${current()}/resend`, { entryId, ...change }),
    setPlan: (on) => api(`c/${current()}/plan`, { on }),
    approvePlan: () => api(`c/${current()}/plan`, { approve: true }),
    prompts: () => api(`c/${current()}/prompts`),
    /** `when` says when, then what Pi gets: `in 2h check the deploy`. Clock times are this device's. */
    schedule: (when) =>
        api(`c/${current()}/schedules`, {
            when,
            zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
    cancelSchedule: (id) => api(`c/${current()}/schedules/${encodeURIComponent(id)}/cancel`, {}),
    setGoal: (command) => api(`c/${current()}/goal`, { command }),
    removeWorktree: (force) => api(`c/${current()}/worktree`, { remove: true, force }),
    clearGoal: () => api(`c/${current()}/goal`, { clear: true }),
    approve: (id, allow) => api(`approvals/${encodeURIComponent(id)}`, { allow }),
    /** `worktree`: the session works in a git worktree of its own, made from the folder. */
    createSession: (cwd, { worktree = false } = {}) =>
        api("sessions", { cwd, ...(worktree ? { worktree } : {}) }),
    updateSession: (id, patch) => api(`sessions/${id}`, patch),
    upload: (file) => api(`c/${current()}/upload?name=${encodeURIComponent(file.name)}`, file),
    fullEntry: (entryId) => api(`c/${current()}/entry/${entryId}`),
    history: (before) => api(`c/${current()}/history?before=${before}`),
};

/** Entries that show as transcript rows. Tool results show inside their call's card instead. */
export const isRow = (entry) =>
    ["user", "assistant", "compaction", "reset", "shell", "note"].includes(entry.kind);

/**
 * Show the transcript from this entry down when it is above the rows shown now, as for a jump to a pinned or quoted
 * message. Compares places in the transcript, not ids: after a compaction, the summary comes first with the newest id.
 */
export function revealEntry(entryId) {
    const { view, transcriptFrom } = store.state;

    if (transcriptFrom === null) {
        return;
    }

    const ids = view.order.filter((id) => {
        const entry = view.entries.get(id);

        return entry !== undefined && isRow(entry);
    });
    const at = ids.indexOf(entryId);
    const from = ids.indexOf(transcriptFrom);

    if (at !== -1 && (from === -1 || at < from)) {
        store.set({ transcriptFrom: entryId });
    }
}

// ─── The People panel ──────────────────────────────────────────────────────────────

const PEOPLE_KEY = "pocket.people";
/** Wide enough for the session list, the conversation, and a panel beside it: where the Browser panel docks too. */
const PEOPLE_DOCK = matchMedia("(min-width: 1100px)");

/** The People panel shows beside the conversation now. */
export function peopleDocked(state = store.state) {
    return (
        state.peopleOpen &&
        PEOPLE_DOCK.matches &&
        Boolean(state.server?.chat) &&
        state.conversationId !== null &&
        !state.missing
    );
}

/**
 * What showing a sheet changes. On wide screens the chat docks beside the conversation instead, as the People panel, and
 * takes the Browser panel's place: both beside the conversation leave it too narrow.
 */
function sheetChange(sheet, state) {
    if (sheet?.type !== "chat" || !PEOPLE_DOCK.matches) {
        return { sheet };
    }

    sessionStorage.setItem(PEOPLE_KEY, "1");
    sessionStorage.removeItem("pocket.browser");

    return {
        sheet: null,
        peopleOpen: true,
        browserOpen: false,
        peopleAsk: {
            tab: sheet.tab ?? null,
            highlight: sheet.highlight ?? null,
            n: state.peopleAsk.n + 1,
        },
    };
}

/** Hide the People panel. Showing it is `openSheet({ type: "chat" })`, which docks it on wide screens. */
export function closePeople() {
    sessionStorage.removeItem(PEOPLE_KEY);

    // Its active border goes to the conversation, not nowhere.
    if (document.documentElement.dataset.focus === "people") {
        document.documentElement.dataset.focus = "pane";
    }

    store.set({ peopleOpen: false });
}

let chatLogs = 0;

/** A chat log is on screen, as the People sheet's or panel's Chat tab: call when it shows, and what it returns when it goes. */
export function chatLogShown() {
    chatLogs++;

    return () => {
        chatLogs--;
    };
}

// A window widened with the chat open as a sheet docks it. One narrowed hides the panel until it is wide again.
PEOPLE_DOCK.addEventListener("change", () => {
    const { sheet } = store.state;

    if (PEOPLE_DOCK.matches && sheet?.type === "chat") {
        openSheet(sheet);
    } else {
        store.set({});
    }
});

export function openSheet(sheet) {
    store.set((state) => ({ ...sheetChange(sheet, state), drawer: false }));
}

/**
 * Put text into the message box to Pi (after what is there: on a new paragraph, or with `inline`, after a space), and
 * files to attach, and close any sheet so it shows.
 */
export function insertIntoComposer(text, files = [], { inline = false } = {}) {
    store.set((state) => ({
        sheet: null,
        composerInsert: { text, files, inline, n: (state.composerInsert?.n ?? 0) + 1 },
    }));
}

/** Open the chat to discuss a transcript message: the next chat message quotes it. */
export function discuss(entryId, text) {
    store.set((state) => ({
        chatQuote: { entryId, text },
        ...sheetChange({ type: "chat" }, state),
        drawer: false,
    }));
}

// Tell the server when this tab is hidden or shown: others see "away", and push notifications only reach hidden tabs.
let lastVisible = null;

function reportVisibility() {
    const visible = document.visibilityState === "visible";

    if (visible === lastVisible || !collab()) {
        return;
    }

    lastVisible = visible;
    api("visibility", { tab: TAB, visible }).catch(() => {});
}

document.addEventListener("visibilitychange", reportVisibility);
store.subscribe((state) => {
    // Report again after each (re)connect: the server starts every new connection as visible.
    if (state.connection !== "open") {
        lastVisible = null;
    } else if (lastVisible === null && document.visibilityState !== "visible") {
        reportVisibility();
    }
});

export function closeSheet() {
    store.set({ sheet: null });
}

// Per-conversation composer drafts survive reloads, including the automatic ones after a live edit.
export const drafts = {
    get: (id) => localStorage.getItem(`pocket.draft.${id ?? "home"}`) ?? "",
    set: (id, text) => {
        if (text) {
            localStorage.setItem(`pocket.draft.${id ?? "home"}`, text);
        } else {
            localStorage.removeItem(`pocket.draft.${id ?? "home"}`);
        }
    },
};
