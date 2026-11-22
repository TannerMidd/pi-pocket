// Pocket Surfaces in the transcript (`docs/design/surfaces.md`): an interactive card drawn from the JSON the server
// keeps. The layout, the data and the rules of who may act all come from the server; the browser only draws them,
// sends the one thing a person did (`{ pv, set }`, `{ pv, event }`, or both: a press carries the text typed before
// it), and shows the change when the next revision arrives. An edit carries the `pv` seen when it began; the data
// changes of the next revisions (`rev`) redraw the card and do not make an edit stale (only `pv` does). Text is always plain text, and an https image is a link, never a load.

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
    stepIndex,
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
    // The text fields' unsent drafts, by path: a press sends them with its event.
    const drafts = useRef(new Map());
    // Sets on their way, and the order every request goes in.
    const inflight = useRef(new Set());
    const queue = useRef(Promise.resolve());
    const pressing = useRef(new Set());
    const [, redraw] = useState(0);
    const [busy, setBusy] = useState({});
    const [error, setError] = useState("");
    const [asking, setAsking] = useState(null);

    latest.current = surface;
    prunePending(pending.current, surface.rev);
    useEffect(() => () => clearTimeout(timer.current), []);

    const again = () => redraw((count) => count + 1);

    // One error line at a time, and a failed request shows it once.
    const fail = (problem) => {
        clearTimeout(timer.current);
        setError(problem?.message || "That did not work");
        timer.current = setTimeout(() => setError(""), ERROR_MS);
    };

    const send = (body, keys) => {
        const run = async () => {
            const now = latest.current;

            setBusy((had) =>
                Object.fromEntries([...Object.entries(had), ...keys.map((k) => [k, true])]),
            );

            try {
                return await api(`c/${conversationId}/surfaces/${now.id}/act`, actBody(now, body));
            } catch (problem) {
                fail(problem);

                return null;
            } finally {
                setBusy((had) => {
                    const rest = { ...had };

                    for (const key of keys) {
                        delete rest[key];
                    }

                    return rest;
                });
            }
        };

        const task = queue.current.then(run);

        queue.current = task;

        return task;
    };

    const track = (task) => {
        inflight.current.add(task);
        task.finally(() => inflight.current.delete(task));

        return task;
    };

    // What a person set shows at once; the server's revision (`until`) takes it over, a failure takes it away.
    const hold = (path, value) => {
        const entry = { value };

        pending.current[path] = entry;
        again();

        return entry;
    };

    const settle = (path, entry, result) => {
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

    /** Sets a path; the promise says whether the server took it. `seen` is the `pv` the person saw. */
    const setValue = (path, value, seen = latest.current.pv) => {
        const entry = hold(path, value);

        return track(
            send({ set: { [path]: value }, pv: seen }, [path]).then((result) => {
                settle(path, entry, result);

                return result !== null;
            }),
        );
    };

    const press = async (id, asked) => {
        if (pressing.current.has(id)) {
            return;
        }

        pressing.current.add(id);

        try {
            let pv = asked ?? latest.current.pv;

            // A set still on its way goes first, and a failed one stops the press: Pi would get the old text.
            if ((await Promise.all([...inflight.current])).includes(false)) {
                return;
            }

            const flushed = [...drafts.current.values()].flatMap((read) => read() ?? []);
            const set = {};
            const held = flushed.map((draft) => {
                set[draft.path] = draft.text;
                pv = Math.min(pv, draft.pv);

                return hold(draft.path, draft.text);
            });
            const result = await track(
                send({ set: flushed.length === 0 ? undefined : set, event: id, pv }, [
                    id,
                    ...flushed.map((draft) => draft.path),
                ]),
            );

            flushed.forEach((draft, index) => {
                settle(draft.path, held[index], result);

                if (result === null) {
                    draft.failed();
                }
            });
        } finally {
            pressing.current.delete(id);
        }
    };

    const data = withPending(surface.data, pending.current);
    const scope = { data, computed: evaluateComputed(surface.computed, data) };

    // A button that acts: whether it is off for this person, and its question; undefined for any other component.
    const button = (id) => {
        const component = surface.components?.[id];

        if (component?.type !== "Button" || component.action?.event === undefined) {
            return undefined;
        }

        const confirm = component.action.event.confirm;

        return {
            disabled:
                !controlState(surface, id).enabled || Boolean(evaluate(component.disabled, scope)),
            confirm: typeof confirm === "string" ? confirm : undefined,
        };
    };

    // The same way in for a person's tap and an extension's `act`: the question first, and nothing for a button that is off.
    const act = (id) => {
        const state = button(id);

        if (state === undefined || state.disabled) {
            return;
        }

        if (state.confirm === undefined) {
            press(id);
        } else {
            // The question is about the card as it is now: Yes sends this `pv`.
            setAsking({ id, pv: latest.current.pv });
        }
    };

    // A question closes when its button is off or Pi changed the card (`pv`): it was about another card.
    useEffect(() => {
        if (
            asking !== null &&
            (asking.pv !== surface.pv || (button(asking.id)?.disabled ?? true))
        ) {
            setAsking(null);
        }
    });

    const ctx = {
        surface,
        busy,
        asking: asking?.id ?? null,
        asked: asking?.pv,
        setAsking,
        setValue,
        press,
        act,
        button,
        pvNow: () => latest.current.pv,
        draft: (path, read) => {
            drafts.current.set(path, read);

            return () => drafts.current.delete(path);
        },
        scope,
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
            const wrap = component.wrap === false ? "surf-nowrap" : "";

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
    const { off, why } = stateOf(ctx, id);

    return html`<${spec.render}
        props=${props}
        value=${typeof bind === "string" ? readPath(bind, ctx.scope) : undefined}
        set=${(next) => (typeof bind === "string" && !off ? ctx.setValue(bind, next) : undefined)}
        act=${(button) => ctx.act(button)}
        disabled=${off}
    />
    <${Why} why=${why} />`;
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

/**
 * The state of a control for this person: whether it is off, and the words that say why when the person's role is the
 * reason (a card that ended says so in its footer). A request on its way (`busy`) never turns a control off: a person
 * who uses the keyboard keeps the focus, and a second press is ignored.
 */
function stateOf(ctx, id, key = id) {
    const state = controlState(ctx.surface, id);

    return {
        off: !state.enabled,
        busy: ctx.busy[key] === true,
        why: ctx.surface.status === "open" ? state.why : "",
    };
}

/** The visible reason a control is off. */
function Why({ why }) {
    return why === "" ? null : html`<span class="surf-text surf-caption surf-why">${why}</span>`;
}

function ButtonView({ id, component, ctx }) {
    const main = useRef(null);
    const yes = useRef(null);
    const moved = useRef(false);
    const label = textOf(component.label);
    const style = ["primary", "danger"].includes(component.style) ? component.style : "default";
    const classes = `surf-btn surf-btn-${style}`;
    const open = component.action?.open;
    const { busy, why } = stateOf(ctx, id);
    const { disabled, confirm } = ctx.button(id) ?? { disabled: true };
    const showAsk = ctx.asking === id && !disabled && confirm !== undefined;

    // The question takes the focus (on "Yes"), and closing it gives the focus back to the button.
    useEffect(() => {
        if (showAsk) {
            yes.current?.focus();
            moved.current = true;
        } else if (moved.current) {
            moved.current = false;
            main.current?.focus();
        }
    }, [showAsk]);

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

    if (showAsk) {
        const close = () => ctx.setAsking(null);

        return html`<div
            class="surf-confirm"
            role="group"
            aria-label=${label}
            onKeyDown=${(event) => {
                if (event.key === "Escape") {
                    event.stopPropagation();
                    close();
                }
            }}
        >
            <span class="surf-confirm-text">${confirm}</span>
            <span class="surf-confirm-buttons">
                <button
                    type="button"
                    class=${classes}
                    ref=${yes}
                    onClick=${() => {
                        close();
                        ctx.press(id, ctx.asked);
                    }}
                >
                    Yes
                </button>
                <button type="button" class="surf-btn" onClick=${close}>Cancel</button>
            </span>
        </div>`;
    }

    const control = html`<button
        type="button"
        class=${classes}
        ref=${main}
        disabled=${disabled}
        aria-busy=${busy ? "true" : undefined}
        onClick=${() => ctx.act(id)}
    >
        ${label}
    </button>`;

    return why === ""
        ? control
        : html`<span class="surf-btn-cell">${control}<${Why} why=${why} /></span>`;
}

/**
 * A text input that keeps what the person types as a draft, sends it after a short pause and when it loses focus, and
 * does not take the server's value while it has focus. A press of a button reads the draft too (`register`) and sends
 * it with its event. The draft goes out with the card's `pv` from when the person began to type; if the server refuses
 * it, the draft is dropped (the card shows the error once) and is not sent again.
 */
function DraftText({
    path,
    value,
    max,
    multiline,
    placeholder,
    label,
    disabled,
    seenPv,
    register,
    onSend,
}) {
    const [draft, setDraft] = useState(null);
    // The draft as it is now: an event handler can run before the draw that shows it.
    const held = useRef(null);
    const timer = useRef(0);
    const stored = useRef(value);
    const seen = useRef(null);
    const sent = useRef(null);

    stored.current = value;
    useEffect(() => () => clearTimeout(timer.current), []);

    const change = (next) => {
        held.current = next;
        setDraft(next);
    };

    // Dropped when it failed, unless the person has typed more since.
    const failed = (text) => {
        if (held.current === text) {
            change(null);
        }

        sent.current = null;
    };

    const send = (text) => {
        clearTimeout(timer.current);
        timer.current = 0;

        if (text === stored.current || text === sent.current) {
            return;
        }

        sent.current = text;
        Promise.resolve(onSend(text, seen.current ?? seenPv())).then((taken) => {
            if (taken === false) {
                failed(text);
            }
        });
    };

    useEffect(
        () =>
            register(path, () => {
                const text = held.current;

                if (text === null || text === stored.current || text === sent.current) {
                    return undefined;
                }

                clearTimeout(timer.current);
                timer.current = 0;
                sent.current = text;

                return { path, text, pv: seen.current ?? seenPv(), failed: () => failed(text) };
            }),
        [path],
    );

    const props = {
        value: draft ?? value,
        maxLength: max,
        placeholder,
        disabled,
        "aria-label": label,
        autoComplete: "off",
        onFocus: () => {
            seen.current = seenPv();
            sent.current = null;
            change(value);
        },
        onInput: (event) => {
            const text = event.currentTarget.value;

            seen.current ??= seenPv();
            change(text);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => send(text), TYPING_MS);
        },
        onBlur: () => {
            if (held.current !== null) {
                send(held.current);
            }

            change(null);
            seen.current = null;
        },
    };

    return multiline
        ? html`<textarea class="surf-input" rows="3" ...${props}></textarea>`
        : html`<input class="surf-input" type="text" ...${props} />`;
}

function TextFieldView({ id, component, ctx }) {
    const path = String(component.bind);
    const { off, why } = stateOf(ctx, id, path);

    return html`<div class="surf-field">
        <label class="surf-field">
            <span class="surf-label">${textOf(component.label)}</span>
            <${DraftText}
                path=${path}
                value=${textOf(readPath(path, ctx.scope))}
                max=${typeof component.max === "number" ? component.max : undefined}
                multiline=${component.multiline === true}
                placeholder=${
                    typeof component.placeholder === "string" ? component.placeholder : undefined
                }
                label=${textOf(component.label)}
                disabled=${off || Boolean(evaluate(component.disabled, ctx.scope))}
                seenPv=${ctx.pvNow}
                register=${ctx.draft}
                onSend=${(text, pv) => ctx.setValue(path, text, pv)}
            />
        </label>
        <${Why} why=${why} />
    </div>`;
}

function CheckBoxView({ id, component, ctx }) {
    const path = String(component.bind);
    const { off, busy, why } = stateOf(ctx, id, path);
    const disabled = off || Boolean(evaluate(component.disabled, ctx.scope));

    return html`<div class="surf-field">
        <label class="surf-check">
            <input
                type="checkbox"
                checked=${readPath(path, ctx.scope) === true}
                disabled=${disabled}
                aria-busy=${busy ? "true" : undefined}
                onChange=${(event) => ctx.setValue(path, event.currentTarget.checked)}
            />
            <span>${textOf(component.label)}</span>
        </label>
        <${Why} why=${why} />
    </div>`;
}

function PickerView({ id, component, ctx }) {
    const path = String(component.bind);
    const { off, busy, why } = stateOf(ctx, id, path);
    const disabled = off || Boolean(evaluate(component.disabled, ctx.scope));
    const options = optionsOf(component.options);
    const current = readPath(path, ctx.scope);
    const label = textOf(component.label);
    let control;

    if (component.multiple === true) {
        control = html`<div class="surf-col surf-gap-s" role="group" aria-label=${label}>
            ${options.map(
                (option) => html`<label class="surf-check" key=${option.value}>
                    <input
                        type="checkbox"
                        checked=${Array.isArray(current) && current.includes(option.value)}
                        disabled=${disabled}
                        aria-busy=${busy ? "true" : undefined}
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
        // One stop in the group (the chosen one, or the first), and the arrow keys move the choice.
        const chosen = options.findIndex((option) => option.value === current);
        const stop = chosen < 0 ? 0 : chosen;

        control = html`<div class="surf-options" role="radiogroup" aria-label=${label}>
            ${options.map(
                (option, at) => html`<button
                    type="button"
                    role="radio"
                    class="surf-option"
                    key=${option.value}
                    aria-checked=${current === option.value}
                    aria-busy=${busy ? "true" : undefined}
                    tabindex=${at === stop ? 0 : -1}
                    disabled=${disabled}
                    onClick=${() => current !== option.value && ctx.setValue(path, option.value)}
                    onKeyDown=${(event) => {
                        const to = stepIndex(options.length, at, event.key);

                        if (to === undefined) {
                            return;
                        }

                        const group = event.currentTarget.parentElement;

                        event.preventDefault();
                        group.children[to]?.focus();

                        if (options[to].value !== current) {
                            ctx.setValue(path, options[to].value);
                        }
                    }}
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
            aria-busy=${busy ? "true" : undefined}
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

    return html`<div class="surf-field">
        <span class="surf-label">${label}</span>
        ${control}
        <${Why} why=${why} />
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
            const off = !state.enabled;

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
                path=${path}
                seenPv=${ctx.pvNow}
                register=${ctx.draft}
                onSend=${(text, pv) => ctx.setValue(path, text, pv)}
            />`;
        }

        const shown = readPath(String(column.value), rowScope(row));

        return column.format === "bytes" ? bytes(shown) : textOf(shown);
    };

    const why = ctx.surface.status === "open" ? state.why : "";

    return html`<div class="surf-table-wrap">
        <table class="surf-table">
            <thead>
                <tr>
                    ${select !== undefined && html`<th class="surf-pick"><span class="surf-sr">Select</span></th>`}
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
                                        disabled=${!state.enabled}
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
        <${Why} why=${why} />
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
