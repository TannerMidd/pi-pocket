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

export type TokenTier = "primitive" | "semantic" | "component";

export interface ModeValue {
    value: unknown;
    css: string;
    literal?: string;
    hex?: string;
    parts?: Record<string, string>;
    alias?: string;
    contrast?: {
        on: string;
        ratio: number;
        min: number;
        pass: boolean;
        exempt?: ContrastExemption;
    };
}

export type ContrastExemption = "disabled" | "decorative";

export interface ResolvedToken {
    path: string[];
    name: string;
    cssVar: string;
    type: TokenType;
    tier: TokenTier;
    description?: string;
    /** True, or a note on what to use instead. */
    deprecated?: boolean | string;
    /** The value in each mode, by mode name. Every mode of the system is present. */
    modes: Record<string, ModeValue>;
    contrast?: { on: string; min: number; exempt?: ContrastExemption };
    /** Every contrast pair the token declares, in order (`contrast` is the first). */
    contrasts?: { on: string; min: number; exempt?: ContrastExemption }[];
    tailwind?: string;
}

export interface ComponentSpec {
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
    tokens: string[];
}

export interface SystemProblem {
    /** An error stops a write, a warning does not, and an `info` (in `DesignSystem.notes` only) needs no action. */
    level: "error" | "warning" | "info";
    file?: string;
    token?: string;
    message: string;
    fix?: string;
}

export interface CompiledFiles {
    css: string;
    tailwind: string;
    json: string;
    components: string;
    modes?: Record<string, string>;
    studio?: string;
    names?: string;
}

export interface DesignSystem {
    name: string;
    description?: string;
    /** Mode names; the first is the default (the one in `tokens.json`). */
    modes: string[];
    schemes: Record<string, "light" | "dark">;
    tokens: ResolvedToken[];
    overrides?: Record<string, string[]>;
    tailwindReset?: string[];
    /** The DTCG draft of the per-mode files, from `$extensions["com.pi-pocket"].format`: `"2021"` (the default) or `"2025.10"`. */
    dtcgFormat?: "2021" | "2025.10";
    components: ComponentSpec[];
    /** `guidelines.md`, bounded. Untrusted project text. */
    guidelines: string;
    problems: SystemProblem[];
    notes?: SystemProblem[];
    compiled: CompiledFiles;
}

// The engine applies the fields in this order: `tokens`, `modes`, `name`/`description`, `set`, `remove`, `components`, `guidelines`.
export interface SystemChange {
    tokens?: unknown;
    modes?: Record<string, unknown | null>;
    name?: string;
    description?: string;
    // A token that is new in the default mode needs a `type` (or a value the engine can read the type from).
    set?: { mode: string; token: string; value: unknown; type?: TokenType; description?: string }[];
    remove?: { mode: string; token: string }[];
    components?: Record<string, string | null>;
    guidelines?: string;
}

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

export interface CheckFix {
    kind: "color" | "length" | "font";
    properties: string[];
    literal: string;
    token: string;
    cssVar: string;
    mode: string;
}

export interface CheckFinding {
    // Stable across runs: the rule and a hash of the element (its `data-pid`, else its selector) and the value, so a pin can follow a finding. A second finding with the same hash gets `-2`, `-3`.
    id?: string;
    fix?: CheckFix;
    rule: CheckRule;
    level: "error" | "warning";
    selector: string;
    pid?: string;
    value?: string;
    suggestion?: string;
    message: string;
    rect?: { x: number; y: number; width: number; height: number };
    // `selector`, `pid`, and `rect` are the first element's. Present only when there are two or more.
    elements?: {
        selector: string;
        pid?: string;
        rect?: { x: number; y: number; width: number; height: number };
    }[];
}

export interface CheckReport {
    viewport: { width: number; height: number };
    colorScheme: "light" | "dark";
    mode?: string;
    findings: CheckFinding[];
    // Not counted as errors or warnings, and not in `byRule`.
    accepted?: CheckFinding[];
    summary: {
        errors: number;
        warnings: number;
        elements: number;
        byRule: Partial<Record<CheckRule, number>>;
        accepted?: number;
        notJudged?: { contrast: { count: number; elements: string[] } };
    };
    withoutSystem: boolean;
}
