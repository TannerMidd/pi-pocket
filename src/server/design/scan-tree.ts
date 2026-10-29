/** The DTCG draft of the scan (stream T): a token's group and name, the node that holds its value, and the tree that is assembled from them. */
import { words } from "./scan-colors.ts";
import { type Category } from "./scan-facts.ts";
import { stackOf } from "./scan-facts-use.ts";
import { bezier, shadowValue } from "./scan-scales.ts";
import { type Obj, slug } from "./scan-util.ts";
import { type Variable } from "./scan-variables.ts";
import { GRADIENT, LENGTH } from "./scan-categorize.ts";

const GROUPS: Record<Category, string> = {
    color: "color",
    font: "font",
    text: "text",
    space: "space",
    radius: "radius",
    shadow: "shadow",
    duration: "duration",
    ease: "ease",
    breakpoint: "breakpoint",
    weight: "weight",
    leading: "leading",
    tracking: "tracking",
    z: "z",
    opacity: "opacity",
    size: "size",
    gradient: "gradient",
};

const PREFIX: Record<Category, RegExp> = {
    color: /^(?:theme-)?(?:colou?rs?|clr)-?/,
    font: /^(?:font(?:-family)?|family|typeface)-?/,
    text: /^(?:font-size|text|fs|size|type|step)-?/,
    space: /^(?:spacing|spacers?|space|gap|gutter)-?/,
    radius: /^(?:border-)?(?:radius|rounded|corner)-?/,
    shadow: /^(?:box-)?shadow-?|^elevation-?/,
    duration: /^(?:transition-)?(?:duration|time|speed)-?/,
    ease: /^(?:transition-)?(?:ease|easing|timing|curve)-?/,
    breakpoint: /^(?:breakpoint|screen|bp)-?/,
    weight: /^(?:font-weight|weight|fw)-?/,
    leading: /^(?:leading|line-height|lh)-?/,
    tracking: /^(?:tracking|letter-spacing)-?/,
    z: /^(?:z-index|z|layer)-?/,
    opacity: /^opacity-?/,
    size: /^(?:size|container|blur)-?/,
    gradient: /^(?:gradient|bg-gradient)-?/,
};

const FALLBACK_NAME: Record<Category, string> = {
    color: "base",
    font: "sans",
    text: "base",
    space: "base",
    radius: "md",
    shadow: "md",
    duration: "base",
    ease: "base",
    breakpoint: "base",
    weight: "base",
    leading: "base",
    tracking: "base",
    z: "base",
    opacity: "base",
    size: "base",
    gradient: "base",
};

/** Words that name a role, or its colors (`hover`-ed or `dark`-ened): such a color is nested, not a role of its own. */
const ROLE_WORDS = new Set(
    "accent brand primary link highlight danger error destructive critical negative warning warn caution success positive valid ok bg background canvas page surface card panel elevated raised popover layer text fg foreground ink content muted subtle dim faint quiet tertiary border divider outline stroke line separator hairline".split(
        " ",
    ),
);

/** The token path of a project variable: its group, and its name without the group's own prefix. */
export function nameOf(variable: Variable, category: Category): string {
    // `borderRadius` and `border-radius` are one name.
    const stripped = variable.name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .replace(PREFIX[category], "");

    return slug(stripped.replace(/\.+/g, "-"));
}

export function pathOf(variable: Variable, category: Category): string[] {
    const name = nameOf(variable, category);
    const [first, ...tail] = name.split("-");

    // `--accent-hover` is `color.accent.hover`, beside `color.accent.default`; `--primary` is `color.primary.default`.
    // A color with a role word in its name sits one level down, so that it never takes the place of the role's own token.
    if (category === "color" && name !== "" && words(name).some((word) => ROLE_WORDS.has(word))) {
        return tail.length > 0 ? ["color", first!, tail.join("-")] : ["color", first!, "default"];
    }

    return [GROUPS[category], name === "" ? FALLBACK_NAME[category] : name];
}

// --- Values --------------------------------------------------------------------------------------------------------

/** The DTCG node for a variable's value in a category, or undefined when the value does not fit. */
export function nodeFor(category: Category, text: string, colorText?: string): Obj | undefined {
    switch (category) {
        case "color":
            return colorText === undefined ? undefined : { $value: colorText, $type: "color" };

        case "font": {
            const stack = stackOf(text);

            return stack === undefined ? undefined : { $value: stack, $type: "fontFamily" };
        }

        case "weight": {
            const weight = Number(text);

            return Number.isFinite(weight) && weight >= 1 && weight <= 1000
                ? { $value: weight, $type: "fontWeight" }
                : undefined;
        }

        case "duration":
            return /^\d*\.?\d+(?:ms|s)$/.test(text)
                ? { $value: text, $type: "duration" }
                : undefined;

        case "ease": {
            const value = bezier(text);

            return value === undefined ? undefined : { $value: value, $type: "cubicBezier" };
        }

        case "shadow": {
            const value = shadowValue(text);

            return { $value: value, $type: "shadow" };
        }

        case "gradient":
            return GRADIENT.test(text) ? { $value: text, $type: "gradient" } : undefined;

        case "z":
        case "opacity":

        case "leading": {
            const value = Number(text);

            return Number.isFinite(value) ? { $value: value, $type: "number" } : undefined;
        }

        default: {
            // A dimension: text, space, radius, breakpoint, tracking, size.
            if (!LENGTH.test(text)) {
                return undefined;
            }

            const unitless = /^-?\d*\.?\d+$/.test(text);

            return {
                $value: unitless && Number(text) !== 0 ? `${text}px` : text,
                $type: "dimension",
            };
        }
    }
}

// --- The draft -----------------------------------------------------------------------------------------------------

/** How much of one step ran: `until` is when it must end, `read` counts the entries it placed, and `stopped` says the time
 * ended it early. */
export interface Progress {
    until: number;
    read: number;
    stopped: boolean;
}

/**
 * Nested objects from flat tokens. A token that is also a group (`color.primary` and `color.primary.foreground`) becomes
 * `….default`. Past `progress.until` the rest of the entries are left out.
 */
export function assemble(
    entries: { path: string[]; node: Obj }[],
    renamed: Map<string, string>,
    progress?: Progress,
): Obj {
    const paths = new Set(entries.map((entry) => entry.path.join(".")));
    // The names that hold another name, indexed once: asking every path for every entry is quadratic, and 40 000 variables took
    // 27 seconds that way.
    const groups = new Set<string>();

    for (const path of paths) {
        for (let at = path.indexOf("."); at > 0; at = path.indexOf(".", at + 1)) {
            groups.add(path.slice(0, at));
        }
    }

    const root: Obj = {};

    for (const entry of entries) {
        if (progress !== undefined && Date.now() >= progress.until) {
            progress.stopped = true;

            break;
        }

        const name = entry.path.join(".");
        let path = entry.path;

        if (groups.has(name)) {
            path = [...entry.path, paths.has(`${name}.default`) ? "base" : "default"];
            renamed.set(name, path.join("."));
        }

        let node = root;

        for (const key of path.slice(0, -1)) {
            node[key] ??= {};
            node = node[key] as Obj;
        }

        node[path.at(-1)!] = entry.node;

        if (progress !== undefined) {
            progress.read += 1;
        }
    }

    return root;
}

/** Hoists a `$type` shared by every token of a top-level group onto the group. */
export function hoistTypes(root: Obj): void {
    for (const group of Object.values(root)) {
        if (typeof group !== "object" || group === null || "$value" in group) {
            continue;
        }

        const types = new Set<string>();

        const visit = (node: Obj) => {
            for (const [key, child] of Object.entries(node)) {
                if (key.startsWith("$") || typeof child !== "object" || child === null) {
                    continue;
                }

                if ("$value" in child) {
                    types.add(String((child as Obj).$type));
                } else {
                    visit(child as Obj);
                }
            }
        };

        visit(group as Obj);

        if (types.size === 1) {
            const [type] = types;

            const strip = (node: Obj) => {
                for (const [key, child] of Object.entries(node)) {
                    if (!key.startsWith("$") && typeof child === "object" && child !== null) {
                        if ("$value" in child) {
                            delete (child as Obj).$type;
                        } else {
                            strip(child as Obj);
                        }
                    }
                }
            };

            strip(group as Obj);

            // `$type` first, so the file reads naturally.
            const rest = { ...(group as Obj) };

            for (const key of Object.keys(group as Obj)) {
                delete (group as Obj)[key];
            }

            Object.assign(group as Obj, { $type: type }, rest);
        }
    }
}

/** A mode file needs no `$type`: a token takes it from the default mode. */
export function dropTypes(node: Obj): Obj {
    for (const [key, child] of Object.entries(node)) {
        if (
            typeof child === "object" &&
            child !== null &&
            !Array.isArray(child) &&
            !key.startsWith("$")
        ) {
            if ("$value" in child) {
                delete (child as Obj).$type;
            } else {
                dropTypes(child as Obj);
            }
        }
    }

    return node;
}

/** Rewrites `{name}` references to tokens that were renamed. */
export function rewrite(node: unknown, renamed: Map<string, string>): unknown {
    if (typeof node === "string") {
        return node.replace(/\{([^{}]+)\}/g, (all, name: string) =>
            renamed.has(name) ? `{${renamed.get(name)}}` : all,
        );
    }

    if (Array.isArray(node)) {
        return node.map((item) => rewrite(item, renamed));
    }

    if (typeof node === "object" && node !== null) {
        return Object.fromEntries(
            Object.entries(node).map(([key, value]) => [key, rewrite(value, renamed)]),
        );
    }

    return node;
}
