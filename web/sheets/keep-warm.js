// Keep warm: the owner's settings for keeping a session's prompt cache warm once its run ends, and the row a session
// chooses its own time with.
import { useEffect, useRef, useState } from "preact/hooks";
import { actions, api, attempt, canSteer, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet, Switch } from "../ui.js";

/** The times on offer: off, hours (0.5: 30 minutes), or Break-even. The server takes these only. */
const TIMES = [
    [0, "Off"],
    [0.5, "30 min"],
    [1, "1 h"],
    [2, "2 h"],
    [4, "4 h"],
    [8, "8 h"],
    ["break-even", "Break-even"],
];

/** This tab's keep-warm saves, sent one after another so answers arrive in the order asked. */
let saving = Promise.resolve();

function queueSave(action) {
    const next = saving.then(action);

    saving = next.catch(() => {});

    return next;
}

/** What Break-even means, said the same way wherever it can be chosen. */
const BREAK_EVEN =
    "Keeps the cache warm until the refreshes and the next cache read cost as much as writing the cache once more, then stops.";

/**
 * Fixed list prices per million tokens (2026-11-02), not fetched from a provider. Each example uses a 150k context.
 * The write is Pi's listed cache write: input × 1.25 (Claude's 5-minute tier, GPT-6.1 Sol), and input × 2 for
 * Claude's 1-hour tier, as `writePrice` in src/server/model-cache-facts.ts counts it.
 */
const EXAMPLES = [
    { name: "Claude Opus 5.5", input: 4, read: 0.2, writeMultiplier: 2, cacheMinutes: 60 },
    { name: "Claude Opus 5.5", input: 4, read: 0.2, writeMultiplier: 1.25, cacheMinutes: 5 },
    { name: "GPT-6.1 Sol", input: 2, read: 0.1, writeMultiplier: 1.25, cacheMinutes: 30 },
];

const money = (amount) =>
    amount >= 100
        ? `$${Math.round(amount)}`
        : amount >= 0.995 || Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-8
          ? `$${amount.toFixed(2)}`
          : `$${amount.toFixed(3)}`;

/** A span of time: "45 min", "1 h", "1 h 30 min", "2 d 4 h". */
function durationLabel(ms) {
    const minutes = Math.round(ms / 60_000);

    if (minutes < 60) {
        return `${Math.max(minutes, ms > 0 ? 1 : 0)} min`;
    }

    if (minutes >= 48 * 60) {
        const hours = Math.round(minutes / 60);

        return `${Math.floor(hours / 24)} d${hours % 24 === 0 ? "" : ` ${hours % 24} h`}`;
    }

    const rest = minutes % 60;

    return `${Math.floor(minutes / 60)} h${rest === 0 ? "" : ` ${rest} min`}`;
}

/** "1 refresh", "2 refreshes". */
const plural = (count) => `${count} ${count === 1 ? "refresh" : "refreshes"}`;

/** A keep-warm time in words: "Off", "30 min", "2 h", or "Break-even". */
function timeLabel(hours) {
    return TIMES.find(([value]) => value === hours)?.[1] ?? `${hours} h`;
}

/**
 * One fixed example under the current settings: refreshes, dollars, elapsed milliseconds, and one uncached prompt.
 * The interval and Break-even follow `idleEveryMs` and `breakEvenRefreshes`; the estimate also applies both caps.
 */
export function estimate(hours, settings, example = EXAMPLES[0]) {
    const cacheMs = example.cacheMinutes * 60_000;
    const everyMs = Math.floor(Math.min((cacheMs * settings.share) / 100, cacheMs - 10_000));
    const write = example.input * example.writeMultiplier;
    const perRefresh = (150_000 * example.read) / 1_000_000;
    const breakEven = Math.max(0, Math.floor(write / example.read) - 1);
    const asked = hours === "break-even" ? breakEven : Math.floor((hours * 3_600_000) / everyMs);
    const costCap = settings.maxCost === 0 ? Infinity : Math.floor(settings.maxCost / perRefresh);
    let refreshes = Math.max(0, Math.min(asked, settings.maxRefreshes, costCap));

    // A floating-point product must not cross a cap at an exact dollar boundary.
    if (settings.maxCost > 0 && refreshes * perRefresh > settings.maxCost) {
        refreshes--;
    }

    return {
        refreshes,
        cost: refreshes * perRefresh,
        lasts: refreshes * everyMs,
        uncached: (150_000 * example.input) / 1_000_000,
        everyMs,
        breakEven,
    };
}

/** The chosen time's estimate, under its row: what it does for the example model (Break-even's meaning first). */
function Estimate({ hours, settings }) {
    const { refreshes, cost, lasts, uncached, breakEven } = estimate(hours, settings);
    const example = `${EXAMPLES[0].name}, 150k context:`;
    let what;

    if (hours === 0) {
        what = html`once its cache expires, the next message costs about <b>${money(uncached)}</b>.`;
    } else if (hours === "break-even") {
        what = html`${plural(refreshes)} over about ${durationLabel(lasts)}, <b>${money(cost)}</b>. ${refreshes < breakEven ? "Your caps stop it sooner. " : ""}Without keep warm, the next message costs about <b>${money(uncached)}</b>.`;
    } else if (refreshes === 0) {
        what = html`<b>no refreshes</b> within this time and your caps. Its cache already lasts ${EXAMPLES[0].cacheMinutes} min.`;
    } else {
        what = html`about ${plural(refreshes)} over ${durationLabel(lasts)}, <b>${money(cost)}</b>. Without keep warm, the next message costs about <b>${money(uncached)}</b>.`;
    }

    return html`${hours === "break-even" && html`${BREAK_EVEN}<br />`}<span class="muted">${example}</span> ${what}`;
}

/** The menu row's hint: the owner's time. */
export function keepWarmHint() {
    const hours = store.state.server?.keepWarm?.hours;

    return hours === undefined ? "" : hours === 0 ? "off" : `after a run: ${timeLabel(hours)}`;
}

/** Resolve a session's choice against the owner's current default. */
function chosenTime(choice) {
    return choice === "default" ? store.state.server?.keepWarm?.hours : choice;
}

/** Whether keep warm is on for a session: its own time, or the owner's default, is not Off. */
export function keepWarmOn(conversation) {
    const choice = conversation?.keepWarm?.choice;
    const hours = store.state.server?.keepWarm?.hours;

    return choice !== undefined && hours !== undefined && chosenTime(choice) !== 0;
}

/** Whether this server keeps sessions warm once their run ends. */
export function keepWarmAvailable() {
    return store.state.server?.keepWarm !== undefined;
}

/** A number field that saves when it loses focus or Enter is pressed, and shows what the server kept. */
function NumberField({
    value,
    min,
    max,
    step = "1",
    label,
    placeholder = "",
    clearable = false,
    onSave,
    width = "4.5rem",
}) {
    const [draft, setDraft] = useState(null);
    const [invalid, setInvalid] = useState(false);
    const revision = useRef(0);
    const shown = draft ?? (value === undefined || value === null ? "" : String(value));

    const save = () => {
        if (draft === null) {
            return;
        }

        const text = draft.trim();
        const number = text === "" && clearable ? null : Number(text);

        if (
            (!clearable && text === "") ||
            (number !== null && (!Number.isFinite(number) || number < min || number > max))
        ) {
            setInvalid(true);

            return;
        }

        const edited = revision.current;

        setInvalid(false);
        attempt(async () => {
            await onSave(number);

            if (revision.current === edited) {
                setDraft(null);
            }
        });
    };

    return html`<span class="keep-warm-number-field">
        <input
            type="number"
            inputmode="decimal"
            class="keep-warm-number"
            style=${`width:${width}`}
            min=${min}
            max=${max}
            step=${step}
            aria-label=${label}
            aria-invalid=${invalid}
            placeholder=${placeholder}
            value=${shown}
            onInput=${(event) => {
                revision.current++;
                setDraft(event.currentTarget.value);
                setInvalid(false);
            }}
            onBlur=${save}
            onKeyDown=${(event) => event.key === "Enter" && event.currentTarget.blur()}
        />
        ${invalid && html`<span class="small warn" role="alert">Use a number from ${min} to ${max}</span>`}
    </span>`;
}

/** One model: its name and cache cost on one line, when its cache expires, and what keep warm does with it. */
function ModelCard({ model, settings, onSet }) {
    const { everyMs, refreshes, breakEvenStopMs } = model.plan;
    const own = settings.models[model.spec]?.lifetime;
    const read = model.known.read;
    const kept = everyMs !== undefined;

    return html`<div class="keep-warm-model">
        <div class="keep-warm-model-row">
            <span class="keep-warm-model-name" title=${model.spec}>${model.name}</span>
            <span class="keep-warm-model-value">
                <span class="muted small">Cache cost</span>
                ${
                    read === undefined
                        ? html`$<${NumberField}
                              value=${settings.models[model.spec]?.read}
                              min=${0}
                              max=${10_000}
                              step="any"
                              width="4.2rem"
                              label=${`Dollars per million tokens to read the cache of ${model.name}`}
                              placeholder="?"
                              clearable=${true}
                              onSave=${(value) => onSet("read", value)}
                          />`
                        : html`<b>${money(read)}</b>`
                }
                <span class="muted small">per million tokens</span>
            </span>
        </div>
        <label class="keep-warm-model-row">
            <span>Cache expires after</span>
            <span class="keep-warm-model-value">
                <${NumberField}
                    value=${own}
                    min=${1}
                    max=${10_080}
                    width="4.2rem"
                    label=${`Minutes until the cache of ${model.name} expires`}
                    placeholder=${model.known.lifetime === undefined ? "" : String(model.known.lifetime)}
                    clearable=${true}
                    onSave=${(value) => onSet("lifetime", value)}
                />
                <span class="muted small">minutes idle</span>
            </span>
        </label>
        <div class=${`keep-warm-model-note ${kept ? "" : "off"}`}>
            ${
                kept
                    ? `Refreshed every ${durationLabel(everyMs)} · Break-even after ${durationLabel(breakEvenStopMs)}, ${plural(refreshes)}`
                    : "Not kept warm: no published cache time. Type one to turn it on."
            }
        </div>
    </div>`;
}

/** The models, grouped by provider (each folded) and filtered without changing the owner's saved values. */
function KeepWarmModels({ models, settings, onSet }) {
    const [query, setQuery] = useState("");
    const needle = query.trim().toLowerCase();
    const groups = new Map();
    const known = models.filter((model) => model.plan.everyMs !== undefined).length;

    for (const model of models) {
        const provider = model.spec.slice(0, model.spec.indexOf("/"));

        if (needle === "" || `${model.spec} ${model.name}`.toLowerCase().includes(needle)) {
            groups.set(provider, [...(groups.get(provider) ?? []), model]);
        }
    }

    return html`<div class="keep-warm-models">
        <p class="muted small">
            Each model's cache cost, and how long its cache lasts once idle. Grey: the maker's published values; type your own to replace one, or clear it to go back.${" "}<span class="faint">${known} of ${models.length} with a known cache time</span>
        </p>
        <label class="search">
            <${Icon} name="search" size=${16} />
            <input
                placeholder="Find a model"
                aria-label="Find a model to keep warm"
                value=${query}
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
        </label>
        <div class="keep-warm-model-list" role="group" aria-label="Keep warm by model">
            ${
                groups.size === 0 &&
                html`<p class="muted small">
                ${models.length === 0 ? "No models: sign in to a provider first." : "No model matches."}
            </p>`
            }
            ${[...groups].map(([provider, list]) => {
                const known = list.filter((model) => model.plan.everyMs !== undefined).length;

                return html`<details class="keep-warm-provider" key=${provider} open=${needle !== ""}>
                    <summary>
                        <${Icon} name="chevron" size=${14} />
                        <span>${provider}</span>
                        <span class="muted small">${known} of ${list.length} with a known cache time</span>
                    </summary>
                    <div class="keep-warm-model-grid">
                        ${list.map(
                            (model) => html`<${ModelCard}
                                key=${model.spec}
                                model=${model}
                                settings=${settings}
                                onSet=${(field, value) => onSet(model.spec, field, value)}
                            />`,
                        )}
                    </div>
                </details>`;
            })}
        </div>
    </div>`;
}

/** Apply one pending change over the last answer without replacing another model's fields. */
function withSettings(settings, patch) {
    const next = { ...settings, ...patch, models: { ...settings.models } };

    for (const [spec, fields] of Object.entries(patch.models ?? {})) {
        const model = { ...next.models[spec] };

        for (const [field, value] of Object.entries(fields)) {
            if (value === null) {
                delete model[field];
            } else {
                model[field] = value;
            }
        }

        next.models[spec] = model;
    }

    return next;
}

/** The sheet's tabs, in order: the time, the caps, and the models. */
const TABS = [
    ["when", "When"],
    ["limits", "Limits"],
    ["models", "Models"],
];

/** A row's short estimate for one time: "2 refreshes · $0.06", "no refreshes", or for Off "next message $0.60". */
function shortEstimate(hours, settings) {
    const { refreshes, cost, uncached } = estimate(hours, settings);

    if (hours === 0) {
        return `next message ${money(uncached)}`;
    }

    return refreshes === 0 ? "no refreshes" : `${plural(refreshes)} · ${money(cost)}`;
}

/** Tabs move with Left and Right; radios with all four arrows. */
const TAB_KEYS = { ArrowLeft: -1, ArrowRight: 1 };
const RADIO_KEYS = { ...TAB_KEYS, ArrowUp: -1, ArrowDown: 1 };

/** The index an arrow key (or Home, End) moves to in `list`, wrapping round; null for other keys. */
function stepped(event, list, current, keys) {
    const index = list.indexOf(current);

    if (event.key === "Home") {
        return 0;
    }

    if (event.key === "End") {
        return list.length - 1;
    }

    return keys[event.key] === undefined
        ? null
        : (index + keys[event.key] + list.length) % list.length;
}

/** The settings window keeps later edits visible while each earlier save finishes. */
export function KeepWarmSheet() {
    const [data, setData] = useState(null);
    const [asked, setAsked] = useState([]);
    // Each opening starts on When: the tab is not kept.
    const [tab, setTab] = useState("when");

    useEffect(() => {
        attempt(async () => setData(await api("keep-warm")));
    }, []);

    const save = (patch) => {
        const change = { patch };

        setAsked((was) => [...was, change]);

        return queueSave(async () => {
            try {
                setData(await api("keep-warm", patch));
            } finally {
                setAsked((was) => was.filter((item) => item !== change));
            }
        });
    };

    if (data === null) {
        return html`<${Sheet} title="Keep warm" onClose=${closeSheet}>
            <${Loader} label="Loading" />
        <//>`;
    }

    const { models, now } = data;
    const settings = asked.reduce(
        (current, change) => withSettings(current, change.patch),
        data.settings,
    );
    const setModel = (spec, field, value) => save({ models: { [spec]: { [field]: value } } });
    const known = models.filter((model) => model.plan.everyMs !== undefined).length;
    const values = {
        when: timeLabel(settings.hours),
        limits: `${settings.maxCost === 0 ? "no $ cap" : money(settings.maxCost)} · ${settings.maxRefreshes}`,
        models: `${known} of ${models.length}`,
    };

    const onTabKey = (event) => {
        const next = stepped(
            event,
            TABS.map(([key]) => key),
            tab,
            TAB_KEYS,
        );

        if (next !== null) {
            event.preventDefault();
            setTab(TABS[next][0]);
            event.currentTarget.parentElement.children[next].focus();
        }
    };

    const tabs = html`<div class="keep-warm-tabs" role="tablist" aria-label="Keep warm settings">
        ${TABS.map(
            ([key, label]) => html`<button
                type="button"
                role="tab"
                id=${`keep-warm-tab-${key}`}
                class=${tab === key ? "on" : ""}
                aria-selected=${tab === key ? "true" : "false"}
                aria-controls=${`keep-warm-panel-${key}`}
                tabindex=${tab === key ? 0 : -1}
                onClick=${() => setTab(key)}
                onKeyDown=${onTabKey}
            >
                <span>${label}</span>
                <span class="keep-warm-tab-value">${values[key]}</span>
            </button>`,
        )}
    </div>`;

    const pickTime = (value) => value !== settings.hours && attempt(() => save({ hours: value }));

    const onTimeKey = (event) => {
        const next = stepped(
            event,
            TIMES.map(([value]) => value),
            settings.hours,
            RADIO_KEYS,
        );

        if (next !== null) {
            event.preventDefault();
            pickTime(TIMES[next][0]);
            event.currentTarget.parentElement.querySelectorAll('[role="radio"]')[next].focus();
        }
    };

    const times = html`<section class="keep-warm-times">
        <div class="group-title">After a run ends, keep sessions warm for</div>
        <div class="sheet-list" role="radiogroup" aria-label="How long to keep sessions warm">
            ${TIMES.map(([value, label]) => {
                const on = settings.hours === value;

                return html`<button
                        type="button"
                        role="radio"
                        key=${String(value)}
                        class=${`keep-warm-time ${on ? "on" : ""}`}
                        aria-checked=${on ? "true" : "false"}
                        aria-describedby=${on ? "keep-warm-chosen" : undefined}
                        tabindex=${on ? 0 : -1}
                        onClick=${() => pickTime(value)}
                        onKeyDown=${onTimeKey}
                    >
                        <span class="keep-warm-dot" aria-hidden="true"></span>
                        <span>${label}</span>
                        <span class="keep-warm-time-estimate">${shortEstimate(value, settings)}</span>
                    </button>
                    ${
                        on &&
                        html`<div class="keep-warm-chosen" id="keep-warm-chosen" key=${`${value} estimate`}>
                            <${Estimate} hours=${value} settings=${settings} />
                        </div>`
                    }`;
            })}
        </div>
    </section>`;

    const about = html`<div class="keep-warm-about">
        <p>
            Pocket sends the smallest possible request to keep the cache alive. This is cheaper than no
            cache, until you have paid what you would have paid anyway (Break-even).
        </p>
        <p>As a rule, keeping a session warm for 30 minutes to 3 hours saves money when you step away.</p>
        <p>
            Recommended: keep it on globally for 30 minutes for all sessions, or off globally and turn it on for one
            session at a time in the session menu.
        </p>
    </div>`;

    const examples = html`<section class="keep-warm-examples">
        <table class="keep-warm-stops">
            <thead>
                <tr>
                    <th scope="col">Model</th>
                    <th scope="col">Stops after</th>
                    <th scope="col">Keep warm</th>
                    <th scope="col">No cache</th>
                </tr>
            </thead>
            <tbody>
                ${EXAMPLES.map((example) => {
                    const { refreshes, cost, lasts, uncached } = estimate(
                        "break-even",
                        settings,
                        example,
                    );

                    return html`<tr key=${`${example.name} ${example.cacheMinutes}`}>
                        <th scope="row">
                            ${example.name}<span class="muted">${durationLabel(example.cacheMinutes * 60_000)} cache</span>
                        </th>
                        <td>${durationLabel(lasts)}<span class="muted">${refreshes} refreshes</span></td>
                        <td>${money(cost)}</td>
                        <td>${money(uncached)}</td>
                    </tr>`;
                })}
            </tbody>
        </table>
        <p class="faint small">
            Keep warm: what its refreshes cost until Break-even stops. No cache: one message after the cache
            expired. List prices on 2026-11-02, a 150k context, and your current Refresh at and caps. These are
            estimates only: they can be wrong.
        </p>
    </section>`;

    const like = html`<p class="faint small">
        Keep warm works like the pi-keepwarm extension for Pi: it sends the last request again, with the
        smallest reply, before the cache expires.
    </p>`;

    // Phones: what keep warm does, the times, the examples, and where it comes from. Wide sheets: the times on the
    // left; on the right what it does, the examples, and where it comes from.
    const when = html`<div class="keep-warm-when">
        ${times}
        <div class="keep-warm-when-side">${about}${examples}${like}</div>
    </div>`;

    // Phones: one column. Wide sheets: the session's caps on the left, the timing on the right.
    const limits = html`<div class="keep-warm-limits">
        <div class="sheet-list">
            <label class="keep-warm-row">
                <span class="keep-warm-row-label">
                    <span>Most it may spend</span>
                    <span class="muted">per session, subagents included; 0: no cap</span>
                </span>
                <span class="keep-warm-input">
                    $<${NumberField}
                        value=${settings.maxCost}
                        min=${0}
                        max=${1000}
                        step="any"
                        label="Most a session may spend on keeping warm, in dollars"
                        onSave=${(value) => value !== null && save({ maxCost: value })}
                    />
                </span>
            </label>
            <label class="keep-warm-row">
                <span class="keep-warm-row-label">
                    <span>Most refreshes</span>
                    <span class="muted">per conversation</span>
                </span>
                <${NumberField}
                    value=${settings.maxRefreshes}
                    min=${1}
                    max=${10000}
                    label="Most refreshes for a conversation"
                    onSave=${(value) => value !== null && save({ maxRefreshes: value })}
                />
            </label>
            <div class="keep-warm-row">
                <span class="keep-warm-row-label">
                    <span>Subagents too</span>
                    <span class="muted">Subagents inherit their parent session's keep warm.</span>
                </span>
                <${Switch}
                    on=${settings.subagents}
                    label="Keep subagents warm too"
                    onChange=${() => attempt(() => save({ subagents: !settings.subagents }))}
                />
            </div>
        </div>
        <div class="sheet-list">
            <label class="keep-warm-row">
                <span class="keep-warm-row-label">
                    <span>Refresh at</span>
                    <span class="muted">of the cache time</span>
                </span>
                <span class="keep-warm-input">
                    <${NumberField}
                        value=${settings.share}
                        min=${10}
                        max=${95}
                        width="3.6rem"
                        label="Share of a cache lifetime between refreshes, in percent"
                        onSave=${(value) => value !== null && save({ share: value })}
                    />%
                </span>
            </label>
        </div>
    </div>`;

    const panels = {
        when,
        limits,
        models: html`<${KeepWarmModels} models=${models} settings=${settings} onSet=${setModel} />`,
    };

    return html`<${Sheet} title="Keep warm" onClose=${closeSheet} className="keep-warm-sheet">
        ${tabs}
        <div class="keep-warm-scroll">
            ${
                now.warm > 0 &&
                html`<p class="small keep-warm-now">
                    <span class="pulse"></span> ${now.warm === 1 ? "1 session" : `${now.warm} sessions`} warm now ·${" "}
                    ${now.refreshes} ${now.refreshes === 1 ? "refresh" : "refreshes"} · ${money(now.spent)}
                </p>`
            }
            ${TABS.map(
                ([key]) => html`<div
                    class="keep-warm-panel"
                    role="tabpanel"
                    key=${key}
                    id=${`keep-warm-panel-${key}`}
                    aria-labelledby=${`keep-warm-tab-${key}`}
                    hidden=${tab !== key}
                >
                    ${panels[key]}
                </div>`,
            )}
        </div>
    <//>`;
}

/**
 * A session's keep warm, as a card: `compact` for the session menu (the flame turns it on and off, and the bar holds the
 * times), else the reply menu's fuller card (Off is the bar's first choice, and a line says what the time does).
 */
export function KeepWarmCard({ compact = false }) {
    const [pending, setPending] = useState(null);
    const asked = useRef(null);
    const { view, server } = store.state;
    const conversation = view.conversation;
    const state = conversation?.keepWarm;

    if (!state || server?.keepWarm === undefined || conversation.kind !== "session") {
        return null;
    }

    const steer = canSteer();
    const choice = pending?.id === conversation.id ? pending.choice : state.choice;

    const choose = (choice) => {
        const change = { id: conversation.id, choice };

        asked.current = change;
        setPending(change);
        attempt(() =>
            queueSave(async () => {
                try {
                    await actions.updateSession(change.id, { keepWarm: choice });

                    // The POST confirms this choice before the next view arrives. A later tap must stay selected.
                    if (
                        asked.current === change &&
                        store.state.view.conversation?.id === change.id
                    ) {
                        store.set((current) => ({
                            view: {
                                ...current.view,
                                conversation: {
                                    ...current.view.conversation,
                                    keepWarm: { ...current.view.conversation.keepWarm, choice },
                                },
                            },
                        }));
                    }
                } finally {
                    if (asked.current === change) {
                        asked.current = null;
                        setPending(null);
                    }
                }
            }),
        );
    };

    const status = state.status;
    const time = (at) =>
        new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const fallback = server.keepWarm.hours;
    const chosen = chosenTime(choice);
    const on = chosen !== 0;
    const warming = on && status.warm;
    // The same times as the owner's, the session's own (or the owner's default) selected. Picking the owner's default
    // follows it again ("default"), so a later change of the default reaches this session too.
    const valueOf = (value) => (value === fallback ? "default" : value);
    // Only the owner turns a session on or picks another time; anyone who can steer may turn it off, or back to the
    // default when the default is Off or is the session's time already (the server checks it too).
    const owner = store.state.me?.role === "owner";
    const allowed = (value) =>
        owner || value === 0 || (value === fallback && (fallback === 0 || chosen === fallback));

    const pick = (value) => {
        const current = asked.current?.id === conversation.id ? asked.current.choice : choice;

        if (current !== valueOf(value)) {
            choose(valueOf(value));
        }
    };

    // The flame turns it back on with the owner's default, or 30 minutes when the default is Off.
    const onAgain = fallback !== 0 ? fallback : 0.5;
    const hoursLabel = (hours) => (hours === 0.5 ? "30 min" : hours === 1 ? "1 h" : `${hours} h`);
    const what = !on
        ? "The cache expires on its own"
        : chosen === "break-even"
          ? "Until break-even"
          : `${hoursLabel(chosen)} after Pi finishes`;
    const details = warming
        ? html`Next <b>${time(status.nextAt)}</b> · <b>${status.refreshes}</b> of ${status.maxRefreshes} refreshes
              · <b>${money(status.spent)}</b>${status.until === undefined ? "" : html` · until <b>${time(status.until)}</b>`}`
        : status.stopped && on
          ? `Stopped: ${status.stopped}`
          : undefined;
    const flame = html`<${Icon} name="flame" size=${compact ? 17 : 18} stroke=${2} class=${warming ? "warming" : ""} />`;
    const tile = `keep-warm-flame ${on ? "" : "off"}`;
    const times = compact ? TIMES.slice(1) : TIMES;

    return html`<div class=${`keep-warm-card ${compact ? "compact" : ""}`}>
        <div class="keep-warm-card-head">
            ${
                compact
                    ? html`<button
                          type="button"
                          class=${tile}
                          aria-pressed=${on}
                          aria-label=${on ? "Turn keep warm off" : "Turn keep warm on"}
                          title=${on ? "Turn keep warm off" : "Turn keep warm on"}
                          disabled=${!steer || !allowed(on ? 0 : onAgain)}
                          onClick=${() => pick(on ? 0 : onAgain)}
                      >
                          ${flame}
                      </button>`
                    : html`<span class=${tile} aria-hidden="true">${flame}</span>`
            }
            <span class="keep-warm-card-title">
                <span>Keep this session warm</span>
                ${!compact && html`<span class="muted small">${what}</span>`}
            </span>
            <span class=${`keep-warm-pill ${on ? "" : "off"}`}>${!on ? "Off" : warming ? "Warming" : "On"}</span>
        </div>
        <div
            class=${`segmented keep-warm-bar ${compact && !on ? "dim" : ""}`}
            role="group"
            aria-label="How long to keep this session warm"
        >
            ${times.map(
                ([value, label]) => html`<button
                    type="button"
                    class=${chosen === value && (on || value === 0) ? "on" : ""}
                    aria-pressed=${chosen === value}
                    title=${value === fallback ? "The owner's default" : value === "break-even" ? BREAK_EVEN : ""}
                    disabled=${!steer || !allowed(value)}
                    onClick=${() => pick(value)}
                >
                    ${label}
                </button>`,
            )}
        </div>
        ${
            compact
                ? html`<div class="keep-warm-card-details">${details ?? what}</div>`
                : details && html`<div class="keep-warm-card-details">${details}</div>`
        }
    </div>`;
}
