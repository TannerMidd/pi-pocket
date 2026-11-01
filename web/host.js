// `window.pocketHost`: the bridge a desktop app gives the page (docs/desktop.md). This module imports nothing, so that
// `store.js` and the modules that import it can all use it.

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

export function onPageVisibility(listener) {
    document.addEventListener("visibilitychange", listener);
    const stop = onHost("visibility", listener);

    return () => {
        document.removeEventListener("visibilitychange", listener);
        stop();
    };
}
