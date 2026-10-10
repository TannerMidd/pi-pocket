// The dock: what sits above the message box (who is typing, the queue, and the bars), and how it shares the room
// with the conversation. The bars always show whole. The rest of the dock's share goes to the two parts that scroll,
// the queue and the subagents' list:
//
// - The dock's share is 45% of the room the conversation and the dock have together, so a taller message box, a phone's
//   keyboard, or a short window all leave the conversation the rest.
// - Folded, the queue takes what the bars leave, one row at least.
// - Unfolded, the list takes it, one whole row at least: the queue keeps two rows if it can, else one, else it folds
//   away to how many wait.
// - The count of waiting messages shows whenever the queue does not show them all.
// - When the bars would leave the conversation too little (a short screen with several of them), the plan, goal, and
//   trust bars keep one line each: their words cut short, their buttons whole. Who drives keeps its own, for the people
//   to hand over to. Bars that still need more than the share show whole: the dock grows past it.
// - Only where even that leaves the conversation less than a quarter of the room (a phone on its side with every bar
//   up) does the dock stop there, and scroll: the conversation always keeps a few lines.
//
// CSS cannot measure the bars, so this sets the queue's and the list's heights. It does so after each render, and
// whenever the conversation's height changes (a window resized, a message box that grew).
import { useEffect, useLayoutEffect } from "preact/hooks";

/** The dock's share of the room it and the conversation have together. */
const SHARE = 0.45;
/** Below this share of that room for the conversation, the bars keep one line each. */
const LEAST_CONVERSATION = 0.3;
/** What the conversation keeps whatever the dock holds: this share of the room, up to a few lines. */
const FLOOR = 0.25;

/** An element's height with its margins; nothing for none. */
function outer(element) {
    if (!element) {
        return 0;
    }

    const style = getComputedStyle(element);

    return (
        element.getBoundingClientRect().height +
        parseFloat(style.marginTop) +
        parseFloat(style.marginBottom)
    );
}

const height = (element) => element?.getBoundingClientRect().height ?? 0;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * The room the conversation and the dock have together: their window, less what else is in it (the top bar, peek
 * tiles) and the rest of the message box. Not the two heights added up: a conversation squeezed to nothing would make
 * that too much.
 */
function shared(dock) {
    const wrap = dock.closest(".composer-wrap");
    const pane = wrap?.parentElement;

    if (!pane) {
        return innerHeight * 0.5;
    }

    const style = getComputedStyle(pane);
    let room =
        pane.clientHeight -
        parseFloat(style.paddingTop) -
        parseFloat(style.paddingBottom) -
        (outer(wrap) - height(dock));

    for (const child of pane.children) {
        if (child !== wrap && !child.classList.contains("scroller")) {
            room -= outer(child);
        }
    }

    return Math.max(0, room);
}

/** Share the dock's room: set the queue's and the list's heights, and whether the queue folds and its count shows. */
export function fitDock(dock) {
    if (!dock?.isConnected) {
        return;
    }

    const queue = dock.querySelector(":scope > .inbox");
    const count = dock.querySelector(":scope > .inbox-count");
    const bar = dock.querySelector(":scope > .agents-bar");
    const list = bar?.querySelector(".agents-list");
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const together = shared(dock);

    // What the queue and the list are: their rows' own heights, whatever room they have now. A small button's tap area
    // reaches past its row, and does not count.
    const rows = queue ? [...queue.querySelectorAll(":scope > .queued")] : [];
    const queueAll =
        rows.length === 0
            ? 0
            : rows.at(-1).getBoundingClientRect().bottom - rows[0].getBoundingClientRect().top;
    const row = rows.length === 0 ? 0 : height(rows[0]);
    const gap = queue ? parseFloat(getComputedStyle(queue).rowGap) || 0 : 0;
    const queueMargin = queue ? parseFloat(getComputedStyle(queue).marginBottom) || 0 : 0;
    const countHeight = count ? 1.5 * rem : 0;
    const listAll = list?.scrollHeight ?? 0;
    // One whole row, and the line above the rows.
    const listLeast = list ? Math.min(listAll, height(list.querySelector(".agent-row")) + 1) : 0;
    const least = list
        ? listLeast + (queue ? countHeight : 0)
        : queue
          ? row + queueMargin + (queueAll > row + 1 ? countHeight : 0)
          : 0;

    // Everything that does not give up room: the bars, the typing line, and the subagents bar's own line.
    const fixedNow = () => {
        let sum = 0;

        for (const child of dock.children) {
            if (child !== queue && child !== count) {
                sum += outer(child) - (child === bar && list ? height(list) : 0);
            }
        }

        return sum;
    };

    // Measured with the bars at their whole height and the dock at its own, so the choices hold once they are made. A
    // dock that scrolls stops scrolling while it is measured: where the reader had it is put back after.
    const scrolled = dock.scrollTop;

    delete dock.dataset.compact;
    delete dock.dataset.capped;
    dock.style.maxHeight = "";
    let fixed = fixedNow();

    if (together - fixed - least < together * LEAST_CONVERSATION) {
        dock.dataset.compact = "on";
        fixed = fixedNow();
    }

    const room = together * SHARE - fixed;
    let queueHeight = Math.min(queueAll, row);
    let folded = false;

    if (list) {
        const listMost = Math.min(listAll, innerHeight * 0.4, 22 * rem);
        // The room the queue takes at `size`, with its count when it does not show them all.
        const taken = (size) =>
            queue ? size + queueMargin + (size < queueAll - 1 ? countHeight : 0) : 0;
        let listHeight = Math.min(listMost, room);

        if (queue) {
            const queueMost = Math.min(queueAll, innerHeight * 0.14, 6 * rem);

            queueHeight = clamp(
                room - listMost - queueMargin,
                Math.min(queueAll, 2 * row + gap),
                queueMost,
            );
            listHeight = Math.min(listMost, room - taken(queueHeight));

            if (listHeight < listLeast) {
                queueHeight = Math.min(queueAll, row);
                listHeight = Math.min(listMost, room - taken(queueHeight));
            }

            if (listHeight < listLeast) {
                folded = true;
                listHeight = Math.min(listMost, room - countHeight);
            }
        }

        list.style.maxHeight = `${Math.max(listLeast, listHeight)}px`;
    } else if (queue) {
        // The queue takes what the bars leave: one row at least, a few rows' height at most.
        const most = Math.min(queueAll, innerHeight * 0.28, 12 * rem);

        queueHeight = clamp(room - queueMargin, row, most);

        if (queueHeight < queueAll - 1) {
            queueHeight = clamp(room - queueMargin - countHeight, row, most);
        }
    }

    // Folded, the queue keeps its rows laid out, out of sight: they are measured again next time. One that shows them
    // all is no scroller: the tap areas that reach past its rows stay whole, and make nothing scroll.
    if (queue) {
        const all = !folded && queueHeight >= queueAll - 1;

        queue.style.maxHeight = all ? "none" : `${folded ? 0 : Math.ceil(queueHeight)}px`;
        queue.style.overflowY = all ? "visible" : "auto";
    }

    if (folded) {
        dock.dataset.queue = "folded";
    } else {
        delete dock.dataset.queue;
    }

    if (folded || (queue && queueHeight < queueAll - 1)) {
        dock.dataset.count = "on";
    } else {
        delete dock.dataset.count;
    }

    const floor = Math.min(together * FLOOR, 5 * rem);

    // Where the reader had the dock when the list unfolded: it goes back there when the list folds.
    if (list && dock.dataset.listShown !== "on") {
        dock.dataset.scrolledFrom = String(scrolled);
    }

    if (together - height(dock) < floor) {
        dock.dataset.capped = "on";
        dock.style.maxHeight = `${Math.max(0, together - floor)}px`;
        dock.scrollTop = scrolled;

        // A list just unfolded in a dock that scrolls: bring it into sight, once; then the scrolling is the reader's.
        const below = list
            ? list.getBoundingClientRect().bottom - dock.getBoundingClientRect().bottom
            : 0;

        if (list && dock.dataset.listShown !== "on" && below > 0) {
            dock.scrollTop = scrolled + below;
        }
    }

    if (list) {
        dock.dataset.listShown = "on";
    } else {
        // Folded again: back to where the reader had it, even as the list's going lets the dock fit for a moment.
        if (dock.dataset.scrolledFrom !== undefined) {
            dock.scrollTop = Number(dock.dataset.scrolledFrom);
        }

        delete dock.dataset.listShown;
        delete dock.dataset.scrolledFrom;
    }
}

/** Keep the dock in `ref` fitted: after every render, and when the conversation's height changes. */
export function useDock(ref) {
    useLayoutEffect(() => fitDock(ref.current));
    useEffect(() => {
        const dock = ref.current;
        const scroller = dock
            ?.closest(".composer-wrap")
            ?.parentElement?.querySelector(":scope > .scroller");

        if (!dock || !scroller) {
            return;
        }

        let frame = 0;
        // A frame later: fitting changes the very heights this watches.
        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => fitDock(dock));
        });

        observer.observe(scroller);

        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, []);
}
