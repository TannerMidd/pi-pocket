// OpenAI-compatible endpoints in the Providers sheet: the "OpenAI Compatible" row adds one with a
// URL and a key, its models picked from what the endpoint lists (GET /models) or typed by hand;
// each endpoint's own row edits or removes it. The server keeps each in Pi's models.json, and its
// key in Pi's sign-ins.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, attempt, notify, store } from "../store.js";
import { html, Icon, MODEL_SEARCH_AT } from "../ui.js";

/** The form that adds an endpoint (`editing` undefined) or changes one. */
export function EndpointForm({ editing, onDone, onCancel }) {
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
    const first = useRef(null);

    // The form opens under its row: the name is the first thing to fill in.
    useLayoutEffect(() => {
        first.current?.focus({ preventScroll: true });
        first.current
            ?.closest(".provider-item")
            ?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, []);

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
                // No key asks with none, not with the saved key.
                ...(editing && !noKey ? { id: editing.id } : {}),
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
    const keepsKey = editing && editing.key !== "none" && editing.key !== "missing";
    const findLabel =
        busy === "discover" ? "Asking…" : listed === null ? "Find models" : "Find again";

    return html`<section
        class="auth-inline custom-endpoint-form"
        aria-label=${editing ? `Edit ${editing.name}` : "Add an OpenAI-compatible endpoint"}
    >
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
                    ref=${first}
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
                    API key${keepsKey ? " (empty keeps the saved one)" : ""}
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
                        ${findLabel}
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
                    html`<div
                        class="custom-endpoint-models"
                        role="group"
                        aria-label="Models to add"
                    >
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
                    <button
                        class="button small"
                        disabled=${typed.trim() === ""}
                        onClick=${addTyped}
                    >
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

/** The owner's OpenAI-compatible endpoints, by id, and a way to load them again; null until they come. */
export function useCustomProviders(owner) {
    const [list, setList] = useState(null);
    const load = () =>
        owner
            ? attempt(async () => {
                  setList(await api("custom-providers"));
              })
            : undefined;

    // Also when the models change, as another tab's save changes them.
    useEffect(() => {
        load();
    }, [owner, store.state.models]);

    return { list, load };
}

/** Take an endpoint out of models.json and its key out of Pi's sign-ins, once the owner says so. */
export function removeCustomProvider(endpoint, done) {
    return (
        confirm(
            `Remove ${endpoint.name}? Its models leave Pi's models.json, ` +
                "and its key leaves Pi's sign-ins.",
        ) &&
        attempt(async () => {
            await api(`custom-providers/${encodeURIComponent(endpoint.id)}`, undefined, {
                method: "DELETE",
            });
            done();
        })
    );
}
