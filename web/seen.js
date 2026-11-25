// What this browser has seen: when it last looked at each session, by the server's clock, so a run that ended since
// is new. Peek tiles show those sessions, and the session list's squares turn solid for them. Opening a session is
// looking at it, and so is having it open in sight when its run ends.
//
// Kept per browser, in localStorage, like pins and marks, and shared with the person's other tabs and devices through
// the server: each look is sent as it is made (`POST /api/seen`, best effort), and a look from elsewhere (`seen` events,
// `seenRemote`) that is later than ours becomes ours. A look is a time on the server's clock and only grows, so a lost
// or late one does no harm, and a restart that makes the server forget them forgets the runs they were compared with
// too. `since` stays this browser's own: a look from elsewhere only adds to what it has seen.
import { onPageVisibility, pageVisible } from "./host.js";
import { api, serverClockOffset, store } from "./store.js";

/** Each session's seen mark is a key of its own, so tabs that mark different sessions at once keep both. */
const SEEN_PREFIX = "pocket.peekSeen.";
/** Marks older than this are forgotten: the run they saw is long over, and the server has likely restarted since. */
const SEEN_KEEP_MS = 30 * 24 * 60 * 60_000;
const SINCE_KEY = "pocket.peekSince";

const hidden = () => !pageVisible();

/** The server's time now: runs end by the server's clock, which each hello gives (`serverClockOffset`). */
const serverNow = () => Date.now() + serverClockOffset();

/** A time the server took (its clock), on this device's clock: a phone set a few minutes off still counts right. */
export const fromServer = (ms) => ms - serverClockOffset();

function readSeen() {
    const seen = {};

    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        const at = key?.startsWith(SEEN_PREFIX) ? Number(localStorage.getItem(key)) : 0;

        if (at > 0) {
            seen[key.slice(SEEN_PREFIX.length)] = at;
        }
    }

    return seen;
}

for (const [id, at] of Object.entries(readSeen())) {
    if (Date.now() - at > SEEN_KEEP_MS) {
        localStorage.removeItem(SEEN_PREFIX + id);
    }
}

/** Runs that ended before this browser first had these marks are old news. The server's time; null until it said. */
let since = Number(localStorage.getItem(SINCE_KEY)) || null;

store.set({ peekSeen: readSeen() });

// Another tab of this browser marked a session seen (or cleared the storage).
addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith(SEEN_PREFIX)) {
        store.set({ peekSeen: readSeen() });
    }
});

/** Looks not sent yet, by session: all that come in one turn of the event loop go in one request. */
const outgoing = new Map();
let sending = false;

/** Send a look to the server, which tells the person's other tabs. A failure is let go: the look is still ours. */
function publish(id, at) {
    outgoing.set(id, Math.max(outgoing.get(id) ?? 0, at));

    if (!sending) {
        sending = true;
        queueMicrotask(() => {
            // The server takes whole numbers; the clock's offset can leave a fraction, which is cut (never below `ended`).
            const items = [...outgoing].map(([each, time]) => ({
                id: Number(each),
                at: Math.floor(time),
            }));

            sending = false;
            outgoing.clear();

            for (let from = 0; from < items.length; from += MAX_SENT) {
                api("seen", { items: items.slice(from, from + MAX_SENT) }).catch(() => {});
            }
        });
    }
}

/** The most looks one request carries (the server's `MAX_SEEN_ITEMS`). */
const MAX_SENT = 500;

/**
 * Sessions whose look was undone here, and when: a look from another device that is not later than the undoing stays
 * out, so Undo holds on this device. Not kept across a reload.
 */
const undone = new Map();

/** Looks from the person's other devices that are later than ours become ours; nothing is sent back. */
function takeRemote(remote) {
    const changed = {};

    for (const [id, at] of Object.entries(remote)) {
        const key = SEEN_PREFIX + id;
        const have = Math.max(Number(localStorage.getItem(key)) || 0, undone.get(id) ?? 0);

        if (at > have) {
            localStorage.setItem(key, String(at));
            changed[id] = at;
        }
    }

    if (Object.keys(changed).length > 0) {
        store.set({ peekSeen: { ...store.state.peekSeen, ...changed } });
    }
}

/**
 * Remember that this browser looked at sessions now: a run that ended before is no longer new. One change to the store
 * for all of them, and none when their marks are as they were (each change draws the whole app).
 */
export function markSeen(...ids) {
    const changed = {};

    for (const id of ids) {
        const key = SEEN_PREFIX + id;
        const ended = store.state.sessions.find((session) => session.id === id)?.endedAt ?? 0;
        // The latest look counts, whichever tab made it; the run's own end counts too, in case the clocks disagree.
        const at = Math.max(Number(localStorage.getItem(key)) || 0, serverNow(), ended);

        localStorage.setItem(key, String(at));
        publish(id, at);

        if (store.state.peekSeen?.[id] !== at) {
            changed[id] = at;
        }
    }

    if (Object.keys(changed).length > 0) {
        store.set({ peekSeen: { ...store.state.peekSeen, ...changed } });
    }
}

export function seenSnapshot(ids) {
    return Object.fromEntries(ids.map((id) => [id, store.state.peekSeen?.[id] ?? 0]));
}

/** With `expected`, only looks still as the marking left them go back: a session looked at since stays seen. */
export function restoreSeen(snapshot, expected) {
    const peekSeen = { ...store.state.peekSeen };
    const back = new Set();

    for (const [id, at] of Object.entries(snapshot)) {
        const now = Number(localStorage.getItem(SEEN_PREFIX + id)) || 0;

        if (expected !== undefined && now !== (expected[id] ?? 0)) {
            continue;
        }

        back.add(Number(id));
        undone.set(id, serverNow());

        if (at > 0) {
            localStorage.setItem(SEEN_PREFIX + id, String(at));
            peekSeen[id] = at;
        } else {
            localStorage.removeItem(SEEN_PREFIX + id);
            delete peekSeen[id];
        }
    }

    store.set({ peekSeen });

    return back;
}

/**
 * A session whose run ended since this browser last had it open. A run older than the marks are kept counts as seen:
 * its mark may be gone, with the server up all that time.
 */
export function finishedUnseen(session, state = store.state) {
    return (
        since !== null &&
        !session.busy &&
        session.endedAt !== undefined &&
        serverNow() - session.endedAt < SEEN_KEEP_MS &&
        session.endedAt > Math.max(since, state.peekSeen?.[session.id] ?? 0)
    );
}

/** What `finishedUnseen` depends on besides the state: a memo of it keys on this too. */
export const seenSince = () => since;

let previous = store.state.conversationId;
/** When the open session's last run ended, as this tab last marked it seen. */
let openEnded;
let lastServer;

/** A run that ends while its session is open in sight is seen as it ends. */
function seeOpen(state) {
    const id = state.conversationId;
    const ended = state.sessions.find((session) => session.id === id)?.endedAt;

    if (id !== null && ended !== undefined && ended !== openEnded && !hidden()) {
        openEnded = ended;
        markSeen(id);
    }
}

let lastRemote = store.state.seenRemote;

store.subscribe((state) => {
    if (state.seenRemote !== lastRemote) {
        lastRemote = state.seenRemote;
        takeRemote(lastRemote);
    }

    if (state.server !== lastServer) {
        lastServer = state.server;

        if (typeof state.server?.now === "number" && since === null) {
            since = state.server.now;
            localStorage.setItem(SINCE_KEY, String(since));
        }
    }

    // Leaving a session sees it as it was left; opening one sees it.
    if (state.conversationId !== previous) {
        const left = previous;

        previous = state.conversationId;
        openEnded = undefined;
        markSeen(...[left, state.conversationId].filter((id) => id !== null));
    }

    seeOpen(store.state);
});

onPageVisibility(() => seeOpen(store.state));
