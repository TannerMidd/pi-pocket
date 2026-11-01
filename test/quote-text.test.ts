import assert from "node:assert/strict";
import { test } from "node:test";

const { QUOTE_MAX, splitQuote, withQuote } = (await import(
    new URL("../web/quote-text.js", import.meta.url).href
)) as {
    QUOTE_MAX: number;
    splitQuote: (text: string) => { passage: string; rest: string } | null;
    withQuote: (passage: string | null, reply: string) => string;
};

test("a quoted passage goes out first, and reads back as it was", () => {
    const sent = withQuote("first line\n\nthird line", "why?");

    assert.equal(sent, "> first line\n>\n> third line\n\nwhy?");
    assert.deepEqual(splitQuote(sent), { passage: "first line\n\nthird line", rest: "why?" });
});

test("with no passage the reply goes out as it is, and a plain message shows no quote", () => {
    assert.equal(withQuote(null, "hello"), "hello");
    assert.equal(splitQuote("hello > not a quote"), null);
});

test("a long passage is cut", () => {
    const sent = withQuote("x".repeat(QUOTE_MAX + 500), "ok");

    assert.ok(sent.length < QUOTE_MAX + 20);
    assert.ok(sent.includes("…"));
});
