import assert from "node:assert/strict";
import { test } from "node:test";

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
    insertQuote,
    lineUnder,
    quoteBlocks,
    quoteParts,
    quoteStep,
    splitQuote,
    withQuote,
    withQuotes,
    withoutQuote,
} = (await import(new URL("../web/quote-text.js", import.meta.url).href)) as {
    QUOTE_MAX: number;
    insertQuote: (
        text: string,
        at: number,
        passage: string,
    ) => { text: string; at: number; block: string };
    lineUnder: (text: string, block: Block) => { text: string; at: number };
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

/** `text` with "|" where the caret is: the text without it, and the caret. */
const caret = (marked: string) => [marked.replace("|", ""), marked.indexOf("|")] as const;

/** What the box does with an edit of `type` at the caret of `marked`, every quote of it a piece. */
const step = (
    marked: string,
    type: string,
    data: string | null = null,
    mark: number | null = null,
) => {
    const [text, at] = caret(marked);

    return quoteStep(text, quoteBlocks(text), at, at, type, data, mark);
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

test("Reply stacks quotes in the box: each after what is there, the caret on the line under it", () => {
    const first = insertQuote("", 0, "one\n\ntwo");

    assert.deepEqual(first, { text: "> one\n>\n> two\n\n", at: 15, block: "> one\n>\n> two" });

    const words = `${first.text}my answer`;
    const second = insertQuote(words, words.length, "three");

    assert.equal(second.text, "> one\n>\n> two\n\nmy answer\n\n> three\n\n");
    assert.equal(second.at, second.text.length);
    // A caret inside a quote puts the new one after it, never inside it; the words after it stay apart.
    assert.equal(
        insertQuote(second.text, 2, "four").text.startsWith("> one\n>\n> two\n\n> four\n\n\n\nmy"),
        true,
    );
});

test("a message shows each quote where it was written, and one in a code fence is code", () => {
    assert.deepEqual(quoteParts("hi\n\n> one\n> more\n\nok\n\n> two"), [
        { text: "hi" },
        { quote: "one\nmore" },
        { text: "ok" },
        { quote: "two" },
    ]);
    assert.deepEqual(quoteBlocks("```\n> not one\n```\n> one"), [
        { start: 18, end: 23, text: "> one" },
    ]);
});

test("Backspace on the line under a quote marks it first, then removes it with its blank lines", () => {
    const text = "hi\n\n> one\n\n";
    const [block] = quoteBlocks(text);

    assert.deepEqual(step("hi\n\n> one\n\n|", "deleteContentBackward"), { mark: 4 });
    assert.deepEqual(step("hi\n\n> one\n\n|", "deleteContentBackward", null, 4), { remove: block });
    assert.deepEqual(withoutQuote(text, block!), { text: "hi\n\n", at: 4 });
    assert.deepEqual(withoutQuote("> one\n\nmine", quoteBlocks("> one")[0]!), {
        text: "mine",
        at: 0,
    });
});

test("a quote's words do not change: typing in it goes under it, deleting into it does nothing", () => {
    const [block] = quoteBlocks("> one\n\nok");

    assert.deepEqual(step("> o|ne\n\nok", "insertText", "x"), { stop: true, under: block });
    assert.deepEqual(step("> one|\n\nok", "insertText", "x"), { stop: true, under: block });
    assert.deepEqual(step("> one\n\n|ok", "deleteContentBackward"), { mark: 0 });
    assert.deepEqual(step("> one\n|\nok", "deleteContentBackward"), { mark: 0 });
    assert.deepEqual(step("> |one\n\nok", "deleteContentBackward"), { stop: true });
    assert.deepEqual(step("> one|\n\nok", "deleteContentForward"), { stop: true });
    assert.deepEqual(step("hi|\n\n> one", "deleteWordForward"), { stop: true });
    // Words right under it would join it in Markdown.
    assert.deepEqual(step("> one\n|\nok", "deleteContentForward"), { stop: true });
    assert.deepEqual(step("> one\n|\nok", "insertText", "x"), { stop: true, under: block });
    // The caret leaves it on the line under it, made if missing.
    assert.deepEqual(lineUnder("> one", block!), { text: "> one\n\n", at: 7 });
    assert.deepEqual(lineUnder("> one\n\nok", block!), { text: "> one\n\nok", at: 7 });
});

test("what does not touch a quote happens as usual, and a whole quote selected can go", () => {
    const text = "hi\n\n> one\n\nok";

    assert.equal(step("h|i\n\n> one\n\nok", "insertText", "x"), null);
    assert.equal(step("hi\n\n> one\n\no|k", "deleteContentBackward"), null);
    assert.equal(step("hi\n\n> one|\n\nok", "insertLineBreak"), null);
    assert.equal(step("hi\n\n> one\n\nok|", "insertCompositionText", "x"), null);
    assert.equal(step("hi\n\n> o|ne\n\nok", "historyUndo"), null);
    assert.deepEqual(step("hi\n\n|> one\n\nok", "insertParagraph"), { open: 4 });
    assert.equal(quoteStep(text, quoteBlocks(text), 0, text.length, "insertText", "x", null), null);
    assert.equal(
        quoteStep(text, quoteBlocks(text), 2, 11, "deleteContentBackward", null, null),
        null,
    );
    // A quote typed by hand is not a piece: it is plain text.
    assert.equal(quoteStep(text, [], 7, 7, "insertText", "x", null), null);
});
