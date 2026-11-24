// The app's one way to read its own text in a language: English in web/locales/en.js, and each language that a module
// declares with `web.uiLocales` over it, key by key. The server and the browser import this file, so a label reads the
// same on a sign-in page as in the app. Nothing here reads the page, the store, or the server: it is pure.

/** A placeholder in a message: a name in braces, as in `Saved {count} messages.` Nothing else is replaced. */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** The placeholder names in `text`, in order, each as often as it comes. */
export function placeholders(text) {
    return [...text.matchAll(PLACEHOLDER)].map((found) => found[1]);
}

/**
 * `text`, with each placeholder that `values` names replaced by its value as it is written. A placeholder that `values`
 * does not name stays as it is. A value is inserted as text: it is not read as a pattern, as an expression, or as
 * markup, and the answer still goes through the escaping of the place that shows it.
 */
export function format(text, values) {
    const all = values ?? {};

    return text.replace(PLACEHOLDER, (marker, name) =>
        Object.hasOwn(all, name) ? String(all[name]) : marker,
    );
}

/**
 * The words for `key`: those of `messages` when it has them, else `english`, which is the wording of the place that
 * asks. An empty or blank message counts as none. It never answers the key itself, so a key that no language has still
 * reads as a sentence.
 */
export function translate(messages, key, english, values) {
    const said = Object.hasOwn(messages, key) ? messages[key] : undefined;
    const text = typeof said === "string" && said.trim() !== "" ? said : english;

    return format(text, values);
}
