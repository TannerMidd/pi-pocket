import type { Category, Facts, VarFact } from "./scan-facts.ts";
import { kebab, vkey } from "./scan-colors.ts";
import { parseColor } from "./color.ts";

export interface Variable {
    name: string;
    kind: VarFact["kind"];
    light?: VarFact;
    dark?: VarFact;
    spare?: VarFact;
    twin?: boolean;
    hint?: Category;
}

type Mode = "dark" | "light";
type Found = { text: string; via?: Variable };
type Lookup = (name: string, kind: "scss" | "less" | "css") => string | undefined;

export const modeValue = (variable: Variable, mode: Mode) =>
    (mode === "dark" ? (variable.dark ?? variable.light) : (variable.light ?? variable.dark))
        ?.value;

const otherMode = (mode: Mode): Mode => (mode === "dark" ? "light" : "dark");

export function variables(facts: Facts, alt: Mode): Variable[] {
    const map = new Map<string, Variable>();
    const better = (a: VarFact | undefined, b: VarFact) =>
        a === undefined || b.rank < a.rank || (b.rank === a.rank && b.order > a.order);

    for (const fact of facts.vars) {
        const key = vkey(fact);
        const variable = map.get(key) ?? { name: fact.name, kind: fact.kind, hint: fact.hint };

        // The project's opposite mode only fills in what the default scope does not set.
        if (fact.scope === "default" && better(variable.light, fact)) {
            variable.light = fact;
        } else if (fact.scope === alt && better(variable.dark, fact)) {
            variable.dark = fact;
        } else if (fact.scope === otherMode(alt) && variable.light === undefined) {
            variable.spare = fact;
        }

        if (fact.hint !== undefined) {
            variable.hint = fact.hint;
        }

        map.set(key, variable);
    }

    for (const variable of map.values()) {
        variable.light ??= variable.spare;
    }

    pairModeTwins(map, alt);
    pairSassNames(map, alt);
    pairModeSuffixes(map, alt);

    return [...map.values()].filter(
        (variable) => variable.light !== undefined || variable.dark !== undefined,
    );
}

// `--bg: var(--dark-bg)` in the dark scope makes a sure pair; otherwise three pairs make a scheme,
// and a `-light` or `-main` sibling (`primary-dark` beside `primary-light`) makes it a shade.
function pairModeTwins(map: Map<string, Variable>, alt: Mode): void {
    const mode = alt === "dark" ? /^(?:dark|night|dk|drk|d)$/ : /^(?:light|day|lt|lgt|l)$/;
    const plain = (name: string) => kebab(name).replace(/^(?:color|colour|clr)-/, "");
    const byName = new Map<string, Variable>();

    for (const [key, variable] of map) {
        if (/^(?:css|scss|less|js):/.test(key)) {
            byName.set(`${variable.kind}:${plain(variable.name)}`, variable);
        }
    }

    const pairs: { twin: Variable; base: Variable; sure: boolean }[] = [];

    for (const variable of map.values()) {
        const words = plain(variable.name).split("-");
        const at = words.findIndex((word) => mode.test(word));

        if (at === -1 || words.length < 2 || variable.light === undefined) {
            continue;
        }

        const rest = words.filter((_, index) => index !== at).join("-");
        const base = byName.get(`${variable.kind}:${rest}`);

        if (base === undefined || base === variable) {
            continue;
        }

        const target = new RegExp(String.raw`var\(\s*--${variable.name}\s*[,)]`);
        const sure = base.dark !== undefined && target.test(base.dark.value);
        const stem = words.slice(0, at).join("-");
        const shade =
            at === words.length - 1 &&
            [...map.values()].some((other) => {
                const name = plain(other.name);

                return (
                    name.startsWith(`${stem}-`) &&
                    /^(?:light|main|base|default)$/.test(name.slice(stem.length + 1))
                );
            });

        if (sure || !shade) {
            pairs.push({ twin: variable, base, sure });
        }
    }

    if (pairs.length < 3 && !pairs.some((pair) => pair.sure)) {
        return;
    }

    for (const { twin, base } of pairs) {
        base.dark ??= { ...twin.light!, scope: alt };
        twin.twin = true;
    }
}

function pairModeSuffixes(map: Map<string, Variable>, alt: Mode): void {
    const isMode = (word: string | undefined) => word === "light" || word === "dark";
    const stems = new Map<string, { name: string; first?: Variable; second?: Variable }>();

    for (const variable of map.values()) {
        const words = kebab(variable.name).replace(/^-/, "").split("-");
        const at = isMode(words.at(-1)) ? words.length - 1 : isMode(words[0]) ? 0 : -1;

        if (
            at === -1 ||
            words.length < 2 ||
            variable.light === undefined ||
            variable.twin === true
        ) {
            continue;
        }

        const name = words.filter((_, index) => index !== at).join("-");
        const stem = `${variable.kind}:${variable.hint ?? ""}:${name}`;
        const pair = stems.get(stem) ?? { name };

        pair[words[at] === otherMode(alt) ? "first" : "second"] = variable;
        stems.set(stem, pair);
    }

    const complete = [...stems].filter(
        ([, pair]) => pair.first !== undefined && pair.second !== undefined,
    );

    if (complete.length < 2) {
        return;
    }

    for (const [stem, { name, first, second }] of complete) {
        if (map.has(stem)) {
            continue;
        }

        const merged: Variable = {
            name,
            kind: first!.kind,
            light: first!.light,
            dark: { ...second!.light!, scope: alt },
            ...(first!.hint === undefined ? {} : { hint: first!.hint }),
        };

        first!.twin = true;
        second!.twin = true;
        map.set(vkey(merged), merged);
    }
}

function pairSassNames(map: Map<string, Variable>, alt: Mode): void {
    const plain = (name: string) =>
        kebab(name).replace(/^(?:bs|ifm|sl|mui|ant|chakra|mantine|pico|vt)-/, "");
    const preprocessed = new Map<string, Variable>();

    for (const variable of map.values()) {
        if (variable.kind === "scss" || variable.kind === "less") {
            preprocessed.set(plain(variable.name), variable);
        }
    }

    for (const variable of map.values()) {
        if (
            (variable.kind === "css" || variable.kind === "theme") &&
            variable.light === undefined
        ) {
            const base = preprocessed.get(plain(variable.name));

            if (base !== undefined && base.dark === undefined && variable.dark !== undefined) {
                base.dark = { ...variable.dark, scope: alt };
                variable.twin = true;
            }
        }
    }
}

export function follow(
    index: Map<string, Variable>,
    start: Variable,
    scope: Mode,
    active: Set<Variable> = new Set(),
    memo: Map<Variable, Found | undefined> = new Map(),
): Found | undefined {
    // `$a: $a * 2` is not followed into itself, nor a chain past 64.
    if (active.has(start) || active.size >= 64) {
        return undefined;
    }

    // Each variable is followed once in a walk, so `$b: $a + $a; $c: $b + $b` does not double the work.
    if (memo.has(start)) {
        return memo.get(start);
    }

    active.add(start);

    try {
        const out = followOnce(index, start, scope, active, memo);

        memo.set(start, out);

        return out;
    } finally {
        active.delete(start);
    }
}

function followOnce(
    index: Map<string, Variable>,
    start: Variable,
    scope: Mode,
    active: Set<Variable>,
    memo: Map<Variable, Found | undefined>,
): Found | undefined {
    const bare = (variable: Variable) =>
        modeValue(variable, scope)?.replace(/#\{\s*([$@][\w-]+)\s*\}/g, "$1");

    const lookup: Lookup = (name, kind) => {
        const target = index.get(`${kind}:${name}`);

        return target === undefined ? undefined : follow(index, target, scope, active, memo)?.text;
    };

    let text = bare(start);
    let via: Variable | undefined;

    for (let hop = 0; hop < 8 && text !== undefined; hop++) {
        const css = /^var\(\s*--([\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(text);
        const sass = css === null ? /^([$@])([\w-]+)$/.exec(text) : null;

        if (css === null && sass === null) {
            break;
        }

        const next =
            css !== null
                ? index.get(`css:${css[1]}`)
                : index.get(`${sass![1] === "$" ? "scss" : "less"}:${sass![2]}`);

        if (next === undefined) {
            if (css?.[2] !== undefined) {
                text = css[2].trim();

                continue;
            }

            return undefined;
        }

        via ??= next;
        text = bare(next);
    }

    if (text === undefined) {
        return undefined;
    }

    if (text.includes("#{")) {
        text = text.replace(/#\{\s*([^{}]+?)\s*\}/g, (all, expression: string) => {
            const lone = /^(?:[\w-]+\.)?[$@]([\w-]+)$/.exec(expression);

            return (
                (lone === null
                    ? evalMath(expression, lookup)
                    : (lookup(lone[1]!, "scss") ?? lookup(lone[1]!, "less"))) ?? all
            );
        });
    }

    const calc = /^calc\((.*)\)$/s.exec(text.trim());

    if (
        (/[$@][A-Za-z_]/.test(text) && /[*/+()]|\s-\s/.test(text)) ||
        (calc !== null && /var\(/.test(text))
    ) {
        text = evalMath(calc === null ? text : calc[1]!, lookup) ?? text;
    }

    return { text: text.trim(), via };
}

interface Quantity {
    n: number;
    unit: string;
}

const LENGTHS = ["px", "rem", "em"];

// rem and em are 16px when a sum mixes them with pixels (`0.5rem - 2px`).
const pixels = (quantity: Quantity): Quantity =>
    quantity.unit === "rem" || quantity.unit === "em"
        ? { n: quantity.n * 16, unit: "px" }
        : quantity;

function multiply(op: string, left: Quantity, right: Quantity): Quantity | undefined {
    if (op === "/" && right.n === 0) {
        return undefined;
    }

    return op === "*"
        ? { n: left.n * right.n, unit: left.unit || right.unit }
        : { n: left.n / right.n, unit: left.unit === right.unit ? "" : left.unit };
}

function add(op: string, left: Quantity, right: Quantity): Quantity | undefined {
    const mixed =
        left.unit !== right.unit && LENGTHS.includes(left.unit) && LENGTHS.includes(right.unit);
    const [a, b] = mixed ? [pixels(left), pixels(right)] : [left, right];

    if (a.unit !== b.unit && a.unit !== "" && b.unit !== "") {
        return undefined;
    }

    return { n: op === "+" ? a.n + b.n : a.n - b.n, unit: a.unit || b.unit };
}

export function evalMath(text: string, value: Lookup): string | undefined {
    const tokens = text.match(/var\(\s*--[\w-]+\s*\)|\$[\w-]+|@[\w-]+|\d*\.?\d+[a-z%]*|[()+*/-]/g);
    let at = 0;

    if (tokens === null || tokens.join("").length < text.replace(/\s/g, "").length) {
        return undefined;
    }

    const operand = (token: string): Quantity | undefined => {
        const source = token.startsWith("var(")
            ? value(/--([\w-]+)/.exec(token)![1]!, "css")
            : /^[$@]/.test(token)
              ? value(token.slice(1), token[0] === "$" ? "scss" : "less")
              : token;
        const match = source === undefined ? null : /^(-?\d*\.?\d+)([a-z%]*)$/.exec(source.trim());

        return match === null ? undefined : { n: Number(match[1]), unit: match[2]! };
    };

    const factor = (): Quantity | undefined => {
        const token = tokens[at++];

        if (token === "(") {
            const inner = sum();

            return tokens[at++] === ")" ? inner : undefined;
        }

        if (token === "-") {
            const inner = factor();

            return inner === undefined ? undefined : { n: -inner.n, unit: inner.unit };
        }

        return token === undefined ? undefined : operand(token);
    };

    const chain =
        (next: () => Quantity | undefined, ops: string[], apply: typeof add) =>
        (): Quantity | undefined => {
            let left = next();

            while (left !== undefined && ops.includes(tokens[at] ?? "")) {
                const op = tokens[at++]!;
                const right = next();

                left = right === undefined ? undefined : apply(op, left, right);
            }

            return left;
        };

    const product = chain(factor, ["*", "/"], multiply);
    const sum = chain(product, ["+", "-"], add);
    const result = sum();

    return result === undefined || at !== tokens.length || !Number.isFinite(result.n)
        ? undefined
        : `${Math.round(result.n * 1000) / 1000}${result.unit}`;
}

export function channelColor(text: string, name: string): string | undefined {
    if (
        /^\d+(?:\.\d+)?(?:deg)?[ ,]+\d+(?:\.\d+)?%[ ,]+\d+(?:\.\d+)?%(?:\s*\/\s*[\d.]+%?)?$/.test(
            text,
        )
    ) {
        return `hsl(${text})`;
    }

    if (/-rgb$/.test(name) && /^\d{1,3}[ ,]+\d{1,3}[ ,]+\d{1,3}$/.test(text)) {
        return `rgb(${text})`;
    }

    return undefined;
}

const FUNCTION = String.raw`\b(rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(\s*`;
const STARTS_WITH_FUNCTION = new RegExp(String.raw`^${FUNCTION}`, "i");

export function noteChannels(facts: Facts, value: string): void {
    if (!value.includes("var(") || facts.channels.size > 400) {
        return;
    }

    for (const call of value.matchAll(
        new RegExp(String.raw`${FUNCTION}((?:[^()]|\([^()]*\))*)\)`, "gi"),
    )) {
        const kind = call[1]!.toLowerCase().replace(/a$/, "");

        for (const name of call[2]!.matchAll(/var\(\s*--([\w-]+)/g)) {
            facts.channels.set(name[1]!, kind);
        }
    }
}

const NUMBERS =
    /^\s*-?[\d.]+(?:deg|%)?(?:\s*[ ,]\s*-?[\d.]+(?:deg|%)?){2,3}(?:\s*\/\s*[\d.]+%?)?\s*$/;

function fill(text: string, values: Map<string, string>, depth = 0): string | undefined {
    if (depth > 4) {
        return undefined;
    }

    let missing = false;
    const out = text.replace(
        /var\(\s*--([\w-]+)\s*(?:,\s*([^()]*))?\)/g,
        (_, name: string, fallback?: string) => {
            const value = values.get(name) ?? fallback?.trim();
            const inner = value?.includes("var(") ? fill(value, values, depth + 1) : value;

            missing ||= inner === undefined;

            return inner ?? "";
        },
    );

    return missing ? undefined : out;
}

export function resolveChannels(facts: Facts): void {
    const own = new Map<string, string>();
    const dark = new Map<string, string>();

    for (const variable of facts.vars) {
        if (variable.scope === "default" || variable.scope === "dark") {
            (variable.scope === "dark" ? dark : own).set(variable.name, variable.value);
        }
    }

    // Built once: a copy for each property made the scan quadratic in the number of properties.
    const darkOwn = new Map([...own, ...dark]);

    for (const variable of facts.vars) {
        const kind = facts.channels.get(variable.name);

        if (kind !== undefined && !variable.value.includes("(") && NUMBERS.test(variable.value)) {
            const color = `${kind}(${variable.value.trim().replace(/,\s*/g, " ")})`;

            if (parseColor(color) !== undefined) {
                variable.value = color;
            }

            continue;
        }

        if (variable.value.includes("var(") && STARTS_WITH_FUNCTION.test(variable.value.trim())) {
            const text = variable.value.replace(/<alpha-value>/g, "1");
            const filled = fill(text, variable.scope === "dark" ? darkOwn : own);
            const opaque = filled?.replace(/\s*\/\s*1\s*\)/, ")");

            if (opaque !== undefined && parseColor(opaque) !== undefined) {
                variable.value = opaque;
            }
        }
    }
}
