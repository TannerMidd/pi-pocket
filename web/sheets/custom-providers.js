// OpenAI-compatible endpoints in the Providers sheet: the "OpenAI Compatible" row adds one with a
// URL and a key, its models picked from what the endpoint lists (GET /models) or typed by hand;
// each endpoint's own row edits or removes it. Each chosen model says whether it sees images, the
// thinking levels it has, its context window and maximum output, and its price. The server keeps
// each in Pi's models.json, and its key in Pi's sign-ins.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, attempt, notify, store } from "../store.js";
import { formatTokens, html, Icon, MODEL_SEARCH_AT } from "../ui.js";

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

/** The parts of a model's price, in dollars per million tokens, with their names in the form. */
const PRICES = [
    ["input", "Input"],
    ["output", "Output"],
    ["cacheRead", "Cache read"],
    ["cacheWrite", "Cache write"],
];
/** The most tokens and dollars the server takes. */
const MAX_TOKENS = 1_000_000_000;
const MAX_PRICE = 1_000_000;

/** A number as its field shows it, every digit and no exponent (0.0000003, not 3e-7): empty when there is none. */
const shown = (value) =>
    typeof value === "number"
        ? value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 })
        : "";

/** What a model's fields start with: its context window, maximum output, and price, as text. */
const limitsText = (model) => ({
    contextWindow: shown(model?.contextWindow),
    maxTokens: shown(model?.maxTokens),
    cost: Object.fromEntries(PRICES.map(([part]) => [part, shown(model?.cost?.[part])])),
});

/** A count of tokens from its field: null when empty (Pi's default), NaN when it is not one. */
function tokensFrom(text) {
    const trimmed = text.trim();

    if (trimmed === "") {
        return null;
    }

    const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;

    return value >= 1 && value <= MAX_TOKENS ? value : Number.NaN;
}

/** Dollars from a price field: a plain number (3, 0.15, .5), NaN when it is not one. */
const amountFrom = (text) =>
    /^(\d+(\.\d*)?|\.\d+)$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;

/** A price from its fields: null when all are empty (the model costs nothing); a cache part left empty is 0. */
const priceFrom = (cost) =>
    PRICES.every(([part]) => cost[part].trim() === "")
        ? null
        : Object.fromEntries(
              PRICES.map(([part]) => [part, cost[part].trim() === "" ? 0 : amountFrom(cost[part])]),
          );

/** What is wrong with a model's context window, maximum output, or price; empty when nothing is. */
function limitsProblem({ contextWindow, maxTokens, cost }) {
    if (Number.isNaN(tokensFrom(contextWindow))) {
        return "The context window is a whole number of tokens.";
    }

    if (Number.isNaN(tokensFrom(maxTokens))) {
        return "The maximum output is a whole number of tokens.";
    }

    const price = priceFrom(cost);

    if (price === null) {
        return "";
    }

    if (cost.input.trim() === "" || cost.output.trim() === "") {
        return "A price needs its input and output dollars.";
    }

    return Object.values(price).every((each) => each >= 0 && each <= MAX_PRICE)
        ? ""
        : "A price is a plain number of dollars per million tokens, like 0.15.";
}

/** A price as its button shows it: 3, 0.15, 0.075, 0.0003. */
const dollars = (value) => shown(Number(value < 0.1 ? value.toPrecision(2) : value.toFixed(2)));

/** Whether any of a model's context, output, or price fields has something in it. */
const limitsSet = ({ contextWindow, maxTokens, cost }) =>
    [contextWindow, maxTokens, ...Object.values(cost)].some((each) => each.trim() !== "");

/** What a model's Context and price button says: what is set, or that nothing is. */
function limitsSummary(limits) {
    const window = tokensFrom(limits.contextWindow);
    const price = limitsProblem(limits) === "" ? priceFrom(limits.cost) : null;
    const parts = [
        ...(window > 0 ? [`${formatTokens(window)} context`] : []),
        ...(price === null ? [] : [`$${dollars(price.input)}/$${dollars(price.output)}`]),
    ];

    return parts.length === 0 ? "Context & price" : parts.join(" · ");
}

/**
 * A model's context window and maximum output, in tokens, and its price, in dollars per million tokens. An empty token
 * field is Pi's default; an empty price is no price, so the model costs nothing.
 */
function ModelLimits({ id, limits, onChange }) {
    const problem = limitsProblem(limits);
    const tokens = (field, label, fallback) => html`<label class="field">
        <span class="label">${label}</span>
        <input
            inputmode="numeric"
            autocomplete="off"
            spellcheck="false"
            value=${limits[field]}
            placeholder=${fallback}
            onInput=${(event) => onChange({ [field]: event.currentTarget.value })}
        />
    </label>`;

    return html`<div class="model-limits" role="group" aria-label=${`Context and price of ${id}`}>
        <div class="model-limits-grid">
            ${tokens("contextWindow", "Context window", "128000")}
            ${tokens("maxTokens", "Max output", "16384")}
        </div>
        <p class="muted small">
            In tokens. Empty uses Pi's default (128k and 16k). The context meter and compaction go by
            the context window. Each request asks for up to the max output, so keep it at or below
            what the endpoint allows.
        </p>
        <span class="label">Price in dollars per million tokens</span>
        <div class="model-limits-grid">
            ${PRICES.map(
                ([part, label]) => html`<label class="field" key=${part}>
                    <span class="label">${label}</span>
                    <input
                        inputmode="decimal"
                        autocomplete="off"
                        spellcheck="false"
                        value=${limits.cost[part]}
                        placeholder=${part === "input" || part === "output" ? "" : "0"}
                        onInput=${(event) =>
                            onChange({
                                cost: { ...limits.cost, [part]: event.currentTarget.value },
                            })}
                    />
                </label>`,
            )}
        </div>
        <p class="muted small">
            Pi counts what each message costs, and spend limits use it. Empty: the model costs
            nothing.
        </p>
        ${problem && html`<p class="warn small" role="alert">${problem}</p>`}
    </div>`;
}

/** The form that adds an endpoint (`editing` undefined) or changes one. */
export function EndpointForm({ editing, onDone, onCancel }) {
    const [name, setName] = useState(editing?.name ?? "");
    const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
    const [apiKey, setApiKey] = useState("");
    const [noKey, setNoKey] = useState(editing?.key === "none");
    // The models chosen, in order, and what the endpoint listed (with context windows, and what the
    // model can do, when it said them).
    const [chosen, setChosen] = useState((editing?.models ?? []).map((model) => model.id));
    // What each model is, by id: it sees images, its thinking levels (null: it does not think), and
    // its context window, maximum output, and price, as their fields' text.
    const [caps, setCaps] = useState(
        () =>
            new Map(
                (editing?.models ?? []).map((model) => [
                    model.id,
                    // A server from before these fields sends none: no images, no thinking, Pi's
                    // defaults, no price.
                    {
                        images: model.images === true,
                        thinking: Array.isArray(model.thinking) ? model.thinking : null,
                        ...limitsText(model),
                    },
                ]),
            ),
    );
    // The panel open under a model: its thinking levels, or its context and price.
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

    // A new model starts with what the endpoint said of it: images, thinking, and a vLLM context
    // window. Its maximum output and price are typed by hand.
    const capsOf = (id) => {
        const said = (listed ?? []).find((model) => model.id === id);

        return (
            caps.get(id) ?? {
                images: said?.images === true,
                thinking: said?.reasoning === true ? DEFAULT_TIERS : null,
                ...limitsText(said),
            }
        );
    };

    const toggleOpen = (panel) => setOpen(open === panel ? null : panel);

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
            const { images, thinking, contextWindow, maxTokens, cost } = capsOf(id);

            return {
                id,
                images,
                thinking:
                    thinking === null
                        ? null
                        : thinking.map((tier) => ({ ...tier, value: tier.value.trim() })),
                contextWindow: tokensFrom(contextWindow),
                maxTokens: tokensFrom(maxTokens),
                cost: priceFrom(cost),
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
    const matching = rows.filter((id) => needle === "" || id.toLowerCase().includes(needle));
    const ready =
        name.trim() !== "" &&
        baseUrl.trim() !== "" &&
        (noKey || apiKey.trim() !== "" || editing !== undefined) &&
        chosen.every((id) => tiersReady(capsOf(id).thinking) && limitsProblem(capsOf(id)) === "") &&
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
                        ${matching.map((id) => {
                            const on = chosen.includes(id);
                            const model = capsOf(id);
                            const { images, thinking } = model;
                            const thinkingPanel = `thinking ${id}`;
                            const limitsPanel = `limits ${id}`;
                            const limitsBad = limitsProblem(model) !== "";

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
                                                aria-expanded=${open === thinkingPanel ? "true" : "false"}
                                                onClick=${() => toggleOpen(thinkingPanel)}
                                            >
                                                ${tierSummary(thinking)}
                                                <${Icon}
                                                    name=${open === thinkingPanel ? "up" : "down"}
                                                    size=${14}
                                                />
                                            </button>
                                            <button
                                                class=${`button small model-thinking-button ${limitsBad ? "bad" : limitsSet(model) ? "on" : ""}`}
                                                aria-expanded=${open === limitsPanel ? "true" : "false"}
                                                onClick=${() => toggleOpen(limitsPanel)}
                                            >
                                                ${limitsSummary(model)}
                                                <${Icon}
                                                    name=${open === limitsPanel ? "up" : "down"}
                                                    size=${14}
                                                />
                                            </button>
                                        </div>`
                                    }
                                </div>
                                ${
                                    on &&
                                    open === thinkingPanel &&
                                    html`<${ThinkingLevels}
                                        id=${id}
                                        thinking=${thinking}
                                        onChange=${(next) => setCap(id, { thinking: next })}
                                    />`
                                }
                                ${
                                    on &&
                                    open === limitsPanel &&
                                    html`<${ModelLimits}
                                        id=${id}
                                        limits=${model}
                                        onChange=${(patch) => setCap(id, patch)}
                                    />`
                                }
                            </div>`;
                        })}
                        ${matching.length === 0 && html`<p class="muted small">No model matches.</p>`}
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
