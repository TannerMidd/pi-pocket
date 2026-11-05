// Model providers: signing in and out, the models subagents may use, and the dialog a
// sign-in uses to ask for a code or a key.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, attempt, closeSheet, closeSignIn, signInAnswered, store } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";
import { RefreshModels } from "../model-refresh.js";
import { t } from "../ui-locale.js";

/** Models past this many get a box to find them by. */
const MODEL_SEARCH_AT = 8;

/** This tab's changes to the models for subagents, one after another: their answers come back in the order sent. */
let saving = Promise.resolve();

/**
 * The owner's choice of the models Pi may start subagents and linked sessions on: every model, by provider, each
 * checked or not on its own. None, the default: they run on their session's model, and Pi is offered no model to pick.
 * Some: only those, their session's model too only when it is checked. A tap sends that one model's change, not the
 * whole list, so quick taps and other tabs keep theirs.
 * `names`: providers' names by id, once the sheet has them.
 */
function SubagentModels({ names }) {
    const { models, server } = store.state;
    const allowed = server?.subagentModels;
    // What this tab asked for and has no answer to yet, by model: shown at once.
    const [asked, setAsked] = useState({});
    const [query, setQuery] = useState("");

    // A server that does not keep the choice sends none.
    if (!Array.isArray(allowed)) {
        return null;
    }

    const specOf = (model) => `${model.provider}/${model.id}`;
    // Allowed models that are not signed in now are listed too, so they can be seen and taken off.
    const rows = [
        ...models.map((model) => ({ spec: specOf(model), model })),
        ...allowed
            .filter((spec) => !models.some((model) => specOf(model) === spec))
            .map((spec) => ({ spec, model: null })),
    ];
    const isOn = (spec) => asked[spec] ?? allowed.includes(spec);
    const chosen = rows.filter((row) => isOn(row.spec)).map((row) => row.model?.name ?? row.spec);
    const summary =
        chosen.length === 0
            ? t(
                  "web.sheets.providers.subagent-models.summary.none-allowed-pi-never",
                  "None allowed: Pi never picks a model.",
              )
            : t(
                  "web.sheets.providers.subagent-models.summary.allowed",
                  "{count} allowed: {detail}",
                  {
                      count: chosen.length,
                      detail: chosen.join(", "),
                  },
              );
    const needle = query.trim().toLowerCase();
    const groups = new Map();

    for (const row of rows) {
        const provider = row.spec.slice(0, row.spec.indexOf("/"));
        const words = `${row.spec} ${row.model?.name ?? ""} ${names[provider] ?? ""}`;

        if (needle === "" || words.toLowerCase().includes(needle)) {
            groups.set(provider, [...(groups.get(provider) ?? []), row]);
        }
    }

    const toggle = (spec, on) => {
        setAsked((was) => ({ ...was, [spec]: on }));
        saving = saving.then(async () => {
            const answer = await attempt(() =>
                api("subagent-models", { model: spec, allowed: on }),
            );

            if (Array.isArray(answer?.subagentModels)) {
                store.set((state) => ({
                    server: { ...state.server, subagentModels: answer.subagentModels },
                }));
            }

            // Unless a later tap asked otherwise, what the server says shows now.
            setAsked((was) => {
                if (was[spec] !== on) {
                    return was;
                }

                const rest = { ...was };

                delete rest[spec];

                return rest;
            });
        });
    };

    return html`<div class="subagent-models">
        <div class="label">${t(
            "web.sheets.providers.subagent-models.div.models-for-subagents",
            "Models for subagents",
        )}</div>
        <p class="muted small">
            ${t("web.sheets.providers.subagent-models.p.none-checked-subagents-linked", "With none checked, subagents and linked sessions run on their session's model, and Pi cannot choose another. Check some, and they run only on those: on the session's model when it is checked, otherwise on a checked model that Pi chooses to suit the work. Pi cannot use any other.")}
        </p>
        <p class="small subagent-models-chosen" title=${summary}>${summary}</p>
        ${
            (rows.length > MODEL_SEARCH_AT || query !== "") &&
            html`<label class="search">
                <${Icon} name="search" size=${16} />
                <input
                    placeholder=${t(
                        "web.sheets.providers.subagent-models.placeholder.find-a-model",
                        "Find a model",
                    )}
                    aria-label=${t(
                        "web.sheets.providers.subagent-models.aria-label.find-model-subagents",
                        "Find a model for subagents",
                    )}
                    value=${query}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                />
            </label>`
        }
        <div class="subagent-models-list" role="group" aria-label=${t(
            "web.sheets.providers.subagent-models.aria-label.models-for-subagents",
            "Models for subagents",
        )}>
            ${
                groups.size === 0 &&
                html`<p class="muted small">
                    ${
                        rows.length === 0
                            ? t(
                                  "web.sheets.providers.subagent-models.p.no-models-sign-provider",
                                  "No models: sign in to a provider below.",
                              )
                            : t(
                                  "web.sheets.providers.subagent-models.p.no-model-matches",
                                  "No model matches.",
                              )
                    }
                </p>`
            }
            ${[...groups].map(
                ([provider, list]) => html`<div key=${provider}>
                    <div class="subagent-models-head">${names[provider] ?? provider}</div>
                    ${list.map(
                        ({ spec, model }) => html`<label class="subagent-model" key=${spec}>
                            <input
                                type="checkbox"
                                value=${spec}
                                checked=${isOn(spec)}
                                onChange=${(event) => toggle(spec, event.currentTarget.checked)}
                            />
                            <span>
                                ${model?.name ?? spec.slice(spec.indexOf("/") + 1)}
                                <span class="muted small">
                                    ${spec}
                                    ${
                                        !model
                                            ? html` · <span class="warn">${t(
                                                  "web.sheets.providers.subagent-models.span.not-signed-in",
                                                  "not signed in",
                                              )}</span>`
                                            : model.signIn &&
                                              html` · <span class="warn">${t(
                                                  "web.sheets.providers.subagent-models.span.needs-sign-in",
                                                  "needs sign-in",
                                              )}</span>`
                                    }
                                </span>
                            </span>
                        </label>`,
                    )}
                </div>`,
            )}
        </div>
    </div>`;
}

/** How long a run waits for a provider's limit to clear (`limit-gate.ts`), at most. */
const limitWait = () => [
    [0, t("web.sheets.providers.limit-wait.off", "Off")],
    [1, t("web.sheets.providers.limit-wait.hour", "1 hour")],
    [6, t("web.sheets.providers.limit-wait.6-hours", "6 hours")],
    [12, t("web.sheets.providers.limit-wait.12-hours", "12 hours")],
    [24, t("web.sheets.providers.limit-wait.24-hours", "24 hours")],
];

/** The owner's choice of how long a run waits for a limit, rather than failing. Shorter limits wait less. */
function LimitWait() {
    const hours = store.state.server?.limitWaitHours;

    // A server that does not wait for limits sends none.
    if (typeof hours !== "number") {
        return null;
    }

    const change = (value) => attempt(() => api("settings", { limitWaitHours: value }));

    return html`<div class="limit-wait">
        <div class="small">${t(
            "web.sheets.providers.limit-wait.div.wait-for-a-limit",
            "Wait for a limit",
        )}</div>
        <p class="muted small">
            ${t(
                "web.sheets.providers.limit-wait.p.provider-s-limit-stops",
                "When a provider's limit stops a run, it waits for the limit to clear, up to this long, and goes on by itself. A limit that clears later makes it fail with the time.",
            )}
        </p>
        <div class="segmented" role="group" aria-label=${t(
            "web.sheets.providers.limit-wait.aria-label.long-wait-limit",
            "How long to wait for a limit",
        )}>
            ${limitWait().map(
                ([value, label]) => html`<button
                    class=${hours === value ? "on" : ""}
                    aria-pressed=${hours === value}
                    onClick=${() => change(value)}
                >
                    ${label}
                </button>`,
            )}
        </div>
    </div>`;
}

export function ProvidersSheet() {
    const { me, auth } = store.state;
    const [providers, setProviders] = useState(null);
    const [query, setQuery] = useState("");
    const loginButton = useRef(null);
    const load = () => attempt(async () => setProviders(await api("providers")));

    useEffect(() => {
        load();
    }, [store.state.models]);
    useLayoutEffect(() => {
        if (!auth) {
            loginButton.current?.focus();
            loginButton.current = null;
        }
    }, [auth]);
    const owner = me?.role === "owner";

    const login = (provider, type, button) => {
        loginButton.current = button;

        return attempt(() => api(`providers/${encodeURIComponent(provider.id)}/login`, { type }));
    };

    const logout = (provider) =>
        confirm(
            t(
                "web.sheets.providers.providers-sheet.logout.confirm.log-out-pi-uses",
                "Log out of {provider}? Pi uses the same sign-in, so it is signed out too.",
                { provider: provider.name },
            ),
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
            (a, b) =>
                Number(Boolean(b.needsSignIn)) - Number(Boolean(a.needsSignIn)) ||
                Number(b.configured) - Number(a.configured) ||
                a.name.localeCompare(b.name),
        );

    // Signed-out providers wait at the end, and an expired sign-in comes first: that is the one to act on.
    const groups = [
        [
            t("web.sheets.providers.providers-sheet.groups.needs-sign", "Needs sign-in"),
            list.filter((provider) => provider.needsSignIn),
        ],
        [
            t("web.sheets.providers.providers-sheet.groups.signed", "Signed in"),
            list.filter((provider) => !provider.needsSignIn && provider.configured),
        ],
        [
            t("web.sheets.providers.providers-sheet.groups.not-configured", "Not configured"),
            list.filter((provider) => !provider.needsSignIn && !provider.configured),
        ],
    ].filter(([, each]) => each.length > 0);

    const row = (provider) => html`<div class="provider" key=${provider.id}>
        <div class="provider-info">
            <div class="provider-name">
                ${provider.name}
                ${
                    provider.needsSignIn
                        ? html` <span class="warn provider-needs">${t(
                              "web.sheets.providers.providers-sheet.row.span.needs-sign-in",
                              "needs sign-in",
                          )}</span>`
                        : provider.configured && html` <span class="ok">✓</span>`
                }
            </div>
            <div class="muted small">
                ${
                    provider.needsSignIn
                        ? t(
                              "web.sheets.providers.providers-sheet.row.div.sign-expired-not-renewed",
                              "the sign-in expired and could not be renewed: sign in again. Until then, sessions on its models fail, and PiP and subagents on other models do not use them",
                          )
                        : provider.configured
                          ? t(
                                "web.sheets.providers.providers-sheet.row.div.signed",
                                "signed in{provider}",
                                {
                                    provider: provider.label
                                        ? ` · ${provider.label}`
                                        : provider.source
                                          ? ` · ${provider.source}`
                                          : "",
                                },
                            )
                          : t(
                                "web.sheets.providers.providers-sheet.row.div.not-configured",
                                "not configured",
                            )
                } · ${t(
                    "web.sheets.providers.providers-sheet.row.div.model-count",
                    "{count} models",
                    { count: provider.models },
                )}
            </div>
            ${
                provider.needsSignIn &&
                html`<div class="muted small mono provider-why">${provider.needsSignIn}</div>`
            }
        </div>
        ${
            owner &&
            html`<div class="provider-actions">
                ${
                    provider.oauth &&
                    html`<button
                        class="button small"
                        onClick=${(event) => login(provider, "oauth", event.currentTarget)}
                    >
                        ${provider.oauth}
                    </button>`
                }
                ${
                    provider.apiKey &&
                    html`<button
                        class="button small"
                        onClick=${(event) => login(provider, "api_key", event.currentTarget)}
                    >
                        ${t("web.sheets.providers.providers-sheet.row.button.api-key", "API key")}
                    </button>`
                }
                ${
                    provider.configured &&
                    provider.source === "stored" &&
                    html`<button class="button small ghost" onClick=${() => logout(provider)}>
                        ${t("web.sheets.providers.providers-sheet.row.button.log-out", "Log out")}
                    </button>`
                }
            </div>`
        }
    </div>`;

    return html`<${Sheet}
        title=${t("web.sheets.providers.providers-sheet.title.providers", "Providers")}
        onClose=${closeSheet}
        className=${`providers-sheet ${owner ? "with-side" : ""}`}
    >
        <p class="muted small">
            ${t("web.sheets.providers.providers-sheet.p.pi-pocket-shares-s", "Pi Pocket shares Pi's sign-ins (")}<span class="mono">~/.pi/agent/auth.json</span>). ${
                owner
                    ? ""
                    : t(
                          "web.sheets.providers.providers-sheet.span.owner-change-them",
                          "Only the owner can change them.",
                      )
            }
        </p>
        <div class="providers-layout">
            ${
                owner &&
                html`<aside class="providers-side" aria-label=${t(
                    "web.sheets.providers.providers-sheet.aria-label.models",
                    "Models",
                )}>
                    <${RefreshModels} />
                    <${LimitWait} />
                    <${SubagentModels}
                        names=${Object.fromEntries(
                            (providers ?? []).map((each) => [each.id, each.name]),
                        )}
                    />
                </aside>`
            }
            <div class="providers-main">
                ${store.state.auth && html`<${AuthDialog} inline=${true} />`}
                <label class="search">
                    <${Icon} name="search" size=${16} />
                    <input
                        placeholder=${t(
                            "web.sheets.providers.providers-sheet.placeholder.search-providers",
                            "Search providers",
                        )}
                        value=${query}
                        onInput=${(event) => setQuery(event.currentTarget.value)}
                    />
                </label>
                ${
                    providers === null &&
                    html`<${Loader}
                        label=${t(
                            "web.sheets.providers.providers-sheet.label.loading-providers",
                            "Loading providers",
                        )}
                    />`
                }
                ${
                    providers !== null &&
                    list.length === 0 &&
                    needle !== "" &&
                    html`<div class="launcher-empty" role="status">
                        <strong>
                            ${t(
                                "web.sheets.providers.providers-sheet.strong.no-providers-match",
                                "No providers match “{query}”.",
                                { query: query.trim() },
                            )}
                        </strong>
                        <button class="button" onClick=${() => setQuery("")}>${t(
                            "web.sheets.providers.providers-sheet.button.clear-search",
                            "Clear search",
                        )}</button>
                    </div>`
                }
                ${groups.map(
                    ([title, each]) => html`<section class="provider-group" key=${title}>
                        <h3 class="provider-group-head">
                            ${title} <span class="muted">${each.length}</span>
                        </h3>
                        <div class="sheet-list">${each.map(row)}</div>
                    </section>`,
                )}
            </div>
        </div>
    <//>`;
}

/** A provider signs in in place; sign-ins requested elsewhere still get their own dialog. */
function AuthFrame({ title, onClose, inline, focusKey, children }) {
    const ref = useRef(null);
    const close = useRef(onClose);

    close.current = onClose;

    // The first question may arrive after the card mounts. Focus it then, not on every redraw while typing.
    useLayoutEffect(() => {
        if (inline) {
            const card = ref.current?.querySelector(".auth-card");
            const control =
                card?.querySelector(".field input:not(:disabled), .field button:not(:disabled)") ??
                card?.querySelector("a[href], button:not(:disabled)");

            (control ?? ref.current)?.focus({ preventScroll: true });
            ref.current?.scrollIntoView({ block: "nearest" });
        }
    }, [inline, focusKey]);
    useEffect(() => {
        if (!inline) {
            return undefined;
        }

        const escape = (event) => {
            if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
                event.stopImmediatePropagation();
                close.current();
            }
        };

        addEventListener("keydown", escape, true);

        return () => removeEventListener("keydown", escape, true);
    }, [inline]);

    const content = html`<div class="auth-card">${children}</div>`;

    return inline
        ? html`<section class="auth-inline" aria-label=${title} tabindex="-1" ref=${ref}>
            <div class="auth-inline-head">
                <strong>${title}</strong>
                <button class="icon-button" aria-label=${t(
                    "web.sheets.providers.auth-frame.aria-label.close",
                    "Close",
                )} onClick=${onClose}>
                    <${Icon} name="close" size=${16} />
                </button>
            </div>
            ${content}
        </section>`
        : html`<${Sheet} title=${title} onClose=${onClose}>${content}<//>`;
}

export function AuthDialog({ inline = false }) {
    const { auth } = store.state;
    const [value, setValue] = useState("");

    // Each question starts empty, also one that came before the reply to the answer before it.
    useEffect(() => setValue(""), [auth?.flowId, auth?.prompt?.id]);

    if (!auth) {
        return null;
    }

    const answer = (payload) => {
        const { flowId, prompt: asked } = auth;

        if (asked.type === "secret" && payload.value?.trim() === "") {
            return;
        }

        return attempt(async () => {
            await api(`auth/${flowId}/${asked.id}`, payload);
            signInAnswered(flowId, asked.id);
        });
    };

    const close = () => {
        // Stop the sign-in on the server too, also while it waits without a question (an OAuth callback holds a port).
        if (!auth.done) {
            api(`auth/${encodeURIComponent(auth.flowId)}/cancel`, {}).catch(() => {});
        }

        closeSignIn(auth.flowId);
    };

    const prompt = auth.prompt;

    return html`<${AuthFrame}
        title=${t("web.sheets.providers.auth-dialog.title.sign", "Sign in: {provider}", {
            provider: auth.providerName,
        })}
        onClose=${close}
        inline=${inline}
        focusKey=${`${auth.flowId}:${prompt?.id ?? auth.events.length}`}
    >
        ${(auth.done ? [] : auth.events).map((event) => {
            if (event.type === "auth_url") {
                return html`<div class="auth-event">
                    <a class="button primary wide" href=${event.url} target="_blank" rel="noopener">
                        ${t(
                            "web.sheets.providers.auth-dialog.a.open-the-sign-in-page",
                            "Open the sign-in page",
                        )}
                    </a>
                    ${event.instructions && html`<p class="muted small">${event.instructions}</p>`}
                </div>`;
            }

            if (event.type === "device_code") {
                return html`<div class="auth-event">
                    <p>
                        ${t("web.sheets.providers.auth-dialog.p.enter-this-code-at", "Enter this code at")} <a href=${event.verificationUri} target="_blank" rel="noopener">${event.verificationUri}</a>
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
                            aria-label=${prompt.message}
                            autocomplete="off"
                            placeholder=${prompt.placeholder ?? ""}
                            value=${value}
                            onInput=${(event) => setValue(event.currentTarget.value)}
                            onKeyDown=${(event) => event.key === "Enter" && answer({ value })}
                        />
                        <button
                            class="button primary"
                            disabled=${prompt.type === "secret" && value.trim() === ""}
                            onClick=${() => answer({ value })}
                        >
                            ${t("web.sheets.providers.auth-dialog.button.continue", "Continue")}
                        </button>
                    </div>
                </div>`)
        }
        ${
            !prompt &&
            !auth.done &&
            html`<${Loader}
                label=${t(
                    "web.sheets.providers.auth-dialog.label.waiting-for-the-provider",
                    "Waiting for the provider",
                )}
            />`
        }
        ${
            auth.done &&
            !auth.done.ok &&
            html`<div class="error-box">
                <p>${
                    auth.done.details
                        ? auth.done.error
                        : t(
                              "web.sheets.providers.auth-dialog.text.sign-not-finish-try",
                              "Sign-in did not finish. Try again.",
                          )
                }</p>
                <details>
                    <summary>${t(
                        "web.sheets.providers.auth-dialog.summary.details",
                        "Details",
                    )}</summary>
                    <p>${auth.done.details ?? auth.done.error}</p>
                </details>
                <button
                    class="button"
                    onClick=${() =>
                        attempt(async () => {
                            await api(`providers/${encodeURIComponent(auth.providerId)}/login`, {
                                type: auth.done.loginType ?? "oauth",
                            });
                            closeSignIn(auth.flowId);
                        })}
                >
                    ${t("web.sheets.providers.auth-dialog.button.start-again", "Start again")}
                </button>
            </div>`
        }
    <//>`;
}
