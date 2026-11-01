import { contrastRatio } from "./color.ts";
import type { Facts, Kinds } from "./scan-facts.ts";
import {
    type ColorEntry,
    distance,
    entryOf,
    hexOf,
    merge as mergeFact,
    mergeColors,
    nameScore,
    type RoleName,
    ROLES,
    w,
    words,
} from "./scan-colors.ts";
import {
    type Classified,
    type Prepared,
    useDefaultColors,
    weighClassRules,
} from "./scan-prepare.ts";
import type { Book, Inferred } from "./scan-scales.ts";
import type { Variable } from "./scan-variables.ts";

export interface RoleChoice {
    role: RoleName;
    hex: string;
    basis: "name" | "use";
    source: string;
    score: number;
}

interface VarColor {
    name: string;
    hex: string;
    uses: number;
    kinds?: Kinds;
}

const hueOk = (role: RoleName, color: ColorEntry): boolean => {
    if (color.c < 0.06) {
        return false;
    }

    switch (role) {
        case "danger":
            return color.h >= 345 || color.h < 45;
        case "warning":
            return color.h >= 35 && color.h < 115;
        case "success":
            return color.h >= 105 && color.h < 185;
        default:
            return true;
    }
};

const STATUS = ["danger", "warning", "success"] as const;
const NEUTRAL_ROLES = new Set<RoleName>(["background", "surface", "text", "muted", "border"]);
const ACCENT_WORDS = w(
    "accent primary brand link highlight cta action interactive main theme key default base 500 600 text dark light hover active focus pressed",
);
// The hue each status color sits nearest to (Oklch degrees): a red close to 27° is an error, not an orange.
const CENTERS = { danger: 27, warning: 70, success: 148 } as const;
const hueGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

// How well a variable's name and color fit a role; the caller keeps the best score of 60 or more.
function namedScore(
    role: RoleName,
    variable: VarColor,
    color: ColorEntry,
    bg: ColorEntry | undefined,
): number {
    const segs = words(variable.name);
    let score = nameScore(role, segs);

    if (score === 0) {
        return 0;
    }

    if (STATUS.includes(role as (typeof STATUS)[number])) {
        if (segs.some((seg) => /^\d{3}$/.test(seg))) {
            score += segs.includes("500") ? 8 : segs.includes("600") ? 5 : 0;
        }

        score -= hueOk(role, color) ? 0 : 45;
    }

    if (role === "accent") {
        // A gray `primary` (shadcn's hover surface) is no brand; how vivid it is only breaks a tie.
        score += color.c >= 0.03 ? 20 + Math.min(10, color.c * 40) : -10;
        score +=
            segs.includes("accent") &&
            !segs.includes("primary") &&
            !segs.includes("brand") &&
            color.c >= 0.03
                ? 10
                : 0;
        score -= segs.some((seg) => /^\d$/.test(seg)) ? 15 : 0;
        // A long name that only holds a role word (`tooltipExternalLinkColor`) is not the brand.
        score -= Math.min(
            24,
            segs.filter((seg) => !/^\d+$/.test(seg) && !ACCENT_WORDS.includes(seg)).length * 8,
        );
    }

    // How the variable is really used beats what it is called: a "text" color that paints the page is the page.
    const kinds = variable.kinds;

    if (kinds !== undefined) {
        if ((role === "text" || role === "muted") && kinds.bg >= 2 && kinds.bg > kinds.text * 2) {
            score -= 45;
        } else if (
            (role === "background" || role === "surface") &&
            kinds.text >= 2 &&
            kinds.text > kinds.bg * 2
        ) {
            score -= 40;
        } else if (role === "border" && kinds.bg >= 3 && kinds.bg > kinds.border * 3) {
            score -= 30;
        }
    }

    score -= role === "background" && color.c > 0.1 ? 50 : 0;

    if ((role === "text" || role === "muted") && bg !== undefined) {
        const ratio = contrastRatio(color.rgba, bg.rgba);

        // A quiet text a little under 3:1 (a gray on a gray page) is still quiet text; far under is not text.
        score += ratio >= 4.5 ? 8 : ratio >= 3 ? 0 : ratio >= 2.5 ? -18 : -45;
    }

    return score + Math.min(8, Math.log2(1 + variable.uses));
}

// `colors` is every color of the project; `named` is the subset that variables hold.
function chooseRoles(
    colors: Map<string, ColorEntry>,
    named: VarColor[],
): Partial<Record<RoleName, RoleChoice>> {
    const chosen: Partial<Record<RoleName, RoleChoice>> = {};
    const entries = [...colors.values()];
    const best = (list: ColorEntry[], pick: (entry: ColorEntry) => number) =>
        [...list].sort(
            (a, b) => pick(b) - pick(a) || b.uses - a.uses || a.hex.localeCompare(b.hex),
        )[0];

    const set = (
        role: RoleName,
        hex: string,
        basis: RoleChoice["basis"],
        source: string,
        score: number,
    ) => {
        chosen[role] = { role, hex, basis, source, score };
    };

    const family = (name: string) => /^(.*?)[-_]?\d{1,3}$/.exec(name)?.[1];
    // A family of numbered steps (`ink-0` … `ink-9`) is a ramp, not the roles that a step's word names.
    const steps = new Map<string, number>();

    for (const variable of named) {
        const name = family(variable.name);

        if (name !== undefined && name !== "") {
            steps.set(name, (steps.get(name) ?? 0) + 1);
        }
    }

    // Names first, the page background first: the others are judged against it.
    const pickNamed = (role: RoleName, bg: ColorEntry | undefined) => {
        const scored: { variable: VarColor; score: number }[] = [];

        for (const variable of named) {
            const color = colors.get(variable.hex);

            if (
                color === undefined ||
                (NEUTRAL_ROLES.has(role) && (steps.get(family(variable.name) ?? "") ?? 0) >= 6) ||
                Object.values(chosen).some(
                    (each) =>
                        each.hex === variable.hex &&
                        each.basis === "name" &&
                        each.source === variable.name,
                )
            ) {
                continue;
            }

            const score = namedScore(role, variable, color, bg);

            if (score !== 0) {
                scored.push({ variable, score });
            }
        }

        let top = scored.reduce<(typeof scored)[number] | undefined>(
            (most, each) => (most === undefined || each.score > most.score ? each : most),
            undefined,
        );

        // A surface that is the page's own color is no surface (`--surface-1` is the page, `--surface-2` the card).
        if (role === "surface" && top !== undefined && top.variable.hex === bg?.hex) {
            top =
                scored
                    .filter((each) => each.variable.hex !== bg.hex && each.score >= 60)
                    .sort((a, b) => b.score - a.score)[0] ?? top;
        }

        if (top !== undefined && top.score >= 60) {
            set(role, top.variable.hex, "name", top.variable.name, top.score);
        }
    };

    pickNamed("background", undefined);

    const bg =
        chosen.background === undefined
            ? entries
                  .filter(
                      (color) =>
                          color.c < 0.06 && color.rgba.a > 0.9 && (color.fact?.root ?? 0) > 0,
                  )
                  .sort((a, b) => (b.fact?.root ?? 0) - (a.fact?.root ?? 0))[0]
            : colors.get(chosen.background.hex);

    for (const role of ROLES.filter((each) => each !== "background")) {
        pickNamed(role, bg);
    }

    // `--muted` alone: text if it reads on the page, a surface if not.
    const lone = named.find((variable) => /^(?:color-)?muted$/i.test(variable.name));
    const loneColor = lone === undefined ? undefined : colors.get(lone.hex);

    if (lone !== undefined && loneColor !== undefined && bg !== undefined) {
        const text = contrastRatio(loneColor.rgba, bg.rgba) >= 3 && distance(loneColor, bg) > 0.2;

        if (text && chosen.muted === undefined) {
            set("muted", lone.hex, "name", lone.name, 62);
        } else if (!text && chosen.surface === undefined && lone.hex !== chosen.background?.hex) {
            set("surface", lone.hex, "name", lone.name, 62);
        }
    }

    const fact = (
        color: ColorEntry,
        kind: "bg" | "text" | "border" | "root" | "surface" | "body" | "fill",
    ) => color.fact?.[kind] ?? 0;
    const neutral = entries.filter((color) => color.c < 0.06 && color.rgba.a > 0.9);
    const used = (hex: string) => Object.values(chosen).some((each) => each.hex === hex);

    if (chosen.background === undefined) {
        const top =
            best(
                neutral.filter((color) => fact(color, "root") > 0),
                (color) => fact(color, "root"),
            ) ??
            best(
                neutral.filter((color) => fact(color, "bg") > 0),
                (color) => fact(color, "bg"),
            );

        if (top !== undefined) {
            set("background", top.hex, "use", `used on the page ${top.hex}`, 40);
        }
    }

    const page = chosen.background === undefined ? undefined : colors.get(chosen.background.hex);
    const gray = (color: ColorEntry, chroma: number) =>
        !used(color.hex) && color.rgba.a > 0.9 && color.c < chroma;

    if (chosen.surface === undefined && page !== undefined) {
        const top = best(
            neutral.filter(
                (color) =>
                    !used(color.hex) &&
                    fact(color, "bg") > 0 &&
                    distance(color, page) > 0.012 &&
                    distance(color, page) < 0.3,
            ),
            (color) => fact(color, "surface") * 3 + fact(color, "bg"),
        );

        if (top !== undefined) {
            set("surface", top.hex, "use", "most used background of cards and panels", 35);
        }
    }

    if (chosen.text === undefined) {
        const top = best(
            entries.filter(
                (color) =>
                    gray(color, 0.1) &&
                    fact(color, "text") > 0 &&
                    (page === undefined || contrastRatio(color.rgba, page.rgba) >= 4.5),
            ),
            (color) => fact(color, "body") * 6 + fact(color, "text"),
        );

        if (top !== undefined) {
            set("text", top.hex, "use", "most used text color", 40);
        }
    }

    const ink = chosen.text === undefined ? undefined : colors.get(chosen.text.hex);

    if (chosen.muted === undefined && ink !== undefined && page !== undefined) {
        const inkRatio = contrastRatio(ink.rgba, page.rgba);
        const top = best(
            entries.filter((color) => {
                const ratio = contrastRatio(color.rgba, page.rgba);

                return (
                    gray(color, 0.1) &&
                    fact(color, "text") > 0 &&
                    ratio >= 3 &&
                    ratio < inkRatio - 0.5
                );
            }),
            (color) =>
                fact(color, "text") *
                (color.c < 0.05 ? 1 : 0.3) *
                (contrastRatio(color.rgba, page.rgba) <= inkRatio * 0.7 ? 1 : 0.5),
        );

        if (top !== undefined) {
            set("muted", top.hex, "use", "second most used text color", 35);
        }
    }

    if (chosen.border === undefined) {
        const top =
            best(
                neutral.filter((color) => !used(color.hex) && fact(color, "border") > 0),
                (color) => fact(color, "border"),
            ) ??
            best(
                entries.filter(
                    (color) => !used(color.hex) && color.c < 0.08 && fact(color, "border") > 0,
                ),
                (color) => fact(color, "border"),
            );

        if (top !== undefined) {
            set("border", top.hex, "use", "most used border color", 35);
        }
    }

    const chroma = entries.filter((color) => color.c >= 0.07 && color.rgba.a > 0.9);
    const notice = (color: ColorEntry) =>
        color.names.some(
            (each) =>
                STATUS.some((role) => nameScore(role, words(each.name)) >= 48) ||
                words(each.name).some((word) => ["info", "note", "notice"].includes(word)),
        );

    if (chosen.accent === undefined) {
        // A color a variable names is a token of the design; a literal in a gradient is a decoration.
        const top = best(
            chroma.filter((color) => !used(color.hex) && !notice(color)),
            (color) =>
                fact(color, "bg") * 1.4 +
                fact(color, "text") +
                fact(color, "border") +
                fact(color, "fill") +
                (color.names.length > 0 ? 2 : 0) +
                color.c * 5,
        );

        if (top !== undefined) {
            set("accent", top.hex, "use", "most used chromatic color", 35);
        }
    }

    const accent = chosen.accent === undefined ? undefined : colors.get(chosen.accent.hex);
    // A color named for the accent's variable and a suffix (`--glow-deep`, `--brandHover`) is a step of the accent;
    // so is a color near it, or one of its hue with no name of its own.
    const accentShade = (color: ColorEntry) =>
        accent !== undefined &&
        ((accent.names ?? []).some((stem) =>
            color.names.some(
                (each) =>
                    each.name !== stem.name &&
                    each.name.startsWith(stem.name) &&
                    /^[-_A-Z0-9]/.test(each.name.slice(stem.name.length)),
            ),
        ) ||
            distance(color, accent) <= 0.06 ||
            (accent.c >= 0.07 && color.names.length === 0 && hueGap(color.h, accent.h) < 8));

    for (const role of STATUS.filter((each) => chosen[each] === undefined)) {
        // Used, or named by a variable (`--stop` is defined, and no rule needs to use it).
        const top = best(
            chroma.filter(
                (color) =>
                    !used(color.hex) &&
                    hueOk(role, color) &&
                    color.c >= 0.1 &&
                    (color.uses >= 1 || color.names.length > 0) &&
                    !accentShade(color),
            ),
            (color) =>
                Math.log2(1 + color.uses) * 2 +
                (1 - Math.min(1, hueGap(color.h, CENTERS[role]) / 40)) * 3 +
                (color.names.length > 0 ? 3 : 0),
        );

        if (top !== undefined) {
            set(
                role,
                top.hex,
                "use",
                top.uses === 0
                    ? `named ${top.names[0]!.name}, with the hue of ${role}`
                    : `used ${top.uses}× with the hue of ${role}`,
                30,
            );
        }
    }

    return chosen;
}

export interface InferContext {
    facts: Facts;
    prep: Prepared;
    classified: Classified[];
    alt: "dark" | "light";
    result: Inferred;
    book: Book;
    aliasOf: Map<string, string[]>;
    uses: (variable: Variable) => number;
}

export interface ColorRoles {
    lightColors: Map<string, ColorEntry>;
    darkColors: Map<string, ColorEntry>;
    lightRoles: Partial<Record<RoleName, RoleChoice>>;
    darkRoles: Partial<Record<RoleName, RoleChoice>>;
}

export function chooseColorRoles(context: InferContext): ColorRoles {
    const { facts, classified, alt, result, uses } = context;
    const colorVars = classified.filter((entry) => entry.category === "color");

    const defined = (mode: "lightColor" | "darkColor") =>
        colorVars.flatMap((entry) => {
            const hex = hexOf(entry[mode]);

            return hex === undefined
                ? []
                : [
                      {
                          entry,
                          hex,
                          text: entry[mode]!,
                          name: entry.variable.name,
                          uses: uses(entry.variable),
                      },
                  ];
        });
    const light = defined("lightColor");
    const namedDark = defined("darkColor");

    useDefaultColors(facts);
    weighClassRules(facts);

    const lightColors = mergeColors(light, facts.colors);
    const darkColors = mergeColors(namedDark, alt === "dark" ? facts.darkColors : new Map());
    const namedLight = light.map((each) => ({
        ...each,
        kinds: facts.varKinds.get(each.name),
    }));

    for (const each of namedLight) {
        const entry = lightColors.get(each.hex);

        entry?.names.push({ name: each.name, uses: each.uses });

        if (entry !== undefined && each.kinds !== undefined) {
            const { kinds } = each;

            entry.fact = mergeFact(
                entry.fact,
                { ...kinds, hex: each.hex, forms: new Map(), order: 0 },
                each.hex,
            );
            entry.uses += kinds.bg + kinds.text + kinds.border + kinds.fill + kinds.other;
        }
    }

    const lightRoles = chooseRoles(lightColors, namedLight);

    // A project with one background color, called a surface, has no other page color: the surface is the page too.
    if (lightRoles.background === undefined && lightRoles.surface?.basis === "name") {
        lightRoles.background = { ...lightRoles.surface, role: "background" };
        delete lightRoles.surface;
    }

    const hasDarkVars = classified.some((entry) => entry.variable.dark !== undefined);

    result.hasDark = hasDarkVars || (alt === "dark" && facts.darkColors.size > 0);

    const darkRoles: Partial<Record<RoleName, RoleChoice>> = result.hasDark
        ? chooseRoles(darkColors, namedDark)
        : {};

    const kindOf: Partial<Record<RoleName, "bg" | "text" | "border">> = {
        background: "bg",
        surface: "bg",
        text: "text",
        muted: "text",
        border: "border",
        accent: "text",
    };

    for (const [role, choice] of Object.entries(lightRoles) as [RoleName, RoleChoice][]) {
        const holder =
            choice.basis === "name"
                ? colorVars.find((entry) => entry.variable.name === choice.source)
                : colorVars
                      .filter((entry) => hexOf(entry.lightColor) === choice.hex)
                      .sort((a, b) => uses(b.variable) - uses(a.variable))[0];
        const dark = hexOf(holder?.darkColor);

        if (
            holder !== undefined &&
            dark !== undefined &&
            (choice.basis === "name" || dark !== choice.hex)
        ) {
            darkRoles[role] = { ...choice, hex: dark, basis: "name", source: holder.variable.name };
        }

        // A class that has a color in each mode (`.text-gray-900` and `.dark .text-gray-900`) pairs the two.
        const pair = !result.hasDark
            ? undefined
            : [...facts.classRules.values()].find(
                  (rule) =>
                      rule.kind === kindOf[role] &&
                      rule.dark !== undefined &&
                      rule.light === choice.hex &&
                      rule.dark !== choice.hex,
              );

        if (pair !== undefined && darkRoles[role]?.basis !== "name") {
            darkRoles[role] = {
                ...choice,
                hex: pair.dark!,
                basis: "use",
                source: "the same class in the dark mode",
            };
        }
    }

    // A brand or status color that a dark mode merely uses in another hue (links turn light blue) is not that role's
    // dark value: a role keeps its hue across modes.
    for (const role of ["accent", ...STATUS] as const) {
        const lightHex = lightRoles[role]?.hex;
        const before = lightHex === undefined ? undefined : entryOf(lightHex);
        const after = darkRoles[role]?.basis === "use" ? entryOf(darkRoles[role].hex) : undefined;

        if (
            before !== undefined &&
            after !== undefined &&
            before.c >= 0.05 &&
            after.c >= 0.05 &&
            hueGap(before.h, after.h) > 40
        ) {
            delete darkRoles[role];
        }
    }

    return { lightColors, darkColors, lightRoles, darkRoles };
}
