// Model providers: signing in and out, the models subagents may use, and the dialog a
// sign-in uses to ask for a code or a key.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, attempt, closeSheet, closeSignIn, signInAnswered, store } from "../store.js";
import { html, Icon, Loader, MODEL_SEARCH_AT, Sheet } from "../ui.js";
import { RefreshModelsButton, RefreshModelsStatus } from "../model-refresh.js";
import { favoriteModels, setModelFavorite } from "../model-favorites.js";
import { EndpointForm, removeCustomProvider, useCustomProviders } from "./custom-providers.js";

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
    const [filter, setFilter] = useState("all");
    const favoritesOnly = filter === "favorites";
    const favorites = new Set(favoriteModels());

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
            ? "None allowed: Pi never picks a model."
            : `${chosen.length} allowed: ${chosen.join(", ")}`;
    const needle = query.trim().toLowerCase();
    const groups = new Map();

    for (const row of rows) {
        const provider = row.spec.slice(0, row.spec.indexOf("/"));
        const words = `${row.spec} ${row.model?.name ?? ""} ${names[provider] ?? ""}`;

        if (
            (filter === "all" || (favoritesOnly ? favorites.has(row.spec) : isOn(row.spec))) &&
            (needle === "" || words.toLowerCase().includes(needle))
        ) {
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
        <div class="subagent-models-heading">
            <div class="label">Subagent models</div>
            <${RefreshModelsButton} />
            <span class="small subagent-models-chosen" title=${summary} aria-live="polite">
                ${chosen.length} for subagents
            </span>
        </div>
        <${RefreshModelsStatus} />
        <p class="muted small">
            <strong>Checkbox:</strong> models subagents and linked sessions may use. With none checked, they use the
            session's model. <strong>Star:</strong> only a shortcut in your model picker; it changes no permission.
        </p>
        <div class="segmented model-filters" role="group" aria-label="Filter models">
            ${[
                ["all", "All models", null],
                ["allowed", "Allowed", "check"],
                ["favorites", "Favorites", "star"],
            ].map(
                ([value, label, icon]) => html`<button
                    class=${filter === value ? "on" : ""}
                    aria-pressed=${filter === value}
                    onClick=${() => setFilter(value)}
                >
                    ${icon && html`<${Icon} name=${icon} size=${15} />`} ${label}
                </button>`,
            )}
        </div>
        ${
            (rows.length > MODEL_SEARCH_AT || query !== "") &&
            html`<label class="search">
                <${Icon} name="search" size=${16} />
                <input
                    placeholder="Find a model"
                    aria-label="Find a model for subagents"
                    value=${query}
                    onInput=${(event) => setQuery(event.currentTarget.value)}
                />
            </label>`
        }
        <div class="subagent-models-legend" aria-hidden="true">
            <span><${Icon} name="check" size=${13} />${" "}Allowed for subagents</span>
            <span>Favorite${" "}<${Icon} name="star" size=${13} /></span>
        </div>
        <div class="subagent-models-list" role="group" aria-label="Subagent models">
            ${
                groups.size === 0 &&
                html`<p class="muted small">
                    ${rows.length === 0 ? "No models: sign in to a provider first." : needle === "" && filter !== "all" ? (favoritesOnly ? "Star models in All models to add favorites." : "No model is allowed yet: check some in All models.") : "No model matches."}
                </p>`
            }
            ${[...groups].map(
                ([provider, list]) => html`<div key=${provider}>
                    <div class="subagent-models-head">${names[provider] ?? provider}</div>
                    ${list.map(
                        ({ spec, model }) => html`<div class="subagent-model" key=${spec}>
                            <label class="subagent-model-choice">
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
                                                ? html` · <span class="warn">not signed in</span>`
                                                : model.signIn &&
                                                  html` · <span class="warn">needs sign-in</span>`
                                        }
                                    </span>
                                </span>
                            </label>
                            <button
                                class="icon-button model-favorite"
                                aria-label=${`Favorite ${model?.name ?? spec} (model picker shortcut)`}
                                aria-pressed=${favorites.has(spec)}
                                title=${favorites.has(spec) ? "Remove from model picker favorites" : "Add to model picker favorites (does not allow it for subagents)"}
                                onClick=${(event) => {
                                    if (favoritesOnly) {
                                        event.currentTarget
                                            .closest(".subagent-models")
                                            .querySelector(
                                                '.model-filters button[aria-pressed="true"]',
                                            )
                                            .focus();
                                    }

                                    return attempt(() =>
                                        setModelFavorite(spec, !favorites.has(spec)),
                                    );
                                }}
                            >
                                <${Icon} name="star" size=${18} />
                            </button>
                        </div>`,
                    )}
                </div>`,
            )}
        </div>
    </div>`;
}

/** How long a run waits for a provider's limit to clear (`limit-gate.ts`), at most. */
const LIMIT_WAIT = [
    [0, "Off"],
    [1, "1 hour"],
    [6, "6 hours"],
    [12, "12 hours"],
    [24, "24 hours"],
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
        <div class="small">Wait for a limit</div>
        <p class="muted small">
            When a provider's limit stops a run, it waits for the limit to clear, up to this long, and goes on by
            itself. A limit that clears later makes it fail with the time.
        </p>
        <div class="segmented" role="group" aria-label="How long to wait for a limit">
            ${LIMIT_WAIT.map(
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

/** Where a sign-in's key comes from, in words. */
const SOURCES = { models_json_key: "key in models.json", models_json_command: "key command" };
/** Where an endpoint's key is, in words. */
const ENDPOINT_KEYS = {
    stored: "key stored",
    file: "key in models.json",
    none: "no key",
    missing: "no key set",
};

const modelCount = (n) => `${n} ${n === 1 ? "model" : "models"}`;

/** A provider row's line under its name: its sign-in and its models, or what the row adds. */
function aboutOf(provider, endpoint) {
    if (provider.about) {
        return provider.about;
    }

    if (endpoint !== undefined && !provider.needsSignIn) {
        return `${endpoint.baseUrl} · ${ENDPOINT_KEYS[endpoint.key]} · ${modelCount(provider.models)}`;
    }

    const account = provider.label || SOURCES[provider.source] || provider.source;
    const signIn = provider.needsSignIn
        ? "the sign-in expired and could not be renewed: sign in again. Until then, sessions " +
          "on its models fail, and PiP and subagents on other models do not use them"
        : provider.configured
          ? `signed in${account ? ` · ${account}` : ""}`
          : "not configured";

    return `${signIn} · ${modelCount(provider.models)}`;
}

/** How long a panel under a row takes to close: `.provider-panel.closing` in style.css. */
const PANEL_CLOSE_MS = 180;

/**
 * A panel that opens under a provider's row, inside the list: it grows open, and shrinks closed before it goes, still
 * showing what it showed. With reduced motion it comes and goes at once.
 */
function RowPanel({ open, children }) {
    const kept = useRef(null);
    const [, redraw] = useState(0);

    if (open) {
        kept.current = children;
    }

    useEffect(() => {
        if (open || kept.current === null) {
            return undefined;
        }

        const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const timer = setTimeout(
            () => {
                kept.current = null;
                redraw((n) => n + 1);
            },
            still ? 0 : PANEL_CLOSE_MS,
        );

        return () => clearTimeout(timer);
    }, [open]);

    if (kept.current === null) {
        return null;
    }

    return html`<div class=${`provider-panel ${open ? "" : "closing"}`}>
        <div class="provider-panel-clip">
            <div class="provider-panel-body">${open ? children : kept.current}</div>
        </div>
    </div>`;
}

/** The endpoint form's value while it adds one: no endpoint id has a colon. */
const ADDING = ":add";

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
    const custom = useCustomProviders(owner);
    // The endpoint form: ADDING, an endpoint's id, or null when closed.
    const [endpointForm, setEndpointForm] = useState(null);
    const customIds = new Set((custom.list ?? []).map((endpoint) => endpoint.id));

    const openEndpointForm = (id) => setEndpointForm((was) => (was === id ? null : id));

    const endpointSaved = () => {
        setEndpointForm(null);
        custom.load();
        load();
    };

    const login = (provider, type, button) => {
        loginButton.current = button;

        return attempt(() => api(`providers/${encodeURIComponent(provider.id)}/login`, { type }));
    };

    const logout = (provider) =>
        confirm(
            `Log out of ${provider.name}? Pi uses the same sign-in, so it is signed out too.`,
        ) &&
        attempt(async () => {
            await api(`providers/${encodeURIComponent(provider.id)}/logout`, {});
            load();
        });
    const needle = query.trim().toLowerCase();
    // Not a provider of Pi's: the row that adds an OpenAI-compatible endpoint, which becomes one.
    const addRow = owner
        ? [
              {
                  id: "openai-compatible",
                  name: "OpenAI Compatible",
                  configured: false,
                  adds: true,
                  models: 0,
                  words: "custom endpoint local self-hosted ollama lm studio vllm llama.cpp proxy",
                  about:
                      "Any server with the OpenAI API (Ollama, LM Studio, vLLM, a proxy): " +
                      "a URL, a key, and its models",
              },
          ]
        : [];
    const list = [...(providers === null ? [] : addRow), ...(providers ?? [])]
        .filter(
            (provider) =>
                needle === "" ||
                `${provider.id} ${provider.name} ${provider.words ?? ""}`
                    .toLowerCase()
                    .includes(needle),
        )
        .sort(
            (a, b) =>
                Number(Boolean(b.needsSignIn)) - Number(Boolean(a.needsSignIn)) ||
                Number(b.configured) - Number(a.configured) ||
                a.name.localeCompare(b.name),
        );

    // Signed-out providers wait at the end, and an expired sign-in comes first: that is the one to act on.
    const groups = [
        ["Needs sign-in", list.filter((provider) => provider.needsSignIn)],
        ["Signed in", list.filter((provider) => !provider.needsSignIn && provider.configured)],
        [
            "Not configured",
            list.filter((provider) => !provider.needsSignIn && !provider.configured),
        ],
    ].filter(([, each]) => each.length > 0);

    // Where sign-ins live, said once: beside Signed in, or the first group when nothing is signed in.
    const noteGroup = (groups.find(([title]) => title === "Signed in") ??
        groups.find(([title]) => title === "Not configured") ??
        groups[0])?.[0];
    const noteMore = owner ? "" : " · only the owner can change them";
    const note = html`<p class="providers-note">
        Shared with Pi · <span class="mono">~/.pi/agent/auth.json</span>${noteMore}
    </p>`;

    // A sign-in opens under its provider's row; one whose row is not shown (a search hides it) opens above the list.
    const authInList = auth !== null && list.some((provider) => provider.id === auth.providerId);
    const formFor = (provider) =>
        endpointForm !== null &&
        (endpointForm === provider.id ||
            (endpointForm === ADDING && provider.id === "openai-compatible"));
    const isOpen = (provider) => auth?.providerId === provider.id || formFor(provider);

    // A row, and under it, inside the list, what its buttons opened: its sign-in, or the endpoint form.
    const row = (provider) => html`<div class="provider-item" key=${provider.id}>
        ${providerRow(provider)}
        <${RowPanel} open=${isOpen(provider)}>
            ${
                auth?.providerId === provider.id
                    ? html`<${AuthDialog} inline=${true} />`
                    : formFor(provider) &&
                      html`<${EndpointForm}
                          key=${endpointForm}
                          editing=${custom.list?.find((endpoint) => endpoint.id === endpointForm)}
                          onDone=${endpointSaved}
                          onCancel=${() => setEndpointForm(null)}
                      />`
            }
        <//>
    </div>`;
    const providerRow = (
        provider,
    ) => html`<div class=${`provider ${isOpen(provider) ? "open" : ""}`}>
        <div class="provider-info">
            <div class="provider-name">
                ${provider.name}
                ${
                    provider.needsSignIn
                        ? html` <span class="warn provider-needs">needs sign-in</span>`
                        : provider.configured && html` <span class="ok">✓</span>`
                }
            </div>
            <div class="muted small">
                ${aboutOf(
                    provider,
                    custom.list?.find((endpoint) => endpoint.id === provider.id),
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
                    provider.adds &&
                    html`<button
                        class="button small"
                        aria-expanded=${endpointForm === ADDING}
                        onClick=${() => openEndpointForm(ADDING)}
                    >
                        Add
                    </button>`
                }
                ${
                    customIds.has(provider.id) &&
                    html`<button
                            class="button small"
                            aria-expanded=${endpointForm === provider.id}
                            onClick=${() => openEndpointForm(provider.id)}
                        >
                            Edit
                        </button>
                        <button
                            class="button small ghost"
                            onClick=${() =>
                                removeCustomProvider(
                                    custom.list.find((endpoint) => endpoint.id === provider.id),
                                    endpointSaved,
                                )}
                        >
                            Remove
                        </button>`
                }
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
                    !customIds.has(provider.id) &&
                    html`<button
                        class="button small"
                        onClick=${(event) => login(provider, "api_key", event.currentTarget)}
                    >
                        API key
                    </button>`
                }
                ${
                    provider.configured &&
                    provider.source === "stored" &&
                    html`<button class="button small ghost" onClick=${() => logout(provider)}>
                        Log out
                    </button>`
                }
            </div>`
        }
    </div>`;

    return html`<${Sheet}
        title="Providers"
        onClose=${closeSheet}
        className=${`providers-sheet ${owner ? "with-side" : ""}`}
    >
        <div class="providers-layout">
            ${
                owner &&
                html`<aside class="providers-side" aria-label="Subagent models">
                    <${SubagentModels}
                        names=${Object.fromEntries(
                            (providers ?? []).map((each) => [each.id, each.name]),
                        )}
                    />
                </aside>`
            }
            <div class="providers-main">
                ${auth && !authInList && html`<${AuthDialog} inline=${true} />`}
                ${owner && html`<${LimitWait} />`}
                <label class="search">
                    <${Icon} name="search" size=${16} />
                    <input
                        placeholder="Search providers"
                        value=${query}
                        onInput=${(event) => setQuery(event.currentTarget.value)}
                    />
                </label>
                ${providers === null && html`<${Loader} label="Loading providers" />`}
                ${
                    providers !== null &&
                    list.length === 0 &&
                    needle !== "" &&
                    html`<div class="launcher-empty" role="status">
                        <strong>No providers match “${query.trim()}”.</strong>
                        <button class="button" onClick=${() => setQuery("")}>Clear search</button>
                    </div>`
                }
                ${groups.map(
                    ([title, each]) => html`<section class="provider-group" key=${title}>
                        <div class="provider-group-top">
                            <h3 class="provider-group-head">
                                ${title} <span class="muted">${each.length}</span>
                            </h3>
                            ${title === noteGroup && note}
                        </div>
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
            // Under its row, the row comes to the top with it; above the list, it only needs to show.
            const item = ref.current?.closest(".provider-item");

            (item ?? ref.current)?.scrollIntoView({
                block: item ? "start" : "nearest",
                behavior: item ? "smooth" : "auto",
            });
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
                <button class="icon-button" aria-label="Close" onClick=${onClose}>
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
        title=${`Sign in: ${auth.providerName}`}
        onClose=${close}
        inline=${inline}
        focusKey=${`${auth.flowId}:${prompt?.id ?? auth.events.length}`}
    >
        ${(auth.done ? [] : auth.events).map((event) => {
            if (event.type === "auth_url") {
                return html`<div class="auth-event">
                    <a class="button primary wide" href=${event.url} target="_blank" rel="noopener">
                        Open the sign-in page
                    </a>
                    ${event.instructions && html`<p class="muted small">${event.instructions}</p>`}
                </div>`;
            }

            if (event.type === "device_code") {
                return html`<div class="auth-event">
                    <p>
                        Enter this code at <a href=${event.verificationUri} target="_blank" rel="noopener">${event.verificationUri}</a>
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
                            Continue
                        </button>
                    </div>
                </div>`)
        }
        ${!prompt && !auth.done && html`<${Loader} label="Waiting for the provider" />`}
        ${
            auth.done &&
            !auth.done.ok &&
            html`<div class="error-box">
                <p>${auth.done.details ? auth.done.error : "Sign-in did not finish. Try again."}</p>
                <details>
                    <summary>Details</summary>
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
                    Start again
                </button>
            </div>`
        }
    <//>`;
}
