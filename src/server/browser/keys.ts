/** Key names and combinations (`Enter`, `Control+A`) as the DevTools protocol's key events. */
import { BrowserError } from "./cdp.ts";

const MODIFIERS: Record<string, number> = {
    alt: 1,
    option: 1,
    control: 2,
    ctrl: 2,
    meta: 4,
    cmd: 4,
    command: 4,
    super: 4,
    shift: 8,
};

/** Keys other than characters: their DOM code, Windows key code, and the text they type. */
export const KEYS: Record<string, [string, number, string?]> = {
    Enter: ["Enter", 13, "\r"],
    Tab: ["Tab", 9],
    Backspace: ["Backspace", 8],
    Delete: ["Delete", 46],
    Escape: ["Escape", 27],
    ArrowLeft: ["ArrowLeft", 37],
    ArrowUp: ["ArrowUp", 38],
    ArrowRight: ["ArrowRight", 39],
    ArrowDown: ["ArrowDown", 40],
    Home: ["Home", 36],
    End: ["End", 35],
    PageUp: ["PageUp", 33],
    PageDown: ["PageDown", 34],
    Insert: ["Insert", 45],
    " ": ["Space", 32, " "],
    Shift: ["ShiftLeft", 16],
    Control: ["ControlLeft", 17],
    Alt: ["AltLeft", 18],
    Meta: ["MetaLeft", 91],
    ...Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
            `F${index + 1}`,
            [`F${index + 1}`, 112 + index] as [string, number],
        ]),
    ),
};
const KEY_NAMES: Record<string, string> = {
    esc: "Escape",
    return: "Enter",
    space: " ",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    del: "Delete",
    pgup: "PageUp",
    pgdn: "PageDown",
    ...Object.fromEntries(Object.keys(KEYS).map((name) => [name.toLowerCase(), name])),
};
/**
 * Editing shortcuts headless Chromium does not act on by itself, as the editor commands they stand for. Not the
 * clipboard's: the browser's clipboard is not the person's, whose pastes arrive as text.
 */
const COMMANDS: Record<string, string> = { a: "selectAll", z: "undo", y: "redo" };

/** `Control+Shift+A` as a key and modifier bits; a key alone is a key. */
export function parseKeys(combo: string): { key: string; modifiers: number } {
    const parts =
        combo === "+"
            ? ["+"]
            : combo.endsWith("++")
              ? [...combo.slice(0, -2).split("+"), "+"]
              : combo.split("+");
    let modifiers = 0;

    for (const part of parts.slice(0, -1)) {
        const bit = MODIFIERS[part.trim().toLowerCase()];

        if (bit === undefined) {
            throw new BrowserError(`Unknown modifier "${part}". Use Control, Shift, Alt, or Meta.`);
        }

        modifiers |= bit;
    }

    const last = parts.at(-1) ?? "";
    const key = last.length === 1 ? last : (KEY_NAMES[last.trim().toLowerCase()] ?? last.trim());

    if (key.length !== 1 && KEYS[key] === undefined) {
        throw new BrowserError(`Unknown key "${last}".`);
    }

    return { key, modifiers };
}

export function keyEvents(
    key: string,
    modifiers: number,
): { down: Record<string, unknown>; up: Record<string, unknown> } {
    const special = KEYS[key];
    let code: string;
    let keyCode: number;
    let text: string | undefined;

    if (special !== undefined) {
        [code, keyCode, text] = special;
    } else {
        const upper = key.toUpperCase();

        code = /^[a-z]$/i.test(key) ? `Key${upper}` : /^\d$/.test(key) ? `Digit${key}` : "";
        keyCode = /^[a-z\d]$/i.test(key) ? upper.charCodeAt(0) : 0;
        text = key;
    }

    // With Control, Alt, or Meta held, a key is a shortcut and types nothing.
    if ((modifiers & 7) !== 0) {
        text = undefined;
    }

    const base = {
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        modifiers,
    };
    const command = (modifiers & 6) !== 0 ? COMMANDS[key.toLowerCase()] : undefined;

    return {
        down: {
            ...base,
            type: text === undefined ? "rawKeyDown" : "keyDown",
            ...(text === undefined ? {} : { text, unmodifiedText: text }),
            ...(command === undefined ? {} : { commands: [command] }),
        },
        up: { ...base, type: "keyUp" },
    };
}
