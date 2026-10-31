import { createModel, previewVars, tokenEdits, unsavedCount } from "./system.js";

export function watchPreview(store) {
    let seen = {};
    let text = "{}";

    return store.subscribe((s) => {
        if (
            seen.data === s.system.data &&
            seen.history === s.history &&
            seen.view === s.view &&
            seen.mode === s.sysMode
        ) {
            return;
        }

        seen = { data: s.system.data, history: s.history, view: s.view, mode: s.sysMode };

        let vars = {};
        const data = s.system.data;

        if (data && (s.view === "system" || unsavedCount(data, s.history) > 0)) {
            const mode =
                s.view === "system" && data.modes.includes(s.sysMode) ? s.sysMode : data.modes[0];

            vars = previewVars(createModel(data, tokenEdits(s.history)), mode);
        }

        const next = JSON.stringify(vars);

        if (next !== text) {
            text = next;
            store.set({ previewVars: vars });
        }
    });
}
