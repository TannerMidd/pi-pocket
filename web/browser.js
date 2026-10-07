// The Browser panel's state, for everything that opens it: whether it is open, and opening an address in it. The
// panel itself is browser-panel.js.

import { api, attempt, closePeople, notify, store } from "./store.js";

const OPEN_KEY = "pocket.browser";

/** The browser is on while its extension is: the owner turns it off in Extensions. */
export const browserAvailable = () =>
    store.state.server?.extensions?.includes("pocket-browser") === true;

/**
 * Show or hide the panel. Kept per tab, so a reload after a live edit keeps it open. It takes the People panel's and
 * the Files tile's place.
 */
export function setBrowserOpen(open) {
    if (open) {
        sessionStorage.setItem(OPEN_KEY, "1");
        sessionStorage.removeItem("pocket.files");
        closePeople();
    } else {
        sessionStorage.removeItem(OPEN_KEY);
    }

    // One panel beside the conversation at a time: the browser takes the Files tile's place too.
    store.set({ browserOpen: open, drawer: false, ...(open ? { filesOpen: false } : {}) });
}

export const toggleBrowser = () => setBrowserOpen(!store.state.browserOpen);

export const browserApi = (action, body) =>
    api(`c/${store.state.conversationId}/browser/${action}`, body);

/** Open the panel, and an address in it. */
export function openInBrowser(url) {
    setBrowserOpen(true);

    if (url) {
        return attempt(() => browserApi("navigate", { url }).then(reportNavigation));
    }

    return undefined;
}

export function reportNavigation(result) {
    if (result?.error) {
        notify(
            "error",
            /CONNECTION_REFUSED/.test(result.error)
                ? `Nothing answers at that address (${result.error}). Is the server running?`
                : `Could not open it: ${result.error}`,
        );
    }
}

/** The address as the address bar shows it: without http:// and a lone trailing slash. */
export function displayUrl(url) {
    if (!url || url === "about:blank") {
        return "";
    }

    return url.replace(/^https?:\/\//, "").replace(/^([^/?#]+)\/$/, "$1");
}
