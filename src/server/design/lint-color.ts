import { colorObjectCss, luminance, oklabOf, toHex } from "./color.ts";
import { sameInEveryMode } from "./fix.ts";
import type { DesignSystem, ModeValue, ResolvedToken } from "./system-types.ts";

export type RgbaTuple = [number, number, number, number];

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** sRGB channels from 0 to 255 to OKLab. */
export const toOklab = (red: number, green: number, blue: number): [number, number, number] =>
    oklabOf({ r: red / 255, g: green / 255, b: blue / 255, a: 1 });

// A Check compares each page color with every token: the conversions are kept by array, and no color array is changed in place.
const labs = new WeakMap<readonly number[], [number, number, number]>();
const lights = new WeakMap<readonly number[], number>();

export function labOf(color: readonly number[]): [number, number, number] {
    let lab = labs.get(color);

    if (lab === undefined) {
        lab = toOklab(color[0]!, color[1]!, color[2]!);
        labs.set(color, lab);
    }

    return lab;
}

function lightOf(color: readonly number[]): number {
    let light = lights.get(color);

    if (light === undefined) {
        light = luminance({ r: color[0]! / 255, g: color[1]! / 255, b: color[2]! / 255, a: 1 });
        lights.set(color, light);
    }

    return light;
}

// The OKLab distance times 100: about 1 is the smallest step a person sees, 0.4 is one 8-bit step. The alpha difference in percent is added.
export function colorDistance(a: RgbaTuple, b: RgbaTuple): number {
    const [l1, a1, b1] = labOf(a);
    const [l2, a2, b2] = labOf(b);
    const lab = Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;

    return lab + Math.abs(a[3] - b[3]) * 100;
}

// `contrastRatio` of two opaque colors.
export function contrastOf(a: readonly number[], b: readonly number[]): number {
    const one = lightOf(a);
    const two = lightOf(b);

    return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

export function formatColor(color: readonly number[]): string {
    const alpha = color[3] ?? 1;
    const channels = [color[0]!, color[1]!, color[2]!].map((value) =>
        Math.round(clamp(value, 0, 255)),
    );

    if (alpha >= 0.995) {
        return toHex({ r: channels[0]! / 255, g: channels[1]! / 255, b: channels[2]! / 255, a: 1 });
    }

    return `rgb(${channels.join(" ")} / ${Math.round(alpha * 100) / 100})`;
}

export function colorCss(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value.startsWith("{") || value.length > 200 ? undefined : value;
    }

    const css = colorObjectCss(value);

    if ("css" in css) {
        return css.css;
    }

    const hex = (value as { hex?: unknown } | null)?.hex;

    return typeof hex === "string" ? hex : undefined;
}

export function dimensionParts(value: unknown): { amount: number; unit: string } | undefined {
    if (typeof value === "number") {
        return { amount: value, unit: "px" };
    }

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const { value: amount, unit } = value as { value?: unknown; unit?: unknown };

        if (typeof amount === "number" && typeof unit === "string") {
            return { amount, unit };
        }
    }

    return undefined;
}

export function dimensionCss(value: unknown): string | undefined {
    if (typeof value === "string") {
        return /^[-+0-9.a-z%(), *\/]+$/i.test(value) && value.length <= 120 ? value : undefined;
    }

    const parts = dimensionParts(value);

    return parts !== undefined && Number.isFinite(parts.amount) && /^[a-z%]{1,5}$/i.test(parts.unit)
        ? `${parts.amount}${parts.unit}`
        : undefined;
}

export function familyList(value: string): string[] {
    const names: string[] = [];
    let current = "";
    let quote = "";

    for (const character of value) {
        if (quote !== "") {
            if (character === quote) {
                quote = "";
            } else {
                current += character;
            }
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === ",") {
            names.push(current);
            current = "";
        } else {
            current += character;
        }
    }

    names.push(current);

    return names.map((name) => name.trim().toLowerCase()).filter((name) => name !== "");
}

const GENERIC_FAMILIES = new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "fangsong",
]);

export function isGenericFamily(name: string): boolean {
    return GENERIC_FAMILIES.has(name);
}

export type LengthKind = "font-size" | "space" | "radius";

interface TokenColor {
    name: string;
    cssVar: string;
    tier: ResolvedToken["tier"];
    css: string;
    rgba?: RgbaTuple;
    steady?: boolean;
}

interface TokenFont {
    name: string;
    cssVar: string;
    families: string[];
    steady?: boolean;
}

interface TokenLength {
    kind: LengthKind;
    name: string;
    cssVar: string;
    css: string;
    px?: number;
    steady?: boolean;
}

export interface TokenSet {
    mode: string;
    colors: TokenColor[];
    fonts: TokenFont[];
    lengths: TokenLength[];
}

const SPACE_GROUP = /^(space|spaces|spacing|gap|gaps|gutter|inset)$/i;
const RADIUS_GROUP = /^(radius|radii|rounded|corner|corners|round)$/i;
const FONT_GROUPS = /^(font|fonts|text|type|typography|fontsize|fontsizes|font-size|font-sizes)$/i;
const SIZE_NAME = /^(size|sizes|fontsize|font-size|fontsizes|font-sizes|fs)$/i;

export function lengthKind(path: string[]): LengthKind | undefined {
    const names = path.slice(0, -1).concat(path.at(-1) ?? "");

    if (names.some((name) => RADIUS_GROUP.test(name))) {
        return "radius";
    }

    if (names.some((name) => SPACE_GROUP.test(name))) {
        return "space";
    }

    if (
        names.some((name) => /^(fontsize|fontsizes|font-size|font-sizes|fs)$/i.test(name)) ||
        (names.some((name) => SIZE_NAME.test(name)) &&
            names.some((name) => FONT_GROUPS.test(name))) ||
        (path.length > 1 && /^(text|type)$/i.test(path[0]!) && !names.some(isNonSize))
    ) {
        return "font-size";
    }

    return undefined;
}

const isNonSize = (name: string) =>
    /^(weight|leading|line-?height|tracking|spacing|family)$/i.test(name);

const valueIn = (token: ResolvedToken, mode: string): ModeValue | undefined =>
    token.modes[mode] ?? Object.values(token.modes)[0];

function fontFamilies(value: unknown): string[] {
    if (typeof value === "string") {
        return familyList(value);
    }

    if (Array.isArray(value)) {
        return value.filter((item) => typeof item === "string").map((item) => item.toLowerCase());
    }

    return [];
}

export function tokenSet(system: DesignSystem, mode: string): TokenSet {
    const set: TokenSet = { mode, colors: [], fonts: [], lengths: [] };
    const seen = new Set<string>();
    const steady = (token: ResolvedToken) => sameInEveryMode(token, system.modes);

    const addLength = (token: ResolvedToken, kind: LengthKind, value: unknown, suffix = "") => {
        const css = dimensionCss(value);

        if (css !== undefined && !seen.has(`${token.name}${suffix}`)) {
            seen.add(`${token.name}${suffix}`);
            set.lengths.push({
                kind,
                name: token.name,
                cssVar: token.cssVar,
                css,
                steady: steady(token),
            });
        }
    };

    for (const token of system.tokens) {
        const entry = valueIn(token, mode);

        if (entry === undefined) {
            continue;
        }

        if (token.type === "color") {
            const css = entry.css.startsWith("var(") ? colorCss(entry.value) : entry.css;

            if (css !== undefined) {
                set.colors.push({
                    name: token.name,
                    cssVar: token.cssVar,
                    tier: token.tier,
                    css,
                    steady: steady(token),
                });
            }
        } else if (token.type === "fontFamily") {
            const families = fontFamilies(entry.value);

            if (families.length > 0) {
                set.fonts.push({
                    name: token.name,
                    cssVar: token.cssVar,
                    families,
                    steady: steady(token),
                });
            }
        } else if (token.type === "dimension" && token.tier !== "component") {
            const kind = lengthKind(token.path);

            if (kind !== undefined) {
                addLength(token, kind, entry.value);
            }
        } else if (token.type === "typography") {
            const fontSize = (entry.value as { fontSize?: unknown } | null)?.fontSize;

            if (fontSize !== undefined) {
                addLength(token, "font-size", fontSize, "#size");
            }
        }
    }

    return set;
}
