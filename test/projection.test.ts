import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { projectEntry, projectStats } from "../src/server/projection.ts";

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
