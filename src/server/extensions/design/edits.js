// The text edits a person makes on the canvas, gathered until they are sent to Pi as one message.

/** The key an edit goes by: the element it changed. */
const keyOf = (target) => `${target?.pid ?? ""}\n${target?.selector ?? ""}`;

/**
 * Add one edit (`{ target, before, after }`) to the list. A second edit of the same element keeps the first `before` and
 * takes the new `after`; an edit that ends where it began is dropped. Returns a new list.
 */
export function addEdit(list, edit) {
    const key = keyOf(edit.target);
    const at = list.findIndex((each) => keyOf(each.target) === key);

    if (at === -1) {
        return edit.before === edit.after ? list : [...list, { ...edit }];
    }

    const merged = { ...list[at], target: edit.target, after: edit.after };

    if (merged.before === merged.after) {
        return list.filter((_, index) => index !== at);
    }

    return list.map((each, index) => (index === at ? merged : each));
}

/** A short name for an element: `button “Get started”`, or its tag and selector when it has no words. */
export function nameOf(target) {
    const words = String(target?.text ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const tag = target?.tag || "element";

    return words === ""
        ? `${tag} ${target?.selector ?? ""}`.trim()
        : `${tag} “${words.slice(0, 40)}${words.length > 40 ? "…" : ""}”`;
}
