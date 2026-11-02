import { strict as assert } from "node:assert";
import { test } from "node:test";

const { blockMath, inlineMath, MATH_LIMIT } = (await import(
    new URL("../web/math.js", import.meta.url).href
)) as {
    blockMath(src: string): { raw: string; text: string } | null;
    inlineMath(src: string): { raw: string; text: string; display: boolean } | null;
    MATH_LIMIT: number;
};

test("inline math respects delimiters and escapes", () => {
    assert.deepEqual(inlineMath("$x^2$ rest"), { raw: "$x^2$", text: "x^2", display: false });
    assert.deepEqual(inlineMath("$a\\$b$"), { raw: "$a\\$b$", text: "a\\$b", display: false });
    assert.equal(inlineMath("$5 and $10"), null);
    assert.equal(inlineMath("$5 and $10 or $x$"), null);
    assert.equal(inlineMath("$ x$"), null);
    assert.equal(inlineMath("$x $"), null);
    assert.equal(inlineMath("$x$5"), null);
    assert.ok(inlineMath("$x$ 5"));
    assert.equal(inlineMath("$x\n\ny$"), null);
    assert.equal(inlineMath(`$${"x".repeat(MATH_LIMIT + 1)}$`), null);
});

test("inline math does not close on a $ that has a letter or a digit after it", () => {
    assert.equal(inlineMath("$HOME/bin:$PATH"), null);
    assert.equal(inlineMath('$value" and "$type"'), null);
    assert.equal(inlineMath("$x$é"), null);
    assert.ok(inlineMath("$a+b$"));
    assert.ok(inlineMath("$x$, and"));
    assert.ok(inlineMath("$y$)"));
    // Scripts written without spaces: Chinese, Japanese.
    assert.ok(inlineMath("$z$为实数"));
    assert.ok(inlineMath("$x$です"));
});

test("display math supports one or more lines", () => {
    assert.deepEqual(blockMath("$$x=1$$\nrest"), { raw: "$$x=1$$\n", text: "x=1" });
    assert.deepEqual(blockMath("$$\nx+y\n$$\n"), { raw: "$$\nx+y\n$$\n", text: "x+y" });
    assert.equal(blockMath("$$\n$$"), null);
});
