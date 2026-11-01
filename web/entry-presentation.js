/**
 * How this browser shows an input a module presents. The default is one folded line. Nothing here is stored with the
 * entry, and the model still reads the message in full. The choice lives in this browser, under a `pocket.` key: Pi
 * Pocket does not write `x.` keys.
 */

/** Where this browser keeps each kind's mode. */
export const PRESENTATION_STORAGE_KEY = "pocket.entryPresentation";

/** Kinds this browser remembers. A module registers far fewer: past it, the choice set longest ago is forgotten. */
const MODE_LIMIT = 256;

/** The modes, in the order a person chooses between them. */
export const PRESENTATION_MODES = Object.freeze(["open", "folded", "hidden"]);

/** The last part of `x.<module>.<name>`. */
const PRESENTATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Told when a kind's mode changes: `(kind, mode) => void`. */
const listeners = new Set();

/** Entry ids Find has asked to show, newest last. */
const revealed = new Set();

/** Told when Find asks to show an entry. */
const revealListeners = new Set();

const REVEALED_LIMIT = 200;

/** `label`, or `label · summary`. */
export function presentationLine(label, summary) {
    return typeof summary === "string" && summary !== "" ? `${label} · ${summary}` : label;
}

/**
 * What a row draws. `open` is the message. A folded row is one line, and `opened` shows its text. Hidden is an anchor
 * until Find opens it.
 */
export function presentationDraw(mode, opened = false) {
    if (mode === "open") {
        return "message";
    }

    if (opened) {
        return "text";
    }

    return mode === "hidden" ? "anchor" : "chip";
}

/**
 * Whether a message can go to Pi again: a user message (`pi.user`). An input a module stored as its own kind cannot,
 * even while the module presents it as a message.
 */
export function resendable(entry) {
    return (
        entry?.kind === "user" &&
        (entry.presentation === undefined || entry.presentation.prefixed === true)
    );
}

/** The message to Pi a reply answers in `view`: the newest one before `entryId` that can be sent again. */
export function promptBefore(entryId, view) {
    for (let index = view.order.indexOf(entryId) - 1; index >= 0; index--) {
        const entry = view.entries.get(view.order[index]);

        if (resendable(entry)) {
            return entry;
        }
    }

    return undefined;
}

const isMode = (value) => PRESENTATION_MODES.includes(value);

/** This browser's storage, or undefined where it is blocked: reading `localStorage` itself can throw. */
function browserStorage() {
    try {
        return globalThis.localStorage ?? undefined;
    } catch {
        return undefined;
    }
}

/** Choices this tab could not store (private mode, a full quota): they last until it reloads. */
const unsaved = new Map();

/** The stored choices, by kind: only valid modes. Nothing when storage is blocked or holds something else. */
function readMap(storage) {
    let parsed;

    try {
        parsed = JSON.parse(storage?.getItem(PRESENTATION_STORAGE_KEY) ?? "{}");
    } catch {
        return {};
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
    }

    const modes = {};

    for (const [key, value] of Object.entries(parsed)) {
        if (isMode(value)) {
            modes[key] = value;
        }
    }

    return modes;
}

/** The choice this browser has for `kind`, or undefined when it has none. */
export function storedPresentationMode(kind, storage = browserStorage()) {
    return unsaved.get(kind) ?? readMap(storage)[kind];
}

/** How this browser shows `kind`: `open`, `folded`, or `hidden`. With no choice, it is folded. */
export function presentationMode(kind, storage = browserStorage()) {
    return storedPresentationMode(kind, storage) ?? "folded";
}

function tell(kind, mode) {
    for (const hear of listeners) {
        hear(kind, mode);
    }
}

/** `kind` as `x.<module>.<name>`, checked; with `module`, it must be that module's. */
function checkKind(kind, module) {
    const prefix = module === undefined ? undefined : `x.${module}.`;
    const parts = typeof kind === "string" ? /^x\.([^.]+)\.(.+)$/.exec(kind) : null;

    if (
        parts === null ||
        !PRESENTATION_NAME.test(parts[2]) ||
        (prefix !== undefined && !kind.startsWith(prefix))
    ) {
        throw new Error(`pocket.entryPresentation: kind is ${prefix ?? "x.<module>."}<name>`);
    }
}

/**
 * Store this browser's choice for `kind`. The app's own control on a presented row does this for any module's kind.
 * The same mode again changes nothing. Past {@link MODE_LIMIT} kinds, the choice made longest ago is forgotten. A
 * browser that cannot store still shows the choice in this tab until it reloads.
 */
export function choosePresentationMode(kind, mode, storage = browserStorage()) {
    checkKind(kind);

    if (!isMode(mode)) {
        throw new Error("pocket.entryPresentation: mode is open, folded, or hidden");
    }

    if (storedPresentationMode(kind, storage) === mode) {
        return;
    }

    // Insertion order is the order of choices: the one made now goes last, and the oldest go first.
    const next = Object.fromEntries(
        Object.entries(readMap(storage)).filter(([key]) => key !== kind),
    );
    const keys = Object.keys(next);

    for (const key of keys.slice(0, Math.max(0, keys.length - (MODE_LIMIT - 1)))) {
        delete next[key];
    }

    next[kind] = mode;

    try {
        if (storage === undefined) {
            throw new Error("no storage");
        }

        storage.setItem(PRESENTATION_STORAGE_KEY, JSON.stringify(next));
        unsaved.delete(kind);
    } catch {
        unsaved.set(kind, mode);
    }

    tell(kind, mode);
}

/** The same, for a browser module: `kind` must be its own `x.<module>.<name>`. */
export function setPresentationMode(kind, mode, { storage = browserStorage(), module }) {
    checkKind(kind, module);
    choosePresentationMode(kind, mode, storage);
}

/**
 * This browser's choice for a browser module's own kind, or undefined when it has none: a module sets a mode only
 * when the person has not chosen one.
 */
export function modulePresentationMode(kind, { storage = browserStorage(), module }) {
    checkKind(kind, module);

    return storedPresentationMode(kind, storage);
}

/** Another tab of this browser stored a choice (a `storage` event): this one shows it too. */
export function storageChanged(event, storage = browserStorage()) {
    if (event.key !== PRESENTATION_STORAGE_KEY && event.key !== null) {
        return;
    }

    let before = {};

    try {
        before = readMap({ getItem: () => event.oldValue });
    } catch {
        before = {};
    }

    const after = readMap(storage);

    for (const kind of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[kind] !== after[kind] && !unsaved.has(kind)) {
            tell(kind, after[kind] ?? "folded");
        }
    }
}

if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => storageChanged(event));
}

/** Hear mode changes. Returns how to stop. */
export function onPresentationMode(hear) {
    listeners.add(hear);

    return () => listeners.delete(hear);
}

/** Find asked to show this entry. Hidden rows open; the id stays so a later draw can see it. */
export function noteRevealed(id) {
    if (typeof id !== "number") {
        return;
    }

    revealed.delete(id);
    revealed.add(id);

    if (revealed.size > REVEALED_LIMIT) {
        revealed.delete(revealed.values().next().value);
    }

    for (const hear of revealListeners) {
        hear(id);
    }
}

/** Whether Find has asked to show this entry since the page opened. */
export function wasRevealed(id) {
    return revealed.has(id);
}

/** Hear Find. Returns how to stop. */
export function onRevealed(hear) {
    revealListeners.add(hear);

    return () => revealListeners.delete(hear);
}
