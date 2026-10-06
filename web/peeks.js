// Peek tiles: other sessions' live work beside the open one. Wide screens show a column of tiles where the People and
// Browser panels dock (when neither is open), narrower ones a strip under the top bar. Tiles are the sessions working,
// waiting for approval, finished since this browser last looked, and pinned, plus the one just left. Only tiles on
// screen are live: once scrolling settles, the tab tells the server which (`POST /api/peeks`), and the rest keep the
// lines they last had. Their state marks stay current from the session list, which covers every session.
import { useEffect, useRef, useState } from "preact/hooks";
import { workspaceOrder } from "./sessions.js";
import { actions, api, attempt, canSteer, navigate, store, TAB } from "./store.js";
import { prefs } from "./theme.js";
import { describeCall } from "./transcript.js";
import { html, Icon, shortPath } from "./ui.js";

/** Wide enough for the column beside the conversation: where People and the Browser panel dock too. */
export const PEEK_WIDE = matchMedia("(min-width: 1100px)");
/** How long the tiles on screen must stay put before the server hears of them: scrolling past is not looking. */
const SETTLE_MS = 250;
/** As many as the server keeps live for a tab (`MAX_PEEKS`). */
const MAX_LIVE = 12;
const SEEN_KEY = "pocket.peekSeen";
const SINCE_KEY = "pocket.peekSince";

PEEK_WIDE.addEventListener("change", () => store.set({}));

function readSeen() {
    try {
        return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") ?? {};
    } catch {
        return {};
    }
}

/** Runs that ended before this browser first had peeks are old news, not something new to look at. */
const since =
    Number(localStorage.getItem(SINCE_KEY)) ||
    (() => {
        const now = Date.now();

        localStorage.setItem(SINCE_KEY, String(now));

        return now;
    })();

store.set({ peeks: {}, peekSeen: readSeen() });

/** Remember that this browser looked at a session now: a run that ended before is no longer new. */
export function markSeen(id) {
    const { sessions, sessionsLoaded } = store.state;
    const known = new Set(sessions.map((session) => String(session.id)));
    const seen = Object.fromEntries(
        Object.entries({ ...store.state.peekSeen, [id]: Date.now() }).filter(
            ([key]) => !sessionsLoaded || known.has(key),
        ),
    );

    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    store.set({ peekSeen: seen });
}

/** A session whose run ended since this browser last had it open. */
export function finishedUnseen(session, state = store.state) {
    return (
        !session.busy &&
        session.endedAt !== undefined &&
        session.endedAt > Math.max(since, state.peekSeen?.[session.id] ?? 0)
    );
}

// ─── Which sessions are tiles, in a steady order ─────────────────────────────────────

/** The tiles' order: kept as sessions come and go, so a tile stays where it was until it no longer belongs. */
let slots = [];
/** The session open before this one: it stays a tile, in the place of the one that was opened. */
let lastLeft = null;
let previous = store.state.conversationId;

store.subscribe((state) => {
    if (state.conversationId === previous) {
        return;
    }

    const left = previous;
    const at = slots.indexOf(state.conversationId);

    previous = state.conversationId;

    if (left !== null) {
        lastLeft = left;

        if (at >= 0) {
            slots[at] = left;
        }

        markSeen(left);
    }

    if (state.conversationId !== null) {
        markSeen(state.conversationId);
    }
});

const rank = (session, state) =>
    session.waiting
        ? 0
        : session.busy
          ? 1
          : finishedUnseen(session, state)
            ? 2
            : state.pinned.includes(session.id)
              ? 3
              : 4;

/** The sessions shown as tiles now, in tile order. */
export function peekTiles(state = store.state) {
    const shown = state.sessions.filter(
        (session) =>
            !session.archived &&
            session.id !== state.conversationId &&
            (session.busy ||
                session.waiting ||
                finishedUnseen(session, state) ||
                state.pinned.includes(session.id) ||
                session.id === lastLeft),
    );
    const ids = new Set(shown.map((session) => session.id));

    slots = slots.filter((id) => ids.has(id));
    const fresh = shown
        .filter((session) => !slots.includes(session.id))
        .sort((a, b) => rank(a, state) - rank(b, state));

    slots.push(...fresh.map((session) => session.id));
    const byId = new Map(shown.map((session) => [session.id, session]));

    return slots.map((id) => byId.get(id));
}

/** Peeks show in this session: turned on, a server that sends them, and a session open. */
export function peeksWanted(state = store.state) {
    return (
        prefs().peeks !== false &&
        state.server?.peeks === true &&
        state.conversationId !== null &&
        !state.missing
    );
}

// ─── What is on screen, and telling the server ───────────────────────────────────────

/** Each tile element the observers watch, and whether it is on screen. */
const onScreen = new Map();
let settleTimer = 0;
let sentKey = null;
let lastServer = store.state.server;

function screenIds() {
    const ids = [];

    for (const [element, visible] of onScreen) {
        if (!element.isConnected) {
            onScreen.delete(element);
        } else if (visible) {
            ids.push(Number(element.dataset.peek));
        }
    }

    return [...new Set(ids)].slice(0, MAX_LIVE);
}

function settle(delay = SETTLE_MS) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(sendScreen, delay);
}

function sendScreen() {
    if (store.state.server?.peeks !== true) {
        return;
    }

    const ids = screenIds();
    const key = ids.join(",");

    if (key === sentKey) {
        return;
    }

    sentKey = key;
    api("peeks", { tab: TAB, ids }).catch(() => {
        // Try again with the next change: the server may be restarting.
        sentKey = null;
    });
}

// Every connection to the server starts without tiles (a session switch reconnects, as does a restart): say again
// which are on screen.
store.subscribe((state) => {
    if (state.server !== lastServer) {
        lastServer = state.server;
        sentKey = null;
        settle(0);
    }
});

/** Watch a scrolling list's tiles for being on screen, and tell the server once they settle. */
function useOnScreen(list) {
    const observer = useRef(null);

    useEffect(() => {
        const root = list.current;
        const watcher = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    onScreen.set(entry.target, entry.isIntersecting);
                }

                settle();
            },
            { root },
        );

        observer.current = watcher;

        return () => {
            watcher.disconnect();

            for (const element of onScreen.keys()) {
                if (root.contains(element) || !element.isConnected) {
                    onScreen.delete(element);
                }
            }

            settle();
        };
    }, []);

    // New tiles join the watch; observing one twice does nothing. Tiles that went are forgotten.
    useEffect(() => {
        let gone = false;

        for (const element of list.current.querySelectorAll("[data-peek]")) {
            observer.current.observe(element);
        }

        for (const element of onScreen.keys()) {
            if (!element.isConnected) {
                onScreen.delete(element);
                gone = true;
            }
        }

        if (gone) {
            settle();
        }
    });
}

/** Tiles waiting for approval that are scrolled out of the column, above and below. */
function useAwayWaiting(list) {
    const [away, setAway] = useState({ up: [], down: [] });

    const measure = () => {
        const box = list.current;

        if (!box) {
            return;
        }

        const up = [];
        const down = [];

        for (const tile of box.querySelectorAll(".peek.waiting")) {
            const id = Number(tile.dataset.peek);

            if (tile.offsetTop + tile.offsetHeight <= box.scrollTop + 4) {
                up.push(id);
            } else if (tile.offsetTop >= box.scrollTop + box.clientHeight - 4) {
                down.push(id);
            }
        }

        setAway((before) =>
            before.up.join() === up.join() && before.down.join() === down.join()
                ? before
                : { up, down },
        );
    };

    useEffect(measure);
    useEffect(() => {
        const box = list.current;
        let frame = 0;

        const scrolled = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(measure);
        };

        box.addEventListener("scroll", scrolled, { passive: true });

        return () => {
            cancelAnimationFrame(frame);
            box.removeEventListener("scroll", scrolled);
        };
    }, []);

    return away;
}

// ─── Tiles ──────────────────────────────────────────────────────────────────────────

function Status({ status }) {
    if (status === "running") {
        return html`<span class="peek-run" title="Running">…</span>`;
    }

    return status === "error" ? html`<span class="err" title="Failed">✕</span>` : null;
}

function PeekLine({ line }) {
    switch (line.kind) {
        case "user":
            return html`<div class="peek-line user">
                <span class="peek-mark">›</span> ${line.from && html`<b>${line.from}</b> `}${line.text}
            </div>`;
        case "text":
            return html`<div class="peek-line text"><span class="pi">π</span> ${line.text}</div>`;

        case "tool": {
            const call = describeCall({ name: line.name, args: line.args });

            return html`<div class="peek-line">
                <span class="peek-mark">${call.icon}</span> ${call.label} ${call.subject}${" "}
                <${Status} status=${line.status} />
            </div>`;
        }

        case "shell":
            return html`<div class="peek-line">
                <span class="peek-mark">$</span> ${line.command}${" "}
                <${Status} status=${line.status} />
            </div>`;
        case "note":
            return html`<div class="peek-line faint">${line.name}: ${line.text}</div>`;
        case "error":
            return html`<div class="peek-line err">${line.text}</div>`;
        default:
            return html`<div class="peek-line faint">${line.text}</div>`;
    }
}

/** Allow or deny a call from its tile, as from its card: the same rules, the same request. */
function PeekApproval({ approval }) {
    const { me, server } = store.state;
    const [busy, setBusy] = useState(false);

    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
    };

    const ownCall =
        server?.approvalRule === "others" &&
        me?.role !== "owner" &&
        approval.requestedBy === me?.id;

    return html`<span class="peek-actions">
        <button class="button small" disabled=${busy} onClick=${() => answer(false)}>Deny</button>
        ${
            !ownCall &&
            html`<button
                class="button small primary"
                disabled=${busy}
                onClick=${() => answer(true)}
            >
                Allow
            </button>`
        }
    </span>`;
}

function PeekTile({ session, number, compact }) {
    const state = store.state;
    const peek = state.peeks?.[session.id];
    const unseen = finishedUnseen(session, state);
    const status = session.waiting
        ? "waiting"
        : session.busy
          ? "working"
          : unseen
            ? "done"
            : "idle";
    const label =
        status === "waiting"
            ? "needs you"
            : status === "working"
              ? "working"
              : status === "done"
                ? "done · new"
                : session.id === lastLeft
                  ? "just left"
                  : "pinned";
    const approval = peek?.approvals?.[0];
    const lines = peek?.lines;
    const shown = compact ? (lines ?? []).slice(-1) : lines;
    const title = session.title ?? "New session";
    const open = () => navigate(session.id);
    const mark =
        status === "waiting"
            ? html`<span class="state-warn">!</span>`
            : status === "working"
              ? html`<span class="mini-sweep"><i></i><i></i><i></i></span>`
              : html`<span class="state-idle"></span>`;

    return html`<div class=${`peek ${status}`} data-peek=${session.id}>
        <button class="peek-head" title=${`Open ${title}`} onClick=${open}>
            <span class="session-state">${mark}</span>
            <span class="peek-name">
                <span class="peek-title">${title}</span>
                <span class="peek-cwd mono">${shortPath(session.cwd, state.server?.home)}</span>
            </span>
            ${
                number !== undefined &&
                number < 9 &&
                html`<kbd class="session-num">${number + 1}</kbd>`
            }
        </button>
        <div class="peek-lines mono" onClick=${open}>
            ${
                shown === undefined
                    ? html`<span class="peek-skeleton"><i></i><i></i><i></i></span>`
                    : shown.map((line, index) => html`<${PeekLine} key=${index} line=${line} />`)
            }
            ${
                approval &&
                html`<div class="peek-line ask">
                    <${Icon} name="shield" size=${11} /> ${approval.tool}: ${approval.subject}
                </div>`
            }
        </div>
        <div class="peek-foot">
            <span class="peek-status">${label}</span>
            ${
                approval &&
                canSteer() &&
                html`<${PeekApproval} key=${approval.id} approval=${approval} />`
            }
            ${
                status === "done" &&
                html`<button
                    class="icon-button peek-seen"
                    title="Mark as seen"
                    aria-label="Mark as seen"
                    onClick=${() => markSeen(session.id)}
                >
                    <${Icon} name="check" size=${14} />
                </button>`
            }
        </div>
    </div>`;
}

const numbers = () => new Map(workspaceOrder().map((session, index) => [session.id, index]));

/** Wide screens: the tiles as a column beside the conversation, scrolling, with the way to calls waiting out of view. */
export function PeekColumn({ tiles }) {
    const list = useRef(null);
    const away = useAwayWaiting(list);
    const order = numbers();
    const reveal = (id) =>
        list.current
            ?.querySelector(`[data-peek="${id}"]`)
            ?.scrollIntoView({ block: "nearest", behavior: "smooth" });

    useOnScreen(list);

    return html`<aside class="peeks window" aria-label="Peeks">
        <div class="peeks-list" ref=${list}>
            ${tiles.map(
                (session) =>
                    html`<${PeekTile}
                        key=${session.id}
                        session=${session}
                        number=${order.get(session.id)}
                    />`,
            )}
        </div>
        ${
            away.up.length > 0 &&
            html`<button class="peeks-jump up" onClick=${() => reveal(away.up.at(-1))}>
                ▲ ${away.up.length} need${away.up.length === 1 ? "s" : ""} you
            </button>`
        }
        ${
            away.down.length > 0 &&
            html`<button class="peeks-jump down" onClick=${() => reveal(away.down[0])}>
                ▼ ${away.down.length} need${away.down.length === 1 ? "s" : ""} you
            </button>`
        }
    </aside>`;
}

/** Narrow screens, or with a panel beside the conversation: the tiles as a strip under the top bar, swiped sideways. */
export function PeekStrip({ tiles }) {
    const list = useRef(null);
    const order = numbers();

    useOnScreen(list);

    return html`<div class="peek-strip" ref=${list} aria-label="Peeks">
        ${tiles.map(
            (session) =>
                html`<${PeekTile}
                    key=${session.id}
                    session=${session}
                    number=${order.get(session.id)}
                    compact=${true}
                />`,
        )}
    </div>`;
}
