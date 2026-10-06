// The working folder of a new session or of this one: browse, recent folders, and a worktree of its own.
import { useEffect, useState } from "preact/hooks";
import { actions, api, attempt, closeSheet, navigate, store } from "../store.js";
import { html, Icon, Sheet, shortPath } from "../ui.js";

export function CwdSheet({ mode }) {
    const { view, server } = store.state;
    const initial =
        mode === "change" ? (view.agent?.cwd ?? server?.defaultCwd) : (server?.defaultCwd ?? "~");
    const [path, setPath] = useState(initial ?? "~");
    const [listing, setListing] = useState(null);
    const [hidden, setHidden] = useState(false);
    const [browse, setBrowse] = useState(true);
    const [worktree, setWorktree] = useState(false);
    const load = (target, showHidden = hidden) =>
        attempt(async () => {
            const result = await api(
                `fs?path=${encodeURIComponent(target)}${showHidden ? "&hidden=1" : ""}`,
            );

            setListing(result);
            setPath(result.path);
        });

    useEffect(() => {
        load(initial ?? "~");
    }, []);
    const use = (target) =>
        attempt(async () => {
            if (mode === "change") {
                await actions.configure({ cwd: target });
                closeSheet();
            } else {
                const created = await actions.createSession(target, { worktree });

                navigate(created.id);
            }
        });

    return html`<${Sheet}
        title=${mode === "change" ? "Working directory" : "New session"}
        onClose=${closeSheet}
    >
        <div class="row">
            <input
                class="mono"
                value=${path}
                onInput=${(event) => setPath(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && load(path)}
            />
            <button
                class="button"
                onClick=${() => (browse ? setBrowse(false) : (setBrowse(true), load(path)))}
            >
                ${browse ? "Hide" : "Browse"}
            </button>
        </div>
        ${
            mode === "new" &&
            html`<label class="check">
                <input type="checkbox" checked=${worktree} onChange=${(event) => setWorktree(event.currentTarget.checked)} /> In a git worktree of its own: a branch, apart from this folder
            </label>`
        }
        <button class="button primary wide" onClick=${() => use(path)}>
            Use ${shortPath(path, listing?.home ?? server?.home)}
        </button>
        ${
            browse &&
            listing &&
            html`<div class="dir-list">
                <label class="check">
                    <input
                        type="checkbox"
                        checked=${hidden}
                        onChange=${(event) => {
                            setHidden(event.currentTarget.checked);
                            load(path, event.currentTarget.checked);
                        }}
                    /> Show hidden
                </label>
                ${
                    listing.parent &&
                    html`<button class="list-item" onClick=${() => load(listing.parent)}>
                        <span class="mono">..</span>
                    </button>`
                }
                ${listing.dirs.map(
                    (dir) => html`<button class="list-item" onClick=${() => load(dir.path)}>
                        <span><${Icon} name="folder" size=${15} /> ${dir.name}</span>
                        <${Icon} name="chevron" size=${14} />
                    </button>`,
                )}
                ${listing.dirs.length === 0 && html`<div class="muted pad">No folders here.</div>`}
            </div>`
        }
        ${
            listing?.recent?.length > 0 &&
            html`<div class="group">
                <div class="group-title">Recent</div>
                ${listing.recent.map(
                    (dir) =>
                        html`<button class="list-item" onClick=${() => use(dir)}>
                            <span class="mono">${shortPath(dir, listing.home)}</span>
                        </button>`,
                )}
            </div>`
        }
    <//>`;
}
