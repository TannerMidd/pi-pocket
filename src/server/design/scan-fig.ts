// Everything read from a `.fig` is untrusted: it reaches the report only through the scan's fence.
import { quoted } from "../fence.ts";
import { type Facts } from "./scan-facts.ts";
import { type FigDecoded, decodeFig, readFigBytes } from "./scan-fig-container.ts";
import { FIG_LIMITS, FigError } from "./scan-fig-kiwi.ts";
import {
    type Collection,
    FONT_NAME,
    type FigValue,
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
import { LIMITS as TOKEN_LIMITS } from "./scan-import-eval.ts";
import { assemble, type Progress, dropTypes, hoistTypes, rewrite } from "./scan-tree.ts";
import { type Obj } from "./scan-colors.ts";
import { LIMITS as SYSTEM, RESERVED } from "./tokens-base.ts";

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

// One deadline for all the scan's Figma files. It is generous: a busy machine slows the clock,
// not the work, and the 274 KB fixture takes about a second.
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
        .slice(0, 40)
        .replace(/^-+|-+$/g, "");

    return clean === "" ? "mode" : RESERVED.has(clean) ? `${clean}-mode` : clean;
}

const isNamed = (name: string, word: string): boolean =>
    new RegExp(`(?:^|[^a-z])${word}(?:[^a-z]|$)`, "i").test(name);
const isDarkMode = (name: string): boolean => isNamed(name, "dark");

// A collection's default is its mode named just Light (Dark when the file is dark first), or else
// its first; in a light first file, a collection that starts dark takes its first named with light.
// Its dark mode is the one named just Dark, or else its first named with dark: another (Dark high
// contrast) is a mode of its own. A name used twice in a collection gets a number.
function modesOf(collections: Map<string, Collection>, darkFirst: boolean) {
    // A variable names its collection by guid, or by its published key in a library file.
    const collectionOf = new Map<string, string>();
    const baseOf = new Map<string, string>();
    const byId = new Map<string, { name: string; collection: string }>();
    // A collection's modes by the name they take: an alias across collections reads the target's
    // mode of the same name.
    const named = new Map<string, Map<string, string>>();
    const home = darkFirst ? "dark" : "light";

    for (const collection of collections.values()) {
        const first = collection.modes[0];
        const base =
            collection.modes.find((mode) => modeNameOf(mode.name) === home) ??
            (!darkFirst && isDarkMode(first?.name ?? "")
                ? collection.modes.find((mode) => isNamed(mode.name, "light"))
                : undefined) ??
            first;
        const others = collection.modes.filter((mode) => mode !== base);
        const dark = darkFirst
            ? undefined
            : (others.find((mode) => modeNameOf(mode.name) === "dark") ??
              others.find((mode) => isDarkMode(mode.name)));
        const taken = new Set([home, "dark"]);
        const names = new Map<string, string>();

        collectionOf.set(collection.id, collection.id);

        if (collection.key !== "") {
            collectionOf.set(collection.key, collection.id);
        }

        if (base !== undefined) {
            baseOf.set(collection.id, base.id);
        }

        for (const mode of others) {
            let name = mode === dark ? "dark" : modeNameOf(mode.name);

            for (let index = 2; mode !== dark && taken.has(name); index += 1) {
                name = `${modeNameOf(mode.name)}-${index}`;
            }

            taken.add(name);
            names.set(name, mode.id);
            byId.set(mode.id, { name, collection: collection.id });
        }

        named.set(collection.id, names);
    }

    return { collectionOf, baseOf, byId, named };
}

interface Lookup {
    named: Map<string, Shaped>;
    byKey: Map<string, string>;
    byId: Map<string, FigVariable>;
    /** The name a mode takes in the tokens; none for a collection's default mode. */
    nameOf: (mode: string) => string | undefined;
    /** The mode of a variable that the tokens' mode `name` reads: that mode, or its default. */
    modeIn: (variable: FigVariable, name: string | undefined) => string;
}

// A copy reads each variable on the way in the tokens' mode `name`, as the engine reads a
// reference: a collection without that mode, on the way or at the start, reads its default.
function literalOf(
    variable: FigVariable,
    mode: string,
    name: string | undefined,
    look: Lookup,
    depth = 0,
): FigValue | undefined {
    const found = variable.values.get(mode);

    if (found?.kind !== "alias") {
        return found;
    }

    const target = look.byId.get(look.byKey.get(found.target) ?? found.target);

    return target === undefined || depth >= 8
        ? undefined
        : literalOf(target, look.modeIn(target, name), name, look, depth + 1);
}

function valueOf(
    variable: FigVariable,
    mode: string,
    look: Lookup,
    name = look.nameOf(mode),
): Obj | undefined {
    let found = variable.values.get(mode);
    const shape = look.named.get(variable.id);

    if (found === undefined || shape === undefined) {
        return undefined;
    }

    if (found.kind === "alias") {
        const target =
            look.named.get(look.byKey.get(found.target) ?? found.target) ??
            look.named.get(found.target);

        if (target === undefined) {
            return undefined;
        }

        if (target.type === shape.type) {
            return { $value: `{${target.path.join(".")}}`, $type: shape.type };
        }

        // The engine refuses an alias to another type (a spacing to a number): copy the value.
        found = literalOf(variable, mode, name, look);
    }

    if (found === undefined) {
        return undefined;
    }

    const value =
        found.kind === "color"
            ? found.value
            : found.kind === "number"
              ? numberValue(found.value, shape.measure)
              : found.kind === "text" && shape.type === "fontFamily"
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

        at[path.at(-1)!] = rewrite(node, renamed) as Obj;
    }

    return out;
}

/** `until`: the deadline of all the scan's Figma files; `max`: the tokens left in the budget. */
export function figTokens(
    decoded: FigDecoded,
    file: string,
    options: { until?: number; max?: number } = {},
): FigTokens {
    const until = options.until ?? Date.now() + FIG_TIME_MS;
    const max = options.max ?? TOKEN_LIMITS.tokens;
    const { nodes } = decoded;
    const collections = collectionsOf(nodes);
    // Only a collection with a dark mode chooses the default: a spacing collection has no theme.
    const themed = [...collections.values()].filter((each) =>
        each.modes.some((mode) => isDarkMode(mode.name)),
    );
    const darkFirst =
        themed.length > 0 && themed.every((each) => isDarkMode(each.modes[0]?.name ?? ""));
    const modes = modesOf(collections, darkFirst);

    const { list, byKey } = variablesOf(nodes);
    const named = new Map<string, Shaped>();
    const taken = new Set<string>();
    const next = new Map<string, number>();
    let stop: "time" | "tokens" | undefined;
    let seen = 0;

    // Every path first: an alias names another variable's path.
    for (const variable of list) {
        const { resolved } = variable;
        const token =
            resolved === "COLOR" ||
            resolved === "FLOAT" ||
            (resolved === "STRING" && FONT_NAME.test(variable.name));

        const late = Date.now() >= until;

        if (late || (token && named.size >= max)) {
            stop = late ? "time" : "tokens";

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

    const baseIn = (variable: FigVariable) =>
        modes.baseOf.get(modes.collectionOf.get(variable.collection) ?? variable.collection) ??
        [...variable.values.keys()][0] ??
        "";
    const look: Lookup = {
        named,
        byKey,
        byId: new Map(list.map((each) => [each.id, each])),
        nameOf: (mode) => modes.byId.get(mode)?.name,
        modeIn: (variable, name) => {
            const collection = modes.collectionOf.get(variable.collection) ?? variable.collection;
            const same = name === undefined ? undefined : modes.named.get(collection)?.get(name);

            return same !== undefined && variable.values.has(same) ? same : baseIn(variable);
        },
    };
    const entries: { path: string[]; node: Obj }[] = [];
    const changes = new Map<string, Map<string, Obj>>();
    // The values that read another variable, which can change in a mode their collection has not.
    const reads: { variable: FigVariable; path: string; value: Obj }[] = [];

    for (const variable of list) {
        const shape = named.get(variable.id);

        if (shape === undefined) {
            continue;
        }

        const collection = modes.collectionOf.get(variable.collection) ?? variable.collection;
        const base = baseIn(variable);
        const value = valueOf(variable, base, look);

        if (value === undefined) {
            continue;
        }

        entries.push({ path: shape.path, node: value });

        if (variable.values.get(base)?.kind === "alias") {
            reads.push({ variable, path: shape.path.join("."), value });
        }

        for (const modeId of variable.values.keys()) {
            const mode = modeId === base ? undefined : modes.byId.get(modeId);

            if (mode === undefined || mode.collection !== collection) {
                continue;
            }

            const changed = valueOf(variable, modeId, look);

            if (changed === undefined || JSON.stringify(changed) === JSON.stringify(value)) {
                continue;
            }

            const tree = changes.get(mode.name) ?? new Map<string, Obj>();

            tree.set(shape.path.join("."), changed);
            changes.set(mode.name, tree);
        }
    }

    const made = entries.length;
    const { styles, left } = stylesOf(nodes);

    for (const style of styles) {
        stop ??= Date.now() >= until ? "time" : entries.length >= max ? "tokens" : undefined;

        if (stop !== undefined) {
            break;
        }

        entries.push({ path: uniquePath(safePath(style.path), taken, next), node: style.token });
    }

    const renamed = new Map<string, string>();
    const progress: Progress = { until, read: 0, stopped: false };
    const tokens = rewrite(assemble(entries, renamed, progress), renamed) as Obj;

    stop ??= progress.stopped ? "time" : undefined;

    if (darkFirst && Object.keys(tokens).length > 0) {
        tokens.$extensions = { "com.pi-pocket": { mode: "dark" } };
    }

    if (Object.keys(tokens).length > 0) {
        hoistTypes(tokens);
    }

    // No prototype: a mode's name is a key, and never a key of `Object`.
    const extra: Record<string, Obj> = Object.create(null) as Record<string, Obj>;

    // The engine holds 16 modes beside the default: the dark mode first, then the others as found.
    const kept = [...changes]
        .sort(([a], [b]) => Number(b === "dark") - Number(a === "dark"))
        .slice(0, SYSTEM.modes);

    // A reference changes in each mode of what it reads, and so does a copy (`literalOf`).
    for (const { variable, path, value } of reads) {
        for (const [mode, tree] of kept) {
            const changed = tree.has(path)
                ? undefined
                : valueOf(variable, look.modeIn(variable, mode), look, mode);

            if (changed !== undefined && JSON.stringify(changed) !== JSON.stringify(value)) {
                tree.set(path, changed);
            }
        }
    }

    for (const [mode, tree] of kept) {
        if (mode !== "dark") {
            extra[mode] = dropTypes(fill(tree, renamed));
        }
    }

    const variables = (type: string) => list.filter((each) => each.resolved === type).length;
    const ofStyle = (kind: string) => styles.filter((each) => each.kind === kind).length;
    const modeNames = [
        ...new Set(
            [...collections.values()].flatMap((each) => each.modes.map((mode) => mode.name)),
        ),
    ].filter((name) => name !== "");
    const layers = nodes.filter(
        (node) => !["VARIABLE", "VARIABLE_SET", "STYLE"].includes(node.type as string),
    ).length;
    const images = decoded.entries.filter((entry) => entry.startsWith("images/")).length;
    const leftOut = [
        [seen - made, "variable"],
        [left, "style"],
        [changes.size - kept.length, "mode"],
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

    if (stop !== undefined) {
        const limit =
            stop === "time"
                ? `the time limit (${FIG_TIME_MS} ms)`
                : `${TOKEN_LIMITS.tokens} tokens`;

        notes.push(`Stopped at ${limit}: ${progress.read} tokens read.`);
    }

    return {
        file,
        default: tokens,
        dark: dropTypes(fill(changes.get("dark") ?? new Map(), renamed)),
        extra,
        count: progress.read,
        partial: stop !== undefined,
        line: notes.join(" ").slice(0, 1200),
    };
}

// A file not read may still hold tokens: the scan is partial, so resync does not call them gone.
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

        tokens = figTokens(decoded, file, {
            until,
            max: TOKEN_LIMITS.tokens - facts.imported.count,
        });
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
