/**
 * What the design system scan finds in a project's files (stream T): custom properties and theme variables by scope,
 * how often each color, font, size, space, radius, shadow, duration, and easing is used, and which variables are
 * referenced. This module only counts and records; `scan-infer.ts` decides what it means.
 */
import { type Scope } from "./scan-parse.ts";
import { type Imported } from "./scan-import.ts";
import { noteChannels } from "./scan-channels.ts";
import type { Skipped } from "./scan-files.ts";

/** A list of words from one string. */
const w = (text: string) => text.split(" ");

/** What a value is for, which decides the group of its token. */
export type Category =
    | "color"
    | "font"
    | "text"
    | "space"
    | "radius"
    | "shadow"
    | "duration"
    | "ease"
    | "breakpoint"
    | "weight"
    | "leading"
    | "tracking"
    | "z"
    | "opacity"
    | "size"
    | "gradient";

/** A custom property or a stylesheet variable. */
export interface VarFact {
    /** Without `--`, `$`, or `@`; for a JavaScript theme, the path joined by `-`. */
    name: string;
    value: string;
    scope: Scope;
    kind: "css" | "theme" | "scss" | "less" | "js";
    file: string;
    /** The category that the place of the variable states (a Tailwind namespace, a theme key such as `borderRadius`). */
    hint?: Category;
    /** Source order: files by priority, then position. */
    order: number;
    /** The file's rank by priority (0 is read first). The lowest rank wins; in one file the later declaration wins. */
    rank: number;
    /** The line of the file where the variable is set, when known. */
    line?: number;
}

/** How a color is used. */
export interface ColorFact {
    hex: string;
    /** The authored texts, by count. */
    forms: Map<string, number>;
    /** Literal uses in declarations, by kind of property. */
    bg: number;
    text: number;
    border: number;
    fill: number;
    shadow: number;
    other: number;
    /** As a background on the page's root (`body`, `html`, `:root`, `#app`). */
    root: number;
    /** As the text color of the root or of paragraphs. */
    body: number;
    /** As a background on a card, panel, modal, or the like. */
    surface: number;
    /** When it was first seen: the earlier of two equal colors is the one the author wrote first. */
    order: number;
    /** Where it was first seen, as `file:line`. */
    at?: string;
}

/** How a color is used, by kind of property (the counts of a `ColorFact`). */
export type Kinds = Pick<
    ColorFact,
    "bg" | "text" | "border" | "fill" | "shadow" | "other" | "root" | "body" | "surface"
>;

export const emptyKinds = (): Kinds => ({
    bg: 0,
    text: 0,
    border: 0,
    fill: 0,
    shadow: 0,
    other: 0,
    root: 0,
    body: 0,
    surface: 0,
});

export interface FontFact {
    /** The family names, quotes removed, in order. */
    stack: string[];
    count: number;
    heading: number;
    body: number;
    code: number;
}

export interface SizeFact {
    count: number;
    body: number;
    heading: number;
    /** The authored texts, by count: `1rem`, `16px`. */
    forms: Map<string, number>;
}

export interface Facts {
    /** The rank of the file being read. */
    rank: number;
    files: string[];
    partial: boolean;
    tailwind: boolean;
    /** The project has a WordPress `theme.json`: its variables are named `--wp--preset--…`. */
    wordpress?: boolean;
    /** The project's Sass functions that scale a number (`@function space($n) { @return $n * 4px; }`), by name. */
    sassFunctions: Map<string, { param: string; expression: string }>;
    /** The Sass mixins that hold the dark mode (`@include dark { … }`), from every file. */
    darkMixins: Set<string>;
    /** The file being read, relative to the scanned folder. */
    file?: string;
    /** The mode that the file being read is named for (`dark.less`), when it is one. */
    fileMode?: Scope;
    /** What the walk and the read left out, and why (a vendored folder, a minified file, a file cut at its limit). */
    skipped: Skipped[];
    /** The Sass files whose loops and functions were run: the text they make, by path. */
    sassExpanded: Map<string, string>;
    /** Declarations that compute a size from custom properties (`calc(var(--gap) * 2)`): the scan resolves them later. */
    deferred: {
        prop: string;
        value: string;
        selector: string;
        scope: Scope;
        file?: string;
        line?: number;
    }[];
    /** 3 or 4: which defaults the utility classes mean. */
    tailwindVersion: 3 | 4;
    /** How the project uses Tailwind's default colors by class (`bg-slate-200`, `text-white`), by color name. */
    classColors: Map<string, Kinds>;
    vars: VarFact[];
    colors: Map<string, ColorFact>;
    darkColors: Map<string, ColorFact>;
    varUse: Map<string, number>;
    /** How each custom property is used as a color: `background: var(--ink)` is a background use of `--ink`. */
    varKinds: Map<string, Kinds>;
    /** What each length variable is used for: spacing, type size, radius, or the size of a box. */
    varLayout: Map<string, { space: number; text: number; radius: number; box: number }>;
    classUse: Map<string, number>;
    /** The classes on the page's `<body>` and `<html>`: their rules style the whole page. */
    rootClasses: Set<string>;
    /** How often each class name is used in markup (`class="a b"`). */
    classCount: Map<string, number>;
    /** The colors that a rule with one class sets (`.text-gray-900 { color: … }`), by class, in each mode. */
    classRules: Map<string, { kind: "bg" | "text" | "border"; light?: string; dark?: string }>;
    fonts: Map<string, FontFact>;
    sizes: Map<number, SizeFact>;
    weights: Map<number, number>;
    leadings: Map<number, number>;
    tracking: Map<string, number>;
    spacing: Map<number, number>;
    radii: Map<string, { count: number; text: string }>;
    shadows: Map<string, number>;
    durations: Map<number, number>;
    easings: Map<string, number>;
    breakpoints: Map<number, number>;
    /** Spacing from Tailwind classes (`p-4` is 16px): used only when the project uses Tailwind. */
    classSpacing: Map<number, number>;
    /** Tailwind utility classes by size name: `text-sm` → `sm`, `rounded-lg` → `lg`, `font-bold` → `bold`. */
    classText: Map<string, number>;
    classRadius: Map<string, number>;
    classWeight: Map<string, number>;
    /** Scopes that set custom properties but are neither the root nor dark mode, by selector. */
    scoped: Map<string, number>;
    /** Custom properties used inside a color function (`rgb(var(--c-brand))`), and which function: their values are channels. */
    channels: Map<string, string>;
    /** Tokens already written in a DTCG, Style Dictionary, or Tokens Studio file. */
    imported: Imported;
    /** What each Figma `.fig` file gave the scan, one line for each, or why it could not be read (untrusted text). */
    figs: string[];
}

export function newFacts(): Facts {
    return {
        rank: 0,
        files: [],
        partial: false,
        tailwind: false,
        deferred: [],
        tailwindVersion: 3,
        classColors: new Map(),
        vars: [],
        colors: new Map(),
        darkColors: new Map(),
        varUse: new Map(),
        varKinds: new Map(),
        varLayout: new Map(),
        classUse: new Map(),
        rootClasses: new Set(),
        darkMixins: new Set(),
        sassFunctions: new Map(),
        classCount: new Map(),
        classRules: new Map(),
        fonts: new Map(),
        sizes: new Map(),
        weights: new Map(),
        leadings: new Map(),
        tracking: new Map(),
        spacing: new Map(),
        radii: new Map(),
        shadows: new Map(),
        durations: new Map(),
        easings: new Map(),
        breakpoints: new Map(),
        classSpacing: new Map(),
        classText: new Map(),
        classRadius: new Map(),
        classWeight: new Map(),
        scoped: new Map(),
        channels: new Map(),
        skipped: [],
        sassExpanded: new Map(),
        imported: {
            default: {},
            dark: {},
            extra: {},
            count: 0,
            files: [],
            certain: false,
            configs: [],
            materialCss: [],
            pending: [],
            notes: [],
            done: false,
        },
        figs: [],
    };
}

export const bump = <K>(map: Map<K, number>, key: K, by = 1) =>
    map.set(key, (map.get(key) ?? 0) + by);

// --- Color uses ----------------------------------------------------------------------------------------------------

export const GENERIC = new Set(
    w(
        "serif sans-serif monospace cursive fantasy system-ui ui-serif ui-sans-serif ui-monospace ui-rounded math emoji fangsong",
    ),
);

/** The category that a Tailwind v4 namespace states: `--color-brand` is a color, `--radius-lg` a radius. */
export function namespaceOf(name: string): { category: Category; rest: string } | undefined {
    const table: [RegExp, Category][] = [
        [/^color-/, "color"],
        [/^font-weight-/, "weight"],
        [/^font-/, "font"],
        [/^text-(?!.*--)/, "text"],
        [/^spacing-/, "space"],
        [/^radius-/, "radius"],
        [/^shadow-|^inset-shadow-|^drop-shadow-/, "shadow"],
        [/^ease-/, "ease"],
        [/^breakpoint-/, "breakpoint"],
        [/^leading-/, "leading"],
        [/^tracking-/, "tracking"],
        [/^blur-/, "size"],
        [/^container-/, "size"],
    ];

    for (const [pattern, category] of table) {
        if (pattern.test(name)) {
            return { category, rest: name.replace(pattern, "") };
        }
    }

    return undefined;
}

export function addVar(facts: Facts, fact: Omit<VarFact, "order" | "rank">): void {
    noteChannels(facts, fact.value);

    // A file that is the other mode's (`dark.less`, `themes/night/colors.css`) sets that mode's values.
    const scope =
        fact.scope === "default" && facts.fileMode !== undefined ? facts.fileMode : fact.scope;

    facts.vars.push({ ...fact, scope, order: facts.vars.length, rank: facts.rank });
}
