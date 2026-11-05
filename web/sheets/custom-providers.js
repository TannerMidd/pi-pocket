// OpenAI-compatible endpoints in the Providers sheet: the "OpenAI Compatible" row adds one with a
// URL and a key, its models picked from what the endpoint lists (GET /models) or typed by hand;
// each endpoint's own row edits or removes it. Each chosen model says whether it sees images and
// the thinking levels it has. The server keeps each in Pi's models.json, and its key in Pi's
// sign-ins.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, attempt, notify, store } from "../store.js";
import { html, Icon, MODEL_SEARCH_AT } from "../ui.js";

/** Pi's thinking levels, in order, with their names in the app. */
const LEVELS = [
    ["off", "Off"],
    ["minimal", "Minimal"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "Extra high"],
    ["max", "Max"],
];
const LEVEL_NAMES = new Map(LEVELS);
/** The levels a model gets when thinking is turned on, each sending its own name. */
const DEFAULT_TIERS = ["low", "medium", "high", "xhigh", "max"].map((level) => ({
    level,
    value: level,
}));
const order = (tiers) => LEVELS.flatMap(([level]) => tiers.filter((tier) => tier.level === level));

/** What a model's Thinking button says: off, or its levels from first to last. */
function tierSummary(thinking) {
    if (!Array.isArray(thinking) || thinking.length === 0) {
        return "No thinking";
    }

    const first = LEVEL_NAMES.get(thinking[0]?.level);
    const last = LEVEL_NAMES.get(thinking.at(-1)?.level);

    return thinking.length === 1 ? `Thinking: ${first}` : `Thinking: ${first} to ${last}`;
}

/**
 * A model's thinking levels: each is one of Pi's levels and the value sent to the endpoint for it (its
 * `reasoning_effort`), which a model may name its own way. Levels can be added, removed, and changed.
 */
function ThinkingLevels({ id, thinking, onChange }) {
    const used = new Set((thinking ?? []).map((tier) => tier.level));
    const free = LEVELS.filter(([level]) => !used.has(level));
    const set = (index, patch) =>
        onChange(order(thinking.map((tier, at) => (at === index ? { ...tier, ...patch } : tier))));

    return html`<div class="model-thinking" role="group" aria-label=${`Thinking levels of ${id}`}>
        <label class="check model-thinking-on">
            <input
                type="checkbox"
                checked=${thinking !== null}
                onChange=${(event) => onChange(event.currentTarget.checked ? DEFAULT_TIERS : null)}
            />
            It thinks (reasoning)
        </label>
        ${
            thinking !== null &&
            html`<p class="muted small">
                    Each level in the model menu, and the value it sends the endpoint as its
                    reasoning effort.
                </p>
                <div class="model-tiers">
                    ${thinking.map(
                        (tier, index) => html`<div class="model-tier" key=${tier.level}>
                            <select
                                aria-label="Level"
                                value=${tier.level}
                                onChange=${(event) =>
                                    set(index, { level: event.currentTarget.value })}
                            >
                                ${LEVELS.filter(
                                    ([level]) => level === tier.level || !used.has(level),
                                ).map(
                                    ([level, name]) =>
                                        html`<option value=${level}>${name}</option>`,
                                )}
                            </select>
                            <input
                                class="mono"
                                aria-label=${`Value sent for ${LEVEL_NAMES.get(tier.level)}`}
                                value=${tier.value}
                                maxlength="64"
                                autocomplete="off"
                                placeholder=${tier.level === "off" ? "Nothing" : tier.level}
                                onInput=${(event) => set(index, { value: event.currentTarget.value })}
                            />
                            <button
                                class="icon-button"
                                aria-label=${`Remove ${LEVEL_NAMES.get(tier.level)}`}
                                disabled=${thinking.length === 1}
                                onClick=${() => onChange(thinking.filter((_, at) => at !== index))}
                            >
                                <${Icon} name="close" size=${14} />
                            </button>
                        </div>`,
                    )}
                </div>
                <div class="row model-tier-buttons">
                    <button
                        class="button small"
                        disabled=${free.length === 0}
                        onClick=${() =>
                            onChange(
                                order([
                                    ...thinking,
                                    {
                                        level: free[0][0],
                                        value: free[0][0] === "off" ? "" : free[0][0],
                                    },
                                ]),
                            )}
                    >
                        <${Icon} name="plus" size=${14} />
                        Add level
                    </button>
                    <button class="button small ghost" onClick=${() => onChange(DEFAULT_TIERS)}>
                        Defaults
                    </button>
                </div>`
        }
    </div>`;
}

/** A model's tiers are ready to save: each level but off sends something. */
const tiersReady = (thinking) =>
    thinking === null || thinking.every((tier) => tier.level === "off" || tier.value.trim() !== "");

/** The form that adds an endpoint (`editing` undefined) or changes one. */
export function EndpointForm({ editing, onDone, onCancel }) {
    const [name, setName] = useState(editing?.name ?? "");
    const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
    const [apiKey, setApiKey] = useState("");
    const [noKey, setNoKey] = useState(editing?.key === "none");
    // The models chosen, in order, and what the endpoint listed (with context windows, and what the
    // model can do, when it said them).
    const [chosen, setChosen] = useState((editing?.models ?? []).map((model) => model.id));
    // What each model can do, by id: it sees images, and its thinking levels (null: it does not think).
    const [caps, setCaps] = useState(
        () =>
            new Map(
                (editing?.models ?? []).map((model) => [
                    model.id,
                    // A server from before these fields sends neither: no images, no thinking.
                    {
                        images: model.images === true,
                        thinking: Array.isArray(model.thinking) ? model.thinking : null,
                    },
                ]),
            ),
    );
    // The model whose thinking levels are open.
    const [open, setOpen] = useState(null);
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

    // A model the endpoint said can see images or think starts with them on.
    const capsOf = (id) => {
        const said = (listed ?? []).find((model) => model.id === id);

        return (
            caps.get(id) ?? {
                images: said?.images === true,
                thinking: said?.reasoning === true ? DEFAULT_TIERS : null,
            }
        );
    };

    const setCap = (id, patch) =>
        setCaps((was) => new Map(was).set(id, { ...capsOf(id), ...patch }));
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

        const models = chosen.map((id) => {
            const { images, thinking } = capsOf(id);

            return {
                id,
                ...(windows.get(id) === undefined ? {} : { contextWindow: windows.get(id) }),
                images,
                thinking:
                    thinking === null
                        ? null
                        : thinking.map((tier) => ({ ...tier, value: tier.value.trim() })),
            };
        });
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
        chosen.every((id) => tiersReady(capsOf(id).thinking)) &&
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
                        ${shown.map((id) => {
                            const on = chosen.includes(id);
                            const { images, thinking } = capsOf(id);

                            return html`<div
                                class=${`custom-endpoint-model ${on ? "chosen" : ""}`}
                                key=${id}
                            >
                                <div class="custom-endpoint-model-row">
                                    <label class="check custom-endpoint-model-name">
                                        <input
                                            type="checkbox"
                                            checked=${on}
                                            onChange=${(event) =>
                                                toggle(id, event.currentTarget.checked)}
                                        />
                                        <span class="mono">${id}</span>
                                    </label>
                                    ${
                                        on &&
                                        html`<div class="custom-endpoint-model-caps">
                                            <label class="check">
                                                <input
                                                    type="checkbox"
                                                    checked=${images}
                                                    onChange=${(event) =>
                                                        setCap(id, {
                                                            images: event.currentTarget.checked,
                                                        })}
                                                />
                                                Images
                                            </label>
                                            <button
                                                class=${`button small model-thinking-button ${thinking === null ? "" : "on"}`}
                                                aria-expanded=${open === id ? "true" : "false"}
                                                onClick=${() => setOpen(open === id ? null : id)}
                                            >
                                                ${tierSummary(thinking)}
                                                <${Icon}
                                                    name=${open === id ? "up" : "down"}
                                                    size=${14}
                                                />
                                            </button>
                                        </div>`
                                    }
                                </div>
                                ${
                                    on &&
                                    open === id &&
                                    html`<${ThinkingLevels}
                                        id=${id}
                                        thinking=${thinking}
                                        onChange=${(next) => setCap(id, { thinking: next })}
                                    />`
                                }
                            </div>`;
                        })}
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
