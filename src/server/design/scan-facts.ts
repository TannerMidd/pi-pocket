import { type Scope } from "./scan-parse.ts";
import { type Imported } from "./scan-import.ts";
import { noteChannels } from "./scan-variables.ts";
import type { Skipped } from "./scan-files.ts";

const w = (text: string) => text.split(" ");

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

export interface VarFact {
    /** Without `--`, `$`, or `@`; for a Tailwind config, the theme path joined by `-`. */
    name: string;
    value: string;
    scope: Scope;
    kind: "css" | "theme" | "scss" | "less" | "js";
    file: string;
    hint?: Category;
    order: number;
    /** The lowest rank wins; in one file the later declaration wins. */
    rank: number;
    line?: number;
}

const KINDS = [
    "bg",
    "text",
    "border",
    "fill",
    "shadow",
    "other",
    "root",
    "body",
    "surface",
] as const;

export type Kinds = Record<(typeof KINDS)[number], number>;

export const emptyKinds = () => Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Kinds;

export interface ColorFact extends Kinds {
    hex: string;
    forms: Map<string, number>;
    order: number;
    at?: string;
}

interface FontFact {
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
    forms: Map<string, number>;
}

export interface Facts {
    rank: number;
    files: string[];
    partial: boolean;
    tailwind: boolean;
    file?: string;
    fileMode?: Scope;
    skipped: Skipped[];
    deferred: {
        prop: string;
        value: string;
        selector: string;
        scope: Scope;
        file?: string;
        line?: number;
    }[];
    tailwindVersion: 3 | 4;
    classColors: Map<string, Kinds>;
    vars: VarFact[];
    colors: Map<string, ColorFact>;
    darkColors: Map<string, ColorFact>;
    varUse: Map<string, number>;
    varKinds: Map<string, Kinds>;
    varLayout: Map<string, { space: number; text: number; radius: number; box: number }>;
    classUse: Map<string, number>;
    rootClasses: Set<string>;
    classCount: Map<string, number>;
    /** Keyed `class|kind`: the colors that a rule with one class sets, in each mode. */
    classRules: Map<string, { kind: "bg" | "text" | "border"; light?: string; dark?: string }>;
    fonts: Map<string, FontFact>;
    sizes: Map<number, SizeFact>;
    spacing: Map<number, number>;
    radii: Map<string, { count: number; text: string }>;
    shadows: Map<string, number>;
    breakpoints: Map<number, number>;
    classSpacing: Map<number, number>;
    classText: Map<string, number>;
    classRadius: Map<string, number>;
    scoped: Map<string, number>;
    /** Custom properties used inside a color function (`rgb(var(--c))`): their values are channels. */
    channels: Map<string, string>;
    imported: Imported;
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
        classCount: new Map(),
        classRules: new Map(),
        fonts: new Map(),
        sizes: new Map(),
        spacing: new Map(),
        radii: new Map(),
        shadows: new Map(),
        breakpoints: new Map(),
        classSpacing: new Map(),
        classText: new Map(),
        classRadius: new Map(),
        scoped: new Map(),
        channels: new Map(),
        skipped: [],
        imported: {
            default: {},
            dark: {},
            extra: {},
            count: 0,
            files: [],
            certain: false,
            pending: [],
            notes: [],
            done: false,
        },
    };
}

export const bump = <K>(map: Map<K, number>, key: K, by = 1) =>
    map.set(key, (map.get(key) ?? 0) + by);

export function entry<K, V>(map: Map<K, V>, key: K, make: () => NoInfer<V>): V {
    let value = map.get(key);

    if (value === undefined) {
        value = make();
        map.set(key, value);
    }

    return value;
}

export const GENERIC = new Set(
    w(
        "serif sans-serif monospace cursive fantasy system-ui ui-serif ui-sans-serif ui-monospace ui-rounded math emoji fangsong",
    ),
);

const NAMESPACES: [RegExp, Category][] = [
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
    [/^blur-|^container-/, "size"],
];

export function namespaceOf(name: string): { category: Category; rest: string } | undefined {
    const found = NAMESPACES.find(([pattern]) => pattern.test(name));

    return found === undefined
        ? undefined
        : { category: found[1], rest: name.replace(found[0], "") };
}

// A bound on memory: 10,000 properties in each of 15 files filled a 128 MB heap.
const MAX_VARS = 20_000;

export function addVar(facts: Facts, fact: Omit<VarFact, "order" | "rank">): void {
    if (facts.vars.length >= MAX_VARS) {
        if (!facts.partial) {
            facts.partial = true;
            facts.skipped.push({
                path: fact.file,
                why: `over ${MAX_VARS} variables: the rest left out`,
            });
        }

        return;
    }

    noteChannels(facts, fact.value);

    const scope =
        fact.scope === "default" && facts.fileMode !== undefined ? facts.fileMode : fact.scope;

    facts.vars.push({ ...fact, scope, order: facts.vars.length, rank: facts.rank });
}

export function modeOf(name: string): Scope | undefined {
    const words = name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/);
    const last = words.at(-1) ?? "";

    if (
        words.some((word) => word === "dark" || word === "night" || word === "dim") ||
        /^[a-z]{2,}(?:dark|night)$/.test(last)
    ) {
        return "dark";
    }

    return words.some((word) => word === "light" || word === "day") || /^[a-z]{2,}light$/.test(last)
        ? "light"
        : undefined;
}
