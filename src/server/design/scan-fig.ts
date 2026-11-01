// Everything read from a `.fig` is untrusted: it reaches the report only through the scan's fence.
import { quoted } from "../fence.ts";
import { type Facts } from "./scan-facts.ts";
import { type FigDecoded, decodeFig, readFigBytes } from "./scan-fig-container.ts";
import { FIG_LIMITS, FigError } from "./scan-fig-kiwi.ts";
import {
    type Collection,
    FONT_NAME,
    type FigVariable,
    type Named,
    typeOf,
    collectionsOf,
    familyOf,
    nameFor,
    numberValue,
    safePath,
    stylesOf,
    uniquePath,
    variablesOf,
} from "./scan-fig-nodes.ts";
import { type Imported, addFound } from "./scan-import.ts";
import { assemble, type Progress, dropTypes, hoistTypes, rewrite } from "./scan-tree.ts";
import { type Obj } from "./scan-colors.ts";
import { RESERVED } from "./tokens-base.ts";

export interface FigTokens {
    file: string;
    default: Obj;
    dark: Obj;
    extra: Record<string, Obj>;
    count: number;
    partial: boolean;
    /** One line for the report (untrusted text). */
    line: string;
}

// One deadline for all the Figma files of a scan. It is generous because a busy machine slows the clock many times
// over the work: the 274 KB test fixture takes about a second.
export const FIG_TIME_MS = 20_000;

type Shaped = Named & { type: string };

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function withKinds(count: number, word: string, kinds: [number, string][]): string {
    const shown = kinds.filter(([each]) => each > 0).map(([each, name]) => `${each} ${name}`);

    return `${plural(count, word)}${shown.length === 0 ? "" : ` (${shown.join(", ")})`}`;
}

function modeNameOf(name: string): string {
    const clean = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);

    return clean === "" ? "mode" : RESERVED.has(clean) ? `${clean}-mode` : clean;
}

const isDarkMode = (name: string): boolean => /(?:^|[^a-z])dark(?:[^a-z]|$)/i.test(name);

function modesOf(collections: Map<string, Collection>) {
    // A variable names its collection by guid, or by the collection's published key in a library file.
    const collectionOf = new Map<string, string>();
    const firstOf = new Map<string, string>();
    const firstNames = new Set<string>();
    const byId = new Map<string, { name: string; collection: string }>();

    for (const collection of collections.values()) {
        const first = collection.modes[0];

        collectionOf.set(collection.id, collection.id);

        if (collection.key !== "") {
            collectionOf.set(collection.key, collection.id);
        }

        if (first !== undefined) {
            firstNames.add(modeNameOf(first.name));
            firstOf.set(collection.id, first.id);
        }

        for (const mode of collection.modes) {
            byId.set(mode.id, { name: mode.name, collection: collection.id });
        }
    }

    return { collectionOf, firstOf, firstNames, byId };
}

function valueOf(
    variable: FigVariable,
    mode: string,
    named: Map<string, Shaped>,
    byKey: Map<string, string>,
): Obj | undefined {
    const found = variable.values.get(mode);
    const shape = named.get(variable.id);

    if (found === undefined || shape === undefined) {
        return undefined;
    }

    if (found.kind === "alias") {
        const path = (named.get(byKey.get(found.target) ?? found.target) ?? named.get(found.target))
            ?.path;

        return path === undefined
            ? undefined
            : { $value: `{${path.join(".")}}`, $type: shape.type };
    }

    const value =
        found.kind === "color"
            ? found.value
            : found.kind === "number"
              ? numberValue(found.value, shape.measure)
              : shape.type === "fontFamily"
                ? familyOf(found.value)
                : undefined;

    return value === undefined ? undefined : { $value: value, $type: shape.type };
}

function fill(from: Map<string, Obj>, renamed: Map<string, string>): Obj {
    const out: Obj = {};

    for (const [name, node] of from) {
        const path = (renamed.get(name) ?? name).split(".");
        let at = out;

        for (const key of path.slice(0, -1)) {
            at[key] ??= {};
            at = at[key] as Obj;
        }

        at[path.at(-1)!] = node;
    }

    return out;
}

/** `until` is the deadline of all the scan's Figma files. */
export function figTokens(
    decoded: FigDecoded,
    file: string,
    options: { until?: number } = {},
): FigTokens {
    const until = options.until ?? Date.now() + FIG_TIME_MS;
    const { nodes } = decoded;
    const collections = collectionsOf(nodes);
    const modes = modesOf(collections);
    const { list, byKey } = variablesOf(nodes);
    const named = new Map<string, Shaped>();
    const taken = new Set<string>();
    const next = new Map<string, number>();
    let stop = false;
    let seen = 0;

    // Every path first: an alias names another variable's path.
    for (const variable of list) {
        const { resolved } = variable;
        const token =
            resolved === "COLOR" ||
            resolved === "FLOAT" ||
            (resolved === "STRING" && FONT_NAME.test(variable.name));

        if (Date.now() >= until) {
            stop = true;

            break;
        }

        seen += 1;

        if (!token) {
            continue;
        }

        const kind = resolved === "COLOR" ? "color" : resolved === "FLOAT" ? "number" : "font";
        const shape = nameFor(kind, variable.name);
        const path = uniquePath(safePath(shape), taken, next);

        named.set(variable.id, { ...shape, path, type: typeOf(variable, shape.measure) });
    }

    const entries: { path: string[]; node: Obj }[] = [];
    const changes = new Map<string, Map<string, Obj>>();
    const darkChanges = new Map<string, Obj>();

    for (const variable of list) {
        const shape = named.get(variable.id);

        if (shape === undefined) {
            continue;
        }

        const collection = modes.collectionOf.get(variable.collection) ?? variable.collection;
        const first = modes.firstOf.get(collection) ?? [...variable.values.keys()][0] ?? "";
        const value = valueOf(variable, first, named, byKey);

        if (value === undefined) {
            continue;
        }

        entries.push({ path: shape.path, node: value });

        for (const modeId of variable.values.keys()) {
            const mode = modeId === first ? undefined : modes.byId.get(modeId);

            if (mode === undefined || mode.collection !== collection) {
                continue;
            }

            const changed = valueOf(variable, modeId, named, byKey);

            if (changed === undefined || JSON.stringify(changed) === JSON.stringify(value)) {
                continue;
            }

            const name = modeNameOf(mode.name);

            if (isDarkMode(mode.name)) {
                darkChanges.set(shape.path.join("."), changed);
            } else if (!modes.firstNames.has(name)) {
                // A mode named like a default mode would be refused by the engine.
                const tree = changes.get(name) ?? new Map<string, Obj>();

                tree.set(shape.path.join("."), changed);
                changes.set(name, tree);
            }
        }
    }

    const made = entries.length;
    const { styles, left } = stylesOf(nodes);

    for (const style of styles) {
        if (Date.now() >= until) {
            stop = true;

            break;
        }

        entries.push({ path: uniquePath(safePath(style.path), taken, next), node: style.token });
    }

    const renamed = new Map<string, string>();
    const progress: Progress = { until, read: 0, stopped: false };
    const tokens = rewrite(assemble(entries, renamed, progress), renamed) as Obj;

    stop ||= progress.stopped;

    const darkFirst =
        collections.size > 0 &&
        [...collections.values()].every((each) => isDarkMode(each.modes[0]?.name ?? ""));

    if (darkFirst && Object.keys(tokens).length > 0) {
        tokens.$extensions = { "com.pi-pocket": { mode: "dark" } };
    }

    if (Object.keys(tokens).length > 0) {
        hoistTypes(tokens);
    }

    // No prototype: a mode's name is a key, and never a key of `Object`.
    const extra: Record<string, Obj> = Object.create(null) as Record<string, Obj>;

    for (const [mode, tree] of changes) {
        extra[mode] = dropTypes(fill(tree, renamed));
    }

    const variables = (type: string) => list.filter((each) => each.resolved === type).length;
    const ofStyle = (kind: string) => styles.filter((each) => each.kind === kind).length;
    const modeNames = [
        ...new Set(
            [...collections.values()].flatMap((each) => each.modes.map((mode) => mode.name)),
        ),
    ].filter((name) => name !== "");
    const layers = nodes.filter(
        (node) => !["VARIABLE", "VARIABLE_SET", "STYLE"].includes(String(node.type)),
    ).length;
    const images = decoded.entries.filter((entry) => entry.startsWith("images/")).length;
    const leftOut = [
        [seen - made, "variable"],
        [left, "style"],
    ] as const;
    const notes = [
        `Figma: read ${quoted(file, 60)}: ${plural(collections.size, "collection")}, ${withKinds(
            list.length,
            "variable",
            [
                [variables("COLOR"), "color"],
                [variables("FLOAT"), "number"],
                [variables("STRING"), "text"],
                [variables("BOOLEAN"), "switch"],
            ],
        )}, ${withKinds(styles.length, "style", [
            [ofStyle("TEXT"), "text"],
            [ofStyle("EFFECT"), "effect"],
            [ofStyle("FILL"), "paint"],
        ])}.`,
    ];

    if (modeNames.length > 0) {
        const more = modeNames.length > 6 ? ` and ${modeNames.length - 6} more` : "";

        notes.push(
            `Modes: ${modeNames
                .slice(0, 6)
                .map((name) => quoted(name, 60))
                .join(", ")}${more}${darkFirst ? " (dark first)" : ""}.`,
        );
    }

    notes.push(`Not imported: ${plural(layers, "layer")}, ${plural(images, "image")}.`);

    if (leftOut.some(([count]) => count > 0)) {
        notes.push(
            `Left out, as the token format cannot hold them: ${leftOut
                .filter(([count]) => count > 0)
                .map(([count, word]) => plural(count, word))
                .join(" and ")}.`,
        );
    }

    if (stop) {
        notes.push(`Stopped at the time limit (${FIG_TIME_MS} ms): ${progress.read} tokens read.`);
    }

    return {
        file,
        default: tokens,
        dark: dropTypes(fill(darkChanges, renamed)),
        extra,
        count: progress.read,
        partial: stop,
        line: notes.join(" ").slice(0, 1200),
    };
}

// A file that was not read may still hold tokens: the scan is partial, so resync does not call them gone.
function notRead(facts: Facts, file: string, why: string): void {
    facts.partial = true;

    if (facts.skipped.length < 40) {
        facts.skipped.push({ path: file, why });
    }
}

/** `until` is the deadline of all the scan's Figma files, not of this one. */
export function readFigInto(
    facts: Facts,
    file: string,
    path: string,
    until: number = Date.now() + FIG_TIME_MS,
): void {
    if (Date.now() >= until) {
        return notRead(facts, file, "was not read: the scan reached its limit for Figma files");
    }

    let tokens: FigTokens;

    try {
        const decoded = decodeFig(readFigBytes(path), { ...FIG_LIMITS, ms: FIG_TIME_MS }, until);

        tokens = figTokens(decoded, file, { until });
    } catch (error) {
        const reason =
            error instanceof FigError
                ? error.message
                : error instanceof Error
                  ? error.message.replace(/\s+/g, " ").slice(0, 160)
                  : "unknown";

        return notRead(facts, file, `could not be read: ${reason}`);
    }

    facts.partial ||= tokens.partial;
    facts.figs.push(tokens.line);
    facts.files.push(file);
    addFigImport(facts.imported, tokens);
}

// A `.fig` is sure to be a token source, so even a few tokens are used as they are.
function addFigImport(into: Imported, tokens: FigTokens): void {
    if (tokens.count > 0) {
        into.certain = true;
        addFound(into, { ...tokens, notes: [] }, tokens.count, [tokens.file]);
    }
}
