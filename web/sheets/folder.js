// The working folder of a new session or of this one: browse, make a new folder, recent folders, and a worktree of its
// own.
import { useEffect, useRef, useState } from "preact/hooks";
import { actions, api, attempt, closeSheet, navigate, notify, store } from "../store.js";
import { html, Icon, Sheet, shortPath } from "../ui.js";

/** A folder's path with a name added: `/a` and `b` make `/a/b`, `/` and `b` make `/b`. */
const joined = (folder, name) => `${folder.replace(/\/+$/, "")}/${name.replace(/^\/+/, "")}`;

/** Whether a failure says a folder is not there yet, and so could be made: only a whole path, as the server makes no other. */
const notThere = (error, target) =>
    error.status === 404 && /isn't there/.test(error.message) && /^\s*[~/]/.test(target);

/** The name of a new folder in `folder`: Enter or Create makes it, Esc or × lets it go. */
function NewFolder({ folder, onMake, onCancel }) {
    const [name, setName] = useState("");
    const input = useRef(null);

    useEffect(() => input.current?.focus(), []);

    return html`<form
        class="new-folder"
        onSubmit=${(event) => {
            event.preventDefault();

            if (name.trim() !== "") {
                onMake(name.trim());
            }
        }}
    >
        <${Icon} name="folder" size=${15} />
        <input
            class="mono"
            ref=${input}
            value=${name}
            placeholder=${`New folder in ${folder}`}
            aria-label="The new folder's name"
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
            enterkeyhint="done"
            onInput=${(event) => setName(event.currentTarget.value)}
            onKeyDown=${(event) => {
                // Esc lets go of the name, not the whole sheet.
                if (event.key === "Escape") {
                    event.stopPropagation();
                    onCancel();
                }
            }}
        />
        <button class="button small primary" type="submit" disabled=${name.trim() === ""}>
            Create
        </button>
        <button class="icon-button" type="button" aria-label="Cancel" onClick=${onCancel}>
            <${Icon} name="close" size=${16} />
        </button>
    </form>`;
}

export function CwdSheet({ mode }) {
    const { view, server } = store.state;
    const initial =
        mode === "change" ? (view.agent?.cwd ?? server?.defaultCwd) : (server?.defaultCwd ?? "~");
    const [path, setPath] = useState(initial ?? "~");
    const [listing, setListing] = useState(null);
    const [hidden, setHidden] = useState(false);
    const [browse, setBrowse] = useState(true);
    const [worktree, setWorktree] = useState(false);
    // Whether a folder is being named, to make in the one shown; and a path typed that is not there yet.
    const [naming, setNaming] = useState(false);
    const [missing, setMissing] = useState(null);
    const useButton = useRef(null);
    const home = listing?.home ?? server?.home;

    const load = (target, showHidden = hidden) =>
        api(`fs?path=${encodeURIComponent(target)}${showHidden ? "&hidden=1" : ""}`).then(
            (result) => {
                setListing(result);
                setPath(result.path);
                setMissing(null);
            },
            (error) => {
                // A path that is not there yet can be made from here; any other trouble is a notice.
                if (notThere(error, target)) {
                    setMissing(target);
                } else {
                    notify("error", error.message);
                }
            },
        );

    useEffect(() => {
        load(initial ?? "~");
    }, []);

    /** Start the session in a folder (or move this one there), making the folder first when it is not there yet. */
    const use = async (target) => {
        try {
            if (missing === target) {
                await api("fs", { path: target });
            }

            if (mode === "change") {
                await actions.configure({ cwd: target });
                closeSheet();
            } else {
                const created = await actions.createSession(target, { worktree });

                navigate(created.id);
            }
        } catch (error) {
            // Typed but not there: offer to make it, rather than only saying so.
            if (notThere(error, target)) {
                setMissing(target);
            } else {
                notify("error", error.message);
            }
        }
    };

    /** Make a folder, then show it, chosen: Use is the next tap. */
    const make = (target) =>
        attempt(async () => {
            const made = await api("fs", { path: target });

            setNaming(false);
            setBrowse(true);
            await load(made.path);
            useButton.current?.focus({ preventScroll: true });
        });

    return html`<${Sheet}
        title=${mode === "change" ? "Working directory" : "New session"}
        onClose=${closeSheet}
    >
        <div class="row">
            <input
                class="mono"
                value=${path}
                onInput=${(event) => {
                    setPath(event.currentTarget.value);
                    setMissing(null);
                }}
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
            missing !== null &&
            html`<div class="folder-missing">
                <span><span class="mono">${shortPath(missing, home)}</span> isn't there yet.</span>
                <button class="button small" onClick=${() => make(missing)}>
                    <${Icon} name="plus" size=${14} /> Create it
                </button>
            </div>`
        }
        ${
            mode === "new" &&
            html`<label class="check">
                <input type="checkbox" checked=${worktree} onChange=${(event) => setWorktree(event.currentTarget.checked)} /> In a git worktree of its own: a branch, apart from this folder
            </label>`
        }
        <button class="button primary wide" ref=${useButton} onClick=${() => use(path)}>
            ${missing === path ? "Create and use" : "Use"} ${shortPath(path, home)}
        </button>
        ${
            browse &&
            listing &&
            html`<div class="dir-list">
                <div class="dir-tools">
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
                        !naming &&
                        html`<button class="button small" onClick=${() => setNaming(true)}>
                            <${Icon} name="plus" size=${14} /> New folder
                        </button>`
                    }
                </div>
                ${
                    naming &&
                    html`<${NewFolder}
                        folder=${shortPath(listing.path, home)}
                        onMake=${(name) => make(joined(listing.path, name))}
                        onCancel=${() => setNaming(false)}
                    />`
                }
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
