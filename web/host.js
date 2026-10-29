// A desktop app around Pi Pocket (such as Pi Pocket GUI, an Electron wrapper) gives the page `window.pocketHost`: a
// generic, versioned bridge to what a browser tab cannot do (native notifications, the tray, the window's state). In a
// browser there is none, and every caller does as before. docs/desktop.md describes the bridge.
//
// This module imports nothing, so that `store.js` and the modules that import it can all use it.

/** The bridge version this code speaks. A host of a newer version still offers version 1's calls. */
const VERSION = 1;

const offered = globalThis.pocketHost;

/** The host, or null in a browser. Only the top page gets one: never an artifact's frame. */
export const host =
    typeof offered === "object" &&
    offered !== null &&
    Number.isInteger(offered.apiVersion) &&
    offered.apiVersion >= VERSION &&
    window.top === window
        ? offered
        : null;

const capabilities = new Set(Array.isArray(host?.capabilities) ? host.capabilities : []);

/**
 * Whether the host offers this: "menu" (items for the app's menu), "badge" (a count on its icon), "notify" (native
 * notifications, and their clicks), "visibility" (whether its window shows), "pinned" (the pinned sessions, for its
 * tray), "open" (it asks the page to open a session).
 */
export const hostCan = (capability) => capabilities.has(capability);

/** Call the host, and never let it break the page: a host is another program, of another version. */
export function callHost(name, ...args) {
    if (typeof host?.[name] !== "function") {
        return undefined;
    }

    try {
        return host[name](...args);
    } catch (error) {
        console.warn(`pocketHost.${name} failed`, error);

        return undefined;
    }
}

/** Listeners by event type: "visibility" ({ visible }), "open" ({ url }), "approve" ({ id, allow }). */
const listeners = new Map();

callHost("subscribe", (event) => {
    for (const listener of listeners.get(event?.type) ?? []) {
        try {
            listener(event);
        } catch (error) {
            console.error(error);
        }
    }
});

/** Hear one type of the host's events. Returns the way to stop. */
export function onHost(type, listener) {
    const set = listeners.get(type) ?? new Set();

    listeners.set(type, set);
    set.add(listener);

    return () => set.delete(listener);
}

/**
 * Whether the person can see this page: the tab shows, and so does the host's window. A desktop app keeps its page
 * running at full speed while its window hides in the tray, so the page itself always reads as visible there.
 */
export function pageVisible() {
    if (document.visibilityState !== "visible") {
        return false;
    }

    return !hostCan("visibility") || callHost("visible") !== false;
}

/** Hear the page become visible or hidden, by either measure. */
export function onPageVisibility(listener) {
    document.addEventListener("visibilitychange", listener);
    const stop = onHost("visibility", listener);

    return () => {
        document.removeEventListener("visibilitychange", listener);
        stop();
    };
}
