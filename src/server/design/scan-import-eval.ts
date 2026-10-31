import { convert, isObject, type Obj } from "./scan-import-convert.ts";
import { parseColor, toHex } from "./color.ts";
import { evalMath } from "./scan-variables.ts";

// Type style members the scan leaves out: a failed reference in one must not drop the style.
const OPTIONAL_MEMBERS = new Set([
    "textCase",
    "textDecoration",
    "paragraphSpacing",
    "paragraphIndent",
]);

export const LIMITS = {
    sets: 40,
    tokens: 5000,
    depth: 12,
    refs: 24,
    text: 400,
    // Text made by references: `{a}{a}` at each level doubles it.
    made: 4000,
} as const;

export interface Entry {
    path: string[];
    node: Obj;
    type: string | undefined;
}

export function segment(text: string): string {
    const dashed = text.replace(/[^\w-]+/g, "-");
    let start = 0;
    let end = dashed.length;

    while (start < end && dashed[start] === "-") {
        start++;
    }

    while (end > start && dashed[end - 1] === "-") {
        end--;
    }

    return dashed.slice(start, end);
}

export const words = (text: string) =>
    text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word !== "");
export const DARK = new Set(["dark", "night", "midnight", "black"]);
export const LIGHT = new Set(["light", "day", "daylight"]);
export const hasWord = (text: string, list: Set<string>) =>
    words(text).some((word) => list.has(word));

const textOr = (value: unknown, fallback: string | undefined) =>
    typeof value === "string" ? value : fallback;

// Keys that would reach an object's prototype.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function flatten(tree: Obj, into: Map<string, Entry>, budget: { left: number }): void {
    const visit = (node: Obj, path: string[], inherited: string | undefined, depth: number) => {
        if (depth > LIMITS.depth) {
            return;
        }

        const isToken = "value" in node || "$value" in node;
        const own = textOr(node.$type, isToken ? inherited : textOr(node.type, inherited));

        for (const [rawKey, child] of Object.entries(node)) {
            const key = segment(rawKey);

            if (
                rawKey.startsWith("$") ||
                key === "" ||
                UNSAFE_KEYS.has(key) ||
                !isObject(child) ||
                budget.left <= 0
            ) {
                continue;
            }

            if ("$value" in child || "value" in child) {
                const type = textOr(child.$type, textOr(child.type, own));

                budget.left -= 1;
                into.set([...path, key].join("."), { path: [...path, key], node: child, type });
            } else {
                visit(child, [...path, key], own, depth + 1);
            }
        }
    };

    visit(tree, [], undefined, 0);
}

const ALPHA = /^rgba?\(\s*(\{[^{}]+\}|\$[\w.-]+|#[0-9a-f]{3,8})\s*,\s*(\d*\.?\d+%?)\s*\)$/i;
const REFERENCE = /\{([^{}]+)\}|(?<![\w$])\$([A-Za-z_][\w-]*(?:\.[\w-]+)+)/g;

function wholeReference(text: string): string | undefined {
    const match = /^\{([^{}]+)\}$|^\$([A-Za-z_][\w-]*(?:\.[\w-]+)+)$/.exec(text);

    return match === null ? undefined : (match[1] ?? match[2] ?? "");
}

function place(tree: Obj, path: string[], token: Obj, intoTokens: boolean): void {
    let group = tree;

    for (const part of path.slice(0, -1)) {
        const next = group[part];

        if (isObject(next) && (intoTokens || !("$value" in next))) {
            group = next;
        } else {
            const made: Obj = {};

            group[part] = made;
            group = made;
        }
    }

    group[path.at(-1)!] = token;
}

const modifies = (node: Obj) =>
    isObject(node.$extensions) &&
    isObject(node.$extensions["studio.tokens"]) &&
    isObject(node.$extensions["studio.tokens"].modify);

export class Mode {
    entries: Map<string, Entry>;
    done = new Map<string, unknown>();

    constructor(entries: Map<string, Entry>) {
        this.entries = entries;
    }

    keyOf(reference: string): string {
        const key = reference.trim().split(".").map(segment).join(".");

        // Style Dictionary refers to a value: `{color.red.value}` is the token `color.red`.
        return this.entries.has(key) ? key : key.replace(/\.\$?value$/, "");
    }

    valueOf(key: string, stack: string[] = []): unknown {
        if (this.done.has(key)) {
            return this.done.get(key);
        }

        const entry = this.entries.get(key);

        if (entry === undefined || stack.includes(key) || stack.length > LIMITS.refs) {
            return undefined;
        }

        const raw = entry.node.$value ?? entry.node.value;
        // A Tokens Studio color modifier (`lighten`, `mix`) is not run: better left out than wrong.
        const value = modifies(entry.node) ? undefined : this.evaluate(raw, [...stack, key]);

        this.done.set(key, value);

        return value;
    }

    evaluate(raw: unknown, stack: string[], depth = 0): unknown {
        if (depth > LIMITS.depth) {
            return undefined;
        }

        if (Array.isArray(raw)) {
            const items = raw.slice(0, 16).map((item) => this.evaluate(item, stack, depth + 1));

            return items.some((item) => item === undefined) ? undefined : items;
        }

        if (isObject(raw)) {
            const out: Obj = {};

            for (const [name, member] of Object.entries(raw).slice(0, 24)) {
                const value = this.evaluate(member, stack, depth + 1);

                if (value !== undefined) {
                    out[name] = value;
                } else if (!OPTIONAL_MEMBERS.has(name)) {
                    return undefined;
                }
            }

            return out;
        }

        if (typeof raw !== "string") {
            return raw;
        }

        const text = raw.slice(0, LIMITS.text).trim();
        const alpha = ALPHA.exec(text);

        if (alpha !== null) {
            const base = /^[{$]/.test(alpha[1]!)
                ? this.valueOf(this.keyOf(alpha[1]!.replace(/^\{|\}$|^\$/g, "")), stack)
                : alpha[1];
            const color = typeof base === "string" ? parseColor(base) : undefined;
            const opacity = alpha[2]!.endsWith("%")
                ? Number.parseFloat(alpha[2]!) / 100
                : Number(alpha[2]);

            return color === undefined
                ? undefined
                : toHex({ ...color, a: Math.min(1, Math.max(0, opacity)) });
        }

        const whole = wholeReference(text);

        if (whole !== undefined) {
            return this.valueOf(this.keyOf(whole), stack);
        }

        let missing = false;
        const replaced = text.replace(
            REFERENCE,
            (_, braced: string | undefined, dollar: string | undefined) => {
                const found = this.valueOf(this.keyOf(braced ?? dollar ?? ""), stack);

                if (
                    found === undefined ||
                    (typeof found === "object" && found !== null) ||
                    String(found).length > LIMITS.made
                ) {
                    missing = true;

                    return "";
                }

                return String(found);
            },
        );

        if (missing || replaced.length > LIMITS.made) {
            return undefined;
        }

        const math = /^calc\((.*)\)$/is.exec(replaced)?.[1] ?? replaced;
        const result = /[*/+]|\s-\s/.test(math) ? evalMath(math, () => undefined) : undefined;

        // Tokens Studio math functions (`round({a} * 1.6)`) are not run: the token is left out.
        if (result === undefined && /^(?:round|floor|ceil|abs|sqrt|min|max|pow)\(/i.test(math)) {
            return undefined;
        }

        return result ?? replaced;
    }
}

export function tokensOf(mode: Mode): { tree: Obj; flat: Map<string, Obj> } {
    const tree: Obj = {};
    const flat = new Map<string, Obj>();

    for (const [key, entry] of mode.entries) {
        const raw = entry.node.$value ?? entry.node.value;
        const alias = typeof raw === "string" ? wholeReference(raw.trim()) : undefined;
        const target = alias === undefined ? undefined : mode.keyOf(alias);
        const resolved = mode.valueOf(key);

        if (resolved === undefined) {
            continue;
        }

        const value = target !== undefined && mode.entries.has(target) ? `{${target}}` : resolved;
        const token = convert(entry.node, value, entry.type);

        if (token === undefined) {
            continue;
        }

        place(tree, entry.path, token, false);
        flat.set(key, token);
    }

    return { tree, flat };
}

export function changesBetween(
    base: Map<string, Obj>,
    mode: Map<string, Obj>,
): { tree: Obj; skipped: number } {
    const tree: Obj = {};
    let skipped = 0;

    for (const [key, token] of mode) {
        const first = base.get(key);

        if (first === undefined) {
            skipped += 1;
        } else if (JSON.stringify(first.$value) !== JSON.stringify(token.$value)) {
            place(tree, key.split("."), token, true);
        }
    }

    return { tree, skipped };
}
