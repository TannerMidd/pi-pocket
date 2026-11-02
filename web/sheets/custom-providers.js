// OpenAI-compatible endpoints in the Providers sheet: the owner adds one with a URL and a key, picks its models from
// what the endpoint lists (GET /models) or types their IDs, and edits or removes it later. The server keeps each in
// Pi's models.json, and its key in Pi's sign-ins.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, notify } from "../store.js";
import { html, Icon } from "../ui.js";

/** Models past this many get a box to find them by. */
const MODEL_SEARCH_AT = 8;

const KEY_WORDS = {
    stored: "key in Pi's sign-ins",
    file: "key in models.json",
    none: "no key",
    missing: "no key set",
};

/** The form that adds an endpoint (`editing` undefined) or changes one. */
function EndpointForm({ editing, onDone, onCancel }) {
    const [name, setName] = useState(editing?.name ?? "");
    const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
    const [apiKey, setApiKey] = useState("");
    const [noKey, setNoKey] = useState(editing?.key === "none");
    // The models chosen, in order, and what the endpoint listed (with context windows, when it said them).
    const [chosen, setChosen] = useState(editing?.models ?? []);
    const [listed, setListed] = useState(null);
    const [typed, setTyped] = useState("");
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState("");
    const [problem, setProblem] = useState("");

    const windows = new Map((listed ?? []).map((model) => [model.id, model.contextWindow]));
    const toggle = (id, on) =>
        setChosen((was) =>
            on ? [...was.filter((each) => each !== id), id] : was.filter((each) => each !== id),
        );

    const discover = async () => {
        setBusy("discover");
        setProblem("");

        try {
            const answer = await api("custom-providers/discover", {
                baseUrl,
                ...(noKey ? {} : { apiKey }),
                ...(editing ? { id: editing.id } : {}),
            });

            setListed(answer.models);

            if (answer.models.length === 0) {
                setProblem("The endpoint lists no models. Add model IDs by hand.");
            }
        } catch (error) {
            setProblem(error.message ?? String(error));
        } finally {
            setBusy("");
        }
    };

    const addTyped = () => {
        const ids = typed
            .split(/[\s,]+/)
            .map((each) => each.trim())
            .filter(Boolean);

        if (ids.length > 0) {
            setChosen((was) => [...was, ...ids.filter((id) => !was.includes(id))]);
            setTyped("");
        }
    };

    const save = async () => {
        setBusy("save");
        setProblem("");

        const models = chosen.map((id) =>
            windows.get(id) === undefined ? { id } : { id, contextWindow: windows.get(id) },
        );
        const body = {
            name,
            baseUrl,
            models,
            ...(noKey ? { noKey: true } : apiKey.trim() === "" ? {} : { apiKey }),
        };

        try {
            const saved = editing
                ? await api(`custom-providers/${encodeURIComponent(editing.id)}`, body, {
                      method: "PUT",
                  })
                : await api("custom-providers", body);

            notify("info", `${saved.name}: ${saved.models.length} models saved.`);
            onDone();
        } catch (error) {
            setProblem(error.message ?? String(error));
        } finally {
            setBusy("");
        }
    };

    const needle = query.trim().toLowerCase();
    // Listed models, then any chosen one the endpoint did not list (typed, or kept from before).
    const rows = [
        ...(listed ?? []).map((model) => model.id),
        ...chosen.filter((id) => !(listed ?? []).some((model) => model.id === id)),
    ];
    const shown = rows.filter((id) => needle === "" || id.toLowerCase().includes(needle));
    const ready =
        name.trim() !== "" &&
        baseUrl.trim() !== "" &&
        (noKey || apiKey.trim() !== "" || editing !== undefined) &&
        busy === "";

    return html`<section class="auth-inline custom-endpoint-form" aria-label=${editing ? `Edit ${editing.name}` : "Add an OpenAI-compatible endpoint"}>
        <div class="auth-inline-head">
            <strong>${editing ? `Edit ${editing.name}` : "OpenAI-compatible endpoint"}</strong>
            <button class="icon-button" aria-label="Close" onClick=${onCancel}>
                <${Icon} name="close" size=${16} />
            </button>
        </div>
        <div class="auth-card">
            <label class="field">
                <span class="label">Name</span>
                <input
                    value=${name}
                    placeholder="LM Studio"
                    maxlength="80"
                    onInput=${(event) => setName(event.currentTarget.value)}
                />
            </label>
            <label class="field">
                <span class="label">Base URL</span>
                <input
                    value=${baseUrl}
                    type="url"
                    inputmode="url"
                    autocomplete="off"
                    placeholder="http://localhost:1234/v1"
                    onInput=${(event) => setBaseUrl(event.currentTarget.value)}
                />
            </label>
            <label class="field">
                <span class="label">
                    API key${editing && editing.key !== "none" && editing.key !== "missing" ? " (empty keeps the saved one)" : ""}
                </span>
                <input
                    type="password"
                    autocomplete="off"
                    value=${apiKey}
                    disabled=${noKey}
                    placeholder=${noKey ? "No key" : "sk-…"}
                    onInput=${(event) => setApiKey(event.currentTarget.value)}
                />
            </label>
            <label class="check">
                <input
                    type="checkbox"
                    checked=${noKey}
                    onChange=${(event) => setNoKey(event.currentTarget.checked)}
                />
                No key (a local server)
            </label>
            <div class="field">
                <div class="custom-endpoint-models-head">
                    <span class="label">Models · ${chosen.length} chosen</span>
                    <button
                        class="button small"
                        disabled=${baseUrl.trim() === "" || busy !== ""}
                        onClick=${discover}
                    >
                        <${Icon} name="reload" size=${14} />
                        ${busy === "discover" ? "Asking…" : listed === null ? "Find models" : "Find again"}
                    </button>
                </div>
                ${
                    rows.length > MODEL_SEARCH_AT &&
                    html`<label class="search">
                        <${Icon} name="search" size=${16} />
                        <input
                            placeholder="Find a model"
                            aria-label="Find a model of this endpoint"
                            value=${query}
                            onInput=${(event) => setQuery(event.currentTarget.value)}
                        />
                    </label>`
                }
                ${
                    rows.length > 0 &&
                    html`<div class="custom-endpoint-models" role="group" aria-label="Models to add">
                        ${shown.map(
                            (id) => html`<label class="check custom-endpoint-model" key=${id}>
                                <input
                                    type="checkbox"
                                    checked=${chosen.includes(id)}
                                    onChange=${(event) => toggle(id, event.currentTarget.checked)}
                                />
                                <span class="mono">${id}</span>
                            </label>`,
                        )}
                        ${shown.length === 0 && html`<p class="muted small">No model matches.</p>`}
                    </div>`
                }
                <div class="row">
                    <input
                        value=${typed}
                        autocomplete="off"
                        aria-label="Model ID"
                        placeholder="Add a model ID by hand"
                        onInput=${(event) => setTyped(event.currentTarget.value)}
                        onKeyDown=${(event) => event.key === "Enter" && addTyped()}
                    />
                    <button class="button small" disabled=${typed.trim() === ""} onClick=${addTyped}>
                        Add
                    </button>
                </div>
            </div>
            ${problem && html`<p class="warn small" role="alert">${problem}</p>`}
            <div class="row custom-endpoint-buttons">
                <button class="button ghost" onClick=${onCancel}>Cancel</button>
                <button class="button primary" disabled=${!ready} onClick=${save}>
                    ${busy === "save" ? "Saving…" : "Save"}
                </button>
            </div>
        </div>
    </section>`;
}

/**
 * The owner's OpenAI-compatible endpoints: each with its URL and models, Edit and Remove, and a button that adds one.
 * `onChanged` reloads the sheet's providers.
 */
export function CustomProviders({ onChanged }) {
    const [list, setList] = useState(null);
    // "new", an endpoint's id, or null: which form is open.
    const [open, setOpen] = useState(null);
    const load = () =>
        attempt(async () => {
            setList(await api("custom-providers"));
        });

    useEffect(() => {
        load();
    }, []);

    if (list === null) {
        return null;
    }

    const done = () => {
        setOpen(null);
        load();
        onChanged?.();
    };

    const remove = (endpoint) =>
        confirm(
            `Remove ${endpoint.name}? Its models leave Pi's models.json, and its key leaves Pi's sign-ins.`,
        ) &&
        attempt(async () => {
            await api(`custom-providers/${encodeURIComponent(endpoint.id)}`, undefined, {
                method: "DELETE",
            });
            done();
        });

    return html`<section class="provider-group custom-endpoints">
        <h3 class="provider-group-head">
            OpenAI-compatible endpoints <span class="muted">${list.length}</span>
        </h3>
        ${
            list.length > 0 &&
            html`<div class="sheet-list">
                ${list.map(
                    (endpoint) => html`<div class="provider" key=${endpoint.id}>
                        <div class="provider-info">
                            <div class="provider-name">${endpoint.name}</div>
                            <div class="muted small provider-why">
                                <span class="mono">${endpoint.baseUrl}</span> · ${endpoint.models.length} models ·
                                ${" "}${KEY_WORDS[endpoint.key]}
                            </div>
                        </div>
                        <div class="provider-actions">
                            <button
                                class="button small"
                                onClick=${() => setOpen(open === endpoint.id ? null : endpoint.id)}
                            >
                                Edit
                            </button>
                            <button class="button small ghost" onClick=${() => remove(endpoint)}>
                                Remove
                            </button>
                        </div>
                    </div>`,
                )}
            </div>`
        }
        ${
            open !== null &&
            html`<${EndpointForm}
                key=${open}
                editing=${list.find((endpoint) => endpoint.id === open)}
                onDone=${done}
                onCancel=${() => setOpen(null)}
            />`
        }
        ${
            open === null &&
            html`<button class="button wide" onClick=${() => setOpen("new")}>
                <${Icon} name="plus" size=${16} /> Add OpenAI-compatible endpoint
            </button>`
        }
    </section>`;
}
