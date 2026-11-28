// The components that extensions add to a surface (`pocket.surfaceComponent`, `src/server/surfaces/components.ts`).
// `extension-ui.js` fills this in and `surfaces.js` asks it; neither imports the other. No imports, so Node tests it.

let find = () => undefined;
let revision = 0;
const listeners = new Set();

/** `lookup(type)` gives the renderer of a type that a live browser module registered, or undefined. */
export function setSurfaceComponents(lookup) {
    find = lookup;
}

export const surfaceComponentOf = (type) => find(String(type));

export const surfaceComponentsRevision = () => revision;

/** A module added or took away a component: the cards that show one draw again. */
export function surfaceComponentsChanged() {
    revision++;

    for (const listener of [...listeners]) {
        listener();
    }
}

export function onSurfaceComponents(listener) {
    listeners.add(listener);

    return () => listeners.delete(listener);
}
