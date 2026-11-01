// Which sessions the tab strip shows, and each one's state (`session-tabs.js` draws them). No imports, so Node tests it.

/** As many tabs as Alt+1…9 reach. */
export const TAB_MAX = 9;

/**
 * The sessions the strip shows: the first `max` in workspace order, and the open session in the last place when it is
 * further down (or archived: `all` has every session), so the strip always shows where you are. `order` is not changed.
 */
export function tabSessions(order, openId, max = TAB_MAX, all = order) {
    const first = order.slice(0, max);

    if (openId === null || first.some((session) => session.id === openId)) {
        return first;
    }

    // An archived session is not in the order, but you are in it: it takes the place too.
    const open = all.find((session) => session.id === openId);

    return open === undefined ? first : [...first.slice(0, max - 1), open];
}

/** A tab's state for themes (`data-state`) and for its look. */
export function tabState(session, open, unread) {
    if (session.waiting) {
        return "waiting";
    }

    if (session.busy || session.background > 0) {
        return "working";
    }

    return !open && unread ? "unread" : "idle";
}
