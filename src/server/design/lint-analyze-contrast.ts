import { contrastOf, formatColor, type RgbaTuple, type TokenSet } from "./lint-color.ts";
import { nearestColor, nearestPassing as passing, SAME_COLOR } from "./lint-suggest.ts";
import type { RawPage } from "./lint-page.ts";
import {
    clip,
    elementOf,
    more,
    num,
    rgbaOf,
    rgbOf,
    tokenRef,
    weighted,
    type WeightedFinding,
} from "./lint-analyze-util.ts";

type ContrastGroup = NonNullable<RawPage["contrast"]>[number];

const nearestPassing = (
    set: TokenSet,
    fg: RgbaTuple,
    back: [number, number, number],
    needed: number,
    use?: string,
) => passing(set, fg, back, needed, contrastOf, use);

// A system that sets a field's border and fill owns that look: its contrast pairs are checked in the system.
function edgesOnSystem(group: ContrastGroup, tokens: TokenSet | undefined): boolean {
    const edges = (group.edges ?? []).map(rgbaOf);

    return (
        tokens !== undefined &&
        edges.length > 0 &&
        edges.every((edge) => {
            const near = edge === undefined ? undefined : nearestColor(tokens, edge);

            return near !== undefined && near.distance < SAME_COLOR;
        })
    );
}

function uiContrastFinding(
    group: ContrastGroup,
    tokens: TokenSet | undefined,
    fg: [number, number, number],
    bg: [number, number, number],
    shown: string,
): WeightedFinding {
    const part = group.what === "focus" || group.what === "icon" ? group.what : "field";
    const tag = clip(group.tag, 20);
    const found =
        tokens === undefined
            ? undefined
            : nearestPassing(
                  tokens,
                  [...fg, 1] as RgbaTuple,
                  bg,
                  3,
                  part === "icon" ? "text" : "border",
              );
    const property = part === "focus" ? "outline-color" : "color";
    const edit =
        found === undefined
            ? part === "field"
                ? " Give the border a stronger color."
                : ` Use ${part === "focus" ? "a ring" : "an icon"} color that reaches 3:1 on ${formatColor(bg)}.`
            : ` Set \`${property}: ${tokenRef(found.token)}\` (${formatColor(found.token.rgba!)}, ${found.ratio.toFixed(2)}:1)${part === "icon" ? " on the icon (or its `fill`)" : ""} instead of ${formatColor(fg)}.`;
    const what =
        part === "focus"
            ? `The focus ring of a <${tag}> is ${shown} against what is around it`
            : part === "icon"
              ? `The icon in a <${tag}> is ${shown} against what it sits on`
              : `The edge of a form field is ${shown} against what it sits on`;

    return weighted(
        {
            rule: "contrast",
            level: "warning",
            ...elementOf(group.el),
            value: shown,
            ...(found === undefined ? {} : { suggestion: tokenRef(found.token) }),
            message: `${what}; WCAG 1.4.11 needs 3:1${more(num(group.count))}.${edit}`,
        },
        num(group.count),
    );
}

function textContrastFinding(
    group: ContrastGroup,
    tokens: TokenSet | undefined,
    fg: [number, number, number],
    bg: [number, number, number],
    shown: string,
    needed: number,
): WeightedFinding {
    const swatch = (color: number[]) => formatColor(color);
    const pass =
        tokens === undefined
            ? undefined
            : nearestPassing(tokens, [...fg, 1] as RgbaTuple, bg, needed);

    return weighted(
        {
            rule: "contrast",
            level: "error",
            ...elementOf(group.el),
            value: shown,
            ...(pass === undefined ? {} : { suggestion: tokenRef(pass.token) }),
            message:
                `Text ${swatch(fg)} on ${swatch(bg)} is ${shown}; ${group.large ? "large text" : "text"} needs ${needed}:1${more(num(group.count))}.` +
                (pass === undefined
                    ? tokens === undefined
                        ? " Darken the `color` or lighten the `background-color`."
                        : " No system color passes on this background: change its `background-color`."
                    : ` Set \`color: ${tokenRef(pass.token)}\` (${swatch(pass.token.rgba!)}, ${pass.ratio.toFixed(2)}:1) instead of ${swatch(fg)}.${
                          pass.sameHue
                              ? ""
                              : ` No system color of its hue reaches ${needed}:1 here, so this one changes the hue.`
                      }`),
        },
        num(group.count),
    );
}

export function contrastFindings(raw: RawPage, tokens: TokenSet | undefined): WeightedFinding[] {
    const out: WeightedFinding[] = [];

    for (const group of raw.contrast ?? []) {
        const fg = rgbOf(group.fg);
        const bg = rgbOf(group.bg);

        if (fg === undefined || bg === undefined) {
            continue;
        }

        const ratio =
            group.ui && typeof group.ratio === "number" ? group.ratio : contrastOf(fg, bg);
        const needed = group.ui || group.large ? 3 : 4.5;

        if (ratio >= needed) {
            continue;
        }

        const shown = `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;

        if (!group.ui) {
            out.push(textContrastFinding(group, tokens, fg, bg, shown, needed));
        } else if (!edgesOnSystem(group, tokens)) {
            out.push(uiContrastFinding(group, tokens, fg, bg, shown));
        }
    }

    return out;
}
