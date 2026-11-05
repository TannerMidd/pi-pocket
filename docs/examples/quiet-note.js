// Quiet note's browser module: until a person chooses otherwise, this browser hides the module's notes, so they show
// only through Find or the note's row control. The model still reads each one.
// The app loads it and calls its default export with `pocket` (docs/extensions.md).

/** The version of `pocket` this module was written for: an older app does not load it. */
export const pocketApi = 1;

const NOTE = "x.quiet-note.note";

export default function setup(pocket) {
    // On an older app there is nothing to set: the notes show as the app shows them.
    if (typeof pocket.entryPresentation !== "function") {
        return;
    }

    // `open` is the message, `folded` is one line (the app's default), and `hidden` keeps the turn until Find.
    // Only a browser with no choice yet: a person who picked "Fold" or "Show" on a note keeps what they picked.
    if (pocket.entryPresentation(NOTE) === undefined) {
        pocket.entryPresentation(NOTE, "hidden");
    }
}
