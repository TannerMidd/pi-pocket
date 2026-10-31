import { escapeHtml as esc } from "./docsite-markdown.ts";
import {
    type Ctx,
    copyName,
    descOf,
    limiter,
    moreTokens,
    plain,
    pxOf,
    rootOf,
    rowOf,
    tokenTable,
    tokensOf,
    valueIn,
    varOf,
    variants,
} from "./docsite-core.ts";
import type { ResolvedToken } from "./system-types.ts";

// The System view groups by the same words (`SPACE_ROOT` and `SIZE_ROOT` in extensions/design/system.js).
const SPACE_ROOT = /^(space|spacing|gap|gaps|sp|spaces)$/;
const SIZE_ROOT = /^(size|sizes|sizing)$/;

const pxIn = (ctx: Ctx, token: ResolvedToken) => pxOf(valueIn(token, ctx.modes[0]!)?.value) ?? 0;

const byPx = (ctx: Ctx, list: ResolvedToken[]) =>
    [...list].sort((a, b) => pxIn(ctx, a) - pxIn(ctx, b));

export function spacingSection(ctx: Ctx): string | undefined {
    const mine = tokensOf(ctx, "spacing");

    if (mine.length === 0) {
        return undefined;
    }

    const { take, note } = limiter(ctx);
    const own = mine.filter((token) => token.tier !== "component" && token.type === "dimension");
    const space = take(own.filter((token) => SPACE_ROOT.test(rootOf(token))));
    const sizes = take(own.filter((token) => SIZE_ROOT.test(rootOf(token))));
    const roles = take(
        own.filter(
            (token) =>
                token.tier === "semantic" &&
                !SPACE_ROOT.test(rootOf(token)) &&
                !SIZE_ROOT.test(rootOf(token)),
        ),
    );
    const longest = Math.max(...space.map((token) => pxIn(ctx, token)), 1);
    const bar = (token: ResolvedToken) =>
        `<div class="bar" style="width:${Math.max(1, Math.round((pxIn(ctx, token) / longest) * 100))}%"></div>`;
    const part = (
        id: string,
        title: string,
        sub: string,
        list: ResolvedToken[],
        sample: (token: ResolvedToken) => string,
    ) =>
        list.length === 0
            ? ""
            : `<h3 id="${id}">${title}</h3><p class="sub">${sub}</p><div class="rows">${list.map((token) => rowOf(ctx, token, sample(token))).join("")}</div>`;

    return `<p class="intro">The steps and sizes that the layout is built of.</p>${part("spacing-steps", "Steps", "The steps that padding, margins, and gaps move in. Each bar is in proportion to the longest step.", space, bar)}${part("spacing-roles", "Roles", "Where the system uses a step.", roles, bar)}${part("sizes", "Sizes", "Heights and widths for controls, icons, and marks.", sizes, (token) => `<div class="box" style="width:${varOf(token, "0")};height:${varOf(token, "0")}"></div>`)}${note()}${moreTokens(ctx, "spacing")}`;
}

export function radiiSection(ctx: Ctx): string | undefined {
    const mine = tokensOf(ctx, "radii");

    if (mine.length === 0) {
        return undefined;
    }

    const { take, note } = limiter(ctx);
    const radii = take(
        mine.filter(
            (token) =>
                token.tier !== "component" &&
                token.type === "dimension" &&
                /^(radius|radii|rounded|corners?|round)$/.test(rootOf(token)),
        ),
    );
    const tile = (token: ResolvedToken) =>
        `<div class="tile" data-s><div class="shape" style="border-radius:${varOf(token, "0")}"></div>${copyName(token)}<span class="desc">${variants(ctx, (mode) => esc(plain(token.type, valueIn(token, mode))))}</span>${descOf(token)}</div>`;
    const grid = (title: string, list: ResolvedToken[]) =>
        list.length === 0
            ? ""
            : `<div data-group><h4>${title}</h4><div class="tiles">${byPx(ctx, list).map(tile).join("")}</div></div>`;
    const roles = radii.filter((token) => token.tier === "semantic");
    const scale = radii.filter((token) => token.tier !== "semantic");

    return `<p class="intro">Corners follow what they round: small for marks, more for controls, most for containers.</p>${grid("Roles", roles)}${grid(roles.length > 0 ? "Scale" : "Steps", scale)}${note()}${moreTokens(ctx, "radii")}`;
}

export function shadowSection(ctx: Ctx): string | undefined {
    const mine = tokensOf(ctx, "shadows");

    if (mine.length === 0) {
        return undefined;
    }

    const { take, note } = limiter(ctx);
    const shadows = take(
        mine.filter((token) => token.type === "shadow" && token.tier !== "component"),
    );

    return `<p class="intro">Shadows lift a surface off the page. The shadow color follows the mode.</p><div class="tiles wide">${shadows
        .map(
            (token) =>
                `<div class="tile lift" data-s style="box-shadow:${varOf(token, "none")}">${copyName(token)}${descOf(token)}<span class="desc">${variants(ctx, (mode) => esc(plain("shadow", valueIn(token, mode))))}</span></div>`,
        )
        .join("")}</div>${note()}${moreTokens(ctx, "shadows")}`;
}

export function otherSection(ctx: Ctx): string | undefined {
    const mine = tokensOf(ctx, "other");

    if (mine.length === 0) {
        return undefined;
    }

    for (const token of mine) {
        ctx.claimed.add(token);
    }

    return `<p class="intro">Breakpoints, borders, layers, and the tokens that fit no other section.</p>${tokenTable(ctx, mine)}`;
}
