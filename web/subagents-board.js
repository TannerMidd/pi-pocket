// The subagents board: every subagent in every session, in the conversation's place while it is open. One square per
// subagent and one row per session, the sessions that need you first; a bar that says how many are in each state and
// filters by it; what needs you (approvals and failures) in a queue; and the one selected, with Open and Stop. The
// arrows move between squares and Enter opens one. Phones get one column and a bar at the bottom for the one selected.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { folderColor } from "./avatar.js";
import { useBack } from "./back.js";
import { fromServer, useOnScreen } from "./peeks.js";
import { api, attempt, canSteer, navigate, store } from "./store.js";
import { elapsed, nowDoing, ordered, stateOf } from "./subagents.js";
import { html, Icon, timeAgo } from "./ui.js";

/** The states, most urgent first: the order of the bar, the legend, the squares, and the sessions' summaries. */
const STATES = ["waiting", "failed", "working", "stopped", "done"];

const LABELS = {
    waiting: "Needs approval",
    failed: "Failed",
    working: "Working",
    stopped: "Stopped",
    done: "Done",
};

/** Where a subagent is on the board: waiting for an approval comes first, as it is working but held up. */
const boardState = (agent) => (agent.waiting ? "waiting" : stateOf(agent));

const live = (state) => state === "working" || state === "waiting";

/** The board goes to one column below this width, as sheets come up from the bottom. */
const PHONE = matchMedia("(max-width: 699px)");

// While the board shows, this tab gets every subagent with each session list: the server is told which connection
// wants them, again on each new one (a session switch reconnects, as does a restart), and when the board closes.
let told = null;
/** Numbers each request, so the server drops one that arrives after a newer one. */
let seq = 0;

/** Tell the server whether this tab's connection wants every subagent, when that changed. */
function sync(state) {
    const wanted = state.board && state.streamId ? state.streamId : null;

    if (wanted === told) {
        return;
    }

    if (told !== null) {
        api("subagents", { connection: told, on: false, seq: ++seq }).catch(() => {});
    }

    told = wanted;

    // A request lost with the network is asked again on the connection that follows; one that failed while the
    // connection stayed, again in a moment.
    if (wanted !== null) {
        api("subagents", { connection: wanted, on: true, seq: ++seq }).catch(() => {
            if (told === wanted) {
                told = null;
                setTimeout(() => sync(store.state), 2000);
            }
        });
    }
}

store.subscribe(sync);

/** Close the board: back to the conversation, or the home screen, it took the place of. */
export const closeBoard = () => store.set({ board: false, boardAgents: null });

/** "2 need approval · 4 working · 2 done": a session's subagents by state (`counts`), most urgent first. */
function summaryOf(counts, { short = false } = {}) {
    if (short) {
        const parts = STATES.filter(
            (state) => counts[state] > 0 && !["stopped", "done"].includes(state),
        );

        return parts.length > 0
            ? parts
                  .map((state) => `${counts[state]} ${state === "waiting" ? "approve" : state}`)
                  .join(" · ")
            : `${totalOf(counts)} done`;
    }

    return STATES.filter((state) => counts[state] > 0)
        .map((state) => `${counts[state]} ${state === "waiting" ? "need approval" : state}`)
        .join(" · ");
}

const totalOf = (counts) => Object.values(counts).reduce((sum, count) => sum + count, 0);

/**
 * A session's subagents by state. The board leaves out a session's oldest finished ones (the server's
 * `BOARD_FINISHED`), which the session list still counts (`known`): never fewer than the squares, as the two lists
 * can arrive a moment apart.
 */
function countOf(list, known) {
    const counts = Object.fromEntries(STATES.map((state) => [state, 0]));

    for (const agent of list) {
        counts[boardState(agent)]++;
    }

    for (const state of STATES) {
        counts[state] = Math.max(counts[state], known?.[state] ?? 0);
    }

    return counts;
}

/** How long ago something ended, as the board says it: "14m ago", "just now", or the day, a month on. */
function ago(server) {
    // The server's clock, on this device's.
    const ms = fromServer(server);

    if (Date.now() - ms >= 30 * 86_400_000) {
        return `on ${new Date(ms).toLocaleDateString()}`;
    }

    const when = timeAgo(ms);

    return when === "now" ? "just now" : `${when} ago`;
}

/** What a subagent does now: the call waiting for an approval, or what its peek shows. */
function nowOf(agent) {
    if (agent.waiting && agent.approval) {
        return `Waiting for approval: ${agent.approval.tool} ${agent.approval.subject}`.trim();
    }

    return nowDoing(agent);
}

/** What a working subagent does now, for the search: only what is known (an approval, or its peek), not a guess. */
function knownNow(agent) {
    const state = boardState(agent);

    if (!live(state) || (!agent.waiting && !store.state.peeks?.[agent.conversationId])) {
        return "";
    }

    return nowOf(agent);
}

/** The line about a subagent: what it does now while it works, else why it failed, else what it was asked. */
function lineOf(agent) {
    const state = boardState(agent);

    if (live(state)) {
        return nowOf(agent);
    }

    return (state === "failed" && agent.error) || agent.asked || "";
}

/** How long it has worked, or since it ended. */
function whenOf(agent) {
    if (live(boardState(agent))) {
        return agent.askedAt ? elapsed(agent.askedAt) : "";
    }

    return agent.answeredAt ? ago(agent.answeredAt) : "";
}

/** One subagent's square: its state's color, and "!" when it needs you. */
function Cell({ agent, state, dim, selected, onPick, onHover }) {
    return html`<button
        class=${`board-cell ${state} ${dim ? "dim" : ""} ${selected ? "on" : ""}`}
        data-agent=${agent.conversationId}
        aria-label=${`${agent.name}, ${LABELS[state]}`}
        aria-pressed=${selected}
        title=${agent.name}
        onClick=${() => onPick(agent.conversationId)}
        onMouseEnter=${() => onHover(agent.conversationId)}
        onMouseLeave=${() => onHover(null)}
    >
        ${(state === "waiting" || state === "failed") && "!"}
    </button>`;
}

/** A state's mark: a small square in its color, with "!" when it needs you. */
function Mark({ state, glyph = true }) {
    return html`<span class=${`board-mark ${state}`} aria-hidden="true">
        ${glyph && (state === "waiting" || state === "failed") && "!"}
    </span>`;
}

/** The subagents that need you: waiting for an approval first, then failed. */
function NeedsYou({ needs, titles, selected, onPick }) {
    return html`<div class="board-needs">
        <div class="label">Needs you <span class="board-needs-count">${needs.length}</span></div>
        ${needs.map((agent) => {
            const state = boardState(agent);

            return html`<button
                key=${agent.conversationId}
                class=${`board-need ${state} ${agent.conversationId === selected ? "on" : ""}`}
                onClick=${() => onPick(agent.conversationId)}
            >
                <${Mark} state=${state} />
                <span class="board-need-main">
                    <span class="board-need-head">
                        <b>${agent.name}</b>${" "}<span class="board-need-what">
                            ${state === "waiting" ? "needs approval" : "failed"}
                        </span>
                    </span>
                    <span class="board-need-session">${titles.get(agent.id)}</span>
                </span>
            </button>`;
        })}
    </div>`;
}

/** Stop a subagent that works or waits. */
const stop = (agent) => attempt(() => api(`c/${agent.conversationId}/abort`, {}));

/** Open a subagent's conversation, where an approval it waits for can be answered. */
function open(agent) {
    closeBoard();
    navigate(agent.conversationId);
}

function openSession(id) {
    closeBoard();
    navigate(id);
}

/** The selected subagent, in the side panel: where it works, for how long, what it was asked and does now. */
function Detail({ agent, title }) {
    const state = boardState(agent);
    const now = live(state);

    return html`<div class="board-detail" data-peek=${agent.conversationId}>
        <div class="board-detail-head">
            <${Mark} state=${state} />
            <span class="board-detail-name">${agent.name}</span>
            <span class=${`board-detail-state ${state}`}>${LABELS[state]}</span>
        </div>
        <div class="board-facts">
            <span>Session</span>
            <button class="board-link" onClick=${() => openSession(agent.id)}>${title}</button>
            <span>${now ? "Running" : "Ended"}</span>
            <span class="board-when">${whenOf(agent) || "—"}</span>
            ${
                agent.asked &&
                html`<span>Asked</span>
                    <span class="board-asked">${agent.asked}</span>`
            }
            ${
                now &&
                html`<span>Now</span>
                    <span class=${`board-now ${state}`}>${nowOf(agent)}</span>`
            }
            ${
                state === "failed" &&
                agent.error &&
                html`<span>Error</span><span class="board-error">${agent.error}</span>`
            }
        </div>
        ${agent.reporting && html`<span class="agent-chip">report on its way to Pi</span>`}
        <div class="board-actions">
            <button class="button primary" onClick=${() => open(agent)}>
                ${state === "waiting" ? "Review the approval" : "Open"}
            </button>
            ${
                now &&
                canSteer() &&
                html`<button class="button board-stop" onClick=${() => stop(agent)}>Stop</button>`
            }
        </div>
    </div>`;
}

/** Under the squares: what the one under the mouse does, or the selected one when none is. */
function StatusLine({ agent }) {
    const state = agent && boardState(agent);

    return html`<div class="board-status">
        ${
            agent
                ? html`<${Mark} state=${state} glyph=${false} />
                      <span class="board-status-name">${agent.name}</span>
                      <span class="board-status-when">
                          ${live(state) ? whenOf(agent) : `${state} ${whenOf(agent)}`}
                      </span>
                      <span
                          class=${`board-status-line ${state}`}
                          data-peek=${agent.conversationId}
                          key=${agent.conversationId}
                      >
                          ${lineOf(agent)}
                      </span>`
                : html`<span class="board-status-line">Hover a square to see what it is doing</span>`
        }
        <span class="board-keys">←→↑↓ move · Enter opens</span>
    </div>`;
}

/** The selected subagent on a phone: a bar at the bottom, over the list. */
function DetailBar({ agent, title, onClose }) {
    const state = boardState(agent);

    return html`<div class="board-bar" data-peek=${agent.conversationId}>
        <div class="board-bar-head">
            <${Mark} state=${state} />
            <span class="board-detail-name">${agent.name}</span>
            <span class=${`board-detail-state ${state}`}>${LABELS[state]}</span>
            <span class="board-bar-when">${whenOf(agent)}</span>
            <button class="board-bar-close" aria-label="Close" onClick=${onClose}>
                <${Icon} name="close" size=${16} />
            </button>
        </div>
        <div class="board-bar-session">${title}</div>
        <div class=${`board-bar-line ${state}`}>${lineOf(agent)}</div>
        <div class="board-bar-actions">
            <button class="button primary" onClick=${() => open(agent)}>
                ${state === "waiting" ? "Review the approval" : "Open"}
            </button>
            ${
                live(state) &&
                canSteer() &&
                html`<button class="button" onClick=${() => stop(agent)}>Stop</button>`
            }
        </div>
    </div>`;
}

/** The search field: finds subagents by name, what they were asked, what they do now, and why they failed. */
function Search({ query, setQuery }) {
    return html`<label class=${`board-search ${query ? "filled" : ""}`}>
        <${Icon} name="search" size=${14} />
        <input
            placeholder="Find a subagent or task"
            value=${query}
            onInput=${(event) => setQuery(event.currentTarget.value)}
            onKeyDown=${(event) => {
                if (event.key === "Escape" && query !== "") {
                    // Taken: this Esc clears the search, not the board.
                    event.preventDefault();
                    setQuery("");
                }
            }}
        />
    </label>`;
}

/** Re-render when a media query starts or stops matching. */
function useMatches(query) {
    const [matches, setMatches] = useState(query.matches);

    useEffect(() => {
        const change = () => setMatches(query.matches);

        query.addEventListener("change", change);

        return () => query.removeEventListener("change", change);
    }, []);

    return matches;
}

export function SubagentsBoard() {
    const { boardAgents, sessions } = store.state;
    const phone = useMatches(PHONE);
    const [filter, setFilter] = useState("all");
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState(null);
    const [hovered, setHovered] = useState(null);
    const [, tick] = useState(0);
    const box = useRef(null);
    const agents = boardAgents ?? [];
    const titles = new Map(sessions.map((session) => [session.id, session.title ?? "New session"]));
    const cwds = new Map(sessions.map((session) => [session.id, session.cwd]));
    const known = new Map(sessions.map((session) => [session.id, session.subagents]));
    const needle = query.trim().toLowerCase();
    const matches = (agent) =>
        (filter === "all" || boardState(agent) === filter) &&
        (needle === "" ||
            `${agent.name} ${agent.asked ?? ""} ${knownNow(agent)} ${agent.error ?? ""}`
                .toLowerCase()
                .includes(needle));

    // One row per session: those with a subagent waiting or failed first, then the most at work; in each, the squares
    // by state, most urgent first, and the newest first within a state.
    const bySession = new Map();

    for (const agent of agents) {
        bySession.set(agent.id, [...(bySession.get(agent.id) ?? []), agent]);
    }

    const rows = [...bySession.entries()]
        .map(([id, list]) => ({
            id,
            list: ordered(list).sort(
                (a, b) => STATES.indexOf(boardState(a)) - STATES.indexOf(boardState(b)),
            ),
            counts: countOf(list, known.get(id)),
        }))
        .sort(
            (a, b) =>
                Number(b.counts.waiting + b.counts.failed > 0) -
                    Number(a.counts.waiting + a.counts.failed > 0) ||
                b.counts.working - a.counts.working,
        );
    const grid = rows.map((row) => row.list.map((agent) => agent.conversationId));
    const byId = new Map(agents.map((agent) => [agent.conversationId, agent]));
    // Every state's count, older finished subagents left off the board included.
    const counts = Object.fromEntries(
        STATES.map((state) => [state, rows.reduce((sum, row) => sum + row.counts[state], 0)]),
    );
    const total = totalOf(counts);
    // What needs you, in the squares' order: waiting for an approval first, then failed.
    const needs = rows
        .flatMap((row) => row.list)
        .filter((agent) => ["waiting", "failed"].includes(boardState(agent)))
        .sort((a, b) => STATES.indexOf(boardState(a)) - STATES.indexOf(boardState(b)));
    const chosen = byId.get(selected) ?? null;
    const shown = byId.get(hovered) ?? chosen;
    const working = agents.some((agent) => live(boardState(agent)));

    useBack(true, closeBoard);
    // What the selected and hovered subagents do now: their peeks, while they show.
    useOnScreen(box);

    // The first that waits for an approval is selected when the board opens, or else the first square.
    useLayoutEffect(() => {
        if (selected === null && grid.length > 0) {
            setSelected(
                rows.flatMap((row) => row.list).find((agent) => agent.waiting)?.conversationId ??
                    grid[0][0],
            );
        }
    }, [grid.length > 0]);

    // Elapsed times tick while one works.
    useEffect(() => {
        if (!working) {
            return;
        }

        const timer = setInterval(() => tick((count) => count + 1), 1000);

        return () => clearInterval(timer);
    }, [working]);

    // The arrows move between squares, wrapping from row to row; Enter opens the one selected; Esc closes the board.
    const keys = useRef(null);

    keys.current = (event) => {
        if (event.defaultPrevented || store.state.sheet || store.state.launcher) {
            return;
        }

        const target = event.target;
        const typing =
            target instanceof HTMLElement &&
            (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

        if (event.key === "Escape") {
            event.preventDefault();
            closeBoard();

            return;
        }

        // Keys in the sidebar are the sidebar's, but for the rail's button that opened the board.
        const aside =
            target instanceof Element &&
            target.closest(".sidebar, .drawer") !== null &&
            !target.classList.contains("rail-agents");

        if (typing || aside || event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }

        if (event.key === "Enter") {
            // A focused button takes its own Enter, but for a square, and the rail's button that opened the board.
            const own =
                target instanceof HTMLButtonElement &&
                !target.classList.contains("board-cell") &&
                !target.classList.contains("rail-agents");

            if (chosen && !own) {
                event.preventDefault();
                open(chosen);
            }

            return;
        }

        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
            return;
        }

        event.preventDefault();

        if (grid.length === 0) {
            return;
        }

        let row = grid.findIndex((ids) => ids.includes(selected));

        if (row === -1) {
            setSelected(grid[0][0]);

            return;
        }

        let column = grid[row].indexOf(selected);

        if (event.key === "ArrowRight") {
            if (column < grid[row].length - 1) {
                column++;
            } else if (row < grid.length - 1) {
                row++;
                column = 0;
            }
        } else if (event.key === "ArrowLeft") {
            if (column > 0) {
                column--;
            } else if (row > 0) {
                row--;
                column = grid[row].length - 1;
            }
        } else if (event.key === "ArrowDown" && row < grid.length - 1) {
            row++;
            column = Math.min(column, grid[row].length - 1);
        } else if (event.key === "ArrowUp" && row > 0) {
            row--;
            column = Math.min(column, grid[row].length - 1);
        }

        setSelected(grid[row][column]);
        box.current
            ?.querySelector(`.board-cell[data-agent="${grid[row][column]}"]`)
            ?.scrollIntoView({ block: "nearest" });
    };

    useEffect(() => {
        const onKey = (event) => keys.current(event);

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    const pick = (id) => setSelected(id);
    const sessionCount = rows.length;
    const legend = [
        { key: "all", label: "All", count: total },
        ...STATES.filter((state) => counts[state] > 0).map((state) => ({
            key: state,
            label: LABELS[state],
            count: counts[state],
        })),
    ];

    const sessionRows = rows.map(({ id, list, counts: own }) => {
        // Finished long ago and left off the board: counted, not drawn.
        const older = totalOf(own) - list.length;
        const top = STATES.find((state) => list.some((agent) => boardState(agent) === state));
        const tone = top === "done" || top === "stopped" ? "quiet" : top;
        const title = titles.get(id) ?? `Session ${id}`;

        return html`<div
            key=${id}
            class=${`board-row ${list.some(matches) ? "" : "dim"}`}
        >
            <button
                class="board-session"
                title=${`Open ${title}`}
                onClick=${() => openSession(id)}
            >
                <span class="board-session-title">
                    <span
                        class="folder-mark"
                        style=${`--folder:${folderColor(cwds.get(id))}`}
                    ></span>
                    <span class="board-session-name">${title}</span>
                    ${
                        phone &&
                        html`<span class=${`board-summary ${tone}`}>
                            ${summaryOf(own, { short: true })}
                        </span>`
                    }
                </span>
                ${!phone && html`<span class=${`board-summary ${tone}`}>${summaryOf(own)}</span>`}
            </button>
            <div class="board-cells">
                ${list.map(
                    (agent) => html`<${Cell}
                        key=${agent.conversationId}
                        agent=${agent}
                        state=${boardState(agent)}
                        dim=${!matches(agent)}
                        selected=${agent.conversationId === selected}
                        onPick=${pick}
                        onHover=${phone ? () => {} : setHovered}
                    />`,
                )}
                ${
                    older > 0 &&
                    html`<span
                        class="board-older"
                        title=${`${older} more, finished earlier: open the session to see them`}
                    >
                        +${older}
                    </span>`
                }
            </div>
        </div>`;
    });

    const empty =
        boardAgents === null
            ? html`<div class="board-empty">Loading subagents…</div>`
            : agents.length === 0
              ? html`<div class="board-empty">
                    No subagents yet. Pi starts them when a task splits into parts that can run at once.
                </div>`
              : null;

    return html`<section
        class=${`board ${phone ? "phone" : ""}`}
        ref=${box}
        aria-label="Subagents in every session"
    >
        <header class="board-head">
            <div class="board-title">
                <h2>Subagents</h2>
                <div class="board-sub">
                    ${total} in ${sessionCount} session${sessionCount === 1 ? "" : "s"}
                </div>
            </div>
            ${!phone && html`<${Search} query=${query} setQuery=${setQuery} />`}
            <button
                class="icon-button"
                title="Back to the conversation (Esc)"
                aria-label="Close"
                onClick=${closeBoard}
            >
                <${Icon} name="close" />
            </button>
        </header>
        ${
            phone &&
            html`<div class="board-search-row">
                <${Search} query=${query} setQuery=${setQuery} />
            </div>`
        }
        ${
            agents.length > 0 &&
            html`<div class="board-summary-bar">
                <div class="board-states" aria-hidden="true">
                    ${STATES.filter((state) => counts[state] > 0).map(
                        (state) => html`<span
                            class=${`board-state ${state} ${filter === "all" || filter === state ? "" : "dim"}`}
                            style=${`flex-grow:${counts[state]}`}
                            title=${`${counts[state]} ${LABELS[state].toLowerCase()}`}
                        ></span>`,
                    )}
                </div>
                <div class="board-legend" role="group" aria-label="Show only">
                    ${legend.map(
                        (item) => html`<button
                            class=${`board-filter ${item.key} ${filter === item.key ? "on" : ""}`}
                            aria-pressed=${filter === item.key}
                            onClick=${() => setFilter(filter === item.key ? "all" : item.key)}
                        >
                            ${
                                item.key !== "all" &&
                                html`<${Mark} state=${item.key} glyph=${false} />`
                            }
                            ${item.label}
                            <span class="board-filter-count">${item.count}</span>
                        </button>`,
                    )}
                </div>
            </div>`
        }
        ${
            phone
                ? html`<div class=${`board-list ${chosen ? "with-bar" : ""}`}>
                      ${empty}
                      ${
                          needs.length > 0 &&
                          html`<${NeedsYou}
                              needs=${needs}
                              titles=${titles}
                              selected=${selected}
                              onPick=${pick}
                          />`
                      }
                      ${sessionRows}
                  </div>
                  ${
                      chosen &&
                      html`<${DetailBar}
                          key=${chosen.conversationId}
                          agent=${chosen}
                          title=${titles.get(chosen.id) ?? ""}
                          onClose=${() => setSelected(null)}
                      />`
                  }`
                : html`<div class="board-body">
                      <div class="board-main">
                          <div class="board-map">${empty}${sessionRows}</div>
                          <${StatusLine} agent=${shown} />
                      </div>
                      <aside class="board-side">
                          ${
                              needs.length > 0 &&
                              html`<${NeedsYou}
                                  needs=${needs}
                                  titles=${titles}
                                  selected=${selected}
                                  onPick=${pick}
                              />`
                          }
                          ${
                              chosen &&
                              html`<${Detail}
                                  key=${chosen.conversationId}
                                  agent=${chosen}
                                  title=${titles.get(chosen.id) ?? ""}
                              />`
                          }
                      </aside>
                  </div>`
        }
    </section>`;
}
