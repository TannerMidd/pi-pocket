import { dimensionCss } from "../src/server/design/lint-color.ts";
import { createPublicFetch } from "../src/server/public-fetch.ts";
import type { PocketHost } from "../src/server/host.ts";
import type { DesignBundle } from "../src/server/design/bundle.ts";
import { type CheckOptions, checkDesign } from "../src/server/design/lint.ts";
import type {
    CheckFinding,
    CheckReport,
    DesignSystem,
    ResolvedToken,
    TokenTier,
    TokenType,
} from "../src/server/design/system-types.ts";

export const host = { fetchPublic: createPublicFetch() } as PocketHost;

export function token(
    name: string,
    type: TokenType,
    value: unknown,
    dark?: unknown,
    tier: TokenTier = "semantic",
): ResolvedToken {
    const css = (item: unknown) => (typeof item === "string" ? item : "");

    return {
        path: name.split("."),
        name,
        cssVar: `--${name.replaceAll(".", "-")}`,
        type,
        tier,
        modes: {
            light: { value, css: css(value) },
            dark: { value: dark ?? value, css: css(dark ?? value) },
        },
    };
}

export function testSystem(): DesignSystem {
    return {
        name: "Test system",
        modes: ["light", "dark"],
        schemes: { light: "light", dark: "dark" },
        components: [],
        guidelines: "",
        problems: [],
        compiled: { css: "", tailwind: "", json: "", components: "" },
        tokens: [
            token("color.bg.page", "color", "#f6f7fb", "#101218"),
            token("color.bg.surface", "color", "#ffffff", "#1a1d27"),
            token("color.text.primary", "color", "#1c1e26", "#e6e8f0"),
            token("color.text.muted", "color", "#5a5f73", "#a0a5b8"),
            token("color.border.default", "color", "#8a90a6", "#4a4f63"),
            token("color.accent.default", "color", "#3b6cf6", "#7aa2f7"),
            token("color.accent.fg", "color", "#ffffff", "#101218"),
            token("color.blue.500", "color", "#3b6cf6", "#7aa2f7", "primitive"),
            token("font.body", "fontFamily", "system-ui, sans-serif"),
            token("font.mono", "fontFamily", ["JetBrains Mono", "monospace"]),
            token("font.size.sm", "dimension", "14px"),
            token("font.size.md", "dimension", "16px"),
            token("font.size.lg", "dimension", { value: 1.5, unit: "rem" }),
            token("space.2", "dimension", "8px"),
            token("space.3", "dimension", "12px"),
            token("space.4", "dimension", "16px"),
            token("space.6", "dimension", "24px"),
            token("radius.md", "dimension", "8px"),
        ],
    };
}

export function bundleOf(content: string, assets: DesignBundle["assets"] = []): DesignBundle {
    return { meta: { title: "Test", type: "html", versions: [] }, version: 1, content, assets };
}

const head =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';

export function tokensCss(system: DesignSystem = testSystem()): string {
    const lines = (mode: string) =>
        system.tokens
            .map((item) => {
                const value = item.modes[mode]!.value;
                const css =
                    typeof value === "string"
                        ? value
                        : Array.isArray(value)
                          ? value.join(", ")
                          : dimensionCss(value);

                return `${item.cssVar}:${css};`;
            })
            .join("");

    return `:root{${lines("light")}}@media (prefers-color-scheme: dark){:root{${lines("dark")}}}`;
}

// The body's own look uses the variables, so a page made of `var()`s alone is on the system.
export const page = (style: string, body: string) =>
    `${head}<style>${tokensCss()}body{margin:0;font-family:var(--font-body);font-size:var(--font-size-md);line-height:1.5;color:var(--color-text-primary);background:var(--color-bg-page)}${style}</style></head><body><main data-pid="page">${body}</main></body></html>`;

export function check(
    content: string,
    options: CheckOptions = {},
    system: DesignSystem | null = testSystem(),
    assets: DesignBundle["assets"] = [],
): Promise<CheckReport> {
    return checkDesign(
        bundleOf(content, assets),
        system ?? undefined,
        { viewport: "mobile", ...options },
        host,
    );
}

export const ofRule = (report: CheckReport, rule: string): CheckFinding[] =>
    report.findings.filter((finding) => finding.rule === rule);
export const onPid = (report: CheckReport, rule: string, pid: string): CheckFinding | undefined =>
    report.findings.find((finding) => finding.rule === rule && finding.pid === pid);
