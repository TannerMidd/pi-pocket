// Safe mode: a tab opened with `?noext=1` loads no extensions' browser modules (`extension-ui.js`) and no theme
// (`theme.js`), so one that breaks the app can be turned off from it. It holds for as long as the tab stays open.
import { replaceAddress } from "./back.js";

/** Where a tab keeps that it is in safe mode: in its session storage, so reloads and reconnects keep it. */
const SAFE_KEY = "pocket.noext";

/** What `?noext=` turns safe mode off with; any other value (`1`, or none) turns it on. */
const SAFE_OFF = new Set(["0", "false", "off", "no"]);

/**
 * Read `?noext=1` (safe mode on) or `?noext=0` (off) from the address, keep it for the tab, and take it out of the
 * address, so a link copied from here does not pass it on.
 */
function startSafeMode() {
    const query = new URLSearchParams(location.search);
    const asked = query.has("noext")
        ? !SAFE_OFF.has(query.get("noext").trim().toLowerCase())
        : null;
    let on = false;

    try {
        if (asked === true) {
            sessionStorage.setItem(SAFE_KEY, "1");
        } else if (asked === false) {
            sessionStorage.removeItem(SAFE_KEY);
        }

        on = sessionStorage.getItem(SAFE_KEY) === "1";
    } catch {
        // No session storage: safe mode holds for this page only.
        on = asked === true;
    }

    if (query.has("noext")) {
        query.delete("noext");
        const rest = query.toString();

        replaceAddress(`${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
    }

    return on;
}

let safe = startSafeMode();
const listeners = new Set();

/** This tab loads no browser modules of extensions and no theme (it was opened with `?noext=1`). */
export const safeMode = () => safe;

/** Hear when this tab leaves safe mode. */
export function onSafeModeEnd(listener) {
    listeners.add(listener);

    return () => listeners.delete(listener);
}

/** Leave safe mode: the tab loads its browser modules and its theme again. */
export function leaveSafeMode() {
    safe = false;

    try {
        sessionStorage.removeItem(SAFE_KEY);
    } catch {
        // Nothing kept, nothing to take away.
    }

    for (const listener of listeners) {
        listener();
    }
}
