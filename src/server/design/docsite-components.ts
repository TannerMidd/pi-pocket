import { escapeHtml as esc, plural } from "./docsite-markdown.ts";
import {
    type Ctx,
    MAX_CODE,
    MAX_COMPONENTS,
    MAX_STATES,
    anchor,
    clip,
    groundToken,
    idOf,
    textToken,
} from "./docsite-core.ts";
import type { ComponentSpec } from "./system-types.ts";

export const snippet = (id: string, text: string, label: string, kind = "") =>
    `<div class="snip"${kind === "" ? "" : ` data-kind="${kind}" data-panel="${esc(label)}"`}><div class="snip-head"><span>${esc(label)}</span><button class="mini" type="button" data-copy-from="${esc(id)}">Copy</button></div><pre id="${esc(id)}"><code>${esc(text)}</code></pre></div>`;

function stage(ctx: Ctx): string {
    const ground = groundToken(ctx);
    const text = textToken(ctx);
    const family = ctx.system.tokens.find(
        (token) => token.type === "fontFamily" && token.tier !== "component",
    );
    const style = [
        ground === undefined ? "" : `--g:var(${ground.cssVar});`,
        text === undefined ? "" : `--t:var(${text.cssVar});`,
        family === undefined ? "" : `--f:var(${family.cssVar});`,
    ].join("");

    return `<div class="comp-stage" role="group" aria-label="States"${style === "" ? "" : ` style="${esc(style)}"`}><p class="sub">The states show when script runs; the markup and CSS are below.</p></div>`;
}

function article(ctx: Ctx, spec: ComponentSpec, index: number): string {
    const id = `comp-${idOf(spec.slug)}`;
    const states = spec.states.slice(0, MAX_STATES);
    const list = (title: string, items: string[], kind: string) =>
        items.length === 0
            ? ""
            : `<div class="${kind}"><h4>${title}</h4><ul>${items
                  .slice(0, 12)
                  .map((item) => `<li>${esc(clip(item, 300))}</li>`)
                  .join("")}</ul></div>`;
    const usage =
        spec.usage === undefined
            ? ""
            : list("Do", spec.usage.do, "do") + list("Don’t", spec.usage.dont, "dont");
    const tokens = spec.tokens
        .slice(0, 80)
        .map((name) => `<button class="tk">${esc(name)}</button>`)
        .join("");
    const code = [
        ...states.map((state, at) =>
            snippet(
                `code-${index}-${at}`,
                clip(spec.markup[state] ?? "", MAX_CODE),
                state,
                "state",
            ),
        ),
        snippet(`code-${index}-css`, clip(spec.css, MAX_CODE), "css", "css"),
    ].join("");

    return `<article class="comp" id="${id}" data-pid="${id}" data-s><div class="row-head"><h3>${esc(spec.name)}${anchor(id, spec.name)}</h3><span class="pill">${plural(states.length, "state")}</span></div><p class="intro">${esc(spec.description)}</p>${stage(ctx)}${usage === "" ? "" : `<div class="dos">${usage}</div>`}${tokens === "" ? "" : `<details class="fold"><summary>Tokens it uses <span class="pill">${Math.min(spec.tokens.length, 80)}</span></summary><div class="chips">${tokens}</div></details>`}<details class="fold"><summary>Markup and CSS</summary>${code}</details></article>`;
}

export function componentsSection(ctx: Ctx): string | undefined {
    const components = ctx.system.components.slice(0, MAX_COMPONENTS);

    return components.length === 0
        ? undefined
        : `<p class="intro">${plural(components.length, "component")}, each shown in every state and in the mode you chose. Copy the markup to reuse it.</p>${components.map((spec, index) => article(ctx, spec, index)).join("")}`;
}
