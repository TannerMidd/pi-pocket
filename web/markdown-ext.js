// What extensions add to Markdown. `extension-ui.js` fills this in and `ui.js` asks it; neither imports the other. No
// imports, so Node tests it.

let findFence = () => undefined;
let findMath = () => undefined;
let revision = 0;

export function setFences(find) {
    findFence = find;
}

export function setMath(find) {
    findMath = find;
}

export const fenceFor = (lang) => findFence(String(lang).toLowerCase());

export const mathOn = () => findMath() !== undefined;

export const markdownRevision = () => revision;

export function markdownChanged() {
    revision++;
}

export function mountMath(root) {
    const spec = findMath();

    if (spec === undefined || root === null) {
        return;
    }

    for (const element of root.querySelectorAll(
        'code[data-part="inline-math"]:not([data-mounted])',
    )) {
        element.dataset.mounted = "";
        element.dataset.tex = element.textContent ?? "";

        try {
            spec.mount(element, element.textContent ?? "", element.dataset.lang === "math-display");
        } catch (error) {
            console.error("Math could not be set", error);
        }
    }
}
