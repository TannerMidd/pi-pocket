// Which panel each session shows beside its conversation, so going back to a session shows what it showed when it was
// left: an extension's panel (as Design's), the Browser panel, the Files tile on its tab, or the People panel. PiP's
// panel is not a session's: it stays as it is, and its board keeps no layout. `store.js` keeps the layouts (the tab's
// first, then the device's) and shows a session's as it opens. No imports, so Node tests it.

/** How many sessions' layouts a tab, and the device, keep: the ones shown longest ago go first. */
const LAYOUT_MAX = 200;

/** A session that shows no panel: what one never seen before shows. */
export const NO_LAYOUT = Object.freeze({ panel: null, filesTab: "files" });

const PANELS = new Set(["ext", "browser", "files", "people"]);

/**
 * A session's layout, as kept: `{ panel, filesTab }`, and `ext` (`{ module, id }`) for an extension's panel. Anything
 * else (kept by another version, or broken) is null.
 */
export function readLayout(kept) {
    if (typeof kept !== "object" || kept === null) {
        return null;
    }

    const filesTab = kept.filesTab === "changes" ? "changes" : "files";

    if (kept.panel === null) {
        return { panel: null, filesTab };
    }

    if (!PANELS.has(kept.panel)) {
        return null;
    }

    if (kept.panel !== "ext") {
        return { panel: kept.panel, filesTab };
    }

    const { ext } = kept;

    return typeof ext?.module === "string" && typeof ext.id === "string"
        ? { panel: "ext", ext: { module: ext.module, id: ext.id }, filesTab }
        : null;
}

/**
 * The layout the store's state shows. One panel at a time; were more than one asked for, the one `App` draws, in its
 * order: Browser, Files, an extension's, People.
 */
export function layoutOf(state) {
    const { filesTab } = state;

    if (state.browserOpen) {
        return { panel: "browser", filesTab };
    }

    if (state.filesOpen) {
        return { panel: "files", filesTab };
    }

    if (state.extPanel !== null) {
        return { panel: "ext", ext: { ...state.extPanel }, filesTab };
    }

    return { panel: state.peopleOpen ? "people" : null, filesTab };
}

/** What the store's state takes to show `layout`. */
export function layoutPatch({ panel, ext, filesTab }) {
    return {
        extPanel: panel === "ext" ? { ...ext } : null,
        browserOpen: panel === "browser",
        filesOpen: panel === "files",
        peopleOpen: panel === "people",
        filesTab,
    };
}

export const sameLayout = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The layouts kept, as `[id, layout]` pairs (the session shown longest ago first), with `id`'s now the newest. With
 * `keepNone` false, a session that shows no panel is not kept, as one never seen: the device's layouts keep only panels,
 * while a tab's keep "none" too, so that a panel this tab closed stays closed whatever another tab did. At most `max`.
 */
export function remember(pairs, id, layout, { keepNone = true, max = LAYOUT_MAX } = {}) {
    const others = pairs.filter(([each]) => each !== id);
    const next = !keepNone && sameLayout(layout, NO_LAYOUT) ? others : [...others, [id, layout]];

    return next.slice(-max);
}

/** The layout kept for `id` among `pairs`, or null. */
export function keptLayout(pairs, id) {
    const pair = pairs.find(([each]) => each === id);

    return pair === undefined ? null : readLayout(pair[1]);
}

/** Kept pairs as they were read (`JSON.parse` of what a storage holds): anything else counts as none. */
export const layoutPairs = (kept) =>
    Array.isArray(kept)
        ? kept.filter((pair) => Array.isArray(pair) && Number.isInteger(pair[0]))
        : [];

/**
 * The layout the panels kept before layouts were a session's, read from one tab's storage (`get(key)`): one panel for
 * every session. The first session a tab shows after the update takes it.
 */
export function legacyLayout(get) {
    const filesTab = get("pocket.filesTab") === "changes" ? "changes" : "files";
    let ext = null;

    try {
        ext = JSON.parse(get("pocket.extPanel"));
    } catch {
        // Broken: none.
    }

    if (get("pocket.browser") === "1") {
        return { panel: "browser", filesTab };
    }

    if (get("pocket.files") === "1") {
        return { panel: "files", filesTab };
    }

    if (typeof ext?.module === "string" && typeof ext.id === "string") {
        return { panel: "ext", ext: { module: ext.module, id: ext.id }, filesTab };
    }

    return get("pocket.people") === "1" ? { panel: "people", filesTab } : null;
}

/** The keys `legacyLayout` reads, which nothing writes now. */
export const LEGACY_KEYS = [
    "pocket.extPanel",
    "pocket.browser",
    "pocket.files",
    "pocket.filesTab",
    "pocket.people",
];
