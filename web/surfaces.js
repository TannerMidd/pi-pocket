// Pocket Surfaces in the transcript (`docs/design/surfaces.md`): an interactive card drawn from the JSON the server
// keeps. The layout, the data and the rules of who may act all come from the server; the browser only draws them,
// sends the one thing a person did (`{ pv, set }` or `{ pv, event }`), and shows the change when the next revision
// arrives. Text is always plain text, and an https image is a link, never a load.

import { Component } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, store } from "./store.js";
import { bytes, evaluate, evaluateComputed, readPath, textOf } from "./surfaces-expr.js";
import {
    actBody,
    bodyOfText,
    cellPath,
    controlState,
    footerOf,
    httpsUrl,
    imageKind,
    optionsOf,
    prunePending,
    surfaceOfCall,
    toggled,
    withPending,
} from "./surfaces-model.js";
import { onSurfaceComponents, surfaceComponentOf } from "./surface-registry.js";
import { html } from "./ui.js";

/** How long a short error line stays in the card. */
const ERROR_MS = 6000;
/** How long a text field waits after the last key before it sends. */
const TYPING_MS = 400;
/** A layout is at most 8 deep; this stops a loop in a bad one. */
const MAX_DEPTH = 12;
/** A single-choice picker with up to this many options is a row of buttons; more is a select. */
const BUTTONS_UP_TO = 4;

// ─── The live surface ────────────────────────────────────────────────────────────

/**
 * The surface a call made, from the store, kept current: the transcript's rows are memoized, so the card follows the
 * store itself. Only the conversation the tab shows has surfaces.
 */
function useSurface(conversationId, callId) {
    const pick = (state) =>
        state.view.conversation?.id === conversationId
            ? surfaceOfCall(state.view.surfaces, callId)
            : undefined;
    const [surface, setSurface] = useState(() => pick(store.state));

    useEffect(() => {
        let seen;
        let shown;

        const sync = (state) => {
            const { surfaces, conversation } = state.view;

            // The same map and conversation as last time: nothing to look up.
            if (surfaces === seen && conversation?.id === shown) {
                return;
            }

            seen = surfaces;
            shown = conversation?.id;
            const next = pick(state);

            setSurface((had) => (had === next ? had : next));
        };

        sync(store.state);

        return store.subscribe(sync);
    }, [conversationId, callId]);

    return surface;
}

/**
 * The card of a `ui` call: the live surface the call made, or, when the server no longer has it (a fork, an old card,
 * a dropped one), the plain text of the call's result in a read-only frame. Neither: `fallback` (the call as a step),
 * or nothing. It follows the store itself, so a memoized row that holds it still updates.
 */
export function SurfaceCard({ conversationId, callId, details, fallback = null }) {
    const surface = useSurface(conversationId, callId);

    if (surface !== undefined) {
        return html`<${Live} surface=${surface} conversationId=${conversationId} />`;
    }

    if (typeof details?.text === "string" && details.text !== "") {
        const title = typeof details.title === "string" ? details.title : "";

        return html`<${Frame} title=${title} footer="Read-only copy">
            <pre class="surf-copy">${bodyOfText(details.text, title)}</pre>
        <//>`;
    }

    return fallback;
}

/** The fixed frame: Pi's label, the title, the body, and the line under it. */
function Frame({ title, footer, error, children }) {
    return html`<section class="surf" aria-label=${`Pi's card: ${title}`}>
        <header class="surf-head">
            <span class="surf-tag">Pi's card</span>
            <span class="surf-title-line">${title}</span>
        </header>
        <div class="surf-body">${children}</div>
        ${error && html`<p class="surf-error" role="alert">${error}</p>`}
        ${footer && html`<footer class="surf-foot">${footer}</footer>`}
    </section>`;
}

function Live({ surface, conversationId }) {
    const latest = useRef(surface);
    const pending = useRef({});
    const timer = useRef(0);
    const [, redraw] = useState(0);
    const [busy, setBusy] = useState({});
    const [error, setError] = useState("");

    latest.current = surface;
    prunePending(pending.current, surface.rev);
    useEffect(() => () => clearTimeout(timer.current), []);

    const again = () => redraw((count) => count + 1);

    const fail = (problem) => {
        clearTimeout(timer.current);
        setError(problem?.message || "That did not work");
        timer.current = setTimeout(() => setError(""), ERROR_MS);
    };

    const call = async (body, key) => {
        const now = latest.current;

        setBusy((had) => ({ ...had, [key]: true }));

        try {
            return await api(`c/${conversationId}/surfaces/${now.id}/act`, actBody(now, body));
        } catch (problem) {
            fail(problem);

            return null;
        } finally {
            setBusy((had) => {
                const rest = { ...had };

                delete rest[key];

                return rest;
            });
        }
    };

    const setValue = async (path, value) => {
        const entry = { value };

        pending.current[path] = entry;
        again();

        const result = await call({ set: { [path]: value } }, path);

        // A newer set of the same path took over: it settles it.
        if (pending.current[path] === entry) {
            if (result === null) {
                delete pending.current[path];
            } else {
                entry.until = result.rev;
                prunePending(pending.current, latest.current.rev);
            }

            again();
        }
    };

    const press = (id) => call({ event: id }, id);
    const data = withPending(surface.data, pending.current);
    const ctx = {
        surface,
        busy,
        setValue,
        press,
        scope: { data, computed: evaluateComputed(surface.computed, data) },
    };

    return html`<${Frame} title=${surface.title} footer=${footerOf(surface)} error=${error}>
        <${Node} id=${surface.root} ctx=${ctx} depth=${0} />
    <//>`;
}

// ─── Components ──────────────────────────────────────────────────────────────────

/** One bad component shows a short note and leaves the rest of the card alone; a new revision tries it again. */
class Guard extends Component {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(problem) {
        console.error("A surface component failed", problem);
    }

    componentDidUpdate(before) {
        if (this.state.failed && before.resetKey !== this.props.resetKey) {
            this.setState({ failed: false });
        }
    }

    render() {
        return this.state.failed
            ? html`<p class="surf-text surf-caption">This part could not be shown.</p>`
            : this.props.children;
    }
}

function Node({ id, ctx, depth }) {
    const component = ctx.surface.components?.[id];

    if (component === undefined || component === null || depth > MAX_DEPTH) {
        return null;
    }

    return html`<${Guard} resetKey=${ctx.surface.rev}>
        <${Piece} id=${id} component=${component} ctx=${ctx} depth=${depth} />
    <//>`;
}

const GAPS = { s: "surf-gap-s", m: "surf-gap-m", l: "surf-gap-l" };

function Children({ component, ctx, depth }) {
    const ids = Array.isArray(component.children) ? component.children : [];

    return ids.map(
        (child) => html`<${Node} key=${child} id=${child} ctx=${ctx} depth=${depth + 1} />`,
    );
}

function Piece({ id, component, ctx, depth }) {
    const value = (expr) => evaluate(expr, ctx.scope);

    switch (component.type) {
        case "Column": {
            return html`<div class=${`surf-col ${GAPS[component.gap] ?? "surf-gap-m"}`}>
                <${Children} component=${component} ctx=${ctx} depth=${depth} />
            </div>`;
        }

        case "Row": {
            const wrap = component.wrap === true ? "surf-wrap" : "";

            return html`<div class=${`surf-row ${GAPS[component.gap] ?? "surf-gap-m"} ${wrap}`}>
                <${Children} component=${component} ctx=${ctx} depth=${depth} />
            </div>`;
        }

        case "Card": {
            return html`<div class="surf-box">
                ${
                    typeof component.title === "string" &&
                    html`<div class="surf-box-title">${component.title}</div>`
                }
                <div class=${`surf-col ${GAPS[component.gap] ?? "surf-gap-m"}`}>
                    <${Children} component=${component} ctx=${ctx} depth=${depth} />
                </div>
            </div>`;
        }

        case "Text": {
            const style = ["title", "caption", "mono"].includes(component.style)
                ? component.style
                : "body";

            return html`<p class=${`surf-text surf-${style}`}>${textOf(value(component.text))}</p>`;
        }

        case "Divider": {
            return html`<hr class="surf-divider" />`;
        }

        case "Image": {
            return html`<${ImageView} component=${component} />`;
        }

        case "Button": {
            return html`<${ButtonView} id=${id} component=${component} ctx=${ctx} />`;
        }

        case "TextField": {
            return html`<${TextFieldView} id=${id} component=${component} ctx=${ctx} />`;
        }

        case "CheckBox": {
            return html`<${CheckBoxView} id=${id} component=${component} ctx=${ctx} />`;
        }

        case "ChoicePicker": {
            return html`<${PickerView} id=${id} component=${component} ctx=${ctx} />`;
        }

        case "Table": {
            return html`<${TableView} id=${id} component=${component} ctx=${ctx} />`;
        }

        case "Status": {
            return html`<${StatusView} component=${component} ctx=${ctx} />`;
        }

        default: {
            // An extension's component, drawn by its own browser module; any other type this code does not know (a
            // later version's) shows as text.
            return html`<${ExtensionView} id=${id} component=${component} ctx=${ctx} />`;
        }
    }
}

/**
 * A component an extension registered (`web.surfaceComponent`, `pocket.surfaceComponent`). Its renderer is the owner's
 * installed code, never the card's: it gets the props (expressions worked out), the value of its one binding and a
 * way to set it, a way to press one of the card's own buttons, and whether it is off. Without the module in this
 * browser (it is off, or this person is a guest in one session), the text the server worked out shows instead.
 */
function ExtensionView({ id, component, ctx }) {
    const [, redraw] = useState(0);

    useEffect(() => onSurfaceComponents(() => redraw((count) => count + 1)), []);

    const spec = component.type.startsWith("x.") ? surfaceComponentOf(component.type) : undefined;

    if (spec === undefined) {
        const text =
            ctx.surface.fallbacks?.[id] ??
            textOf(evaluate(component.text ?? component.label ?? component.type, ctx.scope));

        return html`<p class="surf-text surf-body">${text}</p>`;
    }

    const { type: _type, bind, who: _who, ...rest } = component;
    const props = Object.fromEntries(
        Object.entries(rest).map(([name, each]) => [name, evaluate(each, ctx.scope)]),
    );
    const { off } = stateOf(ctx, id, typeof bind === "string" ? bind : id);

    return html`<${spec.render}
        props=${props}
        value=${typeof bind === "string" ? readPath(bind, ctx.scope) : undefined}
        set=${(next) => (typeof bind === "string" && !off ? ctx.setValue(bind, next) : undefined)}
        act=${(button) =>
            ctx.surface.components?.[button]?.type === "Button" ? ctx.press(button) : undefined}
        disabled=${off}
    />`;
}

function ImageView({ component }) {
    const shown = imageKind(component.url);
    const alt = typeof component.alt === "string" ? component.alt : "";

    if (shown.kind === "img") {
        return html`<img class="surf-image" src=${shown.src} alt=${alt} />`;
    }

    if (shown.kind === "link") {
        return html`<a
            class="surf-chip"
            href=${shown.href}
            target="_blank"
            rel="noopener noreferrer"
            title=${alt}
        >
            Image from ${shown.host}
        </a>`;
    }

    return html`<p class="surf-text surf-caption">${alt || "An image that cannot be shown"}</p>`;
}

/** The state of a control for this person: whether it is live, and why it is not. */
function stateOf(ctx, id, key = id) {
    const state = controlState(ctx.surface, id);

    return {
        off: !state.enabled || ctx.busy[key] === true,
        locked: !state.enabled,
        why: state.why,
    };
}

function ButtonView({ id, component, ctx }) {
    const [asking, setAsking] = useState(false);
    const label = textOf(component.label);
    const style = ["primary", "danger"].includes(component.style) ? component.style : "default";
    const classes = `surf-btn surf-btn-${style}`;
    const open = component.action?.open;

    if (open !== undefined) {
        const url = httpsUrl(open?.url);

        return url === undefined
            ? html`<button type="button" class=${classes} disabled>${label}</button>`
            : html`<a
                  class=${classes}
                  href=${url.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title=${label}
              >
                  Open ${url.host}
              </a>`;
    }

    const { off, locked, why } = stateOf(ctx, id);
    const disabled = off || Boolean(evaluate(component.disabled, ctx.scope));
    const confirm = component.action?.event?.confirm;

    if (asking && !disabled && typeof confirm === "string") {
        return html`<div class="surf-confirm" role="group" aria-label=${label}>
            <span class="surf-confirm-text">${confirm}</span>
            <span class="surf-confirm-buttons">
                <button
                    type="button"
                    class=${classes}
                    onClick=${() => {
                        setAsking(false);
                        ctx.press(id);
                    }}
                >
                    Yes
                </button>
                <button type="button" class="surf-btn" onClick=${() => setAsking(false)}>
                    Cancel
                </button>
            </span>
        </div>`;
    }

    return html`<button
        type="button"
        class=${classes}
        disabled=${disabled}
        title=${locked ? why : undefined}
        onClick=${() => (typeof confirm === "string" ? setAsking(true) : ctx.press(id))}
    >
        ${label}
    </button>`;
}

/**
 * A text input that keeps what the person types as a draft, sends it after a short pause and when it loses focus, and
 * does not take the server's value while it has focus.
 */
function DraftText({ value, max, multiline, placeholder, label, disabled, onSend }) {
    const [draft, setDraft] = useState(null);
    const timer = useRef(0);
    const stored = useRef(value);

    stored.current = value;
    useEffect(() => () => clearTimeout(timer.current), []);

    const send = (text) => {
        clearTimeout(timer.current);
        timer.current = 0;

        if (text !== stored.current) {
            onSend(text);
        }
    };

    const props = {
        value: draft ?? value,
        maxLength: max,
        placeholder,
        disabled,
        "aria-label": label,
        autoComplete: "off",
        onFocus: () => setDraft(value),
        onInput: (event) => {
            const text = event.currentTarget.value;

            setDraft(text);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => send(text), TYPING_MS);
        },
        onBlur: () => {
            if (draft !== null) {
                send(draft);
            }

            setDraft(null);
        },
    };

    return multiline
        ? html`<textarea class="surf-input" rows="3" ...${props}></textarea>`
        : html`<input class="surf-input" type="text" ...${props} />`;
}

function TextFieldView({ id, component, ctx }) {
    const path = String(component.bind);
    const { locked, why } = stateOf(ctx, id, path);

    return html`<label class="surf-field" title=${locked ? why : undefined}>
        <span class="surf-label">${textOf(component.label)}</span>
        <${DraftText}
            value=${textOf(readPath(path, ctx.scope))}
            max=${typeof component.max === "number" ? component.max : undefined}
            multiline=${component.multiline === true}
            placeholder=${
                typeof component.placeholder === "string" ? component.placeholder : undefined
            }
            label=${textOf(component.label)}
            disabled=${locked || Boolean(evaluate(component.disabled, ctx.scope))}
            onSend=${(text) => ctx.setValue(path, text)}
        />
    </label>`;
}

function CheckBoxView({ id, component, ctx }) {
    const path = String(component.bind);
    const { off, locked, why } = stateOf(ctx, id, path);
    const disabled = off || Boolean(evaluate(component.disabled, ctx.scope));

    return html`<label class="surf-check" title=${locked ? why : undefined}>
        <input
            type="checkbox"
            checked=${readPath(path, ctx.scope) === true}
            disabled=${disabled}
            onChange=${(event) => ctx.setValue(path, event.currentTarget.checked)}
        />
        <span>${textOf(component.label)}</span>
    </label>`;
}

function PickerView({ id, component, ctx }) {
    const path = String(component.bind);
    const { off, locked, why } = stateOf(ctx, id, path);
    const disabled = off || Boolean(evaluate(component.disabled, ctx.scope));
    const options = optionsOf(component.options);
    const current = readPath(path, ctx.scope);
    const label = textOf(component.label);
    let control;

    if (component.multiple === true) {
        control = html`<div class="surf-col surf-gap-s">
            ${options.map(
                (option) => html`<label class="surf-check" key=${option.value}>
                    <input
                        type="checkbox"
                        checked=${Array.isArray(current) && current.includes(option.value)}
                        disabled=${disabled}
                        onChange=${(event) =>
                            ctx.setValue(
                                path,
                                toggled(
                                    current,
                                    component.options,
                                    option.value,
                                    event.currentTarget.checked,
                                ),
                            )}
                    />
                    <span>${option.label}</span>
                </label>`,
            )}
        </div>`;
    } else if (options.length <= BUTTONS_UP_TO) {
        control = html`<div class="surf-options" role="radiogroup" aria-label=${label}>
            ${options.map(
                (option) => html`<button
                    type="button"
                    role="radio"
                    class="surf-option"
                    key=${option.value}
                    aria-checked=${current === option.value}
                    disabled=${disabled}
                    onClick=${() => current !== option.value && ctx.setValue(path, option.value)}
                >
                    ${option.label}
                </button>`,
            )}
        </div>`;
    } else {
        const known = options.some((option) => option.value === current);

        control = html`<select
            class="surf-input"
            aria-label=${label}
            value=${known ? current : ""}
            disabled=${disabled}
            onChange=${(event) => ctx.setValue(path, event.currentTarget.value)}
        >
            ${!known && html`<option value="" disabled>Choose…</option>`}
            ${options.map(
                (option) => html`<option value=${option.value} key=${option.value}>
                    ${option.label}
                </option>`,
            )}
        </select>`;
    }

    return html`<div class="surf-field" title=${locked ? why : undefined}>
        <span class="surf-label">${label}</span>
        ${control}
    </div>`;
}

function TableView({ id, component, ctx }) {
    const rows = readPath(component.rows, ctx.scope);
    const list = Array.isArray(rows) ? rows : [];
    const columns = Array.isArray(component.columns) ? component.columns : [];
    const select = typeof component.select === "string" ? component.select : undefined;
    const state = controlState(ctx.surface, id);
    const rowScope = (row) => ({ ...ctx.scope, row });

    const cell = (row, index, column) => {
        if (typeof column.bind === "string") {
            const path = cellPath(component.rows, index, column.bind);
            const stored = row?.[column.bind];
            const off = !state.enabled || ctx.busy[path] === true;

            if (Array.isArray(column.options)) {
                const options = optionsOf(column.options);
                const known = options.some((option) => option.value === stored);

                return html`<select
                    class="surf-input"
                    aria-label=${`${textOf(column.label)}, row ${index + 1}`}
                    value=${known ? stored : ""}
                    disabled=${off}
                    onChange=${(event) => ctx.setValue(path, event.currentTarget.value)}
                >
                    ${!known && html`<option value="" disabled>Choose…</option>`}
                    ${options.map(
                        (option) => html`<option value=${option.value} key=${option.value}>
                            ${option.label}
                        </option>`,
                    )}
                </select>`;
            }

            return html`<${DraftText}
                value=${textOf(stored)}
                max=${500}
                label=${`${textOf(column.label)}, row ${index + 1}`}
                disabled=${!state.enabled}
                onSend=${(text) => ctx.setValue(path, text)}
            />`;
        }

        const shown = readPath(String(column.value), rowScope(row));

        return column.format === "bytes" ? bytes(shown) : textOf(shown);
    };

    return html`<div class="surf-table-wrap" title=${state.enabled ? undefined : state.why}>
        <table class="surf-table">
            <thead>
                <tr>
                    ${select !== undefined && html`<th class="surf-pick"></th>`}
                    ${columns.map((column) => html`<th>${textOf(column.label)}</th>`)}
                </tr>
            </thead>
            <tbody>
                ${list.map((row, index) => {
                    const path =
                        select === undefined ? "" : cellPath(component.rows, index, select);

                    return html`<tr key=${index}>
                        ${
                            select !== undefined &&
                            html`<td class="surf-pick">
                                <label class="surf-pick-box">
                                    <input
                                        type="checkbox"
                                        aria-label=${`Select row ${index + 1}`}
                                        checked=${row?.[select] === true}
                                        disabled=${!state.enabled || ctx.busy[path] === true}
                                        onChange=${(event) =>
                                            ctx.setValue(path, event.currentTarget.checked)}
                                    />
                                </label>
                            </td>`
                        }
                        ${columns.map(
                            (column) => html`<td data-label=${textOf(column.label)}>
                                ${cell(row, index, column)}
                            </td>`,
                        )}
                    </tr>`;
                })}
            </tbody>
        </table>
    </div>`;
}

const STATES = ["idle", "running", "ok", "warn", "error"];
const STATE_WORDS = {
    idle: "Idle",
    running: "Running",
    ok: "OK",
    warn: "Warning",
    error: "Error",
};

function StatusView({ component, ctx }) {
    const value = (expr) => evaluate(expr, ctx.scope);
    const asked = value(component.state);
    const state = STATES.includes(asked) ? asked : "idle";
    const detail = textOf(value(component.detail));
    const progress = value(component.progress);
    const percent =
        typeof progress === "number" && Number.isFinite(progress)
            ? Math.round(Math.min(1, Math.max(0, progress)) * 100)
            : undefined;

    return html`<div class="surf-status">
        <div class="surf-status-line">
            <span class=${`surf-dot surf-dot-${state}`} aria-hidden="true"></span>
            <span class="surf-status-label">${textOf(component.label)}</span>
            <span class="surf-status-word">${STATE_WORDS[state]}</span>
        </div>
        ${detail !== "" && html`<div class="surf-caption surf-status-detail">${detail}</div>`}
        ${
            percent !== undefined &&
            html`<div
                class="surf-bar"
                role="progressbar"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow=${percent}
            >
                <div class="surf-bar-fill" style=${`width: ${percent}%`}></div>
            </div>`
        }
    </div>`;
}
