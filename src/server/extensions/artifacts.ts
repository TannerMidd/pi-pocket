/**
 * Artifacts: HTML pages, Markdown documents, and SVG images the agent publishes for the user to open in the app, and
 * HTML pages it shows as a card in its reply (`artifact_inline`, the same store). Every call with the same id adds a
 * version. The index and the bodies are durable documents committed together with
 * the call, so a replayed call finds the version it already wrote instead of writing another.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
    defineExtension,
    defineTool,
    section,
    type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
    ArtifactBodyDoc,
    type ArtifactMeta,
    ArtifactsDoc,
    type ArtifactType,
    type ArtifactVersion,
} from "../docs.ts";
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

/** The bullet about the second tool, for sessions that have it. */
const INLINE_GUIDE = `- Two tools publish HTML. artifact_inline shows the page as a card in your reply, between your paragraphs, with Preview/Code and Run/Stop, and a button that opens the viewer: use it for a small interactive piece that belongs to what you are explaining (a calculator, a chart, a form), when the person will use it right there. artifact opens it in the viewer only: use it for a whole page, a game, a Markdown document or SVG image, or anything that needs the whole screen. Both share one store: the same id adds a version, whichever tool made the earlier ones. artifact_inline takes HTML only (content or edits, no path), and says in its result which version it made; that card keeps showing that version, so an update never changes an earlier card: say what changed, and do not repeat the page in your reply. Only a call you make directly shows a card: one made inside codemode publishes a version with no card. A page made by artifact_inline stays HTML: the artifact tool cannot change its type, so use a new id for a Markdown or SVG one. Write the card's page to fit a narrow column, with no fixed height: the card grows to fit the page, up to 900 px once it runs (1200 px as a preview), then the page scrolls inside it. Its page gets the same follow-up and saved-state messages as the viewer's.
`;

const guide = (
    inline: boolean,
) => `Use the artifact tool for results the user should see rendered rather than read as text: interactive demos, games, visualizations, charts, diagrams, formatted reports. Do not use it for plain answers or for project files (write those with write).
- HTML artifacts open in a sandboxed frame on the user's device (often a phone). They cannot reach this app, its cookies, or the parent page. Make them self-contained, responsive (include a viewport meta tag), and touch-friendly.
- Load libraries from a CDN with full URLs, such as https://esm.sh or https://cdn.jsdelivr.net. For ES modules that import bare specifiers (three.js addons import "three"), add an import map, for example: <script type="importmap">{"imports":{"three":"https://esm.sh/three@0.170.0","three/addons/":"https://esm.sh/three@0.170.0/examples/jsm/"}}</script>
- Show loading and error states inside the page (window.onerror, a visible message), so a broken artifact explains itself.
- In the app's viewer, an HTML artifact can ask the app for two things with parent.postMessage(message, "*"). Answers come as message events: take only those with event.source === parent. Only the page the frame first loads is heard: a page it goes on to (a link, location) gets no answer.
  - {type:"pocket-follow-up", text, selection}: puts a message in the person's message box, for them to read and send; it is never sent by itself, and the viewer closes so the box shows. Send it from a button's click or tap: the app takes it only right after the person taps or presses a key on the page (focus alone does not count; a tap serves one follow-up), and once every 2 seconds. text is up to 2,000 characters; selection, optional, is JSON up to 2,000. The app answers {type:"pocket-follow-up", ok, error}. Use it for "Ask Pi about this" buttons.
  - {type:"pocket-state-get", requestId, schema} and {type:"pocket-state-set", requestId, state, schema}: load and save up to 16 KB of JSON for the person using the artifact, so its controls survive a reload and follow them to other devices. requestId is 1 to 64 letters, digits, and _ . : - (others get no answer). The app answers {type:"pocket-state", requestId, ok, state, at, error}; state is null when nothing is saved. A set with state null clears it. schema, optional, is a string such as "v1" (up to 64 letters, digits, and . _ : -; a number is refused): change it when the state's shape changes, and older state then reads as null. Save after changes settle (at most 20 saves in 10 seconds).
  - Only HTML artifacts have this (not Markdown or SVG). Neither works in a published link or a tab of its own: the page must still work when no answer comes.
- Reuse the id to publish a new version. For small fixes, send edits against the latest version instead of the whole content.
${inline ? INLINE_GUIDE : ""}- To publish an existing local HTML, Markdown, or SVG file without repeating its contents, give path instead of content or edits. This copies a UTF-8 snapshot (up to 2,000,000 bytes), not a live link or its neighboring assets. Everyone who can see the conversation can open the snapshot.`;

type Exec = ToolRegistration["execute"];

type PublishArgs = {
    id: string;
    title: string;
    type?: ArtifactType;
    content?: string;
    path?: string;
    edits?: { oldText: string; newText: string }[];
};

/**
 * Publish a version, for `artifact` and for `artifact_inline` (`inline`: HTML only, and the result says the page shows
 * as a card in the reply). The commit is idempotent per call, so a rerun after a crash is harmless.
 */
async function publish(
    args: PublishArgs,
    api: Parameters<Exec>[1],
    context: Parameters<Exec>[2],
    inline: boolean,
): ReturnType<Exec> {
    const id = slugify(args.id);

    if (id === "") {
        throw new Error("The id must contain letters or digits.");
    }

    const index = (await api.snapshot(ArtifactsDoc, api.conversationId, context)) ?? {
        items: {},
    };
    const previous = Object.hasOwn(index.items, id) ? (index.items[id] as ArtifactMeta) : undefined;
    const notHtml = (type: ArtifactType) =>
        new Error(`Artifact ${id} is ${type}, not HTML: publish it with the artifact tool.`);

    // A replay of this very call, not another call of the same task (codemode makes several in one).
    const mine = (version: { taskId: unknown; callId?: string }) =>
        version.taskId === api.taskId && (version.callId ?? api.callId) === api.callId;
    const replayed = previous?.versions.find(mine);
    let version = replayed?.version;

    if (inline && version === undefined && previous !== undefined && previous.type !== "html") {
        throw notHtml(previous.type);
    }

    if (version === undefined) {
        const inputs = [args.content, args.edits, args.path].filter(
            (value) => value !== undefined,
        ).length;

        if (inputs !== 1 || args.edits?.length === 0) {
            throw new Error(
                inline
                    ? "Give exactly one of content or nonempty edits."
                    : "Give exactly one of content, nonempty edits, or path.",
            );
        }

        let content: string;
        let type: ArtifactType = inline ? "html" : (args.type ?? previous?.type ?? "html");

        if (args.path !== undefined) {
            if (args.path.trim() === "") {
                throw new Error("Give a local file path.");
            }

            if (previous !== undefined && args.type !== undefined && args.type !== previous.type) {
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

            if (inline && current !== undefined && current.type !== "html") {
                throw notHtml(current.type);
            }

            if (args.path !== undefined && current !== undefined) {
                if (args.type !== undefined && args.type !== current.type) {
                    throw new Error("A path cannot change an existing artifact's type.");
                }

                type = current.type;
            }

            // A card in a reply names a version, and the page it gets is by the artifact's type: so it stays HTML.
            if (
                current !== undefined &&
                current.type !== type &&
                current.versions.some((each) => each.inline === true)
            ) {
                throw new Error(
                    `Artifact ${id} has versions shown as cards in replies, so it stays HTML: publish the ${type} under a new id.`,
                );
            }

            const next = (current?.versions.at(-1)?.version ?? 0) + 1;
            const record: ArtifactVersion = {
                version: next,
                taskId: api.taskId,
                callId: api.callId,
                size: Buffer.byteLength(content),
                createdAt: Date.now(),
                ...(inline ? { inline: true as const } : {}),
            };

            if (current === undefined) {
                doc.items[id] = { title: args.title, type, versions: [record] };
            } else {
                current.title = args.title;
                current.type = type;
                current.versions.push(record);
            }

            const body = await tx.doc(ArtifactBodyDoc, api.conversationId, `${id}@${next}`, {
                content,
            });

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
                text: inline
                    ? `Published "${args.title}" as artifact ${id}, version ${version}. ${
                          // A script's nested calls have ids of the form `<codemode call>/<n>`.
                          api.callId.includes("/")
                              ? "It does not show as a card here: this call ran inside codemode, so the version has no card."
                              : `It shows as a card in your reply, and keeps showing version ${version}.`
                      }`
                    : `Published "${args.title}" as artifact ${id}, version ${version}. The user opens it from the artifact card.`,
            },
        ],
        details: inline
            ? { id, title: args.title, version, inline: true }
            : { id, title: args.title, version },
    };
}

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
        // The commit in publish() is idempotent per call, so a rerun after a crash is harmless.
        replay: "safe",
        execute: (args, api, context) => publish(args, api, context, false),
    });

    const inline = defineTool({
        name: "artifact_inline",
        description:
            "Show an HTML page as a card in your reply, where the person uses it without leaving the conversation (Preview/Code, Run/Stop, and a button for the artifact viewer). " +
            "The same store as artifact: the same id adds a version, and each card keeps the version its call made. Give exactly one of content or nonempty edits.",
        parameters: Type.Object({
            id: Type.String({
                description:
                    "Stable kebab-case id, for example loan-calculator. Reuse it for new versions.",
            }),
            title: Type.String({ description: "Short human-readable title." }),
            content: Type.Optional(
                Type.String({ description: "The complete HTML of the new version." }),
            ),
            edits: Type.Optional(
                Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), {
                    description:
                        "Exact, unique replacements applied to the latest version instead of sending content.",
                }),
            ),
        }),
        replay: "safe",
        // Only its own fields: the model may send others, and a path or a type is the artifact tool's.
        execute: (args, api, context) =>
            publish(
                { id: args.id, title: args.title, content: args.content, edits: args.edits },
                api,
                context,
                true,
            ),
    });

    return defineExtension({
        name: "pocket-artifacts",
        tools: [artifact, inline],
        sections: [
            section("artifacts", (input) =>
                guide(input.agent.tools.some((tool) => tool.name === "artifact_inline")),
            ),
        ],
    });
}
