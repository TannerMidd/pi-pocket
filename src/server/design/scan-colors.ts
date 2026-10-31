import { parseColor, type Rgba, toHex, toOklch } from "./color.ts";
import type { Category, ColorFact, VarFact } from "./scan-facts.ts";

export const w = (text: string) => text.split(" ");

export type Obj = Record<string, unknown>;

export const vkey = (variable: { kind: VarFact["kind"]; hint?: Category; name: string }) =>
    `${variable.kind === "theme" ? "css" : variable.kind}:${variable.hint ?? ""}:${variable.name}`;

export const kebab = (name: string) =>
    name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");

export const slug = (text: string) =>
    text
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);

export const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));

export function hexOf(text: string | undefined): string | undefined {
    const color = text === undefined ? undefined : parseColor(text);

    return color === undefined ? undefined : toHex(color);
}

export function normalizeColor(text: string): string {
    const trimmed = text.trim();

    return trimmed.startsWith("#") ? trimmed.toLowerCase() : trimmed.replace(/\s+/g, " ");
}

export type RoleName =
    | "background"
    | "surface"
    | "text"
    | "muted"
    | "border"
    | "accent"
    | "danger"
    | "warning"
    | "success";

export const ROLE_PATHS: Record<RoleName, string[]> = {
    background: ["color", "bg", "page"],
    surface: ["color", "bg", "surface"],
    text: ["color", "text", "primary"],
    muted: ["color", "text", "muted"],
    border: ["color", "border", "default"],
    accent: ["color", "accent", "default"],
    danger: ["color", "danger", "default"],
    warning: ["color", "warning", "default"],
    success: ["color", "success", "default"],
};

export const ROLES = Object.keys(ROLE_PATHS) as RoleName[];

export interface ColorEntry {
    hex: string;
    rgba: Rgba;
    l: number;
    c: number;
    h: number;
    /** The Oklab a and b, kept so that a distance costs no trigonometry. */
    la: number;
    lb: number;
    uses: number;
    fact: ColorFact | undefined;
    names: { name: string; uses: number }[];
    text: string;
}

export const entryOf = (hex: string, text = hex): ColorEntry | undefined => {
    const rgba = parseColor(hex);

    if (rgba === undefined) {
        return undefined;
    }

    const { l, c, h } = toOklch(rgba);
    const rad = (h * Math.PI) / 180;

    return {
        hex,
        rgba,
        l,
        c,
        h,
        la: c * Math.cos(rad),
        lb: c * Math.sin(rad),
        uses: 0,
        fact: undefined,
        names: [],
        text,
    };
};

// A hair apart, or the same gray a shade apart (`#ddd`, `#e0e0e0`); pure white and black are decisions, not shades.
export function nearColors(a: ColorEntry, b: ColorEntry, threshold = 0.0065): boolean {
    if ([a.hex, b.hex].some((hex) => hex === "#ffffff" || hex === "#000000")) {
        return distance(a, b) < Math.min(threshold, 0.003);
    }

    const chroma = Math.hypot(a.la - b.la, a.lb - b.lb);

    return distance(a, b) < threshold || (chroma < 0.004 && Math.abs(a.l - b.l) < 0.0095);
}

// Oklab distance; about 0.02 is just visible.
export function distance(a: ColorEntry, b: ColorEntry): number {
    return Math.hypot(a.l - b.l, a.la - b.la, a.lb - b.lb);
}

const totalUses = (fact: ColorFact | undefined) =>
    fact === undefined ? 0 : fact.bg + fact.text + fact.border + fact.fill + fact.other;

const MAX_COLORS = 300;

// Variables are the project's own names and are never merged with each other; only literal uses fold into them.
export function mergeColors(
    defined: { hex: string; text: string }[],
    uses: Map<string, ColorFact>,
    threshold = 0.0065,
): Map<string, ColorEntry> {
    const out = new Map<string, ColorEntry>();

    for (const color of defined.slice(0, MAX_COLORS * 2)) {
        if (!out.has(color.hex)) {
            const entry = entryOf(color.hex, color.text);

            if (entry !== undefined) {
                out.set(color.hex, entry);
            }
        }
    }

    const rest = [...uses.values()]
        .sort(
            (a, b) =>
                totalUses(b) - totalUses(a) || a.order - b.order || a.hex.localeCompare(b.hex),
        )
        .slice(0, MAX_COLORS);
    const pool = [...out.values()];

    for (const fact of rest) {
        const entry = entryOf(
            fact.hex,
            [...fact.forms].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fact.hex,
        );

        if (entry === undefined) {
            continue;
        }

        const target =
            out.get(fact.hex) ??
            pool.find(
                (other) =>
                    Math.abs(other.rgba.a - entry.rgba.a) < 0.05 &&
                    nearColors(other, entry, threshold),
            );

        if (target !== undefined) {
            target.uses += totalUses(fact);
            target.fact = merge(target.fact, fact, target.hex);
        } else {
            entry.uses = totalUses(fact);
            entry.fact = merge(undefined, fact, entry.hex);
            pool.push(entry);
            out.set(entry.hex, entry);
        }
    }

    return out;
}

export function merge(into: ColorFact | undefined, more: ColorFact, hex: string): ColorFact {
    const fact: ColorFact = into ?? {
        hex,
        forms: new Map(),
        bg: 0,
        text: 0,
        border: 0,
        fill: 0,
        shadow: 0,
        other: 0,
        root: 0,
        body: 0,
        surface: 0,
        order: more.order,
    };

    for (const key of [
        "bg",
        "text",
        "border",
        "fill",
        "shadow",
        "other",
        "root",
        "body",
        "surface",
    ] as const) {
        fact[key] += more[key];
    }

    for (const [form, count] of more.forms) {
        fact.forms.set(form, (fact.forms.get(form) ?? 0) + count);
    }

    if (fact.at === undefined && more.at !== undefined) {
        fact.at = more.at;
    }

    return fact;
}

export function family(color: { c: number; h: number }): string {
    if (color.c < 0.045) {
        return "gray";
    }

    const h = color.h;

    if (h >= 335 || h < 10) {
        return "pink";
    }

    const table: [number, string][] = [
        [40, "red"],
        [70, "orange"],
        [105, "yellow"],
        [135, "lime"],
        [170, "green"],
        [200, "teal"],
        [225, "cyan"],
        [270, "blue"],
        [295, "indigo"],
        [335, "purple"],
    ];

    return table.find(([limit]) => h < limit)![1];
}

export const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

export function step(l: number): number {
    const limits: [number, number][] = [
        [0.976, 50],
        [0.9475, 100],
        [0.9, 200],
        [0.79, 300],
        [0.629, 400],
        [0.4985, 500],
        [0.41, 600],
        [0.3255, 700],
        [0.244, 800],
        [0.17, 900],
    ];

    return limits.find(([limit]) => l > limit)?.[1] ?? 950;
}

export function paletteName(color: ColorEntry, taken: Set<string>): string[] {
    if (color.hex === "#ffffff" && !taken.has("color.white")) {
        return ["color", "white"];
    }

    if (color.hex === "#000000" && !taken.has("color.black")) {
        return ["color", "black"];
    }

    const fam = family(color);
    const alpha = color.rgba.a < 0.995 ? `-a${Math.round(color.rgba.a * 100)}` : "";
    const base = STEPS.indexOf(step(color.l) as (typeof STEPS)[number]);

    // The nearest free step, no farther than the next one: a color two steps off is a different color, so it takes a
    // suffix (`400-2`) instead of a wrong step.
    for (let offset = 0; offset <= 1; offset++) {
        for (const at of offset === 0 ? [base] : [base - offset, base + offset]) {
            if (at >= 0 && at < STEPS.length) {
                const path = ["color", fam, `${STEPS[at]}${alpha}`];

                if (!taken.has(path.join("."))) {
                    return path;
                }
            }
        }
    }

    let n = 2;

    while (taken.has(`color.${fam}.${STEPS[base]}${alpha}-${n}`)) {
        n += 1;
    }

    return ["color", fam, `${STEPS[base]}${alpha}-${n}`];
}

export function words(rawName: string): string[] {
    const all = rawName
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        // `font-color-base` (Infima) is the text color, not a font.
        .replace(/font[-_]colou?r/gi, "text-color")
        .replace(/([a-z]{3,})(\d{1,3})(?![\d-])/gi, "$1-$2")
        .toLowerCase()
        .split(/[-_.\s]+/);
    const found = all.filter(
        (word) =>
            word !== "" &&
            !w(
                "color colour clr c theme tw ui sys md ref palette colors var bs ifm sl mui ant chakra mantine pico vt wp preset custom",
            ).includes(word),
    );

    // `secondary-color` and `tertiary-color` name quiet text: the word `color` says it is a text color.
    return all.at(-1) === "color" &&
        found.some((word) => w("secondary tertiary muted subtle dim faint quiet").includes(word)) &&
        !found.includes("bg") &&
        !found.includes("background") &&
        !found.includes("border")
        ? ["text", ...found]
        : found;
}

const STATE = w("hover active focus pressed disabled selected checked visited ring");
const SURFACEISH = w(
    "surface card panel elevated raised container popover modal dialog sheet input button btn header footer nav navbar sidebar menu tooltip toast overlay code table row layer tile well component",
);
const OTHER_ROLE = w(
    "accent danger error warning success info brand destructive critical secondary tertiary link border outline divider bad good ok positive negative note notice caution warn pass fail",
);
const VARIANT = w(
    "bg background subtle soft light lighter muted tint container border outline hover active focus pressed disabled faint",
);
const INK = w("foreground fg text on contrast inverse inverted content");
const STATUS_WORDS = {
    danger: [
        w(
            "danger error destructive critical negative invalid alert err bad fail failed failure wrong fatal severe",
        ),
        ["red"],
    ],
    warning: [w("warning warn caution attention alertness moderate"), w("amber orange yellow")],
    success: [
        w("success positive valid ok confirm safe good pass passed done"),
        w("green emerald"),
    ],
} as const;
const ACCENT_WEIGHTS: Record<string, number> = {
    primary: 50,
    brand: 50,
    accent: 45,
    highlight: 30,
    key: 20,
    link: 25,
    cta: 25,
    action: 25,
    interactive: 25,
    main: 20,
    theme: 12,
};

const has = (segs: string[], list: readonly string[]) => segs.some((seg) => list.includes(seg));
const plain = (segs: string[], words: string) =>
    segs.length <= 2 && segs.every((seg) => w(words).includes(seg) || /^\d{1,3}$/.test(seg));

export function nameScore(role: RoleName, segs: string[]): number {
    if (
        segs.length === 0 ||
        has(
            segs,
            w("rgb hsl channels channel alpha opacity radius width shadow size font gradient"),
        )
    ) {
        return 0;
    }

    const state = has(segs, STATE);

    switch (role) {
        case "background": {
            // `body` alone is the body text in many systems (`--body`); `body-bg` is the page.
            const strong = has(segs, w("bg background page canvas window root"));
            const base = segs.includes("base") && segs.some((seg) => /^\d/.test(seg));

            if (state || has(segs, [...SURFACEISH, ...OTHER_ROLE]) || (!strong && !base)) {
                return 0;
            }

            // `bg-primary` is the page in many systems and the brand in others: the caller checks the color.
            return (
                (strong ? 70 : 55) +
                (plain(
                    segs,
                    "bg background page canvas body base main app root default window primary 1 0",
                )
                    ? 25
                    : 0)
            );
        }

        case "surface": {
            const named = has(
                segs,
                w(
                    "surface card panel elevated raised container popover layer sheet tile well paper component",
                ),
            );
            const layered =
                has(segs, ["bg", "background"]) &&
                has(segs, w("secondary alt subtle muted elevated raised tertiary soft mute"));
            const base = segs.includes("base") && segs.some((seg) => /^[2-9]\d{2}$/.test(seg));

            if (
                state ||
                has(segs, [
                    ...INK,
                    ...w(
                        "accent danger error warning success info brand link border outline divider",
                    ),
                ]) ||
                (!named && !layered && !base)
            ) {
                return 0;
            }

            return (
                (named ? 70 : layered ? 62 : 50) +
                (plain(
                    segs,
                    "surface card panel bg background default elevated raised container secondary alt subtle muted popover",
                )
                    ? 25
                    : 0)
            );
        }

        case "text": {
            const ink = has(segs, w("text fg foreground ink content copy"));
            const onBase = segs.includes("on") && has(segs, ["surface", "background", "bg"]);
            const body =
                has(segs, ["body", "font"]) && segs.length <= 2 && !has(segs, ["bg", "background"]);

            if (
                state ||
                // `on-surface-variant` (Material 3) is the quieter text; so are `text-2` and `ink-3`.
                (onBase && segs.includes("variant")) ||
                (ink && segs.some((seg) => /^[2-4]$/.test(seg))) ||
                has(
                    segs,
                    w(
                        "muted secondary subtle dim dimmed faint tertiary disabled inverse inverted link heading quiet soft weak hint",
                    ),
                ) ||
                (has(
                    segs,
                    w(
                        "accent primary danger error warning success info brand destructive card popover sidebar",
                    ),
                ) &&
                    !plain(segs, "text primary fg foreground default")) ||
                (!ink && !onBase && !body)
            ) {
                return 0;
            }

            return (
                (ink ? 70 : onBase ? 62 : 42) +
                (plain(segs, "text fg foreground primary default base main body ink content 1 0")
                    ? 25
                    : 0)
            );
        }

        case "muted": {
            const inks = w("text fg foreground content ink");
            // `secondary` and `tertiary` also name a brand's second color, whose pair is `secondary-foreground`: they
            // are quiet text only when the text word comes first (`text-secondary`, `fg-tertiary`).
            const inkAt = segs.findIndex((seg) => inks.includes(seg));
            const weakAt = segs.findIndex((seg) => ["secondary", "tertiary"].includes(seg));
            const quiet =
                has(
                    segs,
                    w("muted subtle dim dimmed faint faded soft weak hint quiet caption meta"),
                ) ||
                (weakAt >= 0 && inkAt >= 0 && inkAt < weakAt);

            if (
                segs.includes("on") &&
                segs.includes("variant") &&
                has(segs, ["surface", "background", "bg"])
            ) {
                return 78;
            }

            if (
                (state && !segs.includes("placeholder")) ||
                has(
                    segs,
                    w("bg background card surface border accent danger error warning success"),
                )
            ) {
                return 0;
            }

            if (quiet && inkAt >= 0) {
                return 80;
            }

            if (segs.includes("placeholder")) {
                return 50;
            }

            if (inkAt >= 0 && segs.some((seg) => /^[2-4]$/.test(seg))) {
                return 70;
            }

            // A name that is only the word is the quiet text; `muted` alone is often a tint of the background (shadcn).
            return segs.length !== 1
                ? 0
                : segs[0] === "muted"
                  ? 45
                  : w("subtle faint faded dim quiet weak hint").includes(segs[0]!)
                    ? 62
                    : 0;
        }

        case "border": {
            if (
                !has(
                    segs,
                    w("border outline divider separator stroke line hairline rule rim edge"),
                ) ||
                state ||
                has(
                    segs,
                    w(
                        "radius width style focus accent primary danger error success warning bg background",
                    ),
                )
            ) {
                return 0;
            }

            return (
                70 +
                (plain(segs, "border default base subtle muted light divider separator line color")
                    ? 25
                    : 0)
            );
        }

        case "accent": {
            const best = Math.max(0, ...segs.map((seg) => ACCENT_WEIGHTS[seg] ?? 0));

            if (best === 0 || state || has(segs, INK) || has(segs, ["info"])) {
                return 0;
            }

            // A step of a palette (`brand-500`) is the last choice, after a role name (`primary`); of the steps, the middle.
            const step = !segs.some((seg) => /^\d{2,3}$/.test(seg))
                ? 0
                : segs.includes("500")
                  ? -9
                  : segs.includes("600")
                    ? -12
                    : -15;

            return (
                best +
                30 +
                step -
                (has(segs, VARIANT) ? 40 : 0) +
                (plain(segs, "accent primary brand default main 500 600 base link key") ? 10 : 0)
            );
        }

        default: {
            const [named, hue] = STATUS_WORDS[role];
            const base = has(segs, named) ? 70 : has(segs, hue) ? 48 : 0;

            if (state || has(segs, INK) || base === 0) {
                return 0;
            }

            return (
                base -
                (has(segs, VARIANT) ? 28 : 0) +
                (plain(segs, [...named, ...hue, "default", "base", "main"].join(" ")) ? 25 : 0)
            );
        }
    }
}
