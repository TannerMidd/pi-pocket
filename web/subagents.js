// The subagents bar, above the message box: this session's subagents at a glance. It shows while one works or has a
// report on its way to Pi, and after they finish until it is put away. Folded, one line: how many work and how many
// are done, and what the newest one does. Unfolded, a row each: what it was asked, what it does this moment (its peek,
// as tiles have), for how long, whether its report is on its way, Stop, and a tap to open it.
import { useEffect, useRef, useState } from "preact/hooks";
import { nowDoing } from "./agent-now.js";
import { useOnScreen } from "./peeks.js";
import { fromServer } from "./seen.js";
import { api, attempt, canSteer, navigate, openSheet, store } from "./store.js";
import { html, Icon, Spinner, timeAgo } from "./ui.js";
import { t } from "./ui-locale.js";

/**
 * When each session's bar was put away, in this browser, as the newest thing its subagents did then (the server's clock,
 * as theirs is): it shows again once one does something newer.
 */
const AWAY_KEY = "pocket.subagentsAway";

function awayMarks() {
    try {
        return JSON.parse(localStorage.getItem(AWAY_KEY) ?? "{}");
    } catch {
        return {};
    }
}

/** The server's time of the newest thing a subagent did: asked, or answered. */
const newest = (agent) => Math.max(agent.askedAt ?? 0, agent.answeredAt ?? 0);

function putAway(id, agents) {
    const marks = { ...awayMarks(), [id]: Math.max(0, ...agents.map(newest)) };
    // The newest few sessions' marks are enough.
    const kept = Object.entries(marks)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50);

    localStorage.setItem(AWAY_KEY, JSON.stringify(Object.fromEntries(kept)));
}

/** Unfold the bar, as the top bar's count of working subagents does: for this session only. */
export const openSubagents = () => store.set({ subagentsOpen: store.state.conversationId });

/** Where a subagent is: working, done, stopped, or failed. */
export const stateOf = (agent) =>
    agent.busy ? "working" : agent.stopped ? "stopped" : agent.failed ? "failed" : "done";

/** A failed subagent nobody has dealt with yet: it needs someone, on the board, the rail, and the session list. */
export const unresolved = (agent) => stateOf(agent) === "failed" && agent.dealt !== true;

/** Say a subagent's failure was dealt with: the one this browser shows (by its time), so a newer one still shows. */
export const dismiss = (agent) =>
    api(`c/${agent.conversationId}/dismiss`, { at: agent.answeredAt ?? 0 });

/** A failure shown to someone who can deal with it, who opens the subagent: seen, it needs nobody now. */
export function seeFailure(agent) {
    if (agent && unresolved(agent) && canSteer()) {
        dismiss(agent).catch(() => {});
    }
}

/** Open a subagent's conversation, from this session's subagents or the board; a failure it had is seen there. */
export function openSubagent(id) {
    const { boardAgents, view } = store.state;

    seeFailure(
        [...(view.subagents ?? []), ...(boardAgents ?? [])].find(
            (agent) => agent.conversationId === id,
        ),
    );
    navigate(id);
}

/** The mark a row starts with, for a subagent that is not working. */
const MARKS = { done: "✓", stopped: "■", failed: "!" };

/** Each state's name: a key and its English, looked up as it draws. */
const STATE_NAMES = {
    working: ["web.subagents.state-of.working", "working"],
    stopped: ["web.subagents.state-of.stopped", "stopped"],
    failed: ["web.subagents.state-of.failed", "failed"],
    done: ["web.subagents.state-of.done", "done"],
};

/** How long since `ms`, a time the server took: "45s", "3m 05s", "1h 12m". */
export function elapsed(ms) {
    const seconds = Math.max(0, Math.round((Date.now() - fromServer(ms)) / 1000));

    if (seconds < 60) {
        return `${seconds}s`;
    }

    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
    }

    return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}

/** The order of the states, in the dots and the rows: working, then trouble, then done. */
const RANK = { working: 0, failed: 1, stopped: 2, done: 3 };

/** By state; working ones newest asked first, the rest newest answer first. */
export function ordered(agents) {
    return [...agents].sort(
        (a, b) =>
            RANK[stateOf(a)] - RANK[stateOf(b)] ||
            (a.busy
                ? (b.askedAt ?? 0) - (a.askedAt ?? 0)
                : (b.answeredAt ?? 0) - (a.answeredAt ?? 0)),
    );
}

function AgentRow({ agent }) {
    const stop = () => attempt(() => api(`c/${agent.conversationId}/abort`, {}));
    const status = stateOf(agent);
    // A failure someone dealt with says so, as the board does.
    const dealt = status === "failed" && agent.dealt;
    const at = agent.answeredAt ? timeAgo(fromServer(agent.answeredAt)) : "";
    const when = agent.busy
        ? agent.askedAt && elapsed(agent.askedAt)
        : at &&
          (dealt
              ? t("web.subagents.agent-row.when.dismissed", "{state} {when} · dismissed", {
                    state: t(...STATE_NAMES[status]),
                    when: at,
                })
              : t("web.subagents.agent-row.when.state-when", "{state} {when}", {
                    state: t(...STATE_NAMES[status]),
                    when: at,
                }));

    return html`<div class=${`agent-row ${status}`} data-peek=${agent.conversationId}>
        <button class="agent-open" onClick=${() => openSubagent(agent.conversationId)}>
            <span class="agent-mark" aria-hidden="true">
                ${agent.busy ? html`<${Spinner} />` : MARKS[status]}
            </span>
            <span class="agent-main">
                <span class="agent-head">
                    <span class="agent-name">${agent.name}</span>
                    ${when && html`<span class="agent-when">${when}</span>`}
                    ${agent.reporting && html`<span class="agent-chip">${t("web.subagents.agent-row.span.report-way-pi", "report on its way to Pi")}</span>`}
                </span>
                ${agent.busy && html`<span class="agent-now">${nowDoing(agent)}</span>`}
                ${status === "failed" && agent.error && html`<span class="agent-error">${agent.error}</span>`}
                ${agent.asked && html`<span class="agent-asked">${agent.asked}</span>`}
            </span>
        </button>
        ${
            agent.busy &&
            canSteer() &&
            html`<button
                class="icon-button agent-stop"
                aria-label=${t("web.subagents.agent-row.aria-label.stop", "Stop {name}", {
                    name: agent.name,
                })}
                title=${t("web.subagents.agent-row.title.stop", "Stop")}
                onClick=${stop}
            >
                <${Icon} name="stop" size=${13} />
            </button>`
        }
    </div>`;
}

/**
 * Reports a spend limit holds back: why they wait, and for the owner the way to raise it. They go once it is raised.
 */
function Held({ why }) {
    const owner = store.state.me?.role === "owner";

    return html`<div class="agents-held" role="status">
        <span>${t("web.subagents.held.span.reports-wait", "Reports wait: {why}.", { why })}</span>
        ${
            owner
                ? html`<button class="link" onClick=${() => openSheet({ type: "spend" })}>
                      ${t("web.subagents.held.button.raise-it", "Raise it")}
                  </button>`
                : html`<span>${t(
                      "web.subagents.held.span.they-go-once-owner",
                      "They go once the owner raises it.",
                  )}</span>`
        }
    </div>`;
}

/** The bar, while it shows: its hooks watch its rows for peeks, and tick the elapsed times. */
function Bar({ agents, active, open, held }) {
    const box = useRef(null);
    const [, rerender] = useState(0);
    const count = (status) => agents.filter((agent) => stateOf(agent) === status).length;
    const working = agents.filter((agent) => agent.busy);
    const lead = ordered(working)[0];
    // Trouble first: on a phone the end of the line may not fit.
    const kinds = ["working", "failed", "stopped", "done"].filter((status) => count(status) > 0);
    // "3 subagents working" when one kind says it all; "2 working · 1 done · 1 failed", short for a phone, when not.
    const summary =
        kinds.length === 1
            ? agents.length === 1
                ? t("web.subagents.bar.summary.one", "1 subagent {state}", {
                      state: t(...STATE_NAMES[kinds[0]]),
                  })
                : t("web.subagents.bar.summary.state", "{count} subagents {state}", {
                      count: agents.length,
                      state: t(...STATE_NAMES[kinds[0]]),
                  })
            : kinds
                  .map((status) =>
                      t("web.subagents.bar.summary.part", "{count} {state}", {
                          count: count(status),
                          state: t(...STATE_NAMES[status]),
                      }),
                  )
                  .join(" · ");
    const shown = ordered(agents);

    // The rows' and the folded line's peeks: what each working subagent does now.
    useOnScreen(box);
    // Elapsed times tick while one works.
    useEffect(() => {
        if (working.length === 0) {
            return;
        }

        const timer = setInterval(() => rerender((count) => count + 1), 1000);

        return () => clearInterval(timer);
    }, [working.length]);

    // What the button says, the newest one's work too: the label stands for everything in it.
    const label = t("web.subagents.bar.label.subagents", "Subagents: {summary}{name}", {
        summary,
        name:
            lead && !open
                ? t("web.subagents.bar.label.lead", ". {name}: {doing}", {
                      name: lead.name,
                      doing: nowDoing(lead),
                  })
                : "",
    });

    return html`<div
        class=${`agents-bar ${open ? "open" : ""} ${working.length > 0 ? "busy" : ""}`}
        data-part="subagents-bar"
        ref=${box}
    >
        <div class="agents-top">
            <button
                class="agents-summary"
                aria-label=${label}
                aria-expanded=${open}
                onClick=${() =>
                    store.set({ subagentsOpen: open ? null : store.state.conversationId })}
            >
                <span class="agents-dots" aria-hidden="true">
                    ${shown
                        .slice(0, 6)
                        .map(
                            (agent) => html`<span class=${`agents-dot ${stateOf(agent)}`}></span>`,
                        )}
                    ${shown.length > 6 && html`<span class="agents-more">+${shown.length - 6}</span>`}
                </span>
                <span class="agents-count">${summary}</span>
                ${
                    lead &&
                    !open &&
                    html`<span class="agents-lead" data-peek=${lead.conversationId}>
                        ${t("web.subagents.bar.span.lead", "{name}: {doing}", {
                            name: lead.name,
                            doing: nowDoing(lead),
                        })}
                    </span>`
                }
                <span class="agents-chevron"><${Icon} name="chevron" size=${14} /></span>
            </button>
            ${
                !active &&
                html`<button
                    class="icon-button"
                    aria-label=${t(
                        "web.subagents.bar.aria-label.put-subagents-bar-away",
                        "Put the subagents bar away",
                    )}
                    title=${t("web.subagents.bar.title.put-away", "Put away")}
                    onClick=${() => {
                        putAway(store.state.conversationId, agents);
                        store.set({ subagentsOpen: null });
                    }}
                >
                    <${Icon} name="close" size=${13} />
                </button>`
            }
        </div>
        ${held && html`<${Held} why=${held} />`}
        ${
            open &&
            html`<div class="agents-list">
                ${shown.map((agent) => html`<${AgentRow} key=${agent.name} agent=${agent} />`)}
            </div>`
        }
    </div>`;
}

/**
 * This session's subagents, while one works or has a report on its way, and after until put away. Once put away, it
 * counts and lists only those that did something since.
 */
export function SubagentsBar() {
    const { view, conversationId, subagentsOpen } = store.state;
    const away = awayMarks()[conversationId] ?? 0;
    const agents = (view.subagents ?? []).filter(
        (agent) => agent.busy || agent.reporting || newest(agent) > away,
    );

    if (agents.length === 0) {
        return null;
    }

    return html`<${Bar}
        agents=${agents}
        held=${view.subagentsHeld}
        active=${agents.some((agent) => agent.busy || agent.reporting)}
        open=${subagentsOpen === conversationId}
    />`;
}
