import { parseColor, ratioText, swatchCss, toHex } from "./color.js";
import { specimenDocument } from "./specimen.js";
import {
    cssOf,
    groupsOf,
    matches,
    millisecondsOf,
    pixelsOf,
    safeCss,
    shadowOf,
    shadowLines,
    showValue,
    tails,
    themeCss,
    typographyMeta,
    typographyStyle,
    typographyStyleOf,
} from "./system.js";
import { copyText, modeTitle, plural, verdictOf } from "./system-widgets.js";

const SAMPLE = "Sphinx of black quartz, judge my vow";

const EMPTY = {
    colors: ["No color matches.", "This system has no colors yet."],
    type: ["No type token matches.", "This system has no type tokens yet."],
    spacing: ["No spacing token matches.", "This system has no spacing yet."],
    radii: ["No radius matches.", "This system has no corner radii yet."],
    shadows: ["No shadow matches.", "This system has no shadows yet."],
    motion: ["No motion token matches.", "This system has no motion yet."],
};

const SCALES = {
    spacing: { stepKind: "steps", size: "space", rolesNote: "where the system uses a step" },
    radii: { stepKind: "scale", size: "sm", rolesNote: "by use, under the step each points at" },
};

const hexOf = (value) => {
    const color = parseColor(value);

    return color === undefined ? "" : toHex(color);
};

function styleMeta(value) {
    if (typeof value !== "object" || value === null) {
        return "";
    }

    const size = cssOf("dimension", value.fontSize);
    const height =
        typeof value.lineHeight === "number"
            ? `/ ${value.lineHeight}`
            : value.lineHeight
              ? `/ ${cssOf("dimension", value.lineHeight)}`
              : "";
    const family = Array.isArray(value.fontFamily) ? value.fontFamily[0] : value.fontFamily;

    return [[size, height].filter(Boolean).join(" "), value.fontWeight, family]
        .filter((part) => part !== undefined && part !== "")
        .join(" · ");
}

export function createSystemSections(env, widgets) {
    const { pocket, store } = env;
    const { html, useEffect, useRef, useState, Markdown } = pocket;
    const { Ico } = env.parts;
    const { Swatch, CopyName, ContrastBadge, TokenEditor, Curve, UsedChips } = widgets;

    const firstValue = (ctx, token) => ctx.model.value(token.name, ctx.modes[0]);
    const editedIn = (ctx, token) => ctx.modes.some((mode) => ctx.model.edited(token.name, mode));
    const valueSpan = (token, now) =>
        html`<span class="dsy-hex mono">${showValue(token, now)}</span>`;

    const roleColor = (ctx, role, mode, fallback = "") => {
        const name = ctx.model.roles()[role];

        return (name === undefined ? "" : swatchCss(ctx.model.value(name, mode).value)) || fallback;
    };

    function TokenRow({ ctx, token, visual, sub, value, stacked = false, children }) {
        const open = ctx.s.sysOpen === token.name;
        const edited = editedIn(ctx, token);

        return html`<li
            class=${`dsy-row ${open ? "open" : ""} ${edited ? "edited" : ""} ${stacked ? "stacked" : ""}`}
            data-token=${token.name}
        >
            <div class="dsy-row-main" onClick=${() => env.toggleToken(token.name)}>
                ${visual && html`<span class="dsy-row-visual">${visual}</span>`}
                <span class="dsy-row-text">
                    <span class="dsy-row-title">
                        <${CopyName} name=${token.name} />
                        ${token.deprecated && html`<span class="dsy-tag warn">deprecated</span>`}
                        ${edited && html`<span class="dsy-tag edit">edited</span>`}
                    </span>
                    ${sub && html`<span class="dsy-row-sub">${sub}</span>`}
                </span>
                ${value && html`<span class="dsy-row-value">${value}</span>`}
                <button
                    type="button"
                    class="dsy-row-open"
                    aria-expanded=${open}
                    aria-label=${`${open ? "Close" : "Open"} ${token.name}`}
                    onClick=${(event) => {
                        event.stopPropagation();
                        env.toggleToken(token.name);
                    }}
                >
                    <${Ico} name="down" size=${15} />
                </button>
            </div>
            ${children}${open && html`<${TokenEditor} ctx=${ctx} token=${token} />`}
        </li>`;
    }

    function Group({ ctx, group, strip, children, bare = false, note = "" }) {
        const folded = ctx.query === "" && (ctx.s.sysFolded[group.id] ?? group.fold === true);

        const more =
            group.hidden > 0 &&
            html`<button
                type="button"
                class="dsn-link dsy-more"
                onClick=${() => env.showAll(group.id)}
            >
                Show ${group.hidden} more
            </button>`;

        if (bare) {
            return html`<section class="dsy-group bare">${children}${more}</section>`;
        }

        return html`<section
            class="dsy-group"
            data-folded=${folded}
            data-tier=${group.tier}
            aria-label=${group.title}
        >
            <button
                type="button"
                class="dsy-group-head"
                aria-expanded=${!folded}
                onClick=${() => env.toggleGroup(group.id, !folded)}
            >
                <span class="dsy-group-title">${group.title}</span>
                <span class="dsy-group-count">${group.total ?? group.tokens.length}</span>
                ${note && html`<span class="dsy-group-note">${note}</span>`} ${strip}
                <${Ico} name="down" size=${15} class="dsy-group-chev" />
            </button>
            ${!folded && html`<div class="dsy-group-body">${children}${more}</div>`}
        </section>`;
    }

    const SHOWN = 120;

    function groupsFor(ctx, section) {
        return groupsOf(ctx.model.tokens, section)
            .map((group) => {
                const found = group.tokens.filter((token) => matches(token, ctx.query));
                const cut = ctx.query === "" && !ctx.s.sysAll[group.id] && found.length > SHOWN;

                return {
                    ...group,
                    total: found.length,
                    tokens: cut ? found.slice(0, SHOWN) : found,
                    hidden: cut ? found.length - SHOWN : 0,
                };
            })
            .filter((group) => group.tokens.length > 0);
    }

    const listed =
        (section, render) =>
        ({ ctx }) => {
            const groups = groupsFor(ctx, section);

            return groups.length === 0
                ? html`<p class="dsy-empty muted">${EMPTY[section][ctx.query ? 0 : 1]}</p>`
                : render(ctx, groups);
        };

    const rowGroups = (ctx, groups, Row, props = {}) =>
        groups.map(
            (group) =>
                html`<${Group} key=${group.id} ctx=${ctx} group=${group}>
                    <ul class="dsy-rows">
                        ${group.tokens.map(
                            (token) =>
                                html`<${Row}
                                    key=${token.name}
                                    ctx=${ctx}
                                    token=${token}
                                    ...${props}
                                />`,
                        )}
                    </ul>
                <//>`,
        );

    function Overview({ ctx }) {
        const found = ctx.model.roles();

        if (found.canvas === undefined || found.surface === undefined || found.text === undefined) {
            return null;
        }

        const chips = [
            ["danger", "Error"],
            ["warning", "Warning"],
            ["success", "Success"],
        ].filter(([role]) => found[role] !== undefined);

        return html`<div class="dsy-overview" data-count=${ctx.modes.length}>
            ${ctx.modes.map((mode) => {
                const color = (role, fallback) => roleColor(ctx, role, mode, fallback);
                const quiet = color("muted", color("text"));

                return html`<figure
                    class="dsy-look"
                    key=${mode}
                    style=${`background:${color("canvas")}`}
                    aria-label=${`A card in ${mode}, drawn with the system's roles`}
                >
                    <div
                        class="dsy-look-card"
                        style=${`background:${color("surface")};box-shadow:0 0 0 1px ${color("border", "rgb(127 127 127 / .3)")}`}
                    >
                        <strong style=${`color:${color("text")}`}>Card title</strong>
                        <span style=${`color:${color("text")}`}>Body text reads at a glance.</span>
                        <span style=${`color:${quiet}`}>Muted text for the details.</span>
                        <span class="dsy-look-row">
                            <span
                                class="dsy-look-button"
                                style=${`background:${color("accent", color("text"))};color:${color("onAccent", color("surface"))}`}
                                >Primary</span
                            >
                            <span
                                class="dsy-look-button ghost"
                                style=${`color:${color("text")};box-shadow:inset 0 0 0 1px ${color("border", quiet)}`}
                                >Secondary</span
                            >
                        </span>
                        ${
                            chips.length > 0 &&
                            html`<span class="dsy-look-chips">
                                ${chips.map(
                                    ([role, label]) =>
                                        html`<span
                                            class="dsy-look-chip"
                                            key=${role}
                                            style=${`color:${color("text")};box-shadow:inset 0 0 0 1px ${color("border", quiet)}`}
                                            ><i style=${`background:${color(role)}`}></i
                                            >${label}</span
                                        >`,
                                )}
                            </span>`
                        }
                    </div>
                    ${ctx.modes.length > 1 && html`<figcaption style=${`color:${quiet}`}>${mode}</figcaption>`}
                </figure>`;
            })}
        </div>`;
    }

    function Opened({ ctx, group }) {
        const open = group.tokens.find((token) => token.name === ctx.s.sysOpen);

        return (
            open &&
            html`<div class="dsy-ramp-editor" data-token=${open.name}>
                <div class="dsy-ramp-editor-head">
                    <${CopyName} name=${open.name} />
                    ${
                        ctx.modes.length === 1 &&
                        ctx.model.modes.length > 1 &&
                        html`<span class="dsy-mode-chip">${modeTitle(ctx.modes[0])}</span>`
                    }
                    <span class="grow"></span>
                    <button
                        type="button"
                        class="icon-button"
                        aria-label=${`Close ${open.name}`}
                        onClick=${() => env.toggleToken(open.name)}
                    >
                        <${Ico} name="close" size=${15} />
                    </button>
                </div>
                <${TokenEditor} ctx=${ctx} token=${open} />
            </div>`
        );
    }

    const alike = (values) =>
        values.every((each) => swatchCss(each.value) === swatchCss(values[0].value));

    function colorFacts(ctx, token) {
        const all = ctx.modes.map((mode) => ctx.model.value(token.name, mode));
        const infos = ctx.modes.map((mode) => ctx.model.contrastOf(token.name, mode));
        const merged =
            ctx.modes.length > 1 &&
            alike(all) &&
            new Set(infos.map((info) => (info ? `${Math.round(info.ratio * 10)}${info.pass}` : "")))
                .size === 1;

        return {
            values: merged ? all.slice(0, 1) : all,
            modes: merged ? ctx.modes.slice(0, 1) : ctx.modes,
            infos: merged ? infos.slice(0, 1) : infos,
        };
    }

    function roleLabel(ctx, token, facts) {
        const pairs = facts.infos.flatMap((info, index) =>
            info
                ? [
                      `${facts.modes.length > 1 ? `${modeTitle(facts.modes[index])} ` : ""}contrast ${ratioText(info.ratio)} ${verdictOf(info)}`,
                  ]
                : [],
        );

        return [
            token.name,
            hexOf(facts.values[0].value),
            ...pairs,
            inheritedIn(ctx, token) ? `inherited from ${modeTitle(ctx.model.defaultMode)}` : "",
        ]
            .filter(Boolean)
            .join(", ");
    }

    function RoleCards({ ctx, group }) {
        const names = tails(group.tokens);
        const facts = new Map(group.tokens.map((token) => [token, colorFacts(ctx, token)]));

        return html`<${Tiles}
            ctx=${ctx}
            group=${group}
            size="role"
            label=${(token) => roleLabel(ctx, token, facts.get(token))}
            tile=${(token) => {
                const { values, modes, infos } = facts.get(token);

                return html`<${Swatch} values=${values.map((each) => each.value)} size=${46} />
                    <span class="dsy-card-name mono">${names.get(token.name)}</span>
                    <span class="dsy-card-meta">
                        <span class="dsy-hex mono">${hexOf(values[0].value) || "—"}</span>
                        ${infos.map(
                            (info, index) =>
                                html`<${ContrastBadge}
                                    key=${modes[index]}
                                    info=${info}
                                    mode=${modes[index]}
                                    modes=${modes.length}
                                />`,
                        )}
                    </span>`;
            }}
        />`;
    }

    function Strip({ ctx, group }) {
        const names = tails(group.tokens);

        return html`<div class="dsy-strip-row">
            <div class="dsy-strip-head">
                <strong>${group.title}</strong>
                <span class="muted small">${group.tokens.length}</span>
            </div>
            <div class="dsy-strip-steps" role="group" aria-label=${`${group.title} palette`}>
                ${group.tokens.map((token) => {
                    const { values } = colorFacts(ctx, token);
                    const hex = hexOf(values[0].value);

                    return html`<button
                        type="button"
                        key=${token.name}
                        data-token=${token.name}
                        class=${`dsy-step-tile ${token.name === ctx.s.sysOpen ? "on" : ""} ${editedIn(ctx, token) ? "edited" : ""}`}
                        aria-pressed=${token.name === ctx.s.sysOpen}
                        aria-label=${`${token.name}, ${hex}`}
                        title=${`${token.name} ${hex}`}
                        onClick=${() => env.toggleToken(token.name)}
                    >
                        <${Swatch} values=${values.map((each) => each.value)} size=${40} />
                        <span class="dsy-step-label mono">${names.get(token.name)}</span>
                    </button>`;
                })}
            </div>
            <${Opened} ctx=${ctx} group=${group} />
        </div>`;
    }

    const stripOf = (ctx, group) =>
        html`<span class="dsy-strip" aria-hidden="true">
            ${group.tokens
                .slice(0, 9)
                .map(
                    (token) =>
                        html`<i
                            key=${token.name}
                            style=${`background:${swatchCss(firstValue(ctx, token).value)}`}
                        ></i>`,
                )}
        </span>`;

    function colorGroups(ctx, groups) {
        const roles = groups.filter((group) => group.tier === "semantic");
        const palette = groups.filter((group) => group.tier === "primitive");
        const components = groups.filter((group) => group.tier === "component");
        const together = (id, title, list, tier) => ({
            id: `colors:${id}`,
            title,
            tier,
            tokens: list.flatMap((group) => group.tokens),
            total: list.reduce((sum, group) => sum + (group.total ?? group.tokens.length), 0),
            hidden: list.reduce((sum, group) => sum + (group.hidden ?? 0), 0),
            fold: roles.length > 0 || tier === "component",
        });

        return html`${ctx.query === "" && html`<${Overview} ctx=${ctx} />`}
        ${
            roles.length > 0 &&
            html`<h3 class="dsy-section-label">
                Roles
                <span class="dsy-group-count"
                    >${roles.reduce((sum, group) => sum + group.total, 0)}</span
                >
            </h3>`
        }
        ${roles.map(
            (group) =>
                html`<${Group}
                    key=${group.id}
                    ctx=${ctx}
                    group=${group}
                    strip=${stripOf(ctx, group)}
                >
                    <${RoleCards} ctx=${ctx} group=${group} />
                <//>`,
        )}
        ${
            palette.length > 0 &&
            html`<${Group}
                ctx=${ctx}
                group=${together("palette", "Palette", palette, "primitive")}
                note="the raw colors that roles point at"
            >
                ${palette.map((group) => html`<${Strip} key=${group.id} ctx=${ctx} group=${group} />`)}
            <//>`
        }
        ${
            components.length > 0 &&
            html`<${Group}
                ctx=${ctx}
                group=${together("components", "Component colors", components, "component")}
                note="each component's own colors"
            >
                ${components.map(
                    (group) =>
                        html`<div class="dsy-sub" key=${group.id}>
                            <h4 class="dsy-sub-title">${group.title}</h4>
                            <${RoleCards} ctx=${ctx} group=${group} />
                        </div>`,
                )}
            <//>`
        }`;
    }

    const glyph = (style, text = "Aa") =>
        html`<span class="dsy-glyph" style=${style}>${text}</span>`;

    function typeParts(ctx, token, now) {
        const mode = ctx.modes[0];
        const value = valueSpan(token, now);

        if (token.type === "typography") {
            return {
                stacked: true,
                sub: html`<span class="mono"
                    >${typographyMeta(ctx.model, mode, now) ?? styleMeta(now.value)}</span
                >`,
                children: html`<p
                    class="dsy-specimen"
                    style=${typographyStyleOf(ctx.model, mode, now)}
                >
                    ${SAMPLE}
                </p>`,
            };
        }

        if (token.type === "fontFamily") {
            return {
                visual: glyph(typographyStyle({ fontFamily: now.value }), "Ag"),
                sub: html`<span class="mono">${cssOf("fontFamily", now.value) ?? ""}</span>`,
                value,
            };
        }

        if (token.type === "fontWeight") {
            return { visual: glyph(`font-weight:${safeCss(now.value) || 400}`), value };
        }

        if (token.type === "number") {
            return {
                visual: html`<span
                    class="dsy-leading"
                    style=${`line-height:${safeCss(now.value) || 1.4}`}
                    >Aa<br />Aa</span
                >`,
                value,
            };
        }

        const px = pixelsOf(now.value);

        return {
            visual: glyph(px === null ? "" : `font-size:${Math.min(px, 30)}px`),
            sub:
                px === null
                    ? null
                    : html`<span class="mono"
                          >${px}px${px % 16 === 0 ? ` · ${px / 16}rem` : ""}</span
                      >`,
            value,
        };
    }

    const TypeRow = ({ ctx, token }) =>
        html`<${TokenRow}
            ctx=${ctx}
            token=${token}
            ...${typeParts(ctx, token, firstValue(ctx, token))}
        />`;

    const OtherRow = ({ ctx, token }) =>
        html`<${TokenRow}
            ctx=${ctx}
            token=${token}
            sub=${token.description ?? ""}
            value=${valueSpan(token, firstValue(ctx, token))}
        />`;

    const VAGUE = new Set(
        "in out on off sm md lg xs xl xxl x y top bottom left right start end inner outer base default main alt hover active".split(
            " ",
        ),
    );

    const labelsOf = (group) => {
        const names = tails(group.tokens);

        if (group.kind === "steps" || group.kind === "scale") {
            return names;
        }

        return new Map(
            group.tokens.map((token) => {
                const tail = names.get(token.name);
                const last = token.path[token.path.length - 1].toLowerCase();

                return [token.name, token.path.length > 1 && VAGUE.has(last) ? token.name : tail];
            }),
        );
    };

    const GROUP_NOTES = {
        steps: "the scale that padding, margins, and gaps move in",
        sizes: "heights and widths for controls, icons, and marks",
        scale: "the corners: every role points at one of these",
    };

    function ByStep({ ctx, group, steps, tile, size }) {
        const mode = ctx.modes[0];
        const px = (token) => pixelsOf(ctx.model.value(token.name, mode).value) ?? 0;
        const ordered = [...steps].sort((a, b) => px(a) - px(b));
        const names = new Set(ordered.map((token) => token.name));
        const buckets = new Map(ordered.map((token) => [token.name, []]));
        const own = [];

        for (const token of group.tokens) {
            const step = ctx.model
                .chain(token.name, mode)
                .slice(1)
                .find((name) => names.has(name));

            (step === undefined ? own : buckets.get(step)).push(token);
        }

        const sets = [
            ...ordered.map((token) => [token, buckets.get(token.name)]),
            [null, own],
        ].filter(([, tokens]) => tokens.length > 0);
        const label = tails(ordered);

        return html`${sets.map(([step, tokens]) => {
            const id = `${group.id}>${step?.name ?? ""}`;
            const part = { ...group, id, tokens };

            return html`<div class="dsy-by-step" key=${id}>
                <h4 class="dsy-by-step-head">
                    ${
                        step
                            ? html`<span class="mono"
                                      >${/^\d+$/.test(label.get(step.name)) ? step.name : label.get(step.name)}</span
                                  >
                                  <span class="muted mono"
                                      >${showValue(step, ctx.model.value(step.name, mode))}</span
                                  >`
                            : html`<span>Own value</span>
                                  <span class="muted">not a step of the scale</span>`
                    }
                </h4>
                <${Tiles}
                    ctx=${ctx}
                    group=${part}
                    size=${size}
                    tile=${(token) => tile(token, labelsOf(group))}
                />
            </div>`;
        })}`;
    }

    function scaleGroups(ctx, groups, section, tile) {
        const { stepKind, size, rolesNote } = SCALES[section];

        return groups.map(
            (group) =>
                html`<${Group}
                    key=${group.id}
                    ctx=${ctx}
                    group=${group}
                    note=${GROUP_NOTES[group.kind] ?? (group.kind === "roles" ? rolesNote : "")}
                    bare=${groups.length === 1}
                >
                    ${
                        group.kind === "roles"
                            ? html`<${ByStep}
                                  ctx=${ctx}
                                  group=${group}
                                  steps=${groupsOf(ctx.model.tokens, section)
                                      .filter((each) => each.kind === stepKind)
                                      .flatMap((each) => each.tokens)}
                                  size=${size}
                                  tile=${tile}
                              />`
                            : html`<${Tiles}
                                  ctx=${ctx}
                                  group=${group}
                                  size=${size}
                                  tile=${(token) => tile(token, labelsOf(group), group.kind)}
                              />`
                    }
                <//>`,
        );
    }

    const scaleSection = (section, tileFor) =>
        listed(section, (ctx, groups) => scaleGroups(ctx, groups, section, tileFor(ctx, groups)));

    function spaceTile(ctx, groups) {
        const mode = ctx.modes[0];
        const widest = Math.max(
            1,
            ...groups
                .filter((group) => group.kind !== "sizes")
                .flatMap((group) =>
                    group.tokens.map(
                        (token) => pixelsOf(ctx.model.value(token.name, mode).value) ?? 0,
                    ),
                ),
        );

        return (token, names, kind) => {
            const now = ctx.model.value(token.name, mode);
            const px = pixelsOf(now.value);

            return html`${
                    kind === "sizes"
                        ? html`<span class="dsy-space"
                              ><i
                                  class="dsy-size"
                                  style=${`width:${Math.min(px ?? 0, 44)}px;height:${Math.min(px ?? 0, 44)}px`}
                              ></i
                          ></span>`
                        : html`<span class="dsy-space"
                              ><i
                                  style=${`width:${px === null ? 0 : Math.max(2, Math.min(100, (px / widest) * 100))}%`}
                              ></i
                          ></span>`
                }
                <span class="dsy-tile-name mono">${names.get(token.name)}</span>
                <span class="dsy-tile-hex dsy-hex mono">${showValue(token, now)}</span>`;
        };
    }

    const radiusTile = (ctx) => (token, names) => {
        const now = firstValue(ctx, token);
        const px = pixelsOf(now.value);

        return html`<span
                class="dsy-corner"
                style=${`border-radius:${px === null ? 0 : Math.min(px, 36)}px`}
            ></span>
            <span class="dsy-tile-name mono">${names.get(token.name)}</span>
            <span class="dsy-tile-hex mono">${showValue(token, now)}</span>`;
    };

    const inheritedIn = (ctx, token) =>
        ctx.modes.length === 1 &&
        ctx.modes[0] !== ctx.model.defaultMode &&
        !ctx.model.overridden(token.name, ctx.modes[0]);

    function Tiles({ ctx, group, tile, label, extra, size = "sm" }) {
        return html`<div class="dsy-ramp-wrap">
            <div class="dsy-tiles" data-size=${size}>
                ${group.tokens.map((token) => {
                    const inherited = inheritedIn(ctx, token);
                    const button = html`<button
                        type="button"
                        key=${token.name}
                        data-token=${token.name}
                        class=${`dsy-card-tile ${token.name === ctx.s.sysOpen ? "on" : ""} ${editedIn(ctx, token) ? "edited" : ""} ${inherited ? "inherited" : ""}`}
                        title=${inherited ? `Inherited from ${modeTitle(ctx.model.defaultMode)}` : undefined}
                        aria-pressed=${token.name === ctx.s.sysOpen}
                        aria-label=${label ? label(token) : token.name}
                        onClick=${() => env.toggleToken(token.name)}
                    >
                        ${tile(token)}
                    </button>`;

                    // A button cannot hold another: the wrapper holds both.
                    return extra
                        ? html`<div class="dsy-tile-wrap" key=${token.name}>
                              ${button}${extra(token)}
                          </div>`
                        : button;
                })}
            </div>
            <${Opened} ctx=${ctx} group=${group} />
        </div>`;
    }

    function ShadowLines({ ctx, token }) {
        const sets = ctx.modes.map((mode) => ({
            mode,
            lines: shadowLines(ctx.model.value(token.name, mode).value),
        }));
        const same = sets.every(
            (set) => JSON.stringify(set.lines) === JSON.stringify(sets[0].lines),
        );

        return html`<span class="dsy-shadow-lines">
            ${(same ? [sets[0]] : sets).map(
                (set) =>
                    html`<span class="dsy-shadow-set" key=${set.mode}>
                        ${!same && html`<em>${modeTitle(set.mode)}</em>`}
                        ${set.lines.map(
                            (line, at) =>
                                html`<span class="dsy-shadow-line" key=${at}>
                                    <i
                                        style=${`--c:${swatchCss(line.color)}`}
                                        title=${typeof line.color === "string" ? line.color : undefined}
                                        aria-hidden="true"
                                    ></i>
                                    <span class="mono">${line.words}</span>
                                </span>`,
                        )}
                    </span>`,
            )}
        </span>`;
    }

    function shadowTile(ctx, group, token) {
        return html`<span class="dsy-stages">
                ${ctx.modes.map((mode) => {
                    const ground = roleColor(ctx, "canvas", mode);
                    const card = roleColor(ctx, "surface", mode);
                    const shadow = shadowOf(ctx.model.value(token.name, mode).value);

                    return html`<span
                        class="dsy-stage"
                        key=${mode}
                        style=${ground ? `background:${ground}` : ""}
                    >
                        <i
                            style=${`${card ? `background:${card};` : ""}box-shadow:${shadow || "none"}`}
                        ></i>
                    </span>`;
                })}
            </span>
            <span class="dsy-tile-name mono">${tails(group.tokens).get(token.name)}</span>
            <${ShadowLines} ctx=${ctx} token=${token} />`;
    }

    const copyShadow = (ctx, token) =>
        html`<button
            type="button"
            class="dsy-copy"
            title="Copy the CSS value"
            aria-label=${`Copy the CSS value of ${token.name}`}
            onClick=${async () => {
                const css = shadowOf(firstValue(ctx, token).value);

                if (css && (await copyText(css))) {
                    pocket.notify(
                        "info",
                        `Copied ${css.length > 60 ? `${css.slice(0, 60)}…` : css}`,
                    );
                }
            }}
        >
            <${Ico} name="copy" size=${13} />
        </button>`;

    const shadowGroups = (ctx, groups) =>
        groups.map(
            (group) =>
                html`<${Group}
                    key=${group.id}
                    ctx=${ctx}
                    group=${group}
                    bare=${groups.length === 1}
                >
                    <${Tiles}
                        ctx=${ctx}
                        group=${group}
                        size="shadow"
                        tile=${(token) => shadowTile(ctx, group, token)}
                        extra=${(token) => copyShadow(ctx, token)}
                    />
                <//>`,
        );

    function useRun() {
        const dot = useRef(null);
        const track = useRef(null);

        return {
            dot,
            track,
            run(ms, easing) {
                const element = dot.current;
                const room = track.current;

                if (!element || !room || typeof element.animate !== "function") {
                    return;
                }

                for (const animation of element.getAnimations()) {
                    animation.cancel();
                }

                const distance = Math.max(0, room.clientWidth - element.clientWidth);

                element.animate(
                    [{ transform: "translateX(0)" }, { transform: `translateX(${distance}px)` }],
                    {
                        duration: Math.max(1, Math.min(5000, ms)),
                        easing,
                        direction: "alternate",
                        iterations: 2,
                        delay: 0,
                        endDelay: 120,
                    },
                );
            },
        };
    }

    const track = (motion) =>
        html`<span class="dsy-track" ref=${motion.track}><i ref=${motion.dot}></i></span>`;

    const playButton = (token, disabled, play) =>
        html`<button
            type="button"
            class="dsy-play"
            aria-label=${`Play ${token.name}`}
            disabled=${disabled}
            onClick=${(event) => {
                event.stopPropagation();
                play();
            }}
        >
            <${Ico} name="play" size=${14} />
        </button>`;

    function MotionRow({ ctx, token, easing }) {
        const motion = useRun();
        const now = firstValue(ctx, token);

        if (token.type === "duration") {
            const ms = millisecondsOf(now.value);

            return html`<${TokenRow}
                ctx=${ctx}
                token=${token}
                visual=${playButton(token, ms === null, () => motion.run(ms ?? 0, easing))}
                sub=${track(motion)}
                value=${valueSpan(token, now)}
            />`;
        }

        if (token.type !== "cubicBezier") {
            return html`<${TokenRow} ctx=${ctx} token=${token} value=${valueSpan(token, now)} />`;
        }

        const curve = Array.isArray(now.value) && now.value.length === 4 ? now.value : null;
        const css = cssOf("cubicBezier", now.value);

        return html`<${TokenRow}
            ctx=${ctx}
            token=${token}
            visual=${curve ? html`<${Curve} value=${curve} size=${56} />` : null}
            sub=${html`<span class="dsy-motion-sub"
                ><span class="mono">${showValue(token, now)}</span>${track(motion)}</span
            >`}
            value=${playButton(token, css === undefined, () => motion.run(900, css))}
        />`;
    }

    function easingOf(ctx) {
        const first = ctx.model.tokens.find((token) => token.type === "cubicBezier");

        return (first && cssOf("cubicBezier", firstValue(ctx, first).value)) || "ease";
    }

    function Specimen({ ctx, component, mode }) {
        const frame = useRef(null);
        const color = (role, fallback) => roleColor(ctx, role, mode, fallback);
        const scheme = ctx.model.system.schemes?.[mode];
        const dark = scheme === undefined ? /dark/i.test(mode) : scheme === "dark";
        const doc = specimenDocument({
            component,
            mode,
            scheme,
            theme: themeCss(ctx.model, mode),
            colors: {
                canvas: color("canvas", dark ? "#12131a" : "#f6f7fb"),
                surface: color("surface", dark ? "#1c1e26" : "#ffffff"),
                text: color("text", dark ? "#f6f7fb" : "#1c1e26"),
            },
        });

        // `allow-same-origin` only lets the page read the frame's height; with no `allow-scripts` nothing in the frame runs.
        return html`<iframe
            ref=${frame}
            class="dsy-specimen-frame"
            title=${`${component.name}, ${mode}`}
            sandbox="allow-same-origin"
            referrerpolicy="no-referrer"
            srcdoc=${doc}
            loading="lazy"
            onLoad=${() => {
                const body = frame.current?.contentDocument?.body;

                if (body && frame.current) {
                    frame.current.style.height = `${Math.min(900, Math.max(60, Math.ceil(body.getBoundingClientRect().height)))}px`;
                }
            }}
        ></iframe>`;
    }

    const usageList = (kind, lines) =>
        lines.length > 0 &&
        html`<ul class=${kind}>
            ${lines.slice(0, 6).map((line) => html`<li>${line}</li>`)}
        </ul>`;

    function ComponentCard({ ctx, component }) {
        const { usage } = component;

        return html`<article class="dsy-component">
            <header>
                <h3>${component.name}</h3>
                <span class="dsy-chip-static mono"
                    >${plural(component.states.length, "state")}</span
                >
                <span class="grow"></span>
                <${CopyName} name=${component.slug} />
            </header>
            ${component.description && html`<p class="muted dsy-component-note">${component.description}</p>`}
            <div class="dsy-specimens" data-count=${ctx.modes.length}>
                ${ctx.modes.map(
                    (mode) =>
                        html`<div class="dsy-specimen-box" key=${mode}>
                            ${ctx.modes.length > 1 && html`<span class="dsy-specimen-mode mono">${mode}</span>`}
                            <${Specimen} ctx=${ctx} component=${component} mode=${mode} />
                        </div>`,
                )}
            </div>
            ${
                usage &&
                (usage.do.length > 0 || usage.dont.length > 0) &&
                html`<div class="dsy-usage">
                    ${usageList("do", usage.do)}${usageList("dont", usage.dont)}
                </div>`
            }
            ${
                component.tokens.length > 0 &&
                html`<${UsedChips} names=${component.tokens} max=${8} has=${ctx.model.has}>
                    <span class="muted small dsy-used-more"
                        >${`and ${component.tokens.length - 8} more`}</span
                    >
                <//>`
            }
        </article>`;
    }

    function Components({ ctx }) {
        const list = ctx.model.system.components.filter((component) => {
            const words = ctx.query.trim().toLowerCase();

            return (
                words === "" ||
                `${component.name} ${component.description} ${component.slug}`
                    .toLowerCase()
                    .includes(words)
            );
        });

        if (list.length === 0) {
            return html`<div class="dsy-blank">
                <${Ico} name="box" size=${28} />
                <h3>${ctx.query ? "No component matches." : "No components yet"}</h3>
                ${
                    !ctx.query &&
                    html`<p class="muted">
                        A component is a button, a field, or a card, written once with the system's
                        tokens, with each of its states (default, hover, focus, disabled, error). Pi
                        reuses their markup in designs.
                    </p>`
                }
                ${
                    !ctx.query &&
                    ctx.canEdit &&
                    html`<button
                        type="button"
                        class="button primary"
                        onClick=${() => env.askPi("components")}
                    >
                        <${Ico} name="sparkle" size=${15} /> Ask Pi for the core components
                    </button>`
                }
            </div>`;
        }

        return html`${list.map(
            (component) =>
                html`<${ComponentCard} key=${component.slug} ctx=${ctx} component=${component} />`,
        )}
        ${
            ctx.canEdit &&
            ctx.query === "" &&
            html`<button
                type="button"
                class="dsn-link dsy-more"
                onClick=${() => env.askPi("component")}
            >
                <${Ico} name="sparkle" size=${14} /> Ask Pi for another component
            </button>`
        }`;
    }

    function Guidelines({ ctx }) {
        const text = ctx.guidelines;
        const writing = ctx.s.sysWriting;
        const [draft, setDraft] = useState(null);
        const area = useRef(null);

        useEffect(() => {
            if (writing) {
                area.current?.focus({ preventScroll: true });
            }
        }, [writing]);

        if (writing && ctx.canEdit) {
            return html`<div class="dsy-write">
                <textarea
                    ref=${area}
                    class="mono"
                    value=${draft ?? text}
                    maxlength="16000"
                    spellcheck="true"
                    aria-label="Guidelines, in Markdown"
                    onInput=${(event) => {
                        setDraft(event.currentTarget.value);
                        env.editGuidelines(event.currentTarget.value);
                    }}
                ></textarea>
                <div class="dsy-write-foot">
                    <span class="muted small"
                        >${(draft ?? text).length.toLocaleString()} of 16,000 characters.
                        Markdown.</span
                    >
                    <span class="grow"></span>
                    <button
                        type="button"
                        class="button small"
                        onClick=${() => store.set({ sysWriting: false })}
                    >
                        Done
                    </button>
                </div>
            </div>`;
        }

        if (text.trim() === "") {
            return html`<div class="dsy-blank">
                <${Ico} name="book" size=${28} />
                <h3>No guidelines yet</h3>
                <p class="muted">
                    Guidelines are the rules in words: the voice, the layout, what to do and what
                    not to do. Pi reads them before it designs.
                </p>
                ${
                    ctx.canEdit &&
                    html`<div class="dsy-blank-actions">
                        <button
                            type="button"
                            class="button primary"
                            onClick=${() => store.set({ sysWriting: true })}
                        >
                            <${Ico} name="pen" size=${15} /> Write them
                        </button>
                        <button
                            type="button"
                            class="button"
                            onClick=${() => env.askPi("guidelines")}
                        >
                            <${Ico} name="sparkle" size=${15} /> Ask Pi
                        </button>
                    </div>`
                }
            </div>`;
        }

        return html`<article class="dsy-prose">
            ${
                ctx.canEdit &&
                html`<button
                    type="button"
                    class="dsn-link dsy-edit-guidelines"
                    onClick=${() => store.set({ sysWriting: true })}
                >
                    <${Ico} name="pen" size=${13} /> Edit
                </button>`
            }
            <${Markdown} text=${text} />
        </article>`;
    }

    return {
        colors: listed("colors", colorGroups),
        type: listed("type", (ctx, groups) => rowGroups(ctx, groups, TypeRow)),
        spacing: scaleSection("spacing", spaceTile),
        radii: scaleSection("radii", radiusTile),
        shadows: listed("shadows", shadowGroups),
        motion: listed("motion", (ctx, groups) =>
            rowGroups(ctx, groups, MotionRow, { easing: easingOf(ctx) }),
        ),
        other: ({ ctx }) => rowGroups(ctx, groupsFor(ctx, "other"), OtherRow),
        components: Components,
        guidelines: Guidelines,
    };
}
