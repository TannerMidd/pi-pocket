// The back stack: what back (a phone's swipe or back button, the browser's) closes, newest first.
//
// Each layer over the conversation (a sheet, the drawer, the launcher, the Files tile or Browser panel where they
// cover the screen, a file opened in the Files tile) is a history entry of its own, so back closes what opened last
// instead of leaving the session. Routes (`/s/12`) are history entries too, written here so that routes and the layers
// above them stay in order. This module knows nothing of the app's state: store.js asks for routes and hears when back
// changes one, and components register their layers with `useBack` (or `addLayer` and `removeLayer`).
//
// Each entry this module writes says how many layers it stands for (`history.state.pocket.layers`), and how many steps
// back the session list's entry is (`back`), when known. The app is the truth and history follows it: a layer closed
// by a tap takes its entry back off; one opened adds an entry. Going back (the person's own) closes the layers above the
// entry it lands on.

import { useEffect, useLayoutEffect, useRef } from "preact/hooks";

/** The open layers, oldest first: `{ close, gone, shown }`. */
const layers = [];
/** How many layers the current history entry stands for. Entries from before this app wrote any count none. */
const depth = () => history.state?.pocket?.layers ?? 0;
/** How long to wait for layers that open and close together (one sheet swapped for another) before writing history. */
const SETTLE_MS = 40;
/** How long a traversal this module asked for may take to arrive; one that cannot happen never does. */
const TRAVERSE_MS = 500;

let routeListener = () => {};

/** Hear when going back or forward changes the route: store.js shows the conversation it names. */
export function onRoute(listener) {
    routeListener = listener;
}

// ─── History, one step at a time ──────────────────────────────────────────────────

/** History's changes, in order: a traversal finishes before the next push, which would otherwise be undone by it. */
let chain = Promise.resolve();

function queue(step) {
    chain = chain.then(step).catch((error) => console.error("back stack:", error));

    return chain;
}

/** The traversal this module asked for: `done` when its popstate arrives. */
let expected = null;

/**
 * Go `delta` entries through history and wait until there. With `follow`, the traversal should stay on the route the
 * app shows, and should it land on another one, the app follows the address.
 */
function traverse(delta, { follow = false } = {}) {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            expected = null;
            resolve();
        };

        const timer = setTimeout(done, TRAVERSE_MS);

        expected = { done, follow };
        history.go(delta);
    });
}

/**
 * Make history match the open layers: add an entry for each new one, or go back past those closed by a tap. New
 * entries wait for the page's first tap or key: Chrome's back button skips entries added before anyone touched it.
 */
async function reconcile() {
    // A layer registered by a render that never showed (it threw, and a boundary caught it) was never open.
    for (const layer of layers.filter((each) => !each.shown)) {
        removeLayer(layer);
    }

    // Bounded: an entry that cannot be reached (history cut short) leaves history as it is rather than looping.
    for (let tries = 0; tries < 4; tries++) {
        const at = depth();

        if (at > layers.length) {
            await traverse(layers.length - at, { follow: true });
        } else {
            if (at < layers.length && !touched()) {
                if (!waitingForTap) {
                    waitingForTap = true;
                    afterFirstTap(() => {
                        waitingForTap = false;
                        settle();
                    });
                }

                return;
            }

            for (let count = at + 1; count <= layers.length; count++) {
                history.pushState(entry(count), "", location.href);
            }

            return;
        }
    }
}

let waitingForTap = false;

/** Someone has tapped or typed on this page (where the browser says; elsewhere, assume so). */
const touched = () => navigator.userActivation?.hasBeenActive ?? true;

/** Run `then` at the page's first tap or key, before what the tap itself does. */
function afterFirstTap(then) {
    const once = () => {
        removeEventListener("click", once, true);
        removeEventListener("keydown", once, true);
        then();
    };

    addEventListener("click", once, true);
    addEventListener("keydown", once, true);
}

/** A layer's entry: its route's, standing for `count` layers. The list goes under the route itself only. */
function entry(count) {
    const { listUnder, ...route } = history.state?.pocket ?? {};

    return { pocket: { ...route, layers: count } };
}

let timer = 0;

function settle() {
    clearTimeout(timer);
    timer = setTimeout(() => queue(reconcile), SETTLE_MS);
}

addEventListener("popstate", (event) => {
    if (expected) {
        const { done, follow } = expected;

        done();

        if (follow && location.pathname !== shown) {
            shown = location.pathname;
            routeListener();
        }

        return;
    }

    // The browser showed back as it does (Safari's swipe slides the page before): what closes goes at once, not again.
    if (event.hasUAVisualTransition) {
        document.documentElement.dataset.backShown = "on";
        setTimeout(() => delete document.documentElement.dataset.backShown, 500);
    }

    // The person went back or forward: the route first, then the layers above the entry it landed on. Forward goes
    // further from the session list; anything else counts as back.
    const back = event.state?.pocket?.back;

    if (location.pathname !== shown) {
        shown = location.pathname;
        heading(
            event.hasUAVisualTransition
                ? "shown"
                : typeof back === "number" && typeof shownBack === "number" && back > shownBack
                  ? "forward"
                  : "back",
        );
    }

    shownBack = back;

    routeListener();
    const at = event.state?.pocket?.layers ?? 0;

    while (layers.length > at) {
        const layer = layers.pop();

        layer.gone = true;
        layer.close();
    }

    // Forward onto layers that are gone: back down to the ones open.
    if (at > layers.length) {
        settle();
    }
});

// ─── Taps that land on what just moved ─────────────────────────────────────────────

/**
 * When something last came or went at a tap: a layer opened or closed, or a route opened, right after a finger (or a
 * mouse button) let go. A second tap that follows quickly (a double tap, an impatient one) would land on whatever slid
 * in under the finger (a tile of the sheet that just rose, a row of the screen that just pushed in, the scrim that
 * closes it) rather than on anything the person saw, so it is let go, focus and all. Only a finger's or a mouse's:
 * keys and scripts are not held back. What moves on its own (a reply that opens a session, a sheet the server closes,
 * Escape) is not at a tap, and holds nothing back.
 */
let movedAt = -Infinity;
let liftedAt = -Infinity;
const SETTLING_MS = 280;
const AT_TAP_MS = 400;

const moved = () => {
    if (performance.now() - liftedAt < AT_TAP_MS) {
        movedAt = performance.now();
    }
};

addEventListener("pointerup", () => (liftedAt = performance.now()), {
    capture: true,
    passive: true,
});

/** A finger's or a mouse's press or click, just after something moved under it. */
const tooSoon = (event) =>
    event.isTrusted && event.detail > 0 && performance.now() - movedAt < SETTLING_MS;

// Held back from the press too: a field that slid in under the finger does not take the focus (and the keyboard).
addEventListener("mousedown", (event) => tooSoon(event) && event.preventDefault(), true);
addEventListener(
    "click",
    (event) => {
        if (tooSoon(event)) {
            event.preventDefault();
            event.stopPropagation();
        }
    },
    true,
);

// ─── Layers ───────────────────────────────────────────────────────────────────────

/**
 * A layer opened: back closes it with `close` until `removeLayer` says it closed some other way. `shown` false waits for
 * the caller to say it showed (`useBack`, once its render is on screen).
 */
export function addLayer(close, { shown = true } = {}) {
    const layer = { close, gone: false, shown };

    layers.push(layer);
    moved();
    settle();

    return layer;
}

/** A layer closed by a tap, a key, or its owner: its history entry goes too. */
export function removeLayer(layer) {
    const at = layers.indexOf(layer);

    layer.gone = true;

    if (at !== -1) {
        layers.splice(at, 1);
        moved();
        settle();
    }
}

/**
 * A layer for as long as `open` is true: back calls `close`, which must make `open` false. Registered while rendering,
 * so a panel and a layer inside it that show together (after a reload) stack in that order, the inner one on top.
 */
export function useBack(open, close) {
    const layer = useRef(null);

    if (layer.current) {
        layer.current.close = close;
    }

    if (open && (layer.current === null || layer.current.gone)) {
        layer.current = addLayer(close, { shown: false });
    }

    useLayoutEffect(() => {
        if (layer.current) {
            layer.current.shown = true;
        }
    });
    useEffect(() => {
        if (!open && layer.current) {
            removeLayer(layer.current);
            layer.current = null;
        }
    });
    useEffect(
        () => () => {
            if (layer.current) {
                removeLayer(layer.current);
            }
        },
        [],
    );
}

/** Back has somewhere to go in the app: a layer to close, or a route opened from the session list's. */
export const canGoBack = () =>
    layers.length > 0 || depth() > 0 || (history.state?.pocket?.back ?? 0) > 0;

/** Back, as the system's back does it: for gestures of the app's own. */
export const goBack = () => history.back();

// ─── Routes ───────────────────────────────────────────────────────────────────────

/** The session list's route. */
const HOME = "/";

/** The route the app shows, ahead of history while layers come off for a new one; how far back the list is from it. */
let shown = location.pathname;
let shownBack = history.state?.pocket?.back;
let routeTimer = 0;

/**
 * Which way the last route change went, for the screen it brings to slide in from that side (style.css): `forward` to
 * a session, `back` to the one before or up to the list. Only while it slides.
 */
function heading(way) {
    document.documentElement.dataset.route = way;
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => delete document.documentElement.dataset.route, 600);
}

/**
 * Show a route: its own entry, after the layers above this one, so back from it comes back here. With `replace`, it
 * takes this route's place instead. The history entry follows the app a moment later while open layers come off.
 */
export function pushRoute(path, { replace = false } = {}) {
    // There already, or on the way (history lags while layers come off): nothing more to write.
    if (path === shown && !replace) {
        return;
    }

    heading(path === HOME ? "back" : "forward");
    moved();
    shown = path;
    queue(async () => {
        if (depth() > 0) {
            await traverse(-depth());
        }

        const here = history.state?.pocket?.back;
        const back =
            path === HOME ? 0 : replace ? here : typeof here === "number" ? here + 1 : undefined;
        const state = { pocket: { layers: 0, back } };

        shownBack = back;

        if (replace) {
            history.replaceState(state, "", path);
        } else {
            history.pushState(state, "", path);
        }
    });
    // Layers still open (a panel that stays) get their entries again, above the new route.
    settle();
}

/**
 * Go up to the session list: back to its entry when it is known, past the sessions opened from it, so back from the
 * list leaves the app as it would from any first page. Otherwise `fallback`, which shows the list some other way.
 */
export function goHome(fallback) {
    const back = history.state?.pocket?.back;

    if (typeof back === "number" && back > 0) {
        history.go(-(back + depth()));
    } else {
        fallback();
    }
}

/**
 * Start: on a fresh page (not a reload, which keeps its entries), mark the entry, and when it opens a conversation
 * straight away (a link, a notification, a home screen icon that remembers) and `home` asks for it, put the session
 * list under it, so back goes there rather than out of the app.
 */
export function startHistory({ home }) {
    const pocket = history.state?.pocket;

    if (pocket && !pocket.listUnder) {
        settle();

        return;
    }

    if (location.pathname === HOME) {
        history.replaceState({ pocket: { layers: 0, back: 0 } }, "", location.href);
    } else if (home) {
        listUnderOnFirstTap();
    } else {
        history.replaceState({ pocket: { layers: 0 } }, "", location.href);
    }

    shownBack = history.state.pocket.back;
    settle();
}

/**
 * Put the session list's entry under this conversation's at the first tap or key, not before: Chrome's back button
 * skips entries a page adds before anyone has touched it. Marked meanwhile, so a reload before then still does it.
 */
function listUnderOnFirstTap() {
    history.replaceState({ pocket: { layers: 0, listUnder: true } }, "", location.href);

    const put = () => {
        // A layer open above it (a notification opened the chat): at a tap once it has closed.
        if (depth() > 0) {
            return;
        }

        removeEventListener("click", put, true);
        removeEventListener("keydown", put, true);

        // Gone to another route already: history stays as it is.
        if (!history.state?.pocket?.listUnder) {
            return;
        }

        const here = location.pathname + location.search + location.hash;

        history.replaceState({ pocket: { layers: 0, back: 0 } }, "", HOME);
        history.pushState({ pocket: { layers: 0, back: 1 } }, "", here);
        shownBack = 1;
    };

    addEventListener("click", put, true);
    addEventListener("keydown", put, true);
}

/** Change the address without a new entry (dropping a query the app has read), keeping what this module wrote. */
export function replaceAddress(path) {
    history.replaceState(history.state, "", path);
}
