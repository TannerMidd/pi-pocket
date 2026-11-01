// The page runs in the artifact sandbox and asks for nothing. All project text is data: it is escaped, token values that
// reach a style are checked first, and component markup and CSS show in a shadow root only after the page's script has
// rebuilt them from an allowlist, under a policy that blocks every request.
import { randomBytes } from "node:crypto";
import { contrastRatio, parseColor, toHex } from "./color.ts";
import { colorSection, pairRows } from "./docsite-color-section.ts";
import { componentsSection } from "./docsite-components.ts";
import {
    type Ctx,
    type SectionId,
    type SystemDoc,
    BASE_GROUNDS,
    BASE_TEXTS,
    MAX_COMPONENTS,
    MAX_PAGE,
    MAX_TOKENS,
    anchor,
    buildContext,
    clip,
    colorOf,
    countsLine,
    findToken,
    idOf,
    modeLabel,
    pageCsp,
    readableOn,
    safeCss,
    safeVar,
    sectionCount,
    valueIn,
    varOf,
} from "./docsite-core.ts";
import { DOC_CSS } from "./docsite-css.ts";
import { DOC_BOOT_JS, DOC_JS } from "./docsite-js.ts";
import { escapeHtml as esc, plural, renderMarkdown } from "./docsite-markdown.ts";
import { codeSection, problemsHtml, referenceSection } from "./docsite-reference.ts";
import { otherSection, radiiSection, shadowSection, spacingSection } from "./docsite-space.ts";
import { motionSection, typographySection } from "./docsite-type.ts";
import type { DesignSystem, ResolvedToken } from "./system-types.ts";

export type { SystemDoc } from "./docsite-core.ts";

interface Block {
    id: string;
    title: string;
    group: "Foundations" | "Components" | "Reference";
    html: string;
    count?: number;
    searchable?: boolean;
}

const ACCENTS = [
    "color.accent.default",
    "color.accent.primary",
    "color.accent.fill",
    "color.primary.default",
    "color.brand.default",
    "color.accent",
];

function chromeAccent(ctx: Ctx, theme: "light" | "dark"): string {
    const fallback = theme === "dark" ? "#8fb0ff" : "#3557a5";
    const page = parseColor(theme === "dark" ? "#0e0f15" : "#fafafc")!;
    const mode = ctx.modes.find((each) => ctx.theme.get(each) === theme);
    const color = mode === undefined ? undefined : colorOf(findToken(ctx, ACCENTS), mode);
    const accent =
        color !== undefined && color.a >= 0.999 && contrastRatio(color, page) >= 4.5
            ? toHex(color)
            : fallback;
    const parsed = parseColor(accent)!;

    return `--dd-accent:${accent};--dd-accent-ink:${readableOn(parsed)};--dd-accent-soft:${toHex({ ...parsed, a: theme === "dark" ? 0.18 : 0.1 })}`;
}

const ICON_MENU = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14"/></svg>`;

const SAMPLER: [string, string[], RegExp][] = [
    ["background", BASE_GROUNDS, /^color\.(bg|background)\.(base|default|canvas|page)$/],
    [
        "surface",
        ["color.bg.surface", "color.surface.default", "color.surface"],
        /^color\.(surface|card)\./,
    ],
    ["text", BASE_TEXTS, /^color\.(text|fg|foreground)\.(primary|default|base)$/],
    [
        "muted",
        ["color.text.muted", "color.text.secondary"],
        /^color\.(text|fg)\.(muted|secondary|subtle)$/,
    ],
    ["border", ["color.border.default", "color.border"], /^color\.border\./],
    ["accent", ACCENTS, /(accent|primary)/],
    ["danger", ["color.danger.default", "color.error.default"], /(danger|error|negative)/],
    ["warning", ["color.warning.default"], /warning/],
    ["success", ["color.success.default", "color.positive.default"], /(success|positive)/],
    ["info", ["color.info.default"], /info/],
    ["brand", ["color.brand.default", "color.brand"], /brand/],
    ["code", ["color.code.bg"], /code\.bg/],
];

function sampler(ctx: Ctx): string {
    const semantic = ctx.system.tokens.filter(
        (token) => token.type === "color" && token.tier === "semantic",
    );
    const chosen: { label: string; token: ResolvedToken }[] = [];
    const add = (label: string, token: ResolvedToken | undefined) =>
        token !== undefined &&
        !chosen.some((item) => item.token === token) &&
        chosen.push({ label, token });

    for (const [label, names, pattern] of SAMPLER) {
        add(
            label,
            findToken(ctx, names) ??
                semantic.find(
                    (token) =>
                        pattern.test(token.name) &&
                        !/on-|inverse|hover|active|soft|line|scrim/.test(token.name),
                ),
        );
    }

    for (const token of semantic.slice(0, 8)) {
        if (chosen.length < 8) {
            add(token.path.slice(-2).join(" "), token);
        }
    }

    return chosen.length === 0
        ? ""
        : `<div class="strip">${chosen
              .slice(0, 12)
              .map(
                  ({ label, token }) =>
                      `<button type="button" class="sw" data-copy="${esc(token.name)}" title="${esc(token.name)}"><i style="background:${varOf(token)}"></i><span>${esc(clip(label, 12))}</span></button>`,
              )
              .join("")}</div>`;
}

function tokenVars(ctx: Ctx): string {
    const first = ctx.modes[0]!;
    const declare = (mode: string, only: (token: ResolvedToken) => boolean) =>
        ctx.system.tokens
            .filter(only)
            .map((token) => {
                const css = safeCss(valueIn(token, mode)?.css);

                return css === undefined || safeVar(token.cssVar) === undefined
                    ? ""
                    : `${token.cssVar}:${css};`;
            })
            .join("");
    const rules = [`body.ds{${declare(first, () => true)}}`];

    for (const mode of ctx.modes.slice(1)) {
        const changed = declare(
            mode,
            (token) => valueIn(token, mode)?.css !== valueIn(token, first)?.css,
        );

        if (changed !== "") {
            rules.push(`html[data-mode="${ctx.slug.get(mode)}"] body.ds{${changed}}`);
        }
    }

    return rules.join("\n");
}

export function renderSystemDoc(system: DesignSystem): SystemDoc {
    let rows = MAX_TOKENS;
    let doc = build(system, rows);

    while (Buffer.byteLength(doc.html) > MAX_PAGE && rows > 25) {
        rows = Math.floor(rows / 2);
        doc = build(system, rows);
    }

    return doc;
}

const TOKEN_SECTIONS: [SectionId, string, (ctx: Ctx) => string | undefined][] = [
    ["color", "Color", colorSection],
    ["typography", "Typography", typographySection],
    ["spacing", "Spacing", spacingSection],
    ["radii", "Radii", radiiSection],
    ["shadows", "Shadows", shadowSection],
    ["motion", "Motion", motionSection],
    ["other", "Other", otherSection],
];

function build(system: DesignSystem, referenceRows: number): SystemDoc {
    const ctx = buildContext(system);
    // The page's scripts carry this, and nothing in project text can know it: it is new for each page.
    const nonce = randomBytes(16).toString("base64url");
    const name = clip(system.name || "Design system", 80);
    const sections: Block[] = [];

    for (const [id, title, make] of TOKEN_SECTIONS) {
        const html = make(ctx);

        if (html !== undefined) {
            sections.push({
                id,
                title,
                group: "Foundations",
                html: countsLine(ctx, id) + html,
                count: sectionCount(ctx, id).headline,
                searchable: true,
            });
        }
    }

    const components = componentsSection(ctx);

    if (components !== undefined) {
        sections.push({
            id: "components",
            title: "Components",
            group: "Components",
            html: components,
            count: Math.min(system.components.length, MAX_COMPONENTS),
            searchable: true,
        });
    }

    if (system.guidelines.trim() !== "") {
        sections.push({
            id: "guidelines",
            title: "Guidelines",
            group: "Reference",
            html: `<div class="prose">${renderMarkdown(system.guidelines)}</div>`,
        });
    }

    sections.push(
        {
            id: "tokens",
            title: "All tokens",
            group: "Reference",
            html: referenceSection(ctx, referenceRows),
            count: system.tokens.length,
            searchable: true,
        },
        { id: "code", title: "Use in code", group: "Reference", html: codeSection(ctx) },
    );

    const pairs = pairRows(ctx);
    const roleCount = ctx.system.tokens.filter(
        (token) => token.type === "color" && token.tier === "semantic",
    ).length;
    const stat = (value: string, label: string) =>
        `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
    const count = (value: number, noun: string) =>
        stat(String(value), plural(value, noun).slice(String(value).length + 1));
    const overview = `<section class="block" id="overview" data-pid="overview" aria-labelledby="overview-title"><div class="hero"><p class="eyebrow">Design system</p><h1 id="overview-title">${esc(name)}</h1>${system.description === undefined ? "" : `<p class="lead">${esc(clip(system.description, 400))}</p>`}${sampler(ctx)}<div class="stats">${count(ctx.system.tokens.length, "token")}${count(roleCount, "color role")}${count(ctx.modes.length, "mode")}${count(ctx.system.components.length, "component")}${pairs.total > 0 ? stat(`${pairs.passing}/${pairs.total}`, pairs.total === 1 ? "contrast check passes" : "contrast checks pass") : ""}</div></div>${problemsHtml(ctx)}${system.tokens.length > MAX_TOKENS ? `<p class="sub">This page shows the first ${MAX_TOKENS} of ${system.tokens.length} tokens.</p>` : ""}</section>`;
    const body = sections
        .map(
            (section) =>
                `<section class="block" id="${section.id}" data-pid="${section.id}" aria-labelledby="${section.id}-title"${section.searchable ? " data-searchable" : ""}><p class="eyebrow">${section.group}</p><h2 id="${section.id}-title">${esc(section.title)}${anchor(section.id, section.title)}</h2>${section.html}</section>`,
        )
        .join("");
    const nav = (["Foundations", "Components", "Reference"] as const)
        .map((group) => {
            const links = sections
                .filter((section) => section.group === group)
                .map(
                    (section) =>
                        `<a href="#${section.id}">${esc(section.title)}${section.count === undefined ? "" : `<span class="count">${section.count}</span>`}</a>${
                            section.id !== "components"
                                ? ""
                                : system.components
                                      .slice(0, MAX_COMPONENTS)
                                      .map(
                                          (spec) =>
                                              `<a class="sub-link" href="#comp-${idOf(spec.slug)}">${esc(spec.name)}</a>`,
                                      )
                                      .join("")
                        }`,
                )
                .join("");

            return links === "" ? "" : `<p class="nav-title">${group}</p>${links}`;
        })
        .join("");
    const first = ctx.modes[0]!;
    const darkMode = ctx.modes.find(
        (mode) => ctx.theme.get(mode) === "dark" && ctx.theme.get(first) !== "dark",
    );
    const modeAttrs = (mode: string) =>
        `data-mode="${ctx.slug.get(mode)}" data-theme="${esc(ctx.theme.get(mode) ?? "light")}"`;
    const modeSwitch =
        ctx.modes.length < 2
            ? ""
            : `<div class="seg" role="group" aria-label="Mode">${ctx.modes.map((mode, index) => `<button type="button" ${modeAttrs(mode)} aria-pressed="${index === 0}">${esc(modeLabel(mode))}</button>`).join("")}</div><select class="modesel" aria-label="Mode">${ctx.modes.map((mode, index) => `<option value="${ctx.slug.get(mode)}" data-theme="${esc(ctx.theme.get(mode) ?? "light")}"${index === 0 ? " selected" : ""}>${esc(modeLabel(mode))}</option>`).join("")}</select>`;
    const modeCss = ctx.modes
        .map(
            (mode, index) =>
                `html:not([data-mode="${ctx.slug.get(mode)}"]) .mv[data-m="${index}"]{display:none}`,
        )
        .join("\n");
    const html = `<!doctype html>
<html lang="en" class="nojs" ${modeAttrs(first)}${darkMode === undefined ? "" : ` data-dark-mode="${ctx.slug.get(darkMode)}"`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${pageCsp(nonce)}">
<meta name="color-scheme" content="light dark">
<title>${esc(name)} · Design system</title>
<script nonce="${nonce}">${DOC_BOOT_JS}</script>
<style>${DOC_CSS}
html[data-theme="light"]{${chromeAccent(ctx, "light")}}
html[data-theme="dark"]{${chromeAccent(ctx, "dark")}}
${modeCss}
</style>
<style>${tokenVars(ctx)}</style>
</head>
<body class="ds">
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
<button class="icon-btn" type="button" aria-label="Menu" aria-controls="nav" aria-expanded="false">${ICON_MENU}</button>
<div class="brand"><span class="brand-name">${esc(name)}</span><span class="brand-sub">Design system</span></div>
${modeSwitch}
</header>
<div class="layout">
<aside class="side" id="nav">
<input id="q" type="search" placeholder="Filter tokens and values" aria-label="Filter tokens, values, and components" autocomplete="off" spellcheck="false">
<nav class="nav" aria-label="Sections"><a href="#overview" aria-current="true">Overview</a>${nav}</nav>
</aside>
<main id="main">
${overview}
${body}
<p class="empty" id="nomatch" hidden>No token or component matches that filter.</p>
<footer class="foot"><strong>${esc(name)}</strong> · ${plural(ctx.system.tokens.length, "token")} · ${plural(ctx.modes.length, "mode")} · ${plural(ctx.system.components.length, "component")} · generated ${new Date().toISOString().slice(0, 10)} by Pi Pocket</footer>
</main>
</div>
<div class="toast" role="status" aria-live="polite"></div>
<script nonce="${nonce}">${DOC_JS}</script>
</body>
</html>
`;

    return {
        html: html.replace(
            /<h3 id="([^"]+)">([^<]*)<\/h3>/g,
            (_all, id: string, text: string) => `<h3 id="${id}">${text}${anchor(id, text)}</h3>`,
        ),
        assets: [],
    };
}
