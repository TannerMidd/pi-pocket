// The utilities in the fixture were made with a real Tailwind 4.3 compile.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadDesignSystem, tailwindNames } from "../src/server/design/tokens.ts";

const FLAGSHIP = join(import.meta.dirname, "..", "docs", "examples", "design-system", "pocket");
const system = loadDesignSystem(FLAGSHIP)!;

const KINDS: [string, string[]][] = [
    ["font-weight", ["fontWeight"]],
    ["inset-shadow", ["shadow"]],
    ["drop-shadow", ["shadow"]],
    ["color", ["color"]],
    ["font", ["fontFamily"]],
    ["text", ["dimension", "typography"]],
    ["tracking", ["dimension"]],
    ["leading", ["number", "dimension"]],
    ["breakpoint", ["dimension"]],
    ["container", ["dimension"]],
    ["spacing", ["dimension"]],
    ["radius", ["dimension"]],
    ["shadow", ["shadow"]],
    ["blur", ["dimension"]],
    ["perspective", ["dimension"]],
    ["aspect", ["number"]],
    ["ease", ["cubicBezier"]],
    ["animate", ["transition"]],
];

test("a token is in a namespace of Tailwind's theme only when it is of that kind: no --font-leading-tight", () => {
    const names = tailwindNames(system);

    assert.equal(names.size, system.tokens.length);

    for (const token of system.tokens) {
        const variable = names.get(token.name)!;
        const namespace = KINDS.find(([each]) => variable.startsWith(`--${each}-`));

        if (namespace !== undefined) {
            assert.ok(
                namespace[1].includes(token.type),
                `${token.name} (${token.type}) is ${variable}, in the namespace of ${namespace[0]}`,
            );
        }
    }

    const css = system.compiled.tailwind.slice(system.compiled.tailwind.indexOf("@theme"));

    assert.doesNotMatch(css, /--font-leading|--font-tracking/);
    assert.match(css, /--leading-tight: /);
    assert.match(css, /--tracking-wide: /);
    assert.equal(new Set(names.values()).size, names.size, "one variable for each token");
});

test("a name that Tailwind would read wrongly is kept out of its namespaces: --ds- in front", () => {
    const made = loadDesignSystem(FLAGSHIP)!;
    const other = {
        ...made,
        tokens: [
            {
                ...made.tokens[0]!,
                name: "font.foo",
                path: ["font", "foo"],
                cssVar: "--font-foo",
                type: "number" as const,
            },
            {
                ...made.tokens[0]!,
                name: "z.modal",
                path: ["z", "modal"],
                cssVar: "--z-modal",
                type: "number" as const,
            },
        ],
    };
    const names = tailwindNames(other);

    assert.equal(
        names.get("font.foo"),
        "--ds-font-foo",
        "a number in --font-* would make font-foo",
    );
    assert.equal(names.get("z.modal"), "--z-modal", "no namespace, no change");
});

test("color roles drop the word that the utility repeats (bg-surface, text-muted); a role that is only primary or default takes its group's word; tokens.css keeps its names", () => {
    const names = tailwindNames(system);

    assert.equal(names.get("color.bg.surface"), "--color-surface");
    assert.equal(
        names.get("color.text.primary"),
        "--color-text",
        "`primary` alone is also the brand",
    );
    assert.equal(
        names.get("color.text.secondary"),
        "--color-text-secondary",
        "the second of one name keeps its full name",
    );
    assert.equal(names.get("color.text.muted"), "--color-muted");
    assert.equal(names.get("color.border.default"), "--color-border");
    assert.equal(names.get("color.bg.base"), "--color-bg");
    assert.equal(names.get("color.accent.default"), "--color-accent", "a trailing default goes");
    assert.equal(
        names.get("color.accent.fill"),
        "--color-accent-fill",
        "a role group's own name stays",
    );
    assert.equal(
        names.get("color.neutral.500"),
        "--color-neutral-500",
        "a palette step is as it is",
    );
    assert.match(
        system.compiled.css,
        /--color-bg-surface: /,
        "the variable of tokens.css is unchanged",
    );
    assert.match(system.compiled.css, /--color-text-primary: /);
    assert.match(
        system.compiled.css,
        /--font-leading-tight: /,
        "and so is the tokens.css name of a leading",
    );
});

function utilities(css: string): string[] {
    const theme = css.slice(
        css.indexOf("@theme static {"),
        css.indexOf("\n}\n", css.indexOf("@theme static {")),
    );
    const variables = [...theme.matchAll(/^ {4}(--[\w-]+):/gm)]
        .map((match) => match[1]!)
        .filter((name) => !name.includes("--", 2));
    const made = new Set<string>();
    const table: [string, string[]][] = [
        ["color", ["bg", "text", "border"]],
        ["font-weight", ["font"]],
        ["font", ["font"]],
        ["text", ["text"]],
        ["tracking", ["tracking"]],
        ["leading", ["leading"]],
        ["spacing", ["p"]],
        ["radius", ["rounded"]],
        ["shadow", ["shadow"]],
        ["ease", ["ease"]],
        ["blur", ["blur"]],
        ["container", ["max-w"]],
    ];

    for (const name of variables) {
        const namespace = [
            "font-weight",
            "inset-shadow",
            "drop-shadow",
            ...table.map(([each]) => each),
        ].find((each) => name.startsWith(`--${each}-`));

        if (namespace === undefined) {
            continue;
        }

        const rest = name.slice(namespace.length + 3);

        for (const [each, prefixes] of table) {
            if (each === namespace) {
                prefixes.forEach((prefix) => made.add(`${prefix}-${rest}`));
            }
        }

        if (namespace === "breakpoint") {
            made.add(`${rest}:flex`);
        }
    }

    return [...made].sort();
}

test("the utilities of the flagship are the ones that a real Tailwind compile made (the fixture)", () => {
    const fixture = readFileSync(
        join(import.meta.dirname, "fixtures", "design-system", "pocket-tailwind-utilities.txt"),
        "utf8",
    )
        .split("\n")
        .filter(Boolean);
    const now = utilities(system.compiled.tailwind);

    assert.deepEqual(
        now,
        fixture,
        "the names in tailwind.css changed. If that is meant, compile it with Tailwind 4 (@tailwindcss/cli over a page of these classes, outside the repository), and write the utilities to the fixture",
    );
    assert.ok(
        now.includes("bg-surface") &&
            now.includes("text-text") &&
            now.includes("border-border") &&
            now.includes("text-muted"),
    );
    assert.ok(
        !now.some((name) =>
            /font-leading|font-tracking|bg-bg-surface|text-text-muted|border-border-subtle/.test(
                name,
            ),
        ),
    );
});

test("dist/names.md lists every token with its variable in each file and its utilities, and says how the names come out", () => {
    const text = system.compiled.names!;
    const rows = text.split("\n").filter((line) => /^\| `[\w.-]+` \|/.test(line));
    const tailwind = tailwindNames(system);

    assert.equal(rows.length, system.tokens.length, "one row for each token");
    assert.match(text, /^# Names: Pi Pocket\n/);
    assert.match(text, /## How the names come out/);
    assert.match(text, /`color\.border\.default` is `--color-border`/);

    const row = (name: string) => rows.find((line) => line.startsWith(`| \`${name}\` |`))!;

    assert.equal(
        row("color.bg.surface"),
        "| `color.bg.surface` | `--color-bg-surface` | `--color-surface` | `bg-surface` |",
    );
    assert.match(
        row("color.text.primary"),
        /`--color-text-primary` \| `--color-text` \| `text-text` \|$/,
    );
    assert.match(
        row("color.accent.default"),
        /`--color-accent` \| `bg-accent` `text-accent` `border-accent` \|$/,
    );
    assert.match(
        row("color.accent.fill"),
        /`bg-accent-fill` `text-accent-fill` `border-accent-fill` \|$/,
        "only the first word of the path names the utility",
    );
    assert.match(
        row("font.family.sans"),
        /`--font-family-sans` \| `--font-sans` \| `font-sans` \|$/,
    );
    assert.match(row("font.weight.bold"), /`--font-weight-bold` \| `font-bold` \|$/);
    assert.match(row("space.4"), /`--space-4` \| `--spacing-4` \| `p-4` `m-4` `gap-4` \|$/);
    assert.match(row("radius.card"), /`rounded-card` \|$/);
    assert.match(row("button.height"), /no utility: `var\(--button-height\)` \|$/);

    for (const token of system.tokens) {
        assert.ok(text.includes(`\`${tailwind.get(token.name)}\``), token.name);
        assert.ok(system.compiled.css.includes(`${token.cssVar}:`), token.cssVar);
    }
});
