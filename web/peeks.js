// Peek tiles: other sessions' live work beside the open one. Wide screens show a column of tiles where the People and
// Browser panels dock (when neither is open), narrower ones a strip under the top bar. Tiles are the sessions working,
// waiting for approval, finished since this browser last looked, and pinned, plus the one just left. Only tiles on
// screen are live: once scrolling settles, the tab tells the server which (`POST /api/peeks`), and the rest keep the
// lines they last had. Their state marks stay current from the session list, which covers every session.
import { Component } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { workspaceOrder } from "./sessions.js";
import { actions, api, attempt, canSteer, navigate, store } from "./store.js";
import { prefs } from "./theme.js";
import { describeCall } from "./transcript.js";
import { html, Icon, shortPath } from "./ui.js";

/** Wide enough for the column beside the conversation: where People and the Browser panel dock too. */
export const PEEK_WIDE = matchMedia("(min-width: 1100px)");
/** How long the tiles on screen must stay put before the server hears of them: scrolling past is not looking. */
const SETTLE_MS = 250;
/** As many as the server keeps live for a tab (`MAX_PEEKS`). */
const MAX_LIVE = 12;
/** A call may be allowed from a tile only when its whole command shows there: this long at most, on one line. */
const ALLOW_LENGTH = 80;
/** Waits before sending the list again after a send failed, growing with each failure. */
const RETRY_MS = [1000, 3000, 10_000];
const SEEN_KEY = "pocket.peekSeen";
const SINCE_KEY = "pocket.peekSince";

PEEK_WIDE.addEventListener("change", () => store.set({}));

const hidden = () => document.visibilityState === "hidden";

// ─── What this browser has seen, by the server's clock ───────────────────────────────

/** How far the server's clock is ahead of this browser's, from its last hello: runs end by the server's clock. */
let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;

function readSeen() {
    try {
        return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") ?? {};
    } catch {
        return {};
    }
}

/** Runs that ended before this browser first had peeks are old news. The server's time; null until it has said. */
let since = Number(localStorage.getItem(SINCE_KEY)) || null;

store.set({ peeks: {}, peekSeen: readSeen() });

// Another tab of this browser marked a session seen.
addEventListener("storage", (event) => {
    if (event.key === SEEN_KEY) {
        store.set({ peekSeen: readSeen() });
    }
});

/** Remember that this browser looked at a session now: a run that ended before is no longer new. */
export function markSeen(id) {
    const { sessions, sessionsLoaded } = store.state;
    const known = new Set(sessions.map((session) => String(session.id)));
    const ended = sessions.find((session) => session.id === id)?.endedAt ?? 0;
    // Read afresh, so marks another tab made since are kept; the run's own end counts, in case the clocks disagree.
    const seen = Object.fromEntries(
        Object.entries({ ...readSeen(), [id]: Math.max(serverNow(), ended) }).filter(
            ([key]) => !sessionsLoaded || known.has(key),
        ),
    );

    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    store.set({ peekSeen: seen });
}

/** A session whose run ended since this browser last had it open. */
export function finishedUnseen(session, state = store.state) {
    return (
        since !== null &&
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

    if (state.conversationId !== previous) {
        const left = previous;
        const at = slots.indexOf(state.conversationId);

        previous = state.conversationId;
        openEnded = undefined;

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
    }

    seeOpen(store.state);
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
/** The connection and list last sent, so the same list is not sent twice. */
let sentKey = null;
let lastStream;
/** Numbers each list, so the server drops one that arrives after a newer one. */
let seq = 0;
let failures = 0;

function screenIds() {
    // A hidden tab looks at nothing: its tiles stop until it shows again.
    if (hidden()) {
        return [];
    }

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
    const { server, streamId } = store.state;

    if (server?.peeks !== true || !streamId) {
        return;
    }

    const ids = screenIds();
    const key = `${streamId}:${ids.join(",")}`;

    if (key === sentKey) {
        return;
    }

    sentKey = key;
    api("peeks", { connection: streamId, seq: ++seq, ids }).then(
        () => {
            failures = 0;
        },
        () => {
            // Try again soon: a moment without the network must not leave the tiles stale.
            sentKey = null;
            settle(RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
        },
    );
}

// Each connection to the server starts without tiles (a session switch reconnects, as does a restart): say again
// which are on screen.
store.subscribe((state) => {
    if (state.streamId !== lastStream) {
        lastStream = state.streamId;
        settle(0);
    }
});

document.addEventListener("visibilitychange", () => {
    settle(hidden() ? 0 : SETTLE_MS);
    seeOpen(store.state);
});

/** Watch a scrolling list's tiles for being on screen, and tell the server once they settle. */
function useOnScreen(list) {
    const observer = useRef(null);
    const watched = useRef(new Set());

    useEffect(() => {
        const watcher = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (watched.current.has(entry.target)) {
                        onScreen.set(entry.target, entry.isIntersecting);
                    }
                }

                settle();
            },
            { root: list.current },
        );

        observer.current = watcher;

        return () => {
            watcher.disconnect();

            for (const element of watched.current) {
                onScreen.delete(element);
            }

            watched.current.clear();
            settle();
        };
    }, []);

    // New tiles join the watch; tiles that went leave it.
    useEffect(() => {
        let gone = false;

        for (const element of list.current.querySelectorAll("[data-peek]")) {
            if (!watched.current.has(element)) {
                watched.current.add(element);
                observer.current.observe(element);
            }
        }

        for (const element of watched.current) {
            if (!element.isConnected) {
                observer.current.unobserve(element);
                watched.current.delete(element);
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
function useAwayWaiting(list, key) {
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

    // Only when the tiles or their states change, or the column scrolls or resizes: not on every update.
    useEffect(measure, [key]);
    useEffect(() => {
        const box = list.current;
        let frame = 0;

        const later = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(measure);
        };

        const resized = new ResizeObserver(later);

        box.addEventListener("scroll", later, { passive: true });
        resized.observe(box);

        return () => {
            cancelAnimationFrame(frame);
            box.removeEventListener("scroll", later);
            resized.disconnect();
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
                <span class="peek-mark">›</span>${" "}
                ${line.from && html`<b>${line.from}</b> `}${line.text}
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

/** Whether a call's whole command shows on its tile: only then may it be allowed from there. */
const wholeOnTile = (approval) =>
    approval.subject.length <= ALLOW_LENGTH && !/[\r\n]/.test(approval.subject);

/** The call a session waits on, in full when it is short, and why the guard asks. */
function PeekAsk({ approval, compact }) {
    return html`<div class="peek-ask" title=${`${approval.subject}\n\n${approval.reason}`}>
        <div class="peek-ask-what mono">
            <${Icon} name="shield" size=${11} /> ${approval.tool}: ${approval.subject}
        </div>
        ${!compact && approval.reason && html`<div class="peek-ask-why">${approval.reason}</div>`}
    </div>`;
}

/**
 * Allow or deny a call from its tile, as from its card: the same rules, the same request. A command too long to show
 * whole is not allowed from here: Open shows it in its session first.
 */
function PeekApproval({ approval, me, rule, open }) {
    const [busy, setBusy] = useState(false);

    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
    };

    const ownCall = rule === "others" && me?.role !== "owner" && approval.requestedBy === me?.id;
    const whole = wholeOnTile(approval);

    return html`<span class="peek-actions">
        <button class="button small" disabled=${busy} onClick=${() => answer(false)}>Deny</button>
        ${
            whole
                ? !ownCall &&
                  html`<button
                      class="button small primary"
                      disabled=${busy}
                      onClick=${() => answer(true)}
                  >
                      Allow
                  </button>`
                : html`<button
                      class="button small primary"
                      title="See the whole command in its session"
                      onClick=${open}
                  >
                      Open
                  </button>`
        }
    </span>`;
}

/**
 * One tile. The whole app renders on every update while a session streams; a tile renders again only when what it
 * shows changed (`tileProps` makes its props, which keep their identity until then).
 */
class PeekTile extends Component {
    shouldComponentUpdate(next) {
        return Object.keys(next).some((key) => next[key] !== this.props[key]);
    }

    render({ session, peek, status, label, number, compact, steer, home, me, rule }) {
        const title = session.title ?? "New session";
        const open = () => navigate(session.id);
        // A call answered elsewhere can stay on a tile scrolled away: the session list says whether one still waits.
        const approval = session.waiting ? peek?.approvals?.[0] : undefined;
        const lines = peek?.lines;
        const shown = compact ? (lines ?? []).slice(-1) : lines;
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
                    <span class="peek-cwd mono">${shortPath(session.cwd, home)}</span>
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
                        : shown.map(
                              (line, index) => html`<${PeekLine} key=${index} line=${line} />`,
                          )
                }
            </div>
            ${approval && html`<${PeekAsk} approval=${approval} compact=${compact} />`}
            <div class="peek-foot">
                <span class="peek-status">${label}</span>
                ${
                    approval &&
                    steer &&
                    html`<${PeekApproval}
                        key=${approval.id}
                        approval=${approval}
                        me=${me}
                        rule=${rule}
                        open=${open}
                    />`
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
}

/** What each tile shows, from the state: plain values and objects that keep their identity until they change. */
function tileProps(tiles, compact) {
    const state = store.state;
    const steer = canSteer();
    const order = new Map(workspaceOrder().map((session, index) => [session.id, index]));

    return tiles.map((session) => {
        const status = session.waiting
            ? "waiting"
            : session.busy
              ? "working"
              : finishedUnseen(session, state)
                ? "done"
                : "idle";
        const label =
            status === "waiting"
                ? steer
                    ? "needs you"
                    : "waiting"
                : status === "working"
                  ? "working"
                  : status === "done"
                    ? "done · new"
                    : session.id === lastLeft
                      ? "just left"
                      : "pinned";

        return {
            key: session.id,
            session,
            peek: state.peeks?.[session.id],
            status,
            label,
            number: order.get(session.id),
            compact,
            steer,
            home: state.server?.home,
            me: state.me,
            rule: state.server?.approvalRule,
        };
    });
}

/** Wide screens: the tiles as a column beside the conversation, scrolling, with the way to calls waiting out of view. */
export function PeekColumn({ tiles }) {
    const list = useRef(null);
    const props = tileProps(tiles, false);
    const away = useAwayWaiting(list, props.map((tile) => `${tile.key}:${tile.status}`).join());
    const reveal = (id) =>
        list.current
            ?.querySelector(`[data-peek="${id}"]`)
            ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const verb = canSteer() ? ["needs you", "need you"] : ["waiting", "waiting"];
    const jump = (ids, arrow, pick) =>
        ids.length > 0 &&
        html`<button
            class=${`peeks-jump ${arrow === "▲" ? "up" : "down"}`}
            onClick=${() => reveal(pick(ids))}
        >
            ${arrow} ${ids.length} ${verb[ids.length === 1 ? 0 : 1]}
        </button>`;

    useOnScreen(list);

    return html`<aside class="peeks window" aria-label="Peeks">
        <div class="peeks-list" ref=${list}>
            ${props.map((each) => html`<${PeekTile} ...${each} />`)}
        </div>
        ${jump(away.up, "▲", (ids) => ids.at(-1))}
        ${jump(away.down, "▼", (ids) => ids[0])}
    </aside>`;
}

/** Narrow screens, or with a panel beside the conversation: the tiles as a strip under the top bar, swiped sideways. */
export function PeekStrip({ tiles }) {
    const list = useRef(null);

    useOnScreen(list);

    return html`<div class="peek-strip" ref=${list} role="region" aria-label="Peeks">
        ${tileProps(tiles, true).map((each) => html`<${PeekTile} ...${each} />`)}
    </div>`;
}
