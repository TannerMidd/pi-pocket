// Session cleanup's browser module, the owner's alone: "Remove and clean up" on archived sessions in the list, and a
// sheet that cleans up every archived session not used for a while. Each change shows what goes, and its size, first.
// It uses only `pocket`.
export const pocketApi = 2;

/** Lucide's archive-x icon. */
const ICON_PATH =
    "M3 3h18v5H3z M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8 M9.5 12.5l5 5 M14.5 12.5l-5 5";
const AGES = [
    { days: 0, label: "Any age" },
    { days: 7, label: "7 days" },
    { days: 30, label: "30 days" },
    { days: 90, label: "90 days" },
];
/** What stays, and that it is for good, for `count` sessions. */
const stays = (count) =>
    count === 1
        ? "Its transcript stays in Pi Pocket's database until Pi Durable can remove it. This cannot be undone."
        : "Their transcripts stay in Pi Pocket's database until Pi Durable can remove them. This cannot be undone.";

/** A size in words: 0 B, 12 KB, 3.4 MB, 1.2 GB. */
export function bytes(count) {
    if (count < 1024) {
        return `${count} B`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let value = count / 1024;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }

    return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** What a removal frees: the clean worktree, the uploads no fork reads, the logs. */
export function freed(plan) {
    return (
        (plan.worktree?.state === "clean" ? plan.worktree.bytes : 0) +
        (plan.uploads.kept ? 0 : plan.uploads.bytes) +
        plan.logs
    );
}

/** What a removal of these sessions ends, in one line; "" for nothing. */
export function endsLine(plans) {
    const sum = (key) => plans.reduce((total, plan) => total + Number(plan.ends[key]), 0);
    const parts = [
        [sum("schedules"), "schedule"],
        [sum("background"), "background task"],
        [sum("prWatch"), "PR watch", "PR watches"],
        [sum("hooks"), "webhook"],
        [sum("repoWatches"), "repository watch", "repository watches"],
        [sum("shares"), "published artifact link"],
        [sum("links"), "public page link"],
        [sum("lessons"), "session lesson"],
    ]
        .filter(([count]) => count > 0)
        .map(([count, one, many]) => plural(count, one, many));

    return parts.length === 0 ? "" : `These end too: ${parts.join(", ")}.`;
}

/** Why a worktree stays, in words. */
const WORKTREE_STAYS = {
    changes: "it has uncommitted changes",
    shared: "another session works in it",
    busy: "Pi works in it now",
};

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    // An app older than 0.20.0 has no session actions.
    if (typeof pocket.sessionAction !== "function") {
        return;
    }

    /**
     * The server's plan for `body` (`{ ids }` or `{ olderThanDays }`), loaded as the sheet opens, and again when `body`
     * or `round` changes.
     */
    function usePlan(body, round = 0) {
        const [state, setState] = useState({ loading: true });
        const key = `${JSON.stringify(body)} ${round}`;

        useEffect(() => {
            let live = true;

            setState({ loading: true });
            pocket
                .api("plan", body)
                .then((answer) => live && setState({ plans: answer.sessions }))
                .catch((failure) => live && setState({ error: failure.message }));

            return () => {
                live = false;
            };
        }, [key]);

        return state;
    }

    /** The sessions that stay, each with why. */
    function Stays({ plans }) {
        if (plans.length === 0) {
            return null;
        }

        return html`<details class="cleanup-stays">
            <summary>
                ${plural(plans.length, "session")} ${plans.length === 1 ? "stays" : "stay"}
            </summary>
            <ul>
                ${plans.map(
                    (plan) =>
                        html`<li key=${plan.id}>
                            <span class="cleanup-title">${plan.title}</span>
                            <span class="muted small">${plan.blocked}</span>
                        </li>`,
                )}
            </ul>
        </details>`;
    }

    /** The confirm of a removal: what goes, its size, and what stays. */
    function RemoveConfirm({ plans, close, onDone }) {
        const going = plans.filter((plan) => plan.blocked === undefined);
        const staying = plans.filter((plan) => plan.blocked !== undefined);
        const [working, setWorking] = useState(false);
        const [error, setError] = useState(null);
        const size = going.reduce((total, plan) => total + freed(plan), 0);
        const ends = endsLine(going);
        const kept = going.filter((plan) => plan.uploads.kept).length;

        const remove = async () => {
            setWorking(true);
            setError(null);

            try {
                const { outcomes } = await pocket.api("remove", {
                    ids: going.map((plan) => plan.id),
                });
                const done = outcomes.filter((outcome) => outcome.done);
                const failed = outcomes.filter((outcome) => !outcome.done);

                pocket.notify(
                    failed.length === 0 ? "info" : "warning",
                    failed.length === 0
                        ? `Removed ${plural(done.length, "session")} and cleaned up ${bytes(
                              done.reduce((total, outcome) => total + (outcome.bytes ?? 0), 0),
                          )}.`
                        : `Removed ${plural(done.length, "session")}. ${plural(failed.length, "session")} stayed: ${failed[0].why}`,
                );
                onDone?.();
                close();
            } catch (failure) {
                setError(failure.message);
                setWorking(false);
            }
        };

        return html`<div class="cleanup-sheet">
            ${
                going.length === 0
                    ? html`<p>Nothing can be removed now.</p>`
                    : html`<p>
                              <strong>
                                  ${going.length === 1 ? "1 session leaves" : `${going.length} sessions leave`}
                              </strong>
                              ${` the app. Pi Pocket removes its own files of ${going.length === 1 ? "it" : "them"}: `}
                              <strong>${bytes(size)}</strong>
                              ${" (worktrees, uploads, and background logs)."}
                          </p>
                          <p class="muted">${stays(going.length)}</p>
                          ${ends && html`<p class="muted small">${ends}</p>`}
                          ${
                              kept > 0 &&
                              html`<p class="muted small">
                                  The uploads of ${plural(kept, "session")} stay: a fork of
                                  ${kept === 1 ? "it" : "them"} still shows them.
                              </p>`
                          }`
            }
            ${
                going.length > 0 &&
                going.length <= 12 &&
                html`<ul class="cleanup-list" aria-label="Sessions that leave">
                    ${going.map(
                        (plan) =>
                            html`<li key=${plan.id}>
                                <span class="cleanup-title">${plan.title}</span>
                                <span class="muted small">${bytes(freed(plan))}</span>
                            </li>`,
                    )}
                </ul>`
            }
            <${Stays} plans=${staying} />
            ${error && html`<div class="error-box">${error}</div>`}
            <div class="cleanup-buttons">
                <button class="button" onClick=${close}>Cancel</button>
                ${
                    going.length > 0 &&
                    html`<button class="button danger" disabled=${working} onClick=${remove}>
                        ${working ? "Removing…" : `Remove ${plural(going.length, "session")}`}
                    </button>`
                }
            </div>
        </div>`;
    }

    /** "Remove and clean up" on sessions in the list: the confirm, for the sessions chosen. */
    function RemoveSheet({ close, sessions }) {
        const ids = Array.isArray(sessions) ? sessions : [];
        const state = usePlan({ ids });

        if (state.loading) {
            return html`<p class="muted cleanup-sheet">Looking at what goes…</p>`;
        }

        if (state.error !== undefined) {
            return html`<div class="cleanup-sheet">
                <div class="error-box">${state.error}</div>
                <div class="cleanup-buttons">
                    <button class="button" onClick=${close}>Close</button>
                </div>
            </div>`;
        }

        return html`<${RemoveConfirm} plans=${state.plans} close=${close} />`;
    }

    /** Clean up archived sessions: those not used for a while, their worktrees, or the sessions themselves. */
    function CleanupSheet({ close }) {
        const [days, setDays] = useState(30);
        const [confirming, setConfirming] = useState(false);
        const [round, setRound] = useState(0);
        const state = usePlan({ olderThanDays: days }, round);
        const [working, setWorking] = useState(false);
        const [error, setError] = useState(null);

        if (confirming && state.plans !== undefined) {
            return html`<${RemoveConfirm}
                plans=${state.plans}
                close=${() => setConfirming(false)}
                onDone=${() => setRound(round + 1)}
            />`;
        }

        const plans = state.plans ?? [];
        const worktrees = plans.filter((plan) => plan.worktree !== undefined);
        const clean = worktrees.filter((plan) => plan.worktree.state === "clean");
        const stuck = worktrees.filter((plan) => plan.worktree.state !== "clean");
        const going = plans.filter((plan) => plan.blocked === undefined);
        const worktreeBytes = clean.reduce((total, plan) => total + plan.worktree.bytes, 0);

        const cleanUp = async () => {
            setWorking(true);
            setError(null);

            try {
                const { outcomes } = await pocket.api("clean-up", {
                    ids: clean.map((plan) => plan.id),
                });
                const done = outcomes.filter((outcome) => outcome.done);

                pocket.notify(
                    "info",
                    `Removed ${plural(done.length, "worktree")}, ${bytes(
                        done.reduce((total, outcome) => total + (outcome.bytes ?? 0), 0),
                    )}.${done.length < outcomes.length ? ` ${plural(outcomes.length - done.length, "worktree")} stayed.` : ""}`,
                );
                setRound(round + 1);
            } catch (failure) {
                setError(failure.message);
            }

            setWorking(false);
        };

        return html`<div class="cleanup-sheet">
            <div class="cleanup-age">
                <span class="muted small">Archived and not used for</span>
                <div class="segmented" role="group" aria-label="Not used for">
                    ${AGES.map(
                        (age) =>
                            html`<button
                                key=${age.days}
                                class=${days === age.days ? "on" : ""}
                                aria-pressed=${days === age.days}
                                onClick=${() => setDays(age.days)}
                            >
                                ${age.label}
                            </button>`,
                    )}
                </div>
            </div>
            ${state.loading && html`<p class="muted">Looking at archived sessions…</p>`}
            ${state.error !== undefined && html`<div class="error-box">${state.error}</div>`}
            ${
                state.plans !== undefined &&
                html`<p>
                    ${
                        plans.length === 0
                            ? "No archived sessions match."
                            : `${plural(plans.length, "archived session")} ${plans.length === 1 ? "matches" : "match"}.`
                    }
                </p>`
            }
            ${
                plans.length > 0 &&
                html`<section class="cleanup-part">
                        <h3>Worktrees</h3>
                        <p class="muted small">
                            ${
                                clean.length === 0
                                    ? "No worktree of these can go."
                                    : `${plural(clean.length, "worktree")} can go: ${bytes(worktreeBytes)}. Their branches, the sessions, and their transcripts stay.`
                            }
                            ${
                                stuck.length > 0 &&
                                ` ${plural(stuck.length, "worktree")} ${stuck.length === 1 ? "stays" : "stay"}: ${WORKTREE_STAYS[stuck[0].worktree.state]}${stuck.length > 1 ? ", or another reason" : ""}.`
                            }
                        </p>
                        <button
                            class="button"
                            disabled=${clean.length === 0 || working}
                            onClick=${cleanUp}
                        >
                            ${working ? "Removing…" : "Remove worktrees"}
                        </button>
                    </section>
                    <section class="cleanup-part">
                        <h3>Remove and clean up</h3>
                        <p class="muted small">
                            ${
                                going.length === 0
                                    ? "No session of these can be removed now."
                                    : `The sessions leave the app, and Pi Pocket removes its own files of them: ${bytes(going.reduce((total, plan) => total + freed(plan), 0))}. ${stays(going.length)}`
                            }
                        </p>
                        <${Stays} plans=${plans.filter((plan) => plan.blocked !== undefined)} />
                        <button
                            class="button danger"
                            disabled=${going.length === 0 || working}
                            onClick=${() => setConfirming(true)}
                        >
                            ${`Remove ${plural(going.length, "session")}…`}
                        </button>
                    </section>`
            }
            ${error && html`<div class="error-box">${error}</div>`}
            <div class="cleanup-buttons">
                <button class="button" onClick=${close}>Done</button>
            </div>
        </div>`;
    }

    pocket.style("style.css");
    pocket.sheet({ id: "remove", title: "Remove and clean up", component: RemoveSheet });
    pocket.sheet({ id: "cleanup", title: "Clean up archived sessions", component: CleanupSheet });
    pocket.sessionAction({ id: "remove", label: "Remove and clean up", sheet: "remove" });
    pocket.launcher({
        id: "cleanup",
        label: "Clean up archived sessions",
        iconPath: ICON_PATH,
        keywords: ["archive", "worktrees", "disk", "space", "remove"],
        sheet: "cleanup",
    });
    pocket.menu({ id: "cleanup", label: "Clean up archived sessions", sheet: "cleanup" });
}
