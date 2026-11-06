// Export keeps a presented input's full text, folded under its label.
import assert from "node:assert/strict";
import { test } from "node:test";
import { transcriptMarkdown } from "../src/server/export.ts";
import type { ClientEntry } from "../src/server/projection.ts";
// @ts-expect-error: a browser module, without types.
import { userSearchText } from "../web/user-search.js";

test("export writes the label and the full text", () => {
    const entry = {
        id: 3,
        kind: "user",
        text: "the whole message",
        images: 0,
        presentation: { entryKind: "x.quiet-input.note", label: "Note", summary: "saved" },
    } satisfies ClientEntry;
    const markdown = transcriptMarkdown({
        title: "Notes",
        cwd: "/tmp/work",
        exportedAt: new Date("2026-01-02T03:04:00Z"),
        entries: [entry],
        authors: {},
    });

    assert.match(markdown, /<details><summary>Note · saved<\/summary>/);
    assert.match(markdown, /the whole message/);
});

test("export escapes a label and summary in its summary line", () => {
    const entry = {
        id: 4,
        kind: "user",
        text: "body",
        images: 0,
        presentation: { entryKind: "x.quiet-input.note", label: "<b>Note</b>", summary: "a & b" },
    } satisfies ClientEntry;
    const markdown = transcriptMarkdown({
        title: "Notes",
        cwd: "/tmp/work",
        exportedAt: new Date("2026-01-02T03:04:00Z"),
        entries: [entry],
        authors: {},
    });

    assert.match(markdown, /<summary>&#60;b&#62;Note&#60;\/b&#62; · a &#38; b<\/summary>/);
});

test("Find searches the label and the text", () => {
    const text = userSearchText({ label: "Note", summary: "saved" }, "the whole message");

    assert.match(text, /Note/);
    assert.match(text, /saved/);
    assert.match(text, /the whole message/);
    assert.equal(userSearchText(undefined, "hello"), "hello");
});
