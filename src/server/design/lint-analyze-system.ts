import {
    colorDistance,
    familyList,
    formatColor,
    isGenericFamily,
    type LengthKind,
    type TokenSet,
} from "./lint-color.ts";
import {
    colorRoleOf,
    difference,
    exactColorToken,
    FAR_COLOR,
    nearestColor,
    SAME_COLOR,
    USE_PROPERTIES,
    USE_PROPERTY,
    USE_ROLE,
} from "./lint-suggest.ts";
import type { RawPage } from "./lint-page.ts";
import {
    clip,
    elementOf,
    lengthsOf,
    num,
    plural,
    rgbaOf,
    tokenRef,
    weighted,
    type WeightedFinding,
} from "./lint-analyze-util.ts";

const SAME_LENGTH = 0.5;

const LENGTH_PROPERTIES: Record<string, string[]> = {
    padding: ["padding", "padding-top", "padding-right", "padding-bottom", "padding-left"],
    margin: ["margin", "margin-top", "margin-right", "margin-bottom", "margin-left"],
    gap: ["gap", "row-gap", "column-gap", "grid-gap"],
    "font-size": ["font-size", "font"],
    "border-radius": [
        "border-radius",
        "border-top-left-radius",
        "border-top-right-radius",
        "border-bottom-right-radius",
        "border-bottom-left-radius",
    ],
};

const SCALE_NAMES: Record<string, string> = {
    "font-size": "the type scale",
    space: "the spacing scale",
    radius: "the radius scale",
};

function suggestFont(set: TokenSet, list: string) {
    const wanted = familyList(list).filter(isGenericFamily).at(-1);

    return (
        set.fonts.find((font) => wanted !== undefined && font.families.at(-1) === wanted) ??
        set.fonts.find((font) => /body|base|sans|text/i.test(font.name)) ??
        set.fonts[0]
    );
}

function sizeEdit(
    props: unknown,
    kind: string,
    step: { cssVar: string; px: number },
    px: number,
): string {
    const names = (Array.isArray(props) ? props : [])
        .map((prop) => clip(prop, 30))
        .filter((prop) => prop !== "");
    const list = names.length > 0 ? names : [kind === "font-size" ? "font-size" : kind];
    const set = list.map((prop) => `\`${prop}\``).join(" or ");

    const by = Math.round(Math.abs(step.px - px) * 100) / 100;
    const change =
        by < 0.01 ? "" : ` The closest step is ${by}px ${step.px < px ? "smaller" : "larger"}.`;

    return `Set ${set} to ${tokenRef(step)}, ${step.px}px, instead of ${px}px.${change}`;
}

export function colorFindings(raw: RawPage, tokens: TokenSet | undefined): WeightedFinding[] {
    const out: WeightedFinding[] = [];

    if (tokens === undefined || !tokens.colors.some((token) => token.rgba !== undefined)) {
        return out;
    }

    for (const group of raw.colors ?? []) {
        const rgba = rgbaOf(group.rgba);

        if (rgba === undefined) {
            continue;
        }

        const onSystem = tokens.colors.some(
            (token) => token.rgba !== undefined && colorDistance(rgba, token.rgba) < SAME_COLOR,
        );

        if (onSystem && group.literal !== true) {
            continue;
        }

        const [main] = Object.entries(group.roles ?? {}).sort((a, b) => num(b[1]) - num(a[1]));

        const roles = Object.entries(group.roles ?? {})
            .filter(([, count]) => Number.isFinite(count))
            .map(([role, count]) => `${role} on ${plural(count, "element")}`)
            .join(", ");
        const better = nearestColor(tokens, rgba, main?.[0]);
        const near =
            better !== undefined && (better.exact || better.distance <= FAR_COLOR)
                ? better
                : undefined;
        const value = formatColor(rgba);
        const wanted = USE_ROLE[main?.[0] ?? ""];
        const given = near === undefined ? undefined : colorRoleOf(near.token.name);
        const property = USE_PROPERTY[main?.[0] ?? ""] ?? "color";
        // Said as "the same color" only when it is: a token that differs is the closest one, and the message says how.
        const edit =
            near === undefined
                ? ""
                : near.exact
                  ? ` Set \`${property}: ${tokenRef(near.token)}\` (${formatColor(near.token.rgba!)}, the same color).`
                  : ` Set \`${property}: ${tokenRef(near.token)}\` (${formatColor(near.token.rgba!)}) instead of ${value}.`;
        const change =
            near === undefined || near.exact
                ? ""
                : ` The closest token is ${formatColor(near.token.rgba!)}, which is ${difference(rgba, near.token.rgba!)}.`;
        const roleNote =
            wanted !== undefined && given !== undefined && given !== wanted
                ? ` It is a ${given} token, and the system has no ${wanted} token this close.`
                : "";

        // A fix replaces the literal in place, so the token must fit the use (a text token is not a background's) and have
        // this value in every mode: the page must look the same in each.
        const steady =
            onSystem && group.literal === true && near?.exact
                ? exactColorToken(
                      {
                          ...tokens,
                          colors: tokens.colors.filter((token) => token.steady !== false),
                      },
                      rgba,
                      main?.[0],
                      2,
                  )
                : undefined;
        const steadyRole = steady === undefined ? undefined : colorRoleOf(steady.name);
        const exact =
            steady !== undefined &&
            steady.tier !== "component" &&
            (steadyRole === undefined || steadyRole === wanted)
                ? steady
                : undefined;

        out.push(
            weighted(
                {
                    rule: "off-system-color",
                    level: onSystem ? "warning" : "error",
                    ...elementOf(group.el),
                    value,
                    ...(near === undefined ? {} : { suggestion: tokenRef(near.token) }),
                    ...(exact === undefined
                        ? {}
                        : {
                              fix: {
                                  kind: "color" as const,
                                  properties: USE_PROPERTIES[main?.[0] ?? "text"] ?? ["color"],
                                  literal: value,
                                  token: exact.name,
                                  cssVar: exact.cssVar,
                                  mode: tokens.mode,
                              },
                          }),
                    message: onSystem
                        ? `${value} is written as a literal (${roles}), so it does not follow the system.` +
                          (near === undefined ? "" : `${edit}${change}${roleNote}`)
                        : `${value} is not a system color (${roles}).` +
                          (near === undefined
                              ? " No token is close: pick a role from the system."
                              : `${edit}${change}${roleNote}`),
                },
                num(group.count),
            ),
        );
    }

    return out;
}

export function fontFindings(raw: RawPage, tokens: TokenSet | undefined): WeightedFinding[] {
    const out: WeightedFinding[] = [];

    if (tokens === undefined || tokens.fonts.length === 0) {
        return out;
    }

    const allowed = new Set(tokens.fonts.map((font) => font.families[0]));

    for (const group of raw.fonts ?? []) {
        const family = clip(group.family, 120);

        const onSystem = allowed.has(family);

        if (family === "" || (onSystem && group.literal !== true)) {
            continue;
        }

        const list = clip(group.list);
        const token = suggestFont(tokens, list);
        const names = familyList(list);
        const exact =
            onSystem && group.literal === true
                ? tokens.fonts.find(
                      (font) =>
                          font.steady !== false &&
                          font.families.length === names.length &&
                          font.families.every((name, index) => name === names[index]),
                  )
                : undefined;

        out.push(
            weighted(
                {
                    rule: "off-system-font",
                    level: onSystem ? "warning" : "error",
                    ...elementOf(group.el),
                    value: list,
                    ...(token === undefined ? {} : { suggestion: tokenRef(token) }),
                    ...(exact === undefined
                        ? {}
                        : {
                              fix: {
                                  kind: "font" as const,
                                  properties: ["font-family"],
                                  literal: list,
                                  token: exact.name,
                                  cssVar: exact.cssVar,
                                  mode: tokens.mode,
                              },
                          }),
                    message:
                        (onSystem
                            ? `Font ${list} is written as a literal (${plural(num(group.count), "element")}), so it does not follow the system.`
                            : `Font ${list} is not a system font (${plural(num(group.count), "element")}).`) +
                        (token === undefined
                            ? ""
                            : ` Set \`font-family: ${tokenRef(token)}\` instead of ${list}.`),
                },
                num(group.count),
            ),
        );
    }

    return out;
}

export function sizeFindings(raw: RawPage, tokens: TokenSet | undefined): WeightedFinding[] {
    const out: WeightedFinding[] = [];

    if (tokens === undefined) {
        return out;
    }

    for (const group of raw.sizes ?? []) {
        const kind = group.kind as LengthKind;
        const scale = SCALE_NAMES[kind] === undefined ? [] : lengthsOf(tokens, kind);
        const px = num(group.px, Number.NaN);

        if (scale.length === 0 || !Number.isFinite(px)) {
            continue;
        }

        const equal = scale.find((token) => Math.abs(token.px - px) <= SAME_LENGTH);

        if (equal !== undefined && group.literal !== true) {
            continue;
        }

        // Two equally near steps: the smaller one.
        const sorted = [...scale].sort(
            (a, b) => Math.abs(a.px - px) - Math.abs(b.px - px) || a.px - b.px,
        );
        const nearest = sorted[0]!;
        const props = (Array.isArray(group.props) ? group.props : [])
            .map((prop) => clip(prop, 30))
            .join(", ");
        const step = equal ?? nearest;
        const exact =
            group.literal === true
                ? scale.find((token) => token.steady !== false && Math.abs(token.px - px) <= 0.01)
                : undefined;
        const properties = (Array.isArray(group.props) ? group.props : []).flatMap(
            (prop) => LENGTH_PROPERTIES[String(prop)] ?? [],
        );

        out.push(
            weighted(
                {
                    rule: "off-system-size",
                    level: "warning",
                    ...elementOf(group.el),
                    value: `${px}px`,
                    suggestion: tokenRef(step),
                    ...(exact === undefined || properties.length === 0
                        ? {}
                        : {
                              fix: {
                                  kind: "length" as const,
                                  properties,
                                  literal: `${px}px`,
                                  token: exact.name,
                                  cssVar: exact.cssVar,
                                  mode: tokens.mode,
                              },
                          }),
                    message:
                        equal === undefined
                            ? `${props === "" ? kind : props} ${px}px is not on ${SCALE_NAMES[kind]} (${plural(num(group.count), "use")}). ${sizeEdit(group.props, kind, nearest, px)}`
                            : `${props === "" ? kind : props} ${px}px is written as a literal (${plural(num(group.count), "use")}), so it does not follow the system. ${sizeEdit(group.props, kind, equal, px)}`,
                },
                num(group.count),
            ),
        );
    }

    return out;
}
