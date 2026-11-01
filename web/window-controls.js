// The window's own buttons (close, minimize, zoom) over the page. A desktop app that runs Pi Pocket up to its window's
// top edge, or Pi Pocket installed as an app with its title bar hidden, says where they are through the Window Controls
// Overlay (navigator.windowControlsOverlay). Only what is under them makes room, and only as much as they take: a bar
// there (the conversation's top bar, a panel's, a viewer's) keeps its contents beside them; a window without one (the
// sidebar, an extension's page) starts below them. The rest of the layout keeps its whole height. Tiled, the window
// whose bar is under them has its corner cut around them, so its border does not run under them. In a browser tab
// there are none, and nothing changes. docs/desktop.md describes it.
//
// On <html>: data-window-controls, "left", "right", or "none" (set before the app's first paint, so a desktop app can
// tell that the page makes its own room), and --controls-h, how far down the buttons reach. What makes room gets
// data-under-controls, "bar" or "push", and --controls-room: the bar's padding on the buttons' side, or how far the
// window's top moves down. The window cut around them gets data-controls-notch, and --notch-w and --notch-h: the cut.
//
// What is under the buttons is read from the layout, before the frame that shows a change: a window, a bar, or a
// panel that opens has its room in its first frame. A window that pops in is measured where it lands, not where its
// animation has it.

const overlay = navigator.windowControlsOverlay;
const root = document.documentElement;

/** Bars along a window's top: they keep clear of the buttons sideways, and the window can be dragged by them. */
const BARS =
    ".tabstrip, .topbar, .viewer-head, .lightbox-bar, .board-head, .files-bar, .ext-panel-bar, .browser-bar, .people-head";

/** Without a bar, the window (or the drawer, or the phone's home list) starts below the buttons. */
const PUSHED = ".drawer, .home-list, .layout > .window";

/** What, added, removed, or changed, can change what is under the buttons. */
const LAYOUT = `${BARS}, .drawer, .home-list, .layout, .window`;

/** How far the cut stays from the buttons, beside them and below them. */
const NOTCH_GAP = 6;

/** What makes room now: element → { kind, room }. */
let marked = new Map();

/** A bar's own padding on the buttons' side, from before it made room: it never gets less. */
const ownPadding = new WeakMap();

/** The tiled window cut around the buttons, and its cut: { element, w, h }, or null. */
let notched = null;

let drag = null;
let resizes = null;
let frame = 0;
let timer = 0;

/**
 * Where `element` is laid out in the window, without transforms: a window that pops in (scaled) or slides in
 * (translated) is where it lands. `getBoundingClientRect` would give where its animation has it in this frame.
 */
function layoutBox(element) {
    let left = 0;
    let top = 0;

    for (let each = element; each !== null; each = each.offsetParent) {
        left += each.offsetLeft + (each === element ? 0 : each.clientLeft);
        top += each.offsetTop + (each === element ? 0 : each.clientTop);
    }

    for (
        let each = element.parentElement;
        each !== null && each !== document.body;
        each = each.parentElement
    ) {
        left -= each.scrollLeft;
        top -= each.scrollTop;
    }

    return {
        left,
        top,
        right: left + element.offsetWidth,
        bottom: top + element.offsetHeight,
        width: element.offsetWidth,
        height: element.offsetHeight,
    };
}

function mark(next) {
    for (const [element] of marked) {
        if (!next.has(element)) {
            element.removeAttribute("data-under-controls");
            element.style.removeProperty("--controls-room");
            resizes?.unobserve(element);
        }
    }

    // Written only when it changes: the page checks often, and each write would lay it out again.
    for (const [element, { kind, room }] of next) {
        const before = marked.get(element);
        const px = Math.max(0, Math.round(room));

        if (before === undefined) {
            resizes?.observe(element);
        }

        if (before?.kind !== kind) {
            element.setAttribute("data-under-controls", kind);
        }

        if (before === undefined || Math.round(before.room) !== px) {
            element.style.setProperty("--controls-room", `${px}px`);
        }
    }

    marked = next;
}

/** Cut `next.element`'s corner (style.css draws it), and no other window's. */
function notch(next) {
    const same = notched !== null && notched.element === next?.element;

    if (notched !== null && !same) {
        notched.element.removeAttribute("data-controls-notch");
        notched.element.style.removeProperty("--notch-w");
        notched.element.style.removeProperty("--notch-h");
    }

    if (next !== null) {
        if (!same) {
            next.element.setAttribute("data-controls-notch", "");
        }

        if (!same || notched.w !== next.w) {
            next.element.style.setProperty("--notch-w", `${next.w}px`);
        }

        if (!same || notched.h !== next.h) {
            next.element.style.setProperty("--notch-h", `${next.h}px`);
        }
    }

    notched = next;
}

function clear() {
    if (root.dataset.windowControls === "none" && marked.size === 0 && notched === null) {
        return;
    }

    root.dataset.windowControls = "none";
    root.style.removeProperty("--controls-h");
    mark(new Map());
    notch(null);
    drag?.remove();
}

/** How much room `element` makes, measured as if it made none. */
function roomOf(element, bar, side, reach, height) {
    const box = layoutBox(element);
    const style = getComputedStyle(element);

    if (bar) {
        if (!marked.has(element)) {
            ownPadding.set(
                element,
                parseFloat(side === "left" ? style.paddingLeft : style.paddingRight) || 0,
            );
        }

        const covered = side === "left" ? reach - box.left : box.right - (innerWidth - reach);

        return Math.max(covered, ownPadding.get(element) ?? 0);
    }

    // Tiled, a window moves down by its margin (the tiles' gap stays above it), else by its padding.
    const moved = marked.get(element)?.kind === "push" ? parseFloat(style.marginTop) || 0 : 0;

    return height - (box.top - moved);
}

/**
 * Tiled, the window that holds `bar` has its border run under the buttons. Its corner is cut around them instead, as
 * wide and as deep as they reach into it, and a little more; never more than half the window. Without tiling there is
 * no border to cut.
 */
function notchOf(bar, side, reach, height) {
    const window = root.dataset.tiling === "on" ? bar.closest(".layout > .window") : null;

    if (window === null) {
        return null;
    }

    const box = layoutBox(window);
    const w = Math.round(
        (side === "left" ? reach - box.left : box.right - (innerWidth - reach)) + NOTCH_GAP,
    );
    const h = Math.round(height - box.top + NOTCH_GAP);

    return w > NOTCH_GAP && h > NOTCH_GAP && w < box.width / 2 && h < box.height / 2
        ? { element: window, w, h }
        : null;
}

/** Where the buttons are: { side, reach, height }, or null when there are none over the page. */
function controls() {
    const rect = overlay?.visible ? overlay.getTitlebarAreaRect() : null;
    const height = rect === null ? 0 : Math.round(rect.y + rect.height);

    if (rect === null || height <= 0 || rect.width >= innerWidth) {
        return null;
    }

    // The buttons are where the title bar's area is not: on its left (macOS) or its right (Windows, Linux).
    const left = Math.max(0, Math.round(rect.x));
    const right = Math.max(0, Math.round(innerWidth - rect.x - rect.width));
    const side = left >= right ? "left" : "right";

    return { side, reach: side === "left" ? left : right, height };
}

function update() {
    cancelAnimationFrame(frame);
    frame = 0;

    const found = controls();

    if (found === null) {
        clear();

        return;
    }

    const { side, reach, height } = found;

    if (root.dataset.windowControls !== side) {
        root.dataset.windowControls = side;
    }

    if (root.style.getPropertyValue("--controls-h") !== `${height}px`) {
        root.style.setProperty("--controls-h", `${height}px`);
    }

    // Everything shown that reaches under the buttons and makes room, in the order of the page. What floats over the
    // app (a sheet's scrim, the launcher) makes none, so the window under it keeps its room while it shows.
    const next = new Map();

    for (const element of document.querySelectorAll(`${BARS}, ${PUSHED}`)) {
        if (!element.checkVisibility({ visibilityProperty: true })) {
            continue;
        }

        const box = layoutBox(element);
        const under =
            box.width > 0 &&
            box.height > 0 &&
            box.bottom > 0 &&
            box.top <= height + 1 &&
            (side === "left"
                ? box.left < reach && box.right > 0
                : box.right > innerWidth - reach && box.left < innerWidth);

        if (under) {
            const bar = element.matches(BARS);

            next.set(element, {
                kind: bar ? "bar" : "push",
                room: roomOf(element, bar, side, reach, height),
            });
        }
    }

    // A window with a bar (or the phone's home list) under the buttons makes room there; it does not also move down.
    for (const [element, { kind }] of next) {
        if (
            kind === "push" &&
            [...next.keys()].some((other) => other !== element && element.contains(other))
        ) {
            next.delete(element);
        }
    }

    mark(next);

    // The topmost tiled window with a bar under the buttons: the last in the page, as the page stacks them.
    let cut = null;

    for (const [element, { kind }] of next) {
        cut = (kind === "bar" && notchOf(element, side, reach, height)) || cut;
    }

    notch(cut);

    // To move the window by: the strip beside the buttons, over the windows that start below them.
    let width = reach;

    for (const [element, { kind }] of next) {
        if (kind === "push") {
            const box = layoutBox(element);

            width = Math.max(width, side === "left" ? box.right : innerWidth - box.left);
        }
    }

    if (drag === null) {
        drag = document.createElement("div");
        drag.className = "window-drag";
        drag.setAttribute("aria-hidden", "true");
    }

    if (drag.style.getPropertyValue("--drag-w") !== `${Math.round(width)}px`) {
        drag.style.setProperty("--drag-w", `${Math.round(width)}px`);
    }

    // First in the body: what comes later (a sheet, the launcher, a viewer) takes clicks over it, as a desktop app
    // reads its page's drag regions in order.
    if (!drag.isConnected) {
        document.body.prepend(drag);
    }
}

/** Before the next frame: something changed that the page sees only then (the buttons, a bar's size). */
function now() {
    if (frame === 0) {
        frame = requestAnimationFrame(update);
    }
}

/** A little later, at most every 100 ms: the page changed, which it does with every word of a streamed reply. */
function soon() {
    if (timer === 0) {
        timer = setTimeout(() => {
            timer = 0;
            now();
        }, 100);
    }
}

/** Whether these changes in the page can change what is under the buttons: a window, a bar, or the layout's state. */
function moves(records) {
    const layout = (node) =>
        node.nodeType === Node.ELEMENT_NODE &&
        node !== drag &&
        (node.matches(LAYOUT) || node.querySelector(LAYOUT) !== null);

    return records.some((record) =>
        record.type === "attributes"
            ? layout(record.target)
            : [...record.addedNodes, ...record.removedNodes].some(layout),
    );
}

// Before the app's first paint, on the buttons' side: a desktop app reads it to know that the page makes room for its
// buttons itself.
root.dataset.windowControls = controls()?.side ?? "none";

if (overlay) {
    // A bar or window that makes room changed size (the theme's spacing, a font): seen after the frame's layout.
    resizes = new ResizeObserver(now);
    overlay.addEventListener("geometrychange", update);
    addEventListener("resize", update);

    // Windows, viewers, and bars come and go; the sidebar folds, shows, and hides with the width and the person's
    // choices. A mutation is seen before the frame that shows it, so those make room at once. The rest (a streamed
    // reply's words) is checked a little later.
    new MutationObserver(update).observe(root, { attributeFilter: ["data-rail", "data-tiling"] });
    new MutationObserver((records) => (moves(records) ? update() : soon())).observe(document.body, {
        childList: true,
        subtree: true,
        attributeFilter: ["class"],
    });

    update();
}
