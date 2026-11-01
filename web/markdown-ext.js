// What extensions add to Markdown: the code blocks they draw (`pocket.fence`) and the math they set in lines of words
// (`pocket.mathInline`). `extension-ui.js` fills this in and `ui.js` asks it; neither imports the other. No imports, so
// Node tests it.

let findFence = () => undefined;
let findMath = () => undefined;
/** Goes up when what extensions draw changes, so that markdown drawn before draws again. */
let revision = 0;

/** Where fences come from: `find(lang)` gives the spec whose `langs` has the (lowercase) language, or undefined. */
export function setFences(find) {
    findFence = find;
}

/** Where the math mounter comes from: `find()` gives the spec of `pocket.mathInline`, or undefined. */
export function setMath(find) {
    findMath = find;
}

export const fenceFor = (lang) => findFence(String(lang).toLowerCase());

/** Whether an extension sets math: `$…$` and `$$…$$` in markdown are math only then. */
export const mathOn = () => findMath() !== undefined;

export const markdownRevision = () => revision;

export function markdownChanged() {
    revision++;
}

/**
 * Math in `root`'s HTML, set by the extension: each `code` the markdown marked as math (`data-part="inline-math"`)
 * once. One the extension cannot set stays as the code it was written as.
 */
export function mountMath(root) {
    const spec = findMath();

    if (spec === undefined || root === null) {
        return;
    }

    for (const element of root.querySelectorAll(
        'code[data-part="inline-math"]:not([data-mounted])',
    )) {
        element.dataset.mounted = "";

        try {
            spec.mount(element, element.textContent ?? "", element.dataset.lang === "math-display");
        } catch (error) {
            console.error("Math could not be set", error);
        }
    }
}
