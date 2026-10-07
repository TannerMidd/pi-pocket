// Small, dependency-free syntax colors. Tokens are escaped before being wrapped; the output is never source HTML.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
const words = (text) => new Set(text.split(" "));
const ALIASES = {
    javascript: "js",
    mjs: "js",
    cjs: "js",
    node: "js",
    typescript: "ts",
    mts: "ts",
    cts: "ts",
    jsonc: "json",
    json5: "json",
    htm: "html",
    xhtml: "html",
    vue: "html",
    svelte: "html",
    md: "markdown",
    mdx: "markdown",
    py: "python",
    python3: "python",
    rs: "rust",
    golang: "go",
    kt: "kotlin",
    kts: "kotlin",
    h: "c",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    hh: "cpp",
    csharp: "cs",
    "c#": "cs",
    "c++": "cpp",
    rb: "ruby",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    fish: "shell",
    yml: "yaml",
    conf: "ini",
    cfg: "ini",
    env: "ini",
    patch: "diff",
    docker: "dockerfile",
    psql: "sql",
    mysql: "sql",
    sqlite: "sql",
};
const LANGUAGES = words(
    "js ts jsx tsx json css scss html xml svg markdown python rust go java kotlin c cpp cs swift ruby php shell yaml toml ini sql lua dockerfile diff",
);

/** The normalized language of a path or a fence name, or undefined when it is not recognized. */
export function langOf(name) {
    if (typeof name !== "string") {
        return undefined;
    }

    const value = name.trim().toLowerCase();
    const base = value.split(/[\\/]/).pop();

    if (/^dockerfile(?:\.|$)/.test(base)) {
        return "dockerfile";
    }

    if (/^\.(?:bashrc|zshrc|profile|bash_profile)$/.test(base)) {
        return "shell";
    }

    if (/^\.env(?:\.|$)/.test(base)) {
        return "ini";
    }

    const extension = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
    const language = ALIASES[extension] ?? extension;

    return LANGUAGES.has(language) ? language : undefined;
}

const COMMON =
    "if else for while do switch case default break continue return try catch finally throw new class extends import export from as in of static public private protected async await yield this super const let var function void typeof instanceof delete with debugger get set";
const KEYWORDS = {
    js: COMMON,
    ts: `${COMMON} interface type implements declare namespace module abstract readonly keyof infer is asserts satisfies override constructor enum unknown never any`,
    python: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
    rust: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
    go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    java: "abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try void volatile while record sealed permits var yield",
    kotlin: "abstract actual annotation as break by catch class companion const constructor continue crossinline data delegate do dynamic else enum expect external final finally for fun get if import in infix init inline inner interface internal is lateinit noinline object open operator out override package private protected public reified return sealed set super suspend tailrec this throw try typealias val var vararg when where while",
    c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Noreturn _Static_assert _Thread_local",
    cpp: "alignas alignof and asm auto bitand bitor bool break case catch char class concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor",
    cs: "abstract as async await base break case catch checked class const continue decimal default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly record ref return sealed sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual void volatile while yield var get set init required",
    swift: "actor as associatedtype async await break case catch class continue convenience default defer deinit didSet do else enum extension fallthrough fileprivate final for func get guard if import in indirect infix init inout internal is lazy let mutating nonmutating open operator optional override postfix precedencegroup prefix private protocol public repeat required rethrows return self set some static struct subscript super switch throws throw try typealias unowned var weak where while willSet",
    ruby: "alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative attr_reader attr_writer attr_accessor",
    php: `${COMMON} abstract and array callable clone declare echo elseif empty endfor endforeach endif endswitch endwhile eval exit final fn foreach global include include_once isset list match namespace or print require require_once trait unset use xor`,
    shell: "if then else elif fi case esac for select while until do done in function time coproc local export readonly declare typeset unset shift return break continue source exec eval set trap test echo printf read cd pwd",
    sql: "select from where join inner left right full outer cross on as and or not in is null true false insert into values update set delete create alter drop table index view database schema primary foreign key references unique check constraint default group by having order asc desc limit offset union all distinct exists between like ilike case when then else end with recursive returning over partition row rows range begin commit rollback transaction grant revoke explain analyze count sum avg min max",
    lua: "and break do else elseif end for function goto if in local not or repeat return then until while",
    dockerfile:
        "FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL",
};

for (const key of Object.keys(KEYWORDS)) {
    KEYWORDS[key] = words(KEYWORDS[key]);
}

const LITERALS = words(
    "true false null undefined NaN Infinity True False None nil NULL nullptr yes no on off",
);
const TYPES = words(
    "string number boolean symbol bigint object String Number Boolean Object Array Promise Map Set Date RegExp Error Uint8Array int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float float32 float64 double bool byte char short long size_t str usize isize u8 u16 u32 u64 u128 i8 i16 i32 i64 i128 f32 f64 Vec Option Result Self Any Int Float Double Bool Character Unit Nothing",
);
const HASH = words("python ruby shell yaml toml ini dockerfile php");
const C_STYLE = words("js ts jsx tsx json css scss rust go java kotlin c cpp cs swift php");
const MARKUP = words("html xml svg jsx tsx");
const MULTILINE_QUOTES = words("yaml toml ini");
const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const NUMBER =
    /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)(?:n|[uif](?:8|16|32|64|128)|[fFdDlLuU])?/y;

/** Find a quote's end without letting escaped quotes end the string. */
function quoteEnd(line, start, end, escaped) {
    let at = start;

    while (at < line.length) {
        if (escaped && line[at] === "\\") {
            at += 2;
        } else if (line.startsWith(end, at)) {
            return at + end.length;
        } else {
            at++;
        }
    }

    return -1;
}

/** Highlight one line with lexical state carried from its preceding line. Spans always close on this line. */
function colorLine(line, lang, state) {
    const chunks = [];
    let pending = "";
    let pendingKind;

    // The last token on this line that was not space: whether a `/` starts a regular expression depends on it.
    let before = "";

    const emit = (text, kind) => {
        if (!text) {
            return;
        }

        const trimmed = text.trim();

        if (trimmed !== "") {
            before = trimmed;
        }

        if (kind !== pendingKind) {
            flush();
            pendingKind = kind;
        }

        pending += text;
    };

    const flush = () => {
        if (pending) {
            const text = escape(pending);

            chunks.push(pendingKind ? `<span class="hl-${pendingKind}">${text}</span>` : text);
            pending = "";
        }
    };

    const family = lang === "jsx" ? "js" : lang === "tsx" ? "ts" : lang;
    const keywords = KEYWORDS[family];
    let at = 0;

    if (lang === "diff") {
        const kind = /^(?:diff |index |@@|---|\+\+\+|\\)/.test(line)
            ? "meta"
            : line[0] === "+"
              ? "str"
              : line[0] === "-"
                ? "tag"
                : undefined;

        emit(line, kind);
        flush();

        return chunks.join("");
    }

    if (lang === "markdown") {
        if (/^\s*(```|~~~)/.test(line)) {
            state.fence = !state.fence;
            emit(line, "meta");
        } else if (state.fence) {
            emit(line, "str");
        } else if (/^\s{0,3}(#{1,6}\s|>)/.test(line)) {
            emit(line, "kw");
        } else {
            const pattern =
                /`+[^`]*`+|!?\[[^\]]*\]\([^)]*\)|\*\*[^*]+\*\*|__[^_]+__|^\s*(?:[-*+] |\d+\. )/g;
            let from = 0;

            for (const match of line.matchAll(pattern)) {
                emit(line.slice(from, match.index));
                emit(match[0], match[0][0] === "`" ? "str" : "meta");
                from = match.index + match[0].length;
            }

            emit(line.slice(from));
        }

        flush();

        return chunks.join("");
    }

    while (at < line.length) {
        if (state.end) {
            const end = state.escaped
                ? quoteEnd(line, at, state.end, true)
                : line.indexOf(state.end, at);
            const to = end < 0 ? line.length : state.escaped ? end : end + state.end.length;

            emit(line.slice(at, to), state.kind);
            at = to;

            if (end >= 0) {
                state.end = null;
            }

            continue;
        }

        const rest = line.slice(at);
        let commentEnd;
        let commentStart;

        if (MARKUP.has(lang) && rest.startsWith("<!--")) {
            commentStart = "<!--";
            commentEnd = "-->";
        } else if (C_STYLE.has(lang) && rest.startsWith("/*")) {
            commentStart = "/*";
            commentEnd = "*/";
        } else if (lang === "sql" && rest.startsWith("/*")) {
            commentStart = "/*";
            commentEnd = "*/";
        } else if (lang === "lua" && /^--\[=*\[/.test(rest)) {
            commentStart = /^--\[=*\[/.exec(rest)[0];
            commentEnd = commentStart.slice(2).replaceAll("[", "]");
        }

        if (commentEnd) {
            emit(commentStart, "com");
            at += commentStart.length;
            Object.assign(state, { end: commentEnd, kind: "com", escaped: false });
            continue;
        }

        if (
            (HASH.has(lang) && rest[0] === "#") ||
            (C_STYLE.has(lang) && lang !== "css" && rest.startsWith("//")) ||
            ((lang === "sql" || lang === "lua") && rest.startsWith("--")) ||
            (lang === "ini" && rest[0] === ";")
        ) {
            emit(rest, "com");
            break;
        }

        if (["c", "cpp", "cs"].includes(lang) && rest[0] === "#") {
            emit(rest, "meta");
            break;
        }

        if (MARKUP.has(lang)) {
            const tag = /^<\/?[a-zA-Z][\w:.-]*/.exec(rest);

            if (tag) {
                state.tag = true;
                emit(tag[0], "tag");
                at += tag[0].length;
                continue;
            }

            if (state.tag && /^\/?>/.test(rest)) {
                const end = /^\/?>/.exec(rest)[0];

                emit(end, "tag");
                at += end.length;
                state.tag = false;
                continue;
            }

            if (/^<![A-Z]/i.test(rest)) {
                const meta = /^<![^>]*>?/.exec(rest)[0];

                emit(meta, "meta");
                at += meta.length;
                continue;
            }

            if (!state.tag && ["html", "xml", "svg"].includes(lang)) {
                const text = /^[^<]+/.exec(rest)?.[0] ?? rest[0];

                emit(text);
                at += text.length;
                continue;
            }
        }

        if (
            rest[0] === '"' ||
            rest[0] === "'" ||
            (rest[0] === "`" && ["js", "ts", "go", "shell"].includes(family))
        ) {
            const triple =
                ["python", "toml", "kotlin", "swift"].includes(lang) &&
                rest.startsWith(rest[0].repeat(3));
            const quote = triple ? rest[0].repeat(3) : rest[0];
            const raw = lang === "go" && quote === "`";
            const end = quoteEnd(line, at + quote.length, quote, !raw);
            const to = end < 0 ? line.length : end;
            const kind = lang === "json" && /^\s*:/.test(line.slice(to)) ? "prop" : "str";

            emit(line.slice(at, to), kind);
            at = to;

            if (
                end < 0 &&
                (triple ||
                    quote === "`" ||
                    MULTILINE_QUOTES.has(lang) ||
                    state.tag ||
                    /\\$/.test(line))
            ) {
                Object.assign(state, { end: quote, kind, escaped: !raw });
            }

            continue;
        }

        if (lang === "lua" && /^\[=*\[/.test(rest)) {
            const start = /^\[=*\[/.exec(rest)[0];

            emit(start, "str");
            at += start.length;
            Object.assign(state, { end: start.replaceAll("[", "]"), kind: "str", escaped: false });
            continue;
        }

        if (["shell", "php", "ruby"].includes(lang) && /^[$@]/.test(rest)) {
            const variable = /^[$@](?:\{[^}]*\}|[\w?#!@$*-]+)/.exec(rest);

            if (variable) {
                emit(variable[0], "var");
                at += variable[0].length;
                continue;
            }
        }

        if (["css", "scss"].includes(lang)) {
            const css = /^(?:#[\da-fA-F]{3,8}\b|--[\w-]+|[.@#$][\w-]+|[\w-]+(?=\s*:))/.exec(rest);

            if (css) {
                emit(css[0], css[0][0] === "#" ? "num" : css[0][0] === "@" ? "kw" : "prop");
                at += css[0].length;
                continue;
            }
        }

        if (lang === "yaml" && /^\s*(?:[-?]\s+)?$/.test(line.slice(0, at))) {
            const key = /^[^\s:#][^:#]*?(?=:\s|:$)/.exec(rest);

            if (key) {
                emit(key[0], "prop");
                at += key[0].length;
                continue;
            }
        }

        if (["ini", "toml"].includes(lang) && /^\s*$/.test(line.slice(0, at)) && rest[0] === "[") {
            emit(rest, "meta");
            break;
        }

        if (
            (family === "js" || family === "ts") &&
            rest[0] === "/" &&
            (before === "" || /[=(:,!&|?;{}[]$/.test(before) || /\breturn$/.test(before))
        ) {
            const regex = /^\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\[])+\/[dgimsuvy]*/.exec(rest);

            if (regex) {
                emit(regex[0], "re");
                at += regex[0].length;
                continue;
            }
        }

        NUMBER.lastIndex = at;
        const number = NUMBER.exec(line);

        if (number) {
            emit(number[0], "num");
            at += number[0].length;
            continue;
        }

        IDENTIFIER.lastIndex = at;
        const identifier = IDENTIFIER.exec(line);

        if (identifier) {
            const word = identifier[0];
            const after = line.slice(at + word.length);
            const lookup =
                lang === "sql"
                    ? word.toLowerCase()
                    : lang === "dockerfile"
                      ? word.toUpperCase()
                      : word;
            const kind = state.tag
                ? "attr"
                : LITERALS.has(word)
                  ? "lit"
                  : keywords?.has(lookup)
                    ? "kw"
                    : /^\s*[:=]/.test(after) && ["yaml", "toml", "ini"].includes(lang)
                      ? "prop"
                      : TYPES.has(word)
                        ? "type"
                        : /^\s*\(/.test(after)
                          ? "fn"
                          : /^[A-Z][a-zA-Z]+/.test(word)
                            ? "type"
                            : undefined;

            emit(word, kind);
            at += word.length;
            continue;
        }

        emit(rest[0], /[+*=!<>|&?:%~^/-]/.test(rest[0]) ? "op" : undefined);
        at++;
    }

    flush();

    return chunks.join("");
}

/** Code as escaped HTML with flat syntax spans. Unknown languages are plain escaped text. */
export function highlight(code, lang) {
    return highlightLines(code.split("\n"), lang).join("\n");
}

/** One escaped HTML string per input line. Block comments and multiline strings carry across lines in this call. */
export function highlightLines(lines, lang) {
    const language = langOf(lang);
    const state = {};
    let remaining = 500_000;

    return lines.map((line) => {
        remaining -= line.length;

        // Generated and minified files stay readable without holding up the conversation.
        if (!language || remaining < 0 || line.length > 20_000) {
            state.end = null;
            state.tag = false;

            return escape(line);
        }

        return colorLine(line, language, state);
    });
}
