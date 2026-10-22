// The sidebar: the rail (Pi, the tools, and you; folded, numbered sessions too) and the session list beside it, in the
// sidebar, the drawer, and a phone's home screen; and the order and archiving of sessions.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Avatar, folderColor, initials } from "./avatar.js";
import { goHome, useBack } from "./back.js";
import {
    ExtensionRailButtons,
    sessionActions,
    sessionChips,
    sessionFilters,
    sessionFilterTest,
    sessionWords,
} from "./extension-ui.js";
import { useDragToClose } from "./gestures.js";
import { PeeksRailButton } from "./peeks.js";
import { PipRailButton } from "./pip.js";
import { sessionForest } from "./session-tree.js";
import {
    actions,
    canSteer,
    collab,
    navigate,
    notify,
    isUnread,
    openSheet,
    scoped,
    sessionUnread,
    setUnread,
    stillMoving,
    store,
    workspaceOrder,
} from "./store.js";
import { finishedUnseen } from "./seen.js";
import { isPinned, prefs, setPrefs, togglePin } from "./theme.js";
import {
    APPLE,
    apartFromViews,
    html,
    Icon,
    memo,
    NO_HOVER,
    railState,
    scrimPress,
    shortPath,
    Slide,
    timeAgo,
    useMinute,
    usePresence,
    useSide,
    useSlide,
} from "./ui.js";

/**
 * Back to the session list, where it is not beside the conversation: back past the sessions opened from it, as a
 * phone's back would go, or to it in this session's place when history does not lead there.
 */
export const toSessions = () => goHome(() => navigate(null, { replace: true }));

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

    notify(
        "info",
        `${archived ? "Archived" : "Unarchived"} ${what}. ${matchMedia("(pointer: coarse)").matches ? "Tap" : "Click"} to undo.`,
        async () => {
            await setArchived(done, !archived, { undo: false });

            if (left && store.state.conversationId === null) {
                navigate(open);
            }
        },
    );
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

/** When today began, in this device's time zone: worked out once for each grouping, not once for each session. */
function todayStart() {
    const today = new Date();

    today.setHours(0, 0, 0, 0);

    return today.getTime();
}

/** Which day bucket a time falls in, in this device's time zone: `start` is when today began (`todayStart`). */
function dayGroup(ms, start) {
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

/** Failed subagents nobody has dealt with (seen or dismissed), of a session's counts or the rail's totals. */
const failing = (counts) => (counts.failed ?? 0) - (counts.dealt ?? 0);

/** "2 working · 1 failed subagents": a session's subagents, for the ⑂ mark's tooltip. */
function subagentsTip(counts) {
    const shown = { ...counts, failed: failing(counts) };
    const kinds = ["working", "waiting", "failed"].filter((kind) => shown[kind] > 0);
    const total = kinds.reduce((sum, kind) => sum + shown[kind], 0);

    return `${kinds.map((kind) => `${shown[kind]} ${kind}`).join(" · ")} subagent${total === 1 ? "" : "s"}`;
}

/**
 * How long a finger rests on a row before its actions open; how far it may stray meanwhile (as far as a scroll, or the
 * drawer's drag); and how long before the row shows the press, so a scroll's start does not light it.
 */
const PRESS_MS = 450;
const PRESS_SLOP = 8;
const PRESS_SHOWS_MS = 100;

/** The list whose row a finger last held: Select in that row's sheet selects there. */
let pressedIn = null;

/**
 * Select a session in the list where its row was held, and let taps there select more (or let go), as Ctrl/⌘+click
 * does with a mouse. From the sheet a long press opens.
 */
export function selectFromList(id) {
    pressedIn?.current?.(id);
}

/**
 * The square at the start of a session's row: its folder's color, in the shape of where the session is. The first that
 * holds wins: a call waiting for you, Pi or its subagents at work, a failed run (solid while new, drawn once seen),
 * finished since this browser last looked or marked unread (solid), and read or never run (hollow).
 */
function stateMark(session, working, marked, unseen = finishedUnseen(session)) {
    const fresh = marked || unseen;

    if (session.waiting) {
        return { shape: "waiting", label: "Waiting for approval" };
    }

    if (session.busy || working) {
        return { shape: "working", label: "Working" };
    }

    if (session.failed) {
        return fresh
            ? { shape: "failed", label: "Failed, not read" }
            : { shape: "failed seen", label: "Failed" };
    }

    return fresh ? { shape: "fresh", label: "Not read" } : { shape: "seen", label: "" };
}

/** A row's state for themes (`data-state`), by its square's shape: a documented name that stays when the squares change. */
const ROW_STATES = {
    waiting: "waiting",
    working: "working",
    failed: "failed",
    fresh: "done",
    seen: "idle",
};

/**
 * Sessions whose rows this page has drawn. A row rises in only the first time: back to the list on a phone builds the
 * list anew, and every row rising in again made it flicker. A session new to the page (started since) still rises in.
 */
const shownRows = new Set();

/** A session's square, as its row in the list draws it (the home screen's Jump back in too). */
export function sessionMark(session) {
    const counts = session.subagents ?? {};

    return stateMark(
        session,
        (counts.working ?? 0) + (counts.waiting ?? 0) > 0,
        isUnread(session.id),
    );
}

/**
 * One session on one line: its folder's color in the shape of its state, its title, and on the right what goes on there (its working subagents,
 * who else is in it, Pi working, a call waiting for you), unread chat, and how long ago. Its folder and model are in
 * its tooltip. Memoized (`memo`): it reads nothing of the store as it draws, only its props, which `AllSessions` works
 * out for it. `minute` and `extensionsRev` draw it again as time passes and as extensions' chips and words change.
 */
function SessionRow({
    session,
    branches,
    index,
    number,
    needle,
    selected,
    pressing,
    folders,
    onPick,
    onSelect,
    hoverAction,
    open,
    pinned,
    marked,
    unread,
    unseen,
    moving,
    home,
    meId,
    collabs,
    steers,
    hovers,
}) {
    // Where it rises in, in turn, when it is new to this page; null when it shows as it was.
    const [arrival] = useState(() => (shownRows.has(session.id) ? null : index));

    useLayoutEffect(() => {
        shownRows.add(session.id);
    }, []);
    const title = session.title ?? "New session";
    const path = shortPath(session.cwd, home);
    const where = [
        session.worktree ? `${path} ⎇ ${session.worktree.branch}` : path,
        session.model,
    ].filter(Boolean);
    // The Folders tab names the folder above the row already: its model comes first.
    const tip = [title, ...(folders ? where.reverse() : where)].join(" · ");
    // A search can match the folder or model instead of the title: the row shows which.
    let hit =
        needle && !title.toLowerCase().includes(needle)
            ? [path, session.cwd, session.model].find((text) =>
                  text?.toLowerCase().includes(needle),
              )
            : undefined;

    // A path from the folder that matched: its start is the same in every row, and would push the match out of sight.
    if (hit && hit !== session.model) {
        const parts = hit.split("/");
        const at = parts.findLastIndex((part) => part.toLowerCase().includes(needle));

        hit = at > 0 ? `…/${parts.slice(at).join("/")}` : hit;
    }

    // Or a word an extension gave it, such as a tag.
    if (needle && hit === undefined && !title.toLowerCase().includes(needle)) {
        hit = sessionWords(session).find((word) => word.includes(needle));
    }

    // What extensions show on the row, under its title.
    const chips = sessionChips(session);

    const counts = session.subagents ?? {};
    const live = (counts.working ?? 0) + (counts.waiting ?? 0);
    const failed = failing(counts);
    // Subagents at work, or failed ones nobody dealt with, but not over a call waiting for you: that says more.
    const fork = !session.waiting && (live > 0 || failed > 0);
    const person = collabs ? (session.people ?? []).find((each) => each.id !== meId) : undefined;
    const mark = stateMark(session, live > 0, marked, unseen);
    // Archive, pin, and mark-unread show on hover; an archived session only comes back, and only for people who steer.
    // And the first extension action with an icon (`pocket.sessionAction`). None where nothing hovers (`hovers`).
    const acts = hovers
        ? (steers ? 1 : 0) + (session.archived ? 0 : 2) + (hoverAction ? 1 : 0)
        : 0;

    return html`<div
        class=${`session-row ${arrival === null ? "" : "arriving"} ${open ? "active" : ""} ${selected ? "selected" : ""} ${pressing ? "pressing" : ""} ${moving ? "moving" : ""} ${marked ? "marked-unread" : ""} ${unseen ? "unseen" : ""} ${chips.length > 0 ? "with-chips" : ""} ${["no-acts", "one-act", "", "three-acts", "four-acts"][acts]}`}
        data-part="session-row"
        data-state=${ROW_STATES[mark.shape.split(" ")[0]]}
        data-id=${session.id}
        style=${`${arrival === null ? "" : `--i:${arrival};`}--linked-depth:${Math.min(branches.length, 3)}`}
    >
        ${
            branches.length > 0 &&
            html`<span class="session-branches" data-part="session-branches" aria-hidden="true">
                ${branches.slice(-3).map(
                    (continues, index, visible) => html`<span
                        class=${`${continues ? "continues" : ""} ${index === visible.length - 1 ? "elbow" : ""}`}
                    ></span>`,
                )}
            </span>`
        }
        <button
            class=${`session ${unread ? "unread" : ""}`}
            data-part="session-button"
            aria-current=${open ? "page" : undefined}
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
                            class=${`state-mark ${mark.shape}`}
                            data-part="session-mark"
                            style=${`--folder:${folderColor(session.cwd)}`}
                            role=${mark.label ? "img" : undefined}
                            aria-label=${mark.label || undefined}
                            aria-hidden=${mark.label ? undefined : "true"}
                        ></span>`
                }
            </span>
            <span class=${`session-title ${hit ? "with-hit" : ""}`}>
                ${
                    hit
                        ? html`<span class="session-name">${title}</span>
                            <span class="session-hit">
                                <${Highlight} text=${hit} needle=${needle} />
                            </span>`
                        : html`<${Highlight} text=${title} needle=${needle} />`
                }
            </span>
            <span class="session-side">
                ${
                    fork &&
                    html`<span
                        class=${`session-fork ${live > 0 ? "" : "failed"}`}
                        title=${subagentsTip(counts)}
                    >
                        <${Icon} name="fork" size=${10} />${live > 0 ? live : failed}
                    </span>`
                }
                ${!fork && person && html`<${Avatar} person=${person} size=${18} />`}
                ${
                    session.busy &&
                    !session.waiting &&
                    !fork &&
                    html`<span class="session-working" title="Working"></span>`
                }
                ${
                    session.waiting &&
                    html`<span class="session-needs" title="Waiting for approval">
                        ${steers ? "needs you" : "waiting"}
                    </span>`
                }
                ${
                    (unread || marked) &&
                    html`<span
                        class="unread-dot"
                        title=${marked ? "Marked unread" : "New chat messages"}
                    ></span>`
                }
                <span class="session-time">${timeAgo(session.updatedAt)}</span>
                ${
                    number !== undefined &&
                    number < 9 &&
                    html`<kbd class="session-num">${number + 1}</kbd>`
                }
            </span>
        </button>
        ${
            chips.length > 0 &&
            html`<span class="session-chips" data-part="session-chips">
                ${chips.map((chip) =>
                    chip.run
                        ? html`<button
                            key=${chip.key}
                            class="session-chip"
                            data-part="session-chip"
                            title=${chip.title}
                            onClick=${chip.run}
                        >
                            ${chip.label}
                        </button>`
                        : html`<span
                            key=${chip.key}
                            class="session-chip"
                            data-part="session-chip"
                            title=${chip.title}
                        >
                            ${chip.label}
                        </span>`,
                )}
            </span>`
        }
        ${
            hovers &&
            html`<span class="session-actions">
            ${
                hoverAction &&
                html`<button
                    class="session-act session-ext-act"
                    title=${hoverAction.title}
                    aria-label=${hoverAction.title}
                    onClick=${() => hoverAction.run([session.id])}
                >
                    <${Icon} path=${hoverAction.iconPath} size=${14} />
                </button>`
            }
            ${
                steers &&
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
            ${
                !session.archived &&
                html`<button
                    class=${`session-act session-unread ${marked ? "on" : ""}`}
                    title=${marked ? "Mark read" : "Mark unread"}
                    aria-label=${marked ? "Mark read" : "Mark unread"}
                    onClick=${() => setUnread(session.id, !marked)}
                >
                    <${Icon} name=${marked ? "check" : "unread"} size=${14} />
                </button>`
            }
        </span>`
        }
    </div>`;
}

/** A row draws again when what it shows changes. Its place (`index`) counts only as it mounts, for its rise-in. */
const MemoRow = memo(SessionRow, ["index"]);

/**
 * Sessions in groups: pinned, then by day or by folder. While searching, one flat list of matches. `today` is when
 * today began, and changes the day groups as days pass.
 */
function groupsOf(shown, { tab, needle, home, pinned, today }) {
    if (needle !== "" || tab === "archived") {
        return [{ key: "flat", label: needle ? "Matches" : "Archived", rows: shown }];
    }

    const groups = [];
    const pins = new Set(pinned);
    const first = shown.filter((session) => pins.has(session.id));

    if (first.length > 0) {
        groups.push({ key: "pinned", label: "Pinned", rows: first });
    }

    const rest = shown.filter((session) => !pins.has(session.id));
    const byKey = new Map();

    for (const session of rest) {
        const day = tab === "folders" ? "" : dayGroup(session.updatedAt, today);
        const key = tab === "folders" ? `dir:${session.cwd}` : `day:${day}`;

        if (!byKey.has(key)) {
            byKey.set(key, {
                key,
                label:
                    tab === "folders"
                        ? html`<${FolderName} path=${shortPath(session.cwd, home)} />`
                        : day,
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

function AllSessions({ compact = false }) {
    const { sessions, sessionsLoaded, server, pinned } = store.state;
    const canStart = canSteer() && !scoped();
    const [query, setQueryState] = useState(() => (compact ? "" : listKept.query));
    const [tab, setTabState] = useState(() => (prefs().group === "folder" ? "folders" : "recent"));
    const [closed, setClosed] = useState(readClosed);
    const [selected, setSelectedState] = useState(() => new Set());
    // Taps select rows instead of opening them: a selection started from a long press's sheet, on a touch screen.
    const [tapSelects, setTapSelects] = useState(false);
    // The row a finger holds down, before its actions open.
    const [pressing, setPressing] = useState(null);
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

        if (next.size === 0) {
            setTapSelects(false);
        }
    };

    // What Select in a held row's sheet does here; and what lets go of a press under way.
    const startSelect = useRef(null);
    const unpress = useRef(null);

    startSelect.current = (id) => {
        anchor.current = id;
        setSelected(new Set([...picked.current, id]));
        setTapSelects(true);
    };

    useEffect(
        () => () => {
            unpress.current?.();

            if (pressedIn === startSelect) {
                pressedIn = null;
            }
        },
        [],
    );

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

    // What changes the list's rows: the sessions and pins, the tab and the search, extensions' filters and words
    // (`extensionsRev`), and the day, which moves sessions between the day groups. Worked out again only when one of
    // them changes, not on every draw.
    const { extensionsRev } = store.state;
    const minute = useMinute();
    const today = useMemo(todayStart, [minute]);
    const home = server?.home;
    const { shown, kept, groups } = useMemo(() => {
        // Extensions' filters that are on (`pocket.sessionFilter`): a session shows only when each keeps it.
        const kept = sessionFilterTest();
        const shown = sessions.filter(
            (session) =>
                Boolean(session.archived) === archived &&
                (needle === "" ||
                    `${session.title ?? ""} ${session.cwd} ${shortPath(session.cwd, home)} ${session.model ?? ""} ${sessionWords(session).join(" ")}`
                        .toLowerCase()
                        .includes(needle)) &&
                (kept === null || kept(session)),
        );
        const forest = sessionForest(shown, { pinned, folders: tab === "folders" });
        const groups = groupsOf(forest.roots, { tab, needle, home, pinned, today }).map(
            (group) => ({
                ...group,
                rows: group.rows.flatMap((root) => forest.rows.get(root.id)),
            }),
        );

        return { shown, kept, groups };
    }, [sessions, pinned, tab, needle, home, today, extensionsRev]);

    visible.current = useMemo(
        () =>
            groups.flatMap((group) =>
                closed.has(group.key) && group.key !== "flat"
                    ? []
                    : group.rows.map(({ session }) => session.id),
            ),
        [groups, closed],
    );
    const chosen = useMemo(
        () =>
            selected.size === 0
                ? []
                : shown.filter((session) => selected.has(session.id)).map((session) => session.id),
        [shown, selected],
    );
    // Taps select while the bar shows: not for rows selected and then hidden (archived, or searched away).
    const tapping = tapSelects && chosen.length > 0;
    const order = workspaceOrder();
    const numbers = useMemo(
        () => new Map(order.map((session, index) => [session.id, index])),
        [order],
    );

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

        if (event.ctrlKey || event.metaKey || tapping) {
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
     * A finger (or a pen) held on a row opens its actions in a sheet, as hovering shows them to a mouse: touch screens
     * have no hover. The row shows the press while it is held; moving (a scroll, a drag) lets it go. The click the lift
     * may then make, on the row or on the scrim that rose under it, does nothing. While the finger is held nothing on
     * the page can be selected: the sheet rises under the finger, and Android's own long press would otherwise select
     * the word there and raise its Copy bar over the sheet.
     */
    const press = (event, id) => {
        const session = sessions.find((each) => each.id === id);

        // Nothing to offer: an archived session, for someone who cannot bring it back.
        if (!event.isPrimary || !session || (session.archived && !canSteer())) {
            return;
        }

        const { pointerId, clientX: x, clientY: y } = event;
        let fired = false;
        let after = 0;
        const root = document.documentElement;
        const shows = setTimeout(() => setPressing(id), PRESS_SHOWS_MS);

        const open = setTimeout(() => {
            // Gone meanwhile (someone deleted it): nothing to open.
            if (!store.state.sessions.some((each) => each.id === id)) {
                return stop();
            }

            fired = true;
            setPressing(null);
            pressedIn = startSelect;
            // Over the drawer, which stays: Select goes on there.
            store.set({ sheet: { type: "session", id } });
        }, PRESS_MS);

        const move = (each) => {
            if (
                each.pointerId === pointerId &&
                !fired &&
                Math.hypot(each.clientX - x, each.clientY - y) >= PRESS_SLOP
            ) {
                stop();
            }
        };

        const lift = (each) => {
            if (each.pointerId !== pointerId) {
                return;
            }

            if (!fired) {
                return stop();
            }

            // The lift's click comes at once, if at all; the next press is someone else's tap.
            removeEventListener("pointerup", lift, true);
            removeEventListener("pointercancel", lift, true);
            addEventListener("pointerdown", stop, true);
            after = setTimeout(stop, 400);
        };

        // A finger's mouse events only: its mousedown can close the scrim before the click, and Enter on a sheet's
        // item is a click too. Keep the guard through mousedown so the click cannot act on an item under the lift.
        const eat = (each) => {
            if (fired && each.detail > 0) {
                each.preventDefault();
                each.stopPropagation();

                if (each.type === "click") {
                    stop();
                }
            }
        };

        // Android's own long press: no menu, and no text selection. The row's own text cannot be selected already,
        // but the sheet this press opens, rising under the finger, could be: Android would select the word under it
        // and raise its Copy bar over the sheet. So, while the finger is held, the page selects nothing.
        const quiet = (each) => each.preventDefault();
        const hold = (each) => each.preventDefault();

        const stop = () => {
            unpress.current = null;
            clearTimeout(shows);
            clearTimeout(open);
            clearTimeout(after);
            setPressing((now) => (now === id ? null : now));
            root.classList.remove("holding");
            removeEventListener("pointermove", move, true);
            removeEventListener("pointerup", lift, true);
            removeEventListener("pointercancel", lift, true);
            removeEventListener("pointerdown", stop, true);
            removeEventListener("mousedown", eat, true);
            removeEventListener("click", eat, true);
            removeEventListener("contextmenu", quiet, true);
            removeEventListener("selectstart", hold, true);
        };

        unpress.current?.();
        unpress.current = stop;
        root.classList.add("holding");
        addEventListener("pointermove", move, true);
        addEventListener("pointerup", lift, true);
        addEventListener("pointercancel", lift, true);
        addEventListener("mousedown", eat, true);
        addEventListener("click", eat, true);
        addEventListener("contextmenu", quiet, true);
        addEventListener("selectstart", hold, true);
    };

    /**
     * Ctrl/⌘+press on a row selects it (or, if it was selected, unselects it); dragging on does the same to every row
     * between it and the pointer. Once the pointer moves, the list scrolls along near its top or bottom edge. A finger
     * held on a row opens its actions instead.
     */
    const select = (event, id) => {
        held.current = null;

        if (event.button !== 0) {
            return;
        }

        if (event.pointerType !== "mouse") {
            press(event, id);

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

    // On a touch screen, so does back.
    useBack(tapping, clearSelection);

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

    // The tabs are as wide as each other: only another tab, or the bar resized, moves the marker.
    const tabBar = useSlide(tabs, "button.on", "x", tab);
    const count = useMemo(
        () => sessions.filter((session) => !session.archived).length,
        [sessions],
    );
    const filters = sessionFilters();
    const steers = canSteer();
    // Made again only when extensions or this person's steering change: rows keep the same action while they do not.
    const extActions = useMemo(sessionActions, [extensionsRev, steers]);
    const hoverAction = extActions.find((action) => action.iconPath !== null);
    // Rows' handlers that stay the same from draw to draw, so a row draws again only when what it shows changes. They
    // call this draw's `pick` and `select`, which see this draw's selection.
    const handlers = useRef(null);

    handlers.current = { pick, select };
    const [onPick] = useState(() => (event, id) => handlers.current.pick(event, id));
    const [onSelect] = useState(() => (event, id) => handlers.current.select(event, id));
    // What every row reads of the store, read once here: rows read none of it themselves (`SessionRow`). Marks, seen
    // marks, and read times come through `isUnread`, `finishedUnseen`, and `sessionUnread`.
    const { conversationId, me, moving } = store.state;
    const collabs = collab();
    // Row buttons that only a hovering pointer shows (`NO_HOVER`): touch screens draw none.
    const hovers = !NO_HOVER.matches;

    const rowOf = ({ session, branches }, index) => {
        const open = session.id === conversationId && !session.archived;

        return html`<${MemoRow}
            key=${session.id}
            session=${session}
            branches=${branches}
            index=${index}
            number=${numbers.get(session.id)}
            needle=${needle}
            selected=${selected.has(session.id)}
            pressing=${pressing === session.id}
            folders=${tab === "folders" && needle === ""}
            onPick=${onPick}
            onSelect=${onSelect}
            hoverAction=${hoverAction}
            open=${open}
            pinned=${isPinned(session.id)}
            marked=${isUnread(session.id)}
            unread=${collabs && !open && sessionUnread(session)}
            unseen=${finishedUnseen(session)}
            moving=${moving[session.id] !== undefined}
            home=${home}
            meId=${me?.id}
            collabs=${collabs}
            steers=${steers}
            hovers=${hovers}
            minute=${minute}
            extensionsRev=${extensionsRev}
        />`;
    };

    let index = 0;

    return html`<div
        class=${`sessions ${compact ? "compact" : ""} ${tapping ? "tap-selecting" : ""}`}
        data-part="session-list"
    >
        <div class="sessions-head">
            <span class="sessions-name" data-part="session-list-title">Sessions</span>
            <span class="sessions-count">${sessionsLoaded ? count : ""}</span>
            ${
                canStart &&
                html`<button
                    class="new-button"
                    title="New session (Alt+N)"
                    onClick=${() => openSheet({ type: "cwd", mode: "new", fromList: true })}
                >
                    <${Icon} name="plus" size=${14} />
                    New
                </button>`
            }
        </div>
        <label class=${`search ${query ? "filled" : ""}`} data-part="session-search">
            <${Icon} name="search" size=${14} />
            <input
                placeholder="Search sessions"
                aria-label="Search sessions"
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
                            aria-hidden="true"
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
            ${filters.map(
                (filter) => html`<button
                    key=${filter.key}
                    class=${`search-filter badge-host ${filter.on ? "on" : ""}`}
                    data-part="session-filter"
                    data-state=${filter.on ? "on" : "off"}
                    title=${filter.title}
                    aria-label=${[filter.title, filter.badge, filter.on ? "on" : ""].filter(Boolean).join(", ")}
                    onClick=${(event) => {
                        event.preventDefault();
                        filter.run();
                    }}
                >
                    <${Icon} path=${filter.iconPath} size=${14} />
                    ${filter.badge !== "" && html`<span class="badge">${filter.badge}</span>`}
                </button>`,
            )}
        </label>
        <div class="session-tabs" data-part="session-tabs" role="tablist" ref=${tabs}>
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
                    ${kept !== null && !needle ? "No sessions match the filters." : archived ? "No archived sessions." : needle ? "No matches." : "No sessions yet. Start one with New."}
                </div>`
            }
            ${groups.map((group) => {
                const isClosed = closed.has(group.key) && group.key !== "flat";
                // A folded group hides its rows' marks: say when one waits for you or its run failed.
                const trouble = isClosed
                    ? group.rows
                          .map((row) => sessionMark(row.session).shape)
                          .find((shape) => shape === "waiting" || shape === "failed")
                    : undefined;

                return html`<section
                    class=${`session-group ${isClosed ? "closed" : ""}`}
                    data-part="session-group"
                    key=${`${tab}:${group.key}`}
                >
                    ${
                        group.key !== "flat" || needle
                            ? html`<button
                                class="group-head"
                                data-part="session-group-head"
                                onClick=${() => group.key !== "flat" && toggleGroup(group.key)}
                                aria-expanded=${!isClosed}
                            >
                                <span class="group-name" data-part="session-group-name">
                                    ${
                                        typeof group.label === "string"
                                            ? html`<b>${group.label}</b>`
                                            : group.label
                                    }
                                </span>
                                ${
                                    trouble &&
                                    html`<span
                                        class=${`group-trouble ${trouble}`}
                                        role="img"
                                        aria-label=${trouble === "waiting" ? "A session needs you" : "A session failed"}
                                        title=${trouble === "waiting" ? "A session here needs you" : "A session here failed"}
                                    ></span>`
                                }
                                <span class="group-count" data-part="session-group-count">
                                    ${group.rows.length}
                                </span>
                                ${group.key !== "flat" && html`<${Icon} name="down" size=${11} />`}
                            </button>`
                            : null
                    }
                    <div class="group-body" inert=${isClosed}>
                        <div>
                            ${group.rows.map((row) => rowOf(row, index++))}
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
                ${extActions.map(
                    (action) => html`<button
                        key=${action.key}
                        class="button"
                        title=${`${action.title} (${action.module})`}
                        onClick=${() => {
                            clearSelection();
                            action.run(chosen);
                        }}
                    >
                        ${action.label}
                    </button>`,
                )}
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

/** Not drawn again as an answer streams: it reads no conversation's view, and on a phone it stays drawn off-screen. */
export const SessionList = apartFromViews(AllSessions);

/**
 * Subagents across the sessions, by state, as the rail counts them: archived sessions only while a subagent works
 * there, as the subagents board shows them.
 */
export function subagentTotals(sessions = store.state.sessions) {
    const totals = { working: 0, waiting: 0, failed: 0, stopped: 0, done: 0, dealt: 0 };

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
        state.board
            ? { board: false, boardAgents: null }
            : { board: true, drawer: false, page: null },
    );

/** The folded sidebar's sessions, numbered like Waybar's workspaces. */
function RailTiles() {
    const { conversationId } = store.state;
    const items = useRef(null);
    const order = workspaceOrder();
    // The tiles are as tall as each other: the open session's place in the order says where its marker goes.
    const at = order.findIndex((session) => session.id === conversationId);
    const indicator = useSlide(items, ".ws.active", "y", at);

    return html`<div class="rail-items" ref=${items}>
        <${Slide} box=${indicator} />
        ${order.map(
            (session, index) => html`<button
                key=${session.id}
                class=${`ws ${session.id === conversationId ? "active" : ""} ${session.busy ? "busy" : ""} ${session.waiting ? "waiting" : ""}`}
                style=${`--i:${index}`}
                title=${`${session.title ?? "New session"}${index < 9 ? ` (Alt+${index + 1})` : ""}`}
                aria-label=${`${session.title ?? "New session"}${session.waiting ? ", needs you" : session.busy ? ", working" : ""}`}
                aria-current=${session.id === conversationId ? "page" : undefined}
                onClick=${() => navigate(session.id)}
            >
                ${index < 9 ? index + 1 : initials(session.title ?? "New session")}
                ${
                    ((collab() && sessionUnread(session)) || isUnread(session.id)) &&
                    session.id !== conversationId &&
                    html`<span class="unread-dot"></span>`
                }
            </button>`,
        )}
    </div>`;
}

/**
 * The rail beside the session list: Pi (home), the sessions (which fold the sidebar), then the tools (peek tiles, PiP,
 * running now, the subagents board, people, providers, the theme) and you. Folded, it holds the sessions too, numbered.
 * In the drawer and on a phone's home screen it does not fold, and Pi is a mark.
 */
function Rail({ foldable = false, folded = false }) {
    const { sessions, board, me } = store.state;
    const canStart = canSteer() && !scoped();
    // Counted again only when the session list changes, not on each draw of the rail.
    const { busy, agents } = useMemo(
        () => ({
            busy: sessions.filter((session) => session.busy).length,
            agents: subagentTotals(sessions),
        }),
        [sessions],
    );
    const live = agents.working + agents.waiting;
    const failed = failing(agents);
    const keys = APPLE ? "⌘B" : "Ctrl+B";
    const fold = () => setPrefs({ sidebar: folded ? "open" : "rail" });
    const role = me?.role === "owner" ? "owner" : me?.role === "viewer" ? "view only" : "guest";

    return html`<nav class="rail" data-part="rail" aria-label="Sessions and tools">
        ${
            foldable
                ? html`<button
                    class="rail-brand"
                    data-part="brand-mark"
                    title="Home"
                    aria-label="Home"
                    onClick=${toSessions}
                >
                    π
                </button>`
                : html`<span class="rail-brand" data-part="brand-mark" aria-hidden="true">π</span>`
        }
        <span class="rail-gap"></span>
        ${
            foldable
                ? html`<button
                    class=${`rail-button ${folded ? "" : "on"}`}
                    data-part="rail-button"
                    data-state=${railState(!folded)}
                    title=${`Sessions (${keys} ${folded ? "unfolds" : "folds"} the list)`}
                    aria-label="Sessions"
                    aria-expanded=${!folded}
                    onClick=${fold}
                >
                    <${Icon} name="chat" size=${19} />
                </button>`
                : html`<span
                    class="rail-button on"
                    data-part="rail-button"
                    data-state="open"
                    title="Sessions"
                    aria-current="page"
                >
                    <${Icon} name="chat" size=${19} />
                </span>`
        }
        ${!folded && html`<span class="rail-fill"></span>`}
        ${
            folded &&
            canStart &&
            html`<button
                class="rail-button rail-new"
                data-part="rail-button"
                title="New session (Alt+N)"
                aria-label="New session"
                onClick=${() => openSheet({ type: "cwd", mode: "new" })}
            >
                <${Icon} name="plus" size=${19} />
            </button>`
        }
        ${folded && html`<${RailTiles} />`}
        ${foldable && html`<${PeeksRailButton} />`}
        <${PipRailButton} />
        <button
            class=${`rail-button rail-running ${busy > 0 ? "lit" : ""}`}
            data-part="rail-button"
            data-state=${railState(false, busy > 0)}
            title="Running now"
            aria-label=${busy > 0 ? `Running now, ${busy}` : "Running now"}
            onClick=${() => openSheet({ type: "running" })}
        >
            <${Icon} name="pulse" size=${19} />
            ${busy > 0 && html`<span class="rail-count">${busy}</span>`}
        </button>
        <button
            class=${`rail-button rail-agents ${live > 0 ? "lit" : ""} ${board ? "open" : ""}`}
            data-part="rail-button"
            data-state=${railState(board, live > 0)}
            title="Subagents in every session"
            aria-label=${[
                "Subagents",
                live > 0 && `${live} at work`,
                agents.waiting > 0 && `${agents.waiting} waiting for approval`,
                failed > 0 && `${failed} failed`,
            ]
                .filter(Boolean)
                .join(", ")}
            aria-pressed=${board}
            onClick=${toggleBoard}
        >
            <${Icon} name="fork" size=${19} />
            ${live > 0 && html`<span class="rail-count">${live}</span>`}
            ${
                (failed > 0 || agents.waiting > 0) &&
                html`<span class="rail-trouble" aria-hidden="true"></span>`
            }
        </button>
        <${ExtensionRailButtons} />
        ${
            collab()
                ? html`<button
                    class="rail-button"
                    data-part="rail-button"
                    title=${canStart ? "People and invites" : "People"}
                    aria-label="People"
                    onClick=${() => openSheet({ type: "people" })}
                >
                    <${Icon} name="users" size=${19} />
                </button>`
                : html`<button
                    class="rail-button"
                    data-part="rail-button"
                    title="Sign in another device"
                    aria-label="Devices"
                    onClick=${() => openSheet({ type: "invite" })}
                >
                    <${Icon} name="users" size=${19} />
                </button>`
        }
        ${
            me?.role === "owner" &&
            html`<button
                class="rail-button"
                data-part="rail-button"
                title="Model providers"
                aria-label="Providers"
                onClick=${() => openSheet({ type: "providers" })}
            >
                <${Icon} name="key" size=${19} />
            </button>`
        }
        <button
            class="rail-button"
            data-part="rail-button"
            title="Theme, tiling, motion"
            aria-label="Theme"
            onClick=${() => openSheet({ type: "appearance" })}
        >
            <${Icon} name="palette" size=${19} />
        </button>
        <button
            class="rail-button rail-me"
            data-part="rail-button"
            title=${`${me?.name ?? ""} · ${role}`}
            aria-label="Your name"
            onClick=${() => openSheet({ type: "name" })}
        >
            ${me && html`<${Avatar} person=${me} size=${30} />`}
        </button>
    </nav>`;
}

/** Not drawn again as an answer streams: it reads no conversation's view. */
export const RailNav = apartFromViews(Rail);

/** The sidebar's list is this wide at least and at most; the rail beside it stays 56px. */
const LIST_MIN = 204;
const LIST_MAX = 464;

/** The sidebar's usual width, the rail and its list together: the one a new browser starts with (theme.js). */
export const SIDEBAR_WIDTH = 312;

/** Drag the sidebar's right edge to resize its list; a double click puts it back to its usual width. */
export function ResizeHandle() {
    const ref = useRef(null);
    // A theme may put the sidebar on the right: the handle goes to its other edge, and drags the other way.
    const side = useSide(ref, (handle) => handle.parentElement);

    const start = (event) => {
        if (event.button !== 0) {
            return;
        }

        event.preventDefault();
        const root = document.documentElement;
        const sidebar = event.currentTarget.parentElement;
        const box = sidebar.getBoundingClientRect();
        // The rail and the borders, which keep their width.
        const rest = sidebar.offsetWidth - (sidebar.querySelector(".sessions")?.offsetWidth ?? 0);
        let width = prefs().sidebarWidth;

        root.classList.add("resizing");

        // No wider than the stylesheet lets it be: 40% of the screen.
        const max = Math.min(LIST_MAX + rest, Math.max(SIDEBAR_WIDTH, innerWidth * 0.4));

        const move = (each) => {
            const across = side === "right" ? box.right - each.clientX : each.clientX - box.left;

            width = Math.round(Math.min(max, Math.max(LIST_MIN + rest, across)));
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
        class=${`resize-handle ${side === "right" ? "at-left" : ""}`}
        ref=${ref}
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
    // A theme may slide it in from the right: it is dragged back that way.
    const side = useSide(ref);

    useBack(store.state.drawer === true, close);
    // Not under a row's actions, which a long press opens over it: the finger that opened them may still move.
    useDragToClose(ref, {
        dir: side,
        onClose: close,
        enabled: Boolean(open) && !leaving && !store.state.sheet,
    });
    // Esc closes it, as it does a sheet; one over it closes first.
    useEffect(() => {
        if (!open || leaving) {
            return undefined;
        }

        const onKey = (event) => {
            if (
                event.key === "Escape" &&
                !event.defaultPrevented &&
                !store.state.sheet &&
                !store.state.launcher
            ) {
                event.preventDefault();
                close();
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [open, leaving]);

    if (!open) {
        return null;
    }

    return html`<div class=${leaving ? "leaving" : ""} inert=${leaving}>
        <div
            class="overlay drawer-overlay"
            data-part="scrim"
            data-for="drawer"
            onMouseDown=${scrimPress(close)}
        >
            <aside
                class="drawer"
                data-part="drawer"
                data-state=${leaving ? "closing" : undefined}
                ref=${ref}
            >
                <${RailNav} />
                <${SessionList} compact=${true} />
            </aside>
        </div>
    </div>`;
}
