/**
 * Imports tokens that a project already keeps in a token file (stream T): W3C DTCG (`$value`), Style Dictionary
 * (`value`), and Tokens Studio (`value` and `type`, with `sizing`, `fontFamilies`, `boxShadow`...; see
 * `scan-import-studio.ts` for token sets, themes, and math). The scan uses them as they are: a project that has tokens
 * does not need them guessed from its CSS. Files are kept as they are read and sorted into modes by `finishImports`,
 * once every file is in.
 */
import { isObject, type Obj } from "./scan-import-convert.ts";
import { materialTokens, type MaterialInput, type MaterialResult } from "./scan-import-material.ts";
import { orderByConfig, styleDictionaryTokens } from "./scan-import-sd.ts";
import { type SdConfig, sdConfigOfJson, sdConfigsIn } from "./scan-import-sd-config.ts";
import { looksLikeSets, studioTokens, type StudioSource } from "./scan-import-studio.ts";

/** A token file that was read: its path, what it parsed to, and whether its name says it holds tokens. */
interface Pending {
    file: string;
    root: unknown;
    named: boolean;
}

/** Tokens found in token files: the default mode, the dark mode, and how many there are. */
export interface Imported {
    default: Obj;
    dark: Obj;
    /** Other modes that a Tokens Studio file has (`high-contrast`), by name: the tokens that each changes. */
    extra: Record<string, Obj>;
    count: number;
    files: string[];
    /** A token source that is sure to be one was read (a Tokens Studio file, a Style Dictionary config): however few tokens it holds. */
    certain: boolean;
    /** Style Dictionary configs: the globs of their token files. */
    configs: SdConfig[];
    /** Stylesheets that hold Material 3 properties, kept until every file is read. */
    materialCss: MaterialInput["css"];
    /** The Material 3 colors, when the files held them: they replace the scan's colors. */
    material?: MaterialResult;
    /** Token files read and not yet sorted into modes (`finishImports` does that, once, when every file has been read). */
    pending: Pending[];
    /** What the Tokens Studio files said that the scan did not take (a theme that was not read). */
    notes: string[];
    done: boolean;
}

/** A file that may hold tokens: by its name, so `package.json` and `tsconfig.json` are never read as tokens. */
export const TOKEN_FILE =
    /(?:^|\/)(?:[^/]*tokens?[^/]*|[^/]*theme[^/]*)\.json$|(?:^|\/)(?:design-?tokens?|tokens?|properties|brands?|themes?|style-?dictionary|dictionary)\/(?:[^/]+\/)*[^/]+\.json$|(?:^|\/)\$(?:themes|metadata)\.json$/i;

const MAX_FILES = 300;
/** `$themes.json` and `$metadata.json`, the two files that Tokens Studio writes beside its sets. */
const STUDIO_MARK = /(?:^|\/)\$(?:themes|metadata)\.json$/;
const dirOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf("/")));

/** Whether a JSON root is one Tokens Studio file: it has `$themes` or `$metadata`, or sets named for light and dark. */
function isStudioFile(root: unknown): root is Obj {
    if (!isObject(root)) {
        return false;
    }

    if (Array.isArray(root.$themes) || isObject(root.$metadata)) {
        return true;
    }

    const keys = Object.keys(root).filter((key) => !key.startsWith("$"));

    return keys.length >= 2 && looksLikeSets(keys) && keys.every((key) => isObject(root[key]));
}

/** Reads a token file. It is kept until every file has been read: `finishImports` sorts the files into modes. */
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

/** A group of the default tree that a later source adds to (a path that is there stays as it is). */
export function addTo(target: Obj, source: Obj): void {
    for (const [key, value] of Object.entries(source)) {
        const have = target[key];

        if (!(key in target)) {
            target[key] = value;
        } else if (
            isObject(have) &&
            isObject(value) &&
            !("$value" in have) &&
            !("$value" in value)
        ) {
            addTo(have, value);
        }
    }
}

/** Adds what a Tokens Studio source holds to the imported tokens. */
function addStudio(into: Imported, source: StudioSource, files: string[]): void {
    const found = studioTokens(source);

    if (found.count === 0) {
        return;
    }

    into.certain = true;
    addTo(into.default, found.default);
    addTo(into.dark, found.dark);

    for (const [mode, tree] of Object.entries(found.extra)) {
        into.extra[mode] ??= {};
        addTo(into.extra[mode]!, tree);
    }

    into.count += found.count;
    into.files.push(...files);
    into.notes.push(...found.notes);
}

/**
 * Sorts the token files that were read into modes, once every file is in. A Tokens Studio file (token sets as top-level
 * keys, with `$themes` or `$metadata`), or a folder of them (`$themes.json`, `$metadata.json`, and a file for each
 * set), is read set by set, and the modes come from its themes. Any other token file is one set, as it was written.
 */
export function finishImports(into: Imported): void {
    if (into.done) {
        return;
    }

    into.done = true;

    const pending = into.pending;
    const taken = new Set<Pending>();
    const marks = new Map<string, { themes?: unknown[]; order?: string[] }>();

    for (const item of pending) {
        if (!STUDIO_MARK.test(item.file)) {
            continue;
        }

        const mark = marks.get(dirOf(item.file)) ?? {};

        if (item.file.endsWith("$themes.json") && Array.isArray(item.root)) {
            mark.themes = item.root;
        } else if (item.file.endsWith("$metadata.json") && isObject(item.root)) {
            mark.order = Array.isArray(item.root.tokenSetOrder)
                ? item.root.tokenSetOrder.filter((name): name is string => typeof name === "string")
                : [];
        }

        marks.set(dirOf(item.file), mark);
        taken.add(item);
    }

    // A folder of Tokens Studio files: each other file under it is a set, named by its path without `.json`.
    for (const [dir, mark] of marks) {
        const sets = new Map<string, Obj>();
        const files: string[] = [];

        for (const item of pending) {
            if (
                taken.has(item) ||
                !isObject(item.root) ||
                !item.file.endsWith(".json") ||
                !(dir === "" || item.file.startsWith(`${dir}/`))
            ) {
                continue;
            }

            const name = (dir === "" ? item.file : item.file.slice(dir.length + 1)).replace(
                /\.json$/,
                "",
            );

            sets.set(name, item.root);
            files.push(item.file);
            taken.add(item);
        }

        if (sets.size > 0) {
            addStudio(into, { sets, order: mark.order ?? [], themes: mark.themes ?? [] }, files);
        }
    }

    for (const item of pending) {
        if (taken.has(item) || !isObject(item.root)) {
            continue;
        }

        if (isStudioFile(item.root)) {
            taken.add(item);

            const sets = new Map<string, Obj>();

            for (const [name, node] of Object.entries(item.root)) {
                if (!name.startsWith("$") && isObject(node) && sets.size < 40) {
                    sets.set(name, node);
                }
            }

            const metadata = item.root.$metadata;
            const order =
                isObject(metadata) && Array.isArray(metadata.tokenSetOrder)
                    ? metadata.tokenSetOrder.filter(
                          (name): name is string => typeof name === "string",
                      )
                    : [];

            addStudio(
                into,
                {
                    sets,
                    order,
                    themes: Array.isArray(item.root.$themes) ? item.root.$themes : [],
                },
                [item.file],
            );
        }
    }

    // Token folders: Style Dictionary sources, and token files of any one project, merged in source order.
    const rest = pending.filter((item) => !taken.has(item) && isObject(item.root));
    const configs = [...into.configs, ...configsIn(rest)];
    const asFiles = (list: Pending[]) =>
        list.map((item) => ({ file: item.file, root: item.root as Obj }));
    const wanted = rest.filter((item) => !isConfigFile(item.root) && !isMaterialJson(item.root));
    // The configs whose globs match files: each one's files are read, a mode config's over the base config's.
    const matched = configs
        .filter((each) => orderByConfig(asFiles(wanted), each) !== undefined)
        .slice(0, 8);
    const listed = new Set(
        matched.flatMap((each) => orderByConfig(asFiles(wanted), each)!.map((item) => item.file)),
    );
    const files = asFiles(
        matched.length === 0
            ? wanted.filter((item) => item.named)
            : wanted.filter((item) => listed.has(item.file)),
    );
    const config = matched[0];

    if (files.length > 0) {
        const found = styleDictionaryTokens(files, matched);

        if (found.count > 0) {
            into.certain = into.certain || matched.length > 0;
            addTo(into.default, found.default);
            addTo(into.dark, found.dark);

            for (const [mode, tree] of Object.entries(found.extra)) {
                into.extra[mode] ??= {};
                addTo(into.extra[mode]!, tree);
            }

            // The tokens that a mode's own file sets count too: a token file for dark is part of what was read.
            into.count +=
                found.count +
                leavesIn(found.dark) +
                Object.values(found.extra).reduce((sum, tree) => sum + leavesIn(tree), 0);
            into.files.push(...files.map((item) => item.file).sort());
            into.notes.push(
                ...(config === undefined
                    ? []
                    : [
                          `Style Dictionary config: the token files are the globs of its source (${[...config.include, ...config.source].slice(0, 4).join(", ")}), in that order.`,
                      ]),
                ...found.notes,
            );
        }
    }

    // Material 3: stylesheets with --md-sys-color-* properties, and the Theme Builder's JSON.
    into.material = materialTokens({
        css: into.materialCss,
        json: pending
            .filter((item) => isMaterialJson(item.root))
            .map((item) => ({ file: item.file, root: item.root as Obj })),
    });
    into.materialCss = [];
    into.pending = [];
}

/** Keeps a stylesheet that holds Material 3 properties; it is read once every file is in. */
export function importMaterial(into: Imported, file: string, text: string): void {
    if (into.materialCss.length < 24 && /--md-(?:sys-color|ref-palette)-/.test(text)) {
        into.materialCss.push({ file, text: text.slice(0, 200_000) });
    }
}

/** How many tokens a tree has. */
function leavesIn(tree: Obj): number {
    return Object.entries(tree).reduce(
        (sum, [key, child]) =>
            sum +
            (key.startsWith("$") || !isObject(child) ? 0 : "$value" in child ? 1 : leavesIn(child)),
        0,
    );
}

/** Whether a JSON root is a Style Dictionary config (it has `source` and `platforms`), not a token file. */
function isConfigFile(root: unknown): boolean {
    return isObject(root) && Array.isArray(root.source) && isObject(root.platforms);
}

/** The Style Dictionary configs among JSON files: `config.json` with `source` and `platforms`. */
function configsIn(items: Pending[]): SdConfig[] {
    return items.flatMap((item) =>
        isConfigFile(item.root)
            ? [sdConfigOfJson(dirOf(item.file), item.file, item.root as Obj)]
            : [],
    );
}

/** The Material Theme Builder's JSON: `{ "schemes": { "light": { "primary": … }, "dark": … } }`. */
function isMaterialJson(root: unknown): boolean {
    return (
        isObject(root) &&
        isObject(root.schemes) &&
        Object.values(root.schemes).some((scheme) => isObject(scheme) && "primary" in scheme)
    );
}

/** Reads the text of a Style Dictionary config written in JavaScript (`sd.config.js`, `config.mjs`): it can hold several. */
export function importConfig(into: Imported, file: string, text: string): void {
    for (const config of sdConfigsIn(dirOf(file), file, text)) {
        if (into.configs.length < 8) {
            into.configs.push(config);
        }
    }
}
