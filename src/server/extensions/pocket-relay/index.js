// Secrets never come to the browser: the form says only whether each one is set.
export const pocketApi = 1;

const ICON =
    "M4.9 16.1C1 12.2 1 5.8 4.9 1.9 M7.8 4.7a6.14 6.14 0 0 0-.8 7.5 M10 9a2 2 0 1 0 4 0 2 2 0 1 0-4 0 M16.2 4.8c2 2 2.26 5.11.8 7.47 M19.1 1.9a9.96 9.96 0 0 1 0 14.1 M9.5 18h5 M8 22l4-11 4 11";

const LIMITS = {
    name: 60,
    instructions: 2000,
    owners: 20,
    owner: 100,
    perHour: [1, 600],
    perAuthor: [1, 120],
};

const STATES = {
    off: { label: "Off", tone: "muted" },
    starting: { label: "Starting", tone: "busy" },
    running: { label: "Running", tone: "ok" },
    waiting: { label: "Waiting", tone: "warn" },
    failed: { label: "Failed", tone: "err" },
    stopped: { label: "Stopped", tone: "err" },
    "no-connector": { label: "Not available", tone: "err" },
};

const MEANS = {
    stopped: "It stopped on an error, such as a wrong token. Edit it to start it again.",
    "no-connector": "The part of Pi Pocket for this kind is not loaded.",
};

function ago(at) {
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));

    if (minutes < 1) {
        return "just now";
    }

    if (minutes < 60) {
        return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }

    const hours = Math.round(minutes / 60);

    if (hours < 48) {
        return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    }

    return `${Math.round(hours / 24)} days ago`;
}

const when = (at) => new Date(at).toLocaleString();

const idsOf = (text) =>
    text
        .split(/[\n,]/)
        .map((each) => each.trim())
        .filter((each) => each !== "");

const bodyOf = (connector, patch = {}) => ({
    name: connector.name,
    kind: connector.kind,
    enabled: connector.enabled,
    target: connector.target,
    instructions: connector.instructions,
    ownerIds: connector.ownerIds,
    mentionOnly: connector.mentionOnly,
    perHour: connector.perHour,
    perAuthor: connector.perAuthor,
    values: connector.values,
    ...patch,
});

function startValue(field, values) {
    const value = values?.[field.name] ?? field.default;

    if (field.type === "boolean") {
        return value === true;
    }

    if (field.type === "choice") {
        return value === undefined ? (field.choices?.[0]?.value ?? "") : String(value);
    }

    return value === undefined ? "" : String(value);
}

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    let data = null;
    let failure = null;
    let gone = false;
    const listeners = new Set();

    const menu = pocket.menu({ id: "relay", label: "Relay", sheet: "relay" });

    pocket.launcher({
        id: "relay",
        label: "Relay",
        detail: "Bring messages from Discord, Telegram, Slack, and more into a session",
        iconPath: ICON,
        keywords: ["relay", "connector", "discord", "telegram", "slack", "matrix", "rss", "bot"],
        sheet: "relay",
    });

    const told = () => {
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const publish = (next) => {
        if (gone) {
            return;
        }

        data = next;
        failure = null;

        const all = next.connectors;
        const broken = all.filter((each) =>
            ["failed", "stopped", "no-connector"].includes(each.status.state),
        ).length;
        const on = all.filter((each) => each.enabled).length;

        menu.update({ hint: broken > 0 ? `${broken} failed` : on > 0 ? `${on} on` : undefined });
        told();
    };

    const upsert = (connector) => {
        if (data === null) {
            return;
        }

        const known = data.connectors.some((each) => each.id === connector.id);

        publish({
            ...data,
            connectors: known
                ? data.connectors.map((each) => (each.id === connector.id ? connector : each))
                : [...data.connectors, connector],
        });
    };

    const drop = (id) => {
        if (data !== null) {
            publish({ ...data, connectors: data.connectors.filter((each) => each.id !== id) });
        }
    };

    // Only the newest load counts: an older answer that comes last would bring back an old list.
    let loads = 0;

    async function load() {
        const mine = ++loads;

        try {
            const answer = await pocket.api("connectors");

            if (mine === loads) {
                publish(answer);
            }
        } catch (error) {
            if (mine === loads && !gone) {
                failure = error.message;
                told();
            }
        }
    }

    void load();
    pocket.onDispose(pocket.on("changed", () => void load()));
    pocket.onDispose(
        pocket.on("status", (event) => {
            const connector = data?.connectors.find((each) => each.id === event?.id);

            if (connector && event.status) {
                upsert({ ...connector, status: event.status });
            }
        }),
    );

    // An event sent while the tab was away (asleep, or reconnecting) is lost: look again on return.
    const back = () => document.visibilityState === "visible" && void load();

    document.addEventListener("visibilitychange", back);
    pocket.onDispose(() => {
        gone = true;
        document.removeEventListener("visibilitychange", back);
    });

    function useData() {
        const [, bump] = useState(0);

        useEffect(() => {
            const listener = () => bump((n) => n + 1);
            const timer = setInterval(listener, 30_000);

            listeners.add(listener);

            return () => {
                listeners.delete(listener);
                clearInterval(timer);
            };
        }, []);

        return data;
    }

    const kindOf = (kind) => data?.kinds.find((each) => each.kind === kind);

    function sessionName(id) {
        const session = data?.sessions.find((each) => each.id === id);

        if (!session) {
            return `Session ${id} (gone)`;
        }

        return session.archived ? `${session.title} (archived)` : session.title;
    }

    function Chip({ status }) {
        const state = STATES[status.state] ?? { label: status.state, tone: "muted" };

        return html`<span class=${`relay-chip ${state.tone}`}>
            <span class="relay-dot" aria-hidden="true"></span>
            <span>${state.label}</span>
        </span>`;
    }

    function Status({ connector }) {
        const status = connector.status;
        const counts = [
            `${status.delivered} delivered`,
            `${status.dropped} dropped`,
            `${status.pending} pending`,
            ...(status.lastEventAt ? [`last message ${ago(status.lastEventAt)}`] : []),
        ].join(" · ");

        return html`<div class="relay-status">
            <div class="relay-status-line">
                <${Chip} status=${status} />
                ${status.text && html`<span class="relay-status-text">${status.text}</span>`}
            </div>
            ${MEANS[status.state] && html`<div class="muted small">${MEANS[status.state]}</div>`}
            ${
                status.lastError &&
                html`<div class="relay-error">
                    <div class="small">${status.lastError}</div>
                    ${
                        status.lastErrorAt &&
                        html`<div class="muted small" title=${when(status.lastErrorAt)}>
                            ${`Last error, ${ago(status.lastErrorAt)}`}
                        </div>`
                    }
                </div>`
            }
            <div class="muted small">${counts}</div>
        </div>`;
    }

    function Failed({ text }) {
        return html`<div class="relay-sheet">
            <div class="error-box">${text}</div>
            <div class="relay-buttons">
                <button class="button" onClick=${() => void load()}>Try again</button>
            </div>
        </div>`;
    }

    function Row({ connector }) {
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState(null);
        const kind = kindOf(connector.kind);

        const toggle = async () => {
            setBusy(true);
            setError(null);

            try {
                upsert(
                    await pocket.api(
                        `connectors/${encodeURIComponent(connector.id)}`,
                        bodyOf(connector, { enabled: !connector.enabled }),
                        { method: "PUT" },
                    ),
                );
            } catch (failed) {
                setError(failed.message);
            } finally {
                setBusy(false);
            }
        };

        return html`<li class="relay-card">
            <div class="relay-card-head">
                <button
                    class="relay-open"
                    aria-label=${`Edit ${connector.name}`}
                    onClick=${() => pocket.openSheet("relay-edit", { id: connector.id })}
                >
                    <span class="relay-name">${connector.name}</span>
                    <span class="muted small relay-meta">
                        ${`${kind?.label ?? connector.kind} → ${sessionName(connector.target)}`}
                    </span>
                </button>
                <${pocket.Switch}
                    on=${connector.enabled}
                    label=${connector.name}
                    disabled=${busy}
                    onChange=${toggle}
                />
            </div>
            <${Status} connector=${connector} />
            ${error && html`<div class="error-box">${error}</div>`}
        </li>`;
    }

    function List() {
        const current = useData();

        if (current === null) {
            return failure
                ? html`<${Failed} text=${failure} />`
                : html`<${pocket.Loader} label="Reading the connectors" />`;
        }

        const add = () => pocket.openSheet("relay-kind");

        if (current.connectors.length === 0) {
            return html`<div class="relay-sheet relay-empty">
                <p>
                    The relay brings messages from Discord, Telegram, Slack, and other services into
                    a session. Pi reads them there, and can answer.
                </p>
                <button class="button primary" onClick=${add}>Add connector</button>
            </div>`;
        }

        return html`<div class="relay-sheet">
            ${
                failure &&
                html`<div class="error-box">Could not read the list again: ${failure}</div>`
            }
            <ul class="relay-list">
                ${current.connectors.map(
                    (connector) => html`<${Row} key=${connector.id} connector=${connector} />`,
                )}
            </ul>
            <div class="relay-buttons">
                <button class="button primary" onClick=${add}>Add connector</button>
            </div>
        </div>`;
    }

    function Kinds() {
        const current = useData();

        if (current === null) {
            return failure
                ? html`<${Failed} text=${failure} />`
                : html`<${pocket.Loader} label="Reading the kinds" />`;
        }

        if (current.kinds.length === 0) {
            return html`<p class="muted">No kinds of connector are loaded.</p>`;
        }

        return html`<div class="relay-sheet">
            <p class="muted small">What does the new connector connect to?</p>
            <ul class="relay-list">
                ${current.kinds.map(
                    (kind) =>
                        html`<li key=${kind.kind}>
                            <button
                                class="relay-kind"
                                onClick=${() => pocket.openSheet("relay-add", { kind: kind.kind })}
                            >
                                <span class="relay-name">${kind.label}</span>
                                ${
                                    kind.description &&
                                    html`<span class="muted small">${kind.description}</span>`
                                }
                                <span class="muted small">
                                    ${kind.reply ? "Pi can answer there." : "Pi only reads it."}
                                </span>
                            </button>
                        </li>`,
                )}
            </ul>
        </div>`;
    }

    function Secret({ field, set, state, onChange }) {
        const id = `relay-field-${field.name}`;

        if (state.mode === "replace" || (!set && state.mode !== "clear")) {
            const placeholder = field.placeholder ?? (set ? "New value" : "");
            const onInput = (event) =>
                onChange({ mode: "replace", text: event.currentTarget.value });
            // A password input strips newlines, so a secret of lines (headers) gets a masked text area.
            const control = field.multiline
                ? html`<textarea
                      id=${id}
                      class="relay-masked"
                      rows="3"
                      autocomplete="off"
                      spellcheck="false"
                      placeholder=${placeholder}
                      value=${state.text}
                      onInput=${onInput}
                  ></textarea>`
                : html`<input
                      id=${id}
                      type="password"
                      autocomplete="new-password"
                      spellcheck="false"
                      placeholder=${placeholder}
                      value=${state.text}
                      onInput=${onInput}
                  />`;

            return html`<div class="relay-secret-edit">
                ${control}
                ${
                    set &&
                    html`<button
                        class="button ghost"
                        type="button"
                        aria-label=${`Keep the ${field.label} that is set`}
                        onClick=${() => onChange({ mode: "keep", text: "" })}
                    >
                        Keep
                    </button>`
                }
            </div>`;
        }

        if (state.mode === "clear") {
            return html`<div class="relay-secret">
                <span class="relay-secret-word warn">Clears on save</span>
                <button
                    class="button ghost"
                    type="button"
                    onClick=${() => onChange({ mode: "keep", text: "" })}
                >
                    Undo
                </button>
            </div>`;
        }

        return html`<div class="relay-secret">
            <span class="relay-secret-word ok">Set</span>
            <button
                class="button"
                type="button"
                aria-label=${`Replace ${field.label}`}
                onClick=${() => onChange({ mode: "replace", text: "" })}
            >
                Replace
            </button>
            <button
                class="button ghost"
                type="button"
                aria-label=${`Clear ${field.label}`}
                onClick=${() => onChange({ mode: "clear", text: "" })}
            >
                Clear
            </button>
        </div>`;
    }

    function Field({ field, value, set, onChange }) {
        const id = `relay-field-${field.name}`;
        const optional = !field.required && ["text", "textarea", "number"].includes(field.type);
        const note = field.type === "secret" && !set ? "Not set" : optional ? "(optional)" : null;
        const label = html`<label class="relay-label" for=${id}>
            ${field.label}${note && html` <span class="muted">${note}</span>`}
        </label>`;
        const about =
            field.description && html`<div class="muted small">${field.description}</div>`;

        if (field.type === "boolean") {
            return html`<div class="relay-field">
                <div class="relay-toggle">
                    <span class="relay-label">${field.label}</span>
                    <${pocket.Switch}
                        on=${value}
                        label=${field.label}
                        onChange=${() => onChange(!value)}
                    />
                </div>
                ${about}
            </div>`;
        }

        let control;

        if (field.type === "secret") {
            control = html`<${Secret}
                field=${field}
                set=${set}
                state=${value}
                onChange=${onChange}
            />`;
        } else if (field.type === "choice") {
            control = html`<select
                id=${id}
                value=${value}
                onChange=${(event) => onChange(event.currentTarget.value)}
            >
                ${(field.choices ?? []).map(
                    (choice) =>
                        html`<option key=${choice.value} value=${choice.value}>
                            ${choice.label}
                        </option>`,
                )}
            </select>`;
        } else if (field.type === "textarea") {
            control = html`<textarea
                id=${id}
                rows="3"
                placeholder=${field.placeholder ?? ""}
                value=${value}
                onInput=${(event) => onChange(event.currentTarget.value)}
            ></textarea>`;
        } else {
            control = html`<input
                id=${id}
                type=${field.type === "number" ? "number" : "text"}
                inputmode=${field.type === "number" ? "numeric" : undefined}
                min=${field.min}
                max=${field.max}
                autocomplete="off"
                placeholder=${field.placeholder ?? ""}
                value=${value}
                onInput=${(event) => onChange(event.currentTarget.value)}
            />`;
        }

        return html`<div class="relay-field">${label}${control}${about}</div>`;
    }

    function problem(form, kind, connector) {
        const name = form.name.trim();

        if (name === "" || [...name].length > LIMITS.name) {
            return `A name is 1 to ${LIMITS.name} characters.`;
        }

        if (form.target === "") {
            return "Choose the session that gets the messages.";
        }

        for (const field of kind.fields) {
            const value = form.values[field.name];

            if (field.type === "secret") {
                const has =
                    value.mode === "replace"
                        ? value.text.trim() !== ""
                        : value.mode === "keep" && connector?.secrets[field.name] === true;

                if (field.required && !has) {
                    return `Fill in ${field.label}.`;
                }
            } else if (field.type === "number") {
                if (value.trim() === "") {
                    if (field.required) {
                        return `Fill in ${field.label}.`;
                    }
                } else {
                    const number = Number(value);
                    const low = field.min ?? -Infinity;
                    const high = field.max ?? Infinity;

                    if (!Number.isFinite(number) || number < low || number > high) {
                        return Number.isFinite(low) && Number.isFinite(high)
                            ? `${field.label} is a number from ${low} to ${high}.`
                            : `${field.label} is a number.`;
                    }
                }
            } else if (field.type !== "boolean" && field.required && value.trim() === "") {
                return `Fill in ${field.label}.`;
            }
        }

        if ([...form.instructions].length > LIMITS.instructions) {
            return `Instructions are ${LIMITS.instructions} characters at most.`;
        }

        const owners = idsOf(form.owners);

        if (owners.length > LIMITS.owners) {
            return `List ${LIMITS.owners} owner IDs at most.`;
        }

        if (owners.some((each) => [...each].length > LIMITS.owner)) {
            return `An owner ID is ${LIMITS.owner} characters at most.`;
        }

        for (const [key, label] of [
            ["perHour", "The limit per hour"],
            ["perAuthor", "The limit per author"],
        ]) {
            const number = Number(form[key]);
            const [low, high] = LIMITS[key];

            if (!Number.isInteger(number) || number < low || number > high) {
                return `${label} is a whole number from ${low} to ${high}.`;
            }
        }

        return null;
    }

    function bodyOfForm(form, kind) {
        const values = {};

        for (const field of kind.fields) {
            const value = form.values[field.name];

            if (field.type === "secret") {
                if (value.mode === "clear") {
                    values[field.name] = null;
                } else if (value.mode === "replace" && value.text.trim() !== "") {
                    values[field.name] = value.text.trim();
                }
            } else if (field.type === "number") {
                if (value.trim() !== "") {
                    values[field.name] = Number(value);
                }
            } else if (field.type === "boolean") {
                values[field.name] = value;
            } else {
                values[field.name] = field.type === "text" ? value.trim() : value;
            }
        }

        return {
            name: form.name.trim(),
            kind: kind.kind,
            enabled: form.enabled,
            target: Number(form.target),
            instructions: form.instructions,
            ownerIds: idsOf(form.owners),
            mentionOnly: kind.mentions ? form.mentionOnly : false,
            perHour: Number(form.perHour),
            perAuthor: Number(form.perAuthor),
            values,
        };
    }

    function startForm(kind, connector, sessions) {
        const values = {};

        for (const field of kind.fields) {
            values[field.name] =
                field.type === "secret"
                    ? { mode: "keep", text: "" }
                    : startValue(field, connector?.values);
        }

        const here = pocket.conversationId();
        const open = sessions.filter((each) => !each.archived);
        const target =
            connector?.target ??
            (open.some((each) => each.id === here) ? here : (open[0]?.id ?? ""));

        return {
            name: connector?.name ?? kind.label,
            target: target === "" ? "" : String(target),
            values,
            instructions: connector?.instructions ?? "",
            owners: (connector?.ownerIds ?? []).join("\n"),
            mentionOnly: connector?.mentionOnly ?? false,
            perHour: String(connector?.perHour ?? 30),
            perAuthor: String(connector?.perAuthor ?? 10),
            enabled: connector?.enabled ?? true,
        };
    }

    function Form({ kind, connector, sessions }) {
        const [form, setForm] = useState(() => startForm(kind, connector, sessions));
        const [error, setError] = useState(null);
        const [saving, setSaving] = useState(false);
        const [removing, setRemoving] = useState(false);

        const set = (key, value) => setForm((before) => ({ ...before, [key]: value }));
        const setValue = (name, value) =>
            setForm((before) => ({ ...before, values: { ...before.values, [name]: value } }));
        const choices = sessions.filter(
            (each) => !each.archived || String(each.id) === String(connector?.target),
        );

        const save = async (event) => {
            event.preventDefault();

            const wrong = problem(form, kind, connector);

            if (wrong) {
                setError(wrong);

                return;
            }

            setSaving(true);
            setError(null);

            try {
                const body = bodyOfForm(form, kind);
                const answer = connector
                    ? await pocket.api(`connectors/${encodeURIComponent(connector.id)}`, body, {
                          method: "PUT",
                      })
                    : await pocket.api("connectors", body);

                upsert(answer);
                pocket.openSheet("relay");
            } catch (failed) {
                setError(failed.message);
                setSaving(false);
            }
        };

        const remove = async () => {
            setSaving(true);
            setError(null);

            try {
                await pocket.api(`connectors/${encodeURIComponent(connector.id)}`, undefined, {
                    method: "DELETE",
                });
                drop(connector.id);
                pocket.openSheet("relay");
            } catch (failed) {
                setError(failed.message);
                setSaving(false);
                setRemoving(false);
            }
        };

        return html`<form class="relay-sheet relay-form" onSubmit=${save} novalidate>
            ${
                connector &&
                html`<div class="relay-card">
                    <div class="relay-name">${kind.label}</div>
                    <${Status} connector=${connector} />
                </div>`
            }
            ${
                !connector &&
                kind.description &&
                html`<p class="muted small">${kind.description}</p>`
            }
            <div class="relay-field">
                <label class="relay-label" for="relay-name">Name</label>
                <input
                    id="relay-name"
                    autocomplete="off"
                    maxlength=${LIMITS.name}
                    value=${form.name}
                    onInput=${(event) => set("name", event.currentTarget.value)}
                />
            </div>
            <div class="relay-field">
                <label class="relay-label" for="relay-target">Session</label>
                <select
                    id="relay-target"
                    value=${form.target}
                    onChange=${(event) => set("target", event.currentTarget.value)}
                >
                    ${
                        form.target === "" &&
                        html`<option value="" disabled>Choose a session</option>`
                    }
                    ${
                        connector &&
                        !sessions.some((each) => each.id === connector.target) &&
                        html`<option value=${String(connector.target)}>
                            ${sessionName(connector.target)}
                        </option>`
                    }
                    ${choices.map(
                        (session) =>
                            html`<option key=${session.id} value=${String(session.id)}>
                                ${session.archived ? `${session.title} (archived)` : session.title}
                            </option>`,
                    )}
                </select>
                <div class="muted small">Messages go to this session, and Pi reads them there.</div>
            </div>
            ${kind.fields.map(
                (field) =>
                    html`<${Field}
                        key=${field.name}
                        field=${field}
                        value=${form.values[field.name]}
                        set=${connector?.secrets[field.name] === true}
                        onChange=${(value) => setValue(field.name, value)}
                    />`,
            )}
            <div class="relay-field">
                <label class="relay-label" for="relay-instructions">
                    Instructions <span class="muted">(optional)</span>
                </label>
                <textarea
                    id="relay-instructions"
                    rows="4"
                    maxlength=${LIMITS.instructions}
                    placeholder="How Pi answers these messages"
                    value=${form.instructions}
                    onInput=${(event) => set("instructions", event.currentTarget.value)}
                ></textarea>
            </div>
            <div class="relay-field">
                <label class="relay-label" for="relay-owners">
                    Your IDs <span class="muted">(optional)</span>
                </label>
                <textarea
                    id="relay-owners"
                    rows="2"
                    spellcheck="false"
                    placeholder="One on each line, or comma separated"
                    value=${form.owners}
                    onInput=${(event) => set("owners", event.currentTarget.value)}
                ></textarea>
                <div class="muted small">
                    The IDs of your own accounts on this service. Pi reads them as trusted.
                </div>
            </div>
            ${
                kind.mentions &&
                html`<div class="relay-toggle">
                    <span class="relay-label">Only messages that mention the bot</span>
                    <${pocket.Switch}
                        on=${form.mentionOnly}
                        label="Only messages that mention the bot"
                        onChange=${() => set("mentionOnly", !form.mentionOnly)}
                    />
                </div>`
            }
            <div class="relay-pair">
                <div class="relay-field">
                    <label class="relay-label" for="relay-per-hour">Messages per hour</label>
                    <input
                        id="relay-per-hour"
                        type="number"
                        inputmode="numeric"
                        min=${LIMITS.perHour[0]}
                        max=${LIMITS.perHour[1]}
                        value=${form.perHour}
                        onInput=${(event) => set("perHour", event.currentTarget.value)}
                    />
                </div>
                ${
                    (kind.authorLimit === true ||
                        (typeof kind.authorLimit === "string" &&
                            String(form.values[kind.authorLimit] ?? "").trim() !== "")) &&
                    html`<div class="relay-field">
                        <label class="relay-label" for="relay-author">Per author, per hour</label>
                        <input
                            id="relay-author"
                            type="number"
                            inputmode="numeric"
                            min=${LIMITS.perAuthor[0]}
                            max=${LIMITS.perAuthor[1]}
                            value=${form.perAuthor}
                            onInput=${(event) => set("perAuthor", event.currentTarget.value)}
                        />
                    </div>`
                }
            </div>
            <div class="muted small">Messages past these limits are dropped.</div>
            <div class="relay-toggle">
                <span class="relay-label">Connector on</span>
                <${pocket.Switch}
                    on=${form.enabled}
                    label="Connector on"
                    onChange=${() => set("enabled", !form.enabled)}
                />
            </div>
            ${error && html`<div class="error-box">${error}</div>`}
            ${
                removing
                    ? html`<div class="relay-confirm">
                          <p>${`Remove ${connector.name}? Its messages stop.`}</p>
                          <p class="muted small">This cannot be undone.</p>
                          <div class="relay-buttons">
                              <button
                                  class="button"
                                  type="button"
                                  disabled=${saving}
                                  onClick=${() => setRemoving(false)}
                              >
                                  Keep it
                              </button>
                              <button
                                  class="button relay-danger"
                                  type="button"
                                  disabled=${saving}
                                  onClick=${remove}
                              >
                                  ${saving ? "Removing…" : "Remove"}
                              </button>
                          </div>
                      </div>`
                    : html`<div class="relay-buttons">
                          ${
                              connector &&
                              html`<button
                                  class="button ghost relay-remove"
                                  type="button"
                                  disabled=${saving}
                                  onClick=${() => setRemoving(true)}
                              >
                                  Remove
                              </button>`
                          }
                          <button
                              class="button"
                              type="button"
                              onClick=${() => pocket.openSheet("relay")}
                          >
                              Cancel
                          </button>
                          <button class="button primary" type="submit" disabled=${saving}>
                              ${saving ? "Saving…" : "Save"}
                          </button>
                      </div>`
            }
        </form>`;
    }

    function FormSheet({ kind: kindName, id }) {
        const current = useData();

        if (current === null) {
            return failure
                ? html`<${Failed} text=${failure} />`
                : html`<${pocket.Loader} label="Reading the connector" />`;
        }

        const connector =
            id === undefined ? undefined : current.connectors.find((each) => each.id === id);

        if (id !== undefined && !connector) {
            return html`<div class="relay-sheet">
                <p class="muted">This connector is gone.</p>
                <div class="relay-buttons">
                    <button class="button" onClick=${() => pocket.openSheet("relay")}>
                        Back to the list
                    </button>
                </div>
            </div>`;
        }

        const kind = kindOf(connector?.kind ?? kindName);

        if (!kind) {
            return html`<div class="relay-sheet">
                <p class="muted">${`${connector?.kind ?? kindName} is not loaded.`}</p>
                <p class="muted small">This form cannot show its fields until it is.</p>
                ${connector && html`<${Status} connector=${connector} />`}
            </div>`;
        }

        return html`<${Form}
            key=${connector?.id ?? kind.kind}
            kind=${kind}
            connector=${connector}
            sessions=${current.sessions}
        />`;
    }

    pocket.style("style.css");
    pocket.sheet({ id: "relay", title: "Relay", component: List });
    pocket.sheet({ id: "relay-kind", title: "Add connector", component: Kinds });
    pocket.sheet({ id: "relay-add", title: "New connector", component: FormSheet });
    pocket.sheet({ id: "relay-edit", title: "Edit connector", component: FormSheet });
}
