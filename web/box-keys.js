// Keys that extensions give the message boxes (`pocket.composerKey`): the session's box and PiP's. What modules added
// comes from `extension-ui.js` (`setBoxKeys`), so the boxes need not import it: no imports, so Node tests it.

const APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

/** The modifiers a key may name, and the event's flag for each. `Mod` is ⌘ on Apple's systems, Ctrl elsewhere. */
const MODIFIERS = {
    ctrl: "ctrlKey",
    control: "ctrlKey",
    alt: "altKey",
    option: "altKey",
    shift: "shiftKey",
    meta: "metaKey",
    cmd: "metaKey",
    command: "metaKey",
};

/** The named keys, by their lowercase name (and a few short ones), as `KeyboardEvent.key` names them. */
const NAMED = Object.fromEntries(
    [
        "Backspace",
        "Delete",
        "Enter",
        "Tab",
        "Escape",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Insert",
        ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
    ].map((name) => [name.toLowerCase(), name]),
);

Object.assign(NAMED, {
    esc: "Escape",
    del: "Delete",
    return: "Enter",
    space: " ",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
});

/**
 * One key as `"Ctrl+W"`, `"Alt+Backspace"`, or `"Mod+Shift+K"`: modifiers, then a character or a named key, joined by
 * `+`. Null when it is not one.
 */
export function parseKey(text, apple = APPLE) {
    if (typeof text !== "string") {
        return null;
    }

    // A last part of "+" itself: "Ctrl++".
    const parts = text.endsWith("++") ? [...text.slice(0, -2).split("+"), "+"] : text.split("+");
    const last = parts.pop().trim();
    const key = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, key: "" };

    for (const part of parts) {
        const name = part.trim().toLowerCase();
        const flag = name === "mod" ? (apple ? "metaKey" : "ctrlKey") : MODIFIERS[name];

        if (flag === undefined || key[flag]) {
            return null;
        }

        key[flag] = true;
    }

    if ([...last].length === 1) {
        key.key = last.toLowerCase();
    } else if (NAMED[last.toLowerCase()] !== undefined) {
        key.key = NAMED[last.toLowerCase()];
    } else {
        return null;
    }

    return key;
}

/** A spec's `keys`, one or a list of up to 8, parsed: null when one is not a key. */
export function parseKeys(keys, apple = APPLE) {
    const list = typeof keys === "string" ? [keys] : keys;

    if (!Array.isArray(list) || list.length === 0 || list.length > 8) {
        return null;
    }

    const parsed = list.map((each) => parseKey(each, apple));

    return parsed.includes(null) ? null : parsed;
}

/**
 * Whether a keydown is this key: the same modifiers, and the same character or named key. A letter or a digit also
 * matches by where it is on the keyboard (`code`) while Alt is down, since Option on a Mac types another character.
 */
export function matchesKey(key, event) {
    if (
        event.ctrlKey !== key.ctrlKey ||
        event.altKey !== key.altKey ||
        event.shiftKey !== key.shiftKey ||
        event.metaKey !== key.metaKey
    ) {
        return false;
    }

    if (key.key.length > 1) {
        return event.key === key.key;
    }

    if (event.key?.toLowerCase() === key.key) {
        return true;
    }

    const code = /^[a-z]$/.test(key.key)
        ? `Key${key.key.toUpperCase()}`
        : /^\d$/.test(key.key)
          ? `Digit${key.key}`
          : null;

    return event.altKey && code !== null && event.code === code;
}

/** A spec's `keys` as the Keyboard shortcuts sheet writes them: "Ctrl W or Alt Backspace". */
export function keysLabel(keys) {
    const list = typeof keys === "string" ? [keys] : keys;

    return list
        .map((each) =>
            (each.endsWith("++") ? [...each.slice(0, -2).split("+"), "+"] : each.split("+"))
                .map((part) => part.trim())
                .map((part) => (part.length === 1 ? part.toUpperCase() : part))
                .join(" "),
        )
        .join(" or ");
}

/** The most text `set` puts into a box. */
const SET_MAX = 1_000_000;

/**
 * What a module's `run` gets: the box's text and selection when the key came, and `set`, which writes new text and
 * puts the caret (or a selection) through the box's own editing, so its draft is kept. `where` is `"session"` or
 * `"pip"`.
 */
export function keyBox(element, where, write) {
    return Object.freeze({
        where,
        text: element.value,
        start: element.selectionStart,
        end: element.selectionEnd,
        set(text, start = text?.length, end = start) {
            if (typeof text !== "string" || text.length > SET_MAX) {
                throw new Error(`box.set: give it text, up to ${SET_MAX} characters`);
            }

            const at = (value) =>
                Math.max(0, Math.min(text.length, Number.isInteger(value) ? value : text.length));
            const from = at(start);

            write(text, from, Math.max(from, at(end)));
        },
    });
}

/** What modules added: `{ keys, label, module, run, failed }` for each, in the order the server lists the modules. */
let source = () => [];

/** Set by `extension-ui.js`, once. */
export function setBoxKeys(list) {
    source = list;
}

/**
 * Give a keydown in a message box to the first module's key that it is. `box` is what the module's `run` gets: the
 * box's text, its selection, and `set`. True when a module took the key: the box then does nothing more with it.
 */
export function boxKey(event, box) {
    if (event.isComposing || event.keyCode === 229) {
        return false;
    }

    for (const each of source()) {
        if (!each.keys.some((key) => matchesKey(key, event))) {
            continue;
        }

        try {
            const result = each.run(box);

            // An async run takes the key: it must say so before the browser acts on it.
            if (result instanceof Promise) {
                result.catch(each.failed);
            }

            return result !== false;
        } catch (error) {
            each.failed(error);

            return false;
        }
    }

    return false;
}

/** The modules' keys, for the Keyboard shortcuts sheet: `[keys, label]` rows. */
export function boxKeyRows() {
    return source().map((each) => [keysLabel(each.keysText), `${each.label} (${each.module})`]);
}
