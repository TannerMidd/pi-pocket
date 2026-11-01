import type { TokenSet } from "./lint-color.ts";
import type { RawPage } from "./lint-page.ts";
import {
    clip,
    elementOf,
    lengthsOf,
    more,
    num,
    plural,
    tokenRef,
    weighted,
    type WeightedFinding,
} from "./lint-analyze-util.ts";

export const MOTION_MS = 500;

export interface AnalyzeContext {
    deck?: boolean;
    phone?: boolean;
}

export function targetFindings(raw: RawPage): WeightedFinding[] {
    const out: WeightedFinding[] = [];

    for (const group of raw.targets ?? []) {
        const width = num(group.width);
        const height = num(group.height);
        const level = group.level === "error" ? "error" : "warning";

        out.push(
            weighted(
                {
                    rule: "tap-target",
                    level,
                    ...elementOf(group.el),
                    value: `${width}×${height}px`,
                    message:
                        level === "error"
                            ? `A <${clip(group.tag, 20)}> target is ${width}×${height} px, under the 24×24 px minimum of WCAG 2.2${more(num(group.count))}. Set \`min-width: 44px; min-height: 44px\` (or padding) on it.`
                            : `A <${clip(group.tag, 20)}> target is ${width}×${height} px; 44×44 px is easier to hit on a phone${more(num(group.count))}. Set \`min-width: 44px; min-height: 44px\` (or padding) on it.`,
                },
                num(group.count),
            ),
        );
    }

    return out;
}

export function overflowFindings(raw: RawPage, context: AnalyzeContext): WeightedFinding[] {
    if (raw.overflow === undefined || context.deck === true) {
        return [];
    }

    const { scrollWidth, clientWidth, clipped, offenders } = raw.overflow;

    return [
        weighted({
            rule: "overflow",
            level: clipped ? "warning" : "error",
            ...elementOf(raw.overflow.el),
            value: `${num(scrollWidth)}px in ${num(clientWidth)}px`,
            message: clipped
                ? `Content reaches ${num(scrollWidth)} px in a ${num(clientWidth)} px viewport and is cut off (${plural(num(offenders), "element")} end past the edge).`
                : `The page scrolls sideways: ${num(scrollWidth)} px wide in a ${num(clientWidth)} px viewport${raw.overflow.el === undefined ? "" : `, with the widest element ending past the edge (${plural(num(offenders), "element")} do)`}. Let it wrap, shrink, or scroll inside its own box.`,
        }),
    ];
}

export function imageFindings(raw: RawPage): WeightedFinding[] {
    const out: WeightedFinding[] = [];

    for (const group of raw.images ?? []) {
        out.push(
            weighted(
                {
                    rule: "image-alt",
                    level: "error",
                    ...elementOf(group.el),
                    message: `An image has ${clip(group.why, 60)}${more(num(group.count))}. Add \`alt="what it shows"\`, or \`alt=""\` if it is decoration.`,
                },
                num(group.count),
            ),
        );
    }

    return out;
}

export function headingFindings(raw: RawPage): WeightedFinding[] {
    const out: WeightedFinding[] = [];

    for (const group of raw.headings ?? []) {
        out.push(
            weighted({
                rule: "heading-order",
                level: "warning",
                ...elementOf(group.el),
                value: `h${num(group.level)} after h${num(group.previous)}`,
                message: `A heading jumps from level ${num(group.previous)} to ${num(group.level)}. Change the tag to <h${num(group.previous) + 1}> and keep its look with CSS.`,
            }),
        );
    }

    return out;
}

export function fontFaceFindings(raw: RawPage): WeightedFinding[] {
    const out: WeightedFinding[] = [];

    for (const group of raw.fontFaces ?? []) {
        const family = clip(group.family, 120);

        out.push(
            weighted(
                {
                    rule: "font-fallback",
                    level: group.failed ? "error" : "warning",
                    ...elementOf(group.el),
                    value: family,
                    message: `Font "${family}" is used but ${clip(group.why, 100)}, so the text falls back to another font${more(num(group.count))}. Load the font (an @font-face file in the bundle, or a public HTTPS stylesheet).`,
                },
                num(group.count),
            ),
        );
    }

    return out;
}

export function viewportFindings(raw: RawPage, context: AnalyzeContext): WeightedFinding[] {
    if (raw.hasViewportMeta !== false || context.deck === true) {
        return [];
    }

    return [
        weighted({
            rule: "missing-viewport",
            level: "error",
            selector: "",
            message:
                'The page has no viewport meta tag, so a phone shows it zoomed out. Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
        }),
    ];
}

export function focusFindings(raw: RawPage, tokens: TokenSet | undefined): WeightedFinding[] {
    const out: WeightedFinding[] = [];

    for (const group of raw.focus ?? []) {
        const tag = clip(group.tag, 20);

        out.push(
            weighted(
                {
                    rule: "focus-visible",
                    level: "warning",
                    ...elementOf(group.el),
                    message: `A <${tag}> shows no focus style: ${group.outlineNone ? "its outline is removed and nothing else changes" : "nothing changes"} when a keyboard focuses it${more(num(group.count))}. Add a :focus-visible rule, such as outline: 2px solid ${tokens?.colors.find((token) => /focus|ring/i.test(token.name)) === undefined ? "an accent color" : tokenRef(tokens.colors.find((token) => /focus|ring/i.test(token.name))!)}.`,
                },
                num(group.count),
            ),
        );
    }

    return out;
}

export function landmarkFindings(raw: RawPage, context: AnalyzeContext): WeightedFinding[] {
    const out: WeightedFinding[] = [];
    const semantics = raw.semantics;

    if (semantics !== undefined && semantics.lang === false) {
        out.push(
            weighted({
                rule: "missing-lang",
                level: "error",
                ...elementOf(semantics.html),
                message:
                    'The page has no lang attribute on <html>, so a screen reader has to guess its language (WCAG 3.1.1). Set `<html lang="en">`, with the page\'s own language.',
            }),
        );
    }

    if (semantics !== undefined && semantics.main === false && context.deck !== true) {
        out.push(
            weighted({
                rule: "missing-main",
                level: "warning",
                ...elementOf(semantics.body),
                message:
                    "The page has no main landmark, so a screen reader cannot jump to its content. Wrap the page's content in `<main>`.",
            }),
        );
    }

    return out;
}

export function labelFindings(raw: RawPage): WeightedFinding[] {
    const out: WeightedFinding[] = [];

    for (const group of raw.labels ?? []) {
        out.push(
            weighted(
                {
                    rule: "form-label",
                    level: "error",
                    ...elementOf(group.el),
                    value: clip(group.kind, 40),
                    message: `A <${clip(group.kind, 40)}> has no label (no label, aria-label, aria-labelledby, or title; a placeholder is not a label: it goes away when a person types, and not every screen reader reads it)${more(num(group.count))}. Add a \`<label for="id">\` (or wrap the field in a \`<label>\`), or add \`aria-label="what it is"\`.`,
                },
                num(group.count),
            ),
        );
    }

    return out;
}

export function nameFindings(raw: RawPage): WeightedFinding[] {
    const out: WeightedFinding[] = [];

    for (const group of raw.names ?? []) {
        out.push(
            weighted(
                {
                    rule: "accessible-name",
                    level: "error",
                    ...elementOf(group.el),
                    value: clip(group.kind, 40),
                    message: `A <${clip(group.kind, 40)}> has no accessible name (no text, aria-label, aria-labelledby, title, image alt, or SVG title)${more(num(group.count))}. Add \`aria-label="what it does"\`.`,
                },
                num(group.count),
            ),
        );
    }

    return out;
}

export function zoomFindings(
    raw: RawPage,
    tokens: TokenSet | undefined,
    context: AnalyzeContext,
): WeightedFinding[] {
    if (context.phone !== true) {
        return [];
    }

    const sizes =
        tokens === undefined
            ? []
            : lengthsOf(tokens, "font-size").filter((token) => token.px >= 16);
    const step = sizes.sort((a, b) => a.px - b.px)[0];

    const out: WeightedFinding[] = [];

    for (const group of raw.zoom ?? []) {
        out.push(
            weighted(
                {
                    rule: "input-zoom",
                    level: "warning",
                    ...elementOf(group.el),
                    value: `${num(group.px)}px`,
                    ...(step === undefined ? {} : { suggestion: tokenRef(step) }),
                    message: `A <${clip(group.kind, 40)}> has font-size ${num(group.px)}px: iOS Safari zooms the page in when a field under 16px gets the focus${more(num(group.count))}. ${
                        step === undefined
                            ? "Set `font-size: 16px`."
                            : `Set \`font-size: ${tokenRef(step)}\` (${step.px}px).`
                    }`,
                },
                num(group.count),
            ),
        );
    }

    return out;
}

export function motionFindings(raw: RawPage): WeightedFinding[] {
    const motion = raw.motion;

    if (
        motion === undefined ||
        num(motion.count) <= 0 ||
        motion.override === true ||
        motion.unreadable === true
    ) {
        return [];
    }

    return [
        weighted({
            rule: "reduced-motion",
            level: "warning",
            ...elementOf(motion.el),
            value: `${num(motion.longest)}ms`,
            message:
                `${plural(num(motion.count), "element")} use a transition or an animation longer than ${MOTION_MS} ms, or one that repeats forever (the longest is ${num(motion.longest)} ms), and the page has no \`@media (prefers-reduced-motion: reduce)\` rule. ` +
                "Add \`@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } }\`.",
        }),
    ];
}

export function pidFindings(raw: RawPage): WeightedFinding[] {
    const pids = (raw.pids ?? []).filter((group) => num(group.count) > 0);

    if (pids.length === 0) {
        return [];
    }

    const total = pids.reduce((sum, group) => sum + num(group.count), 0);
    const listed = pids.slice(0, 5).map((group) => `${num(group.count)} <${clip(group.tag, 20)}>`);
    const tags = pids.length > 5 ? `${listed.join(", ")}, …` : listed.join(", ");

    return [
        weighted({
            rule: "missing-pid",
            level: "warning",
            ...elementOf(pids[0]!.el),
            message: `${plural(total, "element")} with no data-pid on it or a parent (${tags}). Add data-pid to the sections and controls people may comment on.`,
        }),
    ];
}
