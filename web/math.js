// Where math starts and ends in markdown: `$x^2$` in a line of words, `$$…$$` on lines of its own. The rules are
// pandoc's, so that prices stay text: "$5 and $10" holds no math, as the second `$` has a space before it. No imports, so
// Node tests it.

/** The longest math taken as math: a longer one stays as written. */
export const MATH_LIMIT = 20_000;

/**
 * Math in a line, at the start of `src`: `$…$`, or `$$…$$` (shown as a block). The opening `$` has no space after it; the
 * closing one has no space before it and no digit after it; `\$` does not close it, and it stays in one paragraph.
 * `{ raw, text, display }`, or null.
 */
export function inlineMath(src) {
    if (src[0] !== "$") {
        return null;
    }

    const display = src[1] === "$";
    const open = display ? 2 : 1;
    const first = src[open];

    if (first === undefined || /\s/.test(first) || first === "$") {
        return null;
    }

    for (let at = open; at < src.length && at <= MATH_LIMIT + open; at++) {
        const char = src[at];

        if (char === "\\") {
            at++;
        } else if (char === "\n" && src[at + 1] === "\n") {
            return null;
        } else if (char === "$") {
            if (!display && (/\s/.test(src[at - 1]) || /\d/.test(src[at + 1] ?? ""))) {
                return null;
            }

            if (!display || src[at + 1] === "$") {
                return { raw: src.slice(0, at + open), text: src.slice(open, at), display };
            }
        }
    }

    return null;
}

/**
 * Math on lines of its own, at the start of `src`: `$$` and the lines up to the next `$$`, or all in one line. `{ raw,
 * text }`, or null.
 */
export function blockMath(src) {
    const found =
        /^ {0,3}\$\$[ \t]*\n([\s\S]+?)\n {0,3}\$\$[ \t]*(?:\n|$)/.exec(src) ??
        /^ {0,3}\$\$(?!\$)([^\n]+?)\$\$[ \t]*(?:\n|$)/.exec(src);

    if (found === null || found[1].trim() === "" || found[1].length > MATH_LIMIT) {
        return null;
    }

    return { raw: found[0], text: found[1].trim() };
}
