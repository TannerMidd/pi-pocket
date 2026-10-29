/**
 * Figma `.fig` files in the design system scan: the variables of the file's collections (the first mode of a collection is
 * the default, a mode named for dark is the dark mode, and each other mode becomes a mode of its own), the aliases between
 * them (a DTCG reference), and its text, effect, and paint styles, as a DTCG draft. A name that Figma nests with slashes
 * becomes a dotted path of safe slugs: "Colors/Brand/Primary" is `color.brand.primary`.
 *
 * The file's layers, components, and images are not imported, and the report says so. Everything read from the file is
 * untrusted project data: it reaches the report through the scan's fence, and nothing in it is run. A file that cannot be
 * read never throws out of the scan: it becomes a note.
 */
import { quoted } from "../fence.ts";
import { type Facts } from "./scan-facts.ts";
import { type FigDecoded, decodeFig, readFigBytes } from "./scan-fig-container.ts";
import { FIG_LIMITS, FigError } from "./scan-fig-kiwi.ts";
import {
    FONT_NAME,
    RESERVED,
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
import { type Imported, addTo } from "./scan-import.ts";
import { assemble, type Progress, dropTypes, hoistTypes, rewrite } from "./scan-tree.ts";
import { type Obj } from "./scan-util.ts";

/** The tokens of one `.fig`, and what the report says about it. */
export interface FigTokens {
    /** The file, relative to the scanned folder. */
    file: string;
    /** The default mode's tokens. */
    default: Obj;
    /** The values that the dark mode changes. */
    dark: Obj;
    /** The values that each other mode changes, by mode name. */
    extra: Record<string, Obj>;
    /** How many tokens were read. */
    count: number;
    /** What was read, what was not, and what was left out: one line for the report (untrusted text). */
    line: string;
}

// --- The report's counts --------------------------------------------------------------------------------------------

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A count with its breakdown, when there is one: `5 variables (4 colors, 1 number)`. */
function withKinds(count: number, word: string, kinds: [number, string][]): string {
    const shown = kinds.filter(([each]) => each > 0).map(([each, name]) => plural(each, name));

    return `${plural(count, word)}${shown.length === 0 ? "" : ` (${shown.join(", ")})`}`;
}

/** A mode's name as a mode name of the scan: lowercase letters, digits, and hyphens, and never a key of `Object`. */
function modeNameOf(name: string): string {
    const clean = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);

    return clean === "" ? "mode" : RESERVED.has(clean) ? `${clean}-mode` : clean;
}

const isDarkMode = (name: string): boolean => /(?:^|[^a-z])dark(?:[^a-z]|$)/i.test(name);

// --- The whole file -------------------------------------------------------------------------------------------------

/**
 * The most time the scan's Figma files may take in all: past it, a file is read in part, and the report says so. It is one
 * deadline for every file, and it is generous because a busy machine slows the clock many times over the work: a 274 KB file
 * of 108 variables costs about a second, and is never cut short by it.
 */
export const FIG_TIME_MS = 20_000;

/**
 * The tokens of a decoded `.fig`, and the line that the report gives for it. `until` is when the whole scan's Figma files must
 * end (milliseconds since the epoch); `ms` is a limit of that length from now, for a test that must reach it.
 */
export function figTokens(
    decoded: FigDecoded,
    file: string,
    options: { ms?: number; until?: number } = {},
): FigTokens {
    const limit = options.ms ?? FIG_TIME_MS;
    const deadline = options.until ?? Date.now() + limit;
    const nodes = decoded.nodes;
    const collections = collectionsOf(nodes);
    const { list, byKey } = variablesOf(nodes);
    const tally = {
        collections: collections.size,
        variables: list.length,
        colors: 0,
        numbers: 0,
        text: 0,
        switches: 0,
        typography: 0,
        shadows: 0,
        paints: 0,
        layers: 0,
        frames: 0,
        components: 0,
        instances: 0,
        missing: 0,
    };

    for (const node of nodes) {
        const type = typeof node.type === "string" ? node.type : "";

        if (type === "FRAME") {
            tally.frames += 1;
        } else if (type === "SYMBOL" || type === "COMPONENT" || type === "COMPONENT_SET") {
            tally.components += 1;
        } else if (type === "INSTANCE") {
            tally.instances += 1;
        }

        if (type !== "VARIABLE" && type !== "VARIABLE_SET" && type !== "STYLE") {
            tally.layers += 1;
        }
    }

    // The path of each variable first: an alias names another variable's path.
    const named = new Map<string, Named & { type: string }>();
    const taken = new Set<string>();
    const next = new Map<string, number>();
    const firstModes = new Set<string>();
    const firstOf = new Map<string, string>();
    const modeById = new Map<string, { id: string; name: string; collection: string }>();
    // A variable names its collection by guid, or by the collection's published key when the file comes from a library.
    const collectionOf = new Map<string, string>();

    // A mode is found by its id, so a variable costs its own few modes and not every mode of its collection.
    for (const collection of collections.values()) {
        const first = collection.modes[0];

        collectionOf.set(collection.id, collection.id);

        if (collection.key !== "") {
            collectionOf.set(collection.key, collection.id);
        }

        if (first !== undefined) {
            firstModes.add(modeNameOf(first.name));
            firstOf.set(collection.id, first.id);
        }

        for (const mode of collection.modes) {
            modeById.set(mode.id, { ...mode, collection: collection.id });
        }
    }

    let stopped = false;

    for (const variable of list) {
        if (Date.now() >= deadline) {
            stopped = true;

            break;
        }

        const kind =
            variable.resolved === "COLOR"
                ? "color"
                : variable.resolved === "FLOAT"
                  ? "number"
                  : "font";

        if (variable.resolved === "STRING") {
            tally.text += 1;
        } else if (variable.resolved === "BOOLEAN") {
            tally.switches += 1;
        }

        // A text variable is a font family when its name says so; the token format holds no other text, and no switch.
        if (
            variable.resolved !== "COLOR" &&
            variable.resolved !== "FLOAT" &&
            !(variable.resolved === "STRING" && FONT_NAME.test(variable.name))
        ) {
            continue;
        }

        const shape = nameFor(kind, variable.name);
        const path = uniquePath(safePath(shape), taken, next);

        named.set(variable.id, { ...shape, path, type: typeOf(variable, shape.measure) });
    }

    /** The id of the variable that an alias names, when the file holds it. */
    const aliasTarget = (target: string): string | undefined => {
        const id = byKey.get(target) ?? target;

        return named.has(id) ? id : named.has(target) ? target : undefined;
    };

    /** A variable's value in one mode, as a DTCG token. */
    const valueOf = (variable: FigVariable, mode: string): Obj | undefined => {
        const found = variable.values.get(mode);
        const shape = named.get(variable.id);

        if (found === undefined || shape === undefined) {
            return undefined;
        }

        if (found.kind === "alias") {
            const target = aliasTarget(found.target);
            const path = target === undefined ? undefined : named.get(target)?.path;

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
    };

    const entries: { path: string[]; node: Obj }[] = [];
    const changes = new Map<string, Map<string, Obj>>();
    const darkChanges = new Map<string, Obj>();
    let alias = 0;
    let sameAsDefault = 0;

    for (const variable of list) {
        const shape = named.get(variable.id);

        if (shape === undefined) {
            continue;
        }

        if (variable.resolved === "COLOR") {
            tally.colors += 1;
        } else if (variable.resolved === "FLOAT") {
            tally.numbers += 1;
        }

        const collection = collectionOf.get(variable.collection) ?? variable.collection;
        const first = firstOf.get(collection) ?? [...variable.values.keys()][0] ?? "";
        const value = valueOf(variable, first);

        if (value === undefined) {
            tally.missing += 1;

            continue;
        }

        entries.push({ path: shape.path, node: value });

        if (variable.values.get(first)?.kind === "alias") {
            alias += 1;
        }

        for (const modeId of variable.values.keys()) {
            const mode = modeId === first ? undefined : modeById.get(modeId);

            // A value in a mode of another collection is not a mode of this variable.
            if (mode === undefined || mode.collection !== collection) {
                continue;
            }

            const changed = valueOf(variable, modeId);

            if (changed === undefined || JSON.stringify(changed) === JSON.stringify(value)) {
                continue;
            }

            const name = modeNameOf(mode.name);

            if (isDarkMode(mode.name)) {
                darkChanges.set(shape.path.join("."), changed);

                continue;
            }

            // A mode named for the default mode's own name is that mode, and the engine refuses a file for it.
            if (firstModes.has(name)) {
                sameAsDefault += 1;

                continue;
            }

            const tree = changes.get(name) ?? new Map<string, Obj>();

            tree.set(shape.path.join("."), changed);
            changes.set(name, tree);
        }
    }

    // The styles: a text style is typography, an effect style a shadow, and a paint style a color.
    const { styles, left: styleLeft } = stylesOf(nodes);
    let stylesRead = 0;

    for (const style of styles) {
        if (Date.now() >= deadline) {
            stopped = true;

            break;
        }

        stylesRead += 1;
        entries.push({ path: uniquePath(safePath(style.path), taken, next), node: style.token });

        if (style.kind === "TEXT") {
            tally.typography += 1;
        } else if (style.kind === "EFFECT") {
            tally.shadows += 1;
        } else {
            tally.paints += 1;
        }
    }

    const renamed = new Map<string, string>();
    const progress: Progress = { until: deadline, read: 0, stopped: false };
    const tokens = rewrite(assemble(entries, renamed, progress), renamed) as Obj;

    // The deadline holds inside the assembly too: the loop above checks it, and so does the loop there.
    if (progress.stopped) {
        stopped = true;
    }

    const finalPath = (name: string) => (renamed.get(name) ?? name).split(".");

    /** A mode's tree, at the paths that the default mode ended with. */
    const fill = (from: Map<string, Obj>): Obj => {
        const out: Obj = {};

        for (const [name, node] of from) {
            const path = finalPath(name);
            let at = out;

            for (const key of path.slice(0, -1)) {
                at[key] ??= {};
                at = at[key] as Obj;
            }

            at[path.at(-1)!] = node;
        }

        return out;
    };

    const darkFirst =
        collections.size > 0 &&
        [...collections.values()].every((each) => isDarkMode(each.modes[0]?.name ?? ""));

    // A file whose default mode is dark names it, as the scan does for a dark-first project.
    if (darkFirst && Object.keys(tokens).length > 0) {
        tokens.$extensions = { "com.pi-pocket": { mode: "dark" } };
    }

    if (Object.keys(tokens).length > 0) {
        hoistTypes(tokens);
    }

    // No prototype: a mode's name is a key, and never a key of `Object` (`constructor`, `__proto__`).
    const extra: Record<string, Obj> = Object.create(null) as Record<string, Obj>;

    for (const [mode, tree] of changes) {
        extra[mode] = dropTypes(fill(tree));
    }

    const notes: string[] = [
        `Figma: read ${quoted(file, 60)}: ${plural(tally.collections, "collection")}, ${withKinds(
            tally.variables,
            "variable",
            [
                [tally.colors, "color"],
                [tally.numbers, "number"],
                [tally.text, "text"],
            ],
        )}, ${withKinds(tally.typography + tally.shadows + tally.paints, "style", [
            [tally.typography, "typography"],
            [tally.shadows, "shadow"],
            [tally.paints, "color"],
        ])}.`,
    ];
    const modeNames = [
        ...new Set(
            [...collections.values()].flatMap((each) => each.modes.map((mode) => mode.name)),
        ),
    ].filter((name) => name !== "");

    if (modeNames.length > 0) {
        const extraNames = Object.keys(extra);
        const dark = darkChanges.size > 0;

        notes.push(
            `Modes: ${modeNames
                .slice(0, 6)
                .map((name) => quoted(name, 60))
                .join(
                    ", ",
                )}${modeNames.length > 6 ? ", …" : ""}; the first mode of each collection is the default${dark ? ", and a mode named for dark is the dark mode" : ""}${extraNames.length === 0 ? "" : `; ${extraNames.join(", ")} ${extraNames.length === 1 ? "is a mode of its own" : "are modes of their own"}`}${darkFirst ? ". The file is dark first" : ""}.`,
        );
    }

    const images = decoded.entries.filter((entry) => entry.startsWith("images/")).length;
    const parts = [
        tally.frames === 0 ? "" : plural(tally.frames, "frame"),
        tally.components === 0 ? "" : plural(tally.components, "component"),
        tally.instances === 0 ? "" : plural(tally.instances, "instance"),
    ].filter((each) => each !== "");

    notes.push(
        `Not imported: ${plural(tally.layers, "layer")}${parts.length === 0 ? "" : ` (${parts.join(", ")})`} and ${images === 0 ? "no images" : plural(images, "image")}.`,
    );

    if (alias > 0) {
        notes.push(
            `${plural(alias, "token")} ${alias === 1 ? "is" : "are"} a reference to another variable of the file.`,
        );
    }

    const families = [...named.values()].filter((each) => each.type === "fontFamily").length;
    const leftOut = tally.text + tally.switches - families;

    if (leftOut > 0) {
        notes.push(
            `${plural(leftOut, "text or switch variable")} could not become a token: the token format has no text or switch type, and only a font's name makes a family.`,
        );
    }

    if (sameAsDefault > 0) {
        notes.push(
            `${plural(sameAsDefault, "mode value")} was left out: it belongs to a mode whose name is the default mode's name.`,
        );
    }

    if (tally.missing > 0) {
        notes.push(
            `${plural(tally.missing, "variable")} had no value in the default mode, or names a variable that this file does not hold, and so could not become a token.`,
        );
    }

    for (const [styleType, count] of styleLeft) {
        notes.push(
            `${plural(count, `${styleType} style`)} could not become a token (no solid color, or no shadow that the format holds).`,
        );
    }

    if (stopped) {
        notes.push(
            `Stopped at ${limit} ms, the scan's limit for its Figma files: ${progress.read} of ${plural(list.length, "variable")} and ${stylesRead} of ${plural(styles.length, "style")} were read.`,
        );
    }

    return {
        file,
        default: tokens,
        dark: dropTypes(fill(darkChanges)),
        extra,
        count: progress.read,
        line: notes.join(" ").slice(0, 1200),
    };
}

/**
 * Reads one `.fig` file into the scan's token source, with a line for the report; a file it cannot read is a note. `until` is
 * the deadline of every Figma file of the scan, not of this one: 4 files may not take 4 times the time.
 */
export function readFigInto(
    facts: Facts,
    file: string,
    path: string,
    until: number = Date.now() + FIG_TIME_MS,
): void {
    if (Date.now() >= until) {
        if (facts.skipped.length < 40) {
            facts.skipped.push({
                path: file,
                why: "was not read: the scan reached its limit for Figma files",
            });
        }

        return;
    }

    let tokens: FigTokens;

    try {
        // The reader's own limit is the scan's whole budget, so the reason it gives for its deadline is the true one.
        const limits = { ...FIG_LIMITS, ms: FIG_TIME_MS };

        tokens = figTokens(decodeFig(readFigBytes(path), limits, until), file, { until });
    } catch (error) {
        const reason =
            error instanceof FigError
                ? error.message
                : error instanceof Error
                  ? error.message.replace(/\s+/g, " ").slice(0, 160)
                  : "unknown";

        if (facts.skipped.length < 40) {
            facts.skipped.push({ path: file, why: `could not be read: ${reason}` });
        }

        return;
    }

    facts.figs.push(tokens.line);
    facts.files.push(file);
    addFigImport(facts.imported, tokens);
}

/**
 * A mode's tree in the scan's imports: an own key, even for a name that `Object` also has. A plain `into.extra["constructor"]`
 * would be `Object.constructor`, and the tree would be written into `Object` itself.
 */
function modeTree(extra: Record<string, Obj>, mode: string): Obj {
    if (!Object.hasOwn(extra, mode)) {
        Object.defineProperty(extra, mode, {
            value: {},
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }

    return extra[mode]!;
}

/**
 * Adds a `.fig`'s tokens to the scan's imports. A Figma file is sure to be a token source (unlike a JSON file, which may be
 * anything), so even a few tokens are used as they are rather than guessed from the project's CSS.
 */
export function addFigImport(into: Imported, tokens: FigTokens): void {
    if (tokens.count === 0) {
        return;
    }

    into.certain = true;
    addTo(into.default, tokens.default);
    addTo(into.dark, tokens.dark);

    for (const [mode, tree] of Object.entries(tokens.extra)) {
        addTo(modeTree(into.extra, mode), tree);
    }

    into.count += tokens.count;
    into.files.push(tokens.file);
}
