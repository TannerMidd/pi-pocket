/**
 * The shared shapes of a design system (docs/design/design-system.md): what the tokens engine (`tokens.ts`) loads and
 * writes, what the checks (`lint.ts`) report, what the docs page (`docsite.ts`) renders, and what the Design workspace
 * shows. Owned by stream T; the other streams import it and do not change it without a note.
 */

/** The DTCG token types that the engine understands. */
export type TokenType =
    | "color"
    | "dimension"
    | "fontFamily"
    | "fontWeight"
    | "duration"
    | "cubicBezier"
    | "number"
    | "shadow"
    | "typography"
    | "border"
    | "transition"
    | "gradient"
    | "strokeStyle";

/** Where a token sits: a raw value, a role that names what a value is for, or a part of one component. */
export type TokenTier = "primitive" | "semantic" | "component";

/** A token's value in one mode, resolved (no reference left), with its CSS text. */
export interface ModeValue {
    /** The resolved DTCG value (a string, a number, or a DTCG object such as a color or a shadow). */
    value: unknown;
    /** The CSS for the value: `#7aa2f7`, `16px`, `0 1px 2px rgb(0 0 0 / 0.2)`, `var(--color-blue-500)` for a reference. */
    css: string;
    /** The CSS with every reference replaced by its value, so it needs no variable: `#7aa2f7` for an alias. Always set by the engine. */
    literal?: string;
    /** A color's `#rrggbb` (`#rrggbbaa` with alpha) in sRGB, for a picker or a label. Colors only, when the value is not `currentColor`. */
    hex?: string;
    /** A typography token's members as CSS, by property (`font-size`, `line-height`, `font-family`, `font-weight`, `letter-spacing`). */
    parts?: Record<string, string>;
    /** The referenced token's name when the raw value in this mode is a reference (`color.blue.500`). */
    alias?: string;
    /** The result of the token's contrast pair in this mode (only on a token that declares one). */
    contrast?: {
        on: string;
        ratio: number;
        min: number;
        pass: boolean;
        exempt?: ContrastExemption;
    };
}

/** Why a text pair is left out of the contrast check (WCAG exempts disabled controls and decoration). */
export type ContrastExemption = "disabled" | "decorative";

/** One token, resolved. */
export interface ResolvedToken {
    /** The path of group names and the token's name: `["color", "bg", "surface"]`. */
    path: string[];
    /** The path joined by dots: `color.bg.surface`. */
    name: string;
    /** The CSS custom property: `--color-bg-surface`. */
    cssVar: string;
    type: TokenType;
    tier: TokenTier;
    description?: string;
    /** True, or a note on what to use instead. */
    deprecated?: boolean | string;
    /** The value in each mode, by mode name. Every mode of the system is present. */
    modes: Record<string, ModeValue>;
    /** The contrast this text color must reach against another token, in every mode. The first pair when it declares several. */
    contrast?: { on: string; min: number; exempt?: ContrastExemption };
    /** Every contrast pair the token declares, in order (`contrast` is the first). */
    contrasts?: { on: string; min: number; exempt?: ContrastExemption }[];
    /** The Tailwind variable that `$extensions["com.pi-pocket"].tailwind` names for this token (`--color-brand`). */
    tailwind?: string;
}

/** One component specimen (`.pi/design/components/<slug>.html`). */
export interface ComponentSpec {
    /** The file's name without `.html`: lowercase letters, digits, and hyphens. */
    slug: string;
    name: string;
    description: string;
    /** The states the file has a template for, in its order. The first is the default. */
    states: string[];
    /** The markup of each state, by state name. Untrusted: shown only in a sandboxed frame. */
    markup: Record<string, string>;
    /** The component's CSS. Untrusted: shown only in a sandboxed frame. */
    css: string;
    usage?: { do: string[]; dont: string[] };
    /** The token names that the component uses. */
    tokens: string[];
}

/** A problem that the validator found. An error stops a write; a warning does not. */
export interface SystemProblem {
    /** An error stops a write, a warning does not, and an `info` (in `DesignSystem.notes` only) needs no action. */
    level: "error" | "warning" | "info";
    /** The file it is in, relative to `.pi/design/` (`tokens.dark.json`, `components/button.html`). */
    file?: string;
    /** The token it is about. */
    token?: string;
    message: string;
    /** What to do about it, as one sentence, when there is a clear step (`rename space.16 to a role`). */
    fix?: string;
}

/** The generated files in `.pi/design/dist/`. */
export interface CompiledFiles {
    /** `tokens.css`: `:root` for the default mode, `[data-theme="<mode>"]` for each other, and a dark media query. */
    css: string;
    /** `tailwind.css`: a Tailwind v4 `@theme` block that maps to the same variables. */
    tailwind: string;
    /** `tokens.resolved.json`: a compact summary of every token and mode, secondary to the per-mode DTCG files. */
    json: string;
    /** `components.css`: the CSS of every component. */
    components: string;
    /**
     * `tokens.<mode>.resolved.json`, by mode name: DTCG files with every reference followed, one `$value` for each
     * token, for tools that read DTCG (Style Dictionary, Tokens Studio).
     */
    modes?: Record<string, string>;
    /** `tokens.studio.json`: one file for Tokens Studio, with a token set for each mode and a `$themes` array. */
    studio?: string;
    /** `names.md`: every token with its variable in `tokens.css` and `tailwind.css` and its Tailwind utilities. */
    names?: string;
}

/** A project's design system, loaded and checked. */
export interface DesignSystem {
    /** From `$extensions["com.pi-pocket"].name` in `tokens.json`, else the folder's name. */
    name: string;
    description?: string;
    /** Mode names; the first is the default (the one in `tokens.json`). */
    modes: string[];
    /** Whether each mode is light or dark (its `colorScheme`, else its name), for `color-scheme` and the media query. */
    schemes: Record<string, "light" | "dark">;
    tokens: ResolvedToken[];
    /** The tokens each mode file sets itself (the rest are inherited from the default mode), by mode name. */
    overrides?: Record<string, string[]>;
    /** The Tailwind namespaces whose defaults `tailwind.css` clears (`--color-*: initial;`), from `tailwindReset`. */
    tailwindReset?: string[];
    /**
     * Which DTCG draft the per-mode files follow, from `$extensions["com.pi-pocket"].format`: `"2021"` (the default; a
     * color is `"#7aa2f7"`, a dimension `"16px"`) or `"2025.10"` (`{ colorSpace, components, alpha, hex }` and `{ value, unit }`).
     */
    dtcgFormat?: "2021" | "2025.10";
    components: ComponentSpec[];
    /** `guidelines.md`, bounded. Untrusted project text. */
    guidelines: string;
    problems: SystemProblem[];
    /** Notes that need no action (`level: "info"`): a contrast pair that is exempt. Not counted as problems. */
    notes?: SystemProblem[];
    compiled: CompiledFiles;
}

/**
 * A change to write. Each field is optional; what is left out stays. `tokens` and `modes` replace whole files;
 * `set` changes single tokens in place (the Design workspace's editor uses it). The engine applies the fields in this
 * order: `tokens`, `modes`, `name`/`description`, `set`, `remove`, `components`, `guidelines`.
 */
export interface SystemChange {
    /** The whole `tokens.json` (a DTCG object). */
    tokens?: unknown;
    /** Whole mode files, by mode name; `null` removes a mode. */
    modes?: Record<string, unknown | null>;
    /** The system's name and description (kept in `tokens.json`). */
    name?: string;
    description?: string;
    /**
     * Single token values, by mode (the default mode's name for `tokens.json`; any other valid mode name makes or
     * edits `tokens.<mode>.json`) and token name. `value` is a DTCG `$value`, or a whole token object with `$value`.
     * A token that is new in the default mode needs a `type` (or a value the engine can read the type from).
     */
    set?: { mode: string; token: string; value: unknown; type?: TokenType; description?: string }[];
    /** Tokens to delete from a mode (from the default mode: the token itself); empty groups go too. */
    remove?: { mode: string; token: string }[];
    /** Component files, by slug; `null` removes one. */
    components?: Record<string, string | null>;
    guidelines?: string;
    /**
     * Where the code's tokens came from (a resync), kept on the root of `tokens.json` as
     * `$extensions["com.pi-pocket"].source`: the folder that was scanned, when, and how many tokens it found. The rest of
     * the block stays as it is.
     */
    source?: { path: string; scannedAt: string; tokens: number };
}

/** The rules that `checkDesign` applies. */
export type CheckRule =
    | "off-system-color"
    | "off-system-font"
    | "off-system-size"
    | "contrast"
    | "tap-target"
    | "overflow"
    | "image-alt"
    | "heading-order"
    | "font-fallback"
    | "missing-viewport"
    | "missing-pid"
    | "focus-visible"
    | "reduced-motion"
    | "missing-lang"
    | "missing-main"
    | "form-label"
    | "accessible-name"
    | "input-zoom";

/**
 * What a one-tap fix would change, on a finding whose literal equals a token exactly (`applyExactFixes` in `fix.ts`).
 * A finding with this field is fixable.
 */
export interface CheckFix {
    kind: "color" | "length" | "font";
    /** The CSS properties that hold the literal, longhands and the shorthands that can carry it: `["background-color", "background"]`. */
    properties: string[];
    /** The literal as the finding names it: `#5a5f73`, `16px`, `Geist, system-ui, sans-serif`. */
    literal: string;
    /** The token that takes its place: its name (`color.text.muted`) and its custom property (`--color-text-muted`). */
    token: string;
    cssVar: string;
    /** The mode that the literal equals the token in. */
    mode: string;
}

/** One finding of `checkDesign`. */
export interface CheckFinding {
    /**
     * Stable across runs: the rule and a hash of the element (its `data-pid`, else its selector) and the value, so a pin
     * can follow a finding. A second finding with the same hash gets `-2`, `-3`.
     */
    id?: string;
    /** Present when the finding can be fixed with no choice to make: see `CheckFix`. */
    fix?: CheckFix;
    rule: CheckRule;
    level: "error" | "warning";
    /** The element, as the inspector names it. Empty for a page-level finding. */
    selector: string;
    pid?: string;
    /** The value that breaks the rule: `#7ba3f8`, `15px`, `3.1:1`. */
    value?: string;
    /** What to use instead, when there is one: `var(--color-accent-default)`. */
    suggestion?: string;
    message: string;
    rect?: { x: number; y: number; width: number; height: number };
    /**
     * Findings of one rule with the same value, suggestion, and message are one finding: the elements, the first included
     * (`selector`, `pid`, and `rect` are the first's). Present only when there are two or more. A pin for each.
     */
    elements?: {
        selector: string;
        pid?: string;
        rect?: { x: number; y: number; width: number; height: number };
    }[];
}

/** What `checkDesign` returns. */
export interface CheckReport {
    /** The viewport the page was checked at. */
    viewport: { width: number; height: number };
    colorScheme: "light" | "dark";
    /** The system mode that the page was compared with (absent without a system). */
    mode?: string;
    findings: CheckFinding[];
    /**
     * Findings that a person accepted on purpose (the ids given in `CheckOptions.accepted`): reported apart, not counted as
     * errors or warnings, and not in `byRule`.
     */
    accepted?: CheckFinding[];
    /** Counts by rule and level, and how many elements were checked. */
    summary: {
        errors: number;
        warnings: number;
        elements: number;
        byRule: Partial<Record<CheckRule, number>>;
        /** How many findings were accepted (the length of `accepted`). */
        accepted?: number;
        /**
         * What was not judged, so that silence can be trusted: text whose contrast was left out because what is behind it is
         * not certain (a gradient, an image, an overlay, a filter, a faded parent). `elements` names up to 8.
         */
        notJudged?: { contrast: { count: number; elements: string[] } };
    };
    /** True when the system was absent, so no off-system rule ran. */
    withoutSystem: boolean;
}
