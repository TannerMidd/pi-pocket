// Project text (descriptions, component names, guidelines) is data: it is cut to one line, stripped of invisible characters, and made safe to put between tags.
import { defang } from "../fence.ts";
import type { DesignSystem, ResolvedToken } from "./system-types.ts";

const plain = (text: string) =>
    defang(
        text
            .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim(),
    );
const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

function valueLine(system: DesignSystem, token: ResolvedToken): string {
    const [base, ...others] = system.modes as [string, ...string[]];

    const show = (mode: string) => {
        const value = token.modes[mode]!;

        return clip(value.hex ?? value.literal ?? value.css, 70);
    };

    const first = show(base);
    const changes = others
        .filter((mode) => show(mode) !== first)
        .map((mode) => `${mode} ${show(mode)}`);

    return `${first}${changes.length > 0 ? ` (${changes.join("; ")})` : ""}`;
}

const headingOf = (token: ResolvedToken) => token.path[0]!;

function palettes(tokens: ResolvedToken[]): string[] {
    const groups = new Map<string, string[]>();

    for (const token of tokens) {
        const parent = token.path.slice(0, -1).join(".") || token.name;
        const list = groups.get(parent) ?? [];

        list.push(token.path.at(-1)!);
        groups.set(parent, list);
    }

    return [...groups].map(([parent, leaves]) =>
        leaves.length === 1 && parent === leaves[0]
            ? `${parent}`
            : `${parent}.{${clip(leaves.join(", "), 80)}}`,
    );
}

const CLASS_NAME = /^[\w:.[\]%/#-]{1,48}$/;

// Project text: only safe class names are kept.
function rootOf(component: DesignSystem["components"][number]): string {
    const classesIn = (tag: string) =>
        (
            /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i
                .exec(tag)
                ?.slice(1)
                .find((each) => each !== undefined) ?? ""
        )
            .split(/\s+/)
            .filter((name) => CLASS_NAME.test(name));
    const first = component.markup[component.states[0]!] ?? "";
    const opening = /<([a-z][a-z0-9-]*)\b[^>]*>/i.exec(first);

    if (opening === null) {
        return "";
    }

    const tag = opening[1]!.toLowerCase();
    const rootClasses = classesIn(opening[0]);
    const seen = new Set(rootClasses);
    const others: string[] = [];

    for (const state of component.states) {
        for (const element of (component.markup[state] ?? "").matchAll(/<[a-z][^>]*>/gi)) {
            for (const name of classesIn(element[0])) {
                if (!seen.has(name)) {
                    seen.add(name);
                    others.push(name);
                }
            }
        }
    }

    return `root <${tag}${rootClasses.length === 0 ? "" : ` class="${rootClasses.join(" ")}"`}>${others.length === 0 ? "" : `; other classes ${others.slice(0, 8).join(" ")}${others.length > 8 ? " …" : ""}`}`;
}

function useCounts(system: DesignSystem): Map<string, number> {
    const uses = new Map<string, number>();
    const add = (name: string) => uses.set(name, (uses.get(name) ?? 0) + 1);

    for (const component of system.components) {
        new Set(component.tokens).forEach(add);
    }

    for (const token of system.tokens) {
        new Set(Object.values(token.modes).flatMap((value) => value.alias ?? [])).forEach(add);
    }

    return uses;
}

/** The headings of a list of tokens, in the order they first appear; colors come first, since they are the roles. */
function headingsOf(tokens: ResolvedToken[]): string[] {
    const found = [...new Set(tokens.map(headingOf))];

    return [
        ...found.filter((heading) => heading === "color"),
        ...found.filter((heading) => heading !== "color"),
    ];
}

export function systemSummary(system: DesignSystem, maxBytes: number): string {
    const uses = useCounts(system);
    const errors = system.problems.filter((problem) => problem.level === "error").length;
    const warnings = system.problems.length - errors;
    const modes = system.modes
        .map((mode, at) => (at === 0 ? `${mode} (default)` : mode))
        .join(", ");

    // A palette is collapsed when roles name it; a system with only raw colors lists them as the roles.
    const roles = system.tokens.some(
        (token) => token.type === "color" && token.tier !== "primitive",
    );
    const palette = roles
        ? system.tokens.filter((token) => token.type === "color" && token.tier === "primitive")
        : [];
    const rest = system.tokens.filter((token) => !palette.includes(token));
    const ranked = (list: ResolvedToken[]) =>
        list
            .map((token, at) => ({ token, at }))
            .sort(
                (a, b) =>
                    (uses.get(b.token.name) ?? 0) - (uses.get(a.token.name) ?? 0) || a.at - b.at,
            )
            .map((each) => each.token);
    const semantic = rest.filter(
        (token) =>
            token.tier === "semantic" || (token.type === "color" && token.tier === "primitive"),
    );
    const scales = rest.filter((token) => token.tier === "primitive" && !semantic.includes(token));
    const parts = rest.filter((token) => token.tier === "component");

    // `notes.left` is how many descriptions the lines may still carry: the summary keeps them for the tokens that come first.
    const tokenLines = (list: ResolvedToken[], notes: { left: number }): string[] => {
        const lines: string[] = [];

        for (const heading of headingsOf(list)) {
            lines.push(`${heading}:`);

            for (const token of ranked(list.filter((each) => headingOf(each) === heading))) {
                const note =
                    token.deprecated === undefined
                        ? ""
                        : ` [deprecated${typeof token.deprecated === "string" ? `: ${clip(plain(token.deprecated), 50)}` : ""}]`;
                const why =
                    token.description === undefined || notes.left <= 0
                        ? ""
                        : `  // ${clip(plain(token.description), 50)}`;

                if (why !== "") {
                    notes.left -= 1;
                }

                lines.push(`  ${token.cssVar} ${valueLine(system, token)}${note}${why}`);
            }
        }

        return lines;
    };

    const intro: string[] = [
        `Design system "${plain(system.name).slice(0, 60)}": ${system.tokens.length} tokens, modes ${modes}, ${system.components.length} component${system.components.length === 1 ? "" : "s"}${errors + warnings > 0 ? `; ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} (design_system validate lists them)` : ""}.`,
    ];

    if (system.description !== undefined) {
        intro.push(plain(system.description).slice(0, 200));
    }

    intro.push(
        'Link it in every design: <link rel="stylesheet" href="ds/tokens.css">' +
            (system.components.length > 0
                ? ' and <link rel="stylesheet" href="ds/components.css">'
                : "") +
            ". Use only these variables as var(--name); do not write raw colors, font sizes, or pixel spacing. Modes change by themselves" +
            (system.modes.length > 1 ? `, or set <html data-theme="${system.modes[1]}">.` : "."),
        'Set a variable in a design\'s tweaks manifest with its "--" name to let people change it live.',
    );

    const componentLines: string[] = [];

    if (system.components.length > 0) {
        componentLines.push(
            "",
            "Components (design_system read file=components/<name>.html has the markup):",
        );

        for (const component of system.components) {
            const root = rootOf(component);

            componentLines.push(
                `  ${component.slug}: ${clip(plain(component.name), 40)}${root === "" ? "" : `; ${root}`}; states ${component.states.join(", ")}${component.description === "" ? "" : `; ${clip(plain(component.description), 80)}`}`,
            );
        }
    }

    const guidelineLines: string[] = [];
    const guidelines = system.guidelines.trim();

    if (guidelines !== "") {
        guidelineLines.push("", "Guidelines (project rules):");
        guidelineLines.push(
            ...defang(guidelines)
                .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}]+/gu, (run) =>
                    run.includes("\n") ? "\n" : " ",
                )
                .split("\n")
                .map((line) => `  ${line.trimEnd()}`)
                .filter((line) => line.trim() !== "")
                .slice(0, 40),
        );
    }

    // The sections in the order that they are kept when the summary is cut.
    const sections = (described: number) => {
        const notes = { left: described };
        const first = [
            ...intro,
            ...(semantic.length > 0 ? ["", ...tokenLines(semantic, notes)] : []),
            ...componentLines,
        ];
        const later = [
            ...(scales.length > 0
                ? ["", "Scales (raw values):", ...tokenLines(scales, notes)]
                : []),
            ...guidelineLines,
            ...(palette.length > 0
                ? [
                      "",
                      `Palette (raw colors; prefer the roles above): ${palettes(palette).join("; ")}`,
                  ]
                : []),
            ...(parts.length > 0
                ? ["", "Component tokens (set by one component):", ...tokenLines(parts, notes)]
                : []),
        ];

        return { first, all: [...first, ...later] };
    };

    const bytes = (text: string) => Buffer.byteLength(text) + 1;
    const total = (lines: string[]) => lines.reduce((sum, line) => sum + bytes(line), 0);
    const note = (left: number) =>
        `… ${left} more line${left === 1 ? "" : "s"} not shown: call design_system read for all of it.`;
    const everything = system.tokens.length;
    const full = sections(everything);

    if (total(full.all) <= maxBytes) {
        return full.all.join("\n");
    }

    // The roles and the components matter most, then the scales and the rules: descriptions go from the last token to
    // the first until the roles and the components take four fifths of the space.
    let low = 0;
    let high = everything;

    while (low < high) {
        const middle = Math.ceil((low + high) / 2);

        if (total(sections(middle).first) <= maxBytes * 0.8) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    const lines = sections(low).all;
    const budget = maxBytes - bytes(note(lines.length));
    const kept: string[] = [];
    let used = 0;

    for (const line of lines) {
        if (used + bytes(line) > budget) {
            break;
        }

        kept.push(line);
        used += bytes(line);
    }

    return [...kept, note(lines.length - kept.length)].join("\n");
}
