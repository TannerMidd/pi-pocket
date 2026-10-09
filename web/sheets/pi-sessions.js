// Pi's sessions from the terminal, which the owner can continue here: the list, by folder, and one of them before it
// continues, as a short conversation.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { actions, attempt, closeSheet, navigate, notify, openSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet, shortPath, timeAgo } from "../ui.js";

/** Only the owner: Pi's sessions are the owner's files. */
export const piSessionsAvailable = () => store.state.me?.role === "owner";

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A folder's last part, and the folder it is in: `pi-pocket`, `~/code`. */
function folderParts(cwd, home) {
    const path = shortPath(cwd, home);
    const cut = path.replace(/\/+$/, "").lastIndexOf("/");

    return cut <= 0
        ? { name: path, parent: "" }
        : { name: path.slice(cut + 1), parent: path.slice(0, cut) };
}

/** The sessions by folder, the folder used last first; each folder's newest first, as they come. */
function byFolder(sessions) {
    const folders = new Map();

    for (const session of sessions) {
        folders.set(session.cwd, [...(folders.get(session.cwd) ?? []), session]);
    }

    return [...folders];
}

function SessionRow({ session }) {
    const pocket = session.pocket;

    return html`<button
        class="pi-session"
        onClick=${() => openSheet({ type: "pi-session", id: session.path })}
    >
        <span class="pi-session-text">
            <span class="pi-session-title">${session.title}</span>
            <span class="pi-session-meta">
                ${plural(session.messages, "message")} · ${timeAgo(session.modified)}
            </span>
        </span>
        ${
            pocket &&
            html`<span class=${`pi-tag ${pocket.behind ? "behind" : ""}`}>
                ${pocket.behind ? "Pi went on" : "in Pocket"}
            </span>`
        }
        <${Icon} name="chevron" size=${14} />
    </button>`;
}

/** Pi's sessions on this computer, by folder, with a search the server runs through all of them, words included. */
export function PiSessionsSheet() {
    const home = store.state.server?.home;
    const [sessions, setSessions] = useState(null);
    // Whether Pi has any at all, from the first list: a search that finds none is not "no sessions".
    const [any, setAny] = useState(null);
    const [problem, setProblem] = useState(null);
    const [query, setQuery] = useState("");
    const needle = query.trim();
    const box = useRef(null);
    const results = useRef(null);
    // The list's height as it first showed: fewer results while searching keep the sheet that tall, so the box stays put.
    const [floor, setFloor] = useState(0);

    useEffect(() => {
        let current = true;
        // A pause in typing, then the search: the first list at once.
        const timer = setTimeout(
            () =>
                actions.piSessions(needle).then(
                    (result) => {
                        if (current) {
                            setSessions(result.sessions);
                            setAny((was) => was ?? result.sessions.length > 0);
                        }
                    },
                    (error) => current && setProblem(error.message),
                ),
            needle === "" ? 0 : 250,
        );

        return () => {
            current = false;
            clearTimeout(timer);
        };
    }, [needle]);
    const folders = byFolder(sessions ?? []);

    useLayoutEffect(() => {
        if (floor === 0 && needle === "" && sessions?.length > 0 && results.current) {
            setFloor(results.current.offsetHeight);
        }
    }, [sessions]);
    // Straight to the search where there are keys to type it with.
    useEffect(() => {
        if (any && !matchMedia("(pointer: coarse)").matches) {
            box.current?.focus({ preventScroll: true });
        }
    }, [any]);

    return html`<${Sheet} title="Continue a Pi session" onClose=${closeSheet}>
        <p class="muted small">
            Sessions of Pi in the terminal on this computer. One continues here as a new session; its file stays as it is.
        </p>
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${sessions === null && problem === null && html`<${Loader} label="Finding Pi's sessions" />`}
        ${any === false && html`<p class="muted">Pi has no sessions on this computer yet.</p>`}
        ${
            any === true &&
            html`<input
                class="find-input"
                type="search"
                ref=${box}
                placeholder="Search sessions"
                aria-label="Search Pi's sessions: titles, folders, and messages"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />`
        }
        <div
            class="pi-results"
            ref=${results}
            style=${floor > 0 ? `min-height:${floor}px` : ""}
        >
            ${folders.map(([cwd, list]) => {
                const { name, parent } = folderParts(cwd, home);

                return html`<section class="pi-folder" key=${cwd}>
                    <div class="pi-folder-head" title=${cwd}>
                        <${Icon} name="folder" size=${14} />
                        <span class="pi-folder-name">${name}</span>
                        ${parent && html`<span class="pi-folder-parent">${parent}</span>`}
                    </div>
                    <div class="pi-folder-list">
                        ${list.map((session) => html`<${SessionRow} key=${session.path} session=${session} />`)}
                    </div>
                </section>`;
            })}
            ${
                any === true &&
                needle !== "" &&
                sessions?.length === 0 &&
                html`<p class="muted">No session matches “${needle}”.</p>`
            }
        </div>
    <//>`;
}

/** One of Pi's sessions: where it worked and with what, its last messages, and continuing it here. */
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

    return html`<${Sheet} title="Pi session" onClose=${closeSheet}>
        <h3 class="pi-title">${info.title}</h3>
        <dl class="pi-facts">
            <div>
                <dt>Folder</dt>
                <dd class="mono">${shortPath(info.cwd, home)}</dd>
            </div>
            <div>
                <dt>Model</dt>
                <dd class="mono">
                    ${info.model ?? "—"}${info.model && !info.modelHere ? html`<span class="muted"> · not signed in here</span>` : ""}
                </dd>
            </div>
            <div>
                <dt>Messages</dt>
                <dd>${info.messages}</dd>
            </div>
        </dl>
        ${
            !info.cwdExists &&
            html`<div class="error-box small">
                The folder it worked in is not there anymore, so it cannot continue here.
            </div>`
        }
        ${
            info.model &&
            !info.modelHere &&
            html`<p class="muted small">It continues with Pi Pocket's usual model.</p>`
        }
        ${
            info.pocket &&
            html`<div class="pi-note">
                <span>
                    ${info.pocket.behind ? "Continued here before Pi went on in the terminal." : "Already continued here."}
                </span>
                <button class="link" onClick=${() => open(info.pocket.id)}>Open it</button>
            </div>`
        }
        ${
            info.last.length > 0 &&
            html`<div class="pi-convo" aria-label="Its last messages">
                <div class="label">Its last messages</div>
                ${info.last.map((line) =>
                    line.role === "user"
                        ? html`<div class="pi-ask"><div>${line.text}</div></div>`
                        : html`<div class="pi-reply">${line.text}</div>`,
                )}
            </div>`
        }
        <div class="pi-continue">
            <button class="button primary wide" disabled=${busy || !info.cwdExists} onClick=${go}>
                ${info.pocket ? "Continue it here again" : "Continue in Pocket"}
            </button>
            <p class="muted small">
                Pi gets the conversation as Pi left it, with Pi Pocket's instructions and tools. Nothing Pi did runs again, and the session's file stays as it is.
            </p>
        </div>
    <//>`;
}
