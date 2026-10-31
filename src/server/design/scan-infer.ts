import { px } from "./scan-parse.ts";
import type { Category, Facts } from "./scan-facts.ts";
import {
    Book,
    breakpointScale,
    type Draft,
    fontScale,
    type Inferred,
    radiusScale,
    shadowScale,
    sizeScale,
    spacingScale,
} from "./scan-scales.ts";
import { finishImports } from "./scan-import.ts";
import { buildSystem } from "./tokens-model.ts";
import { chooseColorRoles, type InferContext } from "./scan-roles.ts";
import { paletteTokens } from "./scan-palette.ts";
import { kebab, type Obj, slug, vkey } from "./scan-colors.ts";
import type { Variable } from "./scan-variables.ts";
import { assemble, dropTypes, hoistTypes, nameOf, nodeFor, pathOf, rewrite } from "./scan-tree.ts";
import { pageIsDark, prepare, resolveDeferred } from "./scan-prepare.ts";

export type { Draft, Inferred };

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
        breakpoints: [],
        hasDark: false,
        modes: { default: "light", alt: "dark" },
        notes: [],
        imported: 0,
        dropped: [],
        review: [],
        sources: [],
    };
    const { imported } = facts;

    finishImports(imported);

    if (imported.count >= 8 || (imported.certain && imported.count > 0)) {
        result.imported = imported.count;
        result.hasDark = Object.keys(imported.dark).length > 0;

        const meta = { $extensions: { "com.pi-pocket": { name: folder } } };

        result.draft = {
            tokens: { ...meta, ...(imported.default as Obj) },
            modes: {
                ...(result.hasDark ? { dark: imported.dark as Obj } : {}),
                ...(imported.extra as Record<string, Obj>),
            },
        };
        result.notes.push(
            `Used the ${imported.count} tokens from ${imported.files.join(", ")} as they are; styles were not guessed.`,
            ...imported.notes,
        );

        return validate(result);
    }

    let prep = prepare(facts, "dark");

    // A project whose default scope is dark and that names a light scope is dark first.
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

    paletteTokens(context, chooseColorRoles(context));

    const explicit = new Set<Category>();

    // A bare `--radius` takes the fallback name only after the named variables (`--radius-md`).
    const bare = (entry: (typeof classified)[number]) =>
        nameOf(entry.variable, entry.category) === "";

    for (const entry of [...classified.filter((each) => !bare(each)), ...classified.filter(bare)]) {
        if (entry.category === "color" || entry.light === undefined) {
            continue;
        }

        const node = nodeFor(entry.category, entry.light);
        let path = pathOf(entry.variable, entry.category);

        if (bare(entry) && book.has(path)) {
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

    fontScale(facts, book, explicit, result);
    sizeScale(facts, book, explicit, result);
    spacingScale(facts, book, explicit, result);
    radiusScale(facts, book, explicit, result);
    shadowScale(facts, book, result);
    breakpointScale(facts, book, explicit, result);
    dedupeScales(book);
    result.review = reviewScales(facts, explicit, result);

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
    const scheme = { $extensions: { "com.pi-pocket": { colorScheme: alt } } };

    result.draft = {
        tokens: rewrite({ $extensions: { "com.pi-pocket": extension }, ...tokens }, renamed) as Obj,
        modes: Object.keys(darkTree).length > 0 ? { [alt]: { ...scheme, ...other } } : {},
    };

    return validate(result);
}

// Two names for one size are one step: the first stays, unless it is a `base`.
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

function lookup(tree: Obj, path: string[]): unknown {
    let node: unknown = tree;

    for (const key of path) {
        node = typeof node === "object" && node !== null ? (node as Obj)[key] : undefined;
    }

    return node;
}

const isToken = (node: unknown): node is Obj =>
    typeof node === "object" && node !== null && "$value" in node;

function pair(tree: Obj, path: string[], on: string): void {
    const node = lookup(tree, path);

    if (isToken(node) && isToken(lookup(tree, on.slice(1, -1).split(".")))) {
        node.$extensions = { "com.pi-pocket": { contrast: { on, min: 4.5 } } };
    }
}

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

const total = (map: Map<unknown, number | { count: number }>): number =>
    [...map.values()].reduce<number>(
        (sum, value) => sum + (typeof value === "number" ? value : value.count),
        0,
    );

const counted = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function reviewScales(facts: Facts, explicit: Set<Category>, result: Inferred): string[] {
    const lines: string[] = [];

    const guess = (category: Category, label: string, distinct: number, uses: number) => {
        if (!explicit.has(category) && distinct > 0 && (distinct < 3 || uses < 4)) {
            lines.push(
                `${label} (guessed from use: ${counted(distinct, "value")}, ${counted(uses, "use")})`,
            );
        }
    };

    guess("text", "type scale", result.typeScale.sizes.length, total(facts.sizes));
    guess("space", "spacing", result.spacing.steps.length, total(facts.spacing));
    guess("radius", "radii", result.radii.length, total(facts.radii));
    guess("shadow", "shadows", result.shadows, total(facts.shadows));
    guess("font", "fonts", Object.keys(result.fonts).length, total(facts.fonts));

    const off = result.spacing.off;

    // spacingScale keeps at most 6 off-grid values.
    if (off.length > 0) {
        lines.push(
            `spacing (${counted(off.length, "value")} fit no step of the ${result.spacing.base ?? 4}px grid: ${off.map((size) => `${size}px`).join(", ")})`,
        );
    }

    return lines;
}
