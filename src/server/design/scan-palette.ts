import { contrastRatio, parseColor } from "./color.ts";
import {
    type ColorEntry,
    distance,
    entryOf,
    hexOf,
    kebab,
    nearColors,
    normalizeColor,
    paletteName,
    ROLE_PATHS,
    type RoleName,
    slug,
    vkey,
    w,
} from "./scan-colors.ts";
import { type Classified } from "./scan-prepare.ts";
import { topBy } from "./scan-scales.ts";
import { type Variable } from "./scan-variables.ts";
import { pathOf } from "./scan-tree.ts";
import { type ColorRoles, type InferContext, type RoleChoice } from "./scan-roles.ts";

export function paletteTokens(context: InferContext, roles: ColorRoles): void {
    const { facts, classified, alt, result, book, aliasOf, uses } = context;
    const { lightColors, darkColors, lightRoles, darkRoles } = roles;
    const colorVars = classified.filter((entry) => entry.category === "color");

    const scales = new Map<string, Classified[]>();

    for (const entry of colorVars) {
        const match =
            /^(?:color-|colour-|clr-)?([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-(\d{1,3})$/i.exec(
                entry.variable.name,
            );

        if (
            match !== null &&
            !w(
                "bg background surface text fg foreground border layer base space spacing size step",
            ).includes(match[1]!.toLowerCase())
        ) {
            const list = scales.get(match[1]!.toLowerCase()) ?? [];

            list.push(entry);
            scales.set(match[1]!.toLowerCase(), list);
        }
    }

    const hexPath = new Map<string, string[]>();

    const palette = (hex: string, text: string): string[] => {
        const known = hexPath.get(hex);

        if (known !== undefined) {
            return known;
        }

        const entry = lightColors.get(hex) ?? darkColors.get(hex) ?? entryOf(hex, text)!;
        const path = paletteName(entry, book.taken());

        book.add(path, { $value: text, $type: "color" });
        hexPath.set(hex, path);
        result.palette[path[1]!] = (result.palette[path[1]!] ?? 0) + 1;

        return path;
    };

    const asValue = (hex: string, entries: Map<string, ColorEntry>) => {
        const entry = entries.get(hex);

        return entry === undefined
            ? hex
            : entry.text.startsWith("#") ||
                /^[a-z]/i.test(entry.text) ||
                /^(?:rgb|hsl|oklch|oklab|lab|lch|hwb)/i.test(entry.text)
              ? normalizeColor(entry.text)
              : hex;
    };

    const scaleVars = new Set<Classified>();

    for (const [family, list] of scales) {
        if (
            list.length < 2 &&
            !w(
                "gray grey red orange yellow green blue indigo purple pink teal cyan lime amber emerald sky violet fuchsia rose slate zinc stone neutral",
            ).includes(family)
        ) {
            continue;
        }

        for (const entry of list) {
            const step = /(\d{1,3})$/.exec(entry.variable.name)![1]!;
            const path = ["color", slug(family === "grey" ? "gray" : family), step];
            const hex = hexOf(entry.lightColor ?? entry.darkColor);

            if (hex === undefined || book.has(path)) {
                continue;
            }

            const value = normalizeColor((entry.lightColor ?? entry.darkColor)!);

            book.add(path, { $value: value, $type: "color" });
            scaleVars.add(entry);
            aliasOf.set(vkey(entry.variable), path);
            hexPath.set(hex, hexPath.get(hex) ?? path);
            result.palette[path[1]!] = (result.palette[path[1]!] ?? 0) + 1;

            const darkHex = hexOf(entry.darkColor);

            if (darkHex !== undefined && darkHex !== hex) {
                book.addDark(path, { $value: normalizeColor(entry.darkColor!), $type: "color" });
            }
        }
    }

    const roleVars = new Set<string>();
    const pendingDark: { path: string[]; hex: string }[] = [];
    // The light color each color token holds, so that two files that name one token agree on which color it is.
    const lightHexOf = new Map<string, string>();
    // The default-mode colors that a dark-first project keeps on its roles as they are, so the palette skips them.
    const changing = new Set<string>();
    const lightAlias = (hex: string) =>
        changing.has(hex)
            ? asValue(hex, lightColors)
            : `{${palette(hex, asValue(hex, lightColors)).join(".")}}`;

    for (const role of Object.keys(ROLE_PATHS) as RoleName[]) {
        const light = lightRoles[role];

        if (light === undefined) {
            continue;
        }

        const path = ROLE_PATHS[role];
        const dark = darkRoles[role];
        // A dark-first project keeps the colors that change as they are in the default mode: its light mode is the file
        // that changes them, and a palette of dark-only grays would show up in the light mode.
        const changes = dark !== undefined && dark.hex !== light.hex;

        if (alt === "light" && changes) {
            changing.add(light.hex);
        }

        const source = colorVars.find((entry) => entry.variable.name === light.source);

        if (light.basis === "name") {
            roleVars.add(light.source);
        }

        book.add(path, { $value: lightAlias(light.hex), $type: "color" });
        lightHexOf.set(path.join("."), light.hex);

        if (source !== undefined) {
            aliasOf.set(vkey(source.variable), path);
        }

        if (changes) {
            pendingDark.push({ path, hex: dark.hex });
        }

        const fact = source?.variable.light;
        const at =
            light.basis === "use"
                ? lightColors.get(light.hex)?.fact?.at
                : fact === undefined
                  ? undefined
                  : `${fact.file}${fact.line === undefined ? "" : `:${fact.line}`}`;
        // A name that says the role is sure; the way a color is used is a guess, the less so the weaker the sign.
        const sure = light.score >= (light.basis === "name" ? 85 : 40);

        result.roles[role] = {
            token: path.join("."),
            value: light.hex,
            ...(changes ? { dark: dark.hex } : {}),
            basis: light.basis,
            source: light.source,
            confidence:
                light.basis === "name" ? (sure ? "high" : "medium") : sure ? "medium" : "low",
            ...(at === undefined ? {} : { at }),
        };
    }

    const onAccent = (
        accent: ColorEntry,
        entries: Map<string, ColorEntry>,
        roles: Partial<Record<RoleName, RoleChoice>>,
        preferWhite: boolean,
    ) => {
        const given = new Set(Object.values(roles).map((role) => role?.hex));
        const pool = [
            ...[roles.background?.hex, roles.text?.hex, "#ffffff", "#000000"].filter(
                (hex): hex is string => hex !== undefined && entries.has(hex),
            ),
            ...[...entries.values()]
                .filter(
                    (each) =>
                        !given.has(each.hex) &&
                        each.c < 0.06 &&
                        each.rgba.a > 0.9 &&
                        (each.fact?.text ?? 0) > 0 &&
                        (each.fact?.bg ?? 0) === 0 &&
                        (each.fact?.border ?? 0) === 0,
                )
                .map((each) => each.hex),
        ];

        return preferWhite && contrastRatio(parseColor("#ffffff")!, accent.rgba) >= 3
            ? "#ffffff"
            : topBy(pool, (hex) => contrastRatio(entries.get(hex)!.rgba, accent.rgba), 1)[0];
    };

    const accent =
        lightRoles.accent === undefined ? undefined : lightColors.get(lightRoles.accent.hex);
    // White is what a project already puts on its accent when it uses white as a text color.
    const whiteText = (facts.colors.get("#ffffff")?.text ?? 0) > 0 && lightColors.has("#ffffff");
    const onLight =
        accent === undefined ? undefined : onAccent(accent, lightColors, lightRoles, whiteText);

    if (onLight !== undefined) {
        const path = ["color", "text", "on-accent"];
        const darkAccent =
            darkRoles.accent === undefined ? undefined : darkColors.get(darkRoles.accent.hex);
        const onDark =
            darkAccent === undefined
                ? undefined
                : onAccent(darkAccent, darkColors, darkRoles, false);

        book.add(path, { $value: lightAlias(onLight), $type: "color" });

        if (onDark !== undefined && onDark !== onLight) {
            pendingDark.push({ path, hex: onDark });
        }
    }

    const known = [...hexPath.keys()].map((hex) => lightColors.get(hex) ?? entryOf(hex)!);
    const candidates = [...lightColors.values()].filter(
        (entry) =>
            !hexPath.has(entry.hex) &&
            !changing.has(entry.hex) &&
            entry.rgba.a > 0.05 &&
            entry.uses >= 1 &&
            known.every((other) => !nearColors(other, entry)),
    );
    // A color used twice or more is part of the design. One used once is a one-off (a gradient stop, a chart, a badge):
    // a small palette keeps it, a large one has no room for it.
    const repeated = candidates.filter((entry) => entry.uses >= 2);
    // A dark-first project's own colors are the dark mode's: its one-offs are not part of the palette of the other mode.
    const room =
        alt === "light" ? 0 : Math.max(0, 14 - hexPath.size - changing.size - repeated.length);
    const singles: ColorEntry[] = [];

    // A one-off that is a step from a color the design has (a hover shade of the brand) is that color, not a new one.
    for (const entry of candidates.filter((each) => each.uses < 2)) {
        if (
            singles.length < room &&
            [...known, ...repeated, ...singles].every((other) => distance(other, entry) > 0.025)
        ) {
            singles.push(entry);
        }
    }

    const extra = topBy([...repeated, ...singles], (entry) => entry.uses, 16);

    for (const entry of extra) {
        palette(entry.hex, asValue(entry.hex, lightColors));
    }

    const roleNames = new Set([...roleVars].map(kebab));
    // A Sass variable that a custom property is set from (`--bg: #{$dark-bg}`) is that property: one token, not two.
    const sources = new Set(
        colorVars
            .flatMap((entry) =>
                (entry.variable.kind === "css" || entry.variable.kind === "theme"
                    ? [entry.via, entry.darkVia]
                    : []
                ).filter(
                    (through): through is Variable =>
                        through !== undefined &&
                        (through.kind === "scss" || through.kind === "less"),
                ),
            )
            .map((through) => vkey(through)),
    );
    const rest = classified.filter(
        (entry) =>
            entry.category === "color" &&
            !scaleVars.has(entry) &&
            !sources.has(vkey(entry.variable)) &&
            !roleVars.has(entry.variable.name) &&
            !roleNames.has(kebab(entry.variable.name)),
    );

    for (const entry of topBy(rest, (each) => uses(each.variable) + 0.01, 40)) {
        const hex = hexOf(entry.lightColor);
        const path = pathOf(entry.variable, "color");

        if (hex === undefined) {
            continue;
        }

        if (book.has(path)) {
            // The same name from another file (a stylesheet variable and a theme object): it may know the dark value.
            const darkHex = hexOf(entry.darkColor);

            if (
                darkHex !== undefined &&
                darkHex !== hex &&
                lightHexOf.get(path.join(".")) === hex &&
                !book.dark.has(path.join("."))
            ) {
                pendingDark.push({ path, hex: darkHex });
            }

            continue;
        }

        const target = entry.via === undefined ? undefined : aliasOf.get(vkey(entry.via));
        const darkHex = hexOf(entry.darkColor);

        if (alt === "light" && target === undefined && darkHex !== undefined && darkHex !== hex) {
            changing.add(hex);
            book.add(path, { $value: asValue(hex, lightColors), $type: "color" });
        } else {
            const primitive = target ?? palette(hex, asValue(hex, lightColors));

            book.add(path, { $value: `{${primitive.join(".")}}`, $type: "color" });
        }

        lightHexOf.set(path.join("."), hex);
        aliasOf.set(vkey(entry.variable), path);

        if (darkHex !== undefined && darkHex !== hex) {
            pendingDark.push({ path, hex: darkHex });
        }
    }

    // A chromatic color that only the dark mode uses (links turn light blue) is the dark value of the light color of its
    // hue that has none yet.
    if (result.hasDark) {
        const taken = new Set(pendingDark.map((each) => each.hex));
        const changed = () =>
            new Set([...book.dark.keys(), ...pendingDark.map((each) => each.path.join("."))]);

        for (const dark of [...darkColors.values()].sort((a, b) => b.uses - a.uses).slice(0, 12)) {
            if (dark.c < 0.05 || taken.has(dark.hex) || hexPath.has(dark.hex)) {
                continue;
            }

            const moved = changed();
            const twin = [...hexPath]
                .map(([hex, path]) => ({ entry: lightColors.get(hex), path }))
                .filter(
                    (each): each is { entry: ColorEntry; path: string[] } =>
                        each.entry !== undefined &&
                        each.entry.c >= 0.05 &&
                        !moved.has(each.path.join(".")) &&
                        Math.abs(((each.entry.h - dark.h + 540) % 360) - 180) <= 25,
                )
                .sort((a, b) => b.entry.uses - a.entry.uses)[0];

            if (twin !== undefined) {
                pendingDark.push({ path: twin.path, hex: dark.hex });
                taken.add(dark.hex);
            }
        }
    }

    // The other mode's colors: a palette color the light mode already has is referenced; any other is written as it is,
    // in the mode's file, so the default mode holds only the colors it uses.
    const changes = new Set([
        ...book.dark.keys(),
        ...pendingDark.map((each) => each.path.join(".")),
    ]);

    for (const { path, hex } of pendingDark) {
        // A color of the light palette that is itself different in the dark is no stand-in for this one.
        const found = hexPath.get(hex);
        const known = found !== undefined && !changes.has(found.join(".")) ? found : undefined;

        book.addDark(path, {
            $value: known === undefined ? asValue(hex, darkColors) : `{${known.join(".")}}`,
            $type: "color",
        });
    }
}
