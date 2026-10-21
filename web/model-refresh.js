// One refresh action and its persistent feedback, shared by the menu, Providers, and the launcher.
import { api, notify, store } from "./store.js";
import { t } from "./i18n.js";
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
    notify("info", t("Refreshing models…"));

    try {
        const result = await api("models/refresh", {});

        store.set({ modelRefresh: { loading: false, result, error: null } });
        const details =
            result.errors.length > 0
                ? ` ${t("Some providers could not refresh. See Providers for details.")}`
                : "";

        notify(result.errors.length > 0 ? "error" : "info", `${completion(result)}${details}`);

        return result;
    } catch (error) {
        const message = error.message ?? String(error);

        store.set({ modelRefresh: { loading: false, result: null, error: message } });
        notify("error", t("Could not refresh models: {{error}}", { error: message }));
    }
}

function completion({ added, removed, total, offline }) {
    const counts =
        added === 0 && removed === 0
            ? t("No model changes. {{total}} models available.", { total })
            : t(
                  "Models refreshed: {{added}} added, {{removed}} removed. {{total}} models available.",
                  {
                      added,
                      removed,
                      total,
                  },
              );

    return `${offline ? `${t("Offline: reloaded cached models and configuration.")} ` : ""}${counts}`;
}

/** The same loading state and last result survive closing or switching sheets in this tab. */
export function RefreshModels() {
    if (!modelRefreshAvailable()) {
        return null;
    }

    const { loading, result, error } = store.state.modelRefresh;

    return html`<div class="model-refresh">
        <button
            class="button small model-refresh-button"
            type="button"
            disabled=${loading}
            aria-busy=${loading}
            onClick=${refreshModels}
        >
            <${Icon} name="reload" size=${15} />
            ${loading ? t("Refreshing models…") : t("Refresh models")}
        </button>
        <div class="model-refresh-status small" role="status" aria-live="polite">
            ${loading && html`<p class="muted">${t("Checking configured providers…")}</p>`}
            ${error && html`<p class="warn">${t("Could not refresh models: {{error}}", { error })}</p>`}
            ${result && html`<p class="muted">${completion(result)}</p>`}
            ${result?.errors.map(
                ({ provider, message }) =>
                    html`<p class="warn">${t("{{provider}}: {{message}}", { provider, message })}</p>`,
            )}
        </div>
    </div>`;
}
