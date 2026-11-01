import { contrastRatio } from "./color.ts";
import { escapeHtml as esc, plural } from "./docsite-markdown.ts";
import {
    type Ctx,
    TEXT_SEGMENTS,
    colorOf,
    fmtRatio,
    hasSegment,
    hexOf,
    modeLabel,
    nameOfRef,
    rating,
    readableOn,
    titleOf,
    tokensOf,
    valueIn,
    varOf,
    variants,
} from "./docsite-core.ts";
import type { ResolvedToken } from "./system-types.ts";

const MAX_ROLES = 240;
const MAX_PALETTE = 480;

function ratioPill(ratio: number, min: number, exempt?: string): string {
    const passes = ratio >= min;
    const label = rating(ratio);

    return `<span class="ratio">${fmtRatio(ratio)}:1</span> ${
        !passes && exempt !== undefined
            ? `<span class="pill">exempt (${esc(exempt)})</span>`
            : `<span class="pill ${passes ? "ok" : "bad"}">${passes ? label : "Fails"}</span>`
    }`;
}

function copies(ctx: Ctx, token: ResolvedToken): string {
    // The class comes from the variable that the compiled theme gives the token (`--color-surface`, so `bg-surface`).
    const tailwind = ctx.twVar.get(token.name) ?? token.cssVar;
    const prefix = hasSegment(token, TEXT_SEGMENTS)
        ? "text"
        : /(^|\.)border(\.|$)/.test(token.name)
          ? "border"
          : "bg";
    const utility = tailwind.startsWith("--color-")
        ? `${prefix}-${tailwind.slice("--color-".length)}`
        : undefined;
    const button = (label: string, text: string) =>
        `<button type="button" class="mini" data-copy="${esc(text)}" title="Copy ${esc(text)}">${label}</button>`;

    return `<div class="copies">${button("CSS var", `var(${token.cssVar})`)}${utility === undefined ? "" : button("Tailwind", utility)}</div>`;
}

function swatchCard(ctx: Ctx, token: ResolvedToken): string {
    const pair = token.contrast && ctx.byName.get(nameOfRef(token.contrast.on));
    const sample =
        pair === undefined
            ? `<i style="background:${varOf(token)}"></i>`
            : `<i style="background:${varOf(pair)}"></i><span class="aa" style="color:${varOf(token, "inherit")}">Aa <small>on ${esc(pair.name)}</small></span>`;
    const hex = variants(ctx, (mode) => esc(hexOf(token, mode) ?? "—"));
    const alias = variants(ctx, (mode) => esc(valueIn(token, mode)?.alias ?? "—"));
    const hasAlias = ctx.modes.some((mode) => valueIn(token, mode)?.alias !== undefined);
    let contrast = "";

    if (pair !== undefined && token.contrast !== undefined) {
        const { min, exempt } = token.contrast;
        const ratios = variants(ctx, (mode) => {
            const fg = colorOf(token, mode);
            const bg = colorOf(pair, mode);

            return fg === undefined || bg === undefined
                ? "—"
                : ratioPill(contrastRatio(fg, bg), min, exempt);
        });

        contrast = `<p class="cr">${ratios} <span class="desc">${exempt === undefined ? "needs" : `exempt (${esc(exempt)}); would need`} ${min}:1 on ${esc(pair.name)}</span></p>`;
    }

    const deprecated =
        token.deprecated === undefined || token.deprecated === false
            ? ""
            : ` <span class="pill warn">Deprecated</span>`;

    return `<article class="card" data-s><button type="button" class="sw" data-copy="var(${esc(token.cssVar)})" aria-label="Copy var(${esc(token.cssVar)})">${sample}</button><div class="card-body"><div><button class="tk">${esc(token.name)}</button>${deprecated}</div>${token.description === undefined ? "" : `<p class="desc">${esc(token.description)}</p>`}<dl class="vals"><div><dt>hex</dt><dd>${hex}</dd></div>${hasAlias ? `<div><dt>alias</dt><dd>${alias}</dd></div>` : ""}</dl>${contrast}${copies(ctx, token)}</div></article>`;
}

function grouped(tokens: ResolvedToken[]): [string, ResolvedToken[]][] {
    const groups = new Map<string, ResolvedToken[]>();

    for (const token of tokens) {
        const path = token.path.slice(0, -1);

        if (path.length > 1 && /^(colou?rs?|palette)$/i.test(path[0]!)) {
            path.shift();
        }

        const key = path.length === 0 ? "Colors" : path.map(titleOf).join(" / ");

        groups.set(key, [...(groups.get(key) ?? []), token]);
    }

    return [...groups];
}

function rampStep(ctx: Ctx, token: ResolvedToken): string {
    const label = esc(token.path[token.path.length - 1]!);
    const ink = variants(ctx, (mode) => {
        const color = colorOf(token, mode);
        const text = color === undefined || color.a < 0.999 ? "inherit" : readableOn(color);

        return `<span style="color:${text}"><b>${label}</b><small>${esc(hexOf(token, mode) ?? "—")}</small></span>`;
    });

    return `<button type="button" class="step" data-s data-copy="${esc(token.name)}" style="background:${varOf(token)}" title="Copy ${esc(token.name)}">${ink}<span hidden>${esc(token.cssVar)}</span></button>`;
}

const ramps = (ctx: Ctx, tokens: ResolvedToken[]) =>
    grouped(tokens)
        .map(
            ([key, list]) =>
                `<div data-group><h4>${esc(key)}</h4><div class="ramp">${list.map((token) => rampStep(ctx, token)).join("")}</div></div>`,
        )
        .join("");

export function pairRows(ctx: Ctx): { total: number; passing: number; table: string } {
    const declared = ctx.system.tokens.filter((token) => token.contrast !== undefined);
    let total = 0;
    let passing = 0;
    const rows = declared.flatMap((token) =>
        (token.contrasts ?? [token.contrast!]).map((pairOf) => {
            const on = nameOfRef(pairOf.on);
            const pair = ctx.byName.get(on);
            const cells = ctx.modes.map((mode) => {
                const fg = colorOf(token, mode);
                const bg = colorOf(pair, mode);
                const cell = (html: string) =>
                    `<td class="num" data-label="${esc(modeLabel(mode))}">${html}</td>`;

                if (fg === undefined || bg === undefined) {
                    return cell("—");
                }

                const ratio = contrastRatio(fg, bg);

                if (pairOf.exempt === undefined) {
                    total++;
                    passing += ratio >= pairOf.min ? 1 : 0;
                }

                return cell(ratioPill(ratio, pairOf.min, pairOf.exempt));
            });

            return `<tr data-s><td data-label="Text"><i class="chip" style="background:${varOf(token)}"></i><button class="tk">${esc(token.name)}</button></td><td data-label="On"><button class="tk">${esc(on)}</button></td><td class="num" data-label="Needs">${pairOf.exempt === undefined ? `${pairOf.min}:1` : `exempt (${esc(pairOf.exempt)})`}</td>${cells.join("")}</tr>`;
        }),
    );

    return {
        total,
        passing,
        table:
            declared.length === 0
                ? ""
                : `<div class="table-wrap stack"><table><thead><tr><th>Text</th><th>On</th><th>Needs</th>${ctx.modes.map((mode) => `<th>${esc(modeLabel(mode))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
    };
}

function checkSentence(passing: number, total: number): string {
    if (total === 0) {
        return "";
    }

    if (total === 1) {
        return ` The contrast check ${passing === 1 ? "meets" : "does not meet"} its minimum.`;
    }

    return passing === total
        ? ` All ${total} contrast checks meet their minimum.`
        : ` ${passing} of ${total} contrast checks meet their minimum.`;
}

const capNote = (shown: number, all: number) =>
    shown < all
        ? `<p class="sub">Showing the first ${shown} of ${all}. The table of all tokens has the rest.</p>`
        : "";

export function colorSection(ctx: Ctx): string | undefined {
    const colors = tokensOf(ctx, "color");

    if (colors.length === 0) {
        return undefined;
    }

    for (const token of colors) {
        ctx.claimed.add(token);
    }

    const allRoles = colors.filter((token) => token.tier === "semantic");
    const allPalette = colors.filter((token) => token.tier === "primitive");
    const roles = allRoles.slice(0, MAX_ROLES);
    const palette = allPalette.slice(0, MAX_PALETTE);
    const components = colors.filter((token) => token.tier === "component");
    const pairs = pairRows(ctx);
    const parts: string[] = [
        `<p class="intro">${ctx.modes.length > 1 ? `Every role has a value in each of the ${ctx.modes.length} modes.` : "Every role has a value."}${checkSentence(pairs.passing, pairs.total)}</p>`,
    ];

    if (roles.length > 0) {
        parts.push(
            `<h3 id="color-roles">Roles</h3><p class="sub">Roles say what a color is for. Use a role, never a palette step, so the color follows the mode.</p>${capNote(roles.length, allRoles.length)}`,
        );

        const groups = grouped(roles);
        const small = groups.filter(([, list]) => list.length <= 2);
        const shown: [string, ResolvedToken[]][] = [
            ...groups.filter(([, list]) => list.length > 2),
            ...(small.length === 0
                ? []
                : [
                      [
                          small.map(([key]) => key).join(" · "),
                          small.flatMap(([, list]) => list),
                      ] as [string, ResolvedToken[]],
                  ]),
        ];

        for (const [key, list] of shown) {
            parts.push(
                `<div data-group><h4>${esc(key)}</h4><div class="cards">${list.map((token) => swatchCard(ctx, token)).join("")}</div></div>`,
            );
        }
    }

    if (palette.length > 0) {
        parts.push(
            `<h3 id="color-palette">Palette</h3><p class="sub">The raw colors that roles point at. Click a step to copy its name.</p>${capNote(palette.length, allPalette.length)}${ramps(ctx, palette)}`,
        );
    }

    if (components.length > 0) {
        parts.push(
            `<details class="fold" data-group><summary>Component colors <span class="pill">${components.length}</span></summary>${ramps(ctx, components)}</details>`,
        );
    }

    if (pairs.table !== "") {
        parts.push(
            `<h3 id="color-pairs">Contrast pairs</h3><p class="sub">The system checks these pairs in every mode: ${pairs.passing} of ${plural(pairs.total, "check")} ${pairs.passing === 1 ? "passes" : "pass"}.</p>${pairs.table}`,
        );
    }

    return parts.join("");
}
