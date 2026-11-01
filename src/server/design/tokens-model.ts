import { contrastRatio, parseColor, toHex } from "./color.ts";
import { parseComponent } from "./components.ts";
import type {
    DesignSystem,
    ModeValue,
    ResolvedToken,
    SystemProblem,
    TokenTier,
} from "./system-types.ts";
import {
    LIMITS,
    MODE_NAME,
    clip,
    extensionOf,
    isObject,
    plain,
    type Obj,
    type RawSystem,
} from "./tokens-base.ts";
import {
    checkContrast,
    warnDeprecatedUses,
    warnRampOrder,
    warnRawSemanticColors,
    warnValueNamedTokens,
} from "./tokens-model-checks.ts";
import { collectDefinitions, collectModes, type Def } from "./tokens-model-defs.ts";
import { Report } from "./tokens-model-report.ts";
import { assignTypes, resolveModes } from "./tokens-model-resolve.ts";
import { compileDesignSystem } from "./tokens-compile.ts";
import { inferType, wholeRef, type Out } from "./tokens-values.ts";

export { inferType };

type Results = Map<string, Map<string, Out | null>>;

const TIER_GROUPS: Record<string, TokenTier> = {
    primitive: "primitive",
    primitives: "primitive",
    core: "primitive",
    base: "primitive",
    global: "primitive",
    palette: "primitive",
    ref: "primitive",
    reference: "primitive",
    semantic: "semantic",
    sys: "semantic",
    system: "semantic",
    alias: "semantic",
    role: "semantic",
    roles: "semantic",
    theme: "semantic",
    component: "component",
    components: "component",
    comp: "component",
};

/** Path segments that name what a value is for, not which value it is. */
const ROLE_WORDS = new Set([
    "bg",
    "background",
    "surface",
    "text",
    "fg",
    "foreground",
    "border",
    "accent",
    "primary",
    "secondary",
    "danger",
    "success",
    "warning",
    "error",
    "info",
    "muted",
    "on",
    "focus",
    "ring",
    "overlay",
    "link",
    "brand",
    "body",
    "heading",
    "display",
    "default",
]);

function schemeOf(mode: string, declared: unknown): "light" | "dark" | undefined {
    if (declared === "light" || declared === "dark") {
        return declared;
    }

    if (/(^|-)dark($|-)/.test(mode)) {
        return "dark";
    }

    return /(^|-)light($|-)/.test(mode) ? "light" : undefined;
}

function readRoot(
    raw: RawSystem,
    report: Report,
): { rootExt: Obj; name: string; description?: string; defaultMode: string } {
    const root = isObject(raw.tokens) ? raw.tokens : undefined;
    const rootExt = root === undefined ? {} : extensionOf(root);
    const name =
        typeof rootExt.name === "string" && plain(rootExt.name) !== ""
            ? plain(rootExt.name).slice(0, 80)
            : raw.folder;
    const description =
        root !== undefined && typeof root.$description === "string"
            ? plain(root.$description).slice(0, 300)
            : undefined;
    let defaultMode = "light";

    if (typeof rootExt.mode === "string") {
        if (MODE_NAME.test(rootExt.mode)) {
            defaultMode = rootExt.mode;
        } else {
            report.error(
                `The default mode "${clip(rootExt.mode, 30)}" must be a lowercase name such as "light".`,
                "tokens.json",
            );
        }
    }

    return {
        rootExt,
        name,
        ...(description === undefined ? {} : { description }),
        defaultMode,
    };
}

function colorSchemes(
    modes: string[],
    declaredOf: (mode: string) => unknown,
    defs: Map<string, Def>,
    results: Results,
): Record<string, "light" | "dark"> {
    const schemes: Record<string, "light" | "dark"> = {};
    const page = [...defs.values()].find(
        (def) =>
            def.type === "color" &&
            /^(?:color\.)?(?:bg|background)(?:\.(?:page|default|base|canvas))?$/.test(def.name),
    );

    for (const mode of modes) {
        const declared = schemeOf(mode, declaredOf(mode));
        const hex = page === undefined ? undefined : results.get(mode)?.get(page.name)?.literal;
        const rgba = hex === undefined ? undefined : parseColor(hex);

        schemes[mode] =
            declared ??
            (rgba !== undefined &&
            rgba.a > 0 &&
            contrastRatio({ r: 1, g: 1, b: 1, a: 1 }, rgba) >
                contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, rgba)
                ? "dark"
                : "light");
    }

    return schemes;
}

function parseComponents(
    raw: RawSystem,
    defs: Map<string, Def>,
    byVar: Map<string, string>,
    report: Report,
): DesignSystem["components"] {
    const known = {
        byVar,
        names: new Set(defs.keys()),
    };
    const components: DesignSystem["components"] = [];

    if (raw.components.size > LIMITS.components) {
        report.error(
            `There are more than ${LIMITS.components} components; the rest are ignored.`,
            "components",
        );
    }

    for (const [slug, html] of [...raw.components]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(0, LIMITS.components)) {
        const parsed = parseComponent(slug, html, known);

        for (const problem of parsed.problems) {
            report.add(problem.level, problem.message, problem.file, problem.token);
        }

        if (parsed.spec !== undefined) {
            components.push(parsed.spec);
        }
    }

    return components;
}

function modeValues(
    def: Def,
    modes: string[],
    results: Results,
): Record<string, ModeValue> | undefined {
    const values: Record<string, ModeValue> = {};

    for (const mode of modes) {
        const out = results.get(mode)!.get(def.name);

        if (out === null || out === undefined) {
            return undefined;
        }

        const rgba = def.type === "color" ? parseColor(out.literal) : undefined;
        const entry: ModeValue = { value: out.value, css: out.css, literal: out.literal };

        if (rgba !== undefined) {
            entry.hex = toHex(rgba);
        }

        if (out.parts !== undefined) {
            entry.parts = out.parts;
        }

        if (out.alias !== undefined) {
            entry.alias = out.alias;
        }

        values[mode] = entry;
    }

    return values;
}

function tierOf(def: Def, componentSlugs: Set<string>): TokenTier {
    const ext = def.base.ext;
    const first = def.path[0]!.toLowerCase();

    if (ext.tier === "primitive" || ext.tier === "semantic" || ext.tier === "component") {
        return ext.tier;
    }

    if (TIER_GROUPS[first] !== undefined) {
        return TIER_GROUPS[first]!;
    }

    if (componentSlugs.has(first)) {
        return "component";
    }

    if (wholeRef(def.base.value) !== undefined) {
        return "semantic";
    }

    if (/^\d+$/.test(def.path.at(-1)!)) {
        return "primitive";
    }

    return def.path.some((each) => ROLE_WORDS.has(each.toLowerCase())) ? "semantic" : "primitive";
}

function resolvedTokens(
    defs: Map<string, Def>,
    modes: string[],
    results: Results,
    componentSlugs: Set<string>,
): ResolvedToken[] {
    const tokens: ResolvedToken[] = [];

    for (const def of defs.values()) {
        if (def.type === undefined) {
            continue;
        }

        const values = modeValues(def, modes, results);

        // A token that failed in a mode is left out; its problem is in the report.
        if (values === undefined) {
            continue;
        }

        const ext = def.base.ext;
        const token: ResolvedToken = {
            path: def.path,
            name: def.name,
            cssVar: def.cssVar,
            type: def.type,
            tier: tierOf(def, componentSlugs),
            modes: values,
        };

        if (def.base.description !== undefined) {
            token.description = def.base.description;
        }

        if (def.base.deprecated !== undefined && def.base.deprecated !== false) {
            token.deprecated = def.base.deprecated;
        }

        if (typeof ext.tailwind === "string" && /^--[\w-]+$/.test(ext.tailwind)) {
            token.tailwind = ext.tailwind;
        }

        tokens.push(token);
    }

    return tokens;
}

function modeOverrides(
    modes: string[],
    tokens: ResolvedToken[],
    defs: Map<string, Def>,
): Record<string, string[]> {
    const overrides: Record<string, string[]> = {};

    for (const mode of modes.slice(1)) {
        overrides[mode] = tokens
            .filter((token) => defs.get(token.name)?.over.has(mode) === true)
            .map((token) => token.name);
    }

    return overrides;
}

// `"tailwindReset": ["color"]` (or `true`, which is color) clears Tailwind's defaults of those namespaces.
function tailwindResetOf(resetOf: unknown): string[] {
    return [
        ...new Set(
            (resetOf === true
                ? ["color"]
                : Array.isArray(resetOf)
                  ? resetOf
                  : typeof resetOf === "string"
                    ? [resetOf]
                    : []
            ).filter(
                (each): each is string =>
                    typeof each === "string" &&
                    [
                        "color",
                        "font",
                        "text",
                        "font-weight",
                        "spacing",
                        "radius",
                        "shadow",
                        "ease",
                        "breakpoint",
                        "all",
                    ].includes(each),
            ),
        ),
    ];
}

// `"format": "2025.10"` writes the object forms of the DTCG 2025.10 draft in the per-mode files.
function dtcgFormatOf(formatOf: unknown, report: Report): "2021" | "2025.10" | undefined {
    if (formatOf === undefined) {
        return undefined;
    }

    const text = String(formatOf).trim();

    if (/^2025(?:[.-]10)?$/.test(text)) {
        return "2025.10";
    }

    if (/^2021(?:[.-]\d+)?$/.test(text)) {
        return "2021";
    }

    report.warn(
        `The format "${clip(text, 30)}" in tokens.json is not "2021" or "2025.10"; the default, "2021", is used.`,
        "tokens.json",
    );

    return undefined;
}

function copyProblems(problems: SystemProblem[], report: Report): void {
    for (const problem of problems) {
        report.add(problem.level, problem.message, problem.file, problem.token, problem.fix);
    }
}

export function buildSystem(raw: RawSystem): DesignSystem {
    const report = new Report();
    // Typo suggestions are optional: the edit-distance work of one load is bounded (a few tenths of a second at most).
    const suggestionBudget = { remaining: 20_000_000 };

    copyProblems(raw.problems, report);

    const { rootExt, name, description, defaultMode } = readRoot(raw, report);
    const { defs, byVar } = collectDefinitions(raw, report);
    const { modes, modeMeta } = collectModes(raw, defaultMode, defs, report, suggestionBudget);

    assignTypes(defs, report);

    const results = resolveModes(modes, defs, report, suggestionBudget);
    const schemes = colorSchemes(
        modes,
        (mode) => (mode === defaultMode ? rootExt.colorScheme : modeMeta.get(mode)),
        defs,
        results,
    );
    // The components are parsed before the tiers, which use their names.
    const components = parseComponents(raw, defs, byVar, report);
    const componentSlugs = new Set(components.map((component) => component.slug));
    const tokens = resolvedTokens(defs, modes, results, componentSlugs);

    warnValueNamedTokens(tokens, modes, report);
    warnRampOrder(tokens, modes, report);
    warnRawSemanticColors(tokens, defs, report);
    checkContrast(tokens, defs, modes, schemes, report);
    warnDeprecatedUses(tokens, report);

    const overrides = modeOverrides(modes, tokens, defs);
    const tailwindReset = tailwindResetOf(rootExt.tailwindReset);
    const dtcgFormat = dtcgFormatOf(rootExt.format, report);
    const system: Omit<DesignSystem, "compiled" | "problems"> = {
        name,
        modes,
        schemes,
        tokens,
        overrides,
        ...(tailwindReset.length === 0 ? {} : { tailwindReset }),
        ...(dtcgFormat === undefined ? {} : { dtcgFormat }),
        components,
        guidelines: raw.guidelines,
    };

    if (description !== undefined) {
        system.description = description;
    }

    const compiled = compileDesignSystem(system);

    return {
        ...system,
        problems: report.done(),
        ...(report.notes.length === 0 ? {} : { notes: report.notes }),
        compiled,
    };
}
