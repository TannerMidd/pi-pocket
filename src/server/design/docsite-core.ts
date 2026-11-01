import { colorObjectCss, contrastRatio, parseColor, toHex, type Rgba } from "./color.ts";
import { dimensionParts } from "./lint-color.ts";
import { escapeHtml as esc, plural, slugify } from "./docsite-markdown.ts";
import type { DesignSystem, ModeValue, ResolvedToken, TokenType } from "./system-types.ts";
import { tailwindNames } from "./tokens-compile.ts";

export interface SystemDoc {
    html: string;
    assets: { name: string; content: string }[];
}

export const MAX_TOKENS = 3000;
export const MAX_COMPONENTS = 60;
export const MAX_STATES = 16;
export const MAX_CODE = 60_000;
const MAX_SPECIMENS = 240;

/** An artifact holds 2 MB at most; the page keeps room under that. */
export const MAX_PAGE = 1_800_000;

// Nothing loads from outside, and script runs only with the page's own nonce, which a component's markup cannot carry.
// The artifact viewer's bridge script comes before this policy, so it is not touched.
export const pageCsp = (nonce: string) =>
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'`;

export const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

export const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function titleOf(segment: string): string {
    const known: Record<string, string> = { bg: "Background", fg: "Foreground", z: "Layers" };
    const text = known[segment.toLowerCase()] ?? (segment.replace(/[-_]+/g, " ").trim() || segment);

    return text.charAt(0).toUpperCase() + text.slice(1);
}

export const modeLabel = titleOf;

/** A CSS value from the project is used in a style only when it cannot end the declaration or the block. */
export function safeCss(value: unknown): string | undefined {
    if (typeof value !== "string" || value.length === 0 || value.length > 600) {
        return undefined;
    }

    if (/[{}<>;\\\u0000-\u001f]|\/\*|@import|url\s*\(|expression\s*\(|javascript:/i.test(value)) {
        return undefined;
    }

    return value;
}

export const safeVar = (name: string) => (/^--[A-Za-z0-9_-]{1,120}$/.test(name) ? name : undefined);

export const varOf = (token: ResolvedToken, fallback = "transparent") =>
    safeVar(token.cssVar) === undefined ? fallback : `var(${token.cssVar})`;

export const idOf = (text: string) => slugify(text) || "x";

export function dimText(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value;
    }

    const parts = dimensionParts(value);

    return parts === undefined ? undefined : `${parts.amount}${parts.unit}`;
}

export function pxOf(value: unknown): number | undefined {
    const match = /^(-?\d*\.?\d+)\s*(px|rem|em)?$/.exec(dimText(value) ?? "");

    if (match === null) {
        return undefined;
    }

    return Number.parseFloat(match[1]!) * (match[2] === "px" || match[2] === undefined ? 1 : 16);
}

export function stackOf(value: unknown): string | undefined {
    if (Array.isArray(value)) {
        return value
            .map((family) => String(family))
            .map((family) => (/^[\w-]+$/.test(family) ? family : `"${family.replace(/"/g, "")}"`))
            .join(", ");
    }

    return typeof value === "string" ? value : undefined;
}

export const valueIn = (token: ResolvedToken, mode: string): ModeValue | undefined =>
    token.modes[mode];

function colorText(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value;
    }

    const object = colorObjectCss(value);

    return "css" in object ? object.css : undefined;
}

const parseAny = (value: unknown) => {
    const text = colorText(value);

    return text === undefined ? undefined : parseColor(text);
};

export const colorOf = (token: ResolvedToken | undefined, mode: string): Rgba | undefined => {
    const value = token === undefined ? undefined : valueIn(token, mode);

    return value === undefined ? undefined : parseAny(value.literal ?? value.value);
};

function hexText(value: ModeValue | undefined): string | undefined {
    const color = value === undefined ? undefined : parseAny(value.literal ?? value.value);

    return value?.hex ?? (color === undefined ? undefined : toHex(color));
}

export const hexOf = (token: ResolvedToken, mode: string) => hexText(valueIn(token, mode));

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };

export const readableOn = (color: Rgba) =>
    contrastRatio(BLACK, color) >= contrastRatio(WHITE, color) ? "#000000" : "#ffffff";

export function rating(ratio: number): "AAA" | "AA" | "AA large" | "fail" {
    return ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA large" : "fail";
}

/** One decimal, cut and not rounded, so that 4.48 never shows as the 4.5 it does not reach. */
export const fmtRatio = (ratio: number) => (Math.floor(ratio * 10 + 1e-9) / 10).toFixed(1);

function shadowText(value: unknown): string {
    return (Array.isArray(value) ? value : [value])
        .map((layer) => {
            if (!isObject(layer)) {
                return String(layer);
            }

            const parts = [layer.offsetX, layer.offsetY, layer.blur, layer.spread]
                .map((part) => dimText(part) ?? "0")
                .join(" ");
            const color = parseAny(layer.color);

            return `${layer.inset === true ? "inset " : ""}${parts} ${color === undefined ? String(layer.color) : toHex(color)}`;
        })
        .join(", ");
}

/** A resolved value as short, readable text. */
export function plain(type: TokenType, value: ModeValue | undefined): string {
    const raw = value?.value;

    switch (type) {
        case "color":
            return hexText(value) ?? colorText(value?.value) ?? "—";
        case "dimension":
            return dimText(raw) ?? String(raw);
        case "fontFamily":
            return stackOf(raw) ?? String(raw);
        case "cubicBezier":
            return Array.isArray(raw) ? `cubic-bezier(${raw.join(", ")})` : String(raw);
        case "shadow":
            return shadowText(raw);
        case "typography":
            return isObject(raw)
                ? `${stackOf(raw.fontFamily)?.split(",")[0]?.replace(/"/g, "") ?? ""} ${dimText(raw.fontSize) ?? ""}/${String(raw.lineHeight ?? "")} ${String(raw.fontWeight ?? "")}`.trim()
                : String(raw);
        case "transition":
            return isObject(raw)
                ? `${dimText(raw.duration) ?? ""} ${Array.isArray(raw.timingFunction) ? `cubic-bezier(${raw.timingFunction.join(", ")})` : String(raw.timingFunction ?? "")}`.trim()
                : String(raw);
        default:
            return typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
                ? String(raw)
                : clip(JSON.stringify(raw) ?? "", 120);
    }
}

/** The sections that count tokens. A token is in exactly one; their counts add up to the system's token count. */
export type SectionId =
    "color" | "typography" | "spacing" | "radii" | "shadows" | "motion" | "other";

const SECTION_HINTS: [SectionId, RegExp][] = [
    ["typography", /^(font|type|text|typography|line|leading|letter|tracking)$/],
    ["spacing", /^(space|spacing|gap|size|sizes|padding|margin|inset|stack|layout)$/],
    ["radii", /^(radius|radii|round|rounded|corner|corners)$/],
    ["motion", /^(motion|duration|delay|ease|easing|transition|timing)$/],
];

/** The same rule as the System view's `sectionOf` (extensions/design/system.js), so that both count alike. */
export function sectionOf(token: ResolvedToken): SectionId {
    switch (token.type) {
        case "color":
        case "gradient":
            return "color";
        case "fontFamily":
        case "fontWeight":
        case "typography":
            return "typography";
        case "shadow":
            return "shadows";
        case "duration":
        case "cubicBezier":
        case "transition":
            return "motion";
        case "dimension":
        case "number":
            for (const part of token.path) {
                const hint = SECTION_HINTS.find(([, pattern]) => pattern.test(part.toLowerCase()));

                if (hint !== undefined) {
                    return hint[0];
                }
            }

            return "other";
        default:
            return "other";
    }
}

export interface Ctx {
    system: DesignSystem;
    modes: string[];
    /** A mode's name as an attribute value. */
    slug: Map<string, string>;
    theme: Map<string, "light" | "dark">;
    byName: Map<string, ResolvedToken>;
    /** The variable of each token in `tailwind.css` (`color.bg.surface` is `--color-surface`, so `bg-surface`). */
    twVar: Map<string, string>;
    sections: Map<SectionId, ResolvedToken[]>;
    /** The tokens that a specimen has drawn: the rest of a section go to its table of more tokens. */
    claimed: Set<ResolvedToken>;
}

export const nameOfRef = (text: string) => text.replace(/^\{|\}$/g, "").trim();

export function variants(ctx: Ctx, make: (mode: string) => string): string {
    const texts = ctx.modes.map((mode) => make(mode));

    if (texts.every((text) => text === texts[0])) {
        return texts[0] ?? "";
    }

    return texts.map((text, index) => `<span class="mv" data-m="${index}">${text}</span>`).join("");
}

export function findToken(ctx: Ctx, names: string[]): ResolvedToken | undefined {
    return names.map((name) => ctx.byName.get(name)).find((token) => token !== undefined);
}

const GROUND_SEGMENTS = new Set(["bg", "background", "surface", "canvas", "ground"]);

export const TEXT_SEGMENTS = new Set(["text", "fg", "foreground", "content", "ink"]);

export const hasSegment = (token: ResolvedToken, set: Set<string>) =>
    token.path.slice(0, -1).some((segment) => set.has(segment.toLowerCase()));

export const BASE_GROUNDS = [
    "color.bg.base",
    "color.bg.default",
    "color.background.default",
    "color.background.base",
    "color.background",
    "color.bg.canvas",
    "color.bg",
    "color.surface.default",
];

export const BASE_TEXTS = [
    "color.text.primary",
    "color.text.default",
    "color.text.base",
    "color.text",
    "color.foreground.default",
    "color.foreground",
    "color.fg.default",
];

const firstRole = (ctx: Ctx, set: Set<string>) =>
    ctx.system.tokens.find(
        (token) => token.type === "color" && token.tier !== "primitive" && hasSegment(token, set),
    );

export const groundToken = (ctx: Ctx) =>
    findToken(ctx, BASE_GROUNDS) ?? firstRole(ctx, GROUND_SEGMENTS);

export const textToken = (ctx: Ctx) => findToken(ctx, BASE_TEXTS) ?? firstRole(ctx, TEXT_SEGMENTS);

export function buildContext(system: DesignSystem): Ctx {
    // A custom property name goes into styles: one that is not plain gets a safe name made from the token's.
    const tokens = system.tokens
        .slice(0, MAX_TOKENS)
        .map((token) =>
            safeVar(token.cssVar) === undefined
                ? { ...token, cssVar: `--${idOf(token.name)}` }
                : token,
        );
    const modes = system.modes.length > 0 ? system.modes : ["default"];
    const slug = new Map<string, string>();

    for (const mode of modes) {
        let candidate = mode.toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "mode";

        while ([...slug.values()].includes(candidate)) {
            candidate += "-x";
        }

        slug.set(mode, candidate);
    }

    const ctx: Ctx = {
        system: { ...system, tokens },
        modes,
        slug,
        theme: new Map(),
        byName: new Map(tokens.map((token) => [token.name, token])),
        twVar: tailwindNames({ ...system, tokens }),
        sections: new Map(),
        claimed: new Set(),
    };

    for (const token of tokens) {
        const id = sectionOf(token);

        ctx.sections.set(id, [...(ctx.sections.get(id) ?? []), token]);
    }

    for (const mode of modes) {
        const scheme = system.schemes[mode];

        ctx.theme.set(mode, scheme ?? (/dark|night|black|contrast/i.test(mode) ? "dark" : "light"));
    }

    return ctx;
}

export const tokensOf = (ctx: Ctx, id: SectionId) => ctx.sections.get(id) ?? [];

export const rootOf = (token: ResolvedToken) => token.path[0]!.toLowerCase();

export const copyName = (token: ResolvedToken) => `<button class="tk">${esc(token.name)}</button>`;

export const descOf = (token: ResolvedToken) =>
    token.description === undefined ? "" : `<span class="desc">${esc(token.description)}</span>`;

export function limiter(ctx: Ctx): {
    take: (list: ResolvedToken[]) => ResolvedToken[];
    note: () => string;
} {
    let cut = false;

    return {
        take: (list) => {
            cut ||= list.length > MAX_SPECIMENS;

            const kept = list.slice(0, MAX_SPECIMENS);

            for (const token of kept) {
                ctx.claimed.add(token);
            }

            return kept;
        },
        note: () =>
            cut
                ? `<p class="sub">Some lists show only their first ${MAX_SPECIMENS}. The table of all tokens has the rest.</p>`
                : "",
    };
}

export function rowOf(ctx: Ctx, token: ResolvedToken, sample: string): string {
    const value = variants(ctx, (mode) => esc(plain(token.type, valueIn(token, mode))));

    return `<div class="row" data-s><div class="meta">${copyName(token)}${descOf(token)}</div><div class="val">${value}</div><div class="sample">${sample}</div></div>`;
}

/** The System view counts the same way: semantic tokens, else primitives. */
export function sectionCount(ctx: Ctx, id: SectionId) {
    const list = tokensOf(ctx, id);
    const semantic = list.filter((token) => token.tier === "semantic").length;
    const primitive = list.filter((token) => token.tier === "primitive").length;

    return {
        roles: semantic > 0,
        headline: semantic > 0 ? semantic : primitive,
        primitives: semantic > 0 ? primitive : 0,
        components: list.filter((token) => token.tier === "component").length,
        total: list.length,
    };
}

export function countsLine(ctx: Ctx, id: SectionId): string {
    const count = sectionCount(ctx, id);
    const parts = [
        plural(count.headline, count.roles ? "role" : "token"),
        ...(count.primitives > 0
            ? [plural(count.primitives, id === "color" ? "palette color" : "primitive")]
            : []),
        ...(count.components > 0
            ? [plural(count.components, id === "color" ? "component color" : "component token")]
            : []),
    ];

    return count.total === 0 ? "" : `<p class="counts">${parts.join(" · ")}</p>`;
}

function modeCell(token: ResolvedToken, mode: string, across: number): string {
    const value = valueIn(token, mode);
    const hex = token.type === "color" ? hexOf(token, mode) : undefined;
    const body = `${hex === undefined ? "" : `<i class="chip" style="background:${esc(hex)}"></i>`}${esc(clip(plain(token.type, value), 160))}`;

    return across > 1
        ? `<td data-label="Every mode" class="v" colspan="${across}">${body} <span class="all">in every mode</span></td>`
        : `<td data-label="${esc(modeLabel(mode))}" class="v">${body}</td>`;
}

export function tableRows(ctx: Ctx, tokens: ResolvedToken[]): string {
    return tokens
        .map((token) => {
            const texts = ctx.modes.map(
                (mode) => `${hexOf(token, mode) ?? ""}|${plain(token.type, valueIn(token, mode))}`,
            );
            const same = ctx.modes.length > 1 && texts.every((text) => text === texts[0]);
            const cells = same
                ? modeCell(token, ctx.modes[0]!, ctx.modes.length)
                : ctx.modes.map((mode) => modeCell(token, mode, 1)).join("");
            const deprecated =
                token.deprecated === undefined || token.deprecated === false
                    ? ""
                    : ` <span class="pill warn">Deprecated${typeof token.deprecated === "string" ? `: ${esc(clip(token.deprecated, 80))}` : ""}</span>`;

            return `<tr data-s data-type="${esc(token.type)}" data-tier="${esc(token.tier)}"><td data-label="Token">${copyName(token)}<button class="tk">${esc(token.cssVar)}</button>${deprecated}${descOf(token)}</td><td data-label="Type">${esc(token.type)} <span class="pill">${esc(token.tier)}</span></td>${cells}</tr>`;
        })
        .join("");
}

export function moreTokens(ctx: Ctx, id: SectionId): string {
    const left = tokensOf(ctx, id).filter((token) => !ctx.claimed.has(token));

    return left.length === 0
        ? ""
        : `<h3>More tokens</h3><p class="sub">Tokens of this section with no specimen of their own, most of them a component's.</p>${tokenTable(ctx, left)}`;
}

export const tokenTable = (ctx: Ctx, tokens: ResolvedToken[]) =>
    `<div class="table-wrap stack"><table><thead><tr><th>Token</th><th>Type</th>${ctx.modes.map((mode) => `<th>${esc(modeLabel(mode))}</th>`).join("")}</tr></thead><tbody>${tableRows(ctx, tokens)}</tbody></table></div>`;

export function anchor(id: string, label: string): string {
    return `<a class="anchor" href="#${esc(id)}" aria-label="Link to ${esc(label)}"></a>`;
}
