import { parseColor, ratioText, swatchCss, toHex, toOklchText, toRgbText } from "./color.js";
import {
    amountOf,
    EDITABLE,
    linkOf,
    readInput,
    shadowValue,
    showValue,
    withPart,
    writeAmount,
} from "./system.js";

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);

        return true;
    } catch {
        const field = document.createElement("textarea");

        field.value = text;
        field.setAttribute("readonly", "");
        field.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
        document.body.append(field);
        field.select();

        try {
            return document.execCommand("copy");
        } finally {
            field.remove();
        }
    }
}

export const verdictOf = (info) =>
    info.pass
        ? info.level
        : info.exempt
          ? "Exempt"
          : info.level === "AA large"
            ? "Large only"
            : "Fail";

export const modeTitle = (mode) =>
    mode === "" ? "" : mode[0].toUpperCase() + mode.slice(1).replace(/[-_]+/g, " ");

export const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const UNITS = { dimension: ["px", "rem", "em"], duration: ["ms", "s"] };
const PER_UNIT = { px: 1, rem: 16, em: 16, ms: 1, s: 1000 };
const SHOW_COLOR = { hex: toHex, oklch: toOklchText, rgb: toRgbText };
const FORMATS = Object.keys(SHOW_COLOR);
const round = (value) => Math.round(value * 10000) / 10000;

export function createSystemWidgets(env) {
    const { pocket } = env;
    const { html, useState } = pocket;
    const { Ico, Popover } = env.parts;

    function TokenChip({ name, label, disabled }) {
        return html`<button
            type="button"
            class="dsy-chip"
            aria-label=${label}
            disabled=${disabled}
            onClick=${() => env.openToken(name)}
        >
            ${name}
        </button>`;
    }

    function UsedChips({ names, max, has, children }) {
        return html`<div class="dsy-used">
            ${names
                .slice(0, max)
                .map(
                    (name) =>
                        html`<${TokenChip}
                            key=${name}
                            name=${name}
                            disabled=${has && !has(name)}
                        />`,
                )}
            ${names.length > max && children}
        </div>`;
    }

    function Swatch({ values, size = 36 }) {
        return html`<span
            class="dsy-swatch"
            style=${`--size:${size}px`}
            data-parts=${values.length}
            aria-hidden="true"
        >
            ${values.map((value, index) => {
                const css = swatchCss(value);

                return html`<span
                    key=${index}
                    class="dsy-swatch-part"
                    data-empty=${css === ""}
                    style=${css === "" ? "" : `background:${css}`}
                ></span>`;
            })}
        </span>`;
    }

    function CopyName({ name }) {
        const [done, setDone] = useState(false);
        const parts = name.split(".");
        const leaf = parts.pop();

        return html`<button
            type="button"
            class=${"dsy-name "}
            title=${`Copy ${name}`}
            aria-label=${`Copy ${name}`}
            onClick=${async (event) => {
                event.stopPropagation();

                if (await copyText(name)) {
                    setDone(true);
                    setTimeout(() => setDone(false), 1400);
                    pocket.notify("info", `Copied ${name}`);
                }
            }}
        >
            <span class="dsy-name-path">${parts.map((part) => html`${part}.<wbr />`)}</span
            ><span class="dsy-name-leaf">${leaf}</span>
            <span class=${`dsy-name-icon ${done ? "done" : ""}`}
                ><${Ico} name=${done ? "check" : "copy"} size=${12}
            /></span>
        </button>`;
    }

    function ContrastBadge({ info, mode, modes = 1 }) {
        if (!info) {
            return null;
        }

        const exempt = !info.pass && info.exempt !== undefined;
        const kind = info.pass ? (info.level === "AAA" ? "aaa" : "aa") : exempt ? "exempt" : "fail";

        return html`<span
            class=${`dsy-badge ${kind} ${info.auto ? "auto" : ""}`}
            title=${`${mode ? `${modeTitle(mode)}: ` : ""}${ratioText(info.ratio)} on ${info.on}. It needs ${info.min}:1.${exempt ? ` The pair is exempt (${info.exempt}): that is not a failure.` : ""}${info.auto ? " Checked against the page background: this color has no pair of its own." : ""}`}
        >
            ${modes > 1 && html`<span class="dsy-badge-mode">${modeTitle(mode).slice(0, 1)}</span>`}
            <span class="dsy-badge-ratio">${ratioText(info.ratio)}</span>
            <span class="dsy-badge-level">${verdictOf(info)}</span>
        </span>`;
    }

    function AmountField({ amount, units, step = 1, label, onChange, disabled }) {
        const [text, setText] = useState(null);
        const set = (n, unit = amount.unit) => onChange({ n: round(n), unit });

        const convert = (unit) => {
            if (PER_UNIT[amount.unit] && PER_UNIT[unit] && amount.unit !== unit) {
                set((amount.n * PER_UNIT[amount.unit]) / PER_UNIT[unit], unit);
            } else {
                set(amount.n, unit);
            }
        };

        const stepButton = (word, icon, by) =>
            html`<button
                type="button"
                class="dsy-step"
                aria-label=${`${word} ${label}`}
                disabled=${disabled}
                onClick=${() => set(amount.n + by)}
            >
                <${Ico} name=${icon} size=${14} />
            </button>`;

        return html`<div class="dsy-amount">
            ${stepButton("Decrease", "minus", -step)}
            <input
                type="text"
                inputmode="decimal"
                class="mono"
                value=${text ?? String(amount.n)}
                disabled=${disabled}
                aria-label=${label}
                spellcheck="false"
                onInput=${(event) => {
                    const value = event.currentTarget.value;
                    const next = amountOf(value);

                    setText(value);

                    if (next !== null && (units !== undefined || next.unit === "")) {
                        set(next.n, next.unit === "" ? amount.unit : next.unit);
                    }
                }}
                onBlur=${() => setText(null)}
                onKeyDown=${(event) => {
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        event.preventDefault();
                        set(
                            amount.n +
                                (event.key === "ArrowUp" ? step : -step) *
                                    (event.shiftKey ? 10 : 1),
                        );
                        setText(null);
                    }
                }}
            />
            ${stepButton("Increase", "plus", step)}
            ${
                units &&
                html`<select
                    class="dsy-unit"
                    value=${amount.unit}
                    disabled=${disabled}
                    aria-label=${`${label}: unit`}
                    onChange=${(event) => convert(event.currentTarget.value)}
                >
                    ${(units.includes(amount.unit) ? units : [amount.unit, ...units]).map(
                        (unit) => html`<option value=${unit}>${unit}</option>`,
                    )}
                </select>`
            }
        </div>`;
    }

    function ColorField({ value, like, label, onChange, disabled }) {
        const [draft, setDraft] = useState(null);
        const [format, setFormat] = useState("hex");
        const color = parseColor(value);
        const problem = draft === null ? "" : (readInput("color", draft, like).error ?? "");

        const take = (input) => {
            const result = readInput("color", input, like);

            if (result.value !== undefined) {
                onChange(result.value);
            }
        };

        return html`<div class="dsy-colorfield">
            <label class="dsy-well" style=${color ? `--well:${swatchCss(value)}` : ""}>
                <input
                    type="color"
                    value=${color ? toHex({ ...color, a: 1 }) : "#000000"}
                    disabled=${disabled}
                    aria-label=${`${label}: pick`}
                    onInput=${(event) => take(event.currentTarget.value)}
                />
            </label>
            <input
                type="text"
                class=${`mono ${problem ? "bad" : ""}`}
                value=${draft ?? (color === undefined ? "" : SHOW_COLOR[format](color))}
                disabled=${disabled}
                spellcheck="false"
                autocomplete="off"
                aria-label=${`${label}: color`}
                aria-invalid=${problem !== ""}
                onInput=${(event) => {
                    setDraft(event.currentTarget.value);
                    take(event.currentTarget.value);
                }}
                onBlur=${() => setDraft(null)}
            />
            <button
                type="button"
                class="dsy-format"
                title="Show it as hex, oklch, or rgb"
                aria-label=${`Shown as ${format}. Change.`}
                onClick=${() => {
                    setDraft(null);
                    setFormat(FORMATS[(FORMATS.indexOf(format) + 1) % FORMATS.length]);
                }}
            >
                ${format}
            </button>
            ${problem && html`<p class="dsy-problem" role="alert">${problem}</p>`}
        </div>`;
    }

    function Curve({ value, size = 64 }) {
        const [x1, y1, x2, y2] = value;
        const span = size - 20;
        const point = (x, y) => [(10 + x * span).toFixed(1), (size - 10 - y * span).toFixed(1)];
        const at = (x, y) => point(x, y).join(" ");
        const dot = ([cx, cy]) => html`<circle class="dsy-curve-dot" cx=${cx} cy=${cy} r="2.5" />`;

        return html`<svg
            class="dsy-curve"
            width=${size}
            height=${size}
            viewBox=${`0 0 ${size} ${size}`}
            aria-hidden="true"
        >
            <path
                class="dsy-curve-axis"
                d=${`M${at(0, 0)} L${at(1, 0)} M${at(0, 0)} L${at(0, 1)}`}
            />
            <path
                class="dsy-curve-handle"
                d=${`M${at(0, 0)} L${at(x1, y1)} M${at(1, 1)} L${at(x2, y2)}`}
            />
            <path
                class="dsy-curve-line"
                d=${`M${at(0, 0)} C${at(x1, y1)} ${at(x2, y2)} ${at(1, 1)}`}
            />
            ${dot(point(x1, y1))}${dot(point(x2, y2))}
        </svg>`;
    }

    function BezierField({ value, label, onChange, disabled }) {
        return html`<div class="dsy-bezier">
            <${Curve} value=${value} size=${72} />
            <div class="dsy-bezier-fields">
                ${["x1", "y1", "x2", "y2"].map(
                    (name, index) =>
                        html`<label>
                            <span class="muted small mono">${name}</span>
                            <input
                                type="text"
                                inputmode="decimal"
                                class="mono"
                                value=${String(value[index])}
                                disabled=${disabled}
                                aria-label=${`${label}: ${name}`}
                                onChange=${(event) => {
                                    const next = [...value];

                                    next[index] = Number(event.currentTarget.value);

                                    const result = readInput("cubicBezier", next.join(" "), value);

                                    if (result.value !== undefined) {
                                        onChange(result.value);
                                    } else {
                                        pocket.notify("error", result.error);
                                        event.currentTarget.value = String(value[index]);
                                    }
                                }}
                            />
                        </label>`,
                )}
            </div>
        </div>`;
    }

    function AliasPicker({ model, token, mode, part, current, onPick, onClose, narrow }) {
        const [query, setQuery] = useState("");
        const words = query.trim().toLowerCase();
        const targets = (
            part
                ? model.tokens.filter((each) => each.type === part.type && each.name !== token.name)
                : model.targets(token.name)
        ).filter((each) => words === "" || each.name.toLowerCase().includes(words));
        const linked = part ? current : model.value(token.name, mode).alias;

        return html`<${Popover}
            label="Link to a token"
            onClose=${onClose}
            wide=${true}
            sheet=${narrow}
        >
            <input
                class="dsn-search"
                type="search"
                placeholder=${`Find a ${part ? part.type : token.type} token`}
                value=${query}
                autofocus
                onInput=${(event) => setQuery(event.currentTarget.value)}
            />
            <ul class="dsn-list dsy-targets" aria-label="Tokens">
                ${targets.slice(0, 120).map((each) => {
                    const value = model.value(each.name, mode);

                    return html`<li key=${each.name}>
                        <button
                            type="button"
                            class=${`dsn-list-item ${each.name === linked ? "on" : ""}`}
                            onClick=${() => onPick(each.name)}
                        >
                            ${
                                each.type === "color"
                                    ? html`<${Swatch} values=${[value.value]} size=${28} />`
                                    : html`<span class="dsy-target-value mono"
                                          >${showValue(each, value).slice(0, 14)}</span
                                      >`
                            }
                            <span class="dsn-list-main">
                                <strong class="mono dsy-target-name">${each.name}</strong>
                                <span class="muted small"
                                    >${each.tier}${each.description ? ` · ${each.description}` : ""}</span
                                >
                            </span>
                            ${each.name === linked && html`<${Ico} name="check" size=${15} />`}
                        </button>
                    </li>`;
                })}
                ${targets.length === 0 && html`<li class="muted small dsn-empty">No token of this kind${words ? " by that name" : ""}.</li>`}
                ${targets.length > 120 && html`<li class="muted small dsn-empty">Type to narrow ${targets.length} tokens.</li>`}
            </ul>
        <//>`;
    }

    const SHADOW_PARTS = [
        ["offsetX", "X offset", "dimension"],
        ["offsetY", "Y offset", "dimension"],
        ["blur", "Blur", "dimension"],
        ["spread", "Spread", "dimension"],
        ["color", "Color", "color"],
    ];

    const amountField = (type, amount, like, label, disabled, write) =>
        html`<${AmountField}
            amount=${amount}
            units=${UNITS[type]}
            step=${type === "duration" ? 10 : amount.unit === "px" ? 1 : 0.25}
            label=${label}
            disabled=${disabled}
            onChange=${(next) => write(writeAmount(next, like))}
        />`;

    function partInput(member, type, label, disabled, write) {
        const amount = type === "dimension" ? amountOf(member) : null;

        if (type === "color") {
            return html`<${ColorField}
                value=${member}
                like=${member}
                label=${label}
                disabled=${disabled}
                onChange=${write}
            />`;
        }

        return amount
            ? amountField(type, amount, member, label, disabled, write)
            : html`<p class="muted small mono">${String(member)}</p>`;
    }

    function PartField({ model, token, mode, layers, at, part, canEdit }) {
        const [key, name, type] = part;
        const member = layers[at][key];
        const link = linkOf(member);
        const target = link === null ? null : model.token(link);
        const now = target ? model.value(link, mode) : null;
        const label = `${token.name} in ${mode}: layer ${at + 1} ${name.toLowerCase()}`;
        const write = (next) =>
            env.editToken(token.name, mode, {
                value: shadowValue(withPart(layers, at, key, next)),
            });

        return html`<div class="dsy-part" data-part=${key}>
            <span class="dsy-part-name">${name}</span>
            ${
                link === null
                    ? partInput(member, type, label, !canEdit, write)
                    : html`<div class="dsy-part-link">
                          <${Ico} name="link" size=${13} />
                          ${
                              target
                                  ? html`<${TokenChip}
                                        name=${link}
                                        label=${`${label} links to ${link}`}
                                    />`
                                  : html`<span class="dsy-chip">${link}</span>`
                          }
                          ${now && html`<span class="muted small mono">${showValue(target, now)}</span>`}
                      </div>`
            }
            ${
                canEdit &&
                html`<div class="dsy-part-actions">
                    <button
                        type="button"
                        class="dsn-link"
                        onClick=${() => env.pickPart(token.name, mode, { layer: at, key, type })}
                    >
                        ${link === null ? "Link to a token" : "Change"}
                    </button>
                    ${
                        now &&
                        html`<button
                            type="button"
                            class="dsn-link"
                            onClick=${() => write(now.value)}
                        >
                            Use a value
                        </button>`
                    }
                </div>`
            }
        </div>`;
    }

    function ShadowField({ model, token, mode, canEdit }) {
        const { layers } = model.shadowRaw(token.name, mode);
        const mine = canEdit && model.value(token.name, mode).alias === undefined;
        const write = (next) => env.editToken(token.name, mode, { value: shadowValue(next) });
        const base = { model, token, mode, layers };

        return html`<div class="dsy-layers" data-layers=${layers.length}>
            ${layers.map(
                (layer, at) =>
                    html`<fieldset class="dsy-layer" key=${at}>
                        <legend>
                            Layer ${at + 1}
                            ${
                                mine &&
                                layers.length > 1 &&
                                html`<button
                                    type="button"
                                    class="dsn-link"
                                    aria-label=${`Remove layer ${at + 1} of ${token.name} in ${mode}`}
                                    onClick=${() => write(layers.filter((_, index) => index !== at))}
                                >
                                    Remove
                                </button>`
                            }
                        </legend>
                        <div class="dsy-parts">
                            ${SHADOW_PARTS.map(
                                (part) =>
                                    html`<${PartField}
                                        key=${part[0]}
                                        ...${base}
                                        at=${at}
                                        part=${part}
                                        canEdit=${mine}
                                    />`,
                            )}
                        </div>
                        <label class="dsy-inset">
                            <input
                                type="checkbox"
                                checked=${layer.inset === true}
                                disabled=${!mine}
                                aria-label=${`${token.name} in ${mode}: layer ${at + 1} inset`}
                                onChange=${(event) =>
                                    write(
                                        withPart(layers, at, "inset", event.currentTarget.checked),
                                    )}
                            />
                            Inset
                        </label>
                    </fieldset>`,
            )}
            ${
                mine &&
                layers.length < 6 &&
                html`<button
                    type="button"
                    class="dsn-link"
                    onClick=${() => write([...layers, { ...layers.at(-1) }])}
                >
                    Add a layer
                </button>`
            }
        </div>`;
    }

    function ValueField(props) {
        const { model, token, mode, canEdit, like } = props;
        const now = model.value(token.name, mode);
        const disabled = !canEdit;
        const label = `${token.name} in ${mode}`;
        const edit = (value) => env.editToken(token.name, mode, { value });

        switch (token.type) {
            case "shadow":
                return html`<${ShadowField} ...${props} />`;
            case "color":
                return html`<${ColorField}
                    value=${now.value}
                    like=${like}
                    label=${label}
                    disabled=${disabled}
                    onChange=${edit}
                />`;
            case "dimension":

            case "duration": {
                const amount = amountOf(now.value);

                return amount
                    ? amountField(token.type, amount, like, label, disabled, edit)
                    : html`<p class="muted small">This value has no size to edit.</p>`;
            }

            case "number":
            case "fontWeight":
                return typeof now.value === "number"
                    ? html`<${AmountField}
                          amount=${{ n: now.value, unit: "" }}
                          step=${token.type === "fontWeight" ? 100 : 0.05}
                          label=${label}
                          disabled=${disabled}
                          onChange=${(next) => edit(token.type === "fontWeight" ? Math.max(1, Math.min(1000, Math.round(next.n))) : next.n)}
                      />`
                    : html`<p class="muted small mono">${String(now.value)}</p>`;
            case "fontFamily":
                return html`<input
                    type="text"
                    class="dsy-text mono"
                    value=${Array.isArray(now.value) ? now.value.join(", ") : String(now.value ?? "")}
                    disabled=${disabled}
                    spellcheck="false"
                    aria-label=${label}
                    onChange=${(event) => {
                        const result = readInput("fontFamily", event.currentTarget.value, like);

                        if (result.value === undefined) {
                            pocket.notify("error", result.error);
                        } else {
                            edit(result.value);
                        }
                    }}
                />`;
            case "cubicBezier":
                return Array.isArray(now.value) && now.value.length === 4
                    ? html`<${BezierField}
                          value=${now.value}
                          label=${label}
                          disabled=${disabled}
                          onChange=${edit}
                      />`
                    : null;
            default:
                return html`<p class="dsy-composite mono">${showValue(token, now)}</p>`;
        }
    }

    function ContrastList({ model, token, mode, modes }) {
        const pairs = model.contrastsOf(token.name, mode);

        if (pairs.length === 0) {
            return null;
        }

        return html`<div class="dsy-contrasts" data-pairs=${pairs.length}>
            <h5>${pairs.length === 1 ? "Contrast" : `Contrast on ${pairs.length} pairs`}</h5>
            <ul
                aria-label=${`Contrast of ${token.name}${modes > 1 ? ` in ${modeTitle(mode)}` : ""}`}
            >
                ${pairs.map(
                    (pair) =>
                        html`<li key=${pair.on}>
                            <span class="muted small">on</span>
                            <${TokenChip} name=${pair.on} />
                            <${ContrastBadge} info=${pair} mode=${mode} />
                            ${pair.exempt && html`<span class="dsy-exempt-note">exempt: ${pair.exempt}</span>`}
                            ${pair.auto && html`<span class="muted small">checked against the page</span>`}
                        </li>`,
                )}
            </ul>
        </div>`;
    }

    function Inheritance({ model, token, mode, canEdit }) {
        const inherited = !model.overridden(token.name, mode);
        const base = modeTitle(model.defaultMode);

        return html`<div class="dsy-inherit" data-inherit=${inherited}>
            ${
                inherited
                    ? html`<span class="dsy-inherit-tag"
                              ><${Ico} name="link" size=${12} />${`Inherited from ${base}`}</span
                          >
                          <span class="muted small"
                              >${`Change it to give ${modeTitle(mode)} a value of its own.`}</span
                          >`
                    : html`<span class="dsy-inherit-tag own"
                              >${modeTitle(mode)} sets this itself</span
                          >
                          ${
                              canEdit &&
                              html`<button
                                  type="button"
                                  class="dsn-link dsy-match"
                                  onClick=${() => env.inheritToken(token.name, mode)}
                              >
                                  Use ${base}'s value
                              </button>`
                          }`
            }
        </div>`;
    }

    function AliasLine({ model, token, mode, canEdit, now }) {
        const chain = model.chain(token.name, mode).slice(1);

        return html`<div class="dsy-alias">
            <${Ico} name="link" size=${14} />
            ${
                now.alias
                    ? html`<span class="dsy-chain mono">
                          ${chain.map(
                              (name, index) =>
                                  html`${index > 0 && html`<span class="dsy-arrow">→</span>`}<${TokenChip}
                                          name=${name}
                                      />`,
                          )}
                      </span>`
                    : html`<span class="muted small">A value of its own</span>`
            }
            <span class="grow"></span>
            ${
                canEdit &&
                html`<button
                    type="button"
                    class="dsn-link"
                    onClick=${() => env.pickAlias(token.name, mode)}
                >
                    ${now.alias ? "Change" : "Link to a token"}
                </button>`
            }
            ${
                canEdit &&
                now.alias &&
                html`<button
                    type="button"
                    class="dsn-link"
                    onClick=${() =>
                        env.editToken(token.name, mode, {
                            value:
                                token.type === "shadow"
                                    ? shadowValue(model.shadowRaw(token.name, mode).layers)
                                    : now.value,
                        })}
                >
                    Use a value
                </button>`
            }
        </div>`;
    }

    function ModeEditor({ ctx, token, mode }) {
        const { model, modes, canEdit } = ctx;
        const now = model.value(token.name, mode);
        const saved = token.modes[mode];
        const like =
            (saved?.alias === undefined ? saved?.value : now.value) ??
            token.modes[model.defaultMode]?.value;
        const base = { model, token, mode };

        return html`<section class="dsy-mode" aria-label=${modeTitle(mode)}>
            ${modes.length > 1 && html`<h4 class="dsy-mode-name">${modeTitle(mode)}</h4>`}
            ${now.error && html`<p class="dsy-problem" role="alert">${now.error}</p>`}
            ${mode !== model.defaultMode && html`<${Inheritance} ...${base} canEdit=${canEdit} />`}
            <${ValueField} ...${base} canEdit=${EDITABLE.has(token.type) && canEdit} like=${like} />
            <${ContrastList} ...${base} modes=${modes.length} />
            <${AliasLine} ...${base} canEdit=${canEdit} now=${now} />
        </section>`;
    }

    function TokenEditor({ ctx, token }) {
        const { model, canEdit } = ctx;
        const dependents = model.dependents(token.name);
        const anyEdit = model.modes.some((mode) => model.edited(token.name, mode));

        return html`<div class="dsy-editor">
            ${token.description && html`<p class="dsy-editor-note">${token.description}</p>`}
            ${
                token.deprecated &&
                html`<p class="dsy-editor-warn">
                    <${Ico} name="alert" size=${13} />
                    Deprecated${typeof token.deprecated === "string" ? `: ${token.deprecated}` : ""}
                </p>`
            }
            ${ctx.modes.map(
                (mode) =>
                    html`<${ModeEditor} key=${mode} ctx=${ctx} token=${token} mode=${mode} />`,
            )}
            ${
                !EDITABLE.has(token.type) &&
                html`<div class="dsy-askpi">
                    <span class="muted small">
                        This kind of token is made of parts that link to other tokens. Change the
                        tokens it uses, or ask Pi to change it.
                    </span>
                    ${
                        canEdit &&
                        html`<button
                            type="button"
                            class="button small"
                            onClick=${() => env.askPiAbout(token)}
                        >
                            <${Ico} name="sparkle" size=${14} /> Ask Pi
                        </button>`
                    }
                </div>`
            }
            <div class="dsy-editor-foot">
                <button
                    type="button"
                    class="dsn-link"
                    onClick=${async () => {
                        if (await copyText(`var(${token.cssVar})`)) {
                            pocket.notify("info", `Copied var(${token.cssVar})`);
                        }
                    }}
                >
                    <${Ico} name="copy" size=${13} /> var(${token.cssVar})
                </button>
                ${
                    dependents.length > 0 &&
                    html`<span class="muted small"
                        >${`Used by ${plural(dependents.length, "token")}`}</span
                    >`
                }
                <span class="grow"></span>
                ${
                    canEdit &&
                    anyEdit &&
                    html`<button
                        type="button"
                        class="dsn-link"
                        onClick=${() => env.resetToken(token.name)}
                    >
                        <${Ico} name="undo" size=${13} /> Reset
                    </button>`
                }
            </div>
            ${
                dependents.length > 0 &&
                html`<${UsedChips} names=${dependents} max=${12}>
                    <span class="muted small">and ${dependents.length - 12} more</span>
                <//>`
            }
        </div>`;
    }

    return {
        Swatch,
        CopyName,
        ContrastBadge,
        TokenChip,
        UsedChips,
        Curve,
        AliasPicker,
        TokenEditor,
    };
}
