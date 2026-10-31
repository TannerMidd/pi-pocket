import { contrastRatio, grade, parseColor, swatchCss, toHex, writeColor } from "./color.js";

export const SECTIONS = [
    { id: "colors", label: "Colors" },
    { id: "type", label: "Type" },
    { id: "spacing", label: "Spacing" },
    { id: "radii", label: "Radii" },
    { id: "shadows", label: "Shadows" },
    { id: "motion", label: "Motion" },
    { id: "other", label: "Other" },
    { id: "components", label: "Components" },
    { id: "guidelines", label: "Guidelines" },
];

const HINTS = [
    ["type", /^(font|type|text|typography|line|leading|letter|tracking)$/],
    ["spacing", /^(space|spacing|gap|size|sizes|padding|margin|inset|stack|layout)$/],
    ["radii", /^(radius|radii|round|rounded|corner|corners)$/],
    ["motion", /^(motion|duration|delay|ease|easing|transition|timing)$/],
];

export function sectionOf(token) {
    switch (token.type) {
        case "color":
        case "gradient":
            return "colors";
        case "fontFamily":
        case "fontWeight":
        case "typography":
            return "type";
        case "shadow":
            return "shadows";
        case "duration":
        case "cubicBezier":
        case "transition":
            return "motion";
        case "dimension":

        case "number": {
            for (const part of token.path) {
                const hint = HINTS.find(([, pattern]) => pattern.test(part.toLowerCase()));

                if (hint) {
                    return hint[0];
                }
            }

            return "other";
        }

        default:
            return "other";
    }
}

const title = (text) =>
    text === "" ? "" : text[0].toUpperCase() + text.slice(1).replace(/[-_]+/g, " ");

const TIER_RANK = { semantic: 0, primitive: 1, component: 2 };
const tierOf = (token) => (token.tier in TIER_RANK ? token.tier : "semantic");

const TIER_TITLES = { semantic: "", primitive: "Primitives", component: "Component tokens" };
const SCALE_TITLES = { spacing: "Scale", radii: "Corners", shadows: "Elevation" };

// Same words as the documentation page groups by (`src/server/design/docsite-space.ts`); a test compares them.
const SPACE_ROOT = /^(space|spacing|gap|gaps|sp|spaces)$/;
const SIZE_ROOT = /^(size|sizes|sizing)$/;

const rootOf = (token) => token.path[0].toLowerCase();

export function sectionCounts(tokens) {
    const bySection = {};

    for (const token of tokens) {
        (bySection[sectionOf(token)] ??= []).push(token);
    }

    const counts = {};

    for (const [id, list] of Object.entries(bySection)) {
        const open = groupsOf(list, id)
            .filter((group) => group.headline)
            .reduce((sum, group) => sum + group.tokens.length, 0);

        counts[id] = { open, folded: list.length - open, total: list.length };
    }

    return counts;
}

export function groupsOf(tokens, section) {
    const mine = tokens.filter((token) => sectionOf(token) === section);
    const groups = new Map();

    const add = (id, name, kind, token, tier = tierOf(token)) => {
        const key = `${section}:${tier}:${id}`;

        if (!groups.has(key)) {
            groups.set(key, { id: key, title: name, kind, tier, tokens: [] });
        }

        const group = groups.get(key);

        group.tokens.push(token);

        return group;
    };

    const aimed = new Set(
        mine
            .filter((token) => tierOf(token) !== "component")
            .flatMap((token) =>
                Object.values(token.modes ?? {}).flatMap((one) => (one.alias ? [one.alias] : [])),
            ),
    );
    const plainScale =
        section === "radii" &&
        !mine.some(
            (token) =>
                tierOf(token) === "primitive" ||
                token.path.includes("scale") ||
                aimed.has(token.name),
        );

    for (const token of mine) {
        const tier = tierOf(token);

        if (section === "colors") {
            const own = token.path.length >= 3 ? token.path[1] : token.path[0];

            add(
                own,
                title(token.path.length >= 3 ? token.path[1] : "Base"),
                tier === "semantic" ? "roles" : tier === "primitive" ? "palette" : "components",
                token,
            );
        } else if (section === "type") {
            const by = {
                typography: ["styles", "Styles"],
                fontFamily: ["families", "Families"],
                fontWeight: ["weights", "Weights"],
            }[token.type];
            const sub =
                by ?? (token.type === "number" ? ["leading", "Line height"] : ["sizes", "Sizes"]);

            add(
                sub[0],
                tier === "component" ? `Component ${sub[1].toLowerCase()}` : sub[1],
                "type",
                token,
                token.type === "typography" && tier !== "component" ? "semantic" : tier,
            );
        } else if (section === "motion") {
            const by =
                token.type === "duration"
                    ? ["durations", "Durations"]
                    : token.type === "cubicBezier"
                      ? ["easing", "Easing"]
                      : ["transitions", "Transitions"];

            add(by[0], by[1], "motion", token);
        } else if (section === "other") {
            add(token.path[0], title(token.path[0]), "other", token);
        } else if (section === "spacing") {
            // Grouped the way the documentation page does (`order` is theirs, not the tier's).
            const root = rootOf(token);
            const [id, name, order] =
                tier === "component"
                    ? ["components", "Component tokens", 3]
                    : SPACE_ROOT.test(root)
                      ? ["steps", "Steps", 0]
                      : SIZE_ROOT.test(root)
                        ? ["sizes", "Sizes", 2]
                        : ["roles", "Roles", 1];

            add(id, name, id, token, tier === "component" ? "component" : "semantic").order = order;
        } else if (section === "radii") {
            const [id, name, order] =
                tier === "component"
                    ? ["components", "Component tokens", 2]
                    : plainScale ||
                        tier === "primitive" ||
                        token.path.includes("scale") ||
                        aimed.has(token.name)
                      ? ["scale", "Scale", 0]
                      : ["roles", "Roles", 1];

            add(id, name, id, token, tier === "component" ? "component" : "semantic").order = order;
        } else {
            add("all", "", section, token);
        }
    }

    const list = [...groups.values()].sort(
        (a, b) => (a.order ?? TIER_RANK[a.tier]) - (b.order ?? TIER_RANK[b.tier]),
    );
    const semantic = list.some((each) => each.tier === "semantic");

    if (section !== "colors") {
        const seen = new Map();

        for (const group of list) {
            seen.set(group.title, (seen.get(group.title) ?? 0) + 1);
        }

        for (const group of list) {
            if (group.title !== "" && seen.get(group.title) > 1) {
                group.title = `${group.title} · ${group.tier}`;
            }
        }
    }

    for (const group of list) {
        if (group.title === "" && list.length > 1) {
            group.title = TIER_TITLES[group.tier] || SCALE_TITLES[section] || "Scale";
        }

        const own = section === "spacing" || section === "radii";

        group.headline = own
            ? group.tier !== "component" &&
              (group.tokens.some((token) => tierOf(token) === "semantic") ||
                  !mine.some((token) => tierOf(token) === "semantic"))
            : group.tier !== "component" && !(group.tier === "primitive" && semantic);
        group.fold = own
            ? group.tier === "component"
            : group.tier === "component" || (group.tier === "primitive" && semantic);
    }

    return list;
}

export function tails(tokens) {
    const depth = new Map(tokens.map((token) => [token.name, 1]));
    const label = (token) => token.path.slice(-depth.get(token.name)).join(".");

    for (let round = 0; round < 8; round += 1) {
        const seen = new Map();

        for (const token of tokens) {
            seen.set(label(token), (seen.get(label(token)) ?? 0) + 1);
        }

        let moved = false;

        for (const token of tokens) {
            if (seen.get(label(token)) > 1 && depth.get(token.name) < token.path.length) {
                depth.set(token.name, depth.get(token.name) + 1);
                moved = true;
            }
        }

        if (!moved) {
            break;
        }
    }

    return new Map(tokens.map((token) => [token.name, label(token)]));
}

export function matches(token, query) {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

    if (words.length === 0) {
        return true;
    }

    const text = [
        token.name,
        token.description ?? "",
        ...Object.values(token.modes).flatMap((mode) => [
            mode.css,
            mode.alias ?? "",
            showValue(token, mode),
        ]),
    ]
        .join(" ")
        .toLowerCase();

    return words.every((word) => text.includes(word));
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

export function amountOf(value) {
    if (isObject(value)) {
        return number(value.value) !== undefined && typeof value.unit === "string"
            ? { n: value.value, unit: value.unit }
            : null;
    }

    const match =
        typeof value === "string"
            ? /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)\s*$/i.exec(value)
            : null;

    return match ? { n: Number(match[1]), unit: match[2] } : null;
}

export function writeAmount(amount, like) {
    const n = Math.round(amount.n * 10000) / 10000;

    return isObject(like) ? { value: n, unit: amount.unit } : `${n}${amount.unit}`;
}

export function pixelsOf(value) {
    const amount = amountOf(value);

    if (amount === null) {
        return null;
    }

    return amount.unit === "px" || amount.unit === ""
        ? amount.n
        : amount.unit === "rem" || amount.unit === "em"
          ? amount.n * 16
          : null;
}

export function millisecondsOf(value) {
    const amount = amountOf(value);

    return amount === null
        ? null
        : amount.unit === "s"
          ? amount.n * 1000
          : amount.unit === "ms" || amount.unit === ""
            ? amount.n
            : null;
}

const family = (name) => (/^[\w-]+$/.test(name) ? name : `"${name.replace(/"/g, "'")}"`);

export function cssOf(type, value) {
    switch (type) {
        case "color": {
            if (typeof value === "string") {
                return value;
            }

            const color = parseColor(value);

            return color === undefined ? undefined : toHex(color);
        }

        case "dimension":

        case "duration": {
            const amount = amountOf(value);

            return amount === null ? undefined : `${amount.n}${amount.unit}`;
        }

        case "number":
        case "fontWeight":
            return typeof value === "number" || typeof value === "string"
                ? String(value)
                : undefined;
        case "fontFamily":
            return Array.isArray(value)
                ? value.map((each) => family(String(each))).join(", ")
                : typeof value === "string"
                  ? family(value)
                  : undefined;
        case "cubicBezier":
            return Array.isArray(value) &&
                value.length === 4 &&
                value.every((each) => number(each) !== undefined)
                ? `cubic-bezier(${value.join(", ")})`
                : undefined;
        default:
            return undefined;
    }
}

export const shadowValue = (layers) => (layers.length === 1 ? layers[0] : layers);

export const withPart = (layers, at, key, member) =>
    layers.map((layer, index) => {
        if (index !== at) {
            return layer;
        }

        const { inset: _, ...rest } = layer;

        return key === "inset"
            ? { ...rest, ...(member === true ? { inset: true } : {}) }
            : { ...layer, [key]: member };
    });

export const EDITABLE = new Set([
    "color",
    "dimension",
    "duration",
    "number",
    "fontWeight",
    "fontFamily",
    "cubicBezier",
    "shadow",
]);

export function readInput(type, text, like) {
    const input = String(text ?? "").trim();

    if (input === "") {
        return { error: "Enter a value." };
    }

    switch (type) {
        case "color": {
            const color = parseColor(input);

            return color === undefined
                ? { error: "Not a color. Try #3b6cf6, rgb(59 108 246), or oklch(0.6 0.2 260)." }
                : { value: writeColor(color, like) };
        }

        case "dimension":

        case "duration": {
            const units = type === "dimension" ? ["px", "rem", "em", "%", "vw", "vh"] : ["ms", "s"];
            const amount = amountOf(input);
            const unit =
                amount?.unit === "" || amount === null
                    ? (amountOf(like)?.unit ?? units[0])
                    : amount.unit;

            if (amount === null) {
                return {
                    error:
                        type === "dimension"
                            ? "Enter a size, like 16 or 1.5rem."
                            : "Enter a time, like 200ms or 0.4s.",
                };
            }

            if (!units.includes(unit)) {
                return { error: `Use ${units.slice(0, 4).join(", ")}.` };
            }

            return { value: writeAmount({ n: amount.n, unit }, like) };
        }

        case "number": {
            const value = Number(input);

            return Number.isFinite(value) ? { value } : { error: "Enter a number." };
        }

        case "fontWeight": {
            const value = Number(input);

            return Number.isFinite(value) && value >= 1 && value <= 1000
                ? { value: Math.round(value) }
                : { error: "Use a weight from 1 to 1000, like 400." };
        }

        case "fontFamily": {
            const names = input
                .split(",")
                .map((each) => each.trim().replace(/^["']|["']$/g, ""))
                .filter(Boolean);

            if (
                names.length === 0 ||
                names.length > 12 ||
                names.some((each) => each.length > 80 || /[<>{};\\]/.test(each))
            ) {
                return { error: "List up to 12 font names, separated by commas." };
            }

            return { value: Array.isArray(like) || names.length > 1 ? names : names[0] };
        }

        case "cubicBezier": {
            const values = input
                .replace(/^cubic-bezier\(|\)$/g, "")
                .split(/[\s,]+/)
                .filter(Boolean)
                .map(Number);

            return values.length === 4 &&
                values.every(Number.isFinite) &&
                values[0] >= 0 &&
                values[0] <= 1 &&
                values[2] >= 0 &&
                values[2] <= 1
                ? { value: values }
                : { error: "Four numbers. The first and third go from 0 to 1." };
        }

        default:
            return { error: "This kind of value is edited with Pi." };
    }
}

export function showValue(token, mode) {
    const { value, css } = mode;

    switch (token.type) {
        case "color": {
            const color = parseColor(value);

            return color === undefined ? String(css ?? "") : toHex(color);
        }

        case "dimension":
        case "duration":
            return cssOf(token.type, value) ?? css ?? "";
        case "fontFamily":
            return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
        case "cubicBezier":
            return Array.isArray(value) ? value.join(", ") : "";
        case "typography":
        case "shadow":
        case "gradient":
        case "border":
        case "transition":
        case "strokeStyle":
            return String(css ?? "");
        default:
            return value === null || value === undefined ? "" : String(value);
    }
}

const keyOf = (mode, token) => `${mode}\u0000${token}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const linkOf = (member) =>
    typeof member === "string" && /^\{[^{}]+\}$/.test(member) ? member.slice(1, -1) : null;

const rawOf = (value) =>
    value.alias === undefined ? { value: value.value } : { alias: value.alias };

export function createModel(system, edits = new Map()) {
    const tokens = new Map(system.tokens.map((token) => [token.name, token]));
    const defaultMode = system.modes[0];
    const cache = new Map();

    const savedRaw = (name, mode) => {
        const token = tokens.get(name);

        return token?.modes[mode] ? rawOf(token.modes[mode]) : undefined;
    };

    const ownSets = new Map(
        Object.entries(system.overrides ?? {}).map(([mode, list]) => [
            mode,
            Array.isArray(list) ? new Set(list) : null,
        ]),
    );

    const inherits = (name, mode) => {
        if (mode === defaultMode) {
            return false;
        }

        const set = ownSets.get(mode) ?? null;

        return set === null
            ? same(savedRaw(name, mode), savedRaw(name, defaultMode))
            : !set.has(name);
    };

    const editFor = (name, mode) => {
        const own = edits.get(keyOf(mode, name));

        if (own?.inherit === true) {
            return (
                edits.get(keyOf(defaultMode, name)) ?? {
                    saved: tokens.get(name)?.modes[defaultMode],
                }
            );
        }

        return own ?? (inherits(name, mode) ? edits.get(keyOf(defaultMode, name)) : undefined);
    };

    function resolve(name, mode, trail) {
        const token = tokens.get(name);
        const saved = token?.modes[mode];

        if (token === undefined || saved === undefined) {
            return { value: null, css: "", error: `No token ${name}.` };
        }

        if (trail.includes(name)) {
            return { value: null, css: "", error: `A loop: ${[...trail, name].join(" → ")}.` };
        }

        // A mode that takes the default's value follows an edit of the default.
        let edit = editFor(name, mode);

        if (edit?.saved !== undefined) {
            if (edit.saved.alias === undefined) {
                return { ...edit.saved, edited: true };
            }

            edit = { alias: edit.saved.alias };
        }

        if (edit?.alias !== undefined) {
            const target = resolve(edit.alias, mode, [...trail, name]);

            return {
                value: target.value,
                css: `var(${tokens.get(edit.alias)?.cssVar ?? "--unknown"})`,
                alias: edit.alias,
                edited: true,
                ...(target.error ? { error: target.error } : {}),
            };
        }

        if (edit !== undefined && token.type === "shadow") {
            return { ...shadowFrom(edit.value, mode, trail), edited: true };
        }

        if (edit !== undefined) {
            return {
                value: edit.value,
                css: cssOf(token.type, edit.value) ?? saved.css,
                edited: true,
            };
        }

        if (saved.alias !== undefined) {
            const target = resolve(saved.alias, mode, [...trail, name]);

            return target.edited || target.error || target.derived
                ? {
                      ...saved,
                      value: target.value,
                      derived: true,
                      ...(target.error ? { error: target.error } : {}),
                  }
                : saved;
        }

        return saved;
    }

    function shadowFrom(raw, mode, trail) {
        const value = [];
        const css = [];

        for (const layer of Array.isArray(raw) ? raw : [raw]) {
            if (!isObject(layer)) {
                continue;
            }

            const out = {};
            const bits = [];

            for (const key of ["offsetX", "offsetY", "blur", "spread", "color"]) {
                const member = layer[key] ?? (key === "color" ? "#00000000" : "0px");
                const link = linkOf(member);
                const target = link === null ? null : tokens.get(link);

                if (target === undefined) {
                    out[key] = key === "color" ? "#00000000" : "0px";
                    bits.push(key === "color" ? "transparent" : "0px");
                } else if (target !== null) {
                    out[key] = resolve(link, mode, trail).value;
                    bits.push(`var(${target.cssVar})`);
                } else {
                    out[key] = member;
                    bits.push(
                        (key === "color" ? swatchCss(member) : cssOf("dimension", member)) ||
                            (key === "color" ? "transparent" : "0px"),
                    );
                }
            }

            if (layer.inset === true) {
                out.inset = true;
            }

            value.push(out);
            css.push(`${layer.inset === true ? "inset " : ""}${bits.join(" ")}`);
        }

        return { value, css: css.join(", ") };
    }

    let named;
    let byVar;

    const model = {
        byVar: (name) =>
            (byVar ??= new Map(system.tokens.map((token) => [token.cssVar, token]))).get(name),
        roles: () => (named ??= roles(model)),
        system,
        defaultMode,
        modes: system.modes,
        tokens: system.tokens,
        token: (name) => tokens.get(name),
        has: (name) => tokens.has(name),
        raw: savedRaw,
        savedOverride: (name, mode) => mode === defaultMode || !inherits(name, mode),
        overridden(name, mode) {
            const own = edits.get(keyOf(mode, name));

            if (mode === defaultMode) {
                return true;
            }

            return own === undefined ? !inherits(name, mode) : own.inherit !== true;
        },
        shadowRaw(name, mode) {
            const owner = model.chain(name, mode).at(-1) ?? name;
            const token = tokens.get(owner);
            const edit = editFor(owner, mode);

            if (edit?.value !== undefined) {
                const list = Array.isArray(edit.value) ? edit.value : [edit.value];

                return { layers: list.filter(isObject).map((layer) => ({ ...layer })) };
            }

            const saved = edit?.saved ?? token?.modes[mode];
            const resolved = Array.isArray(saved?.value) ? saved.value : [saved?.value];
            const many = resolved.length > 1;

            return {
                layers: resolved.filter(isObject).map((layer, at) => {
                    const prefix = many ? `layer-${at + 1}-` : "";

                    const member = (part, key, fallback) => {
                        const found = /^var\((--[A-Za-z0-9_-]+)\)$/.exec(
                            saved.parts?.[prefix + part] ?? "",
                        );
                        const target = found === null ? undefined : model.byVar(found[1]);

                        return target === undefined ? (layer[key] ?? fallback) : `{${target.name}}`;
                    };

                    return {
                        offsetX: member("offset-x", "offsetX", "0px"),
                        offsetY: member("offset-y", "offsetY", "0px"),
                        blur: member("blur", "blur", "0px"),
                        spread: member("spread", "spread", "0px"),
                        color: member("color", "color", "#00000000"),
                        ...(layer.inset === true ? { inset: true } : {}),
                    };
                }),
            };
        },
        value(name, mode) {
            const key = keyOf(mode, name);

            if (!cache.has(key)) {
                cache.set(key, resolve(name, mode, []));
            }

            return cache.get(key);
        },
        edited: (name, mode) => model.value(name, mode).edited === true,
        dependents(name) {
            return system.tokens
                .filter((token) => Object.values(token.modes).some((each) => each.alias === name))
                .map((token) => token.name);
        },
        chain(name, mode) {
            const out = [name];

            for (
                let step = model.value(name, mode);
                step.alias !== undefined && out.length < 12 && !out.includes(step.alias);
                step = model.value(step.alias, mode)
            ) {
                out.push(step.alias);
            }

            return out;
        },
        targets(name) {
            const token = tokens.get(name);

            return system.tokens.filter(
                (each) =>
                    each.name !== name &&
                    each.type === token?.type &&
                    !model.reaches(each.name, name),
            );
        },
        reaches(from, to, seen = new Set()) {
            if (from === to) {
                return true;
            }

            if (seen.has(from)) {
                return false;
            }

            seen.add(from);

            const token = tokens.get(from);

            return Object.values(token?.modes ?? {}).some(
                (each) => each.alias !== undefined && model.reaches(each.alias, to, seen),
            );
        },
        pairsOf(name) {
            const token = tokens.get(name);

            if (token?.type !== "color") {
                return [];
            }

            const declared = (
                token.contrasts ?? (token.contrast === undefined ? [] : [token.contrast])
            ).map((pair) => ({
                on: String(pair.on).replace(/^\{|\}$/g, ""),
                min: pair.min,
                ...(pair.exempt === undefined ? {} : { exempt: pair.exempt }),
                auto: false,
            }));

            if (declared.length > 0) {
                return declared;
            }

            const ground = isText(token) ? model.roles().canvas : undefined;

            return ground === undefined || ground === name
                ? []
                : [{ on: ground, min: 4.5, auto: true }];
        },
        gradeOf(name, mode, pair) {
            const ink = parseColor(model.value(name, mode).value);
            const ground = tokens.has(pair.on)
                ? parseColor(model.value(pair.on, mode).value)
                : null;

            return ink && ground
                ? { ...grade(contrastRatio(ink, ground), pair.min), ...pair }
                : null;
        },
        contrastsOf: (name, mode) =>
            model
                .pairsOf(name)
                .map((pair) => model.gradeOf(name, mode, pair))
                .filter(Boolean),
        contrastOf(name, mode) {
            const pair = model.pairsOf(name)[0];

            return pair === undefined ? null : model.gradeOf(name, mode, pair);
        },
    };

    return model;
}

// `inverse`, `faint`, `disabled`, and `on-accent` sit on another ground: only a declared pair can say.
const isText = (token) =>
    token.path
        .slice(0, -1)
        .some((part) => /^(text|fg|foreground|content|ink|label)$/i.test(part)) &&
    /^(primary|secondary|tertiary|muted|default|body|strong|link)$/i.test(token.path.at(-1) ?? "");

const ROLES = {
    canvas: {
        group: ["bg", "background", "surface", "canvas", "color"],
        name: ["canvas", "page", "app", "background", "base", "body", "default"],
    },
    surface: {
        group: ["bg", "background", "surface", "color"],
        name: ["surface", "card", "panel", "container", "raised", "elevated"],
    },
    text: {
        group: ["text", "fg", "foreground", "content", "ink"],
        name: ["primary", "default", "base", "body", "strong", "main"],
    },
    muted: {
        group: ["text", "fg", "foreground", "content", "ink"],
        name: ["muted", "secondary", "subtle", "tertiary", "weak", "dim", "faint"],
    },
    accent: {
        group: ["accent", "primary", "brand", "action"],
        name: ["default", "base", "main", "500", "600"],
    },
    onAccent: {
        group: ["text", "fg", "foreground", "on", "content"],
        name: ["inverse", "on-accent", "onaccent"],
    },
    border: {
        group: ["border", "line", "outline", "divider", "stroke"],
        name: ["default", "base", "subtle", "muted"],
    },
    danger: {
        group: [
            "status",
            "state",
            "feedback",
            "semantic",
            "danger",
            "error",
            "negative",
            "destructive",
        ],
        name: ["danger", "error", "negative", "destructive", "critical", "default"],
    },
    success: {
        group: ["status", "state", "feedback", "semantic", "success", "positive", "ok"],
        name: ["success", "positive", "ok", "default"],
    },
    warning: {
        group: ["status", "state", "feedback", "semantic", "warning", "caution"],
        name: ["warning", "caution", "default"],
    },
};

export function roles(model) {
    const found = {};
    const colors = model.tokens.filter((token) => token.type === "color");

    for (const [role, words] of Object.entries(ROLES)) {
        let best;
        let top = 0;

        for (const token of colors) {
            const parts = token.path.map((part) => part.toLowerCase());
            const name = parts.at(-1) ?? "";
            const group = parts.length > 1 ? parts.at(-2) : "";
            const named = words.name.indexOf(name);
            const grouped = words.group.indexOf(group);

            // A hover or a disabled state is never the role.
            if (
                named === -1 ||
                grouped === -1 ||
                /(hover|active|pressed|disabled)/.test(token.name)
            ) {
                continue;
            }

            const score = 100 - named * 4 - grouped + (token.tier === "semantic" ? 2 : 0);

            if (score > top) {
                best = token.name;
                top = score;
            }
        }

        if (best !== undefined) {
            found[role] = best;
        }
    }

    return found;
}

export const emptyHistory = () => ({ past: [], future: [] });

const GUIDELINES = "guidelines";
// Edits to one thing closer than this make one undo step (a color picker drag).
const COALESCE_MS = 1200;

const editKey = (op) => (op.kind === "guidelines" ? GUIDELINES : keyOf(op.mode, op.token));

export const tokenEdit = (mode, token, raw) => ({ kind: "token", mode, token, raw });

export const guidelinesEdit = (text) => ({ kind: "guidelines", text });

// Past this, the oldest step that a later one shadows goes first.
const MAX_STEPS = 500;

export function push(history, op, now = Date.now(), coalesce = true) {
    const last = history.past.at(-1);
    const again =
        coalesce &&
        last !== undefined &&
        editKey(last) === editKey(op) &&
        now - (last.at ?? 0) < COALESCE_MS;
    let past = [...(again ? history.past.slice(0, -1) : history.past), { ...op, at: now }];

    // Keep the newest steps: drop the first one whose thing a later step sets again.
    if (past.length > MAX_STEPS) {
        const keys = past.map(editKey);
        const shadowed = keys.findIndex((key, at) => keys.indexOf(key, at + 1) !== -1);

        past = past.filter((_, at) => at !== (shadowed === -1 ? 0 : shadowed));
    }

    return { past, future: [] };
}

export function undo(history) {
    const last = history.past.at(-1);

    return last === undefined
        ? history
        : { past: history.past.slice(0, -1), future: [...history.future, last] };
}

export function redo(history) {
    const next = history.future.at(-1);

    return next === undefined
        ? history
        : { past: [...history.past, { ...next, at: 0 }], future: history.future.slice(0, -1) };
}

export function editsOf(history) {
    const edits = new Map();

    for (const op of history.past) {
        edits.set(editKey(op), op);
    }

    return edits;
}

export function tokenEdits(history) {
    return new Map(
        [...editsOf(history)]
            .filter(([, op]) => op.kind === "token")
            .map(([key, op]) => [key, op.raw]),
    );
}

export function changeOf(system, history) {
    const model = createModel(system);
    const set = [];
    const remove = [];
    let guidelines;

    for (const [, op] of editsOf(history)) {
        if (op.kind === "guidelines") {
            if (op.text !== system.guidelines) {
                guidelines = op.text;
            }

            continue;
        }

        if (op.raw.inherit === true) {
            if (op.mode !== model.defaultMode && model.savedOverride(op.token, op.mode)) {
                remove.push({ mode: op.mode, token: op.token });
            }

            continue;
        }

        const saved = model.raw(op.token, op.mode);

        // A value that a mode only has by taking the default's is not set again: that would be a copy.
        if (saved !== undefined && same(saved, op.raw)) {
            continue;
        }

        set.push({
            mode: op.mode,
            token: op.token,
            value: op.raw.alias === undefined ? op.raw.value : `{${op.raw.alias}}`,
        });
    }

    return {
        set,
        ...(remove.length === 0 ? {} : { remove }),
        ...(guidelines === undefined ? {} : { guidelines }),
        count: set.length + remove.length + (guidelines === undefined ? 0 : 1),
    };
}

// Safe inside a `<style>`: no markup, no block, no escape, no import or url.
export function safeCss(value) {
    const text = String(value ?? "");

    return text.length <= 400 && !/[<>{};\\]|\/\*|url\(|@|expression\(|[\u0000-\u001f]/i.test(text)
        ? text
        : "";
}

// The artifact bridge takes `--` and up to 78 letters, digits, `_`, `-`.
const bridgeName = (cssVar) => /^--[A-Za-z0-9_-]{1,78}$/.test(cssVar);

// The bridge refuses a value past 200 characters, and a refused batch changes nothing: a long one is left out.
export function previewVars(model, mode) {
    const base = model.defaultMode;
    const out = {};

    for (const token of model.tokens) {
        const css = safeCss(model.value(token.name, mode).css);
        const varies = model.modes.some(
            (other) => token.modes[other]?.css !== token.modes[base]?.css,
        );

        if (
            css !== "" &&
            css.length <= 200 &&
            bridgeName(token.cssVar) &&
            (varies || css !== token.modes[base]?.css)
        ) {
            out[token.cssVar] = css;
        }
    }

    return out;
}

export function themeCss(model, mode) {
    return `:root{${model.tokens
        .map((token) => [token.cssVar, safeCss(model.value(token.name, mode).css)])
        .filter(([name, css]) => css !== "" && /^--[A-Za-z0-9_-]+$/.test(name))
        .map(([name, css]) => `${name}:${css}`)
        .join(";")}}`;
}

const FONTS = {
    geist: '"Pocket Sans", Geist',
    "jetbrains mono": '"Pocket Mono", "JetBrains Mono"',
};

export const fontStack = (css) =>
    css
        .split(",")
        .map((part) => {
            const name = part.trim().replace(/^["']|["']$/g, "");

            return FONTS[name.toLowerCase()] ?? part.trim();
        })
        .join(", ");

export function typographyStyle(value) {
    if (!isObject(value)) {
        return "";
    }

    const parts = [];

    const add = (name, css) => {
        const safe = css === undefined ? "" : safeCss(css);

        if (safe !== "") {
            parts.push(`${name}:${safe}`);
        }
    };

    const family = cssOf("fontFamily", value.fontFamily);

    add("font-family", family === undefined ? undefined : fontStack(family));
    add("font-size", cssOf("dimension", value.fontSize));
    add(
        "font-weight",
        typeof value.fontWeight === "number" || typeof value.fontWeight === "string"
            ? String(value.fontWeight)
            : undefined,
    );
    add(
        "line-height",
        typeof value.lineHeight === "number"
            ? String(value.lineHeight)
            : cssOf("dimension", value.lineHeight),
    );
    add("letter-spacing", cssOf("dimension", value.letterSpacing));

    return parts.join(";");
}

export function shadowOf(value) {
    const layers = Array.isArray(value) ? value : [value];
    const css = layers
        .map((layer) => {
            if (!isObject(layer)) {
                return "";
            }

            const color = swatchCss(layer.color);
            const sizes = ["offsetX", "offsetY", "blur", "spread"].map((key) =>
                cssOf("dimension", layer[key] ?? "0px"),
            );

            return color === "" || sizes.includes(undefined)
                ? ""
                : `${layer.inset === true ? "inset " : ""}${sizes.join(" ")} ${color}`;
        })
        .filter(Boolean)
        .join(", ");

    return safeCss(css);
}

function layerWords(layer) {
    const size = (member) => {
        const px = pixelsOf(member ?? "0px");

        return px === null ? (cssOf("dimension", member) ?? "0") : Math.round(px * 10) / 10;
    };

    const [x, y, blur, spread] = [layer.offsetX, layer.offsetY, layer.blur, layer.spread].map(size);
    const alpha = parseColor(layer.color)?.a;
    const parts = [
        ...(x !== 0 && x !== "0" ? [`x ${x}`] : []),
        `y ${y}`,
        `blur ${blur}`,
        ...(spread !== 0 && spread !== "0" && spread !== undefined ? [`spread ${spread}`] : []),
        ...(alpha === undefined || alpha >= 1 ? [] : [`${Math.round(alpha * 100)}%`]),
    ];

    return `${layer.inset === true ? "inset " : ""}${parts.join(" · ")}`;
}

export function shadowLines(value) {
    return (Array.isArray(value) ? value : [value])
        .filter(isObject)
        .map((layer) => ({ words: layerWords(layer), color: layer.color }));
}

export const unsavedCount = (system, history) => (system ? changeOf(system, history).count : 0);

const VAR = /var\((--[A-Za-z0-9_-]{1,78})\)/g;

export function literalOf(model, mode, text, depth = 0) {
    return depth > 6
        ? text
        : text.replace(VAR, (whole, name) => {
              const token = model.byVar(name);
              const css = token ? safeCss(model.value(token.name, mode).css) : "";

              return css === "" ? whole : literalOf(model, mode, css, depth + 1);
          });
}

export function scopeStyle(model, mode, text, limit = 40) {
    const declared = new Map();
    const queue = [text];

    while (queue.length > 0 && declared.size < limit) {
        for (const [, name] of queue.pop().matchAll(VAR)) {
            const token = declared.has(name) ? undefined : model.byVar(name);
            let css = token ? safeCss(model.value(token.name, mode).css) : "";

            if (css !== "") {
                css = token.type === "fontFamily" ? fontStack(css) : css;
                declared.set(name, css);
                queue.push(css);
            }
        }
    }

    return [...declared].map(([name, css]) => `${name}:${css}`).join(";");
}

const TYPE_PARTS = ["font-family", "font-size", "font-weight", "line-height", "letter-spacing"];

export function typographyStyleOf(model, mode, now) {
    const parts = isObject(now.parts) ? now.parts : undefined;

    if (parts === undefined) {
        return typographyStyle(now.value);
    }

    const text = TYPE_PARTS.map((name) => parts[name]).filter((part) => typeof part === "string");
    const rules = TYPE_PARTS.flatMap((name) => {
        const css = typeof parts[name] === "string" ? safeCss(parts[name]) : "";

        return css === "" ? [] : [`${name}:${name === "font-family" ? fontStack(css) : css}`];
    });

    return [scopeStyle(model, mode, text.join(" ")), ...rules].filter(Boolean).join(";");
}

export function typographyMeta(model, mode, now) {
    const parts = isObject(now.parts) ? now.parts : undefined;
    const part = (name) =>
        typeof parts?.[name] === "string" ? literalOf(model, mode, parts[name]) : undefined;

    if (parts === undefined) {
        return undefined;
    }

    const size = part("font-size");
    const height = part("line-height");
    const family = part("font-family")
        ?.split(",")[0]
        ?.trim()
        .replace(/^["']|["']$/g, "");

    return [
        [size, height === undefined ? "" : `/ ${height}`].filter(Boolean).join(" "),
        part("font-weight"),
        family,
    ]
        .filter((each) => each !== undefined && each !== "")
        .join(" · ");
}
