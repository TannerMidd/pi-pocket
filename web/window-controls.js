// The window's own buttons (close, minimize, zoom) over the page. A desktop app that runs Pi Pocket up to its window's
// top edge, or Pi Pocket installed as an app with its title bar hidden, says where they are through the Window Controls
// Overlay (navigator.windowControlsOverlay). Only what is under them makes room, and only as much as they take: a bar
// there (the conversation's top bar, a panel's, a viewer's) keeps its contents beside them; a window without one (the
// sidebar, an extension's page) starts below them. The rest of the layout keeps its whole height. In a browser tab
// there are none, and nothing changes. docs/desktop.md describes it.
//
// On <html>: data-window-controls, "left", "right", or "none" (set before the app's first paint, so a desktop app can
// tell that the page makes its own room), and --controls-h, how far down the buttons reach. What makes room gets
// data-under-controls, "bar" or "push", and --controls-room: the bar's padding on the buttons' side, or how far the
// window's top moves down.

const overlay = navigator.windowControlsOverlay;
const root = document.documentElement;

/** Bars along a window's top: they keep clear of the buttons sideways, and the window can be dragged by them. */
const BARS =
    ".tabstrip, .topbar, .viewer-head, .lightbox-bar, .board-head, .files-bar, .ext-panel-bar, .browser-bar, .people-head";

/** Without a bar, the window (or the drawer, or the phone's home list) starts below the buttons. */
const PUSHED = ".drawer, .home-list, .layout > .window";

/** How far apart the points are, along the buttons, where the page looks for what is under them. */
const STEP = 8;

/** What makes room now: element → { kind, room }. */
let marked = new Map();

/** A bar's own padding on the buttons' side, from before it made room: it never gets less. */
const ownPadding = new WeakMap();

let drag = null;
let resizes = null;

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

function clear() {
    if (root.dataset.windowControls === "none" && marked.size === 0) {
        return;
    }

    root.dataset.windowControls = "none";
    root.style.removeProperty("--controls-h");
    mark(new Map());
    drag?.remove();
}

/** How much room `element` makes, measured as if it made none. */
function roomOf(element, bar, side, reach, height) {
    const box = element.getBoundingClientRect();
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

function update() {
    const rect = overlay?.visible ? overlay.getTitlebarAreaRect() : null;
    const height = rect === null ? 0 : Math.round(rect.y + rect.height);

    if (rect === null || height <= 0 || rect.width >= innerWidth) {
        clear();

        return;
    }

    // The buttons are where the title bar's area is not: on its left (macOS) or its right (Windows, Linux).
    const left = Math.max(0, Math.round(rect.x));
    const right = Math.max(0, Math.round(innerWidth - rect.x - rect.width));
    const side = left >= right ? "left" : "right";
    const reach = side === "left" ? left : right;

    if (root.dataset.windowControls !== side) {
        root.dataset.windowControls = side;
    }

    if (root.style.getPropertyValue("--controls-h") !== `${height}px`) {
        root.style.setProperty("--controls-h", `${height}px`);
    }

    // Across the buttons and just below them: the topmost things there that make room. A short session tab strip
    // and the bar below it can both meet the buttons. A sheet's scrim or the launcher makes none, so the window under
    // them keeps its room while they show.
    const next = new Map();

    for (let offset = 1; offset < reach + STEP; offset += STEP) {
        const along = Math.min(offset, reach - 1);
        const x = side === "left" ? along : innerWidth - along;

        for (let down = 1; down < height + STEP + 1; down += STEP) {
            for (const element of document.elementsFromPoint(x, Math.min(down, height + 1))) {
                const bar = element.matches(BARS);

                if (bar || element.matches(PUSHED)) {
                    if (!next.has(element)) {
                        next.set(element, {
                            kind: bar ? "bar" : "push",
                            room: roomOf(element, bar, side, reach, height),
                        });
                    }

                    break;
                }
            }
        }
    }

    // A rounded window's edge can be hit above its bar. The bar makes room for the window; do not also push it down.
    const bars = [...next].filter(([, { kind }]) => kind === "bar").map(([element]) => element);

    for (const [element, { kind }] of next) {
        if (kind === "push" && bars.some((bar) => element.contains(bar))) {
            next.delete(element);
        }
    }

    mark(next);

    // To move the window by: the strip beside the buttons, over the windows that start below them.
    let width = reach;

    for (const [element, { kind }] of next) {
        if (kind === "push") {
            const box = element.getBoundingClientRect();

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

let frame = 0;
let timer = 0;

/** Before the next frame: the buttons or the window changed. */
function now() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
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

// Before the app's first paint: a desktop app reads it to know that the page makes room for its buttons itself.
root.dataset.windowControls = overlay?.visible ? "left" : "none";

if (overlay) {
    resizes = new ResizeObserver(now);
    overlay.addEventListener("geometrychange", now);
    addEventListener("resize", now);

    // Windows, viewers, and bars come and go; the sidebar folds, shows, and hides with the width and the person's
    // choices.
    new MutationObserver(now).observe(root, { attributeFilter: ["data-rail", "data-tiling"] });
    new MutationObserver(soon).observe(document.body, {
        childList: true,
        subtree: true,
        attributeFilter: ["class"],
    });

    now();
}
