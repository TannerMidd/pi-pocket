// Model providers: signing in and out, and the dialog a sign-in uses to ask for a code or a key.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";

export function ProvidersSheet() {
    const { me } = store.state;
    const [providers, setProviders] = useState(null);
    const [query, setQuery] = useState("");
    const load = () => attempt(async () => setProviders(await api("providers")));

    useEffect(() => {
        load();
    }, [store.state.models]);
    const owner = me?.role === "owner";
    const login = (provider, type) =>
        attempt(() => api(`providers/${encodeURIComponent(provider.id)}/login`, { type }));
    const logout = (provider) =>
        confirm(
            t("Log out of {{provider}}? Pi uses the same sign-in, so it is signed out too.", {
                provider: provider.name,
            }),
        ) &&
        attempt(async () => {
            await api(`providers/${encodeURIComponent(provider.id)}/logout`, {});
            load();
        });
    const needle = query.trim().toLowerCase();
    const list = (providers ?? [])
        .filter(
            (provider) =>
                needle === "" || `${provider.id} ${provider.name}`.toLowerCase().includes(needle),
        )
        .sort(
            (a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name),
        );

    return html`<${Sheet} title=${t("Providers")} onClose=${closeSheet}>
        <p class="muted small">
            ${t("Pi Pocket shares Pi's sign-ins")} (<span class="mono">~/.pi/agent/auth.json</span>). ${owner ? "" : t("Only the owner can change them.")}
        </p>
        <label class="search">
            <${Icon} name="search" size=${16} />
            <input
                placeholder=${t("Search providers")}
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
        </label>
        ${providers === null && html`<${Loader} label=${t("Loading providers")} />`}
        ${list.map(
            (provider) => html`<div class="provider">
                <div>
                    <div>
                        ${provider.name} ${provider.configured && html`<span class="ok">✓</span>`}
                    </div>
                    <div class="muted small">
                        ${provider.configured ? `${t("signed in")}${provider.label ? ` · ${provider.label}` : provider.source ? ` · ${provider.source}` : ""}` : t("not configured")} · ${t("{{count}} models", { count: provider.models })}
                    </div>
                </div>
                ${
                    owner &&
                    html`<div class="provider-actions">
                        ${
                            provider.oauth &&
                            html`<button
                                class="button small"
                                onClick=${() => login(provider, "oauth")}
                            >
                                ${provider.oauth === "Sign in with ChatGPT" ? t("Sign in with ChatGPT") : provider.oauth}
                            </button>`
                        }
                        ${
                            provider.apiKey &&
                            html`<button
                                class="button small"
                                onClick=${() => login(provider, "api_key")}
                            >
                                ${t("API key")}
                            </button>`
                        }
                        ${
                            provider.configured &&
                            provider.source === "stored" &&
                            html`<button
                                class="button small ghost"
                                onClick=${() => logout(provider)}
                            >
                                ${t("Log out")}
                            </button>`
                        }
                    </div>`
                }
            </div>`,
        )}
    <//>`;
}

export function AuthDialog() {
    const { auth } = store.state;
    const [value, setValue] = useState("");

    if (!auth) {
        return null;
    }

    const answer = (payload) =>
        attempt(async () => {
            await api(`auth/${auth.flowId}/${auth.prompt.id}`, payload);
            setValue("");
            store.set({ auth: { ...store.state.auth, prompt: null } });
        });

    const close = () => {
        // Stop the sign-in on the server too, also while it waits without a question (an OAuth callback holds a port).
        if (!auth.done) {
            api(`auth/${encodeURIComponent(auth.flowId)}/cancel`, {}).catch(() => {});
        }

        store.set({ auth: null });
    };

    const prompt = auth.prompt;

    return html`<${Sheet} title=${t("Sign in: {{provider}}", { provider: auth.providerId })} onClose=${close}>
        ${auth.events.map((event) => {
            if (event.type === "auth_url") {
                return html`<div class="auth-event">
                    <a class="button primary wide" href=${event.url} target="_blank" rel="noopener">
                        ${t("Open the sign-in page")}
                    </a>
                    ${event.instructions && html`<p class="muted small">${event.instructions}</p>`}
                </div>`;
            }

            if (event.type === "device_code") {
                return html`<div class="auth-event">
                    <p>
                        ${t("Enter this code at")} <a href=${event.verificationUri} target="_blank" rel="noopener">${event.verificationUri}</a>
                    </p>
                    <div class="code-big">${event.userCode}</div>
                </div>`;
            }

            return html`<p class="muted small">
                ${event.message}
                ${event.links?.map(
                    (link) => html` <a href=${link.url} target="_blank" rel="noopener">
     ${link.label ?? link.url}
 </a>`,
                )}
            </p>`;
        })}
        ${
            prompt &&
            (prompt.type === "select"
                ? html`<div class="field">
                    <div class="label">${prompt.message}</div>
                    ${prompt.options.map(
                        (option) =>
                            html`<button
                                class="list-item"
                                onClick=${() => answer({ value: option.id })}
                            >
                                <span>${option.label}</span>
                                <span class="muted small">${option.description ?? ""}</span>
                            </button>`,
                    )}
                </div>`
                : html`<div class="field">
                    <div class="label">${prompt.message}</div>
                    <div class="row">
                        <input
                            type=${prompt.type === "secret" ? "password" : "text"}
                            autocomplete="off"
                            placeholder=${prompt.placeholder ?? ""}
                            value=${value}
                            onInput=${(event) => setValue(event.currentTarget.value)}
                            onKeyDown=${(event) => event.key === "Enter" && answer({ value })}
                        />
                        <button class="button primary" onClick=${() => answer({ value })}>
                            ${t("Continue")}
                        </button>
                    </div>
                </div>`)
        }
        ${!prompt && !auth.done && html`<${Loader} label=${t("Waiting for the provider")} />`}
        ${auth.done && !auth.done.ok && html`<div class="error-box">${auth.done.error}</div>`}
    <//>`;
}
