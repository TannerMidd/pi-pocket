// A pure function of the resolved tokens: the same system always gives the same bytes.
// A mode block repeats every token whose value differs from the default, the tokens that only refer to a changed one included:
// a custom property that holds `var(--x)` is computed where it is declared, so a nested `[data-theme]` scope must declare it again to see the new `--x`.
import type { CompiledFiles, DesignSystem, ResolvedToken, TokenTier } from "./system-types.ts";
import { compactJson, dtcgJson, studioJson } from "./tokens-dtcg.ts";
import { namesMarkdown } from "./tokens-names.ts";
import { tailwindNames } from "./tokens-tailwind.ts";

export { scaleOf, tailwindNames, type Scale } from "./tokens-tailwind.ts";

export type CompileInput = Pick<
    DesignSystem,
    | "name"
    | "description"
    | "modes"
    | "schemes"
    | "tokens"
    | "components"
    | "tailwindReset"
    | "dtcgFormat"
>;

type Decl = [property: string, value: string];

const comment = (text: string, max = 90) => {
    const line = text.replace(/\s+/g, " ").replace(/\*\//g, "* /").trim();

    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const TIERS: { tier: TokenTier; title: string }[] = [
    { tier: "primitive", title: "Primitives" },
    { tier: "semantic", title: "Semantic roles" },
    { tier: "component", title: "Component tokens" },
];

// A primitive holds its raw value even when it is written as a reference to another primitive (`{dim.16}`): DevTools then shows `16px`, not `var(--dim-16)`.
// A role or a component token that refers to a token keeps its `var()`: the reference is what a person wrote, and what a mode changes.
function literalPrimitives(system: CompileInput): CompileInput {
    const byName = new Map(system.tokens.map((token) => [token.name, token]));
    const composite = new Set(["typography", "shadow", "border", "transition", "gradient"]);
    const tokens = system.tokens.map((token) => {
        const raw =
            token.tier === "primitive" ||
            (token.tier !== "component" && /^\d/.test(token.path.at(-1)!));

        if (!raw || composite.has(token.type)) {
            return token;
        }

        let changed = false;
        const modes: ResolvedToken["modes"] = {};

        for (const [mode, value] of Object.entries(token.modes)) {
            const target = value.alias === undefined ? undefined : byName.get(value.alias);

            if (
                target?.tier === "primitive" &&
                value.literal !== undefined &&
                value.literal !== value.css
            ) {
                modes[mode] = { ...value, css: value.literal };
                changed = true;
            } else {
                modes[mode] = value;
            }
        }

        return changed ? { ...token, modes } : token;
    });

    return { ...system, tokens };
}

function declarations(token: ResolvedToken, mode: string): Decl[] {
    const value = token.modes[mode]!;
    const decls: Decl[] = [[token.cssVar, value.css]];

    // Only a type style is used by its members (`font-size: var(--type-body-font-size)`); a shadow's are for editors.
    if (token.type === "typography") {
        for (const [property, css] of Object.entries(value.parts ?? {})) {
            decls.push([`${token.cssVar}-${property}`, css]);
        }
    }

    return decls;
}

function differs(token: ResolvedToken, mode: string, base: string): boolean {
    const a = token.modes[mode]!;
    const b = token.modes[base]!;

    return (
        a.css !== b.css ||
        JSON.stringify(a.value) !== JSON.stringify(b.value) ||
        JSON.stringify(a.parts) !== JSON.stringify(b.parts)
    );
}

function inTiers(tokens: readonly ResolvedToken[]): { title: string; tokens: ResolvedToken[] }[] {
    return TIERS.map(({ tier, title }) => ({
        title,
        tokens: tokens.filter((token) => token.tier === tier),
    })).filter((section) => section.tokens.length > 0);
}

function body(
    sections: { title: string; tokens: ResolvedToken[] }[],
    decl: (token: ResolvedToken) => Decl[],
    notes: boolean,
): string[] {
    const lines: string[] = [];

    for (const section of sections) {
        if (lines.length > 0) {
            lines.push("");
        }

        lines.push(`    /* === ${section.title} === */`);

        let group: string | undefined;

        for (const token of section.tokens) {
            const label = token.path.slice(0, -1).join(".") || token.path[0]!;

            if (label !== group) {
                group = label;
                lines.push("", `    /* ${comment(label, 60)} */`);
            }

            const decls = decl(token);

            decls.forEach(([property, value], at) => {
                let note = "";

                if (notes && at === 0) {
                    if (token.deprecated !== undefined) {
                        note = ` /* deprecated${typeof token.deprecated === "string" ? `: ${comment(token.deprecated, 60)}` : ""} */`;
                    } else if (token.description !== undefined) {
                        note = ` /* ${comment(token.description, 70)} */`;
                    }
                }

                lines.push(`    ${property}: ${value};${note}`);
            });
        }
    }

    return lines;
}

const schemeOf = (system: CompileInput, mode: string) => system.schemes[mode] ?? "light";

function preferred(system: CompileInput): { mode: string; scheme: "light" | "dark" } | undefined {
    const base = system.modes[0]!;
    const other = schemeOf(system, base) === "dark" ? "light" : "dark";
    const mode =
        system.modes.find((each) => each !== base && each === other) ??
        system.modes.find((each) => each !== base && schemeOf(system, each) === other);

    return mode === undefined ? undefined : { mode, scheme: other };
}

interface Blocks {
    base: string[];
    others: { mode: string; lines: string[] }[];
    media?: { scheme: "light" | "dark"; lines: string[] };
}

function blocks(
    system: CompileInput,
    decl: (token: ResolvedToken, mode: string) => Decl[],
    notes: boolean,
): Blocks {
    const base = system.modes[0]!;
    const changed = (mode: string) =>
        inTiers(system.tokens.filter((token) => differs(token, mode, base)));
    const alternate = preferred(system);

    return {
        base: body(inTiers(system.tokens), (token) => decl(token, base), notes),
        others: system.modes.slice(1).map((mode) => ({
            mode,
            lines: body(changed(mode), (token) => decl(token, mode), false),
        })),
        ...(alternate === undefined
            ? {}
            : {
                  media: {
                      scheme: alternate.scheme,
                      lines: body(
                          changed(alternate.mode),
                          (token) => decl(token, alternate.mode),
                          false,
                      ),
                  },
              }),
    };
}

function header(system: CompileInput, file: string, lines: string[]): string {
    return [
        "/*",
        ` * ${comment(system.name, 60)}: ${file} (generated)`,
        " * Generated by Pi Pocket from .pi/design/. Do not edit by hand: change the tokens, then compile again.",
        ...lines.map((line) => ` * ${line}`),
        " */",
    ].join("\n");
}

function tokensCss(system: CompileInput): string {
    const base = system.modes[0]!;
    const modes = system.modes
        .map((mode, at) => (at === 0 ? `${mode} (default)` : mode))
        .join(", ");
    const parts = blocks(system, (token, mode) => declarations(token, mode), true);
    const out = [
        header(system, "tokens.css", [
            `Modes: ${comment(modes)}.`,
            'Use it:  <link rel="stylesheet" href="ds/tokens.css">  then  color: var(--color-text-primary);',
            system.modes.length > 1
                ? `Switch a mode with <html data-theme="${system.modes[1]}">.${parts.media === undefined ? "" : ` Without data-theme, the system's ${parts.media.scheme} setting applies.`}`
                : "One mode only: add tokens.<mode>.json for a dark or brand mode.",
        ]),
        "",
        `:root,\n[data-theme="${base}"] {`,
        `    color-scheme: ${schemeOf(system, base)};`,
        "",
        ...parts.base,
        "}",
    ];

    for (const { mode, lines } of parts.others) {
        out.push(
            "",
            `/* Mode: ${comment(mode)}. Repeats each token that differs from ${comment(base)}. */`,
            `[data-theme="${mode}"] {`,
            `    color-scheme: ${schemeOf(system, mode)};`,
            "",
            ...lines,
            "}",
        );
    }

    if (parts.media !== undefined) {
        out.push(
            "",
            `/* Follow the operating system's ${parts.media.scheme} setting until a data-theme is set. */`,
            `@media (prefers-color-scheme: ${parts.media.scheme}) {`,
            "    :root:not([data-theme]) {",
            `        color-scheme: ${parts.media.scheme};`,
            "",
            ...parts.media.lines.map((line) => (line === "" ? line : `    ${line}`)),
            "    }",
            "}",
        );
    }

    return `${out.join("\n")}\n`;
}

function tailwindCss(system: CompileInput): string {
    const names = tailwindNames(system);
    const rename = new Map(system.tokens.map((token) => [token.cssVar, names.get(token.name)!]));
    // A reference points at the variable that the token has in this file.
    const swap = (css: string) =>
        css.replace(/var\((--[\w-]+)/g, (all, name: string) =>
            rename.has(name) ? `var(${rename.get(name)}` : all,
        );

    const decls = (token: ResolvedToken, mode: string): Decl[] => {
        const value = token.modes[mode]!;
        const name = names.get(token.name)!;

        if (token.type !== "typography") {
            return [[name, swap(value.css)]];
        }

        const parts = value.parts ?? {};

        // A type style is Tailwind's `--text-*`: the size, with `--line-height`, `--font-weight`, and `--letter-spacing`.
        if (name.startsWith("--text-") && parts["font-size"] !== undefined) {
            const out: Decl[] = [[name, swap(parts["font-size"])]];

            for (const property of ["line-height", "font-weight", "letter-spacing"] as const) {
                if (parts[property] !== undefined) {
                    out.push([`${name}--${property}`, swap(parts[property])]);
                }
            }

            return out;
        }

        return [
            [name, swap(value.css)],
            ...Object.entries(parts).map(([property, css]): Decl => [
                `${name}-${property}`,
                swap(css),
            ]),
        ];
    };

    const base = system.modes[0]!;
    const parts = blocks(system, decls, true);
    const dark = system.modes.find((mode) => system.schemes[mode] === "dark" && mode !== base);
    const reset = (system.tailwindReset ?? []).map((namespace) =>
        namespace === "all" ? "--*: initial;" : `--${namespace}-*: initial;`,
    );
    const out = [
        header(system, "tailwind.css", [
            "For Tailwind CSS v4. Import it after Tailwind, in your main stylesheet:",
            '    @import "tailwindcss";',
            '    @import "./tailwind.css";',
            "Each token has one variable here, in a namespace of Tailwind's theme when one fits: --color-*, --font-* (families),",
            "--text-*, --font-weight-*, --tracking-*, --leading-*, --breakpoint-*, --container-*, --spacing-*, --radius-*,",
            "--shadow-*, --inset-shadow-*, --drop-shadow-*, --blur-*, --perspective-*, --aspect-*, --ease-*. A token with no",
            "namespace keeps its own name (--button-height); one whose name would be read as a namespace of the wrong kind",
            "(--font-leading-tight) gets --ds- in front.",
            "Utilities read well because a role drops the word that the utility repeats: color.bg.surface is --color-surface",
            "(bg-surface), color.text.primary is --color-primary (text-primary), color.border.default is --color-default",
            "(border-default), and a trailing default goes (color.accent.default is --color-accent). When two roles would",
            "have one name, the first keeps it and the other keeps its full name (--color-text-muted).",
            "tokens.css has every token under its own name (--color-bg-surface, --space-4); link it too for var(--space-4)",
            "and the components.",
            'To clear Tailwind\'s default palette (bg-red-500 and the rest), set "tailwindReset": ["color"] in tokens.json\'s',
            '$extensions["com.pi-pocket"].',
        ]),
        "",
        `:root,\n[data-theme="${base}"] {`,
        `    color-scheme: ${schemeOf(system, base)};`,
        "}",
        "",
        ...(dark === undefined
            ? []
            : [
                  "/* dark: matches [data-theme] when it is set, and the system's dark setting when no data-theme is. */",
                  "@custom-variant dark {",
                  `    &:where([data-theme="${dark}"], [data-theme="${dark}"] *) {`,
                  "        @slot;",
                  "    }",
                  "",
                  "    @media (prefers-color-scheme: dark) {",
                  "        &:where(:not([data-theme]):not([data-theme] *)) {",
                  "            @slot;",
                  "        }",
                  "    }",
                  "}",
                  "",
              ]),
        `/* ${comment(base)} values. Other modes override them below. */`,
        "@theme static {",
        ...reset.map((line) => `    ${line}`),
        ...(reset.length > 0 ? [""] : []),
        ...parts.base,
        "}",
    ];

    for (const { mode, lines } of parts.others) {
        out.push(
            "",
            `/* Mode: ${comment(mode)} */`,
            `[data-theme="${mode}"] {`,
            `    color-scheme: ${schemeOf(system, mode)};`,
            "",
            ...lines,
            "}",
        );
    }

    if (parts.media !== undefined) {
        out.push(
            "",
            `@media (prefers-color-scheme: ${parts.media.scheme}) {`,
            "    :root:not([data-theme]) {",
            `        color-scheme: ${parts.media.scheme};`,
            "",
            ...parts.media.lines.map((line) => (line === "" ? line : `    ${line}`)),
            "    }",
            "}",
        );
    }

    return `${out.join("\n")}\n`;
}

function componentsCss(system: CompileInput): string {
    const head = header(system, "components.css", [
        'Use it:  <link rel="stylesheet" href="ds/components.css">  then use the markup of a component specimen.',
    ]);

    if (system.components.length === 0) {
        return `${head}\n\n/* No components yet. */\n`;
    }

    const blocks = system.components.map(
        (component) =>
            `/* ${comment(component.name, 60)} (components/${component.slug}.html) */\n${component.css}`,
    );

    return `${head}\n\n${blocks.join("\n\n")}\n`;
}

export function compileDesignSystem(input: CompileInput): CompiledFiles {
    const system = literalPrimitives(input);

    return {
        css: tokensCss(system),
        tailwind: tailwindCss(system),
        json: compactJson(system),
        components: componentsCss(system),
        modes: Object.fromEntries(system.modes.map((mode) => [mode, dtcgJson(system, mode)])),
        studio: studioJson(system),
        names: namesMarkdown(system),
    };
}
