// Every artifact in every session, one row each, with the number of its current (latest) version.
import { folderColor } from "../avatar.js";
import { useEffect, useState } from "preact/hooks";
import { api, closeSheet, navigate, notify, store } from "../store.js";
import { formatBytes, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";

/** The entries (newest first) in groups by session, in the order the sessions first appear. */
function bySession(entries) {
    const groups = new Map();

    for (const entry of entries) {
        const group = groups.get(entry.session) ?? {
            session: entry.session,
            title: entry.sessionTitle,
            entries: [],
        };

        group.entries.push(entry);
        groups.set(entry.session, group);
    }

    return [...groups.values()];
}

/** One session's artifacts, in the frame that Running now uses for a session. */
function Group({ group, open }) {
    const cwd = store.state.sessions.find((entry) => entry.id === group.session)?.cwd;
    const title = group.title || `Session ${group.session}`;

    return html`<div class="running">
        <div class="running-head">
            <span
                class="folder-mark"
                style=${`--folder:${folderColor(cwd)}`}
                aria-hidden="true"
            ></span>
            <span class="grow overview-session">${title}</span>
            <span class="muted small">${group.entries.length}</span>
        </div>
        ${group.entries.map((entry) => {
            const about = `${entry.kind ?? entry.type} · ${formatBytes(entry.size)} · ${timeAgo(entry.updatedAt)}`;

            return html`<button class="overview-row" key=${entry.id} onClick=${() => open(entry)}>
                <${Icon} name="artifact" size=${16} />
                <span class="overview-main">
                    <span class="overview-title">${entry.title}</span>
                    <span class="muted small mono">${about}</span>
                </span>
                <span
                    class="overview-version"
                    title=${`Current version: ${entry.current}, of ${entry.versions}`}
                >
                    v${entry.current}
                    ${entry.versions > 1 && html`<span class="muted"> / ${entry.versions}</span>`}
                </span>
            </button>`;
        })}
    </div>`;
}

/** All artifacts, across sessions: a tap opens the current version in its session. */
export function AllArtifactsSheet() {
    const [entries, setEntries] = useState(null);
    const [failed, setFailed] = useState(null);

    useEffect(() => {
        let open = true;

        api("artifacts").then(
            (list) => open && setEntries(list),
            (error) => {
                if (open) {
                    setFailed(error.message);
                    notify("error", error.message);
                }
            },
        );

        return () => {
            open = false;
        };
    }, []);

    const open = (entry) => {
        closeSheet();
        navigate(entry.session, {
            sheet: { type: "viewer", id: entry.id, version: entry.current },
        });
    };

    return html`<${Sheet} title="All artifacts" onClose=${closeSheet} wide=${true}>
        ${entries === null && failed === null && html`<${Loader} label="Looking" />`}
        ${failed !== null && html`<p class="warn">${failed}</p>`}
        ${
            entries?.length === 0 &&
            html`<p class="muted">
                No artifacts yet. Ask Pi to build something you can look at: a chart, a demo, a game.
            </p>`
        }
        ${bySession(entries ?? []).map(
            (group) => html`<${Group} key=${group.session} group=${group} open=${open} />`,
        )}
    <//>`;
}
