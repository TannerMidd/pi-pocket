// One refresh action and its persistent feedback, shared by the menu, Providers, and the launcher.
import { api, notify, store } from "./store.js";
import { html, Icon } from "./ui.js";

/** Reloading shared model configuration and contacting providers is the owner's choice. */
export const modelRefreshAvailable = () =>
    store.state.me?.role === "owner" && store.state.server?.refreshModels === true;

/** A refresh does not choose a model: the server's existing models event updates the lists. */
export async function refreshModels() {
    if (!modelRefreshAvailable() || store.state.modelRefresh.loading) {
        return;
    }

    store.set({ modelRefresh: { loading: true, result: null, error: null } });
    notify("info", "Refreshing models…");

    try {
        const result = await api("models/refresh", {});

        store.set({ modelRefresh: { loading: false, result, error: null } });
        notify(
            result.errors.length > 0 ? "error" : "info",
            `${completion(result)}${result.errors.length > 0 ? " Some providers could not refresh. See Providers for details." : ""}`,
        );

        return result;
    } catch (error) {
        const message = error.message ?? String(error);

        store.set({ modelRefresh: { loading: false, result: null, error: message } });
        notify("error", `Could not refresh models: ${message}`);
    }
}

function completion({ added, removed, total, offline }) {
    const counts =
        added === 0 && removed === 0
            ? `No model changes. ${total} models available.`
            : `Models refreshed: ${added} added, ${removed} removed. ${total} models available.`;

    return `${offline ? "Offline: reloaded cached models and configuration. " : ""}${counts}`;
}

/** A small icon button for a heading: the same action, with its state in its label and a turning icon. */
export function RefreshModelsButton() {
    if (!modelRefreshAvailable()) {
        return null;
    }

    const { loading } = store.state.modelRefresh;
    const label = loading ? "Refreshing models…" : "Refresh models";

    return html`<button
        class="icon-button model-refresh-button"
        type="button"
        aria-label=${label}
        title=${label}
        disabled=${loading}
        aria-busy=${loading}
        onClick=${refreshModels}
    >
        <${Icon} name="reload" size=${16} />
    </button>`;
}

/** The same loading state and last result survive closing or switching sheets in this tab. */
export function RefreshModelsStatus() {
    if (!modelRefreshAvailable()) {
        return null;
    }

    const { loading, result, error } = store.state.modelRefresh;

    return html`<div class="model-refresh-status small" role="status" aria-live="polite">
        ${loading && html`<p class="muted">Checking configured providers…</p>`}
        ${error && html`<p class="warn">Could not refresh models: ${error}</p>`}
        ${result && html`<p class="muted">${completion(result)}</p>`}
        ${result?.errors.map(
            ({ provider, message }) => html`<p class="warn">${provider}: ${message}</p>`,
        )}
    </div>`;
}
