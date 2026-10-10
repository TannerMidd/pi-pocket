// How the transcript reads a conversation (web/turns.js): Pi's answers as runs of words and groups of calls, their
// names as the answer is stored and as the rows shown start elsewhere, and what a call came to from what it printed.
import assert from "node:assert/strict";
import { test } from "node:test";

type Block =
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | { type: "toolCall"; id: string; name: string; args: Record<string, unknown> };
type Entry = { id?: number; kind: string; blocks?: Block[]; stopReason?: string; text?: string };
type Step = { block: Block; entry?: Entry; streaming: boolean; canRun: boolean };
type Item = {
    type: "row" | "activity" | "reply" | "mark";
    key: string | number;
    entry?: Entry;
    steps?: Step[];
    before?: Step[];
    anchors?: number[];
    anchor?: boolean;
    end?: boolean;
};
type Items = Item[] & { state: unknown };
type Turns = {
    itemsOf: (
        rows: Entry[],
        partial: Entry | null,
        options?: { prefix?: string; from?: unknown; talk?: boolean },
    ) => Items;
    rowsBefore: (rows: Entry[], start: number, talk?: boolean) => unknown;
    summarize: (steps: { block: Block }[], thinking?: boolean) => string;
    testOutcome: (text: string, command?: string) => string | null;
    matchCount: (text: string) => number;
    withoutNotes: (text: string) => string;
    shortError: (text: string) => string;
    diffCounts: (diff: unknown) => { added: number; removed: number } | null;
    STOPPED: RegExp;
};

// A plain ES module of the web app's: a path the type checker does not follow, as it has no types of its own.
const turns = (await import(new URL("../web/turns.js", import.meta.url).href)) as Turns;

const call = (id: string, name = "bash", args: Record<string, unknown> = {}): Block => ({
    type: "toolCall",
    id,
    name,
    args,
});
const said = (text: string): Block => ({ type: "text", text });
const thought: Block = { type: "thinking", text: "hmm" };
const user = (id: number): Entry => ({ id, kind: "user", text: "do it" });
const answer = (id: number, blocks: Block[], stopReason = "toolUse"): Entry => ({
    id,
    kind: "assistant",
    blocks,
    stopReason,
});
const shape = (items: Items) =>
    items.map((item) =>
        item.type === "activity"
            ? `${item.key}[${item.steps!.length}${item.before?.length ? `+${item.before.length}` : ""}]`
            : item.key,
    );

test("Pi's calls across answers fold into one group, and words end it", () => {
    const rows = [
        user(1),
        answer(2, [thought, call("a", "grep")]),
        answer(3, [call("b", "read", { path: "x" })]),
        answer(4, [said("Found it.")], "stop"),
        user(5),
        answer(6, [call("c"), said("  "), call("d")]),
        answer(7, [said("Done.")], "stop"),
    ];

    assert.deepEqual(shape(turns.itemsOf(rows, null)), [
        1,
        "a1:0[3]",
        "r1:0",
        5,
        // A blank text block between calls does not split them.
        "a5:0[2]",
        "r5:0",
    ]);
});

test("names stay the same as the answer being written is stored", () => {
    const before = [user(1), answer(2, [call("a")])];
    const writing = turns.itemsOf(before, { kind: "assistant", blocks: [call("b"), said("Hel")] });
    const stored = turns.itemsOf([...before, answer(3, [call("b"), said("Hello")], "stop")], null);

    assert.deepEqual(shape(writing), [1, "a1:0[2]", "r1:0"]);
    assert.deepEqual(shape(stored), [1, "a1:0[2]", "r1:0"]);
    // The answer's jump mark is on its words, where it has some; on its group where it has none.
    assert.equal(stored[2]!.anchor, true);
    assert.deepEqual(stored[1]!.anchors, [2]);
});

test("rows shown from the middle of a group keep its name, and carry its earlier steps", () => {
    const rows = [
        user(1),
        answer(2, [call("a")]),
        answer(3, [call("b")]),
        answer(4, [call("c")]),
        answer(5, [said("Done.")], "stop"),
        user(6),
    ];
    const whole = turns.itemsOf(rows, null);
    const cut = turns.itemsOf(rows.slice(2), null, { from: turns.rowsBefore(rows, 2) });

    assert.deepEqual(shape(whole), [1, "a1:0[3]", "r1:0", 6]);
    assert.deepEqual(shape(cut), ["a1:0[2+1]", "r1:0", 6]);
});

test("only the newest answer that asked for tools has calls that can still run", () => {
    const rows = [user(1), answer(2, [call("a")], "aborted"), user(3), answer(4, [call("b")])];
    const items = turns.itemsOf(rows, null);
    const steps = items.filter((item) => item.type === "activity").flatMap((item) => item.steps!);

    assert.deepEqual(
        steps.map((step) => step.canRun),
        [false, true],
    );
    // Once the next answer is being written, the calls before it are done.
    const writing = turns.itemsOf(rows, { kind: "assistant", blocks: [call("c")] });

    assert.deepEqual(
        writing
            .filter((item) => item.type === "activity")
            .flatMap((item) => item.steps!.map((step) => step.canRun)),
        [false, false, true],
    );
});

test("a failed answer ends its group; a final one gets its actions where people talk", () => {
    const rows = [
        user(1),
        answer(2, [call("a")], "error"),
        answer(3, [call("b")]),
        answer(4, [said("Done.")], "stop"),
    ];

    assert.deepEqual(shape(turns.itemsOf(rows, null)), [1, "a1:0[1]", "z2", "a1:1[1]", "r1:0"]);
    assert.equal(turns.itemsOf(rows, null).at(-1)!.end, false);
    assert.equal(turns.itemsOf(rows, null, { talk: true }).at(-1)!.end, true);
});

test("an answer with nothing to show still has a place to jump to", () => {
    const blank = turns.itemsOf([user(1), answer(2, [said("  ")], "stop")], null);

    assert.deepEqual(
        blank.map((item) => item.type),
        ["row", "mark"],
    );
    const afterCalls = turns.itemsOf(
        [user(1), answer(2, [call("a")]), answer(3, [said(" ")], "stop")],
        null,
    );

    assert.deepEqual(afterCalls[1]!.anchors, [2, 3]);
});

test("a group's line says what its calls did, in the order Pi did them", () => {
    const steps = (blocks: Block[]) => blocks.map((block) => ({ block }));

    assert.equal(
        turns.summarize(
            steps([
                thought,
                call("1", "grep"),
                call("2", "read", { path: "a" }),
                call("3", "read", { path: "b" }),
                call("4", "bash"),
            ]),
        ),
        "Thought, searched, read 2 files, ran 1 command",
    );
    assert.equal(
        turns.summarize(
            steps([
                call("1", "edit", { path: "a" }),
                call("2", "write", { path: "b" }),
                call("3", "subagent", { action: "spawn", name: "tests" }),
                call("4", "bash"),
                call("5", "bash"),
            ]),
        ),
        "Edited 1 file, wrote 1, ran a subagent and 2 commands",
    );
    assert.equal(turns.summarize(steps([thought]), true), "Thinking");
});

test("test runs read as how many passed, from each runner's own count", () => {
    assert.equal(
        turns.testOutcome("ℹ tests 11\nℹ pass 11\nℹ fail 0\nℹ duration_ms 265.2", "node --test"),
        "11 passed · 0.3s",
    );
    assert.equal(
        turns.testOutcome(
            "Test Suites: 2 passed, 2 total\nTests:       1 failed, 47 passed, 48 total\nTime:        3.1 s",
            "npm test",
        ),
        "47 passed · 1 failed · 3.1s",
    );
    assert.equal(
        turns.testOutcome(" Test Files  1 passed (1)\n      Tests  3 passed (3)", "npx vitest run"),
        "3 passed",
    );
    assert.equal(
        turns.testOutcome("===== 5 passed in 0.12s =====", "pytest -q"),
        "5 passed · 0.1s",
    );
    assert.equal(turns.testOutcome("3 passed the review", "git log"), null);
});

test("what tools printed is counted as it is meant", () => {
    // Grep's matches, not the lines around them.
    assert.equal(turns.matchCount("a.ts:3: x\na.ts-4- y\na.ts-2- z\nb-1-c.ts:9: w"), 2);
    assert.equal(turns.matchCount("a.ts:1: x\nb.ts:2: y"), 2);
    assert.equal(
        turns.withoutNotes("a\nb\n\n[1000 results limit reached. Use limit=2000]"),
        "a\nb",
    );
    assert.deepEqual(turns.diffCounts("  1 a\n-2 b\n+2 c\n+3 d"), { added: 2, removed: 1 });
    assert.equal(turns.shortError("out\n\nCommand exited with code 3"), "exit 3");
    assert.equal(
        turns.shortError("<harness>\n[error] Tool grep is not available\n</harness>"),
        "Tool grep is not available",
    );

    for (const stopped of [
        "<harness>\n[error] Tool bash was aborted\n</harness>",
        "<harness>\n[error] Tool edit was interrupted and may have partially run\n</harness>",
        "Operation aborted",
        "some output\n\nCommand aborted",
    ]) {
        assert.ok(turns.STOPPED.test(stopped), stopped);
    }

    assert.ok(!turns.STOPPED.test("the build was aborted by a flag"));
});
