// What this browser has seen: when it last looked at each session, by the server's clock, so a run that ended since
// is new. Peek tiles show those sessions, and the session list's squares turn solid for them. Opening a session is
// looking at it, and so is having it open in sight when its run ends.
//
// Kept per browser, in localStorage, like pins and marks. To share it between someone's devices, the server would keep
// each person's marks (a per-user document beside `SessionsDoc`), `markSeen` would send them, and the session list
// would carry them back; `finishedUnseen` would not change.
import { store } from "./store.js";

/** Each session's seen mark is a key of its own, so tabs that mark different sessions at once keep both. */
const SEEN_PREFIX = "pocket.peekSeen.";
/** Marks older than this are forgotten: the run they saw is long over, and the server has likely restarted since. */
const SEEN_KEEP_MS = 30 * 24 * 60 * 60_000;
const SINCE_KEY = "pocket.peekSince";

const hidden = () => document.visibilityState === "hidden";

/** How far the server's clock is ahead of this browser's, from its last hello: runs end by the server's clock. */
let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;

/** A time the server took (its clock), on this device's clock: a phone set a few minutes off still counts right. */
export const fromServer = (ms) => ms - clockOffset;

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

        if (store.state.peekSeen?.[id] !== at) {
            changed[id] = at;
        }
    }

    if (Object.keys(changed).length > 0) {
        store.set({ peekSeen: { ...store.state.peekSeen, ...changed } });
    }
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

store.subscribe((state) => {
    if (state.server !== lastServer) {
        lastServer = state.server;

        if (typeof state.server?.now === "number") {
            clockOffset = state.server.now - Date.now();

            if (since === null) {
                since = state.server.now;
                localStorage.setItem(SINCE_KEY, String(since));
            }
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

document.addEventListener("visibilitychange", () => seeOpen(store.state));
