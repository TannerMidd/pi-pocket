/**
 * What a theme's CSS asks the browser to load, read as the browser reads it: CSS's own tokens (CSS Syntax Level 3),
 * with comments skipped and escapes resolved, so `\75 rl(…)` is the `url(…)` it is. The app's content security policy
 * already keeps every load on this server; these checks keep a theme's to its own folder, so it reaches no other
 * address here either (`url(/login?token=…)`, an API route).
 */

export interface Token {
    type:
        | "ident"
        | "function"
        | "at"
        | "hash"
        | "string"
        | "bad-string"
        | "url"
        | "bad-url"
        | "number"
        | "whitespace"
        | "open"
        | "close"
        | "delim";
    value: string;
    line: number;
    /** Where it is in the text (with line endings made `\n`, as `tokenize` reads it): its first character, and past its last. */
    start: number;
    end: number;
}

/** A load the CSS asks for: what it names, on which line, and where its token is (`Token`'s `start` and `end`). */
export interface Reference {
    url: string;
    line: number;
    start: number;
    end: number;
    /** `url(…)` without quotes is one token; a quoted address is a string token in a function. */
    quoted: boolean;
}

export interface CssReferences {
    /** Stylesheets it imports. */
    imports: Reference[];
    /** Fonts and images it loads. */
    assets: Reference[];
    /** What it may not do, by line. */
    problems: { line: number; message: string }[];
    /** The text the tokens were read from: line endings made `\n`. */
    text: string;
}

const isDigit = (char: string) => char >= "0" && char <= "9";
const isHex = (char: string) => /^[0-9a-fA-F]$/.test(char);
const isWhitespace = (char: string) => char === " " || char === "\t" || char === "\n";
const isNameStart = (char: string) =>
    char !== "" && (/[A-Za-z_]/.test(char) || char.charCodeAt(0) >= 0x80);
const isName = (char: string) => isNameStart(char) || isDigit(char) || char === "-";
const validEscape = (first: string, second: string) =>
    first === "\\" && second !== "\n" && second !== "";

/** What may not stand in an unquoted `url(…)`: control characters other than tab and newline, and delete. */
const nonPrintable = (char: string) => {
    const code = char.charCodeAt(0);

    return (
        (code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f) &&
        char !== ""
    );
};

/** A token before its place in the text is known. */
type Raw = Omit<Token, "start" | "end">;

/** CSS as `tokenize` reads it: line endings made `\n`, NUL made U+FFFD. */
export const normalizeCss = (source: string) =>
    source.replace(/\r\n?|\f/g, "\n").replace(/\0/g, "\uFFFD");

/** CSS's tokens, as a browser makes them (the parts these checks need: names, strings, and URLs exactly). */
export function tokenize(source: string): Token[] {
    const css = normalizeCss(source);
    const tokens: Token[] = [];
    let at = 0;
    let line = 1;

    const peek = (ahead = 0) => css[at + ahead] ?? "";

    const next = () => {
        const char = css[at++] ?? "";

        if (char === "\n") {
            line++;
        }

        return char;
    };

    const startsIdent = (a: string, b: string, c: string) =>
        a === "-"
            ? isNameStart(b) || b === "-" || validEscape(b, c)
            : isNameStart(a) || validEscape(a, b);

    const startsNumber = (a: string, b: string, c: string) =>
        a === "+" || a === "-"
            ? isDigit(b) || (b === "." && isDigit(c))
            : a === "."
              ? isDigit(b)
              : isDigit(a);

    /** After a backslash: the escaped character. */
    const escape = (): string => {
        const char = next();

        if (char === "") {
            return "\uFFFD";
        }

        if (!isHex(char)) {
            return char;
        }

        let hex = char;

        while (hex.length < 6 && isHex(peek())) {
            hex += next();
        }

        if (isWhitespace(peek())) {
            next();
        }

        const code = Number.parseInt(hex, 16);

        return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
            ? "\uFFFD"
            : String.fromCodePoint(code);
    };

    const name = (): string => {
        let result = "";

        for (;;) {
            const char = peek();

            if (isName(char)) {
                result += next();
            } else if (validEscape(char, peek(1))) {
                next();
                result += escape();
            } else {
                return result;
            }
        }
    };

    const string = (quote: string, start: number): Raw => {
        let value = "";

        for (;;) {
            const char = peek();

            if (char === "" || char === quote) {
                next();

                return { type: "string", value, line: start };
            }

            if (char === "\n") {
                return { type: "bad-string", value, line: start };
            }

            next();

            if (char === "\\") {
                if (peek() === "") {
                    continue;
                }

                if (peek() === "\n") {
                    next();
                    continue;
                }

                value += escape();
            } else {
                value += char;
            }
        }
    };

    /** The rest of a bad URL, up to its `)`. */
    const badUrl = (value: string, start: number): Raw => {
        for (;;) {
            const char = next();

            if (char === "" || char === ")") {
                return { type: "bad-url", value, line: start };
            }

            if (validEscape(char, peek())) {
                escape();
            }
        }
    };

    const url = (start: number): Raw => {
        let value = "";

        while (isWhitespace(peek())) {
            next();
        }

        for (;;) {
            const char = next();

            if (char === "" || char === ")") {
                return { type: "url", value, line: start };
            }

            if (isWhitespace(char)) {
                while (isWhitespace(peek())) {
                    next();
                }

                if (peek() === ")" || peek() === "") {
                    next();

                    return { type: "url", value, line: start };
                }

                return badUrl(value, start);
            }

            if (char === '"' || char === "'" || char === "(" || nonPrintable(char)) {
                return badUrl(value, start);
            }

            if (char === "\\") {
                if (validEscape(char, peek())) {
                    value += escape();
                } else {
                    return badUrl(value, start);
                }
            } else {
                value += char;
            }
        }
    };

    const identLike = (start: number): Raw => {
        const value = name();

        if (value.toLowerCase() === "url" && peek() === "(") {
            next();

            // `url("…")` is a function with a string in it; `url(…)` without quotes is one token.
            let ahead = 0;

            while (isWhitespace(peek(ahead))) {
                ahead++;
            }

            if (peek(ahead) === '"' || peek(ahead) === "'") {
                return { type: "function", value, line: start };
            }

            return url(start);
        }

        if (peek() === "(") {
            next();

            return { type: "function", value, line: start };
        }

        return { type: "ident", value, line: start };
    };

    while (at < css.length) {
        const start = line;
        const from = at;
        const char = peek();
        const push = (token: Raw) => tokens.push({ ...token, start: from, end: at });

        if (char === "/" && peek(1) === "*") {
            const end = css.indexOf("*/", at + 2);
            const stop = end === -1 ? css.length : end + 2;

            while (at < stop) {
                next();
            }

            continue;
        }

        if (isWhitespace(char)) {
            while (isWhitespace(peek())) {
                next();
            }

            push({ type: "whitespace", value: " ", line: start });
            continue;
        }

        if (char === '"' || char === "'") {
            next();
            push(string(char, start));
            continue;
        }

        if (char === "#" && (isName(peek(1)) || validEscape(peek(1), peek(2)))) {
            next();
            push({ type: "hash", value: name(), line: start });
            continue;
        }

        if (char === "(" || char === "[" || char === "{") {
            next();
            push({ type: "open", value: char, line: start });
            continue;
        }

        if (char === ")" || char === "]" || char === "}") {
            next();
            push({ type: "close", value: char, line: start });
            continue;
        }

        if (startsNumber(char, peek(1), peek(2))) {
            let value = next();

            while (isDigit(peek()) || peek() === "." || /[eE]/.test(peek())) {
                value += next();
            }

            if (startsIdent(peek(), peek(1), peek(2))) {
                value += name();
            } else if (peek() === "%") {
                value += next();
            }

            push({ type: "number", value, line: start });
            continue;
        }

        if (char === "@" && startsIdent(peek(1), peek(2), peek(3))) {
            next();
            push({ type: "at", value: name(), line: start });
            continue;
        }

        if (startsIdent(char, peek(1), peek(2))) {
            push(identLike(start));
            continue;
        }

        next();
        push({ type: "delim", value: char, line: start });
    }

    return tokens;
}

/** Functions whose strings are images to load (`image-set("a.png" 1x)`), besides `url()` and `src()`. */
const IMAGE_FUNCTIONS = new Set([
    "image-set",
    "-webkit-image-set",
    "image",
    "cross-fade",
    "-webkit-cross-fade",
]);
/** Functions whose strings are files to load, at any depth. */
const loads = (fn: string) => fn === "url" || fn === "src" || IMAGE_FUNCTIONS.has(fn);
/** Functions that put in a value from elsewhere (a variable, an attribute, the browser). */
const SUBSTITUTE = new Set(["var", "attr", "env"]);
/** Old ways for CSS to run code (Firefox's XBL, Internet Explorer's behaviors and expressions): never in a theme. */
const CODE = new Set(["-moz-binding", "behavior"]);

/** Every load a stylesheet asks for, and what it may not do. */
export function cssReferences(source: string): CssReferences {
    const found: CssReferences = {
        imports: [],
        assets: [],
        problems: [],
        text: normalizeCss(source),
    };
    /** The functions (or plain brackets, as "") open around the current token, innermost last. */
    const open: string[] = [];
    // How many of them load a file, and how many are attr(), kept as they open and close: a scan of `open` for each
    // token would take time that grows with the square of the nesting, which a theme's CSS chooses.
    let loading = 0;
    let attrs = 0;
    let importing: number | undefined;

    const push = (fn: string) => {
        open.push(fn);
        loading += loads(fn) ? 1 : 0;
        attrs += fn === "attr" ? 1 : 0;
    };

    const pop = () => {
        const fn = open.pop();

        loading -= fn !== undefined && loads(fn) ? 1 : 0;
        attrs -= fn === "attr" ? 1 : 0;
    };

    const take = (token: Token) => {
        const reference = {
            url: token.value,
            line: token.line,
            start: token.start,
            end: token.end,
            quoted: token.type === "string",
        };

        if (importing !== undefined) {
            found.imports.push(reference);
            importing = undefined;
        } else {
            found.assets.push(reference);
        }
    };

    for (const token of tokenize(found.text)) {
        switch (token.type) {
            case "at":
                if (token.value.toLowerCase() === "import") {
                    importing = token.line;
                }

                break;
            case "url":
                take(token);
                break;
            case "bad-url":
                found.problems.push({ line: token.line, message: "a url() that cannot be read" });
                break;

            case "string": {
                const inner = open.at(-1);

                // A string anywhere in a function that loads is a load (`image-set(fn("x") 1x)` too), except a type's
                // or a format's, which names a kind of file.
                if (
                    (importing !== undefined && open.length === 0) ||
                    (inner !== "type" && inner !== "format" && loading > 0)
                ) {
                    take(token);
                }

                break;
            }

            case "function": {
                const fn = token.value.toLowerCase();

                if (fn === "expression") {
                    found.problems.push({ line: token.line, message: "expression() runs code" });
                }

                // An address made where the CSS is used, not written: it could name any address here.
                if (SUBSTITUTE.has(fn) && loading > 0) {
                    found.problems.push({
                        line: token.line,
                        message: `${fn}() inside a function that loads a file: name the file itself`,
                    });
                }

                push(fn);
                break;
            }

            case "open":
                if (token.value === "{" && importing !== undefined) {
                    found.problems.push({
                        line: importing,
                        message: "an @import names no stylesheet",
                    });
                    importing = undefined;
                }

                push("");
                break;
            case "close":
                // A block's end ends whatever was left open in it: functions never span blocks.
                if (token.value === "}") {
                    open.length = 0;
                    loading = 0;
                    attrs = 0;
                } else {
                    pop();
                }

                break;
            case "ident":
                // `attr(data-x url)`, `attr(data-x type(<url>))`: an address from the page.
                if (token.value.toLowerCase() === "url" && attrs > 0) {
                    found.problems.push({
                        line: token.line,
                        message: "attr() as an address: name the file itself",
                    });
                }

                if (CODE.has(token.value.toLowerCase())) {
                    found.problems.push({ line: token.line, message: `${token.value} runs code` });
                }

                break;
            case "delim":
                if (token.value === ";" && importing !== undefined) {
                    found.problems.push({
                        line: importing,
                        message: "an @import names no stylesheet",
                    });
                    importing = undefined;
                }

                break;
            default:
                break;
        }
    }

    if (importing !== undefined) {
        found.problems.push({ line: importing, message: "an @import names no stylesheet" });
    }

    return found;
}

/**
 * What `url`, written in the stylesheet `from` (a path in a theme's folder), names: a file in the folder (`{ file }`),
 * `"fragment"` for a reference within the page (`url(#shadow)`), `"data"` for an image written into the CSS, or
 * undefined for anything else (another site, another address on this one, a path that leaves the folder, a query).
 * Resolved as the browser resolves it, `..` and `%2e%2e` and backslashes alike.
 */
export function themeFile(
    url: string,
    from: string,
): { file: string } | "fragment" | "data" | undefined {
    const value = url.trim();

    if (value.startsWith("#")) {
        return "fragment";
    }

    if (/^data:/i.test(value)) {
        return /^data:image\//i.test(value) ? "data" : undefined;
    }

    const base = "https://theme.invalid";
    let resolved: URL;

    try {
        resolved = new URL(value, `${base}/t/${from.split("/").map(encodeURIComponent).join("/")}`);
    } catch {
        return undefined;
    }

    if (
        resolved.origin !== base ||
        resolved.search !== "" ||
        !resolved.pathname.startsWith("/t/")
    ) {
        return undefined;
    }

    const parts: string[] = [];

    for (const part of resolved.pathname.slice(3).split("/")) {
        let decoded: string;

        try {
            decoded = decodeURIComponent(part);
        } catch {
            return undefined;
        }

        if (
            decoded === "" ||
            decoded.startsWith(".") ||
            decoded.includes("\\") ||
            decoded.includes("/") ||
            decoded.includes("\0")
        ) {
            return undefined;
        }

        parts.push(decoded);
    }

    return { file: parts.join("/") };
}
