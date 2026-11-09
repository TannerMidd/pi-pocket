import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionedPaths } from "../src/server/files.ts";

type Block = { start: number; end: number; text: string };
type Step = {
    mark?: number;
    remove?: Block;
    open?: number;
    stop?: boolean;
    under?: Block;
} | null;

const {
    QUOTE_MAX,
    changedRange,
    insertQuote,
    isPiece,
    lineUnder,
    messageText,
    movePieces,
    outsideQuotes,
    piecesIn,
    quoteBlocks,
    quoteParts,
    quoteStep,
    splitQuote,
    withQuote,
    withQuotes,
    withoutQuote,
} = (await import(new URL("../web/quote-text.js", import.meta.url).href)) as {
    QUOTE_MAX: number;
    changedRange: (
        before: string,
        after: string,
        caret?: number,
    ) => { from: number; to: number; insert: string };
    insertQuote: (
        text: string,
        passage: string,
    ) => { text: string; at: number; block: string; start: number; end: number };
    isPiece: (text: string, piece: Block) => boolean;
    lineUnder: (text: string, block: Block) => { text: string; at: number };
    messageText: (text: string, blocks: Block[], expand?: (words: string) => string) => string;
    movePieces: (before: string, after: string, caret: number, pieces: Block[]) => Block[];
    outsideQuotes: (text: string) => string;
    piecesIn: (text: string, pieces: Block[]) => Block[];
    quoteBlocks: (text: string) => Block[];
    quoteParts: (text: string) => ({ quote: string } | { text: string })[] | null;
    quoteStep: (
        text: string,
        blocks: Block[],
        start: number,
        end: number,
        type: string,
        data: string | null,
        marked: number | null,
    ) => Step;
    splitQuote: (text: string) => { passage: string; rest: string } | null;
    withQuote: (passage: string | null, reply: string) => string;
    withQuotes: (passages: string[], reply: string) => string;
    withoutQuote: (text: string, block: Block) => { text: string; at: number };
};

test("a quoted passage goes out first, and reads back as it was", () => {
    const sent = withQuote("first line\n\nthird line", "why?");

    assert.equal(sent, "> first line\n>\n> third line\n\nwhy?");
    assert.deepEqual(splitQuote(sent), { passage: "first line\n\nthird line", rest: "why?" });
});

test("with no passage the reply goes out as it is, and a plain message shows no quote", () => {
    assert.equal(withQuote(null, "hello"), "hello");
    assert.equal(splitQuote("hello > not a quote"), null);
    assert.equal(quoteParts("hello > not a quote"), null);
});

test("strips' passages go first, each a quote of its own, in order", () => {
    const sent = withQuotes(["one", "two\nlines"], "why?");

    assert.equal(sent, "> one\n\n> two\n> lines\n\nwhy?");
    assert.deepEqual(quoteParts(sent), [
        { quote: "one" },
        { quote: "two\nlines" },
        { text: "why?" },
    ]);
    assert.equal(withQuotes(["only"], ""), "> only");
    assert.equal(withQuotes([], "plain"), "plain");
});

test("a long passage is cut", () => {
    const sent = withQuote("x".repeat(QUOTE_MAX + 500), "ok");

    assert.ok(sent.length < QUOTE_MAX + 20);
    assert.ok(sent.includes("…"));
});

/** The box after Reply quoted each of `passages` into `text`: its text, caret, and pieces. */
function replied(text: string, ...passages: string[]) {
    let words = text;
    let at = text.length;
    const pieces: Block[] = [];

    for (const passage of passages) {
        const quoted = insertQuote(words, passage);

        words = quoted.text;
        at = quoted.at;
        pieces.push({ start: quoted.start, end: quoted.end, text: quoted.block });
    }

    return { text: words, at, pieces };
}

test("Reply puts each quote tight after what is there, the caret right under it", () => {
    const first = replied("", "one\n\ntwo");

    assert.deepEqual(first, {
        text: "> one\n>\n> two\n",
        at: 14,
        pieces: [{ start: 0, end: 13, text: "> one\n>\n> two" }],
    });

    // Right under the words; a blank line only between two quotes, which would be one otherwise.
    const box = replied("first", "one", "two");

    assert.equal(box.text, "first\n> one\n\n> two\n");
    assert.equal(box.at, box.text.length);
    assert.deepEqual(
        box.pieces.map((piece) => isPiece(box.text, piece)),
        [true, true],
    );
    assert.equal(replied("mine\n\n\n", "q").text, "mine\n> q\n");
});

test("what goes to Pi sets each quote apart with a blank line, as Markdown needs", () => {
    const box = replied("first", "one", "two");
    const text = `${box.text}yes`;

    assert.equal(messageText(text, piecesIn(text, box.pieces)), "first\n\n> one\n\n> two\n\nyes");
    assert.deepEqual(quoteParts(messageText(text, piecesIn(text, box.pieces))), [
        { text: "first" },
        { quote: "one" },
        { quote: "two" },
        { text: "yes" },
    ]);
    // No pieces: the text as it is.
    assert.equal(messageText("a\n> b", []), "a\n> b");
});

test("a paste placeholder in a quote is the passage's words; in the person's own, it expands", () => {
    const box = replied("[Pasted text #1]", "Literal [Pasted text #1]");
    const expand = (words: string) => words.replace("[Pasted text #1]", "SECRET");

    assert.equal(
        messageText(box.text, piecesIn(box.text, box.pieces), expand),
        "SECRET\n\n> Literal [Pasted text #1]",
    );
});

test("a file named in a quote does not go along, in the box or on the server", () => {
    assert.equal(outsideQuotes("look @a.ts\n> see @/etc/passwd\n  > and @b.ts"), "look @a.ts");
    assert.deepEqual(
        mentionedPaths("look @a.ts\n\n> see @/etc/passwd").map((each) => each.written),
        ["a.ts"],
    );
});

test("pieces are known by where they are: the same words typed by hand stay plain text", () => {
    const box = replied("", "same");
    // Typed above it, the same words: the piece moves down, the typed one is not a piece.
    const typed = `> same\n\n${box.text}`;
    const moved = movePieces(box.text, typed, 8, box.pieces);

    assert.deepEqual(moved, [{ start: 8, end: 14, text: "> same" }]);
    // Two pieces with the same words: an edit in the first ends that one only.
    const two = replied("", "same", "same");
    const edited = `> sZame${two.text.slice(6)}`;

    assert.deepEqual(movePieces(two.text, edited, 4, two.pieces), [
        { start: 9, end: 15, text: "> same" },
    ]);
    assert.equal(quoteStep(two.text, two.pieces, 3, 3, "insertText", "Z", null)?.under?.start, 0);
});

test("a piece is on whole lines, at its place, with its words; a code fence around it does not matter", () => {
    const piece = { start: 4, end: 9, text: "> one" };

    assert.equal(isPiece("```\n> one\n", piece), true);
    assert.equal(isPiece("```\n> onex", piece), false);
    assert.equal(isPiece("```x> one", piece), false);
    assert.equal(isPiece("```\n> One", piece), false);
    assert.deepEqual(piecesIn("```\n> one\n", [piece, { start: 0, end: 3, text: "nah" }]), [piece]);
});

test("Backspace on the line right under a quote marks it first, then removes it, line and all", () => {
    const box = replied("hi", "one");
    const [piece] = box.pieces;

    assert.deepEqual(
        quoteStep(box.text, box.pieces, box.at, box.at, "deleteContentBackward", null, null),
        {
            mark: 3,
        },
    );
    assert.deepEqual(
        quoteStep(box.text, box.pieces, box.at, box.at, "deleteContentBackward", null, 3),
        {
            remove: piece,
        },
    );
    assert.deepEqual(withoutQuote(box.text, piece!), { text: "hi", at: 2 });
    // With words under it, they take its place; the blank line above it stays one.
    assert.deepEqual(withoutQuote("hi\n\n> one\n\nok", { start: 4, end: 9, text: "> one" }), {
        text: "hi\n\nok",
        at: 4,
    });
    // The last of two: the caret stays right under the one above.
    const two = replied("", "one", "two");

    assert.deepEqual(withoutQuote(two.text, two.pieces[1]!), { text: "> one\n", at: 6 });
});

test("typing in a quote goes under it; deleting into it or joining a line to it does nothing", () => {
    const box = replied("", "one");
    const text = `${box.text}ok`;
    const at = (start: number, type: string, data: string | null = null, end = start) =>
        quoteStep(text, box.pieces, start, end, type, data, null);

    assert.deepEqual(at(3, "insertText", "x"), { stop: true, under: box.pieces[0] });
    assert.deepEqual(at(5, "insertText", "x"), { stop: true, under: box.pieces[0] });
    assert.deepEqual(at(2, "deleteContentBackward"), { stop: true });
    assert.deepEqual(at(5, "deleteContentForward"), { stop: true });
    // The line right under it is the person's: typing there is fine.
    assert.equal(at(6, "insertText", "x"), null);
    assert.equal(at(8, "deleteContentBackward"), null);
    assert.deepEqual(lineUnder("> one", box.pieces[0]!), { text: "> one\n", at: 6 });
    assert.deepEqual(lineUnder(text, box.pieces[0]!), { text, at: 6 });
    // A new line at its start goes above it.
    assert.deepEqual(at(0, "insertLineBreak"), { open: 0 });
});

test("the blank line between two quotes takes typing", () => {
    const two = replied("", "one", "two");

    assert.equal(quoteStep(two.text, two.pieces, 6, 6, "insertText", "Z", null), null);

    const typed = `> one\nZ\n> two\n`;

    assert.deepEqual(
        movePieces(two.text, typed, 7, two.pieces).map((piece) => isPiece(typed, piece)),
        [true, true],
    );
});

test("what does not touch a quote happens as usual, and a whole quote selected can go", () => {
    const text = "hi\n\n> one\n\nok";
    const pieces = [{ start: 4, end: 9, text: "> one" }];
    const at = (start: number, end: number, type: string, data: string | null = null) =>
        quoteStep(text, pieces, start, end, type, data, null);

    assert.equal(at(1, 1, "insertText", "x"), null);
    assert.equal(at(12, 12, "deleteContentBackward"), null);
    assert.equal(at(13, 13, "insertCompositionText", "x"), null);
    assert.equal(at(6, 6, "historyUndo"), null);
    assert.equal(at(0, text.length, "insertText", "x"), null);
    assert.equal(at(2, 11, "deleteByCut"), null);
    // Across its edge: its words would change.
    assert.deepEqual(at(0, 6, "deleteByCut"), { stop: true });
    assert.deepEqual(at(6, 13, "insertText", "x"), { stop: true, under: pieces[0] });
    assert.deepEqual(at(7, 9, "insertReplacementText", "two"), { stop: true, under: pieces[0] });
    // A drop or paste that does not say what it writes, into it or not.
    assert.deepEqual(at(6, 6, "insertFromDrop"), { stop: true, under: pieces[0] });
    assert.equal(at(12, 12, "insertFromPaste"), null);
    // No pieces: plain text.
    assert.equal(quoteStep(text, [], 7, 7, "insertText", "x", null), null);
});

test("a word or line deleted next to a quote never reaches into it", () => {
    const text = "> one\nhi there";
    const pieces = [{ start: 0, end: 5, text: "> one" }];
    const at = (start: number, type: string) =>
        quoteStep(text, pieces, start, start, type, null, null);

    assert.equal(at(14, "deleteWordBackward"), null);
    assert.equal(at(14, "deleteSoftLineBackward"), null);
    assert.deepEqual(at(6, "deleteWordBackward"), { stop: true });
    assert.deepEqual(at(5, "deleteWordForward"), { stop: true });
    assert.deepEqual(at(5, "deleteSoftLineForward"), { stop: true });
});

test("an edit as one replacement: where two texts differ, at the caret when it could be either", () => {
    assert.deepEqual(changedRange("> one\n\nyes", "> one\n\nxyes"), {
        from: 7,
        to: 7,
        insert: "x",
    });
    assert.deepEqual(changedRange("a\n\n> q\n\nb", "a\n\nb"), { from: 3, to: 8, insert: "" });
    assert.deepEqual(changedRange("same", "same"), { from: 4, to: 4, insert: "" });
    // "\n\n" typed after "a" or after "a\n\n": the caret says which.
    assert.deepEqual(changedRange("a\n\nb", "a\n\n\n\nb", 3), { from: 1, to: 1, insert: "\n\n" });
    assert.deepEqual(changedRange("a\n\nb", "a\n\n\n\nb", 5), { from: 3, to: 3, insert: "\n\n" });
});

test("a message shows each quote where it was written, and one in a closed code fence is code", () => {
    assert.deepEqual(quoteParts("hi\n\n> one\n> more\n\nok\n\n> two"), [
        { text: "hi" },
        { quote: "one\nmore" },
        { text: "ok" },
        { quote: "two" },
    ]);
    assert.deepEqual(quoteBlocks("```\n> not one\n```\n> one"), [
        { start: 18, end: 23, text: "> one" },
    ]);
    // A fence left open is text, as a person's message shows it.
    assert.deepEqual(quoteBlocks("```\n> one"), [{ start: 4, end: 9, text: "> one" }]);
});
