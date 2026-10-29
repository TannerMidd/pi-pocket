/**
 * The inference of the design system scan (stream T): turns the facts about a project into a DTCG draft. It keeps the
 * project's own variables (named by what they hold), decides the color roles, names a palette by hue and lightness, and
 * reads the type scale, the spacing scale, the radii, the shadows, and the motion from how the project uses them. The
 * draft is run through the tokens engine, and any token it rejects is dropped, so the result always loads.
 */
import { px } from "./scan-parse.ts";
import { type Category, type Facts } from "./scan-facts.ts";
import {
    Book,
    breakpointScale,
    detailScales,
    type Draft,
    fontScale,
    type Inferred,
    motionScale,
    radiusScale,
    shadowScale,
    sizeScale,
    spacingScale,
} from "./scan-scales.ts";
import { finishImports } from "./scan-import.ts";
import { applyMaterial } from "./scan-import-material.ts";
import { reviewScales } from "./scan-review.ts";
import { buildSystem } from "./tokens-model.ts";
import { chooseColorRoles, type InferContext } from "./scan-roles.ts";
import { paletteTokens } from "./scan-palette.ts";
import { kebab, type Obj, slug, vkey } from "./scan-util.ts";
import { type Variable } from "./scan-variables.ts";
import { assemble, dropTypes, hoistTypes, nameOf, nodeFor, pathOf, rewrite } from "./scan-tree.ts";
import { pageIsDark, prepare, resolveDeferred } from "./scan-prepare.ts";

export type { Draft, Inferred };

/** Runs the scan's inference. `folder` names the system. */
export function infer(facts: Facts, folder: string): Inferred {
    const result: Inferred = {
        draft: { tokens: {}, modes: {} },
        roles: {},
        palette: {},
        typeScale: { sizes: [] },
        fonts: {},
        spacing: { steps: [], off: [] },
        radii: [],
        shadows: 0,
        motion: { durations: [], easings: [] },
        breakpoints: [],
        hasDark: false,
        modes: { default: "light", alt: "dark" },
        notes: [],
        imported: 0,
        dropped: [],
        review: [],
        sources: [],
    };
    const meta = { $extensions: { "com.pi-pocket": { name: folder } } };

    // What each Figma `.fig` file gave, or why it could not be read: the report says so, before the roles it guessed.
    result.sources.push(...facts.figs);

    // A project that already keeps tokens in a token file: use them.
    finishImports(facts.imported);

    if (facts.imported.count >= 8 || (facts.imported.certain && facts.imported.count > 0)) {
        result.imported = facts.imported.count;
        result.draft = {
            tokens: { ...meta, ...(facts.imported.default as Obj) },
            modes: {
                ...(Object.keys(facts.imported.dark).length > 0
                    ? { dark: facts.imported.dark as Obj }
                    : {}),
                ...(facts.imported.extra as Record<string, Obj>),
            },
        };
        result.hasDark = Object.keys(facts.imported.dark).length > 0;
        result.notes.push(
            `Used the ${facts.imported.count} tokens from ${facts.imported.files.join(", ")} as they are; styles were not guessed.`,
            ...facts.imported.notes,
        );

        return validate(result);
    }

    let prep = prepare(facts, "dark");

    // A project whose default scope is dark and that names a light scope is dark first: light is its other mode.
    if (facts.vars.some((fact) => fact.scope === "light") && pageIsDark(prep, facts)) {
        prep = prepare(facts, "light");
    }

    const { classified, alt } = prep;

    resolveDeferred(facts, prep);

    result.modes =
        alt === "dark" ? { default: "light", alt: "dark" } : { default: "dark", alt: "light" };
    const book = new Book();
    const aliasOf = new Map<string, string[]>();
    const uses = (variable: Variable) =>
        (facts.varUse.get(variable.name) ?? 0) +
        (variable.kind === "theme" || variable.kind === "css"
            ? (facts.classUse.get(variable.name.replace(/^color-/, "")) ?? 0)
            : 0);

    const context: InferContext = { facts, prep, classified, alt, result, book, aliasOf, uses };

    // 2. Colors: the variables' values and the literal uses, merged; then the roles.
    // 3. The palette: scales the project names, then the role colors, then the colors it uses most.
    paletteTokens(context, chooseColorRoles(context));

    // 4. The other categories: the project's own variables first.
    const explicit = new Set<Category>();

    // A bare `--radius` has no name of its own: it takes the fallback after the variables that are named (`--radius-md`).
    const named = [
        ...classified.filter((entry) => nameOf(entry.variable, entry.category) !== ""),
        ...classified.filter((entry) => nameOf(entry.variable, entry.category) === ""),
    ];

    for (const entry of named) {
        if (entry.category === "color" || entry.light === undefined) {
            continue;
        }

        const node = nodeFor(entry.category, entry.light);
        let path = pathOf(entry.variable, entry.category);

        if (nameOf(entry.variable, entry.category) === "" && book.has(path)) {
            path = [path[0]!, "base"];

            // A second variable with no name of its own (`--gap` beside `$space`) keeps its own name.
            if (book.has(path)) {
                path = [path[0]!, slug(kebab(entry.variable.name))];
            }
        }

        if (node === undefined || book.has(path)) {
            continue;
        }

        book.add(path, node);
        explicit.add(entry.category);
        aliasOf.set(vkey(entry.variable), path);

        const dark =
            entry.dark === undefined || entry.dark === entry.light
                ? undefined
                : nodeFor(entry.category, entry.dark);

        if (dark !== undefined) {
            book.addDark(path, dark);
        }
    }

    // 5. What the project does not name, read from how it uses it.
    fontScale(facts, book, explicit, result);
    sizeScale(facts, book, explicit, result);
    detailScales(facts, book, explicit);
    spacingScale(facts, book, explicit, result);
    radiusScale(facts, book, explicit, result);
    shadowScale(facts, book, explicit, result);
    motionScale(facts, book, explicit, result);
    breakpointScale(facts, book, explicit, result);
    dedupeScales(book);
    result.review = reviewScales(facts, explicit, result);

    // 6. Assemble, add the contrast pairs, and keep only what the engine accepts.
    const renamed = new Map<string, string>();
    const tokens = assemble([...book.tokens.values()], renamed);
    const darkTree = assemble([...book.dark.values()], renamed);

    pair(tokens, ["color", "text", "primary"], "{color.bg.page}");
    pair(tokens, ["color", "text", "muted"], "{color.bg.page}");
    pair(tokens, ["color", "text", "on-accent"], "{color.accent.default}");
    hoistTypes(tokens);
    // A dark-first project names its default mode: the light mode is the file that changes it.
    const extension = alt === "light" ? { name: folder, mode: "dark" } : { name: folder };
    const other = dropTypes(rewrite(darkTree, renamed) as Obj);

    result.draft = {
        tokens: rewrite({ $extensions: { "com.pi-pocket": extension }, ...tokens }, renamed) as Obj,
        modes:
            Object.keys(darkTree).length > 0
                ? {
                      [alt]: {
                          $extensions: { "com.pi-pocket": { colorScheme: alt } },
                          ...other,
                      },
                  }
                : {},
    };

    return validate(
        facts.imported.material === undefined
            ? result
            : applyMaterial(result, facts.imported.material),
    );
}

/**
 * Two names for one size (`radius.lg` and `radius.base`, both 8px) are one step of the scale: the plainer name stays, and
 * the `base` that only names where a scale starts goes.
 */
function dedupeScales(book: Book): void {
    for (const group of ["text", "space", "radius", "breakpoint"]) {
        const seen = new Map<number, string>();

        for (const [key, entry] of [...book.tokens]) {
            const size = entry.path[0] === group ? px(String(entry.node.$value)) : undefined;

            if (size === undefined || size === 0) {
                continue;
            }

            const known = seen.get(size);

            if (known === undefined) {
                seen.set(size, key);

                continue;
            }

            const drop = book.tokens.get(known)!.path.at(-1) === "base" ? known : key;

            book.tokens.delete(drop);
            book.dark.delete(drop);
            seen.set(size, drop === known ? key : known);
        }
    }
}

/** Adds a contrast pair to a token of the tree, if both exist. */
function pair(tree: Obj, path: string[], on: string): void {
    let node: unknown = tree;

    for (const key of path) {
        node = typeof node === "object" && node !== null ? (node as Obj)[key] : undefined;
    }

    if (typeof node !== "object" || node === null || !("$value" in node)) {
        return;
    }

    const target = on.slice(1, -1).split(".");
    let found: unknown = tree;

    for (const key of target) {
        found = typeof found === "object" && found !== null ? (found as Obj)[key] : undefined;
    }

    if (typeof found === "object" && found !== null && "$value" in found) {
        (node as Obj).$extensions = { "com.pi-pocket": { contrast: { on, min: 4.5 } } };
    }
}

// --- Validation ----------------------------------------------------------------------------------------------------

/** Runs the draft through the tokens engine; a token it refuses is dropped, so the result always loads. */
function validate(result: Inferred): Inferred {
    for (let pass = 0; pass < 4; pass++) {
        const system = buildSystem({
            folder: "draft",
            tokens: result.draft.tokens,
            modes: new Map(Object.entries(result.draft.modes)),
            components: new Map(),
            guidelines: "",
            problems: [],
        });
        const bad = new Set(
            system.problems
                .filter((problem) => problem.level === "error" && problem.token !== undefined)
                .map((problem) => problem.token!),
        );

        if (bad.size === 0) {
            break;
        }

        for (const name of bad) {
            result.dropped.push(name);
            remove(result.draft.tokens, name.split("."));

            for (const mode of Object.values(result.draft.modes)) {
                remove(mode, name.split("."));
            }
        }
    }

    return result;
}

function remove(tree: Obj, path: string[]): void {
    const chain: Obj[] = [tree];
    let node = tree;

    for (const key of path.slice(0, -1)) {
        const child = node[key];

        if (typeof child !== "object" || child === null) {
            return;
        }

        node = child as Obj;
        chain.push(node);
    }

    delete node[path.at(-1)!];

    for (let at = chain.length - 1; at > 0; at--) {
        if (Object.keys(chain[at]!).filter((key) => !key.startsWith("$")).length > 0) {
            break;
        }

        delete chain[at - 1]![path[at - 1]!];
    }
}
