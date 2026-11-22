// A `ui` call in the transcript (web/turns.js, web/calls.js): showing a card is its own row between the words and the
// steps around it; the card's patch, wait and close calls are steps in a group.
import assert from "node:assert/strict";
import { test } from "node:test";

type Block =
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; args: Record<string, unknown> };
type Entry = { id?: number; kind: string; blocks?: Block[]; stopReason?: string; text?: string };
type Step = { block: Block; entry?: Entry; streaming: boolean; canRun: boolean };
type Item = { type: string; key: string | number; steps?: Step[]; step?: Step };
type Turns = {
    itemsOf: (rows: Entry[], partial: Entry | null) => Item[];
    isInlineCall: (block: Block) => boolean;
    summarize: (steps: Step[], thinking?: boolean) => string;
};
type Calls = {
    describeCall: (call: { name: string; args?: Record<string, unknown> }) => {
        label: string;
        subject: string;
    };
};

// Plain ES modules of the web app's: paths the type checker does not follow.
const turns = (await import(new URL("../web/turns.js", import.meta.url).href)) as Turns;
const calls = (await import(new URL("../web/calls.js", import.meta.url).href)) as Calls;

const call = (id: string, name: string, args: Record<string, unknown> = {}): Block => ({
    type: "toolCall",
    id,
    name,
    args,
});
const said = (text: string): Block => ({ type: "text", text });
const answer = (id: number, blocks: Block[], stopReason = "toolUse"): Entry => ({
    id,
    kind: "assistant",
    blocks,
    stopReason,
});
const user: Entry = { id: 1, kind: "user", text: "go" };

test("a ui show call is an inline item, and the calls around it still group", () => {
    const rows = [
        user,
        answer(2, [
            call("a", "grep"),
            said("Pick one:"),
            call("card", "ui", { action: "show", title: "Cleanup" }),
            call("b", "read", { path: "x" }),
            call("c", "bash"),
        ]),
        answer(3, [said("Waiting."), call("d", "ui", { action: "show" })], "toolUse"),
    ];
    const items = turns.itemsOf(rows, null);

    assert.deepEqual(
        items.map((item) => item.type),
        ["row", "activity", "reply", "inline", "activity", "reply", "inline"],
    );
    assert.equal(items[3]!.key, "icard");
    assert.equal(items[3]!.step!.entry, rows[1]);
    assert.deepEqual(
        items[4]!.steps!.map((step) => (step.block as { id: string }).id),
        ["b", "c"],
    );
    assert.equal(items[6]!.key, "id", "a show with no id in its arguments is still one");
});

test("a ui call that patches, waits, or closes is a step; one still without its action is a card", () => {
    const rows = [
        user,
        answer(2, [
            call("p", "ui", { action: "patch", id: "s1" }),
            call("w", "ui", { action: "wait", id: "s1" }),
            call("x", "ui", { action: "close", id: "s1" }),
        ]),
    ];
    const items = turns.itemsOf(rows, null);

    assert.deepEqual(
        items.map((item) => item.type),
        ["row", "activity"],
    );
    assert.equal(items[1]!.steps!.length, 3);
    assert.equal(turns.isInlineCall(call("n", "ui", {})), true);
    assert.equal(turns.isInlineCall(call("n", "ui", { action: "patch" })), false);
});

test("a ui call has a one-line description and a place in a group's summary", () => {
    assert.deepEqual(calls.describeCall({ name: "ui", args: { title: "Cleanup" } }), {
        icon: "▦",
        label: "Showed card",
        subject: "“Cleanup”",
        mono: false,
    });
    assert.equal(
        calls.describeCall({ name: "ui", args: { action: "patch", id: "s2" } }).label,
        "Updated card",
    );

    const step = (block: Block): Step => ({ block, streaming: false, canRun: false });

    assert.equal(
        turns.summarize([step(call("a", "ui", { action: "patch", id: "s1" }))]),
        "Updated a card",
    );
});
