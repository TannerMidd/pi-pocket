// How the transcript reads a conversation (web/turns.js): Pi's answers as runs of words and groups of calls, and which
// calls can still run.
import assert from "node:assert/strict";
import { test } from "node:test";

type Block =
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | { type: "toolCall"; id: string; name: string; args: Record<string, unknown> };
type Entry = { id?: number; kind: string; blocks?: Block[]; stopReason?: string; text?: string };
type Step = { block: Block; entry?: Entry; streaming: boolean; canRun: boolean };
type Item = {
    type: "row" | "activity" | "reply" | "mark" | "inline";
    key: string | number;
    entry?: Entry;
    steps?: Step[];
    before?: Step[];
    anchors?: number[];
    anchor?: boolean;
    end?: boolean;
    step?: Step;
};
type Items = Item[] & { state: unknown };
type Turns = {
    itemsOf: (
        rows: Entry[],
        partial: Entry | null,
        options?: { prefix?: string; from?: unknown; talk?: boolean },
    ) => Items;
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
const INLINE = "artifact_inline";

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

test("an artifact_inline call is its own item between the words and the steps around it", () => {
    const rows = [
        user(1),
        answer(2, [call("a", "grep"), said("Here:"), call("page", INLINE), call("b", "read")]),
        answer(3, [said("Try it.")], "stop"),
    ];
    const items = turns.itemsOf(rows, null);

    assert.deepEqual(
        items.map((item) => item.type),
        ["row", "activity", "reply", "inline", "activity", "reply"],
    );
    assert.equal(items[3]!.key, "ipage", "named by its call, as a streamed one is");
    assert.equal(items[3]!.step!.entry, rows[1], "its entry, for a stored call");
    assert.equal(items[3]!.step!.canRun, false);
    // Streaming, the same call keeps its key.
    const writing = turns.itemsOf(rows.slice(0, 1), {
        kind: "assistant",
        blocks: [said("Here:"), call("page", INLINE)],
    });

    assert.equal(writing.at(-1)!.key, "ipage");
    assert.equal(writing.at(-1)!.step!.entry, undefined);
});

test("a jump to an answer lands on its words, or on its card when it has none", () => {
    const talking = turns.itemsOf(
        [user(1), answer(2, [call("p", INLINE), said("Hi")], "stop")],
        null,
    );
    const silent = turns.itemsOf([user(1), answer(2, [call("p", INLINE)])], null);

    assert.deepEqual(talking[1]!.anchors, [], "the words take it");
    assert.equal(talking[2]!.anchor, true);
    assert.deepEqual(silent[1]!.anchors, [2]);
});

test("two inline calls with one id get keys of their own", () => {
    const items = turns.itemsOf(
        [user(1), answer(2, [call("same", INLINE), call("same", INLINE)])],
        null,
    );
    const keys = items.filter((item) => item.type === "inline").map((item) => item.key);

    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, 2);
});
