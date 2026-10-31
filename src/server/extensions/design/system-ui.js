import { watchPreview } from "./system-preview.js";
import { changeOf } from "./system.js";
import { createSystemActions } from "./system-actions.js";
import { createSystemSections } from "./system-sections.js";
import { createSystemView } from "./system-view.js";
import { createSystemWidgets } from "./system-widgets.js";
import { changeWith } from "./unsaved.js";

let stopPreview = null;

export async function createSystemUi(env, canvas) {
    await env.style("system.css");

    changeWith(changeOf);
    Object.assign(env, createSystemActions(env));

    if (stopPreview === null) {
        stopPreview = watchPreview(env.store);
        // The watcher reads the store on its first change: trigger one.
        env.store.set({});
    }

    const widgets = createSystemWidgets(env);

    return createSystemView(env, canvas, createSystemSections(env, widgets), widgets);
}
