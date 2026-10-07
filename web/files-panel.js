// The Files tile: the session's folder as a tree beside a file viewer, and Changes, a review of its uncommitted
// changes. It docks beside the conversation where the Browser and People panels do (one of them at a time), and
// covers the screen on phones. Alt+E, the top bar's folder button, the launcher, or /files show and hide it.

import { useEffect, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { DiffReview, KIND_LETTERS, reloadChanges, useChanges, useWidth } from "./diff.js";
import { loadFiles, suggestFiles } from "./files.js";
import { FileView } from "./sheets/file.js";
import { actions, canSteer, closePeople, panelsBeside, store } from "./store.js";
import { html, Icon, Loader, Marked, shortPath, usePresence } from "./ui.js";

const OPEN_KEY = "pocket.files";
const TAB_KEY = "pocket.filesTab";
const WIDTH_KEY = "pocket.filesWidth";
/** Tree and viewer side by side from this width of the tile; one at a time below it. */
const SIDE_BY_SIDE = 640;

/** The tile is for people who can steer: the viewer reads files as Pi would. */
export const filesAvailable = () => canSteer() && store.state.conversationId !== null;

/** Show or hide the tile. It takes the Browser and People panels' place. */
export function setFilesOpen(open, tab) {
    if (open) {
        sessionStorage.setItem(OPEN_KEY, "1");
        sessionStorage.removeItem("pocket.browser");
        closePeople();
    } else {
        sessionStorage.removeItem(OPEN_KEY);

        if (document.documentElement.dataset.focus === "files-tile") {
            document.documentElement.dataset.focus = "pane";
        }
    }

    if (tab) {
        sessionStorage.setItem(TAB_KEY, tab);
    }

    store.set({
        filesOpen: open,
        drawer: false,
        // Someone asked for the tile just now: Changes takes the keys (`DiffReview`).
        ...(open
            ? {
                  browserOpen: false,
                  sheet: null,
                  filesAsk: { tab: tab ?? store.state.filesTab, at: Date.now() },
              }
            : {}),
        ...(tab ? { filesTab: tab } : {}),
    });
}

/** Show or hide the tile; with `tab`, show that tab, or hide the tile if it already shows it. */
export function toggleFiles(tab) {
    const { filesOpen, filesTab } = store.state;

    if (filesOpen && (tab === undefined || tab === filesTab)) {
        setFilesOpen(false);
    } else {
        setFilesOpen(true, tab);
    }
}

function setTab(tab) {
    sessionStorage.setItem(TAB_KEY, tab);
    store.set({ filesTab: tab });
}

// ─── The tree ──────────────────────────────────────────────────────────────────────

/** Folders' entries, per conversation and folder, kept while the tile is open again and again. */
const folders = new Map();
/** How many folders are kept: the oldest go first. */
const FOLDERS_KEPT = 300;
/** Folders the tree shows open, per conversation: kept for the tab, so a reload keeps the tree as it was. */
const expandedKey = (id) => `pocket.filesTree.${id}`;

/** The file open in the tile, per conversation: kept for the tab too, so a reload after a live edit shows it again. */
const openKey = (id) => `pocket.filesOpenFile.${id}`;

function readOpen(id) {
    try {
        return JSON.parse(sessionStorage.getItem(openKey(id)));
    } catch {
        return null;
    }
}

function readExpanded(id) {
    try {
        return new Set(JSON.parse(sessionStorage.getItem(expandedKey(id))) ?? []);
    } catch {
        return new Set();
    }
}

/** Folders the tree never shows: git's own. */
const HIDDEN = new Set([".git"]);

/** A folder's entries, `{ entries, truncated }` or `{ entries, error }`: the kept ones at once, then read again. */
function useFolder(id, path, version) {
    const key = `${id}\u0000${path}`;
    const [state, setState] = useState(() => folders.get(key) ?? null);

    useEffect(() => {
        let live = true;

        if (folders.has(key)) {
            setState(folders.get(key));
        }

        actions.view(path).then(
            (folder) => {
                const entries =
                    folder.kind === "folder"
                        ? folder.entries.filter((entry) => !HIDDEN.has(entry.name))
                        : [];
                const next = { entries, truncated: folder.truncated === true };

                // A later read may have answered first: only the latest is kept.
                if (live) {
                    folders.delete(key);

                    if (folders.size >= FOLDERS_KEPT) {
                        folders.delete(folders.keys().next().value);
                    }

                    folders.set(key, next);
                    setState(next);
                }
            },
            (failure) => live && setState({ entries: [], error: failure.message }),
        );

        return () => {
            live = false;
        };
    }, [key, version]);

    return state;
}

/** One folder's entries in the tree, and the open folders under it. */
function TreeFolder({ path, depth, ctx }) {
    const folder = useFolder(ctx.id, path, ctx.version);

    if (folder === null) {
        return html`<div class="ft-row muted" style=${`--depth:${depth}`}>…</div>`;
    }

    if (folder.error) {
        return html`<div class="ft-row muted small" style=${`--depth:${depth}`}>${folder.error}</div>`;
    }

    return html`${folder.entries.map((entry) => {
        const full = `${path}/${entry.name}`;
        const open = entry.dir && ctx.expanded.has(full);
        const change = ctx.changed.get(full);
        const inside = entry.dir && ctx.changedDirs.has(full);

        return html`<div key=${entry.name} role="none">
            <button
                type="button"
                role="treeitem"
                aria-expanded=${entry.dir ? (open ? "true" : "false") : undefined}
                class=${`ft-row ${entry.dir ? "dir" : "file"} ${ctx.selected === full ? "on" : ""} ${entry.name.startsWith(".") ? "dot" : ""} ${change ? `changed ${change}` : ""}`}
                style=${`--depth:${depth}`}
                data-path=${full}
                title=${entry.name}
                onClick=${() => (entry.dir ? ctx.toggle(full) : ctx.pick(full))}
            >
                ${
                    entry.dir
                        ? html`<${Icon} name="chevron" size=${12} class=${`chev ${open ? "open" : ""}`} />`
                        : html`<span class="ft-spacer"></span>`
                }
                <${Icon} name=${entry.dir ? "folder" : "file"} size=${14} />
                <span class="ft-name">${entry.name}</span>
                ${inside && html`<span class="ft-dot" title="Has changes"></span>`}
                ${change && html`<span class=${`ft-kind ${change}`}>${KIND_LETTERS[change]}</span>`}
            </button>
            ${open && html`<${TreeFolder} path=${full} depth=${depth + 1} ctx=${ctx} />`}
        </div>`;
    })}
    ${
        folder.truncated &&
        html`<div class="ft-row muted small" style=${`--depth:${depth}`}>
            Only the first ${folder.entries.length} are listed.
        </div>`
    }`;
}

/** Files across the whole folder that match what was typed, as the @ menu matches them. */
function Matches({ query, root, onPick }) {
    const found = suggestFiles(query);

    if (found.loading && found.items.length === 0) {
        return html`<p class="muted small ft-note">Listing the folder…</p>`;
    }

    if (found.items.length === 0) {
        return html`<p class="muted small ft-note">No file matches “${query}”.</p>`;
    }

    return html`<div class="ft-matches" role="listbox">
        ${found.items.map(
            (entry) => html`<button
                type="button"
                class="ft-row match"
                role="option"
                data-path=${`${root}/${entry.path.replace(/\/$/, "")}`}
                onClick=${(event) => onPick(event.currentTarget.dataset.path, entry.dir)}
            >
                <${Icon} name=${entry.dir ? "folder" : "file"} size=${14} />
                <span class="ft-name"><${Marked} text=${entry.name} hits=${entry.nameHits} /></span>
                <span class="ft-parent"><${Marked} text=${entry.parent} hits=${entry.parentHits} /></span>
            </button>`,
        )}
    </div>`;
}

// ─── The tile ──────────────────────────────────────────────────────────────────────

/** Drag the tile's left edge to resize it on wide screens; double-click goes back to the usual width. */
function ResizeEdge() {
    const start = (event) => {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        const root = document.documentElement;
        const right = event.currentTarget.parentElement.getBoundingClientRect().right;
        let width = 0;

        root.classList.add("resizing");

        const move = (each) => {
            width = Math.round(Math.min(innerWidth - 420, Math.max(320, right - each.clientX)));
            root.style.setProperty("--files-w", `${width}px`);
        };

        const stop = () => {
            root.classList.remove("resizing");
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", stop);
            removeEventListener("pointercancel", stop);

            if (width > 0) {
                localStorage.setItem(WIDTH_KEY, String(width));
            }
        };

        addEventListener("pointermove", move);
        addEventListener("pointerup", stop);
        addEventListener("pointercancel", stop);
    };

    const reset = () => {
        localStorage.removeItem(WIDTH_KEY);
        document.documentElement.style.removeProperty("--files-w");
    };

    return html`<div
        class="resize-handle files-resize"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        onPointerDown=${start}
        onDblClick=${reset}
    ></div>`;
}

const savedWidth = Number(localStorage.getItem(WIDTH_KEY));

if (savedWidth > 0) {
    document.documentElement.style.setProperty("--files-w", `${savedWidth}px`);
}

/**
 * The Files tab: the tree, a filter over every file in the folder, and the open file. `covering`: the tile covers the
 * screen and is not on its way out, so back closes a file that hides the tree.
 */
function FilesTab({ changes, covering }) {
    const { conversationId: id, view, server, filesTarget } = store.state;
    const root = view.agent?.cwd ?? view.conversation?.cwd ?? "";
    const [expanded, setExpanded] = useState(() => readExpanded(id));
    const [selected, setSelectedState] = useState(() => readOpen(id));
    const [query, setQuery] = useState("");
    const [version, setVersion] = useState(0);
    // Another branch has other files: the tree and the open file are read again when it changes.
    const head = JSON.stringify(view.branch);
    const ref = useRef(null);
    const width = useWidth(ref);
    const side = width >= SIDE_BY_SIDE;
    const handled = useRef(filesTarget?.n ?? 0);

    const setSelected = (next) => {
        if (next) {
            sessionStorage.setItem(openKey(id), JSON.stringify({ path: next.path }));
        } else {
            sessionStorage.removeItem(openKey(id));
        }

        setSelectedState(next);
    };

    /** Change which folders are open, and keep that for the tab. */
    const update = (change) =>
        setExpanded((before) => {
            const next = change(before);

            sessionStorage.setItem(expandedKey(id), JSON.stringify([...next]));

            return next;
        });

    /** Scroll the tree to a path's row, once its folder has loaded, while the tile is open. */
    const scrollToRow = (path, tries = 12) => {
        if (!ref.current) {
            return;
        }

        const row = ref.current.querySelector(`.ft-row[data-path="${CSS.escape(path)}"]`);

        if (row) {
            row.scrollIntoView({ block: "nearest" });
        } else if (tries > 0) {
            setTimeout(() => scrollToRow(path, tries - 1), 100);
        }
    };

    /** Open the folders down to a path, and with `self` the path itself, so the tree shows it. */
    const reveal = (path, self = false) => {
        if (!path.startsWith(`${root}/`)) {
            return;
        }

        const parts = path
            .slice(root.length + 1)
            .split("/")
            .filter(Boolean);

        update((before) => {
            const next = new Set(before);

            for (let index = 1; index <= parts.length - (self ? 0 : 1); index++) {
                next.add(`${root}/${parts.slice(0, index).join("/")}`);
            }

            return next;
        });
        scrollToRow(path);
    };

    /** Open a file; `from`, the tab it was asked for from, for back to go back to. */
    const pick = (path, line, from) => {
        setSelected({ path, line, from });
        reveal(path);
    };

    /** Close the file, as back does: where it covers the tree, back to the tab it came from. */
    const closeFile = () => {
        const from = selected?.from;

        setSelected(null);

        // After the rest of this back: when it closes the tile too (back to the list), the tile's tab stays as it is.
        if (!side && from && from !== "files") {
            queueMicrotask(() => store.state.filesOpen && setTab(from));
        }
    };

    // A path tapped in the conversation while the tile is open, once the folder it may be relative to is known.
    useEffect(() => {
        if (filesTarget && filesTarget.n !== handled.current && root !== "") {
            handled.current = filesTarget.n;
            const absolute = filesTarget.path.startsWith("/")
                ? filesTarget.path
                : filesTarget.path.startsWith("~/") && server?.home
                  ? `${server.home}${filesTarget.path.slice(1)}`
                  : `${root}/${filesTarget.path.replace(/^\.\//, "")}`;

            pick(absolute, filesTarget.line, filesTarget.from);
        }
    }, [filesTarget?.n, root]);

    useEffect(() => {
        if (query !== "") {
            loadFiles();
        }
    }, [query === ""]);

    const toggle = (path) =>
        update((before) => {
            const next = new Set(before);

            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }

            return next;
        });

    /** Arrows move through the tree as in an editor's: up and down, right opens a folder, left closes it or goes up. */
    const onTreeKey = (event) => {
        const rows = [...event.currentTarget.querySelectorAll(".ft-row[data-path]")];
        const at = rows.indexOf(document.activeElement);
        const row = rows[at];

        if (
            !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
        ) {
            return;
        }

        event.preventDefault();

        if (event.key === "Home" || event.key === "End" || at < 0) {
            rows[event.key === "End" ? rows.length - 1 : 0]?.focus();

            return;
        }

        const path = row.dataset.path;
        const dir = row.classList.contains("dir");
        const open = expanded.has(path);

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            rows[
                Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))
            ]?.focus();
        } else if (event.key === "ArrowRight") {
            if (dir && !open) {
                toggle(path);
            } else if (dir) {
                rows[at + 1]?.focus();
            }
        } else if (dir && open) {
            toggle(path);
        } else {
            const parent = path.slice(0, path.lastIndexOf("/"));

            rows.find((each) => each.dataset.path === parent)?.focus();
        }
    };

    const changed = new Map();
    const changedDirs = new Set();

    if (changes?.repo) {
        for (const file of changes.files) {
            const full = `${changes.repo.root}/${file.path}`;

            changed.set(full, file.kind);

            for (let at = full.lastIndexOf("/"); at > 0; at = full.lastIndexOf("/", at - 1)) {
                changedDirs.add(full.slice(0, at));
            }
        }
    }

    const ctx = {
        id,
        expanded,
        selected: selected?.path,
        changed,
        changedDirs,
        version: `${version}:${head}`,
        toggle,
        pick,
    };

    // Where the file covers the tree, back goes back to the tree; the file slides away over it (kept a moment after).
    useBack(covering && Boolean(selected) && width > 0 && !side, closeFile);
    const [kept] = usePresence(selected, 240);
    const shown = selected ?? (side ? null : kept);
    const covered = !side && Boolean(selected);
    const name = shown?.path.split("/").pop();
    const coveredNow = useRef(covered);

    coveredNow.current = covered;
    // Focus follows the file: into its header when it covers the tree (whose row it was on goes inert), and back to
    // its row when it goes, unless something else took focus meanwhile.
    useEffect(() => {
        if (!covered) {
            return undefined;
        }

        const box = ref.current;
        const path = selected.path;

        if (document.activeElement === document.body || box?.contains(document.activeElement)) {
            box?.querySelector(".ft-view:not(.leaving) .ft-view-head button")?.focus({
                preventScroll: true,
            });
        }

        return () => {
            const left = document.activeElement;

            if (
                !coveredNow.current &&
                box?.isConnected &&
                (left === document.body || box.querySelector(".ft-view")?.contains(left))
            ) {
                box.querySelector(`.ft-row[data-path="${CSS.escape(path)}"]`)?.focus({
                    preventScroll: true,
                });
            }
        };
    }, [covered, selected?.path]);

    // The folder is known once the conversation's view arrives.
    if (root === "") {
        return html`<div class="ft" ref=${ref}><${Loader} label="Opening the folder" /></div>`;
    }

    return html`<div class=${`ft ${side ? "side" : ""}`} ref=${ref}>
        <div
            class="ft-pane"
            inert=${covered}
            aria-hidden=${covered ? "true" : undefined}
        >
            <div class="ft-tools">
                <input
                    type="search"
                    class="ft-filter"
                    placeholder="Go to file"
                    value=${query}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                    onKeyDown=${(event) => {
                        if (event.key === "Escape" && query !== "") {
                            event.stopPropagation();
                            setQuery("");
                        } else if (event.key === "ArrowDown") {
                            event.preventDefault();
                            ref.current?.querySelector(".ft-tree .ft-row[data-path]")?.focus();
                        }
                    }}
                    autocapitalize="off"
                    autocomplete="off"
                    spellcheck="false"
                />
                <button
                    class="icon-button"
                    type="button"
                    title="Fold every folder"
                    aria-label="Fold every folder"
                    onClick=${() => update(() => new Set())}
                >
                    <${Icon} name="down" size=${16} class="ft-fold-all" />
                </button>
                <button
                    class="icon-button"
                    type="button"
                    title="Look again"
                    aria-label="Refresh"
                    onClick=${() => {
                        folders.clear();
                        setVersion(version + 1);
                        reloadChanges(id);
                    }}
                >
                    <${Icon} name="reload" size=${16} />
                </button>
            </div>
            <div class="ft-root mono" title=${root}>${shortPath(root, server?.home)}</div>
            <div class="ft-tree" role="tree" aria-label="Files" onKeyDown=${onTreeKey}>
                ${
                    query === ""
                        ? html`<${TreeFolder} path=${root} depth=${0} ctx=${ctx} />`
                        : html`<${Matches}
                              query=${query}
                              root=${root}
                              onPick=${(path, dir) => {
                                  setQuery("");

                                  if (dir) {
                                      reveal(path, true);
                                  } else {
                                      pick(path);
                                  }
                              }}
                          />`
                }
            </div>
        </div>
        ${
            shown
                ? html`<div class=${`ft-view ${selected ? "" : "leaving"}`} inert=${!selected}>
                      <div class="ft-view-head">
                          ${
                              !side &&
                              html`<button
                                  class="icon-button"
                                  type="button"
                                  aria-label=${shown.from === "changes" ? "Back to Changes" : "Back to the files"}
                                  onClick=${closeFile}
                              >
                                  <${Icon} name="back" size=${22} />
                              </button>`
                          }
                          <strong class="ft-view-name" title=${shown.path}>${name}</strong>
                          ${
                              side &&
                              html`<button
                                  class="icon-button"
                                  type="button"
                                  aria-label="Close the file"
                                  title="Close the file"
                                  onClick=${() => setSelected(null)}
                              >
                                  <${Icon} name="close" size=${16} />
                              </button>`
                          }
                      </div>
                      <${FileView}
                          key=${`${shown.path}:${shown.line ?? ""}:${head}`}
                          path=${shown.path}
                          line=${shown.line}
                          onOpen=${(path) => pick(path)}
                      />
                  </div>`
                : side &&
                  html`<div class="ft-view ft-empty">
                      <${Icon} name="file" size=${26} />
                      <p class="muted small">Pick a file to read it here.</p>
                  </div>`
        }
    </div>`;
}

export function FilesPanel({ leaving = false }) {
    const { filesTab } = store.state;
    const { changes } = useChanges(true);
    // Pi's edits git does not list count too: outside a repository, they are all there is.
    const count = changes ? changes.files.length + changes.piOnly.length : 0;

    const beside = panelsBeside();

    // Over the conversation, back closes the tile.
    useBack(!beside && !leaving, () => setFilesOpen(false));

    return html`<section
        class=${`files-tile window ${leaving ? "leaving" : ""}`}
        aria-label="Files"
        inert=${leaving}
    >
        <${ResizeEdge} />
        <header class="files-bar">
            ${
                !beside &&
                html`<button
                    class="icon-button files-back"
                    type="button"
                    aria-label="Back to the conversation"
                    title="Back (Alt+E)"
                    onClick=${() => setFilesOpen(false)}
                >
                    <${Icon} name="back" size=${22} />
                </button>`
            }
            <div class="files-tabs" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected=${filesTab === "files" ? "true" : "false"}
                    class=${filesTab === "files" ? "on" : ""}
                    onClick=${() => setTab("files")}
                >
                    <${Icon} name="folder" size=${15} /> Files
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected=${filesTab === "changes" ? "true" : "false"}
                    class=${filesTab === "changes" ? "on" : ""}
                    onClick=${() => setTab("changes")}
                >
                    <${Icon} name="diff" size=${15} /> Changes
                    ${count > 0 && html`<span class="files-count">${count}</span>`}
                </button>
            </div>
            <span class="grow"></span>
            ${
                beside &&
                html`<button
                    class="icon-button"
                    type="button"
                    aria-label="Close the files"
                    title="Close (Alt+E)"
                    onClick=${() => setFilesOpen(false)}
                >
                    <${Icon} name="close" size=${18} />
                </button>`
            }
        </header>
        <div class="files-body" role="tabpanel" aria-label="Files" hidden=${filesTab !== "files"}>
            <${FilesTab} changes=${changes} covering=${!beside && !leaving} />
        </div>
        <div
            class="files-body"
            role="tabpanel"
            aria-label="Changes"
            hidden=${filesTab !== "changes"}
        >
            <${DiffReview} active=${filesTab === "changes"} covering=${!beside && !leaving} />
        </div>
    </section>`;
}

/** The top bar's button: shows and hides the tile, with a count of changed files. */
export function FilesButton() {
    const { filesOpen } = store.state;

    if (!filesAvailable()) {
        return null;
    }

    return html`<button
        class=${`icon-button ${filesOpen ? "on" : ""}`}
        aria-label="Files"
        title="Files and changes (Alt+E)"
        onClick=${() => toggleFiles()}
    >
        <${Icon} name="folder" />
    </button>`;
}
