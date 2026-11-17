// Pasting into the Browser panel's screen. Firefox gives a paste to the element it last edited, so the screen never
// hears it: the panel listens on the document instead. No imports, so Node tests it.

/** The text to send to the page for a paste, or null when the paste is not the screen's or holds no text. */
export function screenPaste(event, screen, active) {
    if (!screen || active !== screen) {
        return null;
    }

    const text = event.clipboardData?.getData("text") ?? "";

    return text === "" ? null : text;
}
