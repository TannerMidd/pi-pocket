import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { compilePresentations } from "../src/server/entry-presentation.ts";
import {
    type ClientBlock,
    liveMessageDelta,
    peekLines,
    projectEntry,
    projectStats,
} from "../src/server/projection.ts";

const entry = (kind: string, message: unknown, id = 1) =>
    ({ id, conversationId: 2, kind, model: [message] }) as unknown as EntryRecord;

test("tool results count their images and leave the data out", () => {
    const message = {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "screenshot",
        content: [
            { type: "text", text: "captured" },
            { type: "image", data: "x".repeat(10_000), mimeType: "image/png" },
        ],
        isError: false,
    };
    const projected = projectEntry(entry("pi.tool-result", message));

    assert.ok(projected?.kind === "toolResult");
    assert.equal(projected.images, 1);
    assert.equal(projected.text, "captured");
    assert.ok(JSON.stringify(projected).length < 500);
    const plain = projectEntry(
        entry("pi.tool-result", { ...message, content: [{ type: "text", text: "ok" }] }),
    );

    assert.ok(plain?.kind === "toolResult" && plain.images === undefined);
});

test("stats add the cost of models and tools", () => {
    const usage = {
        models: {
            "a/b": {
                input: 100,
                output: 10,
                cacheRead: 300,
                cacheWrite: 100,
                cost: { total: 0.5 },
            },
        },
        tools: { t: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } },
    };
    const entries = [
        entry("pi.assistant", {
            role: "assistant",
            content: [],
            usage: { input: 10, output: 5, cacheRead: 80, cacheWrite: 5 },
            stopReason: "stop",
        }),
    ];
    const stats = projectStats(usage as never, entries);

    assert.equal(stats.cost, 0.75);
});

test("a live update that does not fit what the browser has is refused, not shown wrong", async () => {
    const { liveMessage } = (await import(new URL("../web/live.js", import.meta.url).href)) as {
        liveMessage: (current: unknown, update: unknown) => unknown;
    };
    const had = { blocks: [{ type: "text", text: "ab" }] };

    assert.equal(
        liveMessage(had, { keep: 0, blocks: [{ type: "text", from: 3, text: "d" }] }),
        null,
    );
    assert.deepEqual(
        liveMessage(
            had,
            liveMessageDelta(had.blocks as ClientBlock[], [{ type: "text", text: "abc" }]),
        ),
        { blocks: [{ type: "text", text: "abc" }] },
    );
});

const presentations = compilePresentations([
    {
        presentations: [{ kind: "x.quiet-input.note", label: "Note", userPrefix: "NOTE " }],
    },
]);

const noted = (text: string, data?: unknown, kind = "x.quiet-input.note") =>
    ({
        id: 7,
        conversationId: 2,
        kind,
        data,
        model: [{ role: "user", content: text, timestamp: 5 }],
    }) as unknown as EntryRecord;

test("a registered kind projects as a user row and clips until a full read", () => {
    const text = `body ${"n".repeat(9000)}`;
    const live = projectEntry(noted(text, { summary: "saved" }), false, { presentations });
    const full = projectEntry(noted(text, { summary: "saved" }), true, { presentations });

    assert.equal(live?.kind, "user");
    assert.equal(full?.kind, "user");

    if (live?.kind !== "user" || full?.kind !== "user") {
        return;
    }

    assert.equal(live.presentation?.entryKind, "x.quiet-input.note");
    assert.equal(live.presentation?.label, "Note");
    assert.equal(live.presentation?.summary, "saved");
    assert.equal(live.presentation?.clipped, text.length);
    assert.ok(live.text.length < text.length);
    assert.equal(full.text, text);
    assert.equal(full.presentation?.clipped, undefined);
    // Stored as the module's own kind: not a message that can go to Pi again.
    assert.equal(live.presentation?.prefixed, undefined);
    assert.deepEqual(peekLines([live], { busy: false }), [
        { kind: "presented", label: "Note", summary: "saved" },
    ]);
});

test("an unregistered kind stays other", () => {
    assert.deepEqual(projectEntry(noted("hello", undefined, "x.quiet-input.other")), {
        id: 7,
        kind: "other",
        entryKind: "x.quiet-input.other",
    });
});

test("a registered kind that is not a user message stays other", () => {
    const assistant = {
        ...noted("hello"),
        model: [{ role: "assistant", content: "hello" }],
    } as unknown as EntryRecord;

    assert.equal(projectEntry(assistant, false, { presentations })?.kind, "other");
});

test("a prefix matches only a user message nobody wrote, and leaves the prefix in the text", () => {
    const row = entry("pi.user", { role: "user", content: "NOTE hello" });
    const open = projectEntry(row, false, { presentations, authored: false });
    const written = projectEntry(row, false, { presentations, authored: true });

    assert.equal(open?.kind, "user");
    assert.equal(written?.kind, "user");

    if (open?.kind !== "user" || written?.kind !== "user") {
        return;
    }

    assert.equal(open.presentation?.label, "Note");
    // A `pi.user` message: it can be sent again.
    assert.equal(open.presentation?.prefixed, true);
    assert.equal(open.text, "NOTE hello");
    assert.equal(written.presentation, undefined);
    assert.equal(written.text, "NOTE hello");
});
