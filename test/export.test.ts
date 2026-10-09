// A session as Markdown: messages in order, authors, tool calls folded away, and fences that hold.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fence, transcriptMarkdown } from "../src/server/export.ts";
import type { ClientEntry } from "../src/server/projection.ts";

const entries: ClientEntry[] = [
    {
        id: 1,
        kind: "user",
        text: "[from: Alex] Why does the build fail?\n\nAttached files (saved on the server):\n- /up/log.txt (log.txt, text/plain, 12 bytes)",
        images: 0,
        from: "Alex",
    },
    {
        id: 2,
        kind: "assistant",
        blocks: [
            { type: "thinking", text: "private reasoning" },
            { type: "text", text: "Let me look." },
            { type: "toolCall", id: "c1", name: "bash", args: { command: "npm run build" } },
        ],
        stopReason: "toolUse",
    },
    {
        id: 3,
        kind: "toolResult",
        callId: "c1",
        name: "bash",
        text: "error: ```weird``` output",
        isError: true,
    },
    {
        id: 4,
        kind: "assistant",
        blocks: [{ type: "toolCall", id: "c2", name: "edit", args: { path: "src/a.ts" } }],
        stopReason: "toolUse",
    },
    {
        id: 5,
        kind: "toolResult",
        callId: "c2",
        name: "edit",
        text: "ok",
        isError: false,
        details: { diff: "-a\n+b" },
    },
    {
        id: 6,
        kind: "assistant",
        blocks: [{ type: "text", text: "Fixed: a <typo>." }],
        stopReason: "stop",
    },
    { id: 7, kind: "reset", text: "We fixed the build." },
    { id: 8, kind: "user", text: "Thanks", images: 0 },
];

test("a transcript reads in order, with authors, files, folded tool calls, and no thinking", () => {
    const markdown = transcriptMarkdown({
        title: "Build fix",
        cwd: "~/app",
        model: "faux/faux-1",
        exportedAt: new Date("2026-10-04T12:30:00Z"),
        entries,
        authors: { 8: "Tanner" },
    });

    assert.match(
        markdown,
        /^# Build fix\n\n_Exported from Pi Pocket on 2026-10-04 12:30 UTC\. Folder `~\/app`, model `faux\/faux-1`\._/,
    );
    assert.match(
        markdown,
        /\*\*Alex\*\*\n\nWhy does the build fail\?\n\nAttached: `log\.txt`/,
        "the speaker prefix becomes the heading",
    );
    assert.doesNotMatch(markdown, /private reasoning/);
    assert.equal(markdown.match(/\*\*Pi\*\*/g)?.length, 1, "one heading for the whole answer");
    assert.match(
        markdown,
        /<details><summary>bash: npm run build<\/summary>\n\n```sh\n\$ npm run build\n```\n\nFailed:\n\n````\nerror: ```weird``` output\n````/,
    );
    assert.match(markdown, /<summary>edit: src\/a\.ts<\/summary>\n\n```diff\n-a\n\+b\n```/);
    assert.match(markdown, /Fixed: a <typo>\./, "Pi's text stays as written");
    assert.match(
        markdown,
        /---\n\n_New context\._\n\nWe fixed the build\.\n\n\*\*Tanner\*\*\n\nThanks\n$/,
    );
});

test("summaries are escaped and long output keeps its start and end", () => {
    const long = `${"a".repeat(3000)}MIDDLE${"z".repeat(3000)}`;
    const markdown = transcriptMarkdown({
        title: "t",
        cwd: "/",
        exportedAt: new Date(0),
        entries: [
            {
                id: 1,
                kind: "assistant",
                blocks: [
                    { type: "toolCall", id: "c", name: "bash", args: { command: "echo <b>&</b>" } },
                ],
            },
            { id: 2, kind: "toolResult", callId: "c", name: "bash", text: long, isError: false },
        ],
        authors: {},
    });

    assert.match(markdown, /<summary>bash: echo &#60;b&#62;&#38;&#60;\/b&#62;<\/summary>/);
    assert.doesNotMatch(markdown, /MIDDLE/);
    assert.match(markdown, /a{2000}\n… 2006 characters left out …\nz{2000}/);
});

test("fences grow past any backtick run inside", () => {
    assert.equal(fence("plain"), "```\nplain\n```");
    assert.equal(fence("has ```` four", "md"), "`````md\nhas ```` four\n`````");
});

test("command cards with many backtick runs export without truncation", () => {
    const output = "`x".repeat(200000);
    const markdown = transcriptMarkdown({
        title: "Many backticks",
        cwd: "/",
        exportedAt: new Date(0),
        entries: [
            {
                id: 1,
                kind: "command",
                command: "status",
                by: "owner",
                name: "Owner",
                output,
                taskId: 7,
            },
        ],
        authors: {},
    });

    assert.ok(markdown.includes("```\n" + output + "\n```"), "the entire card stays fenced");
});

test("command cards export their full fenced output and recorded author between Pi replies", () => {
    const output = "x".repeat(5000) + "\n`````\n<svg onload=alert(1)>";

    const markdown = transcriptMarkdown({
        title: "Native command",
        cwd: "/",
        exportedAt: new Date(0),
        entries: [
            { id: 1, kind: "assistant", blocks: [{ type: "text", text: "Before." }] },
            {
                id: 2,
                kind: "command",
                command: "clock-zone",
                by: "owner",
                name: "Owner",
                output,
                taskId: 7,
            },
            { id: 3, kind: "assistant", blocks: [{ type: "text", text: "After." }] },
        ],
        authors: { 2: "Not the recorded author" },
    });

    assert.ok(
        markdown.includes(fence(output)),
        "card output stays literal and is not silently omitted or clipped",
    );
    assert.match(markdown, /\*\*Owner\*\* ran `\/clock-zone` \(not shown to Pi\)/);
    assert.doesNotMatch(markdown, /Not the recorded author/);
    assert.equal(markdown.match(/\*\*Pi\*\*/g)?.length, 2, "the card separates the two Pi replies");
});
