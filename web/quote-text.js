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
    return passage ? `${quoteLines(passage)}\n\n${reply}`.trimEnd() : reply;
}

/** A message that starts with a quote (Ask PiP): its passage and the words after it. Null when it does not. */
export function splitQuote(text) {
    const match = /^((?:>[^\n]*(?:\n|$))+)\n*([\s\S]*)$/.exec(text);

    if (!match) {
        return null;
    }

    return { passage: passageOf(match[1].replace(/\n$/, "")), rest: match[2] };
}

/**
 * Each quote in `text`: a run of lines that start with ">", outside code fences, as `{ start, end, text }`. `start` is
 * its first character, `end` the end of its last line (before that line's break), `text` its lines as written.
 */
export function quoteBlocks(text) {
    const blocks = [];
    let at = 0;
    let fenced = false;
    let open = null;

    for (const line of text.split("\n")) {
        const end = at + line.length;

        if (line.startsWith("```")) {
            fenced = !fenced;
            open = null;
        } else if (!fenced && line.startsWith(">")) {
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
 * `text` with `passage` quoted at `at` (Reply): on lines of its own with a blank line around it, after the quote `at`
 * is in, never inside one. Gives the new text, where the caret goes (the line under it), and the quote as written.
 */
export function insertQuote(text, at, passage) {
    const block = quoteLines(passage);
    const inside = quoteBlocks(text).find((each) => at >= each.start && at <= each.end);
    const where = inside ? inside.end : Math.max(0, Math.min(at, text.length));
    const before = text.slice(0, where).replace(/\s+$/, "");
    const after = text.slice(where).replace(/^\s+/, "");
    const head = before === "" ? "" : `${before}\n\n`;
    // Words after it stay a paragraph apart from the line the caret is on.
    const value = `${head}${block}\n\n${after === "" ? "" : `\n\n${after}`}`;

    return { text: value, at: head.length + block.length + 2, block };
}

/**
 * Where the caret goes out of quote `block`: the empty line under it, after a blank line, made when it is not there.
 * Gives the text, changed or not, and the caret.
 */
export function lineUnder(text, block) {
    const after = text.slice(block.end);

    if (after === "" || after === "\n") {
        return { text: `${text.slice(0, block.end)}\n\n`, at: block.end + 2 };
    }

    return { text, at: after.startsWith("\n\n") ? block.end + 2 : block.end + 1 };
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

    // A word or a line: its spaces and line breaks too, then the word.
    if (backward) {
        const reach = /\S*\s*$/.exec(text.slice(0, at))[0].length;

        return [at - Math.max(1, reach), at];
    }

    const reach = /^\s*\S*/.exec(text.slice(at))[0].length;

    return [at, at + Math.max(1, reach)];
}

/** Whether words follow quote `block` of `text` on the very next line, which Markdown reads as part of the quote. */
const glued = (text, block) => /^\n[^\n]/.test(text.slice(block.end, block.end + 2));

/**
 * Whether `next`, `text` after an edit over `from`..`to`, keeps the quotes `blocks` (of `text`) that the edit did not
 * take whole: each one still there, in order, as it was, and with no words newly on the line right after it.
 */
export function keepsQuotes(text, blocks, next, from, to) {
    const kept = blocks.filter((block) => !(from <= block.start && to >= block.end));
    let i = 0;

    for (const block of quoteBlocks(next)) {
        if (i < kept.length && block.text === kept[i].text) {
            if (glued(next, block) && !glued(text, kept[i])) {
                return false;
            }

            i += 1;
        }
    }

    return i === kept.length;
}

/**
 * What the message box does with an edit, `beforeinput`'s `type` (and its `data`) over `start`..`end`, so that each
 * quote stays one piece: null to let it happen; `{ mark }`, a first Backspace on the line under a quote (the quote's
 * start), which shows it is about to go; `{ remove }`, the second, which takes that quote away; `{ open }`, a new line
 * at the start of a quote, which goes above it with the caret on it; `{ stop, under? }`, an edit that would change a
 * quote's words or join a line to it, which does not happen (typing moves the caret under the quote, `lineUnder`). A
 * whole quote selected can be typed over or deleted. `blocks` are the quotes of `text` kept as pieces (`quoteBlocks`,
 * those Reply put there); `marked` is the start of the quote marked, or null.
 */
export function quoteStep(text, blocks, start, end, type, data, marked) {
    // A keyboard's word being composed, and undo, are the browser's own: a quote they change is no longer a piece.
    if (blocks.length === 0 || type.includes("Composition") || type.startsWith("history")) {
        return null;
    }

    if (type === "deleteContentBackward" && start === end) {
        const above = blocks.find((block) => /^\n{1,2}$/.test(text.slice(block.end, start)));

        if (above) {
            return marked === above.start ? { remove: above } : { mark: above.start };
        }
    }

    const near = (from, to) =>
        blocks.find((block) => from <= block.end + 1 && to >= block.start - 1);

    if (type.startsWith("insert")) {
        const lineBreak = LINE_BREAKS.has(type);
        const at = start === end && lineBreak && blocks.find((block) => block.start === start);

        if (at) {
            return { open: at.start };
        }

        const written = lineBreak ? "\n" : data;

        // What a drop or a paste writes is not always told: it may not touch a quote at all.
        if (typeof written !== "string") {
            const touched = blocks.some(
                (block) =>
                    start <= block.end &&
                    end >= block.start &&
                    !(start <= block.start && end >= block.end),
            );

            return touched ? { stop: true, under: near(start, end) } : null;
        }

        const next = `${text.slice(0, start)}${written}${text.slice(end)}`;

        return keepsQuotes(text, blocks, next, start, end)
            ? null
            : { stop: true, under: near(start, end) };
    }

    if (type.startsWith("delete")) {
        const [from, to] = start === end ? deleted(text, start, type) : [start, end];
        const next = `${text.slice(0, from)}${text.slice(to)}`;

        return keepsQuotes(text, blocks, next, from, to) ? null : { stop: true };
    }

    return null;
}

/** `text` without the quote `block` and the blank lines after it; the caret goes where it was. */
export function withoutQuote(text, block) {
    let end = block.end;

    while (text[end] === "\n") {
        end += 1;
    }

    const before = text.slice(0, block.start).replace(/\n+$/, "");
    const after = text.slice(end);
    const value =
        before !== "" && after !== ""
            ? `${before}\n\n${after}`
            : before !== ""
              ? `${before}\n\n`
              : after;

    return { text: value, at: before === "" ? 0 : before.length + 2 };
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
