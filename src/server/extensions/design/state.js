// The workspace's state: one small store for the whole tab, made when the module loads. It lives outside the panel's
// component, so going back to the chat on a phone (which closes the panel) and coming again keeps the canvas as it was.

/** No edits to the design system yet (as `emptyHistory` in `system.js`, which loads with the System view). */
const emptyHistory = () => ({ past: [], future: [] });

/** A store: `get()`, `set(patch or fn)`, and `subscribe(listener)`. */
export function createStore(initial) {
    let state = initial;
    const listeners = new Set();

    return {
        get: () => state,
        set(patch) {
            const next = typeof patch === "function" ? patch(state) : patch;

            state = { ...state, ...next };

            for (const listener of [...listeners]) {
                listener(state);
            }
        },
        subscribe(listener) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
    };
}

/** The state of the store, drawn again when it changes. */
export function useStore(pocket, store) {
    const [, draw] = pocket.useState(0);

    pocket.useEffect(() => {
        const stop = store.subscribe(() => draw((count) => count + 1));

        draw((count) => count + 1);

        return stop;
    }, [store]);

    return store.get();
}

const PREFS = "x.design.prefs";
const PICK = "x.design.pick";

const read = (storage, key) => {
    try {
        return JSON.parse(storage.getItem(key) ?? "null");
    } catch {
        return null;
    }
};

const write = (storage, key, value) => {
    try {
        storage.setItem(key, JSON.stringify(value));
    } catch {
        // Private mode or a full store: the choice lasts until the page loads again.
    }
};

/** What a person chose for how the canvas looks: kept in this browser. */
export function loadPrefs() {
    const saved = read(localStorage, PREFS) ?? {};

    return {
        device: ["mobile", "tablet", "desktop", "slide", "custom"].includes(saved.device)
            ? saved.device
            : "auto",
        custom: saved.custom ?? { w: 800, h: 600 },
        zoom:
            ["fit", "width", "auto"].includes(saved.zoom) || typeof saved.zoom === "number"
                ? saved.zoom
                : "auto",
        backdrop: ["auto", "light", "dark"].includes(saved.backdrop) ? saved.backdrop : "auto",
    };
}

/** The size name for `device`: `auto` is the phone's frame in a narrow panel, the tablet's in a middling one, else the desktop's. */
export function resolveDevice(device, width) {
    return device !== "auto"
        ? device
        : width > 0 && width < 700
          ? "mobile"
          : width > 0 && width < 1000
            ? "tablet"
            : "desktop";
}

export function savePrefs(state) {
    write(localStorage, PREFS, {
        // `auto` is not a choice: it is saved as none, so the next load follows the panel again.
        device: state.device === "auto" ? undefined : state.device,
        custom: state.custom,
        zoom: state.zoom,
        backdrop: state.backdrop,
    });
}

/** The design last open in a session, kept for the tab: a reload goes back to it. */
export function loadPick(conversation) {
    const all = read(sessionStorage, PICK) ?? {};

    return all[conversation] ?? null;
}

export function savePick(conversation, pick) {
    const all = read(sessionStorage, PICK) ?? {};

    all[conversation] = pick;
    write(sessionStorage, PICK, all);
}

/** The parts of the state that belong to one session: all of it but how the canvas looks. */
export function sessionState() {
    return {
        /** The session's designs as the server lists them, with their group and kind: `null` until the first answer. */
        listed: null,
        /** The artifact open, and its version (`null` follows the newest). */
        artifact: null,
        version: null,
        /** What fills the canvas: the frame, two versions side by side, or the group's variations. */
        view: "canvas",
        compare: null,
        /** How the page answers a tap: not at all, a comment, or a text edit. */
        mode: "view",
        /** The side panel: `versions`, `comments`, `edits`, `tweaks`, or none. */
        dock: null,
        /** Comments and tweaks by artifact id, as the server has them. */
        notes: {},
        /** A pick not yet saved as a comment: the element and the version it was made on. */
        draft: null,
        /** The comments last put in the message box, by design: the ones "mark them done" is for. */
        sent: {},
        /** Text edits by `artifact@version`, not yet sent. */
        edits: {},
        /** The page's own tweak knobs, and what was set (by artifact id). */
        knobs: [],
        /** The frame (its address) the knobs came from. */
        knobsKey: "",
        tweaks: {},
        deck: null,
        /** The slide the deck was last on (0 first): a page that loads again goes back to it. */
        slide: 0,
        present: false,
        /** A request from outside to open an artifact (the viewer's button, the command): the panel takes it once. */
        wanted: null,
        /** Bumped to load the frame again. */
        reload: 0,
        /** Whether the frame's bridge can inspect, edit, and tweak (it is there when the bridge has `send`). */
        bridge: true,
        ...systemState(),
    };
}

/** The state before anything is chosen. */
export function initialState() {
    return {
        ...loadPrefs(),
        width: 0,
        conversation: null,
        focus: false,
        ...sessionState(),
    };
}

/**
 * The System view's part of the state. `system` is what the server has (`status` idle, loading, ready, or failed), and
 * `history` the person's unsaved edits to it (`system.js`). `previewVars` is what the open design is told to show them.
 */
function systemState() {
    return {
        system: { status: "idle", data: null, legacy: null, error: "" },
        history: emptyHistory(),
        /** The mode the view shows: a mode's name, `both` (side by side), or null for the default one. */
        sysMode: null,
        sysSection: "colors",
        sysOpen: null,
        sysFolded: {},
        /** The long groups the person opened in full, by id. */
        sysAll: {},
        sysQuery: "",
        sysSearch: false,
        /** The alias list that is open: `{ token, mode }`. It is drawn over the whole view, not inside a row. */
        sysPick: null,
        /** On a narrow panel: the view itself, or the open design under it (`system` or `preview`). */
        sysPane: "system",
        /** The last save: `idle`, `saving`, `failed` (with `error` and `problems`), `conflict`, or `saved` (with `note`). */
        save: { status: "idle", error: "", problems: [], note: "" },
        sysWriting: false,
        /** Custom properties the open design shows now: the unsaved edits and the mode in view. */
        previewVars: {},
        /** Page checks, by `artifact@version:mode:size`: `{ status, report, error }`. */
        checks: {},
        /** The options of the next check: null follows the canvas (its color scheme, and the size it shows the page at). */
        checkWith: { mode: null, size: null },
        /** The finding the person tapped (its number in the list): the canvas shows its pin, scrolled into view. */
        checkFocus: null,
        /** How high the findings sheet stands on a phone: the index of `SHEET_SNAPS` in `docks.js`; 0 is a bar, which it starts as. */
        checkSheet: 0,
    };
}
