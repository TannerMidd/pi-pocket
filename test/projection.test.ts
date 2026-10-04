import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { slugify } from "../src/server/extensions/artifacts.ts";
import { plainText, projectEntry, projectLive, projectStats } from "../src/server/projection.ts";

const entry = (kind: string, message: unknown, id = 1) => ({ id, conversationId: 2, kind, model: [message] }) as unknown as EntryRecord;

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
	assert.deepEqual(shared, { id: 1, kind: "user", text: "look at this", images: 1, from: "Alex" });
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
	const plain = projectEntry(entry("pi.tool-result", { ...message, content: [{ type: "text", text: "ok" }] }));
	assert.ok(plain?.kind === "toolResult" && plain.images === undefined);
});

test("a long script's list of calls stays in the short form, without its errors", () => {
	const calls = Array.from({ length: 60 }, (_, index) => ({ name: "write", status: "error", path: `file-${index}.txt`, durationMs: 3, error: "x".repeat(200) }));
	const message = { role: "toolResult", toolCallId: "c1", toolName: "codemode", content: [{ type: "text", text: "done" }], details: { calls }, isError: false };
	const short = projectEntry(entry("pi.tool-result", message));
	assert.ok(short?.kind === "toolResult");
	assert.deepEqual((short.details as { calls: unknown[] }).calls[59], { name: "write", status: "error", path: "file-59.txt" });
	const full = projectEntry(entry("pi.tool-result", message), true);
	assert.ok(full?.kind === "toolResult");
	assert.deepEqual(full.details, { calls });
});

test("big tool arguments are clipped for the list and complete on request", () => {
	const content = "x".repeat(5000);
	const message = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a.txt", content } }], stopReason: "toolUse" };
	const clipped = projectEntry(entry("pi.assistant", message));
	assert.ok(clipped?.kind === "assistant");
	const block = clipped.blocks[0]!;
	assert.ok(block.type === "toolCall");
	assert.equal((block.args.content as string).length, 1500);
	assert.deepEqual(block.clipped, { content: 5000 });
	const full = projectEntry(entry("pi.assistant", message), true);
	assert.ok(full?.kind === "assistant" && full.blocks[0]!.type === "toolCall");
	assert.equal(((full.blocks[0] as { args: Record<string, unknown> }).args.content as string).length, 5000);
});

test("system entries are hidden and live state reports busy runs", () => {
	assert.equal(projectEntry(entry("pi.system", { role: "system", content: "" })), undefined);
	assert.deepEqual(projectLive(undefined), { busy: false });
	const live = projectLive({ run: { taskId: 1, inputs: [] }, tools: [{ callId: "c", name: "bash", status: "running", output: "o", taskId: 5 }] } as never);
	assert.equal(live.busy, true);
	assert.deepEqual(live.tools, [{ callId: "c", name: "bash", status: "running", taskId: 5, output: "o" }]);
});

test("stats add cost and cache rate, and read context size from the newest answer", () => {
	const usage = {
		models: { "a/b": { input: 100, output: 10, cacheRead: 300, cacheWrite: 100, cost: { total: 0.5 } } },
		tools: { t: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } },
	};
	const entries = [entry("pi.assistant", { role: "assistant", content: [], usage: { input: 10, output: 5, cacheRead: 80, cacheWrite: 5 }, stopReason: "stop" })];
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
	const markdown = "## Plan\n\n1. **Theme tokens.** Add a `[data-theme]` block, see [the docs](https://x.y).\n- _Toggle_ in `nav.js`\n> quoted\n\n```js\nconst a = 1;\n```";
	assert.equal(plainText(markdown), "Plan\n\nTheme tokens. Add a [data-theme] block, see the docs.\nToggle in nav.js\nquoted\n\nconst a = 1;\n");
	assert.equal(plainText("a * b * c and snake_case_name stay"), "a * b * c and snake_case_name stay");
});
