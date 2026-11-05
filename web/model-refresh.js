// One refresh action and its persistent feedback, shared by the menu, Providers, and the launcher.
import { api, notify, store } from "./store.js";
import { html, Icon } from "./ui.js";
import { t } from "./ui-locale.js";

/** Reloading shared model configuration and contacting providers is the owner's choice. */
export const modelRefreshAvailable = () =>
    store.state.me?.role === "owner" && store.state.server?.refreshModels === true;

/** A refresh does not choose a model: the server's existing models event updates the lists. */
export async function refreshModels() {
    if (!modelRefreshAvailable() || store.state.modelRefresh.loading) {
        return;
    }

    store.set({ modelRefresh: { loading: true, result: null, error: null } });
    notify(
        "info",
        t("web.model-refresh.refresh-models.button.refreshing-models", "Refreshing models…"),
    );

    try {
        const result = await api("models/refresh", {});

        store.set({ modelRefresh: { loading: false, result, error: null } });
        notify(
            result.errors.length > 0 ? "error" : "info",
            `${completion(result)}${result.errors.length > 0 ? t("web.model-refresh.partial-failure", " Some providers could not refresh. See Providers for details.") : ""}`,
        );

        return result;
    } catch (error) {
        const message = error.message ?? String(error);

        store.set({ modelRefresh: { loading: false, result: null, error: message } });
        notify(
            "error",
            t(
                "web.model-refresh.refresh-models.p.could-not-refresh-models",
                "Could not refresh models: {error}",
                { error: message },
            ),
        );
    }
}

function completion({ added, removed, total, offline }) {
    const counts =
        added === 0 && removed === 0
            ? t(
                  "web.model-refresh.completion.text.no-model-changes",
                  "No model changes. {count} models available.",
                  { count: total },
              )
            : t(
                  "web.model-refresh.completion.text.models-refreshed",
                  "Models refreshed: {added} added, {removed} removed. {count} models available.",
                  { added, removed, count: total },
              );

    if (!offline) {
        return counts;
    }

    const reloaded = t(
        "web.model-refresh.completion.text.offline",
        "Offline: reloaded cached models and configuration.",
    );

    return `${reloaded} ${counts}`;
}

/** A small icon button for a heading: the same action, with its state in its label and a turning icon. */
export function RefreshModelsButton() {
    if (!modelRefreshAvailable()) {
        return null;
    }

    const { loading } = store.state.modelRefresh;
    const label = loading
        ? t("web.model-refresh.refresh-models.button.refreshing-models", "Refreshing models…")
        : t("menu.refresh-models", "Refresh models");

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
        ${loading && html`<p class="muted">${t("web.model-refresh.refresh-models.p.checking-configured-providers", "Checking configured providers…")}</p>`}
        ${error && html`<p class="warn">${t("web.model-refresh.refresh-models.p.could-not-refresh-models", "Could not refresh models: {error}", { error })}</p>`}
        ${result && html`<p class="muted">${completion(result)}</p>`}
        ${result?.errors.map(
            ({ provider, message }) => html`<p class="warn">${provider}: ${message}</p>`,
        )}
    </div>`;
}
