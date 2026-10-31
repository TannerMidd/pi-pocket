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
import { PeeksRailButton, wholeOnTile } from "./peeks.js";
import { PipRailButton } from "./pip.js";
import { sessionForest, unfolded } from "./session-tree.js";
import {
    actions,
    attempt,
    canSteer,
    chatReadStored,
    collab,
    navigate,
    notify,
    isUnread,
    openSheet,
    scoped,
    sessionUnread,
    setChatReadAt,
    setUnread,
    stillMoving,
    store,
    workspaceOrder,
    foldsNow,
    toggleFoldedLinked,
} from "./store.js";
import { dismiss as dismissSubagent } from "./subagents.js";
import { finishedUnseen, fromServer, markSeen, restoreSeen, seenSnapshot } from "./seen.js";
import { isPinned, prefs, setPrefs, togglePin } from "./theme.js";
import {
    APPLE,
    drawnFor,
    formatWhen,
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
    useScrollMore,
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

const truncate = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

const undoWord = () => (matchMedia("(pointer: coarse)").matches ? "Tap" : "Click");

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

    const what =
        done.length === 1
            ? `“${truncate(titles.get(done[0]) ?? "", 48)}”`
            : `${done.length} sessions`;

    notify(
        "info",
        `${archived ? "Archived" : "Unarchived"} ${what}. ${undoWord()} to undo.`,
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

/** The fold's name for a screen reader: how many, and what its dot says (`aria-expanded` says whether they show). */
function foldLabel(kids, trouble) {
    const count = `${kids} linked ${kids === 1 ? "session" : "sessions"}`;

    return trouble === "waiting"
        ? `${count}, one needs you`
        : trouble === "failed"
          ? `${count}, one failed`
          : count;
}

/** Whether a session folded away under `id` waits for you or failed: the fold shows it, as a folded group does. */
function hiddenTrouble(group, id) {
    const at = group.hidden.findIndex((row) => row.session.id === id);

    if (at === -1) {
        return undefined;
    }

    const depth = group.hidden[at].branches.length;

    for (const row of group.hidden.slice(at + 1)) {
        if (row.branches.length <= depth) {
            break;
        }

        const shape = sessionMark(row.session).shape;

        if (shape === "waiting" || shape === "failed") {
            return shape;
        }
    }

    return undefined;
}

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

const failedRun = (session, state = store.state) =>
    session.failed === true && (isUnread(session.id) || finishedUnseen(session, state));

function needOf(session, state = store.state) {
    if (session.waiting) {
        return "ask";
    }

    if (failedRun(session, state)) {
        return "failed";
    }

    return failing(session.subagents ?? {}) > 0 ? "agents" : null;
}

function needsYouCount(sessions = store.state.sessions, state = store.state) {
    return sessions.reduce(
        (sum, session) => sum + (!session.archived && needOf(session, state) ? 1 : 0),
        0,
    );
}

function slotOf(session, { state, collabs, answered }) {
    const need = needOf(session, state);
    const ask = session.approval;
    // A call answered from here is no longer yours while the list has not heard yet, unless more wait behind it.
    const answeredNow =
        need === "ask" && ask !== undefined && answered.has(ask.id) && ask.count <= 1;

    if (need !== null && !answeredNow) {
        return "needs";
    }

    if (
        isUnread(session.id) ||
        finishedUnseen(session, state) ||
        (collabs && session.id !== state.conversationId && sessionUnread(session, state))
    ) {
        return "ready";
    }

    const counts = session.subagents ?? {};

    return session.busy ||
        session.limited !== undefined ||
        (counts.working ?? 0) + (counts.waiting ?? 0) > 0 ||
        session.background > 0
        ? "working"
        : "quiet";
}

const NEED_RANK = { ask: 0, failed: 1, agents: 2 };

function priorityGroups(shown, ctx, held) {
    const slots = { needs: [], ready: [], working: [], quiet: [] };

    for (const session of shown) {
        let slot = slotOf(session, ctx);

        // Reading the open session moves it nowhere until another opens; a new need still comes first.
        if (
            session.id === held.id &&
            held.slot !== null &&
            slot !== held.slot &&
            slot !== "needs" &&
            !(held.slot === "needs" && held.asked)
        ) {
            slot = held.slot;
        }

        slots[slot].push(session);
    }

    const rank = (session) => NEED_RANK[needOf(session, ctx.state)] ?? 3;

    slots.needs.sort((a, b) => {
        const kinds = rank(a) - rank(b);

        if (kinds !== 0) {
            return kinds;
        }

        return rank(a) === 0
            ? (a.approval?.at ?? 0) - (b.approval?.at ?? 0)
            : (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt);
    });
    const rowsOf = (list) => list.map((session) => ({ session, branches: [], descendants: 0 }));
    const groups = [];

    for (const [slot, label] of [
        ["needs", "Needs you"],
        ["ready", "Ready to read"],
        ["working", "Working"],
        ["quiet", "Quiet"],
    ]) {
        if (slots[slot].length > 0) {
            const rows = rowsOf(slots[slot]);

            groups.push({
                key: `priority:${slot}`,
                slot,
                label,
                total: rows.length,
                rows,
                hidden: rows,
            });
        }
    }

    return {
        groups,
        slots: new Map(
            groups.flatMap((group) => group.rows.map((row) => [row.session.id, group.slot])),
        ),
    };
}

/** Groups that start folded: the person's first unfolding is kept as `!key` in the same stored set as the folds. */
const FOLDED_AT_FIRST = new Set(["priority:quiet"]);

/** How long the focus waits for the next call's Review to draw after an answer, before the list takes it. */
const FOCUS_WAIT_MS = 1000;

/** A flood of calls would push everything else away. */
const NEEDS_SHOWN = 6;

function visibleRows(group, asking, all) {
    return group.slot !== "needs" || all || group.rows.length <= NEEDS_SHOWN
        ? group.rows
        : group.rows.filter((row, index) => index < NEEDS_SHOWN || row.session.id === asking);
}

async function dismissFailures(list) {
    const runs = list.filter((session) => failedRun(session));
    const ids = runs.map((session) => session.id);
    const seen = seenSnapshot(ids);
    const marked = ids.filter((id) => isUnread(id));
    const agents = canSteer() ? list.flatMap((session) => session.failedAgents ?? []) : [];

    markSeen(...ids);

    const set = seenSnapshot(ids);

    for (const id of marked) {
        setUnread(id, false);
    }

    const results = await Promise.allSettled(
        agents.map((agent) =>
            dismissSubagent({ conversationId: agent.conversationId, answeredAt: agent.at }),
        ),
    );
    const refused = results.find((result) => result.status === "rejected");

    if (refused) {
        notify("error", refused.reason?.message ?? String(refused.reason));
    }

    const what =
        list.length === 1
            ? `“${truncate(list[0].title ?? "New session", 48)}”`
            : `${list.length} failed`;

    // A subagent's failure that was dealt with stays dealt with: there is no way back, so no undo.
    if (agents.length > 0 || ids.length === 0) {
        notify("info", `Dismissed ${what}.`);

        return;
    }

    notify("info", `Dismissed ${what}. ${undoWord()} to undo.`, () => {
        const back = restoreSeen(seen, set);

        for (const id of marked.filter((each) => back.has(each))) {
            setUnread(id, true);
        }
    });
}

function markRead(list, { say = true } = {}) {
    const ids = list.map((session) => session.id);
    const seen = seenSnapshot(ids);
    const marked = ids.filter((id) => isUnread(id));
    const chats = list
        .filter((session) => session.chatAt !== undefined && sessionUnread(session))
        .map((session) => [session.id, store.state.chatReads[session.id] ?? 0, session.chatAt]);

    markSeen(...ids);

    const set = seenSnapshot(ids);

    for (const id of marked) {
        setUnread(id, false);
    }

    for (const [id, , read] of chats) {
        setChatReadAt(id, read);
    }

    if (!say) {
        return;
    }

    // Undo puts back only what is still as this made it: a session read since, here or in another tab, stays read.
    notify("info", `Marked ${list.length} read. ${undoWord()} to undo.`, () => {
        const back = restoreSeen(seen, set);

        for (const id of marked.filter((each) => back.has(each) && !isUnread(each))) {
            setUnread(id, true);
        }

        for (const [id, before, read] of chats) {
            if (chatReadStored(id) === read) {
                setChatReadAt(id, before);
            }
        }
    });
}

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

let pressedIn = null;

/**
 * Select a session in the list where its row was held, and let taps there select more (or let go), as Ctrl/⌘+click
 * does with a mouse. From the sheet a long press opens.
 */
export function selectFromList(id) {
    pressedIn?.current?.select(id);
}

export function selectedInList() {
    return pressedIn?.current?.count() ?? 0;
}

export function deselectInList() {
    pressedIn?.current?.clear();
}

/**
 * The square at the start of a session's row: its folder's color, in the shape of where the session is. The first that
 * holds wins: a call waiting for you, a request waiting for its provider's limit to clear, Pi or its subagents at work, a failed run (solid while new, drawn once seen),
 * finished since this browser last looked or marked unread (solid), and read or never run (hollow).
 */
function stateMark(session, working, marked, unseen = finishedUnseen(session)) {
    const fresh = marked || unseen;

    if (session.waiting) {
        return { shape: "waiting", label: "Waiting for approval" };
    }

    // Pi's request waits for the provider's limit to clear: working, held up, until a time or a try.
    if (session.limited !== undefined) {
        return { shape: "limited", label: "Waiting for a usage limit" };
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
    limited: "limited",
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
    kids,
    folded,
    foldHeld,
    foldTrouble,
    onFold,
    index,
    number,
    needle,
    selected,
    pressing,
    folders,
    onPick,
    onSelect,
    onMenu,
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
    slot,
    need,
    expanded,
    answering,
    glow,
    ownCall,
    onReview,
    onAnswer,
    onDismiss,
    onRead,
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
    const ask = need === "ask" ? session.approval : undefined;
    const names = (session.failedAgents ?? []).map((agent) => agent.name);
    const why =
        need === "ask"
            ? ask && `${ask.tool} · ${ask.subject}`
            : need === "failed"
              ? `Run failed${session.failure ? `: ${session.failure}` : ""}`
              : need === "agents"
                ? failed === 1 && names.length > 0
                    ? `Subagent ${names[0]} failed`
                    : `${failed} subagents failed`
                : undefined;
    // A failed subagent is dealt with by someone who steers; a failed run is only seen, which anyone can do.
    const dismisses =
        need === "failed" ||
        (need === "agents" && steers && (session.failedAgents ?? []).length > 0);
    const limit =
        slot === "working" && session.limited !== undefined
            ? formatWhen(fromServer(session.limited))
            : undefined;
    const tip = [title, ...(why ? [why] : []), ...(folders ? where.reverse() : where)].join(" · ");
    // Archive, pin, and mark-unread show on hover; an archived session only comes back, and only for people who steer.
    const acts = !hovers
        ? 0
        : slot === "needs"
          ? 0
          : slot === "ready"
            ? (steers ? 1 : 0) + 1 + (hoverAction ? 1 : 0)
            : (steers ? 1 : 0) + (session.archived ? 0 : 2) + (hoverAction ? 1 : 0);

    return html`<div
        class=${`session-row ${kids > 0 ? "with-fold" : ""} ${arrival === null ? "" : "arriving"} ${slot === "needs" ? "needs-you" : ""} ${expanded ? "asking" : ""} ${glow ? "glow" : ""} ${open ? "active" : ""} ${selected ? "selected" : ""} ${pressing ? "pressing" : ""} ${moving ? "moving" : ""} ${marked ? "marked-unread" : ""} ${unseen ? "unseen" : ""} ${chips.length > 0 ? "with-chips" : ""} ${["no-acts", "one-act", "", "three-acts", "four-acts"][acts]}`}
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
            onContextMenu=${(event) => onMenu(event, session.id)}
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
                ${
                    session.background > 0 &&
                    html`<span
                        class="session-background"
                        title=${`${session.background} ${session.background === 1 ? "command runs" : "commands run"} in the background`}
                    >
                        <${Icon} name="terminal" size=${10} />${session.background}
                    </span>`
                }
                ${
                    slot !== "needs" &&
                    !fork &&
                    person &&
                    html`<${Avatar} person=${person} size=${18} />`
                }
                ${
                    slot !== "needs" &&
                    session.busy &&
                    !session.waiting &&
                    session.limited === undefined &&
                    !fork &&
                    html`<span class="session-working" title="Working"></span>`
                }
                ${
                    slot === undefined &&
                    session.waiting &&
                    html`<span class="session-needs" title="Waiting for approval">
                        ${steers ? "needs you" : "waiting"}
                    </span>`
                }
                ${
                    slot !== "needs" &&
                    (unread || marked) &&
                    html`<span
                        class="unread-dot"
                        title=${marked ? "Marked unread" : "New chat messages"}
                    ></span>`
                }
                ${
                    limit &&
                    html`<span
                        class="session-limit"
                        data-part="session-limit"
                        title=${`Waiting for a usage limit to clear, at ${limit}`}
                    >
                        <${Icon} name="clock" size=${10} />${limit}
                    </span>`
                }
                ${
                    slot !== "needs" &&
                    !limit &&
                    html`<span class="session-time">${timeAgo(session.updatedAt)}</span>`
                }
                ${
                    number !== undefined &&
                    number < 9 &&
                    html`<kbd class="session-num">${number + 1}</kbd>`
                }
            </span>
        </button>
        ${
            kids > 0 &&
            html`<button
                class=${`session-fold ${folded ? "folded" : ""}`}
                data-part="session-fold"
                aria-expanded=${!folded}
                aria-label=${foldLabel(kids, foldTrouble)}
                title=${
                    foldHeld
                        ? "The open session is among them, so they show"
                        : `${folded ? "Show" : "Hide"} ${kids} linked ${kids === 1 ? "session" : "sessions"}`
                }
                disabled=${foldHeld}
                onClick=${() => onFold(session.id)}
            >
                ${
                    foldTrouble &&
                    html`<span class=${`group-trouble ${foldTrouble}`} aria-hidden="true"></span>`
                }
                <span class="session-fold-pill">
                    ${kids}
                    <${Icon} name="down" size=${10} />
                </span>
            </button>`
        }
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
            need === "ask" &&
            ask &&
            html`<span class="session-quick" data-part="session-quick">
                <button
                    class="quick-pill attn"
                    data-part="session-review"
                    data-review=${session.id}
                    aria-expanded=${expanded}
                    title="See the call, then allow or deny it"
                    onClick=${() => onReview(session.id)}
                >
                    Review
                </button>
            </span>`
        }
        ${
            need !== null &&
            need !== "ask" &&
            dismisses &&
            html`<span class="session-quick" data-part="session-quick">
                <button
                    class="quick-pill icon-only"
                    data-part="session-dismiss"
                    title=${`Dismiss: ${why}`}
                    aria-label=${`Dismiss: ${why}`}
                    onClick=${() => onDismiss(session.id)}
                >
                    <${Icon} name="close" size=${12} />
                </button>
            </span>`
        }
        ${
            hovers &&
            slot !== "needs" &&
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
                slot === "ready" &&
                html`<button
                    class="session-act"
                    data-part="session-read"
                    title="Mark read"
                    aria-label="Mark read"
                    onClick=${() => onRead(session.id)}
                >
                    <${Icon} name="check" size=${14} />
                </button>`
            }
            ${
                slot !== "ready" &&
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
                slot !== "ready" &&
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
        ${
            expanded &&
            ask &&
            html`<${NeedAsk}
                session=${session}
                ask=${ask}
                steers=${steers}
                ownCall=${ownCall}
                answering=${answering}
                onAnswer=${onAnswer}
            />`
        }
    </div>`;
}

/**
 * A command that does not show whole is not allowed from here, and a question from an extension (a form)
 * is declined or opened.
 */
function NeedAsk({ session, ask, steers, ownCall, answering, onAnswer }) {
    const whole = wholeOnTile(ask);
    const ago = timeAgo(fromServer(ask.at));
    const more = ask.count > 1 ? ` · +${ask.count - 1}` : "";
    const tooLong =
        ask.form || whole ? "" : `${ask.reason ? " · " : ""}too long to allow from here`;

    return html`<div class="need-ask" data-part="session-ask">
        <div
            class=${`need-command ${whole ? "" : "long"}`}
            data-part="session-ask-command"
            title=${ask.subject}
        >
            <code>
                <span class="need-tool"><${Icon} name="shield" size=${11} />${ask.tool}</span>
                ${ask.subject}
            </code>
        </div>
        <div class="need-why" data-part="session-ask-reason">${ask.reason}${tooLong}</div>
        <div class="need-foot">
            <span
                class="need-when"
                title=${ask.count > 1 ? `${ask.count - 1} more waiting in this session` : undefined}
            >${ago === "now" ? "just now" : `${ago} ago`}${more}</span>
            ${
                steers &&
                !ask.form &&
                html`<button
                    class="need-button"
                    data-part="session-deny"
                    disabled=${answering}
                    onClick=${() => onAnswer(session.id, ask.id, false)}
                >
                    Deny
                </button>`
            }
            ${
                steers &&
                ask.form &&
                html`<button
                    class="need-button"
                    data-part="session-decline"
                    title="Decline it from here; answer it where it waits"
                    disabled=${answering}
                    onClick=${() => onAnswer(session.id, ask.id, false)}
                >
                    Decline
                </button>`
            }
            ${
                steers && !ask.form && whole && !ownCall
                    ? html`<button
                          class="need-button primary"
                          data-part="session-allow"
                          disabled=${answering}
                          onClick=${() => onAnswer(session.id, ask.id, true)}
                      >
                          Allow
                      </button>`
                    : html`<button
                          class=${`need-button ${steers && !ask.form ? "" : "primary"}`}
                          data-part="session-ask-open"
                          title="See the whole call where it waits"
                          onClick=${() => navigate(ask.conversationId)}
                      >
                          Open
                      </button>`
            }
        </div>
    </div>`;
}

/** A row draws again when what it shows changes. Its place (`index`) counts only as it mounts, for its rise-in. */
const MemoRow = memo(SessionRow, ["index"]);

/**
 * The branch lines a linked row draws, one array for each shape: the forest makes new ones each time, and a memoized
 * row would draw again for an array that only looks the same. There are few shapes (a row is at most a few deep).
 */
const branchShapes = new Map();

function sameBranches(branches) {
    const key = branches.join();
    let shape = branchShapes.get(key);

    if (shape === undefined) {
        shape = Object.freeze([...branches]);
        branchShapes.set(key, shape);
    }

    return shape;
}

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
    const byId = new Map(shown.map((session) => [session.id, session]));
    const first = pinned.map((id) => byId.get(id)).filter(Boolean);

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
    ["priority", "Priority"],
    ["recent", "Recent"],
    ["folders", "Folders"],
    ["archived", "Archived"],
];

const tabOf = (group) =>
    group === "folder" ? "folders" : group === "priority" ? "priority" : "recent";

/**
 * What the full list searched for and how far it was scrolled, kept while the tab lives: on a phone the list goes when a
 * session opens, and back from the session shows it again as it was.
 */
const listKept = { query: "", scroll: 0 };

function AllSessions({ compact = false }) {
    const { sessions, sessionsLoaded, server, pinned } = store.state;
    const canStart = canSteer() && !scoped();
    const [query, setQueryState] = useState(() => (compact ? "" : listKept.query));
    const [tab, setTabState] = useState(() => tabOf(prefs().group));
    const [closed, setClosed] = useState(readClosed);
    const [asking, setAsking] = useState(null);
    const [answered, setAnswered] = useState(() => new Set());
    const [moved, setMoved] = useState(null);
    const [focusReview, setFocusReview] = useState(null);
    const [allNeeds, setAllNeeds] = useState(false);
    const opened = useRef({ id: null, slot: null, asked: false });
    const slotsShown = useRef(new Map());
    const askOrder = useRef([]);
    // Linked sessions folded away (`store.js`), but never above the open session, which always shows.
    const { foldedLinked, conversationId: openId } = store.state;
    const folded = useMemo(() => foldsNow(), [foldedLinked, openId, sessions]);
    // The sessions above the open one: their folds stay open, so their fold buttons do nothing and are off.
    const holdsOpen = useMemo(() => {
        const byId = new Map(sessions.map((session) => [session.id, session]));
        const above = new Set();

        for (
            let at = byId.get(openId)?.linkedFrom?.id;
            at !== undefined && !above.has(at);
            at = byId.get(at)?.linkedFrom?.id
        ) {
            above.add(at);
        }

        return above;
    }, [openId, sessions]);
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

    startSelect.current = {
        select: (id) => {
            anchor.current = id;
            setSelected(new Set([...picked.current, id]));
            setTapSelects(true);
        },
        clear: () => clearSelection(),
        count: () => picked.current.size,
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
            setPrefs({
                group: next === "folders" ? "folder" : next === "priority" ? "priority" : "recent",
            });
        }
    };

    // What changes the list's rows: the sessions and pins, the tab and the search, extensions' filters and words
    // (`extensionsRev`), and the day, which moves sessions between the day groups. Worked out again only when one of
    // them changes, not on every draw.
    const { extensionsRev, unread, peekSeen, chatReads, chatRead } = store.state;
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

        if (tab === "priority" && needle === "") {
            const openId = store.state.conversationId;

            if (opened.current.id !== openId) {
                opened.current = {
                    id: openId,
                    slot: slotsShown.current.get(openId) ?? null,
                    asked: false,
                };
            }

            if (shown.some((session) => session.id === openId && session.waiting)) {
                opened.current.asked = true;
            }

            const { groups, slots } = priorityGroups(
                shown,
                { state: store.state, collabs: collab(), answered },
                opened.current,
            );

            slotsShown.current = slots;
            askOrder.current = groups
                .filter((group) => group.slot === "needs")
                .flatMap((group) => group.rows.map((row) => row.session))
                .filter((session) => session.waiting && session.approval)
                .map((session) => session.id);

            return { shown, kept, groups };
        }

        const forest = sessionForest(shown, { pinned, folders: tab === "folders" });
        const groups = groupsOf(forest.roots, { tab, needle, home, pinned, today }).map((group) => {
            const rows = group.rows.flatMap((root) => forest.rows.get(root.id));

            return {
                ...group,
                total: rows.length,
                rows: needle === "" ? unfolded(rows, folded) : rows,
                // What each folded row hides, for the marks it stands in for.
                hidden: needle === "" ? rows : [],
            };
        });

        return { shown, kept, groups };
    }, [
        sessions,
        pinned,
        tab,
        needle,
        home,
        today,
        extensionsRev,
        folded,
        unread,
        peekSeen,
        chatReads,
        chatRead,
        store.state.conversationId,
        store.state.server,
        answered,
    ]);

    // Folded groups: a group's key is in `closed`; Quiet starts folded, and `!key` there says it was opened.
    const isClosed = (key) =>
        key !== "flat" && (closed.has(key) || (FOLDED_AT_FIRST.has(key) && !closed.has(`!${key}`)));

    visible.current = useMemo(
        () =>
            groups.flatMap((group) =>
                isClosed(group.key)
                    ? []
                    : visibleRows(group, asking, allNeeds).map(({ session }) => session.id),
            ),
        [groups, closed, asking, allNeeds],
    );
    const chosen = useMemo(() => {
        if (selected.size === 0) {
            return [];
        }

        // A row a fold hides is not chosen: an action runs only on rows the person can see were picked.
        const rows = new Set(
            groups.flatMap((group) => group.rows.map(({ session }) => session.id)),
        );

        return shown
            .filter((session) => selected.has(session.id) && rows.has(session.id))
            .map((session) => session.id);
    }, [shown, groups, selected]);
    // Taps select while the bar shows: not for rows selected and then hidden (archived, searched away, or folded).
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

    // Ctrl+click (a Mac's right-click) still selects; Shift+right-click keeps the browser's own menu.
    // A long press already did its own.
    const menu = (event, id) => {
        if (event.shiftKey || event.defaultPrevented) {
            return;
        }

        event.preventDefault();
        const session = sessions.find((each) => each.id === id);

        if (event.ctrlKey || !session || (session.archived && !canSteer())) {
            return;
        }

        pressedIn = startSelect;
        store.set({ sheet: { type: "session", id, at: { x: event.clientX, y: event.clientY } } });
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

    const toggleFold = (id) => toggleFoldedLinked(id);

    const review = (id) => setAsking((now) => (now === id ? null : id));

    const answer = async (id, askId, allow) => {
        const ask = store.state.sessions.find((each) => each.id === id)?.approval;

        // The row answers the call it showed, never another: one answered elsewhere meanwhile is not answered for it.
        if (ask?.id !== askId) {
            notify(
                "info",
                "That call was answered elsewhere. Look at the next one before you answer it.",
            );

            return;
        }

        if (answered.has(ask.id)) {
            return;
        }

        const next = ask.count > 1 ? id : (askOrder.current.find((each) => each !== id) ?? null);
        const settle = (change) =>
            setAnswered((now) => {
                const copy = new Set(now);

                change(copy);

                return copy;
            });

        settle((copy) => copy.add(ask.id));

        if ((await attempt(() => actions.approve(ask.id, allow))) === undefined) {
            settle((copy) => copy.delete(ask.id));

            return;
        }

        notify("info", `${allow ? "Allowed" : "Denied"}: ${truncate(ask.subject, 60)}`);
        setMoved(id);
        setTimeout(() => setMoved((now) => (now === id ? null : now)), 2500);
        setAsking(next);
        setFocusReview(next ?? "list");
    };

    useEffect(() => {
        if (focusReview === null) {
            return;
        }

        const box = list.current;
        const target =
            focusReview === "list"
                ? box?.querySelector("button.session")
                : box?.querySelector(`[data-review="${focusReview}"]`);

        if (target) {
            target.focus();
            setFocusReview(null);

            return;
        }

        // Not drawn yet (the list has not heard of the answer): each draw looks again, and later the list takes the focus,
        // so it never stays on a button that went away.
        const timer = setTimeout(() => {
            (box?.querySelector("button.session") ?? box)?.focus();
            setFocusReview(null);
        }, FOCUS_WAIT_MS);

        return () => clearTimeout(timer);
    }, [focusReview, groups]);

    useEffect(() => {
        const pending = new Set(sessions.map((session) => session.approval?.id).filter(Boolean));

        setAnswered((now) =>
            [...now].every((id) => pending.has(id))
                ? now
                : new Set([...now].filter((id) => pending.has(id))),
        );

        if (
            asking !== null &&
            !sessions.some((session) => session.id === asking && session.approval)
        ) {
            setAsking(null);
        }
    }, [sessions]);

    const dismissOne = (id) => {
        const session = sessions.find((each) => each.id === id);

        if (session) {
            dismissFailures([session]);
        }
    };

    const dismissAll = (rows) => dismissFailures(rows.map((row) => row.session));

    const readOne = (id) => {
        const session = sessions.find((each) => each.id === id);

        if (session) {
            markRead([session], { say: false });
        }
    };

    const toggleGroup = (key) => {
        const next = new Set(closed);

        if (isClosed(key)) {
            next.delete(key);
            next.add(`!${key}`);
        } else {
            next.add(key);
            next.delete(`!${key}`);
        }

        localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
        setClosed(next);
    };

    // Priority's tab changes width with its count, so the marker is measured again when the count changes.
    const needCount = useMemo(
        () => needsYouCount(sessions),
        [sessions, unread, peekSeen, store.state.server],
    );
    const tabBar = useSlide(tabs, "button.on", "x", `${tab}:${needCount}`);
    const count = useMemo(() => sessions.filter((session) => !session.archived).length, [sessions]);
    const filters = sessionFilters();
    const steers = canSteer();
    // Made again only when extensions or this person's steering change: rows keep the same action while they do not.
    const extActions = useMemo(sessionActions, [extensionsRev, steers]);
    const hoverAction = extActions.find((action) => action.iconPath !== null);
    // Rows' handlers that stay the same from draw to draw, so a row draws again only when what it shows changes. They
    // call this draw's `pick` and `select`, which see this draw's selection.
    const handlers = useRef(null);

    handlers.current = { pick, select, menu, toggleFold, review, answer, dismissOne, readOne };
    const [onPick] = useState(() => (event, id) => handlers.current.pick(event, id));
    const [onSelect] = useState(() => (event, id) => handlers.current.select(event, id));
    const [onMenu] = useState(() => (event, id) => handlers.current.menu(event, id));
    const [onFold] = useState(() => (id) => handlers.current.toggleFold(id));
    const [onReview] = useState(() => (id) => handlers.current.review(id));
    const [onAnswer] = useState(
        () => (id, askId, allow) => handlers.current.answer(id, askId, allow),
    );
    const [onDismiss] = useState(() => (id) => handlers.current.dismissOne(id));
    const [onRead] = useState(() => (id) => handlers.current.readOne(id));
    // What every row reads of the store, read once here: rows read none of it themselves (`SessionRow`). Marks, seen
    // marks, and read times come through `isUnread`, `finishedUnseen`, and `sessionUnread`.
    const { conversationId, me, moving } = store.state;
    const collabs = collab();
    // Row buttons that only a hovering pointer shows (`NO_HOVER`): touch screens draw none.
    const hovers = !NO_HOVER.matches;

    const rowOf = ({ session, branches, descendants }, index, group) => {
        const open = session.id === conversationId && !session.archived;
        // Linked sessions fold under the one that started them; a search shows them all, with nothing to fold.
        const kids = needle === "" ? descendants : 0;
        const isFolded = kids > 0 && folded.has(session.id);

        return html`<${MemoRow}
            key=${session.id}
            session=${session}
            branches=${sameBranches(branches)}
            kids=${kids}
            folded=${isFolded}
            foldHeld=${holdsOpen.has(session.id)}
            foldTrouble=${isFolded ? hiddenTrouble(group, session.id) : undefined}
            onFold=${onFold}
            index=${index}
            number=${numbers.get(session.id)}
            needle=${needle}
            selected=${selected.has(session.id)}
            pressing=${pressing === session.id}
            folders=${tab === "folders" && needle === ""}
            onPick=${onPick}
            onSelect=${onSelect}
            onMenu=${onMenu}
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
            slot=${group.slot}
            need=${group.slot === "needs" ? needOf(session) : null}
            expanded=${asking === session.id && group.slot === "needs"}
            answering=${session.approval !== undefined && answered.has(session.approval.id)}
            glow=${moved === session.id && group.slot !== "needs"}
            ownCall=${
                session.approval !== undefined &&
                server?.approvalRule === "others" &&
                me?.role !== "owner" &&
                // Nobody known to have asked is not someone else: the server leaves that one to the owner.
                (session.approval.requestedBy === undefined ||
                    session.approval.requestedBy === me?.id)
            }
            onReview=${onReview}
            onAnswer=${onAnswer}
            onDismiss=${onDismiss}
            onRead=${onRead}
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
                    key=${key}
                    role="tab"
                    data-part="session-tab"
                    data-tab=${key}
                    aria-selected=${tab === key}
                    aria-label=${
                        key === "archived"
                            ? "Archived"
                            : key === "priority" && needCount > 0
                              ? `Priority, ${needCount} ${needCount === 1 ? "needs" : "need"} you`
                              : undefined
                    }
                    title=${key === "archived" ? "Archived" : undefined}
                    class=${tab === key ? "on" : ""}
                    onClick=${() => setTab(key)}
                >
                    ${key === "archived" ? html`<${Icon} name="archive" size=${14} />` : label}
                    ${
                        key === "priority" &&
                        needCount > 0 &&
                        html`<span
                            class="tab-count"
                            data-part="session-tab-count"
                            aria-hidden="true"
                        >
                            ${needCount}
                        </span>`
                    }
                </button>`,
            )}
            <${Slide} box=${tabBar} axis="x" />
        </div>
        <div
            class="session-items"
            ref=${list}
            tabindex="-1"
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
            ${
                sessionsLoaded &&
                tab === "priority" &&
                needle === "" &&
                shown.length > 0 &&
                !groups.some((group) => group.slot === "needs") &&
                html`<div class="priority-clear" data-part="session-clear">
                    <${Icon} name="check" size=${13} />
                    <span>Nothing needs you</span>
                </div>`
            }
            ${groups.map((group) => {
                const folded = isClosed(group.key);
                // Needs you does not fold: what waits there must show.
                const still = group.slot === "needs";
                const foldable = group.key !== "flat" && !still;
                const toggle = still ? undefined : () => foldable && toggleGroup(group.key);
                const rows = visibleRows(group, asking, allNeeds);
                const failedRows =
                    group.slot === "needs"
                        ? group.rows.filter((row) => {
                              const need = needOf(row.session);

                              return (
                                  need === "failed" ||
                                  (need === "agents" &&
                                      steers &&
                                      (row.session.failedAgents ?? []).length > 0)
                              );
                          })
                        : [];
                const action =
                    group.slot === "needs" && failedRows.length > 1
                        ? {
                              label: `Dismiss ${failedRows.length} failed`,
                              run: () => dismissAll(failedRows),
                          }
                        : group.slot === "ready"
                          ? {
                                label: "Mark all read",
                                run: () => markRead(group.rows.map((row) => row.session)),
                            }
                          : undefined;
                // A folded group hides its rows' marks: say when one waits for you or its run failed.
                const trouble = folded
                    ? group.hidden
                          .map((row) => sessionMark(row.session).shape)
                          .find((shape) => shape === "waiting" || shape === "failed")
                    : undefined;

                const head =
                    group.key !== "flat" || needle
                        ? html`<${still ? "div" : "button"}
                              class=${`group-head ${group.slot === "needs" ? "attn" : ""}`}
                              data-part="session-group-head"
                              onClick=${toggle}
                              aria-expanded=${still ? undefined : !folded}
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
                                  ${group.total}
                              </span>
                              ${foldable && html`<${Icon} name="down" size=${11} />`}
                          <//>`
                        : null;

                return html`<section
                    class=${`session-group ${folded ? "closed" : ""}`}
                    data-part="session-group"
                    data-group=${group.slot}
                    key=${`${tab}:${group.key}`}
                >
                    ${
                        action
                            ? html`<div class="group-bar" data-part="session-group-bar">
                                ${head}
                                <button
                                    class="group-action"
                                    data-part="session-group-action"
                                    onClick=${action.run}
                                >
                                    ${action.label}
                                </button>
                            </div>`
                            : head
                    }
                    <div class="group-body" inert=${folded}>
                        <div>
                            ${rows.map((row) => rowOf(row, index++, group))}
                            ${
                                rows.length < group.rows.length &&
                                html`<button
                                    class="more-needs"
                                    data-part="session-more"
                                    onClick=${() => setAllNeeds(true)}
                                >
                                    Show ${group.rows.length - rows.length} more
                                </button>`
                            }
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

/**
 * The store's keys the session list reads as it draws, itself and through what it calls: `prefs()` (`appearance`),
 * `canSteer()`, `scoped()`, and `collab()` (`me`, `server`), `isPinned` and `workspaceOrder` (`pinned`), `isUnread`
 * (`unread`), `sessionUnread` (`conversationId`, `chatRead`, `chatReads`, `me`), `finishedUnseen` and `sessionMark`
 * (`peekSeen`, and `server` for when this browser started), and extensions' chips, words, filters, and actions
 * (`extensionsRev`). The sheet and the launcher it reads only as keys are pressed.
 */
const LIST_KEYS = [
    "sessions",
    "sessionsLoaded",
    "server",
    "me",
    "pinned",
    "unread",
    "moving",
    "conversationId",
    "chatRead",
    "chatReads",
    "peekSeen",
    "appearance",
    "extensionsRev",
    "foldedLinked",
];

/**
 * Drawn again only when what it reads changes (`LIST_KEYS`): not as an answer streams, nor for the chat, people, or
 * the connection. Back to the list and each reconnect change little of it.
 */
export const SessionList = drawnFor(LIST_KEYS, AllSessions);

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
    const more = useScrollMore();
    // One ref for both: the marker's slide reads the element, and the fades follow its scrolling.
    const [ref] = useState(() => (element) => {
        items.current = element;
        more(element);
    });

    return html`<div class="rail-items" ref=${ref} style=${`--tiles:${order.length}`}>
        <${Slide} box=${indicator} />
        ${order.map(
            (session, index) => html`<button
                key=${session.id}
                class=${`ws ${session.id === conversationId ? "active" : ""} ${session.busy ? "busy" : ""} ${session.waiting ? "waiting" : ""} ${session.background > 0 ? "has-background" : ""}`}
                style=${`--i:${index}`}
                title=${`${session.title ?? "New session"}${index < 9 ? ` (Alt+${index + 1})` : ""}`}
                aria-label=${`${session.title ?? "New session"}${session.waiting ? ", needs you" : session.busy ? ", working" : session.background > 0 ? ", running commands in the background" : ""}`}
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
            // Commands Pi runs in the background are at work too, after its answer ended.
            busy: sessions.filter((session) => session.busy || session.background > 0).length,
            agents: subagentTotals(sessions),
        }),
        [sessions],
    );
    const live = agents.working + agents.waiting;
    const failed = failing(agents);
    const { unread, peekSeen, server } = store.state;
    const needs = useMemo(() => needsYouCount(sessions), [sessions, unread, peekSeen, server]);
    const sessionsLabel =
        needs > 0 ? `Sessions, ${needs} ${needs === 1 ? "needs" : "need"} you` : "Sessions";
    const needsBadge =
        needs > 0 && html`<span class="rail-count attn" data-part="rail-needs">${needs}</span>`;
    const keys = APPLE ? "⌘B" : "Ctrl+B";
    const fold = () => setPrefs({ sidebar: folded ? "open" : "rail" });
    const role = me?.role === "owner" ? "owner" : me?.role === "viewer" ? "view only" : "guest";
    // A rail with more buttons than room scrolls as a whole, and fades the edge where more is.
    const more = useScrollMore();

    return html`<nav class="rail" data-part="rail" aria-label="Sessions and tools" ref=${more}>
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
                    aria-label=${sessionsLabel}
                    aria-expanded=${!folded}
                    onClick=${fold}
                >
                    <${Icon} name="chat" size=${19} />
                    ${needsBadge}
                </button>`
                : html`<span
                    class="rail-button on"
                    data-part="rail-button"
                    data-state="open"
                    title="Sessions"
                    aria-current="page"
                >
                    <${Icon} name="chat" size=${19} />
                    ${needsBadge}
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

/**
 * The store's keys the rail reads as it draws, itself and through its buttons: the session list's for its numbered
 * sessions (`RailTiles`), the board, PiP's (`pip`, `pipOpen`), peek tiles' (`appearance`), and extensions' buttons,
 * which show their page or panel as open (`page`, `extPanel`, `extensionsRev`).
 */
const RAIL_KEYS = [
    "sessions",
    "server",
    "me",
    "pinned",
    "unread",
    "peekSeen",
    "conversationId",
    "chatRead",
    "chatReads",
    "appearance",
    "board",
    "pip",
    "pipOpen",
    "page",
    "extPanel",
    "extensionsRev",
    "foldedLinked",
];

/** Drawn again only when what it reads changes (`RAIL_KEYS`): not as an answer streams. */
export const RailNav = drawnFor(RAIL_KEYS, Rail);

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
