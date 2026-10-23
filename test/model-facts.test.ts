// The line that tells an agent what a listed model offers (`model-facts.ts`): each fact only when known.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelLine } from "../src/server/model-facts.ts";

test("a model line has its thinking, window, and price, and marks the session's own", () => {
    assert.equal(
        modelLine(
            "a/b",
            {
                thinkingLevels: ["off", "low", "high"],
                contextWindow: 200_000,
                cost: { input: 3, output: 15 },
            },
            true,
        ),
        "- a/b: thinks up to high, 200k ctx, $3 in/$15 out per 1M, your model",
    );
});

test("unknown facts are left out, and a model that cannot be used now says why", () => {
    assert.equal(modelLine("a/b", undefined, false), "- a/b");
    assert.equal(
        modelLine("a/b", { thinkingLevels: ["off"], contextWindow: 1_000_000 }, false, "expired"),
        "- a/b: no thinking, 1M ctx, not now: expired",
    );
    // A window of 0 is unknown; a small price keeps its digits.
    assert.equal(
        modelLine(
            "a/b",
            { thinkingLevels: ["low"], contextWindow: 0, cost: { input: 0.075, output: 0.3 } },
            false,
        ),
        "- a/b: thinks up to low, $0.075 in/$0.3 out per 1M",
    );
});
