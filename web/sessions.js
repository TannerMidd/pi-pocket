// The sidebar: the rail (Pi, the tools, and you; folded, numbered sessions too) and the session list beside it, in the
// sidebar, the drawer, and a phone's home screen; and the order and archiving of sessions.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Avatar, folderColor, initials } from "./avatar.js";
import { useBack } from "./back.js";
import { useDragToClose } from "./gestures.js";
import {
    actions,
    canSteer,
    collab,
    navigate,
    notify,
    openSheet,
    scoped,
    sessionUnread,
    stillMoving,
    store,
} from "./store.js";
import { isPinned, prefs, setPrefs, togglePin } from "./theme.js";
import { APPLE, html, Icon, shortPath, Slide, timeAgo, usePresence, useSlide } from "./ui.js";

/** The session list on its way: rows shaped like sessions, lit in turn. */
function LoadingSessions() {
    return html`<div role="status" aria-label="Loading sessions">
        ${[72, 54, 64, 46, 58].map(
            (width, index) =>
                html`<div
                    class="session-placeholder"
                    aria-hidden="true"
                    style=${`--width: ${width}%; --delay: ${index * 0.12}s`}
                >
                    <span></span>
                </div>`,
        )}
    </div>`;
}

/**
 * Sessions in "workspace" order, as Alt+1…9 and the rail number them: pinned ones first (in the order they were
 * pinned), then the rest, newest first. Archived sessions are left out.
 */
export function workspaceOrder(state = store.state) {
    const active = state.sessions.filter((session) => !session.archived);
    const pinned = state.pinned
        .map((id) => active.find((session) => session.id === id))
        .filter(Boolean);

    return [...pinned, ...active.filter((session) => !pinned.includes(session))];
}

/**
 * Archive sessions, or bring them back, then say so in a notice that undoes it. Archiving the open session leaves it
 * for the home screen; undoing that opens it again.
 */
export async function setArchived(ids, archived, { undo = true } = {}) {
    if (ids.length === 0) {
        return;
    }

    const titles = new Map(
        store.state.sessions.map((session) => [session.id, session.title ?? "New session"]),
    );

    markMoving(ids, archived);
    const results = await Promise.allSettled(
        ids.map((id) => actions.updateSession(id, { archived })),
    );
    const done = ids.filter((_, index) => results[index].status === "fulfilled");

    // Rows that failed come back at once; the rest stay dimmed until the server's list shows them moved.
    unmarkMoving(
        ids.filter((id) => !done.includes(id)),
        archived,
    );
    const failed = results.find((result) => result.status === "rejected");

    if (failed) {
        notify("error", failed.reason?.message ?? String(failed.reason));
    }

    const open = store.state.conversationId;
    const left = undo && archived && done.includes(open);

    if (left) {
        navigate(null);
    }

    if (!undo || done.length === 0) {
        return;
    }

    const title = titles.get(done[0]) ?? "";
    const what =
        done.length === 1
            ? `“${title.length > 48 ? `${title.slice(0, 47)}…` : title}”`
            : `${done.length} sessions`;

    notify("info", `${archived ? "Archived" : "Unarchived"} ${what}. Tap to undo.`, async () => {
        await setArchived(done, !archived, { undo: false });

        if (left && store.state.conversationId === null) {
            navigate(open);
        }
    });
}

/**
 * Mark sessions as on their way into the archive (true) or out of it (false). The store drops a mark once the list
 * shows the session where it was going; should that never happen (someone moved it straight back, or the request
 * hangs), the mark goes after a while anyway.
 */
function markMoving(ids, archived) {
    store.set((state) => ({
        moving: stillMoving(
            { ...state.moving, ...Object.fromEntries(ids.map((id) => [id, archived])) },
            state.sessions,
        ),
    }));
    setTimeout(() => unmarkMoving(ids, archived), 10_000);
}

/** Drop the marks, but not ones made since the other way (an undo, say). */
function unmarkMoving(ids, archived) {
    if (!ids.some((id) => store.state.moving[id] === archived)) {
        return;
    }

    store.set((state) => {
        const moving = { ...state.moving };

        for (const id of ids) {
            if (moving[id] === archived) {
                delete moving[id];
            }
        }

        return { moving };
    });
}

const CLOSED_KEY = "pocket.closedGroups";

const readClosed = () => {
    try {
        return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]"));
    } catch {
        return new Set();
    }
};

const DAY = 86_400_000;

/** Which day bucket a time falls in, in this device's time zone. */
function dayGroup(ms) {
    const today = new Date();

    today.setHours(0, 0, 0, 0);
    const start = today.getTime();

    if (ms >= start) {
        return "Today";
    }

    if (ms >= start - DAY) {
        return "Yesterday";
    }

    if (ms >= start - 6 * DAY) {
        return "This week";
    }

    if (ms >= start - 29 * DAY) {
        return "This month";
    }

    return "Earlier";
}

/** `~/Development/pi-pocket` with its last part bold, for a folder group's name. */
function FolderName({ path }) {
    const at = path.lastIndexOf("/");

    if (at <= 0) {
        return html`<b class="last">${path}</b>`;
    }

    // A long path gives way before its last part does.
    return html`<span class="first">${path.slice(0, at + 1)}</span>
        <b class="last">${path.slice(at + 1)}</b>`;
}

/** The text with what matched the search marked. */
function Highlight({ text, needle }) {
    if (!needle) {
        return text;
    }

    const at = text.toLowerCase().indexOf(needle);

    if (at === -1) {
        return text;
    }

    return html`${text.slice(0, at)}
    <mark>${text.slice(at, at + needle.length)}</mark>
    ${text.slice(at + needle.length)}`;
}

/** "2 working · 1 failed subagents": a session's subagents, for the ⑂ mark's tooltip. */
function subagentsTip(counts) {
    const kinds = ["working", "waiting", "failed"].filter((kind) => counts[kind] > 0);
    const total = kinds.reduce((sum, kind) => sum + counts[kind], 0);

    return `${kinds.map((kind) => `${counts[kind]} ${kind}`).join(" · ")} subagent${total === 1 ? "" : "s"}`;
}

/**
 * One session on one line: its folder's color, its title, and on the right what goes on there (its working subagents,
 * who else is in it, Pi working, a call waiting for you), unread chat, and how long ago. Its folder and model are in
 * its tooltip.
 */
function SessionRow({ session, index, number, needle, selected, folders, onPick, onSelect }) {
    const { conversationId, server, me } = store.state;
    const pinned = isPinned(session.id);
    const open = session.id === conversationId && !session.archived;
    const unread = collab() && sessionUnread(session) && !open;
    const moving = store.state.moving[session.id] !== undefined;
    const title = session.title ?? "New session";
    const path = shortPath(session.cwd, server?.home);
    const where = [
        session.worktree ? `${path} ⎇ ${session.worktree.branch}` : path,
        session.model,
    ].filter(Boolean);
    // The Folders tab names the folder above the row already: its model comes first.
    const tip = [title, ...(folders ? where.reverse() : where)].join(" · ");
    const counts = session.subagents ?? {};
    const live = (counts.working ?? 0) + (counts.waiting ?? 0);
    const failed = counts.failed ?? 0;
    // Subagents at work, or failed ones, but not over a call waiting for you: that says more.
    const fork = !session.waiting && (live > 0 || failed > 0);
    const person = collab() ? (session.people ?? []).find((each) => each.id !== me?.id) : undefined;
    // Archive and pin show on hover; an archived session only comes back, and only for people who steer.
    const acts = (canSteer() ? 1 : 0) + (session.archived ? 0 : 1);

    return html`<div
        class=${`session-row ${open ? "active" : ""} ${selected ? "selected" : ""} ${moving ? "moving" : ""} ${["no-acts", "one-act", ""][acts]}`}
        data-id=${session.id}
        style=${`--i:${index}`}
    >
        <button
            class=${`session ${unread ? "unread" : ""}`}
            onPointerDown=${(event) => onSelect(event, session.id)}
            onClick=${(event) => onPick(event, session.id)}
            onContextMenu=${(event) => event.ctrlKey && event.preventDefault()}
            title=${tip}
        >
            <span class="session-mark">
                ${
                    selected
                        ? html`<span class="state-check" role="img" aria-label="Selected">
                            <${Icon} name="check" size=${9} />
                        </span>`
                        : html`<span
                            class="folder-mark"
                            style=${`--folder:${folderColor(session.cwd)}`}
                        ></span>`
                }
            </span>
            <span class="session-title">
                <${Highlight} text=${title} needle=${needle} />
            </span>
            <span class="session-side">
                ${
                    fork &&
                    html`<span
                        class=${`session-fork ${live > 0 ? "" : "failed"}`}
                        title=${subagentsTip(counts)}
                    >
                        <${Icon} name="fork" size=${11} />${live > 0 ? live : failed}
                    </span>`
                }
                ${!fork && person && html`<${Avatar} person=${person} size=${16} />`}
                ${
                    session.busy &&
                    !session.waiting &&
                    !fork &&
                    html`<span class="mini-sweep" title="Working"><i></i><i></i><i></i></span>`
                }
                ${
                    session.waiting &&
                    html`<span class="state-warn" title="Waiting for approval">!</span>`
                }
                ${unread && html`<span class="unread-dot" title="New chat messages"></span>`}
                <span class="session-time">${timeAgo(session.updatedAt)}</span>
                ${
                    number !== undefined &&
                    number < 9 &&
                    html`<kbd class="session-num">${number + 1}</kbd>`
                }
            </span>
        </button>
        <span class="session-actions">
            ${
                canSteer() &&
                html`<button
                    class="session-act"
                    title=${session.archived ? "Unarchive" : "Archive"}
                    aria-label=${session.archived ? "Unarchive" : "Archive"}
                    onClick=${() => setArchived([session.id], !session.archived)}
                >
                    <${Icon} name=${session.archived ? "unarchive" : "archive"} size=${14} />
                </button>`
            }
            ${
                !session.archived &&
                html`<button
                    class=${`session-act session-pin ${pinned ? "on" : ""}`}
                    title=${pinned ? "Unpin" : "Pin to the top"}
                    aria-label=${pinned ? "Unpin" : "Pin"}
                    onClick=${() => togglePin(session.id)}
                >
                    <${Icon} name="pin" size=${14} />
                </button>`
            }
        </span>
    </div>`;
}

/** Sessions in groups: pinned, then by day or by folder. While searching, one flat list of matches. */
function groupsOf(shown, { tab, needle, home, pinned }) {
    if (needle !== "" || tab === "archived") {
        return [{ key: "flat", label: needle ? "Matches" : "Archived", rows: shown }];
    }

    const groups = [];
    const pins = shown.filter((session) => pinned.includes(session.id));

    if (pins.length > 0) {
        groups.push({ key: "pinned", label: "Pinned", rows: pins });
    }

    const rest = shown.filter((session) => !pinned.includes(session.id));
    const byKey = new Map();

    for (const session of rest) {
        const key = tab === "folders" ? `dir:${session.cwd}` : `day:${dayGroup(session.updatedAt)}`;

        if (!byKey.has(key)) {
            byKey.set(key, {
                key,
                label:
                    tab === "folders"
                        ? html`<${FolderName} path=${shortPath(session.cwd, home)} />`
                        : dayGroup(session.updatedAt),
                rows: [],
            });
        }

        byKey.get(key).rows.push(session);
    }

    return [...groups, ...byKey.values()];
}

const TABS = [
    ["recent", "Recent"],
    ["folders", "Folders"],
    ["archived", "Archived"],
];

/**
 * What the full list searched for and how far it was scrolled, kept while the tab lives: on a phone the list goes when a
 * session opens, and back from the session shows it again as it was.
 */
const listKept = { query: "", scroll: 0 };

export function SessionList({ compact = false }) {
    const { sessions, sessionsLoaded, server, pinned } = store.state;
    const canStart = canSteer() && !scoped();
    const [query, setQueryState] = useState(() => (compact ? "" : listKept.query));
    const [tab, setTabState] = useState(() => (prefs().group === "folder" ? "folders" : "recent"));
    const [closed, setClosed] = useState(readClosed);
    const [selected, setSelectedState] = useState(() => new Set());
    // The selection as drags and clicks see it between renders; the row a Shift+click extends from; the row a Ctrl/⌘ press
    // already selected, whose click then does nothing; the rows in view, in order.
    const picked = useRef(selected);
    const anchor = useRef(null);
    const held = useRef(null);
    const visible = useRef([]);
    const list = useRef(null);
    const tabs = useRef(null);
    const needle = query.trim().toLowerCase();
    const archived = tab === "archived";

    const setQuery = (next) => {
        if (!compact) {
            listKept.query = next;
        }

        setQueryState(next);
    };

    // Scrolled back to where it was, once its rows are there.
    useLayoutEffect(() => {
        if (!compact && sessionsLoaded && list.current) {
            list.current.scrollTop = listKept.scroll;
        }
    }, [sessionsLoaded]);

    const setSelected = (next) => {
        picked.current = next;
        setSelectedState(next);
    };

    const clearSelection = () => {
        anchor.current = null;
        setSelected(new Set());
    };

    const setTab = (next) => {
        setTabState(next);
        clearSelection();

        if (next !== "archived") {
            setPrefs({ group: next === "folders" ? "folder" : "recent" });
        }
    };

    const shown = sessions.filter(
        (session) =>
            Boolean(session.archived) === archived &&
            (needle === "" ||
                `${session.title ?? ""} ${session.cwd} ${shortPath(session.cwd, server?.home)} ${session.model ?? ""}`
                    .toLowerCase()
                    .includes(needle)),
    );
    const groups = groupsOf(shown, { tab, needle, home: server?.home, pinned });

    visible.current = groups.flatMap((group) =>
        closed.has(group.key) && group.key !== "flat"
            ? []
            : group.rows.map((session) => session.id),
    );
    const chosen = shown.filter((session) => selected.has(session.id)).map((session) => session.id);
    const numbers = new Map(workspaceOrder().map((session, index) => [session.id, index]));

    /** The rows from `from` to `to` as they show, or just `to` when either is out of view. */
    const span = (from, to) => {
        const ids = visible.current;
        const a = ids.indexOf(from);
        const b = ids.indexOf(to);

        return a === -1 || b === -1 ? [to] : ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    };

    /**
     * A plain click opens the session. Shift+click selects from the last row picked (or the open one) to this row;
     * Ctrl/⌘+Enter on a focused row selects it or lets it go.
     */
    const pick = (event, id) => {
        // The press already selected, even if Ctrl/⌘ was let go before the button.
        if (held.current === id && event.detail > 0) {
            held.current = null;

            return;
        }

        if (event.shiftKey) {
            // From the last row picked, or else the open session, if it shows; or else from this row on.
            if (!visible.current.includes(anchor.current)) {
                const open = store.state.conversationId;

                anchor.current = visible.current.includes(open) ? open : id;
            }

            setSelected(new Set([...picked.current, ...span(anchor.current, id)]));

            return;
        }

        if (event.ctrlKey || event.metaKey) {
            const next = new Set(picked.current);

            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }

            anchor.current = id;
            setSelected(next);

            return;
        }

        clearSelection();
        navigate(id);
    };

    /**
     * Ctrl/⌘+press on a row selects it (or, if it was selected, unselects it); dragging on does the same to every row
     * between it and the pointer. Once the pointer moves, the list scrolls along near its top or bottom edge.
     */
    const select = (event, id) => {
        held.current = null;

        if (event.button !== 0 || event.pointerType !== "mouse") {
            return;
        }

        if (event.shiftKey) {
            // No text selection: the click extends the session selection instead.
            event.preventDefault();

            return;
        }

        if (!event.ctrlKey && !event.metaKey) {
            return;
        }

        event.preventDefault();
        held.current = id;
        const box = list.current;
        const root = document.documentElement;
        const before = picked.current;
        const adding = !before.has(id);

        anchor.current = id;
        let reached = null;

        const reach = (to) => {
            if (to === reached) {
                return;
            }

            reached = to;
            const next = new Set(before);

            for (const each of span(id, to)) {
                if (adding) {
                    next.add(each);
                } else {
                    next.delete(each);
                }
            }

            setSelected(next);
        };

        reach(id);
        const start = event.clientY;
        let y = start;

        // The row at the pointer's height, held inside the list so a drag past its sides or ends still counts.
        const under = () => {
            const rect = box.getBoundingClientRect();
            const row = document
                .elementFromPoint(
                    rect.left + box.clientWidth / 2,
                    Math.min(rect.bottom - 2, Math.max(rect.top + 2, y)),
                )
                ?.closest?.(".session-row[data-id]");

            if (!row || !box.contains(row)) {
                return;
            }

            const found = visible.current.find((each) => String(each) === row.dataset.id);

            if (found !== undefined) {
                reach(found);
            }
        };

        // No frame until the pointer moves: a press near an edge is not a drag.
        let frame = 0;

        const scroll = () => {
            const rect = box.getBoundingClientRect();
            const edge = 36;
            const past =
                y < rect.top + edge
                    ? y - rect.top - edge
                    : y > rect.bottom - edge
                      ? y - rect.bottom + edge
                      : 0;

            if (past !== 0) {
                box.scrollTop += Math.max(-24, Math.min(24, past / 2));
                under();
            }

            frame = requestAnimationFrame(scroll);
        };

        const move = (each) => {
            // The button came up where this page did not hear it, say in another window.
            if ((each.buttons & 1) === 0) {
                return stop();
            }

            y = each.clientY;

            if (frame === 0 && Math.abs(y - start) > 4) {
                frame = requestAnimationFrame(scroll);
            }

            under();
        };

        const stop = () => {
            cancelAnimationFrame(frame);
            root.classList.remove("selecting");
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", stop);
            removeEventListener("pointercancel", stop);
            removeEventListener("blur", stop);
        };

        root.classList.add("selecting");
        getSelection()?.removeAllRanges();
        addEventListener("pointermove", move);
        addEventListener("pointerup", stop);
        addEventListener("pointercancel", stop);
        addEventListener("blur", stop);
    };

    const archiveChosen = () => {
        clearSelection();
        setArchived(chosen, !archived);
    };

    const allPinned = chosen.length > 0 && chosen.every((id) => pinned.includes(id));

    const pinChosen = () => {
        for (const id of chosen) {
            if (isPinned(id) === allPinned) {
                togglePin(id);
            }
        }

        clearSelection();
    };

    // Esc lets go of the selection, unless something else takes it: a sheet, the launcher, a text field, or a menu.
    const selecting = selected.size > 0;

    useEffect(() => {
        if (!selecting) {
            return;
        }

        const onKey = (event) => {
            if (
                event.key !== "Escape" ||
                event.defaultPrevented ||
                store.state.sheet ||
                store.state.launcher
            ) {
                return;
            }

            // Taken: this Esc lets go of the selection, and closes nothing else.
            event.preventDefault();
            clearSelection();
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [selecting]);

    const toggleGroup = (key) => {
        const next = new Set(closed);

        if (next.has(key)) {
            next.delete(key);
        } else {
            next.add(key);
        }

        localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
        setClosed(next);
    };

    const tabBar = useSlide(tabs, "button.on", "x");
    const count = sessions.filter((session) => !session.archived).length;
    let index = 0;

    return html`<div class=${`sessions ${compact ? "compact" : ""}`}>
        <div class="sessions-head">
            <span class="sessions-name">Sessions</span>
            <span class="sessions-count">${sessionsLoaded ? count : ""}</span>
            ${
                canStart &&
                html`<button
                    class="new-button"
                    title="New session (Alt N)"
                    onClick=${() => openSheet({ type: "cwd", mode: "new" })}
                >
                    <${Icon} name="plus" size=${14} />
                    New
                </button>`
            }
        </div>
        <label class=${`search ${query ? "filled" : ""}`}>
            <${Icon} name="search" size=${14} />
            <input
                placeholder="Search sessions"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
                onKeyDown=${(event) => {
                    if (event.key !== "Escape" || query === "") {
                        return;
                    }

                    // Taken: this Esc clears the search, not the selection.
                    event.preventDefault();
                    setQuery("");
                }}
            />
            ${
                query
                    ? html`<button
                        class="search-clear"
                        aria-label="Clear"
                        onClick=${() => setQuery("")}
                    >
                        <${Icon} name="close" size=${13} />
                    </button>`
                    : html`<span
                            class="search-keys"
                            title="Launcher"
                            onClick=${(event) => {
                                event.preventDefault();
                                store.set({ launcher: true, drawer: false });
                            }}
                        >
                            ${APPLE ? "⌘K" : "Ctrl K"}
                        </span>
                        <button
                            class="search-launcher"
                            title="Launcher"
                            aria-label="Open the launcher"
                            onClick=${(event) => {
                                event.preventDefault();
                                store.set({ launcher: true, drawer: false });
                            }}
                        >
                            <${Icon} name="command" size=${14} />
                        </button>`
            }
        </label>
        <div class="session-tabs" role="tablist" ref=${tabs}>
            ${TABS.map(
                ([key, label]) => html`<button
                    role="tab"
                    aria-selected=${tab === key}
                    class=${tab === key ? "on" : ""}
                    onClick=${() => setTab(key)}
                >
                    ${label}
                </button>`,
            )}
            <${Slide} box=${tabBar} axis="x" />
        </div>
        <div
            class="session-items"
            ref=${list}
            onScroll=${(event) => !compact && (listKept.scroll = event.currentTarget.scrollTop)}
        >
            ${!sessionsLoaded && html`<${LoadingSessions} />`}
            ${
                sessionsLoaded &&
                shown.length === 0 &&
                html`<div class="sessions-empty">
                    ${archived ? "No archived sessions." : needle ? "No matches." : "No sessions yet. Start one with New."}
                </div>`
            }
            ${groups.map((group) => {
                const isClosed = closed.has(group.key) && group.key !== "flat";

                return html`<section
                    class=${`session-group ${isClosed ? "closed" : ""}`}
                    key=${`${tab}:${group.key}`}
                >
                    ${
                        group.key !== "flat" || needle
                            ? html`<button
                                class="group-head"
                                onClick=${() => group.key !== "flat" && toggleGroup(group.key)}
                                aria-expanded=${!isClosed}
                            >
                                <span class="group-name">
                                    ${
                                        typeof group.label === "string"
                                            ? html`<b>${group.label}</b>`
                                            : group.label
                                    }
                                </span>
                                <span class="group-count">${group.rows.length}</span>
                                ${group.key !== "flat" && html`<${Icon} name="down" size=${11} />`}
                            </button>`
                            : null
                    }
                    <div class="group-body">
                        <div>
                            ${group.rows.map(
                                (session) =>
                                    html`<${SessionRow}
                                        key=${session.id}
                                        session=${session}
                                        index=${index++}
                                        number=${numbers.get(session.id)}
                                        needle=${needle}
                                        selected=${selected.has(session.id)}
                                        folders=${tab === "folders" && needle === ""}
                                        onPick=${pick}
                                        onSelect=${select}
                                    />`,
                            )}
                        </div>
                    </div>
                </section>`;
            })}
        </div>
        ${
            chosen.length > 0 &&
            html`<div class="select-bar" role="group" aria-label="Selected sessions">
                <span class="select-count">
                    <b>${chosen.length}</b>
                    <span class="select-word"> selected</span>
                </span>
                ${
                    canSteer() &&
                    html`<button class="button" onClick=${archiveChosen}>
                        ${archived ? "Unarchive" : "Archive"}
                    </button>`
                }
                ${
                    !archived &&
                    html`<button class="button" onClick=${pinChosen}>
                        ${allPinned ? "Unpin" : "Pin"}
                    </button>`
                }
                <button
                    class="select-clear"
                    title="Clear the selection (Esc)"
                    aria-label="Clear the selection"
                    onClick=${clearSelection}
                >
                    <${Icon} name="close" size=${14} />
                </button>
            </div>`
        }
    </div>`;
}

/**
 * Subagents across the sessions, by state, as the rail counts them: archived sessions only while a subagent works
 * there, as the subagents board shows them.
 */
export function subagentTotals(sessions = store.state.sessions) {
    const totals = { working: 0, waiting: 0, failed: 0, stopped: 0, done: 0 };

    for (const session of sessions) {
        const counts = session.subagents;

        if (!counts || (session.archived && !counts.working && !counts.waiting)) {
            continue;
        }

        for (const state of Object.keys(totals)) {
            totals[state] += counts[state] ?? 0;
        }
    }

    return totals;
}

/** Open the subagents board in the conversation's place, or close it. */
export const toggleBoard = () =>
    store.set((state) =>
        state.board ? { board: false, boardAgents: null } : { board: true, drawer: false },
    );

/** The folded sidebar's sessions, numbered like Waybar's workspaces. */
function RailTiles() {
    const { conversationId } = store.state;
    const items = useRef(null);
    const order = workspaceOrder();
    const indicator = useSlide(items, ".ws.active");

    return html`<div class="rail-items" ref=${items}>
        <${Slide} box=${indicator} />
        ${order.map(
            (session, index) => html`<button
                key=${session.id}
                class=${`ws ${session.id === conversationId ? "active" : ""} ${session.busy ? "busy" : ""} ${session.waiting ? "waiting" : ""}`}
                style=${`--i:${index}`}
                title=${`${session.title ?? "New session"}${index < 9 ? `  (Alt ${index + 1})` : ""}`}
                onClick=${() => navigate(session.id)}
            >
                ${index < 9 ? index + 1 : initials(session.title ?? "New session")}
                ${
                    collab() &&
                    sessionUnread(session) &&
                    session.id !== conversationId &&
                    html`<span class="unread-dot"></span>`
                }
            </button>`,
        )}
    </div>`;
}

/**
 * The rail beside the session list: Pi (which folds the sidebar), the sessions, then the tools (running now, the
 * subagents board, people, providers, the theme) and you. Folded, it holds the sessions too, numbered. In the drawer and
 * on a phone's home screen it does not fold.
 */
export function RailNav({ foldable = false, folded = false }) {
    const { sessions, board, me } = store.state;
    const canStart = canSteer() && !scoped();
    const busy = sessions.filter((session) => session.busy).length;
    const agents = subagentTotals(sessions);
    const live = agents.working + agents.waiting;
    const keys = `${APPLE ? "⌘" : "Ctrl"} B`;
    const fold = () => setPrefs({ sidebar: folded ? "open" : "rail" });
    const role = me?.role === "owner" ? "owner" : me?.role === "viewer" ? "view only" : "guest";

    return html`<nav class="rail" aria-label="Sessions and tools">
        ${
            foldable
                ? html`<button
                    class="rail-brand"
                    title=${`${folded ? "Unfold" : "Fold"} the sidebar (${keys})`}
                    aria-label=${folded ? "Unfold the sidebar" : "Fold the sidebar"}
                    onClick=${fold}
                >
                    π
                </button>`
                : html`<span class="rail-brand" aria-hidden="true">π</span>`
        }
        ${
            !folded &&
            html`<span class="rail-gap"></span>
                ${
                    foldable
                        ? html`<button
                              class="rail-button on"
                              title=${`Sessions · fold to numbers (${keys})`}
                              aria-current="page"
                              onClick=${fold}
                          >
                              <${Icon} name="chat" size=${18} />
                          </button>`
                        : html`<span class="rail-button on" title="Sessions" aria-current="page">
                              <${Icon} name="chat" size=${18} />
                          </span>`
                }
                <span class="rail-fill"></span>`
        }
        ${
            folded &&
            canStart &&
            html`<button
                class="rail-button rail-new"
                title="New session (Alt N)"
                aria-label="New session"
                onClick=${() => openSheet({ type: "cwd", mode: "new" })}
            >
                <${Icon} name="plus" size=${18} />
            </button>`
        }
        ${folded && html`<${RailTiles} />`}
        <button
            class="rail-button rail-running"
            title="Running now"
            aria-label=${busy > 0 ? `Running now, ${busy}` : "Running now"}
            onClick=${() => openSheet({ type: "running" })}
        >
            <${Icon} name="pulse" size=${18} />
            ${busy > 0 && html`<span class="rail-count">${busy}</span>`}
        </button>
        <button
            class=${`rail-button rail-agents ${live > 0 ? "lit" : ""} ${board ? "open" : ""}`}
            title="Subagents in every session"
            aria-label=${[
                "Subagents",
                live > 0 && `${live} at work`,
                agents.waiting > 0 && `${agents.waiting} waiting for approval`,
                agents.failed > 0 && `${agents.failed} failed`,
            ]
                .filter(Boolean)
                .join(", ")}
            aria-pressed=${board}
            onClick=${toggleBoard}
        >
            <${Icon} name="fork" size=${18} />
            ${live > 0 && html`<span class="rail-count">${live}</span>`}
            ${
                (agents.failed > 0 || agents.waiting > 0) &&
                html`<span class="rail-trouble" aria-hidden="true"></span>`
            }
        </button>
        ${
            collab()
                ? html`<button
                    class="rail-button"
                    title=${canStart ? "People and invites" : "People"}
                    aria-label="People"
                    onClick=${() => openSheet({ type: "people" })}
                >
                    <${Icon} name="users" size=${18} />
                </button>`
                : html`<button
                    class="rail-button"
                    title="Sign in another device"
                    aria-label="Devices"
                    onClick=${() => openSheet({ type: "invite" })}
                >
                    <${Icon} name="users" size=${18} />
                </button>`
        }
        <button
            class="rail-button"
            title="Model providers"
            aria-label="Providers"
            onClick=${() => openSheet({ type: "providers" })}
        >
            <${Icon} name="key" size=${18} />
        </button>
        <button
            class="rail-button"
            title="Theme, tiling, motion"
            aria-label="Theme"
            onClick=${() => openSheet({ type: "appearance" })}
        >
            <${Icon} name="palette" size=${18} />
        </button>
        <button
            class="rail-button rail-me"
            title=${`${me?.name ?? ""} · ${role}`}
            aria-label="Your name"
            onClick=${() => openSheet({ type: "name" })}
        >
            ${me && html`<${Avatar} person=${me} size=${26} />`}
        </button>
    </nav>`;
}

/** The sidebar's list is this wide at least and at most; the rail beside it stays 56px. */
const LIST_MIN = 204;
const LIST_MAX = 464;

/** The sidebar's usual width: its border, the rail, a 264px list, and its other border. */
export const SIDEBAR_WIDTH = 324;

/** Drag the sidebar's right edge to resize its list; a double click puts it back to its usual width. */
export function ResizeHandle() {
    const start = (event) => {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        const root = document.documentElement;
        const sidebar = event.currentTarget.parentElement;
        const left = sidebar.getBoundingClientRect().left;
        // The rail and the borders, which keep their width.
        const rest = sidebar.offsetWidth - (sidebar.querySelector(".sessions")?.offsetWidth ?? 0);
        let width = prefs().sidebarWidth;

        root.classList.add("resizing");

        const move = (each) => {
            width = Math.round(
                Math.min(LIST_MAX + rest, Math.max(LIST_MIN + rest, each.clientX - left)),
            );
            root.style.setProperty("--sidebar-w", `${width}px`);
        };

        const stop = () => {
            root.classList.remove("resizing");
            removeEventListener("pointermove", move);
            removeEventListener("pointerup", stop);
            removeEventListener("pointercancel", stop);
            setPrefs({ sidebarWidth: width });
        };

        addEventListener("pointermove", move);
        addEventListener("pointerup", stop);
        addEventListener("pointercancel", stop);
    };

    return html`<div
        class="resize-handle"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        onPointerDown=${start}
        onDblClick=${() => setPrefs({ sidebarWidth: SIDEBAR_WIDTH })}
    ></div>`;
}

/** The rail and the session list, sliding in from the left on narrow screens. */
export function Drawer() {
    const [open, leaving] = usePresence(store.state.drawer || null, 200);
    const ref = useRef(null);
    const close = () => store.set({ drawer: false });

    useBack(store.state.drawer === true, close);
    useDragToClose(ref, { dir: "left", onClose: close, enabled: Boolean(open) && !leaving });

    if (!open) {
        return null;
    }

    return html`<div class=${leaving ? "leaving" : ""} inert=${leaving}>
        <div
            class="overlay drawer-overlay"
            onClick=${(event) => event.target === event.currentTarget && close()}
        >
            <aside class="drawer" ref=${ref}>
                <${RailNav} />
                <${SessionList} compact=${true} />
            </aside>
        </div>
    </div>`;
}
