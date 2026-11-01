// Updates' browser module, for the owner: a menu row and a launcher action that open the Update Pi Pocket sheet (the running
// version and how it was installed, the newest release and its notes, what stands in the way, and Update and restart), a notice once for each
// new version, and one for how an update ended, after its restart. It uses only `pocket`.
export const pocketApi = 1;

/** Lucide's refresh-cw icon. */
const ICON =
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M8 16H3v5";
const TOLD = "x.updates.told";
const ENDED = "x.updates.outcome";
/** An outcome older than this is not told: it is from an update before this browser looked. */
const RECENT_MS = 60 * 60 * 1000;

const remembered = (key) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const remember = (key, value) => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Private mode: told again next time.
    }
};

/** How the running copy was installed (`installKind` in the server's status), in words for the sheet. */
const INSTALLED = {
    "npm-global": "installed with npm (global)",
    "npm-local": "installed with npm (local)",
    npx: "run with npx",
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

const isBeta = (version) => typeof version === "string" && version.includes("-");

const named = (release) =>
    release.beta || isBeta(release.version) ? `${release.version} (beta)` : release.version;

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    let status = null;
    let failure = null;
    const listeners = new Set();

    const menu = pocket.menu({ id: "updates", label: "Update Pi Pocket", sheet: "updates" });
    const launcher = pocket.launcher({
        id: "updates",
        label: "Update Pi Pocket",
        detail: "Check for a new version of Pi Pocket",
        iconPath: ICON,
        keywords: ["update", "upgrade", "version", "release"],
        sheet: "updates",
    });

    /** While the server restarts for an update, its status is read again until the new one answers. */
    let poll = null;
    let gone = false;
    /** When the restart began, as this tab saw it: one that takes long says so. */
    let restartingSince = null;
    let slow = false;

    const later = () => {
        if (poll === null && !gone) {
            poll = setTimeout(() => {
                poll = null;
                pocket.api("status").then(publish, () => {
                    if (
                        !slow &&
                        restartingSince !== null &&
                        Date.now() - restartingSince > 120_000
                    ) {
                        slow = true;

                        for (const listener of listeners) {
                            listener();
                        }
                    }

                    later();
                });
            }, 2000);
        }
    };

    pocket.onDispose(() => {
        gone = true;
        clearTimeout(poll);
    });

    const publish = (next) => {
        if (gone) {
            return;
        }

        status = next;
        failure = null;

        if (next.step === "Restarting") {
            restartingSince ??= Date.now();
            later();
        } else {
            restartingSince = null;
            slow = false;
        }

        const hint =
            next.step ??
            (next.available && next.latest ? `${named(next.latest)} is out` : undefined);

        menu.update({ hint });
        launcher.update(
            next.available && next.latest
                ? {
                      label: `Update Pi Pocket to ${named(next.latest)}`,
                      detail: "See what is new, and update",
                  }
                : { label: "Update Pi Pocket", detail: "Check for a new version of Pi Pocket" },
        );

        if (next.available && next.latest && remembered(TOLD) !== next.latest.version) {
            remember(TOLD, next.latest.version);
            pocket.notify(
                "info",
                `Pi Pocket ${named(next.latest)} is out: Menu → Update Pi Pocket.`,
            );
        }

        const last = next.last;

        if (last && last.id !== remembered(ENDED) && Date.now() - last.at < RECENT_MS) {
            remember(ENDED, last.id);
            pocket.notify(last.ok ? "info" : "warning", last.message);
        }

        for (const listener of listeners) {
            listener();
        }
    };

    const fail = (error) => {
        if (gone) {
            return;
        }

        failure = error.message;

        for (const listener of listeners) {
            listener();
        }
    };

    const refresh = () => pocket.api("status").then(publish, fail);

    pocket.on("status", publish);
    refresh();

    const useStatus = () => {
        const [, redraw] = useState(0);

        useEffect(() => {
            const listener = () => redraw((count) => count + 1);

            listeners.add(listener);
            refresh();

            return () => listeners.delete(listener);
        }, []);

        return status;
    };

    function List({ items, tone }) {
        return html`<ul class=${`updates-list ${tone}`}>
            ${items.map((item) => html`<li key=${item}><${pocket.Markdown} text=${item} /></li>`)}
        </ul>`;
    }

    function Updates() {
        const current = useStatus();
        const [working, setWorking] = useState(null);
        const [error, setError] = useState(null);
        const [confirmed, setConfirmed] = useState(false);
        const version = current?.latest?.version;

        // A tick for one release's warning is not one for the next.
        useEffect(() => setConfirmed(false), [version]);
        // Contact lost, then a status came: the server answers again, so the words about it go.
        useEffect(() => setError((shown) => (shown?.lost ? null : shown)), [current]);

        const run = async (label, work) => {
            setWorking(label);
            setError(null);

            try {
                const next = await work();

                if (next) {
                    publish(next);
                }
            } catch (failed) {
                // No status: the request got no answer (the phone slept, or the server is restarting).
                setError(
                    failed.status === undefined
                        ? {
                              text: "Lost contact with the server. An update may still go on: this sheet follows it.",
                              lost: true,
                          }
                        : { text: failed.message, lost: false },
                );
                later();
            } finally {
                setWorking(null);
            }
        };

        const check = () => run("Checking", () => pocket.api("check", {}));

        const update = () =>
            run("Updating", async () => {
                const answer = await pocket.api("apply", {
                    confirmWarning: confirmed,
                    allowBusy: true,
                });

                pocket.notify(
                    "info",
                    `Updating to ${answer.version}. The app comes back after the restart.`,
                );
                // The server restarts in a moment: what comes next is its status event, then a new hello.
                publish({ ...status, step: "Restarting" });

                return null;
            });

        if (current === null) {
            return failure
                ? html`<div class="error-box">${failure}</div>`
                : html`<${pocket.Loader} label="Reading the version" />`;
        }

        const latest = current.latest;
        // Notes that warn, or notes Pi Pocket could not read: the owner's word first.
        const careful = latest !== undefined && (latest.warning || latest.unread === true);
        const step = current.step ?? working;
        // While an update moves the checkout, the server does not read it: no commit then is no word on it.
        // A server older than this field, or one that cannot tell, sends no kind: the checkout words then.
        const where = Object.hasOwn(INSTALLED, current.installKind)
            ? INSTALLED[current.installKind]
            : current.commit
              ? `${current.branch ?? "detached"} · ${current.commit.slice(0, 7)}`
              : current.step === undefined
                ? "not a git checkout"
                : null;

        return html`<div class="updates-sheet">
            <div class="updates-card">
                <div class="updates-row">
                    <div>
                        <div class="updates-title">
                            Pi Pocket ${current.version}
                            ${
                                isBeta(current.version) &&
                                html` <span class="updates-badge">Beta</span>`
                            }
                        </div>
                        ${where && html`<div class="muted small mono">${where}</div>`}
                        <div class="muted small">
                            ${current.beta ? "Beta updates are on." : "Stable releases only."}
                        </div>
                    </div>
                    <button
                        class="button"
                        disabled=${step !== null && step !== undefined}
                        onClick=${check}
                    >
                        Check now
                    </button>
                </div>
                ${
                    step === "Checking" && !current.available
                        ? html`<div class="updates-step">
                              <${pocket.Spinner} label="Checking" />
                              <span>Checking…</span>
                          </div>`
                        : html`<div class="muted small">
                              ${
                                  current.error
                                      ? "Could not check."
                                      : current.available
                                        ? `${named(latest)} is out.`
                                        : latest
                                          ? "This is the newest version."
                                          : current.checkedAt
                                            ? "No release found."
                                            : "Not checked since the server started."
                              }
                              ${current.checkedAt ? ` Last look ${ago(current.checkedAt)}.` : ""}
                          </div>`
                }
                ${current.error && html`<div class="error-box">${current.error}</div>`}
                ${
                    failure &&
                    html`<div class="error-box">Could not read the status again: ${failure}</div>`
                }
            </div>
            ${
                current.last &&
                html`<div class=${`updates-card ${current.last.ok ? "" : "updates-warn"}`}>
                    <div class="updates-label">Last update · ${ago(current.last.at)}</div>
                    <div>${current.last.message}</div>
                    ${
                        !current.last.ok &&
                        current.available &&
                        current.last.toVersion === latest.version &&
                        html`<div class="muted small">
                            Pi Pocket does not try this version again by itself. The button below
                            does.
                        </div>`
                    }
                </div>`
            }
            ${
                current.available &&
                html`<div class="updates-card updates-new">
                    <div class="updates-row">
                        <div class="updates-title">
                            ${latest.name}
                            ${
                                (latest.beta || isBeta(latest.version)) &&
                                html` <span class="updates-badge">Beta</span>`
                            }
                        </div>
                        ${
                            latest.url &&
                            html`<a
                                class="small updates-link"
                                href=${latest.url}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                On GitHub
                            </a>`
                        }
                    </div>
                    ${
                        latest.publishedAt &&
                        !Number.isNaN(Date.parse(latest.publishedAt)) &&
                        html`<div class="muted small">
                            Released ${ago(Date.parse(latest.publishedAt))}
                        </div>`
                    }
                    ${
                        latest.notes &&
                        html`<details class="updates-notes" open=${careful}>
                            <summary>Release notes</summary>
                            <div class="updates-notes-body">
                                <${pocket.Markdown} text=${latest.notes} />
                            </div>
                        </details>`
                    }
                    ${
                        current.blockers.length > 0 &&
                        html`<div class="updates-label">Pi Pocket cannot update itself now</div>
                            <${List} items=${current.blockers} tone="updates-blockers" />`
                    }
                    ${
                        current.cautions.length > 0 &&
                        html`<div class="updates-label">Before you update</div>
                            <${List} items=${current.cautions} tone="updates-cautions" />`
                    }
                    ${
                        careful &&
                        current.blockers.length === 0 &&
                        html`<label class="updates-confirm">
                            <input
                                type="checkbox"
                                checked=${confirmed}
                                onChange=${(event) => setConfirmed(event.currentTarget.checked)}
                            />
                            <span>
                                ${
                                    latest.warning
                                        ? "I read the warning in the release notes."
                                        : "I read the release notes on GitHub."
                                }
                            </span>
                        </label>`
                    }
                    ${error && html`<div class="error-box">${error.text}</div>`}
                    ${
                        step
                            ? html`<div class="updates-step">
                                      <${pocket.Spinner} label=${step} />
                                      <span>${step}…</span>
                                  </div>
                                  ${
                                      slow &&
                                      html`<p class="muted small">
                                          This takes longer than usual. If the new version does not
                                          start in 5 minutes, the launcher goes back to the version
                                          before. The server's log says why.
                                      </p>`
                                  }`
                            : html`<button
                                  class="button primary updates-go"
                                  disabled=${current.blockers.length > 0 || (careful && !confirmed)}
                                  onClick=${update}
                              >
                                  Update to ${named(latest)} and restart
                              </button>`
                    }
                </div>`
            }
            ${!current.available && error && html`<div class="error-box">${error}</div>`}
            <p class="muted small">
                To look for new versions, install them by themselves, or turn Beta updates on or
                off, open Menu → Extensions → Installed → Pi Pocket updates.
            </p>
        </div>`;
    }

    pocket.sheet({ id: "updates", title: "Update Pi Pocket", component: Updates });
    pocket.style("style.css");
}
