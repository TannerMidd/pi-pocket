/**
 * Artifacts: HTML pages, Markdown documents, and SVG images the agent publishes for the user to open in the app.
 * Every call with the same id adds a version. The index and the bodies are durable documents committed together with
 * the call, so a replayed call finds the version it already wrote instead of writing another.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { ArtifactBodyDoc, type ArtifactMeta, ArtifactsDoc, type ArtifactType } from "../docs.ts";
import type { PocketHost } from "../host.ts";
import { expandHome } from "../paths.ts";

const MAX_BYTES = 2_000_000;

export function slugify(value: string): string {
    return value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}

/** Agent-local files, not browser file access: parent links are allowed, the final file must not be a link. */
async function readArtifact(path: string): Promise<string> {
    const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );

    try {
        const info = await handle.stat();

        if (!info.isFile()) {
            throw new Error("Artifact paths must name a regular file.");
        }

        if (info.size > MAX_BYTES) {
            throw new Error(`Artifacts are limited to ${MAX_BYTES} bytes.`);
        }

        // Read at most one byte beyond the limit, even when the file grows after stat.
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let size = 0;

        while (true) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);

            if (bytesRead === 0) {
                break;
            }

            size += bytesRead;

            if (size > MAX_BYTES) {
                throw new Error(`Artifacts are limited to ${MAX_BYTES} bytes.`);
            }
        }

        const bytes = buffer.subarray(0, size);

        try {
            if (bytes.includes(0)) {
                throw new Error("Binary data");
            }

            return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
            throw new Error("Artifact paths must contain UTF-8 text, not binary data.");
        }
    } finally {
        await handle.close();
    }
}

function pathType(path: string): ArtifactType | undefined {
    switch (extname(path).toLowerCase()) {
        case ".html":
            return "html";
        case ".md":
        case ".markdown":
            return "markdown";
        case ".svg":
            return "svg";
        default:
            return undefined;
    }
}

function applyEdits(
    content: string,
    edits: readonly { oldText: string; newText: string }[],
): string {
    let next = content;

    for (const [index, edit] of edits.entries()) {
        if (edit.oldText === "") {
            throw new Error(`Edit ${index + 1}: oldText is empty.`);
        }

        const first = next.indexOf(edit.oldText);

        if (first === -1) {
            throw new Error(`Edit ${index + 1}: oldText was not found in the latest version.`);
        }

        if (next.indexOf(edit.oldText, first + 1) !== -1) {
            throw new Error(
                `Edit ${index + 1}: oldText matches more than once; include more context.`,
            );
        }

        next = next.slice(0, first) + edit.newText + next.slice(first + edit.oldText.length);
    }

    return next;
}

const GUIDE = `Use the artifact tool for results the user should see rendered rather than read as text: interactive demos, games, visualizations, charts, diagrams, formatted reports. Do not use it for plain answers or for project files (write those with write).
- HTML artifacts open in a sandboxed frame on the user's device (often a phone). They cannot reach this app, its cookies, or the parent page. Make them self-contained, responsive (include a viewport meta tag), and touch-friendly.
- Load libraries from a CDN with full URLs, such as https://esm.sh or https://cdn.jsdelivr.net. For ES modules that import bare specifiers (three.js addons import "three"), add an import map, for example: <script type="importmap">{"imports":{"three":"https://esm.sh/three@0.170.0","three/addons/":"https://esm.sh/three@0.170.0/examples/jsm/"}}</script>
- Show loading and error states inside the page (window.onerror, a visible message), so a broken artifact explains itself.
- Reuse the id to publish a new version. For small fixes, send edits against the latest version instead of the whole content.
- To publish an existing local HTML, Markdown, or SVG file without repeating its contents, give path instead of content or edits. This copies a UTF-8 snapshot (up to 2,000,000 bytes), not a live link or its neighboring assets. Everyone who can see the conversation can open the snapshot.`;

export default function createArtifacts(_host: PocketHost) {
    const artifact = defineTool({
        name: "artifact",
        description:
            "Publish a viewable artifact (self-contained HTML page, Markdown document, or SVG image) that the user opens in the app's artifact viewer. " +
            "Calling again with the same id publishes a new version. Give exactly one of content, nonempty edits, or a local UTF-8 file path (up to 2,000,000 bytes).",
        parameters: Type.Object({
            id: Type.String({
                description:
                    "Stable kebab-case id, for example solar-system. Reuse it for new versions.",
            }),
            title: Type.String({ description: "Short human-readable title." }),
            type: Type.Optional(
                Type.Union([Type.Literal("html"), Type.Literal("markdown"), Type.Literal("svg")], {
                    description:
                        "Default html for content, inferred from .html/.md/.markdown/.svg for a new path, or the existing artifact's type. A path cannot change an existing type.",
                }),
            ),
            content: Type.Optional(
                Type.String({ description: "The complete content of the new version." }),
            ),
            path: Type.Optional(
                Type.String({
                    description:
                        "Server-local UTF-8 file to copy as this version: absolute, ~/…, or relative to the session folder. Regular files only, not a final symlink. No neighboring assets are copied.",
                }),
            ),
            edits: Type.Optional(
                Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), {
                    description:
                        "Exact, unique replacements applied to the latest version instead of sending content.",
                }),
            ),
        }),
        // The commit below is idempotent per call, so a rerun after a crash is harmless.
        replay: "safe",
        execute: async (args, api, context) => {
            const id = slugify(args.id);

            if (id === "") {
                throw new Error("The id must contain letters or digits.");
            }

            const index = (await api.snapshot(ArtifactsDoc, api.conversationId, context)) ?? {
                items: {},
            };
            const previous = Object.hasOwn(index.items, id)
                ? (index.items[id] as ArtifactMeta)
                : undefined;
            // A replay of this very call, not another call of the same task (codemode makes several in one).
            const mine = (version: { taskId: unknown; callId?: string }) =>
                version.taskId === api.taskId && (version.callId ?? api.callId) === api.callId;
            const replayed = previous?.versions.find(mine);
            let version = replayed?.version;

            if (version === undefined) {
                const inputs = [args.content, args.edits, args.path].filter(
                    (value) => value !== undefined,
                ).length;

                if (inputs !== 1 || args.edits?.length === 0) {
                    throw new Error("Give exactly one of content, nonempty edits, or path.");
                }

                let content: string;
                let type: ArtifactType = args.type ?? previous?.type ?? "html";

                if (args.path !== undefined) {
                    if (args.path.trim() === "") {
                        throw new Error("Give a local file path.");
                    }

                    if (
                        previous !== undefined &&
                        args.type !== undefined &&
                        args.type !== previous.type
                    ) {
                        throw new Error("A path cannot change an existing artifact's type.");
                    }

                    const inferred = args.type ?? previous?.type ?? pathType(args.path);

                    if (inferred === undefined) {
                        throw new Error(
                            "Set type for a path without a .html, .md, .markdown, or .svg extension.",
                        );
                    }

                    type = inferred;
                    const agent = await api.agent(context);
                    const path = resolve(agent.cwd ?? process.cwd(), expandHome(args.path));

                    content = await readArtifact(path);
                } else if (args.content !== undefined) {
                    content = args.content;
                } else if (args.edits !== undefined && args.edits.length > 0) {
                    const latest = previous?.versions.at(-1);

                    if (latest === undefined) {
                        throw new Error(`There is no artifact ${id} to edit yet; send content.`);
                    }

                    const body = await api.snapshot(
                        ArtifactBodyDoc,
                        api.conversationId,
                        `${id}@${latest.version}`,
                        context,
                    );

                    content = applyEdits(body?.content ?? "", args.edits);
                } else {
                    throw new Error("Give either content or edits.");
                }

                if (Buffer.byteLength(content) > MAX_BYTES) {
                    throw new Error(`Artifacts are limited to ${MAX_BYTES} bytes.`);
                }

                version = await api.commit(async (tx) => {
                    const doc = await tx.doc(ArtifactsDoc, api.conversationId);
                    const current = Object.hasOwn(doc.items, id) ? doc.items[id] : undefined;
                    const again = current?.versions.find(mine);

                    if (again !== undefined) {
                        return again.version;
                    }

                    if (args.path !== undefined && current !== undefined) {
                        if (args.type !== undefined && args.type !== current.type) {
                            throw new Error("A path cannot change an existing artifact's type.");
                        }

                        type = current.type;
                    }

                    const next = (current?.versions.at(-1)?.version ?? 0) + 1;
                    const record = {
                        version: next,
                        taskId: api.taskId,
                        callId: api.callId,
                        size: Buffer.byteLength(content),
                        createdAt: Date.now(),
                    };

                    if (current === undefined) {
                        doc.items[id] = { title: args.title, type, versions: [record] };
                    } else {
                        current.title = args.title;
                        current.type = type;
                        current.versions.push(record);
                    }

                    const body = await tx.doc(
                        ArtifactBodyDoc,
                        api.conversationId,
                        `${id}@${next}`,
                        { content },
                    );

                    if (body.content !== content) {
                        body.content = content;
                    }

                    return next;
                }, context);
            }

            return {
                output: [
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
