// One subagent at work, as a sub-tile: the state square in its session's folder color, its name and state, and what it
// does this moment, from its own peek (or, until that arrives, what it was asked). Peek tiles nest these in a session's
// tile; the subagents board shows them under a session's row.
import { useRef } from "preact/hooks";
import { nowDoing } from "./agent-now.js";
import { store } from "./store.js";
import { html } from "./ui.js";

/** Two clicks (or taps) this close together open the subagent, where `onOpen` is given: the board's. */
const DOUBLE_MS = 350;

/** Whether it waits for an approval: the board knows at once; a peek tile, from the subagent's own peek. */
function waitingOf(agent, peek) {
    return agent.waiting === true || (peek?.approvals?.length ?? 0) > 0;
}

/**
 * What it does now; before its own peek arrives, what it was asked says more than "Working…". A call it waits on is
 * the call alone: the tile says it needs approval.
 */
function doingOf(agent, peek) {
    const approval = agent.waiting === true ? agent.approval : peek?.approvals?.[0];

    if (approval !== undefined) {
        return `${approval.tool} ${approval.subject}`.trim();
    }

    const doing = nowDoing(agent, peek);

    return peek === undefined && agent.asked !== undefined ? `Working on: ${agent.asked}` : doing;
}

/**
 * A subagent's sub-tile. `folder` is its session's folder color; `selected` marks it as the one the board shows.
 * `onActivate` takes a click (a peek tile opens it; the board picks it), and `onOpen` a double click or tap.
 */
export function AgentTile({ agent, folder, selected = false, onActivate, onOpen }) {
    const peek = agent.peek ?? store.state.peeks?.[agent.conversationId];
    const waiting = waitingOf(agent, peek);
    const state = waiting ? "waiting" : "working";
    const doing = doingOf(agent, peek);
    const last = useRef(0);

    // A double click, or a double tap: the first picks it, the second opens it. No native dblclick, which a double
    // tap does not always make.
    const activate = () => {
        const now = Date.now();

        if (onOpen !== undefined && now - last.current < DOUBLE_MS) {
            last.current = 0;
            onOpen();

            return;
        }

        last.current = now;
        onActivate();
    };

    return html`<button
        class=${`agent-tile ${state} ${selected ? "on" : ""}`}
        data-peek=${agent.conversationId}
        data-peek-kind="agent"
        title=${`${agent.name}: ${doing}`}
        aria-label=${`${agent.name}, ${waiting ? "needs approval" : "working"}: ${doing}`}
        onClick=${activate}
    >
        <span class="agent-tile-head">
            <span
                class=${`state-mark ${state}`}
                style=${`--folder:${waiting ? "var(--warn)" : (folder ?? "var(--muted)")}`}
                aria-hidden="true"
            ></span>
            <span class="agent-tile-name">${agent.name}</span>
            <span class="agent-tile-state">${waiting ? "needs approval" : "working"}</span>
        </span>
        <span class="agent-tile-now">${doing}</span>
    </button>`;
}
