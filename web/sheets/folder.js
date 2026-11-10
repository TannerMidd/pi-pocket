// The folder picker, as a desktop's file dialog: places on the left (home, the computer, recent folders), the folders
// where you are on the right, and Cancel and Open at the bottom. With a mouse, a click selects a folder and a double
// click goes into it; on a touch screen, a tap goes into it. Open takes the selected folder, or the one you are in.
// It opens in the folder of the session you are in, so New session here is a tap away without walking the tree;
// favorites, each person's own and on all their devices, sit first among the places; Ctrl/⌘+1…9 starts in one.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
    actions,
    api,
    attempt,
    canSteer,
    closeSheet,
    navigate,
    notify,
    openSheet,
    scoped,
    store,
} from "../store.js";
import { sessionStarted } from "../extension-ui.js";
import { chooseFolder } from "../copy-draft.js";
import { goBack } from "../back.js";
import { waitOnComputer } from "../runner-wait.js";
import {
    crumbsOf,
    isWholePath,
    joined,
    recentLabels,
    rootName,
    separatorOf,
} from "../folder-paths.js";
import { APPLE, html, Icon, Sheet, shortPath } from "../ui.js";
import { piSessionsAvailable } from "./pi-sessions.js";

/** Whether hidden folders show: kept for the next time the picker opens. */
const HIDDEN_KEY = "pocket.folderHidden";
/** Whether new sessions always open in the server's default workspace: kept per browser. */
const ALWAYS_DEFAULT_KEY = "pocket.folderAlwaysDefault";
/** Touch screens go into a folder on a tap; a mouse selects on a click and goes in on a double click. */
const touch = matchMedia("(pointer: coarse)").matches;

/** Whether a failure says a folder is not there yet, and so could be made: only a whole path, as the server makes no other. */
const notThere = (error, target) =>
    error.status === 404 && /isn't there/.test(error.message) && isWholePath(target);

// The launcher names favorites as this picker does.
export { recentLabels };

/** Marks the path's field when its start is scrolled out of sight, so it fades there. */
const markCut = (crumbs) => crumbs.classList.toggle("cut", crumbs.scrollLeft > 0);

/** A line to type a name or a path into: Enter takes it, Esc lets it go. */
function LineInput({ value, placeholder, label, onSubmit, onCancel, class: className = "" }) {
    const [text, setText] = useState(value ?? "");
    const input = useRef(null);

    useEffect(() => {
        input.current?.focus();
        input.current?.setSelectionRange(text.length, text.length);
    }, []);

    return html`<form
        class=${`fp-line ${className}`}
        onSubmit=${(event) => {
            event.preventDefault();

            if (text.trim() !== "") {
                onSubmit(text.trim());
            }
        }}
    >
        <input
            ref=${input}
            class="mono"
            value=${text}
            placeholder=${placeholder}
            aria-label=${label}
            autocapitalize="off"
            autocomplete="off"
            spellcheck="false"
            enterkeyhint="go"
            onInput=${(event) => setText(event.currentTarget.value)}
            onKeyDown=${(event) => {
                // Esc lets go of the line, not the whole picker.
                if (event.key === "Escape") {
                    event.stopPropagation();
                    onCancel();
                }
            }}
        />
        <button class="button small primary" type="submit" disabled=${text.trim() === ""}>
            OK
        </button>
        <button class="icon-button" type="button" aria-label="Cancel" onClick=${onCancel}>
            <${Icon} name="close" size=${16} />
        </button>
    </form>`;
}

/**
 * Where a new session runs, among the places: this server, or a linked computer (`computers.js`), and a way to
 * Runners to link one (owners only). Each person sees the computers they may use.
 */
function RunsOn({ runner, runners, onPick }) {
    const choices = [{ id: null, name: "This server", online: true }, ...runners];

    return html`<div class="fp-places-title">Runs on</div>
        ${choices.map(
            (each) => html`<button
                key=${each.id ?? "server"}
                type="button"
                class=${`fp-place ${each.id === runner ? "on" : ""}`}
                aria-pressed=${each.id === runner}
                disabled=${!each.online && each.id !== runner}
                title=${each.online ? `Start the session on ${each.name}` : `${each.name} is offline`}
                onClick=${() => onPick(each.id)}
            >
                <${Icon} name=${each.id === null ? "home" : "monitor"} size=${15} />
                <span>${each.name}</span>
                ${each.id !== null && html`<span class=${`runner-dot ${each.online ? "on" : ""}`}></span>`}
            </button>`,
        )}
        ${
            store.state.me?.role === "owner" &&
            html`<button
                type="button"
                class="link small fp-pi"
                onClick=${() => openSheet({ type: "computers" })}
            >
                ${runners.length === 0 ? "Link a computer…" : "Manage runners…"}
            </button>`
        }`;
}

/**
 * The folder picker. `mode`: "new" starts a session in the folder; "change" moves this session there; "pick" returns
 * the folder to the copy sheet under it (`copy.js`) and goes back to it, changing no session, with `start` the folder
 * it opens in and `title` its caller's title.
 */
export function CwdSheet({
    mode,
    fromList = false,
    runner: given = null,
    start = null,
    title = null,
}) {
    const { view, server, runners } = store.state;
    const changing = mode === "change";
    const picking = mode === "pick";
    // The computer whose folders these are (`runners.ts`): the one asked for, or the session's when moving it. Its
    // folders are not this server's: no default workspace; its favorites and recent folders are its own.
    // A new session can switch computer in the places list (Runs on); moving one keeps its computer, and so does a
    // pick, whose computer the copy sheet chose.
    const [picked, setPicked] = useState(given);
    const runner = changing ? (view.conversation?.runner ?? null) : picked;
    const owner = store.state.me?.role === "owner";
    const favorites = runner
        ? (store.state.runnerFavorites[runner] ?? [])
        : store.state.folderFavorites;
    const computer = runner
        ? (runners.find((each) => each.id === runner)?.name ??
          view.conversation?.runnerName ??
          "another computer")
        : null;
    const [alwaysDefault, setAlwaysDefault] = useState(
        () => localStorage.getItem(ALWAYS_DEFAULT_KEY) === "1",
    );
    // Where it opens: default workspace if pinned, else the folder of the session you are in (Issue #96).
    const initial = picking
        ? (start ?? "~")
        : runner
          ? changing
              ? (view.agent?.cwd ?? "~")
              : "~"
          : !changing && alwaysDefault && server?.defaultCwd
            ? server.defaultCwd
            : (view.agent?.cwd ?? server?.defaultCwd ?? "~");
    const [listing, setListing] = useState(null);
    const [failed, setFailed] = useState(null);
    // The folder a click selected (mouse only): Open takes it over the one you are in.
    const [selected, setSelected] = useState(null);
    const [hidden, setHidden] = useState(() => localStorage.getItem(HIDDEN_KEY) === "1");
    const [worktree, setWorktree] = useState(false);
    // Typing a new folder's name, or a path to go to; and a path typed that is not there yet.
    const [naming, setNaming] = useState(false);
    const [editing, setEditing] = useState(null);
    const [missing, setMissing] = useState(null);
    // Why a favorite in `missing` does not open, when it is there but is no folder to open (a link to nothing, a file).
    const [missingWhy, setMissingWhy] = useState(null);
    const [busy, setBusy] = useState(false);
    // Set at once, unlike busy: a second shortcut in the same moment does not start a second session.
    const starting = useRef(false);
    const [saving, setSaving] = useState(false);
    const list = useRef(null);
    const crumbsBox = useRef(null);
    // Only the latest read shows: a slow one answering after a later click is dropped.
    const asked = useRef(0);
    // Letters typed in the list jump to the folder they start; they add up for a moment.
    const typed = useRef({ text: "", at: 0 });
    const home = listing?.home ?? server?.home;
    const folder = listing?.path ?? null;
    const dirs = listing?.dirs ?? [];
    const target = selected ?? folder;
    const here = changing && target !== null && target === view.agent?.cwd;

    /** Show a folder; `select`, a folder in it to select (the one stepped up from, with a mouse). */
    const load = (path, { showHidden = hidden, select = null } = {}) => {
        const ask = ++asked.current;

        const where = runner ? `runners/${encodeURIComponent(runner)}/fs` : "fs";

        return api(
            `${where}?path=${encodeURIComponent(path)}${showHidden ? "&hidden=1" : ""}`,
        ).then(
            (result) => {
                if (ask !== asked.current) {
                    return;
                }

                setListing(result);
                setFailed(null);
                setSelected(touch ? null : select);
                setMissing(null);
                setEditing(null);
                setNaming(false);
            },
            (error) => {
                if (ask !== asked.current) {
                    return;
                }

                // A favorite that does not open, however, gets the banner, which can remove it.
                if (notThere(error, path) || favorites.includes(path)) {
                    setMissing(path);
                    setMissingWhy(notThere(error, path) ? null : error.message);
                    setEditing(null);
                } else if (listing) {
                    notify("error", error.message);
                } else {
                    setFailed(error.message);
                }
            },
        );
    };

    useEffect(() => {
        load(initial);
    }, [runner]);

    useEffect(() => {
        // The linked computers, for their names and the Runs on places, when this tab has not got the list yet.
        if (owner && runners.length === 0) {
            api("runners").then(
                (list) => store.set({ runners: list }),
                () => {},
            );
        }
    }, []);

    // A new folder shows from its top, or with the selected one in view; its path shows to its end. Keys go to the
    // list, with a mouse and keyboard.
    useLayoutEffect(() => {
        if (crumbsBox.current) {
            crumbsBox.current.scrollLeft = crumbsBox.current.scrollWidth;
            markCut(crumbsBox.current);
        }

        const row =
            selected && list.current?.querySelector(`.fp-row[data-path="${CSS.escape(selected)}"]`);

        if (row) {
            row.scrollIntoView({ block: "nearest" });
        } else if (list.current) {
            list.current.scrollTop = 0;
        }

        if (!touch && !naming && editing === null) {
            list.current?.focus({ preventScroll: true });
        }
    }, [folder]);

    useEffect(() => {
        if (selected) {
            list.current
                ?.querySelector(`.fp-row[data-path="${CSS.escape(selected)}"]`)
                ?.scrollIntoView({ block: "nearest" });
        }
    }, [selected]);

    const up = () => listing?.parent && load(listing.parent, { select: listing.path });

    /** Make a folder and go into it: Open starts there. */
    const make = async (path) => {
        try {
            const made = await api("fs", { path });

            await load(made.path);
        } catch (error) {
            notify("error", error.message);
        }
    };

    /** Start the session in the folder Open names (or a favorite's), or move this one there. */
    const use = async (path = target) => {
        if (path === null || starting.current || (changing && path === view.agent?.cwd)) {
            return;
        }

        // Back to the copy sheet with the folder: no session starts or moves.
        if (picking) {
            chooseFolder(path);
            goBack();

            return;
        }

        starting.current = true;
        setBusy(true);

        try {
            if (changing) {
                await actions.configure({ cwd: path });
                closeSheet();
            } else {
                const created = await (runner
                    ? waitOnComputer(runner, path, "new", (signal) =>
                          actions.createSession(path, { runner, worktree }, signal),
                      )
                    : actions.createSession(path, { worktree }));

                if (!created) {
                    return;
                }

                navigate(created.id);

                // New in the session list: extensions' filters that are on can make it meet them.
                if (fromList) {
                    sessionStarted(created.id);
                }
            }
        } catch (error) {
            notify("error", error.message);
        } finally {
            starting.current = false;
            setBusy(false);
        }
    };

    // Each person keeps favorites on the computers they may use.
    const mayStar =
        canSteer() && !scoped() && (!runner || runners.some((each) => each.id === runner));
    const starred = target !== null && favorites.includes(target);

    /** Star or unstar a folder. The list changes when the server says it did, on every device. */
    const setFavorite = (path, on) =>
        attempt(async () => {
            setSaving(true);

            try {
                await api("folder-favorites", { path, starred: on, ...(runner ? { runner } : {}) });

                return true;
            } finally {
                setSaving(false);
            }
        });

    const toggleFavorite = () => {
        setFavorite(target, !starred);
        // The list keeps the keys: the star, off while it saves, would drop the focus to the page.
        list.current?.focus({ preventScroll: true });
    };

    // Ctrl/⌘+1…9 starts a session in a favorite, while this is the New session picker on top. Caught before the
    // app's own keys; Alt+1…9 (sessions) has Alt, so it never gets here.
    useEffect(() => {
        if (changing || picking) {
            return;
        }

        const shortcut = (event) => {
            const sheet = store.state.sheet;
            const mod = APPLE ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
            const digit = /^Digit([1-9])$/.exec(event.code);
            const favorite = digit && favorites[Number(digit[1]) - 1];

            if (
                !mod ||
                !favorite ||
                event.altKey ||
                event.shiftKey ||
                event.isComposing ||
                sheet?.type !== "cwd" ||
                sheet.mode !== "new" ||
                store.state.launcher
            ) {
                return;
            }

            event.preventDefault();
            event.stopImmediatePropagation();

            if (!event.repeat) {
                use(favorite);
            }
        };

        addEventListener("keydown", shortcut, true);

        return () => removeEventListener("keydown", shortcut, true);
    }, [changing, picking, favorites, worktree]);

    const toggleHidden = () => {
        const next = !hidden;

        localStorage.setItem(HIDDEN_KEY, next ? "1" : "0");
        setHidden(next);

        if (folder !== null) {
            load(folder, { showHidden: next, select: selected });
        }
    };

    const toggleAlwaysDefault = (event) => {
        event.stopPropagation();
        const next = !alwaysDefault;

        localStorage.setItem(ALWAYS_DEFAULT_KEY, next ? "1" : "0");
        setAlwaysDefault(next);
    };

    /** A path typed: whole, or from the folder you are in. */
    const goTo = (text) => load(isWholePath(text) ? text : joined(folder, text));

    // The list's keys, as a file dialog's: arrows select, Enter goes into the selected folder (or opens the one you are
    // in), Ctrl+Enter opens, Backspace goes up, letters jump to a folder, and / or ~ starts a path.
    const onKeyDown = (event) => {
        if (event.target !== list.current || event.isComposing) {
            return;
        }

        const at = dirs.findIndex((dir) => dir.path === selected);

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();

            if (event.altKey && event.key === "ArrowUp") {
                up();

                return;
            }

            const next =
                at < 0
                    ? event.key === "ArrowDown"
                        ? 0
                        : dirs.length - 1
                    : Math.max(
                          0,
                          Math.min(dirs.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)),
                      );

            setSelected(dirs[next]?.path ?? null);
        } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            setSelected(dirs[event.key === "Home" ? 0 : dirs.length - 1]?.path ?? null);
        } else if (event.key === "Enter") {
            event.preventDefault();

            if (event.ctrlKey || event.metaKey || at < 0) {
                use();
            } else {
                load(selected);
            }
        } else if (event.key === "Backspace") {
            event.preventDefault();
            up();
        } else if ((event.ctrlKey || event.metaKey) && event.key === "l") {
            event.preventDefault();
            setEditing(folder ?? "");
        } else if (event.key === "/" || event.key === "~") {
            event.preventDefault();
            setEditing(event.key);
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const now = Date.now();
            const text =
                (now - typed.current.at < 800 ? typed.current.text : "") + event.key.toLowerCase();
            const found = dirs.find((dir) => dir.name.toLowerCase().startsWith(text));

            typed.current = { text, at: now };

            if (found) {
                setSelected(found.path);
            }
        }
    };

    /**
     * Start the new session on another computer, or this server (`null`): its folders show instead. The one already
     * chosen changes nothing: its listing stays, since no new read would come to replace it.
     */
    const pick = (id) => {
        if (id === runner) {
            return;
        }

        setSelected(null);
        setListing(null);
        setPicked(id);
    };

    const crumbs = folder === null ? [] : crumbsOf(folder, home);
    const pathHint =
        separatorOf(home ?? "") === "\\" ? "A path: ~\\code or D:\\work" : "A path: ~/code or /srv";
    const recent = (listing?.recent ?? []).filter((path) => !favorites.includes(path));
    const favoriteLabels = recentLabels(favorites, home);
    const labels = recentLabels(recent, home);
    const places = [
        ...(!runner && server?.defaultCwd && server.defaultCwd !== home && server.defaultCwd !== "/"
            ? [
                  {
                      path: server.defaultCwd,
                      name: "Default workspace",
                      icon: "folder",
                      pin: !changing && !picking,
                  },
              ]
            : []),
        ...(home ? [{ path: home, name: "Home", icon: "home" }] : []),
        // The computer's top folders: this server lists its own (`/`, or each Windows drive); for another computer,
        // and until the list comes, the drive home is on, or `/`.
        ...(
            listing?.roots ?? [home && separatorOf(home) === "\\" ? `${home.slice(0, 2)}\\` : "/"]
        ).map((root) => ({
            path: root,
            name: root === "/" ? "Computer" : rootName(root),
            icon: "monitor",
        })),
    ];

    const place = (path, name, icon, key = null, pin = false) => html`<button
        key=${path}
        type="button"
        class=${`fp-place ${path === folder ? "on" : ""}`}
        title=${shortPath(path, home)}
        aria-current=${path === folder ? "location" : undefined}
        onClick=${() => load(path)}
    >
        <${Icon} name=${icon} size=${15} />
        <span>${name}</span>
        ${
            pin &&
            html`<span
                role="button"
                tabindex="-1"
                class=${`fp-pin ${alwaysDefault ? "on" : ""}`}
                title=${alwaysDefault ? "Always open new sessions here" : "Open new sessions here by default"}
                aria-label=${alwaysDefault ? "Always open new sessions here" : "Open new sessions here by default"}
                onClick=${toggleAlwaysDefault}
            >
                <${Icon} name="pin" size=${13} />
            </span>`
        }
        ${key && html`<span class="fp-key">${key}</span>`}
    </button>`;

    // A pick goes back to the copy sheet, which keeps its choices.
    const cancel = picking ? goBack : closeSheet;

    return html`<${Sheet}
        title=${
            title ??
            (changing ? "Move this session: pick a folder" : "New session: pick a folder") +
                (computer ? ` on ${computer}` : "")
        }
        onClose=${cancel}
        wide=${true}
        className="folder-sheet"
    >
        <div class="fp-bar">
            <button
                type="button"
                class="icon-button"
                aria-label="Up one folder"
                title="Up one folder (Backspace)"
                disabled=${!listing?.parent}
                onClick=${up}
            >
                <${Icon} name="up" size=${18} />
            </button>
            ${
                editing !== null
                    ? html`<${LineInput}
                          class="fp-path-input"
                          value=${editing}
                          placeholder=${pathHint}
                          label="Go to a path"
                          onSubmit=${goTo}
                          onCancel=${() => {
                              setEditing(null);
                              list.current?.focus({ preventScroll: true });
                          }}
                      />`
                    : html`<nav
                          class="fp-crumbs"
                          ref=${crumbsBox}
                          onScroll=${(event) => markCut(event.currentTarget)}
                          aria-label="Folder"
                          title="Click the path's end to type one (Ctrl+L)"
                      >
                          ${crumbs.map((crumb, index) =>
                              index === crumbs.length - 1
                                  ? html`<button
                                        key=${crumb.path}
                                        type="button"
                                        class="fp-crumb here"
                                        aria-current="location"
                                        aria-label=${`${crumb.name}: type a path`}
                                        onClick=${() => setEditing(folder)}
                                    >
                                        ${crumb.name}
                                    </button>`
                                  : html`<button
                                            key=${crumb.path}
                                            type="button"
                                            class="fp-crumb"
                                            onClick=${() => load(crumb.path)}
                                        >
                                            ${crumb.name}
                                        </button>
                                        <${Icon}
                                            key=${`${crumb.path}/`}
                                            name="chevron"
                                            size=${11}
                                            class="fp-sep"
                                        />`,
                          )}
                      </nav>`
            }
            ${
                !runner &&
                html`<button
                    type="button"
                    class="button small fp-new"
                    disabled=${folder === null}
                    onClick=${() => {
                        setEditing(null);
                        setNaming(true);
                    }}
                >
                    <${Icon} name="plus" size=${14} /> New folder
                </button>`
            }
        </div>
        ${
            missing !== null &&
            html`<div class="folder-missing">
                <span>
                    ${missingWhy ?? html`<span class="mono">${shortPath(missing, home)}</span> isn't there.`}
                </span>
                <span class="fp-missing-actions">
                    ${
                        missingWhy === null &&
                        !runner &&
                        html`<button class="button small" onClick=${() => make(missing)}>
                            Create it
                        </button>`
                    }
                    ${
                        // A favorite that is gone is unstarred here: the star acts only on a folder that opens.
                        mayStar &&
                        favorites.includes(missing) &&
                        html`<button
                            class="button small"
                            disabled=${saving}
                            onClick=${() =>
                                setFavorite(missing, false).then(
                                    (done) => done && setMissing(null),
                                )}
                        >
                            Remove from favorites
                        </button>`
                    }
                    <button
                        class="icon-button"
                        aria-label="Never mind"
                        onClick=${() => setMissing(null)}
                    >
                        <${Icon} name="close" size=${15} />
                    </button>
                </span>
            </div>`
        }
        <div class="fp-main">
            <nav class="fp-places" aria-label="Places">
                ${places.map((each) => place(each.path, each.name, each.icon, null, each.pin))}
                ${favorites.length > 0 && html`<div class="fp-places-title">Favorites</div>`}
                ${favorites.map((path, index) =>
                    place(
                        path,
                        favoriteLabels[index],
                        "star",
                        !changing && !picking && !touch && index < 9
                            ? `${APPLE ? "⌘" : "Ctrl+"}${index + 1}`
                            : null,
                    ),
                )}
                ${recent.length > 0 && html`<div class="fp-places-title">Recent</div>`}
                ${recent.map((path, index) => place(path, labels[index], "folder"))}
                ${!changing && !picking && runners.length > 0 && html`<${RunsOn} runner=${runner} runners=${runners} onPick=${pick} />`}
                ${
                    !changing &&
                    !picking &&
                    piSessionsAvailable(runner) &&
                    html`<button
                        type="button"
                        class="link small fp-pi"
                        onClick=${() => openSheet({ type: "pi-sessions", runner })}
                    >
                        Continue a Pi session…
                    </button>`
                }
            </nav>
            <div
                class="fp-list"
                ref=${list}
                role="listbox"
                aria-label="Folders"
                tabindex="0"
                onKeyDown=${onKeyDown}
            >
                ${
                    naming &&
                    html`<${LineInput}
                        class="fp-naming"
                        placeholder="Folder name"
                        label="The new folder's name"
                        onSubmit=${(name) => make(joined(folder, name))}
                        onCancel=${() => {
                            setNaming(false);
                            list.current?.focus({ preventScroll: true });
                        }}
                    />`
                }
                ${failed && html`<p class="fp-note">${failed}</p>`}
                ${!listing && !failed && html`<p class="fp-note">Opening…</p>`}
                ${dirs.map(
                    (dir) => html`<button
                        key=${dir.path}
                        type="button"
                        tabindex="-1"
                        class=${`fp-row ${dir.path === selected ? "on" : ""}`}
                        role="option"
                        aria-selected=${dir.path === selected ? "true" : "false"}
                        data-path=${dir.path}
                        title=${touch ? undefined : "Double-click to open"}
                        onClick=${() => {
                            if (touch) {
                                load(dir.path);

                                return;
                            }

                            // The list keeps the keys: a click gives the row the focus, which the list's keys ignore.
                            setSelected(dir.path);
                            list.current?.focus({ preventScroll: true });
                        }}
                        onDblClick=${() => !touch && load(dir.path)}
                    >
                        <${Icon} name="folder" size=${16} />
                        <span class="fp-name">${dir.name}</span>
                        ${touch && html`<${Icon} name="chevron" size=${14} class="fp-chev" />`}
                    </button>`,
                )}
                ${listing && dirs.length === 0 && html`<p class="fp-note">No folders in here.</p>`}
            </div>
        </div>
        <div class="fp-foot">
            <div class="fp-target" title=${target ? shortPath(target, home) : ""}>
                <span class="muted">Folder:</span>
                <span class="mono">${target ? shortPath(target, home) : "…"}</span>
                ${
                    mayStar &&
                    target !== null &&
                    html`<button
                        type="button"
                        class=${`icon-button fp-star ${starred ? "on" : ""}`}
                        aria-pressed=${starred ? "true" : "false"}
                        aria-label=${starred ? "Remove from favorites" : "Add to favorites"}
                        title=${starred ? "Remove from favorites" : "Add to favorites"}
                        disabled=${saving}
                        onClick=${toggleFavorite}
                    >
                        <${Icon} name="star" size=${15} />
                    </button>`
                }
            </div>
            <div class="fp-options">
                ${
                    !changing &&
                    !picking &&
                    html`<label
                        class="check"
                        title="The session gets a branch of its own, apart from this folder"
                    >
                        <input
                            type="checkbox"
                            checked=${worktree}
                            onChange=${(event) => setWorktree(event.currentTarget.checked)}
                        />
                        Own git worktree
                    </label>`
                }
                <label class="check">
                    <input type="checkbox" checked=${hidden} onChange=${toggleHidden} /> Show hidden
                </label>
            </div>
            <div class="fp-buttons">
                <button type="button" class="button" onClick=${cancel}>Cancel</button>
                <button
                    type="button"
                    class="button primary"
                    title=${touch ? undefined : "Ctrl+Enter"}
                    disabled=${target === null || busy || here}
                    onClick=${() => use()}
                >
                    ${here ? "Already here" : changing ? "Move here" : "Open"}
                </button>
            </div>
        </div>
    <//>`;
}
