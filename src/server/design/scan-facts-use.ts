import { colorsIn, commaParts, type Decl, isDarkSelector, parts, px } from "./scan-parse.ts";
import { nameScore, words } from "./scan-colors.ts";
import {
    addVar,
    bump,
    type ColorFact,
    emptyKinds,
    entry,
    type Facts,
    type Kinds,
} from "./scan-facts.ts";
import { noteChannels } from "./scan-variables.ts";

const COLOR_PROPERTY: [RegExp, "bg" | "text" | "border" | "fill" | "shadow"][] = [
    [
        /^(?:color|caret-color|text-decoration(?:-color)?|-webkit-text-fill-color|text-emphasis-color)$/,
        "text",
    ],
    [/^(?:background(?:-color|-image)?|accent-color|scrollbar-color)$/, "bg"],
    [
        /^(?:border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|column-rule(?:-color)?|border-image)$/,
        "border",
    ],
    [/^(?:fill|stroke|stop-color|flood-color)$/, "fill"],
    [/^(?:box-shadow|text-shadow|filter|drop-shadow)$/, "shadow"],
];

const ROOTISH =
    /^(?:html|body|:root|#root|#app|#__next|main|\.app|\.App|#app-root|\.(?:page|wrapper|layout|site|shell|root|app-shell|page-wrapper|site-wrapper|app-wrapper|container|screen|safeArea|safe-area)|#(?:page|wrapper|main|site|layout))(?:[.#:[][^\s,>+~]*)?$/;

const rootish = (selector: string) =>
    selector !== "" &&
    selector
        .split(",")
        .map((part) => part.trim())
        .every((part) => ROOTISH.test(part));

const SURFACE_SELECTOR =
    /(?:^|[\s,>+~.#:_-])(?:card|panel|surface|modal|dialog|popover|tile|well|sheet|drawer|dropdown|menu|tooltip|toast|box|pop)[\w-]*/i;

const HEADING =
    /(?:^|[\s,>+~])(?:h[1-6]|\.h[1-6]|\.(?:title|heading|headline|display)[\w-]*)(?![\w-])/i;

const BODY = /(?:^|[\s,>+~])(?:body|html|p|:root|\.text|\.body|main)(?![\w-])/i;

const CODE = /(?:^|[\s,>+~])(?:code|pre|kbd|samp|\.mono|\.code)(?![\w-])/i;

const VAR_REF = /var\(\s*--([\w-]+)/g;

export function colorFact(
    map: Map<string, ColorFact>,
    hex: string,
    text: string,
    at?: string,
): ColorFact {
    const fact = entry(map, hex, () => ({
        hex,
        forms: new Map(),
        ...emptyKinds(),
        order: map.size,
        ...(at === undefined ? {} : { at }),
    }));

    bump(fact.forms, text.replace(/\s+/g, " ").slice(0, 80));

    return fact;
}

function useColors(facts: Facts, decl: Decl, dark: boolean): void {
    const known = COLOR_PROPERTY.find(([pattern]) => pattern.test(decl.prop))?.[1];
    const kind = known ?? "other";
    const map = dark ? facts.darkColors : facts.colors;
    // A color name counts only where the property takes a color: `font-family: Rose` is no color.
    const found = colorsIn(
        decl.value,
        known !== undefined && (kind !== "shadow" || !/^none$/i.test(decl.value)),
    );

    const count = (fact: Kinds) => {
        fact[kind] += 1;

        if (kind === "bg" && rootish(decl.selector)) {
            fact.root += 1;
        }

        if (kind === "bg" && SURFACE_SELECTOR.test(decl.selector)) {
            fact.surface += 1;
        }

        if (kind === "text" && (rootish(decl.selector) || BODY.test(decl.selector))) {
            fact.body += 1;
        }
    };

    const where =
        facts.file === undefined || decl.line === undefined
            ? undefined
            : `${facts.file}:${decl.line}`;

    for (const color of found) {
        count(colorFact(map, color.hex, color.text, where));
    }

    const single = /^(?:[^\s,]*\s+)?\.([\w-]+)$/.exec(decl.selector.trim());

    if (
        single !== null &&
        found.length === 1 &&
        (kind === "bg" || kind === "text" || kind === "border") &&
        facts.classRules.size < 600 &&
        (decl.selector.trim() === `.${single[1]}` || (dark && isDarkSelector(decl.selector)))
    ) {
        const rule = entry(facts.classRules, `${single[1]}|${kind}`, () => ({ kind }));

        rule[dark ? "dark" : "light"] = found[0]!.hex;
    }

    if (known !== undefined && !dark) {
        for (const match of decl.value.matchAll(VAR_REF)) {
            count(entry(facts.varKinds, match[1]!, emptyKinds));
        }
    }
}

export function stackOf(value: string): string[] | undefined {
    if (/^(?:(?:inherit|initial|unset|revert)$|var\()/i.test(value.trim())) {
        return undefined;
    }

    const names = commaParts(value)
        .map((part) => part.replace(/^["']|["']$/g, "").trim())
        .filter((name) => name !== "" && !/var\(|\$\{/.test(name))
        .slice(0, 12);

    return names.length === 0 ? undefined : names;
}

function countPlace(fact: { count: number; heading: number; body: number }, selector: string) {
    fact.count += 1;

    if (HEADING.test(selector)) {
        fact.heading += 1;
    }

    if (BODY.test(selector) || rootish(selector)) {
        fact.body += 1;
    }
}

function useFont(facts: Facts, value: string, decl: Decl): void {
    const stack = stackOf(value);

    if (stack === undefined) {
        return;
    }

    const key = stack.map((name) => name.toLowerCase()).join(",");
    const fact = entry(facts.fonts, key, () => ({ stack, count: 0, heading: 0, body: 0, code: 0 }));

    countPlace(fact, decl.selector);

    if (
        CODE.test(decl.selector) ||
        stack.some((name) => /mono|code|courier|consolas|menlo|monaco/i.test(name)) ||
        stack.includes("monospace")
    ) {
        fact.code += 1;
    }
}

function useSize(facts: Facts, text: string, decl: Decl): void {
    const size = px(text);

    if (size === undefined || size < 8 || size > 160) {
        return;
    }

    const rounded = Math.round(size * 100) / 100;
    const fact = entry(facts.sizes, rounded, () => ({
        count: 0,
        body: 0,
        heading: 0,
        forms: new Map(),
    }));

    countPlace(fact, decl.selector);
    bump(fact.forms, text.trim());
}

const SPACING_PROPS =
    /^(?:padding(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|margin(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|gap|row-gap|column-gap|grid-gap|grid-row-gap|grid-column-gap)$/;

function useSpacing(facts: Facts, value: string): void {
    for (const part of parts(value)) {
        const size = px(part);

        if (size !== undefined && size >= 1 && size <= 256) {
            bump(facts.spacing, Math.round(size * 4) / 4);
        }
    }
}

const FULL_RADIUS = /^(?:9{3,}px|9{3,}rem|100vmax|calc\(infinity \* 1px\))$/i;

function useRadius(facts: Facts, value: string): void {
    for (const part of value.split("/").flatMap((half) => parts(half))) {
        const text = part.trim();
        const full = FULL_RADIUS.test(text);
        const size = full ? undefined : px(text);

        // A percentage makes a circle of a square; it is not a size.
        if (!text.endsWith("%") && (full || (size !== undefined && size > 0 && size <= 200))) {
            const key = full ? "full" : `${Math.round(size! * 100) / 100}`;

            entry(facts.radii, key, () => ({ count: 0, text })).count += 1;
        }
    }
}

const SASS_PROPS =
    /^(?:padding|margin|gap|row-gap|column-gap|border-radius|font-size|box-shadow|border|border-(?:top|right|bottom|left)|outline|color|background|background-color|border-color)(?:-[a-z-]+)?$/;

const SCALE_PROPS =
    /^(?:padding|margin|gap|row-gap|column-gap|border-radius|font-size)(?:-[a-z-]+)?$/;

const emptyLayout = () => ({ space: 0, text: 0, radius: 0, box: 0 });

const LAYOUT_GROUP: [RegExp, "space" | "text" | "radius" | "box"][] = [
    [SPACING_PROPS, "space"],
    [/^font-size$/, "text"],
    [/^border(?:-\w+)*-radius$/, "radius"],
    [
        /^(?:width|height|min-width|min-height|max-width|max-height|inline-size|block-size|flex-basis)$/,
        "box",
    ],
];

const FONT_SHORTHAND =
    /^(?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|\d{3})\s+)*(?<size>[\d.]+(?:px|rem|em|pt))(?:\/(?<line>[\d.]+(?:px|rem|em)?))?\s+(?<family>.+)$/i;

export function ingest(facts: Facts, decl: Decl): void {
    noteChannels(facts, decl.value);

    const group = decl.value.includes("var(")
        ? LAYOUT_GROUP.find(([pattern]) => pattern.test(decl.prop))?.[1]
        : undefined;

    if (group !== undefined) {
        for (const match of decl.value.matchAll(VAR_REF)) {
            entry(facts.varLayout, match[1]!, emptyLayout)[group] += 1;
        }
    }

    // Sizes from variables (`calc(var(--gap) * 2)`, `$unit * 2`) wait until the variables are known.
    if (
        ((SCALE_PROPS.test(decl.prop) && /calc\(/.test(decl.value) && /var\(/.test(decl.value)) ||
            (SASS_PROPS.test(decl.prop) && /(?<![\w$@-])[$@][A-Za-z_]/.test(decl.value))) &&
        facts.deferred.length < 1500
    ) {
        facts.deferred.push({
            prop: decl.prop,
            value: decl.value,
            selector: decl.selector,
            scope: decl.scope,
            ...(facts.file === undefined ? {} : { file: facts.file }),
            ...(decl.line === undefined ? {} : { line: decl.line }),
        });

        return;
    }

    const dark = decl.scope === "dark";

    useColors(facts, decl, dark);

    if (dark) {
        return;
    }

    switch (decl.prop) {
        case "font-family":
            useFont(facts, decl.value, decl);

            return;

        case "font": {
            const groups = FONT_SHORTHAND.exec(decl.value)?.groups;

            if (groups !== undefined) {
                useSize(facts, groups.size!, decl);
                useFont(facts, groups.family!, decl);
            }

            return;
        }

        case "font-size":
            useSize(facts, decl.value, decl);

            return;

        case "border-radius":
        case "border-top-left-radius":
        case "border-top-right-radius":
        case "border-bottom-left-radius":
        case "border-bottom-right-radius":
            useRadius(facts, decl.value);

            return;

        case "box-shadow":
            if (
                !/^(?:none|inherit|initial|unset)$/i.test(decl.value) &&
                !/var\(/.test(decl.value)
            ) {
                bump(facts.shadows, decl.value.replace(/\s+/g, " ").trim());
            }

            return;

        default:
            if (SPACING_PROPS.test(decl.prop)) {
                useSpacing(facts, decl.value);
            }
    }
}

function lightDark(value: string): [string, string] | undefined {
    let light = "";
    let dark = "";
    let at = 0;
    let found = false;

    const both = (text: string) => {
        light += text;
        dark += text;
    };

    while (at < value.length) {
        const open = value.indexOf("light-dark(", at);
        let start = open === -1 ? value.length : open + 11;

        if (open === -1 || /[\w-]/.test(value[open - 1] ?? "")) {
            both(value.slice(at, start));
            at = start;

            continue;
        }

        both(value.slice(at, open));

        const parts = [];
        let depth = 0;
        let end = start;

        for (; end < value.length && (depth > 0 || value[end] !== ")"); end++) {
            const char = value[end];

            if (char === "," && depth === 0) {
                parts.push(value.slice(start, end));
                start = end + 1;
            }

            depth += char === "(" ? 1 : char === ")" ? -1 : 0;
        }

        parts.push(value.slice(start, end));

        if (end === value.length || parts.length !== 2) {
            return undefined;
        }

        light += parts[0]!.trim();
        dark += parts[1]!.trim();
        at = end + 1;
        found = true;
    }

    return found ? [light, dark] : undefined;
}

const VAR_KIND: Record<string, "scss" | "less"> = { $: "scss", "@": "less" };

export function ingestStyles(facts: Facts, file: string, all: Decl[]): void {
    const mode = facts.fileMode;

    const expanded = all.flatMap((each): Decl[] => {
        const decl =
            mode !== undefined && each.scope === "default" && !each.inline
                ? { ...each, scope: mode }
                : each;
        const pair = decl.value.includes("light-dark(") ? lightDark(decl.value) : undefined;

        if (pair === undefined || decl.scope === "other") {
            return [decl];
        }

        return decl.scope === "dark"
            ? [{ ...decl, value: pair[1] }]
            : [
                  { ...decl, value: pair[0] },
                  { ...decl, value: pair[1], scope: "dark" },
              ];
    });

    for (const decl of expanded) {
        const custom = decl.prop.startsWith("--");
        const name = decl.prop.slice(custom ? 2 : 1);

        if (custom && decl.scope === "other") {
            bump(facts.scoped, decl.selector.slice(0, 80));

            // The surface is often set on the card itself (`.card { --bs-card-bg: #fff }`).
            if (
                nameScore("surface", words(name)) >= 60 &&
                colorsIn(decl.value).length === 1 &&
                /^\s*(?:#|rgb|hsl|oklch)/i.test(decl.value)
            ) {
                addVar(facts, {
                    name,
                    value: decl.value,
                    scope: isDarkSelector(decl.selector) ? "dark" : "default",
                    kind: "css",
                    file,
                });
            }

            continue;
        }

        if (custom || decl.prop.startsWith("$") || decl.prop.startsWith("@")) {
            addVar(facts, {
                name,
                value: decl.value,
                scope: decl.scope,
                kind: VAR_KIND[decl.prop[0]!] ?? (decl.theme ? "theme" : "css"),
                file,
                ...(decl.line === undefined ? {} : { line: decl.line }),
            });

            continue;
        }

        ingest(facts, decl);

        for (const at of decl.at) {
            breakpointsIn(facts, at);
        }
    }
}

function breakpointsIn(facts: Facts, query: string): void {
    for (const match of query.matchAll(
        /\(\s*(?:min-width\s*:\s*(\d*\.?\d+)(px|em|rem)|width\s*>=?\s*(\d*\.?\d+)(px|em|rem))/gi,
    )) {
        const size = px(`${match[1] ?? match[3]}${(match[2] ?? match[4])!}`);

        if (size !== undefined && size >= 320 && size <= 3000) {
            bump(facts.breakpoints, Math.round(size));
        }
    }
}
