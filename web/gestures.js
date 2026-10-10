// Touch gestures for phones, for one hand. A sheet follows a finger dragging it down and closes when let go far or fast
// enough, as the drawer does dragged to the left. On the conversation, a swipe right goes back and a swipe left opens
// the Files tile; a swipe up from the message box opens the places. On an iPhone's home screen app, which has no back
// gesture of its own, a swipe in from the left edge goes back (back.js). Each swipe shows a mark that follows the finger.

import { useEffect, useRef } from "preact/hooks";
import { canGoBack, goBack } from "./back.js";

/** How far a finger moves before a drag takes it, or leaves it to scrolling. */
const SLOP = 8;
/** A drag closes what it drags past this share of its size, or flicked faster than this (px per ms). */
const CLOSE_SHARE = 0.28;
const CLOSE_SPEED = 0.45;
/** How long a spring back takes. */
const SPRING_MS = 260;

/**
 * The finger a gesture follows, among a touch event's: by its identifier, so another finger on the glass (a thumb
 * resting, a second one coming down) neither moves nor ends it.
 */
const fingerOf = (list, id) => [...list].find((touch) => touch.identifier === id);

/** Something scrolled away from its top, from `target` up to `root`: dragging down there scrolls it back first. */
function scrolledDown(target, root) {
    for (let node = target; node && node !== root.parentElement; node = node.parentElement) {
        if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) {
            return true;
        }
    }

    return false;
}

/** Fields and sliders keep their own drags. */
const ownDrag = (target) => target.closest?.("input, textarea, select, [contenteditable]") !== null;

/** Where a finger was when: the last few, for how fast it moved as it let go. */
function speedOf(samples) {
    const last = samples.at(-1);
    const first = samples.find((each) => last.time - each.time < 100) ?? samples[0];
    const time = last.time - first.time;

    return time > 0 ? (last.offset - first.offset) / time : 0;
}

/**
 * Drag `ref`'s element to close it: `"down"` for a sheet from the bottom edge, `"left"` for the drawer. It follows the
 * finger and dims the scrim behind it (its parent) as it goes. Let go far or fast enough, it calls `onClose` and stays
 * where the finger left it, for its closing animation to go on from there; otherwise it springs back. Only on touch.
 */
export function useDragToClose(ref, { dir, onClose, enabled = true }) {
    const close = useRef(onClose);

    close.current = onClose;
    useEffect(() => {
        const element = ref.current;

        if (!element || !enabled) {
            return undefined;
        }

        const down = dir === "down";
        const scrim = element.parentElement;
        let start = null;
        let dragging = false;
        let samples = [];

        const size = () => (down ? element.offsetHeight : element.offsetWidth) || 1;

        const place = (offset) => {
            element.style.transform = down ? `translateY(${offset}px)` : `translateX(${-offset}px)`;
            scrim.style.opacity = String(1 - Math.min(1, offset / size()) * 0.8);
        };

        const springBack = () => {
            element.style.transition = `transform ${SPRING_MS}ms var(--ease-out)`;
            scrim.style.transition = `opacity ${SPRING_MS}ms var(--ease-out)`;
            element.style.transform = "";
            scrim.style.opacity = "";
            setTimeout(() => {
                element.style.transition = "";
                scrim.style.transition = "";
            }, SPRING_MS);
        };

        const onStart = (event) => {
            const target = event.target;

            // A second finger comes down mid-drag: the drag lets go, as a pinch or a slip is not a close.
            if (dragging) {
                springBack();
            }

            start =
                event.touches.length === 1 &&
                !ownDrag(target) &&
                !(down && scrolledDown(target, element))
                    ? {
                          x: event.touches[0].clientX,
                          y: event.touches[0].clientY,
                          id: event.touches[0].identifier,
                      }
                    : null;
            dragging = false;
            samples = [];
        };

        const onMove = (event) => {
            const touch = start && fingerOf(event.touches, start.id);

            if (!touch) {
                return;
            }

            const offset = down ? touch.clientY - start.y : start.x - touch.clientX;
            const across = Math.abs(down ? touch.clientX - start.x : touch.clientY - start.y);

            if (!dragging) {
                if (Math.max(Math.abs(offset), across) < SLOP) {
                    return;
                }

                // The other way, or more across than along: a scroll, not this drag.
                if (offset <= 0 || across > offset) {
                    start = null;

                    return;
                }

                dragging = true;
                element.style.transition = "none";
                scrim.style.transition = "none";
            }

            event.preventDefault();
            const at = Math.max(0, offset - SLOP);

            samples.push({ offset: at, time: event.timeStamp });
            samples = samples.slice(-6);
            place(at);
        };

        const onEnd = (event) => {
            if (!start || !fingerOf(event.changedTouches, start.id)) {
                return;
            }

            if (!dragging) {
                start = null;

                return;
            }

            const at = samples.at(-1)?.offset ?? 0;
            const speed = speedOf(samples);

            start = null;
            dragging = false;

            if (at > size() * CLOSE_SHARE || (speed > CLOSE_SPEED && at > SLOP)) {
                close.current();
                // Still here after its closing animation would have ended: it did not close after all.
                setTimeout(() => element.isConnected && springBack(), 600);
            } else {
                springBack();
            }
        };

        const onCancel = (event) => {
            if (!start || !fingerOf(event.changedTouches, start.id)) {
                return;
            }

            if (dragging) {
                springBack();
            }

            start = null;
            dragging = false;
        };

        element.addEventListener("touchstart", onStart, { passive: true });
        element.addEventListener("touchmove", onMove, { passive: false });
        element.addEventListener("touchend", onEnd);
        element.addEventListener("touchcancel", onCancel);

        return () => {
            element.removeEventListener("touchstart", onStart);
            element.removeEventListener("touchmove", onMove);
            element.removeEventListener("touchend", onEnd);
            element.removeEventListener("touchcancel", onCancel);

            // Let go mid-drag (the element swapped, the drag turned off): it does not stay where the finger left it.
            if (dragging) {
                element.style.transform = "";
                element.style.transition = "";
                scrim.style.opacity = "";
                scrim.style.transition = "";
            }
        };
    }, [ref.current, dir, enabled]);
}

// ─── Marks that follow a swipe ────────────────────────────────────────────────────

const BACK_PATH = "M15 18l-6-6 6-6";

let mark = null;

/**
 * The mark a swipe shows, coming in from `side` as the finger goes (`offset`), lit once letting go would act: an icon
 * (an SVG path) and an optional label, at height `y`.
 */
function showMark({ side, y, offset, armed, path = BACK_PATH, label = "" }) {
    if (!mark) {
        mark = document.createElement("div");
        mark.className = "swipe-mark";
        mark.setAttribute("aria-hidden", "true");
        document.body.append(mark);
    }

    const key = `${side}|${path}|${label}`;

    if (mark.dataset.key !== key) {
        mark.dataset.key = key;
        mark.dataset.side = side;
        mark.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;

        if (label) {
            mark.append(label);
        }
    }

    const width = mark.offsetWidth;
    const shift = Math.min(offset * 0.75, width + 16);

    mark.classList.remove("going");
    mark.classList.toggle("armed", armed);
    mark.style.top = `${Math.round(y) - 22}px`;
    mark.style.transform = `translateX(${side === "left" ? shift - width : width - shift}px)`;
    mark.style.opacity = String(Math.min(1, offset / 40));
}

function hideMark() {
    if (mark) {
        const width = mark.offsetWidth + 8;

        mark.classList.add("going");
        mark.style.transform = `translateX(${mark.dataset.side === "left" ? -width : width}px)`;
        mark.style.opacity = "0";
    }
}

// ─── Back from the left edge ──────────────────────────────────────────────────────

/** How near the left edge a swipe back starts, and how far it goes before letting go goes back. */
const EDGE = 22;
const ARM = 72;

/** An iPhone or iPad home screen app: no browser around it, and no back gesture of the system's. */
const edgeBackWanted = () => navigator.standalone === true;

/**
 * Swipe in from the left edge to go back, where nothing else does it. Passive, as the conversation's swipes are: the
 * page has nothing to scroll sideways there, and scrolling never waits on it.
 */
export function startEdgeBack() {
    if (!edgeBackWanted()) {
        return;
    }

    let start = null;
    let dragging = false;
    let offset = 0;

    document.addEventListener(
        "touchstart",
        (event) => {
            const touch = event.touches[0];

            if (dragging) {
                hideMark();
            }

            start =
                event.touches.length === 1 && touch.clientX <= EDGE && canGoBack()
                    ? { x: touch.clientX, y: touch.clientY, id: touch.identifier }
                    : null;
            dragging = false;
            offset = 0;
        },
        { passive: true, capture: true },
    );
    document.addEventListener(
        "touchmove",
        (event) => {
            const touch = start && fingerOf(event.touches, start.id);

            if (!touch) {
                return;
            }

            const across = Math.abs(touch.clientY - start.y);

            offset = touch.clientX - start.x;

            if (!dragging) {
                if (Math.max(Math.abs(offset), across) < SLOP) {
                    return;
                }

                if (offset <= 0 || across > offset) {
                    start = null;

                    return;
                }

                dragging = true;
            }

            showMark({ side: "left", y: touch.clientY, offset, armed: offset >= ARM });
        },
        { passive: true, capture: true },
    );

    const end = (event, going) => {
        if (!start || !fingerOf(event.changedTouches, start.id)) {
            return;
        }

        if (dragging && going && offset >= ARM) {
            goBack();
        }

        if (dragging) {
            hideMark();
        }

        start = null;
        dragging = false;
    };

    document.addEventListener("touchend", (event) => end(event, true), { capture: true });
    document.addEventListener("touchcancel", (event) => end(event, false), { capture: true });
}

// ─── Swipes on the conversation ───────────────────────────────────────────────────

/** Where the conversation's swipes work: below the sidebar's width, where the top bar is a stretch for a thumb. */
const NARROW = matchMedia("(max-width: 959px)");
/** Swipes start this far from the screen's sides, which belong to the system's back gesture (and `startEdgeBack`). */
const SIDES = 24;
/** How far up from the message box a swipe goes before it opens what it opens. */
const UP = 44;
/** How far a sideways swipe may drift up or down before it counts as scrolling after all. */
const DRIFT = 56;

/** Something between `target` and `root` scrolls sideways (a wide code block, a table): a swipe there scrolls it. */
function scrollsSideways(target, root) {
    for (let node = target; node && node !== root; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 1) {
            const overflow = getComputedStyle(node).overflowX;

            if (overflow === "auto" || overflow === "scroll") {
                return true;
            }
        }
    }

    return false;
}

/**
 * One-handed swipes on a phone, with passive listeners so scrolling never waits on them. On the conversation, sideways:
 * right goes back, left opens a place (the Files tile), each with a mark that follows the finger and lights when
 * letting go would act; the conversation leans a little the same way. In the Files tile, right goes back too. Up from
 * the message box (not its text, nor the queue and bars above it) opens the places; on the subagents board, right goes
 * back. `swipes(where)` says, when a touch starts on `"conversation"`, `"files"`, or `"board"`, what each does now:
 * `{ right, left }` as `{ path, label, run }`, and `up` as a function, or none.
 */
export function startSwipes(swipes) {
    let swipe = null;

    const lean = (offset) => {
        if (swipe?.root) {
            swipe.root.style.transition =
                offset === 0 ? `transform ${SPRING_MS}ms var(--ease-out)` : "none";
            swipe.root.style.transform =
                offset === 0 ? "" : `translateX(${Math.max(-28, Math.min(28, offset * 0.18))}px)`;
        }
    };

    const stop = (act) => {
        if (swipe?.dir === "left" || swipe?.dir === "right") {
            hideMark();
            lean(0);

            if (act && swipe.armed) {
                swipe.acts[swipe.dir].run();
            }
        }

        swipe = null;
    };

    document.addEventListener(
        "touchstart",
        (event) => {
            // A second finger coming down lets go of a swipe under way.
            stop(false);

            if (event.touches.length !== 1 || !NARROW.matches) {
                return;
            }

            const target = event.target;
            const touch = event.touches[0];

            if (target.closest?.("input, textarea, select, [contenteditable], .commands")) {
                return;
            }

            const root = target.closest?.(
                ".pane > .scroller, .files-tile:not(.leaving), .board.phone",
            );
            const acts = swipes(
                root?.classList.contains("files-tile")
                    ? "files"
                    : root?.classList.contains("board")
                      ? "board"
                      : "conversation",
            );
            const at = {
                x: touch.clientX,
                y: touch.clientY,
                id: touch.identifier,
                acts,
                dir: null,
                armed: false,
            };

            if (
                root &&
                touch.clientX > SIDES &&
                touch.clientX < innerWidth - SIDES &&
                (acts.left || acts.right) &&
                !scrollsSideways(target, root) &&
                !getSelection()?.toString()
            ) {
                swipe = { ...at, root };
            } else if (
                acts.up &&
                target.closest?.(".composer-wrap") &&
                // Above the box, the queue and the subagents list scroll: a finger there scrolls them.
                !target.closest(".dock")
            ) {
                swipe = { ...at, root: null, up: true };
            }
        },
        { passive: true },
    );
    document.addEventListener(
        "touchmove",
        (event) => {
            const touch = swipe && fingerOf(event.touches, swipe.id);

            if (!touch) {
                return;
            }

            const dx = touch.clientX - swipe.x;
            const dy = touch.clientY - swipe.y;

            if (!swipe.dir) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP) {
                    return;
                }

                const dir = swipe.up
                    ? dy < 0 && -dy > Math.abs(dx)
                        ? "up"
                        : null
                    : Math.abs(dx) > Math.abs(dy) * 1.5
                      ? dx < 0
                          ? "left"
                          : "right"
                      : null;

                if (dir === null || (dir !== "up" && !swipe.acts[dir])) {
                    swipe = null;

                    return;
                }

                swipe.dir = dir;
            }

            if (swipe.dir === "up") {
                if (-dy >= UP) {
                    const open = swipe.acts.up;

                    swipe = null;
                    open();
                }

                return;
            }

            // Drifted into a scroll after all.
            if (Math.abs(dy) > DRIFT) {
                stop(false);

                return;
            }

            const offset = Math.max(0, swipe.dir === "left" ? -dx : dx);
            const act = swipe.acts[swipe.dir];

            swipe.armed = offset >= ARM;
            showMark({
                side: swipe.dir === "left" ? "right" : "left",
                y: swipe.y,
                offset,
                armed: swipe.armed,
                path: act.path,
                label: act.label,
            });
            lean(dx);
        },
        { passive: true },
    );

    const ended = (event, act) => {
        if (swipe && fingerOf(event.changedTouches, swipe.id)) {
            stop(act);
        }
    };

    document.addEventListener("touchend", (event) => ended(event, true));
    document.addEventListener("touchcancel", (event) => ended(event, false));
}
