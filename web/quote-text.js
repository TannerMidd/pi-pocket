export const QUOTE_MAX = 1500;

/** A quote's lines as written ("> …") without their ">". */
function passageOf(block) {
    return block
        .split("\n")
        .map((line) => line.replace(/^> ?/, ""))
        .join("\n");
}

function quoteLines(passage) {
    const text = passage.trim().replace(/\r\n?/g, "\n");
    const cut = text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX).trimEnd()}…` : text;

    return cut
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
}

export function withQuote(passage, reply) {
    return passage ? withQuotes([passage], reply) : reply;
}

/** `reply` with `passages` quoted first, in order, each a quote of its own (Reply's strips, Appearance → Separate). */
export function withQuotes(passages, reply) {
    return passages.length === 0
        ? reply
        : [...passages.map(quoteLines), reply].join("\n\n").trimEnd();
}

/** A message that starts with a quote (Ask PiP): its passage and the words after it. Null when it does not. */
export function splitQuote(text) {
    const match = /^((?:>[^\n]*(?:\n|$))+)\n*([\s\S]*)$/.exec(text);

    if (!match) {
        return null;
    }

    return { passage: passageOf(match[1].replace(/\n$/, "")), rest: match[2] };
}

const FENCE_OPEN = /^```[\w+#.-]*[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;

/**
 * Each quote in `text`: a run of lines that start with ">", outside code fences, as `{ start, end, text }`. `start` is
 * its first character, `end` the end of its last line (before that line's break), `text` its lines as written. A fence
 * is code only once it is closed, as a person's message shows it (transcript.js): one left open is text.
 */
export function quoteBlocks(text) {
    const blocks = [];
    const lines = text.split("\n");
    let at = 0;
    let closes = -1;
    let open = null;

    for (const [index, line] of lines.entries()) {
        const end = at + line.length;

        if (closes === -1 && FENCE_OPEN.test(line)) {
            closes = lines.findIndex((each, later) => later > index && FENCE_CLOSE.test(each));
        }

        if (closes !== -1) {
            open = null;

            if (index === closes) {
                closes = -1;
            }
        } else if (line.startsWith(">")) {
            if (open) {
                open.end = end;
            } else {
                open = { start: at, end };
                blocks.push(open);
            }
        } else {
            open = null;
        }

        at = end + 1;
    }

    return blocks.map((block) => ({ ...block, text: text.slice(block.start, block.end) }));
}

/**
 * A message as it shows: its quotes (`{ quote }`, the passage without its ">") and the words around them (`{ text }`),
 * in order. Null when it has no quote.
 */
export function quoteParts(text) {
    const blocks = quoteBlocks(text);

    if (blocks.length === 0) {
        return null;
    }

    const parts = [];
    let last = 0;

    const words = (until) => {
        const between = text.slice(last, until).replace(/^\n+|\n+$/g, "");

        if (between.trim() !== "") {
            parts.push({ text: between });
        }
    };

    for (const block of blocks) {
        words(block.start);
        parts.push({ quote: passageOf(block.text) });
        last = block.end;
    }

    words(text.length);

    return parts;
}

/**
 * `text` with `passage` quoted after it (Reply), on lines of its own: right under the words, or a blank line under a
 * quote (two quotes on lines in a row would be one). The box keeps it tight; the message gets a blank line around each
 * quote as it goes (`messageText`). Gives the new text, where the caret goes (the line right under the quote), and the
 * quote as written, at `start`..`end`.
 */
export function insertQuote(text, passage) {
    const block = quoteLines(passage);
    const before = text.replace(/\s+$/, "");
    const last = before.slice(before.lastIndexOf("\n") + 1);
    const head = before === "" ? "" : `${before}${last.startsWith(">") ? "\n\n" : "\n"}`;
    const value = `${head}${block}\n`;

    return {
        text: value,
        at: value.length,
        block,
        start: head.length,
        end: head.length + block.length,
    };
}

/**
 * Where the caret goes out of quote `block`: the line right under it, made when it is not there. Gives the text,
 * changed or not, and the caret.
 */
export function lineUnder(text, block) {
    return {
        text: block.end === text.length ? `${text}\n` : text,
        at: block.end + 1,
    };
}

/**
 * Whether `piece` (`{ start, end, text }`, a quote Reply put in the box) is still in `text` as it was put there: its
 * text at its place, on whole lines. What is around it does not matter (a quote line typed right under it, a code
 * fence): the message sets each piece apart as it goes (`messageText`).
 */
export function isPiece(text, piece) {
    return (
        piece.start >= 0 &&
        piece.end <= text.length &&
        text.slice(piece.start, piece.end) === piece.text &&
        (piece.start === 0 || text[piece.start - 1] === "\n") &&
        (piece.end === text.length || text[piece.end] === "\n")
    );
}

/** The pieces of `pieces` still in `text` (`isPiece`), in the order they are there. */
export function piecesIn(text, pieces) {
    return pieces.filter((piece) => isPiece(text, piece)).sort((a, b) => a.start - b.start);
}

/**
 * The message the box sends: its words, each paste placeholder in them expanded (`expand`), and its quotes `blocks`
 * (Reply's) as written, each a paragraph of its own, a blank line around it, as Markdown needs (a line right under a
 * quote would be part of it). A passage's words are never expanded: a placeholder in one is the passage's own text.
 */
export function messageText(text, blocks, expand = (words) => words) {
    if (blocks.length === 0) {
        return expand(text);
    }

    const parts = [];
    let last = 0;

    const words = (until) => {
        const between = expand(text.slice(last, until).replace(/^\n+|\n+$/g, ""));

        if (between.trim() !== "") {
            parts.push(between);
        }
    };

    for (const block of blocks) {
        words(block.start);
        parts.push(block.text);
        last = block.end;
    }

    words(text.length);

    return parts.join("\n\n");
}

const LINE_BREAKS = new Set(["insertLineBreak", "insertParagraph"]);

/** What a collapsed delete of `type` at `at` would take: `[from, to]`, as far as it may reach. */
function deleted(text, at, type) {
    const backward = type.includes("Backward");

    if (type === "deleteContentBackward") {
        return [Math.max(0, at - 1), at];
    }

    if (type === "deleteContentForward") {
        return [at, Math.min(text.length, at + 1)];
    }

    // A line: to its start or end, or the line break there when the caret is already at it.
    if (type.includes("Line")) {
        if (backward) {
            const start = text.lastIndexOf("\n", at - 1) + 1;

            return [start === at ? Math.max(0, at - 1) : start, at];
        }

        const end = text.indexOf("\n", at);
        const stop = end === -1 ? text.length : end;

        return [at, stop === at ? Math.min(text.length, at + 1) : stop];
    }

    // A word: its spaces and line breaks too, then the word.
    if (backward) {
        const reach = /\S*\s*$/.exec(text.slice(0, at))[0].length;

        return [at - Math.max(1, reach), at];
    }

    const reach = /^\s*\S*/.exec(text.slice(at))[0].length;

    return [at, at + Math.max(1, reach)];
}

/** `block` moved by `delta`. */
const shift = (block, delta) => ({ ...block, start: block.start + delta, end: block.end + delta });

/**
 * The first quote of `blocks` (pieces of `text`) that `next`, `text` after an edit over `from`..`to`, breaks: one the
 * edit changed, or that no longer stands on lines of its own (`isPiece`). One the edit takes whole is not broken: it
 * goes. Undefined when the edit keeps them all.
 */
export function brokenPiece(text, blocks, next, from, to) {
    const delta = next.length - text.length;

    return blocks.find((block) => {
        if (from <= block.start && to >= block.end) {
            return false;
        }

        const moved = block.end <= from ? block : block.start >= to ? shift(block, delta) : null;

        return moved === null || !isPiece(next, moved);
    });
}

/**
 * What the message box does with an edit, `beforeinput`'s `type` (and its `data`) over `start`..`end`, so that each
 * quote stays one piece: null to let it happen; `{ mark }`, a first Backspace on the line right under a quote (the
 * quote's start), which shows it is about to go; `{ remove }`, the second, which takes that quote away; `{ open }`, a
 * new line at a quote's start, which goes above it with the caret on it; `{ stop, under? }`,
 * an edit that would change a quote's words or join a line to it, which does not happen (what it writes goes on the
 * line under that quote, `lineUnder`). A whole quote selected can be typed over or deleted. `blocks` are the pieces of
 * `text` (`piecesIn`); `marked` is the start of the quote marked, or null.
 */
export function quoteStep(text, blocks, start, end, type, data, marked) {
    // A keyboard's word being composed, and undo, are the browser's own: a quote they change is no longer a piece.
    if (blocks.length === 0 || type.includes("Composition") || type.startsWith("history")) {
        return null;
    }

    if (type === "deleteContentBackward" && start === end) {
        const above = blocks.find((block) => start === block.end + 1);

        if (above) {
            return marked === above.start ? { remove: above } : { mark: above.start };
        }
    }

    if (type.startsWith("insert")) {
        const lineBreak = LINE_BREAKS.has(type);
        const at = start === end && lineBreak && blocks.find((block) => block.start === start);

        // A new line at a quote's start: a line above it, with the caret on it.
        if (at) {
            return { open: at.start };
        }

        const written = lineBreak ? "\n" : data;

        // What a drop or a paste writes is not always told: it may not touch a quote at all.
        if (typeof written !== "string") {
            const touched = blocks.find(
                (block) =>
                    start <= block.end &&
                    end >= block.start &&
                    !(start <= block.start && end >= block.end),
            );

            return touched ? { stop: true, under: touched } : null;
        }

        const broken = brokenPiece(
            text,
            blocks,
            `${text.slice(0, start)}${written}${text.slice(end)}`,
            start,
            end,
        );

        return broken ? { stop: true, under: broken } : null;
    }

    if (type.startsWith("delete")) {
        if (start !== end) {
            const next = `${text.slice(0, start)}${text.slice(end)}`;

            return brokenPiece(text, blocks, next, start, end) ? { stop: true } : null;
        }

        // How far a word or line delete reaches is the browser's to say: every reach up to the guess must be safe.
        const [from, to] = deleted(text, start, type);
        const backward = type.includes("Backward");

        for (let reach = 1; reach <= to - from; reach += 1) {
            const [a, b] = backward ? [to - reach, to] : [from, from + reach];

            if (brokenPiece(text, blocks, `${text.slice(0, a)}${text.slice(b)}`, a, b)) {
                return { stop: true };
            }
        }

        return null;
    }

    return null;
}

/**
 * Where the pieces `pieces` of `before` are in `after`, the box's text after an edit with the caret at `caret`: each
 * one the edit did not change, where it was (the edit after it) or moved by what the edit added or took (before it),
 * if it still stands on lines of its own there (`isPiece`). One the edit changed is a piece no longer: plain text.
 */
export function movePieces(before, after, caret, pieces) {
    if (pieces.length === 0 || before === after) {
        return piecesIn(after, pieces);
    }

    const change = changedRange(before, after, caret);
    const delta = after.length - before.length;

    return piecesIn(
        after,
        pieces.flatMap((piece) =>
            piece.end <= change.from
                ? [piece]
                : piece.start >= change.to
                  ? [shift(piece, delta)]
                  : [],
        ),
    );
}

/**
 * Where `before` and `after` differ, as one replacement: `from`..`to` of `before` becomes `insert`. An edit made this way
 * goes through the browser's own editing, which keeps it in the box's undo history. `caret`, where the caret is in
 * `after` once the edit is made (the end of what it wrote, or where it took text away), says which of two places the
 * same text could be the edit was at: what follows the caret stayed as it was.
 */
export function changedRange(before, after, caret) {
    if (caret !== undefined) {
        const most = Math.max(0, Math.min(before.length, after.length - caret));
        let tail = 0;

        while (tail < most && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
            tail += 1;
        }

        const limit = Math.min(before.length, after.length) - tail;
        let from = 0;

        while (from < limit && before[from] === after[from]) {
            from += 1;
        }

        return { from, to: before.length - tail, insert: after.slice(from, after.length - tail) };
    }

    let from = 0;

    while (from < before.length && from < after.length && before[from] === after[from]) {
        from += 1;
    }

    let tail = 0;

    while (
        tail < before.length - from &&
        tail < after.length - from &&
        before[before.length - 1 - tail] === after[after.length - 1 - tail]
    ) {
        tail += 1;
    }

    return { from, to: before.length - tail, insert: after.slice(from, after.length - tail) };
}

/**
 * `text` without its quote lines ("> …"), for what a message mentions: a file named in a quote is a passage's, not a
 * file this person asks to send along. The server reads mentions the same way (`mentionedPaths`, files.ts).
 */
export function outsideQuotes(text) {
    return text
        .split("\n")
        .filter((line) => !/^ {0,3}>/.test(line))
        .join("\n");
}

/**
 * `text` without the quote `block` and its line break, with no more than one blank line left where it was; the caret
 * goes there. Taken from the end, the caret stays on the line under the quote above, if one is there.
 */
export function withoutQuote(text, block) {
    let before = text.slice(0, block.start);
    let after = text.slice(block.end).replace(/^\n/, "");

    if (after.trim() === "") {
        before = before.replace(/\n+$/, "");

        const last = before.slice(before.lastIndexOf("\n") + 1);

        return before === ""
            ? { text: "", at: 0 }
            : {
                  text: last.startsWith(">") ? `${before}\n` : before,
                  at: before.length + (last.startsWith(">") ? 1 : 0),
              };
    }

    // A blank line above it and one under it make one.
    if (before.endsWith("\n\n") || before === "") {
        after = after.replace(/^\n+/, "");
    }

    return { text: `${before}${after}`, at: before.length };
}

/** The text of a selected range, as it was written: math as its TeX, a diagram as "[diagram]". */
export function rangeText(range) {
    const box = document.createElement("div");

    box.style.cssText = "position:fixed;left:-9999px;top:0;width:600px";
    box.append(range.cloneContents());

    for (const each of box.querySelectorAll("[data-tex]")) {
        const mark = each.dataset.lang === "math-display" ? "$$" : "$";

        each.replaceWith(`${mark}${each.dataset.tex}${mark}`);
    }

    for (const each of box.querySelectorAll(".pocket-diagrams-output")) {
        each.replaceWith("[diagram]");
    }

    document.body.append(box);

    const text = box.innerText;

    box.remove();

    return text;
}
