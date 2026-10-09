// Pi's sessions from the terminal, which the owner can continue here: the list, and one of them before it continues.
import { useEffect, useState } from "preact/hooks";
import { actions, attempt, closeSheet, navigate, notify, openSheet, store } from "../store.js";
import { html, Loader, Sheet, shortPath, timeAgo } from "../ui.js";

/** Only the owner: Pi's sessions are the owner's files. */
export const piSessionsAvailable = () => store.state.me?.role === "owner";

/** Pi's sessions on this computer, newest first, with a search by title and folder. */
export function PiSessionsSheet() {
    const home = store.state.server?.home;
    const [sessions, setSessions] = useState(null);
    const [problem, setProblem] = useState(null);
    const [query, setQuery] = useState("");

    useEffect(() => {
        actions.piSessions().then(
            (result) => setSessions(result.sessions),
            (error) => setProblem(error.message),
        );
    }, []);
    const needle = query.trim().toLowerCase();
    const shown = (sessions ?? []).filter(
        (session) =>
            needle === "" || `${session.title}\n${session.cwd}`.toLowerCase().includes(needle),
    );

    return html`<${Sheet} title="Continue a Pi session" onClose=${closeSheet}>
        <p class="muted small">
            Sessions of Pi in the terminal on this computer. One continues here as a new session; its file stays as it is.
        </p>
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${sessions === null && problem === null && html`<${Loader} label="Finding Pi's sessions" />`}
        ${
            sessions?.length === 0 &&
            html`<p class="muted">Pi has no sessions on this computer yet.</p>`
        }
        ${
            sessions?.length > 0 &&
            html`<input
                class="find-input"
                type="search"
                placeholder="Search by title or folder"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />`
        }
        <div class="group">
            ${shown.map(
                (session) => html`<button
                    class="list-item pi-session"
                    onClick=${() => openSheet({ type: "pi-session", id: session.path })}
                >
                    <span class="pi-session-name">
                        <span>${session.title}</span>
                        <span class="muted small mono">${shortPath(session.cwd, home)}</span>
                    </span>
                    <span class="muted small">
                        ${session.pocket ? "in Pocket · " : ""}${timeAgo(session.modified)}
                    </span>
                </button>`,
            )}
        </div>
        ${
            sessions?.length > 0 &&
            shown.length === 0 &&
            html`<p class="muted">No session matches “${query.trim()}”.</p>`
        }
    <//>`;
}

/** One of Pi's sessions: where it worked, its last messages, and continuing it here. */
export function PiSessionSheet({ path }) {
    const home = store.state.server?.home;
    const [info, setInfo] = useState(null);
    const [problem, setProblem] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        actions.piSession(path).then(setInfo, (error) => setProblem(error.message));
    }, [path]);

    const open = (id) => {
        closeSheet();
        navigate(id);
    };

    const go = () =>
        attempt(async () => {
            setBusy(true);

            try {
                const { id } = await actions.continuePiSession(path);

                open(id);
                notify(
                    "info",
                    "Continued from Pi. Pi has the conversation as Pi left it; nothing it did runs again.",
                );
            } finally {
                setBusy(false);
            }
        });

    if (info === null) {
        return html`<${Sheet} title="Pi session" onClose=${closeSheet}>
            ${
                problem === null
                    ? html`<${Loader} label="Reading the session" />`
                    : html`<div class="error-box small">${problem}</div>`
            }
        <//>`;
    }

    return html`<${Sheet} title=${info.title} onClose=${closeSheet}>
        <p class="muted small">
            <span class="mono">${shortPath(info.cwd, home)}</span> · ${info.messages} messages${info.model ? ` · ${info.model}` : ""}
        </p>
        ${
            info.model &&
            !info.modelHere &&
            html`<p class="muted small">
                Its model is not signed in here: it continues with Pi Pocket's usual model.
            </p>`
        }
        ${
            !info.cwdExists &&
            html`<div class="error-box small">
                The folder it worked in is not there anymore, so it cannot continue here.
            </div>`
        }
        ${
            info.pocket &&
            html`<p class="small">
                ${info.pocket.behind ? "Continued here before Pi went on in the terminal." : "Already continued here."}${" "}
                <button class="link" onClick=${() => open(info.pocket.id)}>Open it</button>
            </p>`
        }
        <div class="pi-preview">
            ${info.last.map(
                (line) => html`<div class=${`pi-line ${line.role}`}>
                    <span class="muted small">${line.role === "user" ? "You" : "Pi"}</span>
                    <div>${line.text}</div>
                </div>`,
            )}
        </div>
        <button class="button primary wide" disabled=${busy || !info.cwdExists} onClick=${go}>
            ${info.pocket ? "Continue it here again" : "Continue in Pocket"}
        </button>
        <p class="muted small">
            Pi gets the conversation as Pi left it, with Pi Pocket's instructions and tools. Nothing Pi did runs again, and the session's file stays as it is.
        </p>
    <//>`;
}
