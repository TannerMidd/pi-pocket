// Peek tiles: other sessions' live work beside the open one, off until turned on (the top bar's tiles button, Alt+P,
// /peek, the launcher, or Appearance). Wide screens show a column of tiles where the People and Browser panels dock
// (when neither is open), narrower ones a strip under the top bar. Tiles are the sessions working, waiting for
// approval, with subagents at work, finished since this browser last looked, and pinned, plus the one just left. A tile
// lists the first few subagents at work in its session, a row each with what it does this moment, and counts the rest.
// Only tiles on screen are live: once scrolling settles, the tab tells the server which (`POST /api/peeks`), subagent
// rows too, and the rest keep the lines they last had. Their state marks stay current from the session list, which
// covers every session.
import { Component } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { AgentTile } from "./agent-tile.js";
import { folderColor } from "./avatar.js";
import { describeCall } from "./calls.js";
import { finishedUnseen, markSeen, seenSince } from "./seen.js";
import {
    actions,
    api,
    attempt,
    canSteer,
    navigate,
    notify,
    store,
    workspaceOrder,
} from "./store.js";
import { prefs, setPrefs } from "./theme.js";
import { html, Icon, railState, shortPath, usePresence } from "./ui.js";

/** Wide enough for the column beside the conversation: where People and the Browser panel dock too. */
export const PEEK_WIDE = matchMedia("(min-width: 1100px)");
/** How long the tiles on screen must stay put before the server hears of them: scrolling past is not looking. */
const SETTLE_MS = 250;
/** As many as the server keeps live for a tab (`MAX_PEEKS`): the tiles and the subagent rows in them. */
const MAX_LIVE = 20;
/** The subagent rows a tile shows, the rest counted under them: a tile stays a glance, however many work. */
const AGENT_ROWS = 3;
/** In the strip, which a phone shares with the conversation: one row and the count. */
const AGENT_ROWS_COMPACT = 1;
/** A call may be allowed from a tile only when its whole command shows there: this long at most, on one line. */
const ALLOW_LENGTH = 80;
/** Waits before sending the list again after a send failed, growing with each failure. */
const RETRY_MS = [1000, 3000, 10_000];

PEEK_WIDE.addEventListener("change", () => store.set({}));

const hidden = () => document.visibilityState === "hidden";

store.set({ peeks: {} });

// ─── Which sessions are tiles, in a steady order ─────────────────────────────────────

/** The tiles' order: kept as sessions come and go, so a tile stays where it was until it no longer belongs. */
let slots = [];
/** The session open before this one: it stays a tile, in the place of the one that was opened. */
let lastLeft = null;
let previous = store.state.conversationId;

// The session left stays a tile, in the place of the one opened. `seen.js` marks both seen.
store.subscribe((state) => {
    if (state.conversationId !== previous) {
        const left = previous;
        const at = slots.indexOf(state.conversationId);

        previous = state.conversationId;

        if (left !== null) {
            lastLeft = left;

            if (at >= 0) {
                slots[at] = left;
            }
        }
    }
});

/**
 * A session's subagents that work or wait: a tile shows them, and the session counts as working while one does.
 * `subagents` is the session list's count by state.
 */
const busyAgents = (session) =>
    (session.subagents?.working ?? 0) + (session.subagents?.waiting ?? 0);

const rank = (session, state, pinned) =>
    session.waiting || (session.subagents?.waiting ?? 0) > 0
        ? 0
        : session.busy || (session.subagents?.working ?? 0) > 0
          ? 1
          : finishedUnseen(session, state)
            ? 2
            : pinned.has(session.id)
              ? 3
              : 4;

/** The last choice of tiles, and what it was made from: most renders (a streaming answer's) change none of it. */
let chosen = { from: [], tiles: [] };

/** The sessions shown as tiles now, in tile order. */
export function peekTiles(state = store.state) {
    const from = [
        state.sessions,
        state.conversationId,
        state.pinned,
        state.peekSeen,
        lastLeft,
        seenSince(),
    ];

    if (from.every((value, index) => value === chosen.from[index])) {
        return chosen.tiles;
    }

    const pinned = new Set(state.pinned);
    const shown = state.sessions.filter(
        (session) =>
            !session.archived &&
            session.id !== state.conversationId &&
            (session.busy ||
                session.waiting ||
                busyAgents(session) > 0 ||
                finishedUnseen(session, state) ||
                pinned.has(session.id) ||
                session.id === lastLeft),
    );
    const ids = new Set(shown.map((session) => session.id));

    slots = slots.filter((id) => ids.has(id));
    const placed = new Set(slots);
    const fresh = shown
        .filter((session) => !placed.has(session.id))
        .sort((a, b) => rank(a, state, pinned) - rank(b, state, pinned));

    slots.push(...fresh.map((session) => session.id));
    const byId = new Map(shown.map((session) => [session.id, session]));

    chosen = { from, tiles: slots.map((id) => byId.get(id)) };

    return chosen.tiles;
}

/** Peek tiles are turned on in this browser. */
export const peeksOn = () => prefs().peeks === true;

/** Peeks show in this session: turned on, a server that sends them, and a session open. */
export function peeksWanted(state = store.state) {
    return (
        peeksOn() && state.server?.peeks === true && state.conversationId !== null && !state.missing
    );
}

/** Turn peek tiles on or off. Turned on where nothing would show yet, a notice says what will. */
export function togglePeeks() {
    const on = !peeksOn();

    setPrefs({ peeks: on });

    if (on && !PEEK_WIDE.matches && peekTiles().length === 0) {
        notify(
            "info",
            "Peek tiles on: sessions show here while they work, wait for you, or finish.",
        );
    }
}

/** The rail's switch, where the top bar's is out of room (a narrow pane). */
export function PeeksRailButton() {
    if (store.state.server?.peeks !== true) {
        return null;
    }

    const on = peeksOn();

    return html`<button
        class=${`rail-button rail-peeks ${on ? "open" : ""}`}
        data-part="rail-button"
        data-state=${railState(on)}
        title=${on ? "Hide peek tiles (Alt+P)" : "Peek at other sessions (Alt+P)"}
        aria-label="Peek tiles"
        aria-pressed=${on}
        onClick=${togglePeeks}
    >
        <${Icon} name="tiles" size=${19} />
    </button>`;
}

/** The top bar's switch. While off, a dot says another session waits for you. */
export function PeeksButton() {
    const { server, sessions, conversationId } = store.state;

    if (server?.peeks !== true) {
        return null;
    }

    const on = peeksOn();
    const waiting =
        !on &&
        sessions.some(
            (session) => session.waiting && !session.archived && session.id !== conversationId,
        );

    return html`<button
        class=${`icon-button badge-host top-toggle ${on ? "on" : ""}`}
        aria-label="Peek tiles"
        aria-pressed=${on}
        title=${on ? "Hide peek tiles (Alt+P)" : "Peek at other sessions (Alt+P)"}
        onClick=${togglePeeks}
    >
        <${Icon} name="tiles" size=${18} />
        ${waiting && html`<span class="peek-dot" aria-hidden="true"></span>`}
    </button>`;
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

    // The tiles first, so a tile's subagents cannot take the room a lower tile needs; the rows after them.
    const tiles = [];
    const agents = [];

    for (const [element, visible] of onScreen) {
        if (!element.isConnected) {
            onScreen.delete(element);
        } else if (visible) {
            (element.dataset.peekKind === "agent" ? agents : tiles).push(
                Number(element.dataset.peek),
            );
        }
    }

    return [...new Set([...tiles, ...agents])].slice(0, MAX_LIVE);
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

    // A connection starts without a list: no tiles yet (or turned off) needs nothing sent.
    if (ids.length === 0 && !sentKey?.startsWith(`${streamId}:`)) {
        sentKey = key;

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
});

/**
 * Watch a scrolling list's tiles (its `[data-peek]` elements) for being on screen, and tell the server once they
 * settle. The subagents bar watches its rows this way too.
 */
export function useOnScreen(list) {
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

/** A line of a tile: a mark column (who or what), then the words, two lines at most. */
function PeekLine({ line }) {
    switch (line.kind) {
        case "user":
            return html`<div class="peek-line user">
                <span class="peek-mark">›</span>
                <span class="peek-text">${line.from && html`<b>${line.from}</b> `}${line.text}</span>
            </div>`;
        case "text":
            return html`<div class="peek-line text">
                <span class="peek-mark pi">π</span>
                <span class="peek-text">${line.text}</span>
            </div>`;

        case "tool": {
            const call = describeCall({ name: line.name, args: line.args });

            return html`<div class="peek-line cmd">
                <span class="peek-mark">
                    ${call.iconPath ? html`<${Icon} path=${call.iconPath} size=${12} />` : call.icon}
                </span>
                <span class="peek-text">
                    ${call.label} ${call.subject}${" "}
                    <${Status} status=${line.status} />
                </span>
            </div>`;
        }

        case "shell":
            return html`<div class="peek-line cmd">
                <span class="peek-mark">${">_"}</span>
                <span class="peek-text">${line.command}${" "}<${Status} status=${line.status} /></span>
            </div>`;
        case "note":
            return html`<div class="peek-line faint">
                <span class="peek-mark">⑂</span>
                <span class="peek-text">${line.name}: ${line.text}</span>
            </div>`;
        case "error":
            return html`<div class="peek-line err">
                <span class="peek-mark">×</span>
                <span class="peek-text">${line.text}</span>
            </div>`;
        default:
            return html`<div class="peek-line faint">
                <span class="peek-mark"></span>
                <span class="peek-text">${line.text}</span>
            </div>`;
    }
}

/**
 * Whether a call's command is short enough to show whole on its tile: only then may it be allowed from there. Shown
 * whole, it is never clamped; the tile also measures that it fits (`PeekTile`), as wide characters take more room.
 */
export const wholeOnTile = (approval) =>
    approval.subject.length <= ALLOW_LENGTH && !/[\r\n]/.test(approval.subject);

/** The call a session waits on, in full when it is short, and why the guard asks. */
function PeekAsk({ approval, compact, who }) {
    return html`<div class="peek-ask" title=${`${approval.subject}\n\n${approval.reason}`}>
        <span class="peek-ask-tool mono">
            <${Icon} name="shield" size=${12} />${approval.tool}
            ${who !== undefined && html`<span class="peek-ask-who">${who} asks</span>`}
        </span>
        <div class=${`peek-ask-what mono ${wholeOnTile(approval) ? "whole" : ""}`}>
            ${approval.subject}
        </div>
        ${
            // A question (a form) is in its reason, its title alone says little: a compact tile shows it too.
            (!compact || approval.form) &&
            approval.reason &&
            html`<div class="peek-ask-why">${approval.reason}</div>`
        }
    </div>`;
}

/**
 * Allow or deny a call from its tile, as from its card: the same rules, the same request. A command that does not show
 * whole is not allowed from here: Open shows it on its card, in the conversation that asks (a subagent's, maybe).
 */
function PeekApproval({ approval, me, rule, whole }) {
    const [busy, setBusy] = useState(false);

    const answer = (allow) => {
        setBusy(true);
        attempt(() => actions.approve(approval.id, allow)).finally(() => setBusy(false));
    };

    const ownCall = rule === "others" && me?.role !== "owner" && approval.requestedBy === me?.id;

    // An extension's question (`host.ask`) is answered on its card, where its fields are: from here, open it or decline.
    if (approval.form) {
        return html`<span class="peek-actions">
            <button class="button small" disabled=${busy} onClick=${() => answer(false)}>
                Decline
            </button>
            <button
                class="button small primary"
                title="Answer it where it waits"
                onClick=${() => navigate(approval.conversationId)}
            >
                Open
            </button>
        </span>`;
    }

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
                      title="See the whole command where it waits"
                      onClick=${() => navigate(approval.conversationId)}
                  >
                      Open
                  </button>`
        }
    </span>`;
}

/**
 * The active subagents a tile shows, each with its own peek. Rows keep their identity until one or its peek changes,
 * so a tile renders again only when what it shows did.
 */
const agentRows = new Map();

function agentsOf(session, peek, peeks) {
    const list = peek?.agents ?? [];
    const from = [peek, session.cwd, ...list.map((agent) => peeks?.[agent.conversationId])];
    const kept = agentRows.get(session.id);

    if (
        kept !== undefined &&
        kept.from.length === from.length &&
        from.every((value, index) => value === kept.from[index])
    ) {
        return kept.rows;
    }

    // The session's peek carries its subagents' waiting calls too: those rows say so at once, and come first.
    const rows = list
        .map((agent) => {
            const index =
                peek?.approvals?.findIndex(
                    (request) => request.conversationId === agent.conversationId,
                ) ?? -1;
            const approval = index === -1 ? undefined : peek.approvals[index];

            return {
                ...agent,
                peek: peeks?.[agent.conversationId],
                folder: folderColor(session.cwd),
                ...(approval === undefined
                    ? {}
                    : {
                          waiting: true,
                          asks: index,
                          approval: { tool: approval.tool, subject: approval.subject },
                      }),
            };
        })
        // In the order their calls wait, as the tile's approval shows the first; the rest as the server lists them.
        .sort((a, b) => (a.asks ?? Number.MAX_SAFE_INTEGER) - (b.asks ?? Number.MAX_SAFE_INTEGER));

    agentRows.set(session.id, { from, rows });

    return rows;
}

/**
 * A tile's subagents at work: the first few as rows (those waiting for an approval first), each opening its subagent,
 * and how many more, which opens the board at the first of them.
 */
function AgentRows({ agents, compact }) {
    const shown = agents.slice(0, compact ? AGENT_ROWS_COMPACT : AGENT_ROWS);
    const more = agents.slice(shown.length);
    const waitingMore = more.filter((agent) => agent.waiting === true).length;
    const waitWords = `${waitingMore} ${waitingMore === 1 ? "needs" : "need"} approval`;

    return html`<div class="agent-tiles" role="group" aria-label="Subagents at work">
        ${shown.map(
            (agent) =>
                html`<${AgentTile}
                    key=${agent.conversationId}
                    agent=${agent}
                    folder=${agent.folder}
                    onActivate=${() => navigate(agent.conversationId)}
                />`,
        )}
        ${
            more.length > 0 &&
            html`<button
                class=${`agent-more ${waitingMore > 0 ? "waiting" : ""}`}
                title="See them all on the subagents board"
                onClick=${() =>
                    store.set({
                        board: true,
                        drawer: false,
                        page: null,
                        boardFocus: more[0].conversationId,
                    })}
            >
                <${Icon} name="fork" size=${13} />
                <span class="agent-more-count">${more.length} more</span>
                ${waitingMore > 0 && html`<span class="agent-more-wait">${waitWords}</span>`}
                <${Icon} name="chevron" size=${14} />
            </button>`
        }
    </div>`;
}

/**
 * A tile's square, in the shape the session list gives the same state: its folder's color.
 */
const SHAPES = {
    waiting: "waiting",
    limited: "limited",
    working: "working",
    done: "fresh",
    idle: "seen",
};

/**
 * One tile. The whole app renders on every update while a session streams; a tile renders again only when what it
 * shows changed (`tileProps` makes its props, which keep their identity until then).
 */
class PeekTile extends Component {
    state = { clipped: false };

    shouldComponentUpdate(next, state) {
        return (
            state.clipped !== this.state.clipped ||
            Object.keys(next).some((key) => next[key] !== this.props[key])
        );
    }

    componentDidMount() {
        this.measure();
    }

    componentDidUpdate() {
        this.measure();
    }

    /** Whether the command waiting on this tile is cut off anywhere, by a clamp or by the tile's edge. */
    measure() {
        const what = this.base?.querySelector(".peek-ask-what");
        let clipped = false;

        if (what) {
            const box = what.getBoundingClientRect();
            const tile = this.base.getBoundingClientRect();

            clipped =
                what.scrollHeight > what.clientHeight + 1 ||
                what.scrollWidth > what.clientWidth + 1 ||
                box.bottom > tile.bottom + 1 ||
                box.right > tile.right + 1;
        }

        if (clipped !== this.state.clipped) {
            this.setState({ clipped });
        }
    }

    render({ session, peek, agents, status, label, number, compact, steer, home, me, rule }) {
        const title = session.title ?? "New session";
        const open = () => navigate(session.id);
        // A call answered elsewhere can stay on a tile scrolled away: the session list says whether one still waits.
        const approval = session.waiting ? peek?.approvals?.[0] : undefined;
        // A subagent's call names the subagent that asks.
        const asker = agents.find(
            (agent) => agent.conversationId === approval?.conversationId,
        )?.name;
        const lines = peek?.lines;
        // The last few lines, which the tile gives two lines of text each.
        const shown = compact ? (lines ?? []).slice(-1) : lines?.slice(-3);

        return html`<div
            class=${`peek ${status}`}
            data-part="peek-tile"
            data-state=${status}
            data-peek=${session.id}
        >
            <button class="peek-head" title=${`Open ${title}`} onClick=${open}>
                <span class="peek-name">
                    <span
                        class=${`state-mark ${SHAPES[status]}`}
                        style=${`--folder:${folderColor(session.cwd)}`}
                        aria-hidden="true"
                    ></span>
                    <span class="peek-title">${title}</span>
                    ${
                        number !== undefined &&
                        number < 9 &&
                        html`<kbd class="session-num">${number + 1}</kbd>`
                    }
                </span>
                <span class="peek-cwd mono">${shortPath(session.cwd, home)}</span>
            </button>
            <div class="peek-lines" onClick=${open}>
                ${
                    shown === undefined
                        ? html`<span class="peek-skeleton"><i></i><i></i><i></i></span>`
                        : shown.map(
                              (line, index) => html`<${PeekLine} key=${index} line=${line} />`,
                          )
                }
            </div>
            ${agents.length > 0 && html`<${AgentRows} agents=${agents} compact=${compact} />`}
            ${
                approval &&
                html`<div class="peek-ask-host" onClick=${open}>
                    <${PeekAsk} approval=${approval} compact=${compact} who=${asker} />
                </div>`
            }
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
                        whole=${wholeOnTile(approval) && !this.state.clipped}
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
                        <${Icon} name="check" size=${16} />
                    </button>`
                }
            </div>
        </div>`;
    }
}

/** "a subagent", or how many. */
const someAgents = (count) => (count === 1 ? "a subagent" : `${count} subagents`);

/** What each tile shows, from the state: plain values and objects that keep their identity until they change. */
function tileProps(tiles, compact) {
    const state = store.state;
    const steer = canSteer();
    const order = new Map(workspaceOrder().map((session, index) => [session.id, index]));

    return tiles.map((session) => {
        const peek = state.peeks?.[session.id];
        const status =
            session.waiting || (session.subagents?.waiting ?? 0) > 0
                ? "waiting"
                : session.limited !== undefined
                  ? "limited"
                  : session.busy || (session.subagents?.working ?? 0) > 0
                    ? "working"
                    : finishedUnseen(session, state)
                      ? "done"
                      : "idle";
        // Where only its subagents keep a session waiting or working, the column's label says so. A session waits
        // while one of its subagents does too: its peek says whose calls wait.
        const waitingAgents = session.subagents?.waiting ?? 0;
        const workingAgents = session.subagents?.working ?? 0;
        // The strip's tiles are too narrow for more than a word or two beside Deny and Allow.
        const waitsItself =
            compact ||
            waitingAgents === 0 ||
            peek === undefined ||
            peek.approvals.some((request) => request.conversationId === session.id);
        const label =
            status === "waiting"
                ? waitsItself
                    ? steer
                        ? "needs you"
                        : "waiting"
                    : steer
                      ? `${someAgents(waitingAgents)} ${waitingAgents === 1 ? "needs" : "need"} you`
                      : `${someAgents(waitingAgents)} waiting`
                : status === "limited"
                  ? "waiting for a limit"
                  : status === "working"
                    ? session.busy || compact
                        ? "working"
                        : `${someAgents(workingAgents)} working`
                    : status === "done"
                      ? "done · new"
                      : session.id === lastLeft
                        ? "just left"
                        : "pinned";

        return {
            key: session.id,
            session,
            peek,
            agents: agentsOf(session, peek, state.peeks),
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

/**
 * The column while it shows, and a moment after, so it can slide out. Not when People or the Browser panel takes its
 * place: that one slides in instead. While it leaves it keeps the tiles it had.
 */
export function PeekHost({ shown, tiles, replaced }) {
    const [kept, leaving] = usePresence(shown ? tiles : null, 180);

    if (shown) {
        return html`<${PeekColumn} tiles=${tiles} />`;
    }

    return kept === null || !leaving || replaced
        ? null
        : html`<${PeekColumn} tiles=${kept} leaving=${true} />`;
}

/** Wide screens: the tiles as a column beside the conversation, scrolling, with the way to calls waiting out of view. */
function PeekColumn({ tiles, leaving = false }) {
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

    return html`<aside
        class=${`peeks window ${leaving ? "leaving" : ""}`}
        data-part="peeks"
        data-state=${leaving ? "closing" : undefined}
        aria-label="Peeks"
        inert=${leaving}
    >
        <div class="peeks-list" ref=${list}>
            ${props.map((each) => html`<${PeekTile} ...${each} />`)}
            ${
                props.length === 0 &&
                html`<div class="peeks-empty">
                    <${Icon} name="tiles" size=${28} />
                    <p>Other sessions show here while they work, wait for you, or finish.</p>
                    <p class="muted small">Pinned sessions stay here. Alt+P hides this.</p>
                </div>`
            }
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
