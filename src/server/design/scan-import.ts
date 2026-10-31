import { parseColor } from "./color.ts";
import { isGroup, isObject, type Obj } from "./scan-import-convert.ts";
import {
    changesBetween,
    DARK,
    type Entry,
    flatten,
    hasWord,
    LIGHT,
    LIMITS,
    Mode,
    segment,
    tokensOf,
    words,
} from "./scan-import-eval.ts";

interface Pending {
    file: string;
    root: unknown;
    named: boolean;
}

interface Found {
    default: Obj;
    dark: Obj;
    extra: Record<string, Obj>;
    count: number;
    notes: string[];
}

export interface Imported extends Found {
    files: string[];
    certain: boolean;
    // Sorted into modes only once every file is read, by `finishImports`.
    pending: Pending[];
    done: boolean;
}

// By file name, so that `package.json` and `tsconfig.json` are never read as tokens.
const TOKEN_FILE =
    /(?:^|\/)(?:[^/]*tokens?[^/]*|[^/]*theme[^/]*)\.json$|(?:^|\/)(?:design-?tokens?|tokens?|properties|brands?|themes?|style-?dictionary|dictionary)\/(?:[^/]+\/)*[^/]+\.json$|(?:^|\/)\$(?:themes|metadata)\.json$/i;

const MAX_FILES = 300;
const STUDIO_MARK = /(?:^|\/)\$(?:themes|metadata)\.json$/;
const dirOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf("/")));

const setOrder = (metadata: unknown): string[] =>
    isObject(metadata) && Array.isArray(metadata.tokenSetOrder)
        ? [
              ...new Set(
                  metadata.tokenSetOrder.filter((name): name is string => typeof name === "string"),
              ),
          ]
        : [];

function isStudioFile(root: unknown): root is Obj {
    if (!isObject(root)) {
        return false;
    }

    if (Array.isArray(root.$themes) || isObject(root.$metadata)) {
        return true;
    }

    const keys = Object.keys(root).filter((key) => !key.startsWith("$"));

    return (
        keys.length >= 2 &&
        keys.some((key) => hasWord(key, DARK) || hasWord(key, LIGHT)) &&
        keys.every((key) => isObject(root[key]))
    );
}

export function importTokens(into: Imported, file: string, source: string): void {
    if (into.pending.length >= MAX_FILES || source.length > 2_000_000) {
        return;
    }

    let root: unknown;

    try {
        root = JSON.parse(source);
    } catch {
        return;
    }

    if (isObject(root) || (Array.isArray(root) && STUDIO_MARK.test(file))) {
        into.pending.push({ file, root, named: TOKEN_FILE.test(file) });
    }
}

function addTo(target: Obj, source: Obj): void {
    for (const [key, value] of Object.entries(source)) {
        const have = target[key];

        if (!(key in target)) {
            target[key] = value;
        } else if (isGroup(have) && isGroup(value)) {
            addTo(have, value);
        }
    }
}

interface StudioSource {
    sets: Map<string, Obj>;
    order: string[];
    themes: unknown[];
}

function addFound(into: Imported, found: Found, count: number, files: string[]): void {
    addTo(into.default, found.default);
    addTo(into.dark, found.dark);

    for (const [mode, tree] of Object.entries(found.extra)) {
        into.extra[mode] ??= {};
        addTo(into.extra[mode]!, tree);
    }

    into.count += count;
    into.files.push(...files);
    into.notes.push(...found.notes);
}

function addStudio(into: Imported, source: StudioSource, files: string[]): void {
    const found = studioTokens(source);

    if (found.count > 0) {
        into.certain = true;
        addFound(into, found, found.count, files);
    }
}

export function finishImports(into: Imported): void {
    if (into.done) {
        return;
    }

    into.done = true;

    const { pending } = into;
    const taken = new Set<Pending>();
    const marks = new Map<string, { themes?: unknown[]; order?: string[] }>();

    for (const item of pending) {
        if (!STUDIO_MARK.test(item.file)) {
            continue;
        }

        const dir = dirOf(item.file);
        const mark = marks.get(dir) ?? {};

        if (item.file.endsWith("$themes.json") && Array.isArray(item.root)) {
            mark.themes = item.root;
        } else if (item.file.endsWith("$metadata.json") && isObject(item.root)) {
            mark.order = setOrder(item.root);
        }

        marks.set(dir, mark);
        taken.add(item);
    }

    for (const [dir, mark] of marks) {
        const prefix = dir === "" ? "" : `${dir}/`;
        const sets = new Map<string, Obj>();
        const files: string[] = [];

        for (const item of pending) {
            if (
                taken.has(item) ||
                !isObject(item.root) ||
                !item.file.endsWith(".json") ||
                !item.file.startsWith(prefix)
            ) {
                continue;
            }

            sets.set(item.file.slice(prefix.length).replace(/\.json$/, ""), item.root);
            files.push(item.file);
            taken.add(item);
        }

        if (sets.size > 0) {
            addStudio(into, { sets, order: mark.order ?? [], themes: mark.themes ?? [] }, files);
        }
    }

    for (const item of pending) {
        if (taken.has(item) || !isStudioFile(item.root)) {
            continue;
        }

        taken.add(item);

        const sets = new Map<string, Obj>();

        for (const [name, node] of Object.entries(item.root)) {
            if (!name.startsWith("$") && isObject(node) && sets.size < LIMITS.sets) {
                sets.set(name, node);
            }
        }

        const themes = Array.isArray(item.root.$themes) ? item.root.$themes : [];

        addStudio(into, { sets, order: setOrder(item.root.$metadata), themes }, [item.file]);
    }

    const files = pending
        .filter((item) => !taken.has(item) && isObject(item.root) && item.named)
        .map((item) => ({ file: item.file, root: item.root as Obj }));
    const found = styleDictionaryTokens(files);

    if (found.count > 0) {
        const count =
            found.count +
            leavesIn(found.dark) +
            Object.values(found.extra).reduce((sum, tree) => sum + leavesIn(tree), 0);

        addFound(into, found, count, files.map((item) => item.file).sort());
    }

    into.pending = [];
}

function leavesIn(tree: Obj): number {
    return Object.entries(tree).reduce(
        (sum, [key, child]) =>
            sum +
            (key.startsWith("$") || !isObject(child) ? 0 : "$value" in child ? 1 : leavesIn(child)),
        0,
    );
}

interface Theme {
    name: string;
    group?: string;
    enabled: string[];
    source: string[];
}

function themesOf(themes: unknown[]): Theme[] {
    const out: Theme[] = [];

    for (const item of themes.slice(0, 40)) {
        if (!isObject(item) || !isObject(item.selectedTokenSets)) {
            continue;
        }

        const on = (status: string) =>
            Object.entries(item.selectedTokenSets as Obj)
                .filter(([, value]) => value === status || (status === "enabled" && value === true))
                .map(([name]) => name);

        out.push({
            name: String(item.name ?? item.id ?? "").slice(0, 60),
            ...(typeof item.group === "string" ? { group: item.group.slice(0, 60) } : {}),
            enabled: on("enabled"),
            source: on("source"),
        });
    }

    return out;
}

function pickModes(
    themes: Theme[],
    names: string[],
    notes: string[],
): { light: string[]; dark: string[] | undefined; extra: [string, string[]][] } {
    const order = (list: string[]) => names.filter((name) => list.includes(name));
    const setsOf = (list: Theme[]) =>
        order(list.flatMap((theme) => [...theme.source, ...theme.enabled]));
    const isDarkTheme = (theme: Theme) =>
        hasWord(theme.name, DARK) || theme.enabled.some((name) => hasWord(name, DARK));
    const stem = (theme: Theme) =>
        words(theme.name)
            .filter((word) => !DARK.has(word) && !LIGHT.has(word))
            .join(" ");
    const darkSets = names.filter((name) => hasWord(name, DARK));
    const lightSets = names.filter((name) => !hasWord(name, DARK) && hasWord(name, LIGHT));
    const baseSets = names.filter((name) => !hasWord(name, DARK) && !hasWord(name, LIGHT));
    let light: string[] | undefined;
    let dark: string[] | undefined;
    const extra: [string, string[]][] = [];

    if (themes.length > 0) {
        // Groups apply together: the first theme of each non-mode group (a brand) is in every mode.
        const groups = new Map<string, Theme[]>();

        for (const theme of themes) {
            const key = theme.group ?? "";

            groups.set(key, [...(groups.get(key) ?? []), theme]);
        }

        const lists = [...groups.values()];
        const modeList = lists.find((list) => list.some(isDarkTheme)) ?? lists[0]!;
        const others = lists.filter((list) => list !== modeList).map((list) => list[0]!);
        const lightTheme =
            modeList.find((theme) => !isDarkTheme(theme) && hasWord(theme.name, LIGHT)) ??
            modeList.find((theme) => !isDarkTheme(theme));
        const lightStem = lightTheme === undefined ? undefined : stem(lightTheme);
        const darkTheme =
            modeList.find((theme) => isDarkTheme(theme) && stem(theme) === lightStem) ??
            modeList.find(isDarkTheme);

        light = lightTheme === undefined ? undefined : setsOf([...others, lightTheme]);
        dark = darkTheme === undefined ? undefined : setsOf([...others, darkTheme]);

        const spare =
            lightTheme === undefined
                ? []
                : modeList.filter((theme) => theme !== lightTheme && theme !== darkTheme);
        const used: Theme[] = [];

        for (const theme of spare.slice(0, 3)) {
            const mode = words(theme.name).join("-");

            if (!["", "dark", "light"].includes(mode) && !extra.some(([name]) => name === mode)) {
                extra.push([mode, setsOf([...others, theme])]);
                used.push(theme);
            }
        }

        const read = [...others, lightTheme, darkTheme, ...used].filter(
            (theme): theme is Theme => theme !== undefined,
        );

        if (read.length < themes.length) {
            notes.push(
                `Tokens Studio has ${themes.length} themes (${themes.map((theme) => theme.name).join(", ")}); the scan reads ${read.map((theme) => theme.name).join(", ")}.`,
            );
        }
    }

    if (light === undefined && dark === undefined) {
        light = darkSets.length > 0 ? [...baseSets, ...lightSets] : names;
        dark = darkSets.length > 0 ? [...baseSets, ...darkSets] : undefined;
    } else if (light === undefined) {
        light = dark;
        dark = undefined;
    } else if (dark === undefined && darkSets.length > 0) {
        dark = [
            ...light.filter((name) => !hasWord(name, LIGHT)),
            ...darkSets.filter((name) => !light!.includes(name)),
        ];
    }

    return { light: light ?? [], dark, extra };
}

function readMode(budget: { left: number }, roots: Obj[]): Mode {
    const entries = new Map<string, Entry>();

    for (const root of roots) {
        flatten(root, entries, budget);
    }

    return new Mode(entries);
}

function changesFrom(first: Map<string, Obj>, mode: Mode, notes: string[], label: string): Obj {
    const { tree, skipped } = changesBetween(first, tokensOf(mode).flat);

    if (skipped > 0) {
        notes.push(`${skipped} tokens that only ${label} has were left out.`);
    }

    return tree;
}

function studioTokens(input: StudioSource): Found {
    const notes: string[] = [];
    const names = [
        ...input.order.filter((name) => input.sets.has(name)),
        ...[...input.sets.keys()].filter((name) => !input.order.includes(name)),
    ].slice(0, LIMITS.sets);
    const { light, dark, extra } = pickModes(themesOf(input.themes), names, notes);

    notes.push(
        `Tokens Studio sets: the default mode is ${light.join(" + ") || "none"}${dark === undefined ? "" : `; the dark mode is ${dark.join(" + ")}`}${extra.map(([mode, sets]) => `; ${mode} is ${sets.join(" + ")}`).join("")}.`,
    );

    const budget = { left: LIMITS.tokens };

    const read = (list: string[]) =>
        readMode(
            budget,
            list.map((name) => input.sets.get(name)!),
        );

    const first = tokensOf(read(light));
    const result: Found = {
        default: first.tree,
        dark: {},
        extra: {},
        count: first.flat.size,
        notes,
    };

    if (dark !== undefined && dark.join("\n") !== light.join("\n")) {
        result.dark = changesFrom(first.flat, read(dark), notes, "the dark mode");
    }

    for (const [mode, sets] of extra) {
        result.extra[mode] = changesFrom(first.flat, read(sets), notes, `the ${mode} mode`);
    }

    return result;
}

interface SdFile {
    file: string;
    root: Obj;
}

const MODE_FOLDER = /^(?:brands?|themes?|modes?|skins?|variants?|schemes?)$/i;

function modeOfFile(file: string): string | undefined {
    const parts = file.replace(/\.[^./]+$/, "").split("/");
    const at = parts.findIndex((part, index) => index < parts.length - 1 && MODE_FOLDER.test(part));

    if (at !== -1) {
        return segment(parts[at + 1]!).toLowerCase() || undefined;
    }

    return hasWord(parts.at(-1)!, DARK) ? "dark" : undefined;
}

// By the words of a token's path, in order: a family is any text, the others are numbers.
const NAMED_TYPES: [RegExp, string, boolean][] = [
    [/\bweight\b|font-weight/, "fontWeight", false],
    [/\b(?:family|families|typeface)\b/, "fontFamily", true],
    [
        /\b(?:opacity|alpha|z|zindex|z-index|line-height|lineheight|leading|ratio|scale)\b/,
        "number",
        false,
    ],
    [/\b(?:time|duration|delay|transition)\b/, "duration", false],
    [
        /\b(?:size|sizes|spacing|space|spaces|radius|radii|rounded|dimension|dimensions|width|height|gap|gutter|breakpoint|breakpoints|tracking|letter-spacing|border-width|stroke)\b/,
        "dimension",
        false,
    ],
];

function inferType(path: string[], value: unknown, node: Obj): string | undefined {
    const attributes = isObject(node.attributes) ? node.attributes : {};
    const category = String(attributes.category ?? path[0] ?? "").toLowerCase();
    const kind = String(attributes.type ?? "").toLowerCase();
    const where = [category, kind, ...path.map((part) => part.toLowerCase())].join(" ");
    const has = (pattern: RegExp) => pattern.test(where);
    const text = typeof value === "string" ? value.trim() : undefined;
    // The number tests take time in the square of the length: a long text is not tested.
    const short = text !== undefined && text.length <= 200;

    if (typeof value === "object" && value !== null) {
        return Array.isArray(value) && value.every((each) => typeof each === "string")
            ? "fontFamily"
            : has(/shadow|elevation/)
              ? "shadow"
              : has(/font|type|text/)
                ? "typography"
                : undefined;
    }

    if (text !== undefined && text.startsWith("{")) {
        return undefined;
    }

    if (has(/\b(?:colou?rs?|clr)\b/) && text !== undefined && parseColor(text) !== undefined) {
        return "color";
    }

    if (text !== undefined && has(/shadow|elevation/) && /\d/.test(text)) {
        return "shadow";
    }

    if (short && /^-?\d*\.?\d+(?:px|rem|em|%|pt|vw|vh)$/i.test(text!)) {
        return "dimension";
    }

    if (short && /^\d*\.?\d+(?:ms|s)$/i.test(text!)) {
        return "duration";
    }

    if (
        text !== undefined &&
        /^(?:#|rgba?\(|hsla?\(|oklch\()/i.test(text) &&
        parseColor(text) !== undefined
    ) {
        return "color";
    }

    const numeric = typeof value === "number" || (short && /^-?\d*\.?\d+$/.test(text!));

    for (const [pattern, type, needsText] of NAMED_TYPES) {
        if (has(pattern) && (needsText ? text !== undefined : numeric)) {
            return type;
        }
    }

    if (
        has(/\b(?:easing|ease|timing|curve)\b/) &&
        text !== undefined &&
        /cubic-bezier|ease|linear/i.test(text)
    ) {
        return "cubicBezier";
    }

    return undefined;
}

function styleDictionaryTokens(files: SdFile[]): Found {
    const notes: string[] = [];
    const budget = { left: LIMITS.tokens };
    const base: Obj[] = [];
    const modes = new Map<string, Obj[]>();

    for (const item of [...files].sort((a, b) => a.file.localeCompare(b.file))) {
        const mode = modeOfFile(item.file);

        if (mode === undefined) {
            base.push(item.root);
        } else {
            modes.set(mode, [...(modes.get(mode) ?? []), item.root]);
        }
    }

    const read = (list: Obj[]) => {
        const mode = readMode(budget, list);

        for (const entry of mode.entries.values()) {
            entry.type ??= inferType(entry.path, entry.node.$value ?? entry.node.value, entry.node);
        }

        return mode;
    };

    const names = [...modes.keys()];
    const firstName =
        names.find(
            (name) =>
                !hasWord(name, DARK) &&
                (hasWord(name, LIGHT) || /^(?:default|base|main|standard)$/.test(name)),
        ) ??
        names.find((name) => !hasWord(name, DARK)) ??
        (base.length === 0 ? names[0] : undefined);
    const defaults = firstName === undefined ? [] : (modes.get(firstName) ?? []);
    const first = tokensOf(read([...base, ...defaults]));
    const result: Found = {
        default: first.tree,
        dark: {},
        extra: {},
        count: first.flat.size,
        notes,
    };

    if (names.length > 0) {
        notes.push(
            `Token folders: the default mode is ${[...(base.length > 0 ? ["the shared files"] : []), ...(firstName === undefined ? [] : [firstName])].join(" + ") || "none"}; modes found: ${names.join(", ")}.`,
        );
    }

    for (const name of names.filter((each) => each !== firstName).slice(0, 4)) {
        const tree = changesFrom(first.flat, read([...base, ...modes.get(name)!]), notes, name);

        if (hasWord(name, DARK)) {
            result.dark = tree;
        } else {
            result.extra[name] = tree;
        }
    }

    return result;
}
