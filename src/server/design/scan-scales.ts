import { colorsIn, commaParts, parts, px } from "./scan-parse.ts";
import type { RoleName } from "./scan-colors.ts";
import type { Category, Facts, SizeFact } from "./scan-facts.ts";

type Obj = Record<string, unknown>;

export interface Draft {
    tokens: Obj;
    modes: Record<string, Obj>;
}

interface RoleInfo {
    token: string;
    value: string;
    dark?: string;
    basis: "name" | "use";
    source: string;
    confidence: "high" | "medium" | "low";
    at?: string;
}

export interface Inferred {
    draft: Draft;
    roles: Partial<Record<RoleName, RoleInfo>>;
    palette: Record<string, number>;
    typeScale: { base?: string; sizes: string[]; ratio?: number };
    fonts: Record<string, string>;
    spacing: { base?: number; steps: number[]; off: number[] };
    radii: string[];
    shadows: number;
    breakpoints: string[];
    hasDark: boolean;
    modes: { default: string; alt: string };
    notes: string[];
    imported: number;
    dropped: string[];
    sources: string[];
    review: string[];
}

const BEZIER: Record<string, number[]> = {
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1],
    linear: [0, 0, 1, 1],
};

export function bezier(text: string): number[] | undefined {
    const keyword = BEZIER[text.trim().toLowerCase()];

    if (keyword !== undefined) {
        return keyword;
    }

    const match =
        /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/i.exec(
            text.trim(),
        );

    if (match === null) {
        return undefined;
    }

    const numbers = match.slice(1, 5).map(Number);
    const timesInRange = [numbers[0]!, numbers[2]!].every((x) => x >= 0 && x <= 1);

    return numbers.every(Number.isFinite) && timesInRange ? numbers : undefined;
}

export const rounded = (value: number) => Math.round(value * 100) / 100;
export const topBy = <T>(list: T[], key: (item: T) => number, limit: number) =>
    [...list].sort((a, b) => key(b) - key(a)).slice(0, limit);

export function shadowValue(text: string): unknown {
    const layers: Obj[] = [];
    const dimension = (value: number | undefined) => `${rounded(value ?? 0)}px`;

    for (const layer of commaParts(text)) {
        const color = colorsIn(layer, true)[0];
        const lengths = parts(layer.replace(color?.text ?? "", " "))
            .filter((part) => part !== "inset")
            .map((part) => px(part));

        if (
            color === undefined ||
            lengths.length < 2 ||
            lengths.length > 4 ||
            lengths.some((length) => length === undefined)
        ) {
            return text;
        }

        layers.push({
            color: color.text.replace(/\s+/g, " "),
            offsetX: dimension(lengths[0]),
            offsetY: dimension(lengths[1]),
            blur: dimension(lengths[2]),
            ...(lengths[3] === undefined ? {} : { spread: dimension(lengths[3]) }),
            ...(/\binset\b/.test(layer) ? { inset: true } : {}),
        });
    }

    return layers.length === 1 ? layers[0] : layers;
}

const pxOf = (value: unknown) => px(String(value ?? "0")) ?? 0;
const layersOf = (value: unknown) => (Array.isArray(value) ? value : [value]) as Obj[];

export function elevation(value: unknown): number {
    const layers = typeof value === "object" && value !== null ? layersOf(value) : [];

    return Math.max(0, ...layers.map((layer) => pxOf(layer.blur) + Math.abs(pxOf(layer.offsetY))));
}

export class Book {
    tokens = new Map<string, { path: string[]; node: Obj }>();
    dark = new Map<string, { path: string[]; node: Obj }>();

    has(path: string[]) {
        return this.tokens.has(path.join("."));
    }

    add(path: string[], node: Obj) {
        this.tokens.set(path.join("."), { path, node });
    }

    addDark(path: string[], node: Obj) {
        this.dark.set(path.join("."), { path, node });
    }

    taken() {
        return new Set(this.tokens.keys());
    }

    group(name: string) {
        return [...this.tokens.values()].filter((entry) => entry.path[0] === name);
    }

    listed(name: string) {
        return this.group(name)
            .sort((a, b) => (px(String(a.node.$value)) ?? 0) - (px(String(b.node.$value)) ?? 0))
            .map((entry) => `${entry.path[1]} ${String(entry.node.$value)}`);
    }
}

const TAILWIND_TEXT: Record<string, string> = {
    xs: "0.75rem",
    sm: "0.875rem",
    base: "1rem",
    lg: "1.125rem",
    xl: "1.25rem",
    "2xl": "1.5rem",
    "3xl": "1.875rem",
    "4xl": "2.25rem",
    "5xl": "3rem",
    "6xl": "3.75rem",
    "7xl": "4.5rem",
    "8xl": "6rem",
    "9xl": "8rem",
};
const TAILWIND_RADIUS: Record<string, string> = {
    xs: "0.125rem",
    sm: "0.25rem",
    md: "0.375rem",
    lg: "0.5rem",
    xl: "0.75rem",
    "2xl": "1rem",
    "3xl": "1.5rem",
    full: "9999px",
};
const SIZE_BELOW = ["sm", "xs", "2xs"];
const SIZE_ABOVE = ["lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl"];
const LADDER = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"];
const LADDERS: Record<number, string[]> = {
    1: ["md"],
    2: ["sm", "lg"],
    3: ["sm", "md", "lg"],
    4: ["sm", "md", "lg", "xl"],
    5: ["xs", "sm", "md", "lg", "xl"],
};

// Entries come most used first, so the first of a group of near values stands for all of them.
function cluster<K, V>(
    entries: [K, V][],
    near: (kept: K, key: K) => boolean,
    join: (kept: [K, V], value: V) => void,
): [K, V][] {
    const clusters: [K, V][] = [];

    for (const [key, value] of entries) {
        const found = clusters.find(([other]) => near(other, key));

        if (found === undefined) {
            clusters.push([key, value]);
        } else {
            join(found, value);
        }
    }

    return clusters;
}

const addCount = (kept: [unknown, number], count: number) => {
    kept[1] += count;
};

const addFactCount = (kept: [unknown, { count: number }], fact: { count: number }) => {
    kept[1].count += fact.count;
};

export function fontScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
    const ranked = [...facts.fonts.values()].sort((a, b) => b.count - a.count);
    const named = book.group("font").filter((entry) => !/^(?:heading|body)/.test(entry.path[1]!));

    const kindOf = (stack: string[]) =>
        stack.some((name) => /mono|code|courier|consolas|menlo|monaco/i.test(name)) ||
        stack.includes("monospace")
            ? "mono"
            : stack.includes("serif") && !stack.includes("sans-serif")
              ? "serif"
              : "sans";

    const add = (kind: string, stack: string[]) => {
        const path = ["font", kind];

        if (book.has(path)) {
            return undefined;
        }

        book.add(path, { $value: stack, $type: "fontFamily" });
        result.fonts[path.join(".")] = stack.join(", ");

        return path;
    };

    const alias = (kind: string, target: string[]) =>
        book.add(["font", kind], { $value: `{${target.join(".")}}`, $type: "fontFamily" });

    for (const entry of named) {
        result.fonts[entry.path.join(".")] = (entry.node.$value as string[]).join(", ");
    }

    if (explicit.has("font")) {
        const covered = new Set(
            named.map((entry) => (entry.node.$value as string[])[0]?.toLowerCase()),
        );
        const mono = ranked
            .slice(0, 8)
            .find(
                (fact) =>
                    fact.stack[0] !== undefined &&
                    kindOf(fact.stack) === "mono" &&
                    !covered.has(fact.stack[0].toLowerCase()),
            );

        if (
            mono !== undefined &&
            !named.some((entry) => kindOf(entry.node.$value as string[]) === "mono")
        ) {
            add("mono", mono.stack);
        }

        const sans = named.find((entry) => /sans|body|base|text/.test(entry.path[1]!)) ?? named[0];
        const heading = named.find((entry) => /heading|display|title/.test(entry.path[1]!));

        if (sans !== undefined && !book.has(["font", "body"])) {
            alias("body", sans.path);
        }

        if (heading !== undefined && !book.has(["font", "heading"])) {
            alias("heading", heading.path);
        }

        return;
    }

    const body = ranked
        .filter((fact) => kindOf(fact.stack) !== "mono")
        .sort((a, b) => b.body * 3 + b.count - (a.body * 3 + a.count))[0];
    const bodyPath = body === undefined ? undefined : add(kindOf(body.stack), body.stack);
    const mono = ranked
        .filter((fact) => kindOf(fact.stack) === "mono")
        .sort((a, b) => b.code + b.count - (a.code + a.count))[0];

    if (mono !== undefined) {
        add("mono", mono.stack);
    }

    const heading = ranked
        .filter((fact) => fact !== body && fact.heading > 0 && kindOf(fact.stack) !== "mono")
        .sort((a, b) => b.heading - a.heading)[0];
    let headingPath: string[] | undefined;

    if (heading !== undefined) {
        const kind = kindOf(heading.stack);

        headingPath = add(book.has(["font", kind]) ? "display" : kind, heading.stack);
    }

    const other = ranked.find(
        (fact) =>
            fact !== body &&
            fact !== mono &&
            fact !== heading &&
            kindOf(fact.stack) === "serif" &&
            !book.has(["font", "serif"]),
    );

    if (other !== undefined) {
        add("serif", other.stack);
    }

    if (bodyPath !== undefined) {
        alias("body", bodyPath);
        alias("heading", headingPath ?? bodyPath);
    }
}

function sizeValue(size: number, fact: SizeFact): string {
    const form = [...fact.forms].sort((a, b) => b[1] - a[1])[0]?.[0] ?? `${size}px`;

    return /^-?[\d.]+(?:px|rem)$/.test(form) ? form : `${rounded(size)}px`;
}

export function sizeScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
    const sizes = [...facts.sizes].filter(([size]) => size >= 9 && size <= 96);

    if (facts.tailwind && facts.classText.size >= 1 && (explicit.has("text") || sizes.length < 3)) {
        for (const [name] of topBy([...facts.classText], ([, count]) => count, 9)) {
            if (TAILWIND_TEXT[name] !== undefined && !book.has(["text", name])) {
                book.add(["text", name], { $value: TAILWIND_TEXT[name], $type: "dimension" });
                explicit.add("text");
            }
        }
    }

    const weight = ([, fact]: [number, SizeFact]) => fact.count + fact.body * 2;
    // Sizes a pixel apart are one size (11px and 12px).
    const merged = cluster(
        sizes
            .sort((a, b) => weight(b) - weight(a) || a[0] - b[0])
            .map(([size, fact]): [number, SizeFact] => [size, { ...fact }]),
        (other, size) => Math.abs(other - size) <= 1,
        ([, kept], fact) => {
            kept.count += fact.count;
            kept.body += fact.body;
            kept.heading += fact.heading;
        },
    );

    if (explicit.has("text")) {
        const named = book.group("text").map((entry) => px(String(entry.node.$value)) ?? -99);

        for (const [size, fact] of topBy(merged, weight, 8)) {
            const path = ["text", String(rounded(size)).replace(".", "-")];

            if (named.every((value) => Math.abs(value - size) > 1) && !book.has(path)) {
                book.add(path, { $value: sizeValue(size, fact), $type: "dimension" });
            }
        }

        result.typeScale = { sizes: book.listed("text") };

        return;
    }

    if (sizes.length === 0) {
        return;
    }

    let kept = topBy(merged, (entry) => weight(entry) + entry[1].heading, 10).sort(
        (a, b) => a[0] - b[0],
    );

    const bodyAt = (list: typeof kept) => {
        const withBody = list.filter(([, fact]) => fact.body > 0);

        return withBody.length > 0
            ? list.indexOf(topBy(withBody, ([, fact]) => fact.body, 1)[0]!)
            : list.indexOf(topBy(list, ([size]) => -Math.abs(size - 16), 1)[0]!);
    };

    let base = bodyAt(kept);

    while (base > SIZE_BELOW.length || kept.length - base - 1 > SIZE_ABOVE.length) {
        kept =
            base > SIZE_BELOW.length &&
            (kept.length - base - 1 <= SIZE_ABOVE.length ||
                kept[0]![1].count <= kept.at(-1)![1].count)
                ? kept.slice(1)
                : kept.slice(0, -1);
        base = bodyAt(kept);
    }

    const names = kept.map((_, at) =>
        at === base ? "base" : at < base ? SIZE_BELOW[base - at - 1]! : SIZE_ABOVE[at - base - 1]!,
    );

    kept.forEach(([size, fact], at) => {
        book.add(["text", names[at]!], { $value: sizeValue(size, fact), $type: "dimension" });
    });

    const above = kept.slice(base).map(([size]) => size);
    const ratios = above.slice(1).map((size, at) => size / above[at]!);
    const logMean = ratios.reduce((sum, ratio) => sum + Math.log(ratio), 0) / ratios.length;

    result.typeScale = {
        base: `${rounded(kept[base]![0])}px`,
        sizes: kept.map(([size], at) => `${names[at]} ${rounded(size)}px`),
        ...(ratios.length > 0 ? { ratio: rounded(Math.exp(logMean)) } : {}),
    };
}

export function spacingScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
    const named = () =>
        book
            .group("space")
            .map((entry) => px(String(entry.node.$value)))
            .filter((value): value is number => value !== undefined && value > 0);
    const counts = new Map(facts.spacing);

    // Tailwind classes are steps of 4px; they count only for a project that uses Tailwind.
    if (facts.tailwind) {
        for (const [size, count] of facts.classSpacing) {
            counts.set(size, (counts.get(size) ?? 0) + count);
        }
    }

    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);

    if (total === 0) {
        const steps = [...new Set(named())].sort((a, b) => a - b);

        result.spacing = { base: steps[0], steps, off: [] };

        return;
    }

    const share = (unit: number) =>
        [...counts]
            .filter(([size]) => size % unit === 0)
            .reduce((sum, [, count]) => sum + count, 0) / total;
    const base = share(8) >= 0.85 ? 8 : share(4) >= 0.75 ? 4 : share(2) >= 0.75 ? 2 : 4;

    // Values a pixel apart are one value (15px and 16px), but below 4px every pixel counts.
    const clusters = cluster(
        [...counts]
            .filter(([size]) => size >= 1 && size <= 192)
            .sort((a, b) => b[1] - a[1] || a[0] - b[0]),
        (other, size) => Math.abs(other - size) <= 1 && Math.min(other, size) >= 4,
        addCount,
    );

    // A value used once that is off the grid or under 4px (a hairline) is a one-off, not a step.
    const kept = topBy(
        clusters.filter(
            ([size, count]) =>
                size >= 2 &&
                (count >= 2 || (size >= 4 && size % Math.min(base, 4) === 0)) &&
                (size >= 4 || count >= 3),
        ),
        ([, count]) => count,
        12,
    );
    const own = explicit.has("space") ? named() : [];

    for (const [size] of kept.sort((a, b) => a[0] - b[0])) {
        const path = ["space", String(rounded(size / 4)).replace(".", "-")];

        if (own.every((value) => Math.abs(value - size) > 1 || size < 4) && !book.has(path)) {
            book.add(path, { $value: `${rounded(size)}px`, $type: "dimension" });
        }
    }

    const steps = [...new Set(named().map((value) => rounded(value)))].sort((a, b) => a - b);

    result.spacing = {
        base: explicit.has("space") ? steps[0] : base,
        steps,
        off: steps.filter((size) => size % 4 !== 0).slice(0, 6),
    };
}

const radiusForm = (text: string, fallback: string) =>
    /^[\d.]+(?:px|rem|em)$/.test(text) ? text : fallback;

export function radiusScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
    if (
        facts.tailwind &&
        facts.classRadius.size > 0 &&
        (explicit.has("radius") || facts.radii.size === 0)
    ) {
        for (const [name] of topBy([...facts.classRadius], ([, count]) => count, 6)) {
            const value = TAILWIND_RADIUS[name];

            if (value !== undefined && !book.has(["radius", name])) {
                book.add(["radius", name], { $value: value, $type: "dimension" });
                explicit.add("radius");
            }
        }
    }

    const byCount = [...facts.radii]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([key, fact]): [string, typeof fact] => [key, { ...fact }]);

    if (explicit.has("radius")) {
        const own = book.group("radius");
        const has = (key: string) =>
            own.some((entry) =>
                key === "full"
                    ? (px(String(entry.node.$value)) ?? 0) >= 100
                    : Math.abs((px(String(entry.node.$value)) ?? -99) - Number(key)) <= 1,
            );
        const extra = cluster(
            byCount.filter(([key]) => !has(key) && (key === "full" || Number(key) >= 2)),
            (other, key) =>
                other !== "full" && key !== "full" && Math.abs(Number(other) - Number(key)) <= 1,
            addFactCount,
        );
        const taken = new Set(own.map((entry) => entry.path[1]));

        for (const [key, fact] of extra.slice(0, 6)) {
            const name = key === "full" ? "full" : key.replace(".", "-");

            if (!taken.has(name)) {
                book.add(["radius", name], {
                    $value: radiusForm(fact.text, key === "full" ? "9999px" : `${key}px`),
                    $type: "dimension",
                });
            }
        }

        result.radii = book.listed("radius");

        return;
    }

    const clusters = cluster(
        byCount.filter(([key]) => key !== "full"),
        (other, key) => Math.abs(Number(other) - Number(key)) <= 1,
        addFactCount,
    );
    const kept = topBy(clusters, ([, fact]) => fact.count, 5).sort(
        (a, b) => Number(a[0]) - Number(b[0]),
    );

    kept.forEach(([key, fact], at) => {
        const name = LADDERS[kept.length]![at]!;
        const form = /^-?[\d.]+(?:px|rem|em)$/.test(fact.text) ? fact.text : `${key}px`;

        book.add(["radius", name], { $value: form, $type: "dimension" });
        result.radii.push(`${name} ${form}`);
    });

    if (facts.radii.has("full")) {
        const value = radiusForm(facts.radii.get("full")!.text, "9999px");

        book.add(["radius", "full"], { $value: value, $type: "dimension" });
        result.radii.push(`full ${value}`);
    }
}

function sameShadow(a: unknown, b: unknown): boolean {
    const first = layersOf(a);
    const second = layersOf(b);
    const hex = (value: unknown) =>
        typeof value === "string" ? colorsIn(value)[0]?.hex : undefined;

    return (
        first.length === second.length &&
        first.every((layer, at) => {
            const other = second[at]!;

            return (
                (layer.inset === true) === (other.inset === true) &&
                Math.abs(pxOf(layer.offsetX) - pxOf(other.offsetX)) <= 1 &&
                Math.abs(pxOf(layer.offsetY) - pxOf(other.offsetY)) <= 1 &&
                Math.abs(pxOf(layer.blur) - pxOf(other.blur)) <= 2 &&
                Math.abs(pxOf(layer.spread) - pxOf(other.spread)) <= 1 &&
                hex(layer.color) === hex(other.color)
            );
        })
    );
}

export function shadowScale(facts: Facts, book: Book, result: Inferred): void {
    const clusters = cluster(
        [...facts.shadows]
            .sort((a, b) => b[1] - a[1])
            .map(([text, count]): [unknown, number] => [shadowValue(text), count])
            .filter(([value]) => typeof value !== "string"),
        sameShadow,
        addCount,
    );
    const own = book.group("shadow").map((entry) => entry.node.$value);
    const top = topBy(
        clusters.filter(([value]) => !own.some((other) => sameShadow(other, value))),
        ([, count]) => count,
        8,
    );
    // A ring or an inset line is not a step of elevation: it gets a name of its own.
    const isRing = ([value]: [unknown, number]) =>
        layersOf(value).every((layer) => layer.inset === true) ||
        layersOf(value).every((layer) => pxOf(layer.blur) === 0 && pxOf(layer.offsetY) === 0);
    const rings = top.filter(isRing);
    const lifts = top
        .filter((entry) => !isRing(entry))
        .sort((a, b) => elevation(a[0]) - elevation(b[0]));

    const free = (name: string) => !book.has(["shadow", name]);

    lifts.forEach(([value], at) => {
        const wanted = (LADDERS[lifts.length] ?? LADDER)[at]!;
        const name = free(wanted) ? wanted : (LADDER.find(free) ?? `extra-${at + 1}`);

        book.add(["shadow", name], { $value: value, $type: "shadow" });
    });

    const seen = new Map<string, number>();

    for (const [value] of rings) {
        const kind = layersOf(value).every((layer) => layer.inset === true) ? "inset" : "ring";
        const count = (seen.get(kind) ?? 0) + 1;
        const name = count === 1 ? kind : `${kind}-${count}`;

        seen.set(kind, count);

        if (free(name)) {
            book.add(["shadow", name], { $value: value, $type: "shadow" });
        }
    }

    result.shadows = book.group("shadow").length;
}

export function breakpointScale(
    facts: Facts,
    book: Book,
    explicit: Set<Category>,
    result: Inferred,
): void {
    if (explicit.has("breakpoint")) {
        return;
    }

    const clusters = cluster(
        [...facts.breakpoints].sort((a, b) => b[1] - a[1]),
        (other, size) => Math.abs(other - size) <= Math.max(2, size * 0.02),
        addCount,
    );
    const names = ["sm", "md", "lg", "xl", "2xl"];

    topBy(clusters, ([, count]) => count, 5)
        .sort((a, b) => a[0] - b[0])
        .forEach(([size], at) => {
            book.add(["breakpoint", names[at]!], { $value: `${size}px`, $type: "dimension" });
            result.breakpoints.push(`${names[at]} ${size}px`);
        });
}
