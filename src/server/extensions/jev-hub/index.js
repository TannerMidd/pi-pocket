// The Jev Hub, for the owner: a menu row and a launcher action that open a sheet with counts of every
// Jev call since the hub started, and the recent provider verdicts. It keeps nothing: the server sends
// only numbers and verdict words. It uses only `pocket`.
export const pocketApi = 1;

/** Lucide's activity icon. */
const ICON =
    "M22 12h-2.48a2 2 0 0 0-1.92 1.45l-2.21 8.06a2 2 0 0 1-3.92 0L6.99 2.49a2 2 0 0 0-3.92 0L.86 10.55A2 2 0 0 1 0 12";

const SOURCES = {
    "relay-inbound": "Relay inbound",
    "relay-outbound": "Relay outbound",
    "agent-teams": "Agent Teams",
    "pip-search": "PiP search",
    "browser-screenshots": "Browser screenshots",
    "memory-suggestions": "Memory suggestions",
    "run-outcomes": "Run outcomes",
};

const VERDICTS = {
    blocked: "Blocked",
    "broken-layout": "Broken layout",
    completed: "Completed",
    loading: "Still loading",
    needs_input: "Needs input",
    unclear: "Outcome unclear",
};

const STATUSES = {
    answered: { label: "Answered", tone: "ok" },
    failed: { label: "Failed", tone: "err" },
    "timed-out": { label: "Timed out", tone: "warn" },
};

/** "5 minutes ago", "3 hours ago", "2 days ago". */
function ago(at) {
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));

    if (minutes < 1) {
        return "just now";
    }

    if (minutes < 60) {
        return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }

    const hours = Math.round(minutes / 60);

    if (hours < 48) {
        return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    }

    return `${Math.round(hours / 24)} days ago`;
}

const when = (at) => new Date(at).toLocaleString();

/** "1.2 s", "3 s". */
const took = (ms) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    pocket.menu({ id: "jev-hub", label: "Jev Hub", sheet: "jev-hub" });
    pocket.launcher({
        id: "jev-hub",
        label: "Jev Hub",
        detail: "Classifier activity and verdicts",
        iconPath: ICON,
        keywords: ["jev", "hub", "verdicts", "counts"],
        sheet: "jev-hub",
    });

    function JevHub() {
        const [activity, setActivity] = useState(null);
        const [error, setError] = useState(null);
        const [working, setWorking] = useState(false);

        const read = async () => {
            setWorking(true);
            setError(null);

            try {
                setActivity(await pocket.api("activity"));
            } catch (failed) {
                setError(failed.message ?? "Could not read the Jev Hub.");
            } finally {
                setWorking(false);
            }
        };

        // Every open reads again: the Hub does not stream.
        useEffect(() => {
            void read();
        }, []);

        const head = (text) => html`<div class="jev-label">${text}</div>`;

        const chip = (tone, text) => html`<span class=${`jev-chip ${tone}`}>${text}</span>`;

        const counts = (total) =>
            html`<div class="jev-counts">
                <span class="jev-count ok">${total.answered} answered</span>
                <span class="jev-count err">${total.failed} failed</span>
                <span class="jev-count warn">${total.timedOut} timed out</span>
            </div>`;

        if (error !== null) {
            return html`<div class="jev-sheet">
                <div class="error-box">${error}</div>
                <div class="jev-buttons">
                    <button class="button" disabled=${working} onClick=${read}>
                        ${working ? "Reading…" : "Try again"}
                    </button>
                </div>
            </div>`;
        }

        if (activity === null) {
            return html`<${pocket.Loader} label="Reading the Jev Hub" />`;
        }

        const totals = activity.totals ?? [];
        const recent = activity.recent ?? [];
        const nothing = totals.every(
            (total) => total.answered + total.failed + total.timedOut === 0,
        );

        return html`<div class="jev-sheet">
            <div class="jev-card jev-head">
                <div>
                    ${head("Classifier calls since the hub started")}
                    <div class="muted small mono">${when(activity.startedAt)}</div>
                </div>
                <button class="button" disabled=${working} onClick=${read}>
                    ${working ? "Reading…" : "Refresh"}
                </button>
            </div>
            ${
                activity.classifierModel === null &&
                html`<div class="jev-card jev-empty" role="status">
                    <div class="jev-source">No classifier model is chosen</div>
                    <div class="muted small">
                        Pick one in Menu → Providers. Until then the classifier features do nothing,
                        except a module with a Classify model of its own.
                    </div>
                </div>`
            }
            ${
                nothing
                    ? html`<div class="jev-card jev-empty">
                          <div class="jev-source">No classifier calls yet</div>
                          <div class="muted small">
                              Enable an integration such as Run outcomes in Menu → Extensions.
                          </div>
                      </div>`
                    : html`<div class="jev-totals">
                          ${totals.map(
                              (total) =>
                                  html`<div key=${total.source} class="jev-card">
                                      <div class="jev-source">
                                          ${SOURCES[total.source] ?? total.source}
                                      </div>
                                      ${counts(total)}
                                  </div>`,
                          )}
                      </div>`
            }
            ${head("Recent provider verdicts")}
            ${
                recent.length === 0
                    ? html`<div class="jev-card jev-empty">
                          <div class="muted">No recent calls to show.</div>
                      </div>`
                    : html`<ul class="jev-recent">
                          ${recent.map(
                              (entry, index) =>
                                  html`<li key=${index} class="jev-card">
                                      <div class="jev-entry-head">
                                          <div class="jev-entry-source">
                                              ${SOURCES[entry.source] ?? entry.source}
                                          </div>
                                          <div class="jev-entry-meta">
                                              ${chip(
                                                  STATUSES[entry.status]?.tone ?? "",
                                                  STATUSES[entry.status]?.label ?? entry.status,
                                              )}
                                              <span class="muted small">${ago(entry.at)}</span>
                                              <span class="muted small"
                                                  >${took(entry.elapsedMs)}</span
                                              >
                                          </div>
                                      </div>
                                      ${
                                          entry.verdicts?.length > 0 &&
                                          html`<ul class="jev-verdicts">
                                              ${entry.verdicts.map(
                                                  (verdict, at) =>
                                                      html`<li key=${at} class="mono jev-verdict">
                                                          ${VERDICTS[verdict] ?? verdict}
                                                      </li>`,
                                              )}
                                          </ul>`
                                      }
                                  </li>`,
                          )}
                      </ul>`
            }
            <p class="muted small">
                Counts are since the hub started, and reset when the server restarts or the hub is
                turned off and on. The rows show provider verdicts, not actions Pi Pocket took. The
                hub keeps no prompts, no screenshots, and no transcript IDs.
            </p>
        </div>`;
    }

    pocket.sheet({ id: "jev-hub", title: "Jev Hub", component: JevHub, wide: true });
    pocket.style("style.css");
}
