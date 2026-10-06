import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { slugify } from "../src/server/extensions/artifacts.ts";
import {
    type ClientEntry,
    peekLines,
    plainText,
    projectEntry,
    projectLive,
    projectStats,
} from "../src/server/projection.ts";

const entry = (kind: string, message: unknown, id = 1) =>
    ({ id, conversationId: 2, kind, model: [message] }) as unknown as EntryRecord;

test("user entries keep text, count images, and lift the speaker prefix", () => {
    const plain = projectEntry(entry("pi.user", { role: "user", content: "hi", timestamp: 1 }));

    assert.deepEqual(plain, { id: 1, kind: "user", text: "hi", images: 0 });
    const shared = projectEntry(
        entry("pi.user", {
            role: "user",
            content: [
                { type: "text", text: "[from: Alex] look at this" },
                { type: "image", data: "x", mimeType: "image/png" },
            ],
            timestamp: 1,
        }),
    );

    assert.deepEqual(shared, {
        id: 1,
        kind: "user",
        text: "look at this",
        images: 1,
        from: "Alex",
    });
});

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

test("a long script's list of calls stays in the short form, without its errors", () => {
    const calls = Array.from({ length: 60 }, (_, index) => ({
        name: "write",
        status: "error",
        path: `file-${index}.txt`,
        durationMs: 3,
        error: "x".repeat(200),
    }));
    const message = {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "codemode",
        content: [{ type: "text", text: "done" }],
        details: { calls },
        isError: false,
    };
    const short = projectEntry(entry("pi.tool-result", message));

    assert.ok(short?.kind === "toolResult");
    assert.deepEqual((short.details as { calls: unknown[] }).calls[59], {
        name: "write",
        status: "error",
        path: "file-59.txt",
    });
    const full = projectEntry(entry("pi.tool-result", message), true);

    assert.ok(full?.kind === "toolResult");
    assert.deepEqual(full.details, { calls });
});

test("big tool arguments are clipped for the list and complete on request", () => {
    const content = "x".repeat(5000);
    const message = {
        role: "assistant",
        content: [
            { type: "toolCall", id: "c1", name: "write", arguments: { path: "a.txt", content } },
        ],
        stopReason: "toolUse",
    };
    const clipped = projectEntry(entry("pi.assistant", message));

    assert.ok(clipped?.kind === "assistant");
    const block = clipped.blocks[0]!;

    assert.ok(block.type === "toolCall");
    assert.equal((block.args.content as string).length, 1500);
    assert.deepEqual(block.clipped, { content: 5000 });
    const full = projectEntry(entry("pi.assistant", message), true);

    assert.ok(full?.kind === "assistant" && full.blocks[0]!.type === "toolCall");
    assert.equal(
        ((full.blocks[0] as { args: Record<string, unknown> }).args.content as string).length,
        5000,
    );
});

test("system entries are hidden and live state reports busy runs", () => {
    assert.equal(projectEntry(entry("pi.system", { role: "system", content: "" })), undefined);
    assert.deepEqual(projectLive(undefined), { busy: false });
    const live = projectLive({
        run: { taskId: 1, inputs: [] },
        tools: [{ callId: "c", name: "bash", status: "running", output: "o", taskId: 5 }],
    } as never);

    assert.equal(live.busy, true);
    assert.deepEqual(live.tools, [
        { callId: "c", name: "bash", status: "running", taskId: 5, output: "o" },
    ]);
});

test("stats add cost and cache rate, and read context size from the newest answer", () => {
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
    assert.equal(stats.cacheRate, 0.6);
    assert.equal(stats.contextTokens, 100);
});

test("artifact ids become kebab-case slugs", () => {
    assert.equal(slugify("Neon Orbital Garden!"), "neon-orbital-garden");
    assert.equal(slugify("  __x__ "), "x");
});

test("snippets drop markdown: emphasis, code ticks, links, headings, and list markers", () => {
    const markdown =
        "## Plan\n\n1. **Theme tokens.** Add a `[data-theme]` block, see [the docs](https://x.y).\n- _Toggle_ in `nav.js`\n> quoted\n\n```js\nconst a = 1;\n```";

    assert.equal(
        plainText(markdown),
        "Plan\n\nTheme tokens. Add a [data-theme] block, see the docs.\nToggle in nav.js\nquoted\n\nconst a = 1;\n",
    );
    assert.equal(
        plainText("a * b * c and snake_case_name stay"),
        "a * b * c and snake_case_name stay",
    );
});

test("peek lines are a session's last steps in brief: words, calls and how they went, and what streams now", () => {
    const entries: ClientEntry[] = [
        {
            id: 1,
            kind: "user",
            text: "fix the login\n\nAttached files (saved on the server):\n- /tmp/a.png",
            images: 0,
            from: "Alex",
        },
        {
            id: 2,
            kind: "assistant",
            blocks: [
                { type: "thinking", text: "hmm" },
                { type: "text", text: "Looking at **`auth.ts`**" },
                {
                    type: "toolCall",
                    id: "c1",
                    name: "read",
                    args: { path: "src/auth.ts", content: "x".repeat(1000), edits: [{ a: 1 }] },
                },
                { type: "toolCall", id: "c2", name: "bash", args: { command: "npm test" } },
            ],
        },
        { id: 3, kind: "toolResult", callId: "c1", name: "read", text: "…", isError: false },
        { id: 4, kind: "toolResult", callId: "c2", name: "bash", text: "1 failing", isError: true },
        {
            id: 5,
            kind: "assistant",
            blocks: [{ type: "toolCall", id: "c3", name: "edit", args: { path: "src/auth.ts" } }],
        },
    ];

    assert.deepEqual(
        peekLines(entries, {
            busy: true,
            tools: [{ callId: "c3", name: "edit", status: "running" }],
        }),
        [
            { kind: "user", text: "fix the login", from: "Alex" },
            { kind: "text", text: "Looking at auth.ts" },
            {
                kind: "tool",
                name: "read",
                args: { path: "src/auth.ts", content: "x".repeat(300) },
                status: "done",
            },
            { kind: "tool", name: "bash", args: { command: "npm test" }, status: "error" },
            { kind: "tool", name: "edit", args: { path: "src/auth.ts" }, status: "running" },
        ],
    );
    // A call without a result is done once Pi stopped; what streams comes last, and only the newest lines are kept.
    assert.deepEqual(
        peekLines(
            entries,
            {
                busy: false,
                generation: { attempt: 0, message: { blocks: [{ type: "text", text: "Almost" }] } },
            },
            2,
        ),
        [
            { kind: "tool", name: "edit", args: { path: "src/auth.ts" }, status: "done" },
            { kind: "text", text: "Almost" },
        ],
    );
    assert.deepEqual(
        peekLines(
            [
                { id: 6, kind: "assistant", blocks: [], stopReason: "aborted" },
                {
                    id: 7,
                    kind: "assistant",
                    blocks: [],
                    stopReason: "error",
                    error: "rate limited",
                },
                { id: 8, kind: "compaction", summary: "…" },
                { id: 9, kind: "other", entryKind: "pi.system" },
            ],
            { busy: false },
        ),
        [
            { kind: "event", text: "Stopped" },
            { kind: "error", text: "rate limited" },
            { kind: "event", text: "Context compacted" },
        ],
    );
});

test("peek lines keep each step short: shell commands, notes, attachments, long words, and nested arguments", () => {
    const shell = (id: number, status: "done" | "failed", code?: number) =>
        ({
            id,
            kind: "shell",
            command: `make ${"x".repeat(400)}`,
            by: "u1",
            name: "Alex",
            context: true,
            output: "…",
            status,
            ...(code === undefined ? {} : { code }),
            taskId: 1,
        }) as ClientEntry;
    const lines = peekLines(
        [
            { id: 1, kind: "user", text: "", images: 2 },
            { id: 2, kind: "user", text: "", images: 0 },
            shell(3, "done", 0),
            shell(4, "done", 2),
            shell(5, "failed"),
            { id: 6, kind: "note", text: "Alex turned plan mode on", name: "Alex" },
            {
                id: 7,
                kind: "assistant",
                blocks: [
                    { type: "text", text: `# Summary\n\n${"word ".repeat(100)}` },
                    { type: "text", text: "   " },
                    {
                        type: "toolCall",
                        id: "c9",
                        name: "codemode",
                        args: {
                            code: "return 1",
                            options: { a: 1 },
                            list: [1, 2],
                            flag: true,
                            n: 3,
                        },
                    },
                ],
            },
            { id: 8, kind: "reset", text: "fresh start" },
        ],
        { busy: false },
        20,
    );

    assert.deepEqual(lines[0], { kind: "user", text: "(attachments)" });
    assert.equal(
        lines.length,
        8,
        "an empty message without attachments, and blank text, make no line",
    );
    assert.deepEqual(
        lines.slice(1, 4).map((line) => (line.kind === "shell" ? line.status : line.kind)),
        ["done", "error", "error"],
    );
    const [, command, , , note, words] = lines;

    assert.equal(command?.kind === "shell" && command.command.length, 300);
    assert.deepEqual(note, { kind: "note", text: "Alex turned plan mode on", name: "Alex" });
    assert.ok(words?.kind === "text");
    assert.ok(words.text.length <= 200 && words.text.endsWith("…"));
    assert.ok(!words.text.includes("#"), "markdown is plain text");
    assert.deepEqual(lines[6], {
        kind: "tool",
        name: "codemode",
        args: { code: "return 1", flag: true, n: 3 },
        status: "done",
    });
    assert.deepEqual(lines[7], { kind: "event", text: "Context cleared" });
    // A call that streams in is running, whatever came before.
    assert.deepEqual(
        peekLines([], {
            busy: true,
            generation: {
                attempt: 0,
                message: {
                    blocks: [{ type: "toolCall", id: "c1", name: "bash", args: { command: "ls" } }],
                },
            },
        }),
        [{ kind: "tool", name: "bash", args: { command: "ls" }, status: "running" }],
    );
    assert.deepEqual(peekLines([], { busy: false }), []);
});
