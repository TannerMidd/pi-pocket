import { NAMED_COLORS, parseColor, toHex } from "./color.ts";

export type Scope = "default" | "dark" | "light" | "other";

export interface Decl {
    prop: string;
    value: string;
    /** The innermost selector, with `&` resolved against its parent. */
    selector: string;
    /** The at-rule preludes around it, outermost first. */
    at: string[];
    scope: Scope;
    theme: boolean;
    inline: boolean;
    line?: number;
}

const MAX_VALUE = 400;
const MAX_MAP = 8000;

// An unclosed comment runs to the end, so the match stays linear; `/*` or `//` after a word, a quote,
// or (for `//`) `:` or `(` is a glob or an address.
const COMMENTS =
    /(?<![\w.*"'`/-])\/\*[\s\S]*?(?:\*\/|$)|<!--[\s\S]*?(?:-->|$)|(?<![:\w"'`(/\\])\/\/[^\n]*/g;

const DARK_WORD = String.raw`(?:dark|dark[-_]theme|dark[-_]mode|darkmode|dark[-_]scheme|theme[-_]{0,2}dark|mode[-_]{0,2}dark|scheme[-_]{0,2}dark|color[-_]scheme[-_]dark|is[-_]?dark|has[-_]?dark|ui[-_]dark|app[-_]dark|body[-_]dark|v-theme--dark|chakra-ui-dark|ant-dark|night|night[-_]mode|nightmode|theme[-_]night|dark[-_]?(?:theme|mode|scheme)(?:[-_]active|[-_]on|[-_]enabled)?)`;
const DARK_PART = String.raw`(?:\.${DARK_WORD}(?![\w-])|\[(?:data-[\w-]*)?(?:theme|mode|color-mode|color-scheme|colorscheme|appearance|scheme)\s*[~|^$*]?=\s*["']?(?:dark|night|slate|dark[-_]mode|darkmode)["']?\s*\])`;
const DARK_ANY = new RegExp(DARK_PART, "i");
const rootRule = (part: string, tail = String.raw`(?::root)?`) =>
    new RegExp(String.raw`^(?:html|body|:root|\*|:host)?(?:${part})+${tail}$`, "i");
const DARK_ROOT = rootRule(DARK_PART);
const LIGHT_PART = String.raw`(?:\.(?:light|light[-_]theme|light[-_]mode|lightmode|theme[-_]{1,2}light|mode[-_]{1,2}light|scheme[-_]light|v-theme--light|chakra-ui-light|ant-light|day|day[-_]mode)(?![\w-])|\[(?:data-[\w-]*)?(?:theme|mode|color-mode|color-scheme|colorscheme|appearance|scheme)\s*[~|^$*]?=\s*["']?(?:light|day)["']?\s*\])`;
const LIGHT_ROOT = rootRule(LIGHT_PART);
const DARK_DESC = rootRule(
    DARK_PART,
    String.raw`\s+(?:body|html|:root|\*|main|#root|#app|\.app|\.App)`,
);
const ROOT_ONLY =
    /^(?:html|body|:root|\*|:host|#root|#app|#__next|\.app|\.theme|main)(?:\[data-(?:bs-)?(?:theme|mode)\])*$|^\[data-(?:bs-)?(?:theme|mode|color-scheme)\]$/i;
const ROOT_ANY = /^(?:html|body|:root|\*|:host)(?:\s*:not\([^)]*\))?$/i;

export const isDarkSelector = (selector: string) => DARK_ANY.test(selector);

function partScope(part: string, dark: boolean, light = false): Scope {
    if (DARK_ROOT.test(part) || DARK_DESC.test(part)) {
        return "dark";
    }

    if (LIGHT_ROOT.test(part)) {
        return "light";
    }

    if (light || dark) {
        // Inside `prefers-color-scheme`, the root selectors define that mode; `:root:not(.light)` too.
        const root = ROOT_ANY.test(part) || ROOT_ONLY.test(part) || /^:root\b/i.test(part);

        return !root ? "other" : light ? "light" : "dark";
    }

    return ROOT_ONLY.test(part) ||
        /^:root\b(?!.*[.[])/i.test(part) ||
        /^(?:html|body|:root)\s*:not\(/i.test(part)
        ? "default"
        : "other";
}

function varScope(selector: string, dark: boolean, light = false): Scope {
    const scopes = selector
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => partScope(part, dark, light));

    if (scopes.length === 0) {
        return dark ? "dark" : light ? "light" : "default";
    }

    return (["default", "dark", "light"] as const).find((each) => scopes.includes(each)) ?? "other";
}

function isDarkWords(name: string): boolean {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((word) => word === "dark" || word === "night");
}

function isDarkInclude(prelude: string): boolean {
    const include = /^@include\s+([\w.-]+)\s*(?:\(([^)]*)\))?/i.exec(prelude);

    if (include !== null) {
        const name = include[1]!.replace(/^.*\./, "");

        return (
            isDarkWords(name) ||
            /(?:^|[\s,(:])['"]?(?:dark|night)['"]?(?:$|[\s,)])/i.test(include[2] ?? "")
        );
    }

    return /^@(?:else\s+)?if\b[^{]*(?:==|=)\s*['"]?(?:dark|night)['"]?\s*$/i.test(prelude);
}

const MAX_DECLS = 30_000;
const MAX_DEPTH = 24;

// A comment keeps its line breaks, so that a line counted after it is the file's line; one line of it is a space.
export const stripComments = (text: string) =>
    text.replace(COMMENTS, (comment) => comment.replace(/[^\n]+/g, "").replace(/^$/, " "));

export function parseStyles(source: string, firstLine: number | undefined = 1): Decl[] {
    const text = stripComments(source);
    let cursor = 0;
    let breaks = 0;
    let nextBreak = text.indexOf("\n");

    // The cursor only moves forward, so the count of line breaks before it only grows.
    const lineOf = (index: number) => {
        for (; nextBreak !== -1 && nextBreak < index; breaks++) {
            nextBreak = text.indexOf("\n", nextBreak + 1);
        }

        return (firstLine ?? 1) + breaks;
    };

    // `@custom-media --dark (prefers-color-scheme: dark);` names a query: `@media (--dark)` is the dark mode's.
    const darkQueries = [
        ...text.matchAll(/@custom-media\s+(--[\w-]+)\s+[^;{}]*prefers-color-scheme\s*:\s*dark/gi),
    ].map((match) => match[1]!);
    const decls: Decl[] = [];
    const stack: { prelude: string; selector: string }[] = [];
    let buffer = "";
    let paren = 0;

    const selector = () =>
        stack.findLast((block) => !block.prelude.startsWith("@"))?.selector ?? "";

    const flush = () => {
        const statement = buffer.trim();

        buffer = "";

        if (statement === "" || decls.length >= MAX_DECLS) {
            return;
        }

        const match = /^(--[\w-]+|[$@]?[A-Za-z_][\w-]*|\*[A-Za-z][\w-]*)\s*:\s*([\s\S]*)$/.exec(
            statement,
        );

        if (
            match === null ||
            /^@(?:media|supports|import|charset|font-face|keyframes|layer|container|include|mixin|use|forward|extend|return|if|else|each|for|while|function|apply|plugin|source|tailwind|custom-variant|variant|utility|theme|config|namespace|property|page|counter-style|font-feature-values|scope|starting-style)\b/.test(
                statement,
            )
        ) {
            return;
        }

        const prop = match[1]!;
        const variable = /^(?:--|[$@])/.test(prop);
        const value = match[2]!.replace(/\s*!(?:important|default|global)\s*$/i, "").trim();
        const at = stack.map((block) => block.prelude).filter((part) => part.startsWith("@"));
        const dark = at.some(
            (part) =>
                /^@media\b[^{]*prefers-color-scheme\s*:\s*dark/i.test(part) ||
                (/^@media\b/i.test(part) &&
                    darkQueries.some((name) => new RegExp(`\\(\\s*${name}\\s*\\)`).test(part))) ||
                isDarkInclude(part),
        );
        const light = at.some((part) =>
            /^@media\b[^{]*prefers-color-scheme\s*:\s*light/i.test(part),
        );
        const here = selector();
        const theme = at.some((part) => /^@theme\b/i.test(part));

        decls.push({
            prop: variable ? prop : prop.toLowerCase(),
            // A Sass map (`$themes: (light: (…), dark: (…))`) is long: it is read whole.
            value: value.slice(
                0,
                prop.startsWith("$") && value.startsWith("(") ? MAX_MAP : MAX_VALUE,
            ),
            selector: here,
            at,
            theme,
            inline: false,
            ...(firstLine === undefined ? {} : { line: lineOf(cursor) }),
            scope: variable
                ? theme
                    ? "default"
                    : varScope(here, dark, light)
                : dark || isDarkSelector(here)
                  ? "dark"
                  : "default",
        });
    };

    for (let at = 0; at < text.length; at++) {
        const char = text[at]!;

        cursor = at;

        if (char === '"' || char === "'") {
            let end = at + 1;

            while (end < text.length && text[end] !== char && text[end] !== "\n") {
                end += text[end] === "\\" ? 2 : 1;
            }

            buffer += text.slice(at, end + 1);
            at = end;
        } else if (char === "#" && text[at + 1] === "{") {
            const end = text.indexOf("}", at);

            buffer += text.slice(at, end === -1 ? text.length : end + 1);
            at = end === -1 ? text.length : end;
        } else if (char === "(") {
            paren += 1;
            buffer += char;
        } else if (char === ")") {
            paren = Math.max(0, paren - 1);
            buffer += char;
        } else if (char === "{" && paren === 0) {
            if (stack.length >= MAX_DEPTH) {
                return decls;
            }

            // Svelte, Vue and CSS Modules wrap selectors: `:global(:root)`, `:global(.dark)`, `:deep(.x)`, `:local(.x)`.
            const prelude = buffer
                .trim()
                .replace(/\s+/g, " ")
                .replace(/:(?:global|local|deep)\(((?:[^()]|\([^()]*\))*)\)/g, "$1")
                .replace(/^:global\s+/, "");

            buffer = "";

            const parent = selector();
            const resolved = prelude.startsWith("@")
                ? parent
                : parent === ""
                  ? prelude
                  : prelude.includes("&")
                    ? prelude.replace(/&/g, parent)
                    : `${parent} ${prelude}`;

            stack.push({ prelude: prelude.slice(0, 300), selector: resolved.slice(0, 300) });
        } else if (char === "}" && paren === 0) {
            flush();
            stack.pop();
        } else if (char === ";" && paren === 0) {
            flush();
        } else {
            buffer += char;
        }

        if (buffer.length > (buffer.trimStart().startsWith("$") ? MAX_MAP * 2 : 4000)) {
            // A statement this long is not a declaration: drop it rather than grow without bound.
            buffer = buffer.slice(-2000);
        }
    }

    flush();

    return decls;
}

export function pageStyles(source: string): { blocks: string[]; inline: Decl[] } {
    const blocks: string[] = [];
    // A search from each `<style` to its end tag: one regex for the whole block went quadratic on unclosed tags.
    const open = /<style\b[^>]{0,1000}>/gi;
    const close = /<\/style\s*>/gi;

    for (let tag = open.exec(source); tag !== null; tag = open.exec(source)) {
        close.lastIndex = open.lastIndex;

        const end = close.exec(source);

        if (end === null) {
            break;
        }

        blocks.push(source.slice(open.lastIndex, end.index));
        open.lastIndex = close.lastIndex;
    }

    const inline: Decl[] = [];
    let count = 0;

    for (const match of source.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        if (++count > 5000) {
            break;
        }

        for (const declaration of (match[1] ?? match[2] ?? "").split(";")) {
            const colon = declaration.indexOf(":");
            const prop = declaration.slice(0, colon).trim().toLowerCase();

            if (colon > 0 && /^(?:--[\w-]+|[a-z-]+)$/.test(prop)) {
                const value = declaration
                    .slice(colon + 1)
                    .trim()
                    .slice(0, MAX_VALUE);

                inline.push({
                    prop,
                    value,
                    selector: "",
                    at: [],
                    scope: "default",
                    theme: false,
                    inline: true,
                });
            }
        }
    }

    return { blocks, inline };
}

export const UNKNOWN = Symbol("unknown");

export type Literal =
    string | number | boolean | null | typeof UNKNOWN | Literal[] | { [key: string]: Literal };

/** A JavaScript object or array literal, read without running anything: what is not a literal is `UNKNOWN`. */
export function readLiteral(text: string, start: number): Literal | undefined {
    let at = start;
    let nodes = 0;

    const skip = () => {
        while (at < text.length) {
            if (/\s/.test(text[at]!)) {
                at += 1;
            } else if (text.startsWith("//", at) || text.startsWith("/*", at)) {
                const end = text.indexOf(text[at + 1] === "/" ? "\n" : "*/", at + 2);

                at = end === -1 ? text.length : end + (text[at + 1] === "/" ? 1 : 2);
            } else {
                break;
            }
        }
    };

    const string = (): string | undefined => {
        const quote = text[at]!;
        let out = "";
        let braces = 0;
        let dynamic = false;

        for (at += 1; at < text.length && (text[at] !== quote || braces > 0); at++) {
            const char = text[at]!;

            if (char === "\\") {
                out += text[++at] ?? "";
            } else if (quote === "`" && char === "$" && text[at + 1] === "{") {
                dynamic = true;
                braces += 1;
                at += 1;
            } else if (braces > 0) {
                braces += char === "{" ? 1 : char === "}" ? -1 : 0;
            } else {
                out += char;
            }
        }

        at += 1;

        return dynamic ? undefined : out.slice(0, 2000);
    };

    const skipValue = (): typeof UNKNOWN => {
        for (let depth = 0; at < text.length; at++) {
            const char = text[at]!;

            if (char === '"' || char === "'" || char === "`") {
                string();
                at -= 1;
            } else if ("([{".includes(char)) {
                depth += 1;
            } else if (")]}".includes(char) || (char === "," && depth === 0)) {
                if (depth === 0) {
                    break;
                }

                depth -= 1;
            }
        }

        return UNKNOWN;
    };

    const ended = () => at >= text.length || ",}]".includes(text[at]!);

    const value = (depth: number): Literal => {
        skip();

        if (++nodes > 20_000 || depth > 12 || at >= text.length) {
            return UNKNOWN;
        }

        const char = text[at]!;

        if (char === "{" || char === "[") {
            const close = char === "{" ? "}" : "]";
            const list: Literal[] = [];
            const object: { [key: string]: Literal } = {};

            // A closing bracket of another kind (`{ a: 1 ) }`) is read by nothing: the literal ends there.
            at += 1;

            for (let last = -1; at < text.length && at !== last;) {
                skip();
                last = at;

                if (text[at] === close) {
                    at += 1;

                    break;
                }

                if (text[at] === ",") {
                    at += 1;
                } else if (char === "[") {
                    list.push(value(depth + 1));

                    if (list.length > 500) {
                        break;
                    }
                } else if (text.startsWith("...", at) || text[at] === "[") {
                    skipValue();
                } else {
                    let key: string | undefined;

                    if ("\"'`".includes(text[at]!)) {
                        key = string();
                    } else {
                        key = /^[A-Za-z_$][\w$-]*|^-?\d+(?:\.\d+)?/.exec(
                            text.slice(at, at + 80),
                        )?.[0];
                        at += key?.length ?? 0;
                    }

                    skip();

                    if (key === undefined || text[at] !== ":") {
                        skipValue();

                        continue;
                    }

                    at += 1;

                    const child = value(depth + 1);

                    if (key !== "__proto__" && key !== "constructor" && key !== "prototype") {
                        object[key] = child;
                    }
                }
            }

            return char === "{" ? object : list;
        }

        if (char === '"' || char === "'" || char === "`") {
            const quoted = string();

            skip();

            return quoted !== undefined && ended() ? quoted : skipValue();
        }

        const number = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(at, at + 40));

        if (number !== null) {
            at += number[0].length;
            skip();

            return ended() ? Number(number[0]) : skipValue();
        }

        const word = /^(true|false|null)\b/.exec(text.slice(at, at + 6));

        if (word !== null) {
            at += word[0].length;

            return word[1] === "null" ? null : word[1] === "true";
        }

        return skipValue();
    };

    skip();

    return text[at] === "{" || text[at] === "[" ? value(0) : undefined;
}

/** A `#hex` that is a color, not an HTML entity, a link or id, or a selector. */
const HEX =
    /(?<![&\w])(?<!(?:href|src|id|for)\s*=\s*["']?)(?<!url\(\s*["']?)#[0-9a-fA-F]{3,8}\b(?![\w-])(?!\s*[{.:[>+~])(?![^;{}"'`<>$]{0,200}\{)/g;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[^()]*\)/gi;
const NAME_WORDS = new RegExp(
    String.raw`(?<![\w$@#.-])(${[...NAMED_COLORS.keys()].join("|")})(?![\w-])`,
    "gi",
);

interface FoundColor {
    text: string;
    hex: string;
}

/** A name inside `url()`, a string, or a function argument is not a color. */
export function colorsIn(value: string, named = false): FoundColor[] {
    const found: FoundColor[] = [];

    const push = (text: string) => {
        const color = parseColor(text);

        if (color !== undefined && !(color.a === 0 && /^transparent$/i.test(text))) {
            found.push({ text: text.trim(), hex: toHex(color) });
        }
    };

    for (const pattern of [HEX, COLOR_FUNCTION]) {
        for (const match of value.matchAll(pattern)) {
            push(match[0]);
        }
    }

    if (named) {
        const bare = value
            .replace(/url\([^)]*\)/gi, " ")
            .replace(/(["'])(?:\\.|(?!\1).)*\1/g, " ")
            .replace(/\b[\w-]+\(/g, "(");

        for (const match of bare.matchAll(NAME_WORDS)) {
            if (match[1]!.toLowerCase() !== "transparent") {
                push(match[1]!);
            }
        }
    }

    return found;
}

export function px(text: string): number | undefined {
    // `clamp(1rem, 0.9rem + 1vw, 1.5rem)` is a fluid size: its smallest value is the step.
    const clamp = /^clamp\(\s*([^,()]+),/i.exec(text.trim());
    const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|pt)?$/i.exec(
        (clamp === null ? text : clamp[1]!).trim(),
    );

    if (match === null) {
        return undefined;
    }

    const value = Number(match[1]);

    switch (match[2]?.toLowerCase()) {
        case "rem":
        case "em":
            return value * 16;
        case "pt":
            return (value * 4) / 3;
        case "px":
            return value;
        default:
            return value === 0 ? 0 : undefined;
    }
}

export function parts(value: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let current = "";

    for (const char of value) {
        if (char === "(") {
            depth += 1;
        } else if (char === ")") {
            depth = Math.max(0, depth - 1);
        }

        if (/\s/.test(char) && depth === 0) {
            if (current !== "") {
                out.push(current);
            }

            current = "";
        } else {
            current += char;
        }
    }

    if (current !== "") {
        out.push(current);
    }

    return out;
}

export function commaParts(value: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote = "";
    let current = "";

    for (const char of value) {
        if (quote !== "") {
            if (char === quote) {
                quote = "";
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "(") {
            depth += 1;
        } else if (char === ")") {
            depth = Math.max(0, depth - 1);
        } else if (char === "," && depth === 0) {
            out.push(current.trim());
            current = "";

            continue;
        }

        current += char;
    }

    if (current.trim() !== "") {
        out.push(current.trim());
    }

    return out;
}
