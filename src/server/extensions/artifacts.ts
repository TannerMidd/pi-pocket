/**
 * Artifacts: HTML pages, Markdown documents, and SVG images the agent publishes for the user to open in the app.
 * Every call with the same id adds a version. The index and the bodies are durable documents committed together with
 * the call, so a replayed call finds the version it already wrote instead of writing another.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { ArtifactBodyDoc, type ArtifactMeta, ArtifactsDoc, type ArtifactType } from "../docs.ts";
import type { PocketHost } from "../host.ts";

const MAX_BYTES = 2_000_000;

export function slugify(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function applyEdits(content: string, edits: readonly { oldText: string; newText: string }[]): string {
	let next = content;
	for (const [index, edit] of edits.entries()) {
		if (edit.oldText === "") throw new Error(`Edit ${index + 1}: oldText is empty.`);
		const first = next.indexOf(edit.oldText);
		if (first === -1) throw new Error(`Edit ${index + 1}: oldText was not found in the latest version.`);
		if (next.indexOf(edit.oldText, first + 1) !== -1) {
			throw new Error(`Edit ${index + 1}: oldText matches more than once; include more context.`);
		}
		next = next.slice(0, first) + edit.newText + next.slice(first + edit.oldText.length);
	}
	return next;
}

const GUIDE = `Use the artifact tool for results the user should see rendered rather than read as text: interactive demos, games, visualizations, charts, diagrams, formatted reports. Do not use it for plain answers or for project files (write those with write).
- HTML artifacts open in a sandboxed frame on the user's device (often a phone). They cannot reach this app, its cookies, or the parent page. Make them self-contained, responsive (include a viewport meta tag), and touch-friendly.
- Load libraries from a CDN with full URLs, such as https://esm.sh or https://cdn.jsdelivr.net. For ES modules that import bare specifiers (three.js addons import "three"), add an import map, for example: <script type="importmap">{"imports":{"three":"https://esm.sh/three@0.170.0","three/addons/":"https://esm.sh/three@0.170.0/examples/jsm/"}}</script>
- Show loading and error states inside the page (window.onerror, a visible message), so a broken artifact explains itself.
- Reuse the id to publish a new version. For small fixes, send edits against the latest version instead of the whole content.`;

export default function createArtifacts(_host: PocketHost) {
	const artifact = defineTool({
		name: "artifact",
		description:
			"Publish a viewable artifact (self-contained HTML page, Markdown document, or SVG image) that the user opens in the app's artifact viewer. " +
			"Calling again with the same id publishes a new version. Give either the full content or edits against the latest version.",
		parameters: Type.Object({
			id: Type.String({ description: "Stable kebab-case id, for example solar-system. Reuse it for new versions." }),
			title: Type.String({ description: "Short human-readable title." }),
			type: Type.Optional(
				Type.Union([Type.Literal("html"), Type.Literal("markdown"), Type.Literal("svg")], {
					description: "Default html, or the type of the existing artifact.",
				}),
			),
			content: Type.Optional(Type.String({ description: "The complete content of the new version." })),
			edits: Type.Optional(
				Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), {
					description: "Exact, unique replacements applied to the latest version instead of sending content.",
				}),
			),
		}),
		// The commit below is idempotent per call, so a rerun after a crash is harmless.
		replay: "safe",
		execute: async (args, api, context) => {
			const id = slugify(args.id);
			if (id === "") throw new Error("The id must contain letters or digits.");
			const index = (await api.snapshot(ArtifactsDoc, api.conversationId, context)) ?? { items: {} };
			const previous = Object.hasOwn(index.items, id) ? (index.items[id] as ArtifactMeta) : undefined;
			// A replay of this very call, not another call of the same task (codemode makes several in one).
			const mine = (version: { taskId: unknown; callId?: string }) => version.taskId === api.taskId && (version.callId ?? api.callId) === api.callId;
			const replayed = previous?.versions.find(mine);
			let version = replayed?.version;
			if (version === undefined) {
				let content: string;
				if (args.content !== undefined) {
					content = args.content;
				} else if (args.edits !== undefined && args.edits.length > 0) {
					const latest = previous?.versions.at(-1);
					if (latest === undefined) throw new Error(`There is no artifact ${id} to edit yet; send content.`);
					const body = await api.snapshot(ArtifactBodyDoc, api.conversationId, `${id}@${latest.version}`, context);
					content = applyEdits(body?.content ?? "", args.edits);
				} else {
					throw new Error("Give either content or edits.");
				}
				if (Buffer.byteLength(content) > MAX_BYTES) throw new Error(`Artifacts are limited to ${MAX_BYTES} bytes.`);
				const type: ArtifactType = args.type ?? previous?.type ?? "html";
				version = await api.commit(async (tx) => {
					const doc = await tx.doc(ArtifactsDoc, api.conversationId);
					const current = Object.hasOwn(doc.items, id) ? doc.items[id] : undefined;
					const again = current?.versions.find(mine);
					if (again !== undefined) return again.version;
					const next = (current?.versions.at(-1)?.version ?? 0) + 1;
					const record = { version: next, taskId: api.taskId, callId: api.callId, size: content.length, createdAt: Date.now() };
					if (current === undefined) {
						doc.items[id] = { title: args.title, type, versions: [record] };
					} else {
						current.title = args.title;
						current.type = type;
						current.versions.push(record);
					}
					const body = await tx.doc(ArtifactBodyDoc, api.conversationId, `${id}@${next}`, { content });
					if (body.content !== content) body.content = content;
					return next;
				}, context);
			}
			return {
				content: [
					{
						type: "text",
						text: `Published "${args.title}" as artifact ${id}, version ${version}. The user opens it from the artifact card.`,
					},
				],
				details: { id, title: args.title, version },
			};
		},
	});

	return defineExtension({
		name: "pocket-artifacts",
		tools: [artifact],
		sections: [section("artifacts", () => GUIDE)],
	});
}
