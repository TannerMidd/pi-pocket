/**
 * Artifacts: HTML pages, Markdown documents, and SVG images the agent publishes for the user to open in the app, and
 * HTML pages it shows as a card in its reply (`artifact_inline`, the same store). Every call with the same id adds a
 * version. The index and the bodies are durable documents committed together with
 * the call, so a replayed call finds the version it already wrote instead of writing another.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
    defineExtension,
    defineTool,
    section,
    type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
    ArtifactAssetDoc,
    ArtifactBodyDoc,
    type ArtifactAsset,
    type ArtifactMeta,
    ArtifactsDoc,
    type ArtifactType,
    type ArtifactVersion,
} from "../docs.ts";
import { APP_ROOT } from "../config.ts";
import type { PocketHost } from "../host.ts";
import { loadDesignSystem } from "../design/tokens.ts";
import { assetName, assetType } from "../http/artifact-assets.ts";
import { expandHome } from "../paths.ts";

export const MAX_BYTES = 2_000_000;
export const MAX_ASSET_BYTES = 5_000_000;
export const MAX_ASSETS_BYTES = 20_000_000;
export const MAX_ASSETS = 200;

export function slugify(value: string): string {
    return value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}

/** Agent-local files, not browser file access: parent links are allowed, the final file must not be a link. */
async function readFileBytes(path: string, limit: number): Promise<Buffer> {
    const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );

    try {
        const info = await handle.stat();

        if (!info.isFile()) {
            throw new Error("Artifact paths must name a regular file.");
        }

        if (info.size > limit) {
            throw new Error(`Files are limited to ${limit} bytes.`);
        }

        // Read at most one byte beyond the limit, even when the file grows after stat.
        const buffer = Buffer.alloc(limit + 1);
        let size = 0;

        while (true) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);

            if (bytesRead === 0) {
                break;
            }

            size += bytesRead;

            if (size > limit) {
                throw new Error(`Files are limited to ${limit} bytes.`);
            }
        }

        // Do not retain the full limit-sized backing allocation for each small bundle file.
        return Buffer.from(buffer.subarray(0, size));
    } finally {
        await handle.close();
    }
}

async function readArtifact(path: string): Promise<string> {
    const bytes = await readFileBytes(path, MAX_BYTES);

    try {
        if (bytes.includes(0)) {
            throw new Error("Binary data");
        }

        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        throw new Error("Artifact paths must contain UTF-8 text, not binary data.");
    }
}

const DESIGN_FILES = {
    "ds/tokens.css": "css",
    "ds/tailwind.css": "tailwind",
    "ds/components.css": "components",
} as const;

/**
 * Adds the compiled `.pi/design/dist/` files that `content` links and the call does not bring or drop. It reads files
 * before the commit, so a replayed call finds what it wrote. Returns notes for the result text.
 */
async function attachDesignSystem(
    content: string,
    prepared: Map<string, { asset: ArtifactAsset; bytes: Buffer }>,
    removed: readonly string[],
    cwd: string | undefined,
): Promise<string[]> {
    const wanted = (Object.keys(DESIGN_FILES) as (keyof typeof DESIGN_FILES)[]).filter(
        (name) => content.includes(name) && !prepared.has(name) && !removed.includes(name),
    );

    if (wanted.length === 0) {
        return [];
    }

    let system;

    try {
        system = cwd === undefined ? undefined : loadDesignSystem(cwd);
    } catch (error) {
        return [
            `The page links ${wanted.join(", ")}, but the design system could not be read: ${(error as Error).message}`,
        ];
    }

    if (system === undefined) {
        return [
            `The page links ${wanted.join(", ")}, but this project has no design system (.pi/design/), so the link will not load. Create one with design_system init, or remove the link.`,
        ];
    }

    for (const name of wanted) {
        const bytes = Buffer.from(system.compiled[DESIGN_FILES[name]], "utf8");

        prepared.set(name, {
            asset: {
                hash: createHash("sha256").update(bytes).digest("hex"),
                size: bytes.length,
                type: assetType(name),
            },
            bytes,
        });
    }

    const errors = system.problems.filter((problem) => problem.level === "error").length;

    return [
        `Attached ${wanted.join(", ")} from the design system "${system.name}" (a snapshot of now; publish again to refresh).${errors > 0 ? ` The system has ${errors} error${errors === 1 ? "" : "s"}: run design_system validate.` : ""}`,
    ];
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
const INLINE_GUIDE = `- artifact_inline shows the page as a card in your reply, for a small interactive piece the person uses right there (a calculator, a chart, a form); artifact is for a whole page, a game, Markdown, or SVG. Its result says which version it made: after an update, say what changed and do not repeat the page. Only a call you make directly shows a card, not one inside codemode. An id made by artifact_inline stays HTML: use a new id for Markdown or SVG. Write its page for a narrow column with no fixed height: the card grows up to 900 px, then scrolls.
`;

export const BRIDGE_GUIDE = join(APP_ROOT, "src", "server", "guides", "artifact-bridge.md");

const guide = (
    inline: boolean,
) => `Use the artifact tool for results the user should see rendered rather than read as text: interactive demos, games, visualizations, charts, diagrams, formatted reports. Not for plain answers or project files (write those with write).
- HTML artifacts open in a sandboxed frame on the user's device (often a phone) and cannot reach this app, its cookies, or the parent page. Make them self-contained, responsive (a viewport meta tag), and touch-friendly, with visible loading and error states (window.onerror).
- Load libraries from a CDN with full URLs (https://esm.sh, https://cdn.jsdelivr.net). For ES modules that import bare specifiers (three.js addons import "three"), add an import map.
- For a page that puts a message in the person's message box ("Ask Pi about this") or keeps its state across reloads and devices, read ${BRIDGE_GUIDE} first.
- For small fixes, send edits instead of the whole content.
${inline ? INLINE_GUIDE : ""}- To publish an existing local file without repeating it, give path. Everyone who can see the conversation can open the copy.`;

type Exec = ToolRegistration["execute"];

type PublishArgs = {
    id: string;
    title: string;
    type?: ArtifactType;
    content?: string;
    path?: string;
    edits?: { oldText: string; newText: string }[];
    assets?: { name: string; path?: string; content?: string }[];
    removeAssets?: string[];
    group?: string;
    kind?: "page" | "deck";
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
    let notes: string[] = [];

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

        if (args.group !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.group)) {
            throw new Error("The group must be a lowercase kebab-case slug.");
        }

        if (args.group !== undefined && args.group.length > 64) {
            throw new Error("The group is limited to 64 characters.");
        }

        if (
            (args.assets?.length ?? 0) > MAX_ASSETS ||
            (args.removeAssets?.length ?? 0) > MAX_ASSETS
        ) {
            throw new Error(`Give at most ${MAX_ASSETS} assets or removals.`);
        }

        for (const name of args.removeAssets ?? []) {
            if (!assetName(name)) {
                throw new Error(`Invalid asset name: ${name}`);
            }
        }

        const prepared = new Map<string, { asset: ArtifactAsset; bytes: Buffer }>();
        let preparedSize = 0;

        for (const entry of args.assets ?? []) {
            if (!assetName(entry.name) || prepared.has(entry.name)) {
                throw new Error(`Invalid or repeated asset name: ${entry.name}`);
            }

            if ((entry.path === undefined) === (entry.content === undefined)) {
                throw new Error(`Asset ${entry.name}: give exactly one of path or content.`);
            }

            let bytes: Buffer;

            if (entry.path !== undefined) {
                if (entry.path.trim() === "") {
                    throw new Error("Give a local file path.");
                }

                const agent = await api.agent(context);
                const path = resolve(agent.cwd ?? process.cwd(), expandHome(entry.path));

                bytes = await readFileBytes(path, MAX_ASSET_BYTES);
            } else {
                if (Buffer.byteLength(entry.content!, "utf8") > MAX_ASSET_BYTES) {
                    throw new Error(`Assets are limited to ${MAX_ASSET_BYTES} bytes each.`);
                }

                bytes = Buffer.from(entry.content!, "utf8");
            }

            if (bytes.length > MAX_ASSET_BYTES) {
                throw new Error(`Assets are limited to ${MAX_ASSET_BYTES} bytes each.`);
            }

            preparedSize += bytes.length;

            if (preparedSize > MAX_ASSETS_BYTES) {
                throw new Error(`Bundle assets are limited to ${MAX_ASSETS_BYTES} bytes.`);
            }

            prepared.set(entry.name, {
                asset: {
                    hash: createHash("sha256").update(bytes).digest("hex"),
                    size: bytes.length,
                    type: assetType(entry.name),
                },
                bytes,
            });
        }

        if (type === "html" && content.includes("ds/")) {
            let cwd: string | undefined;

            try {
                cwd = (await api.agent(context)).cwd;
            } catch {
                // No session folder to look in: the page keeps its link.
            }

            notes = await attachDesignSystem(content, prepared, args.removeAssets ?? [], cwd);
            preparedSize = [...prepared.values()].reduce(
                (total, each) => total + each.bytes.length,
                0,
            );

            if (preparedSize > MAX_ASSETS_BYTES) {
                throw new Error(`Bundle assets are limited to ${MAX_ASSETS_BYTES} bytes.`);
            }
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

            const assets: Record<string, ArtifactAsset> = Object.fromEntries(
                Object.entries(current?.versions.at(-1)?.assets ?? {}),
            );

            for (const name of args.removeAssets ?? []) {
                delete assets[name];
            }

            for (const [name, value] of prepared) {
                Object.defineProperty(assets, name, {
                    value: value.asset,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }

            if (Object.keys(assets).length > MAX_ASSETS) {
                throw new Error(`One version keeps at most ${MAX_ASSETS} assets.`);
            }

            if (
                Object.values(assets).reduce((total, asset) => total + asset.size, 0) >
                MAX_ASSETS_BYTES
            ) {
                throw new Error(`Bundle assets are limited to ${MAX_ASSETS_BYTES} bytes.`);
            }

            for (const { asset, bytes } of prepared.values()) {
                await tx.doc(ArtifactAssetDoc, asset.hash, { base64: bytes.toString("base64") });
            }

            const next = (current?.versions.at(-1)?.version ?? 0) + 1;
            const record: ArtifactVersion = {
                version: next,
                taskId: api.taskId,
                callId: api.callId,
                size: Buffer.byteLength(content),
                createdAt: Date.now(),
                ...(inline ? { inline: true as const } : {}),
                ...(Object.keys(assets).length > 0 ? { assets } : {}),
            };

            if (current === undefined) {
                doc.items[id] = { title: args.title, type, versions: [record] };
            } else {
                current.title = args.title;
                current.type = type;
                current.versions.push(record);
            }

            const meta = doc.items[id]!;

            if (args.group !== undefined) {
                meta.group = args.group;
            }

            if (args.kind !== undefined) {
                meta.kind = args.kind;
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
                      }${notes.map((note) => ` ${note}`).join("")}`
                    : `Published "${args.title}" as artifact ${id}, version ${version}. The user opens it from the artifact card.${notes.map((note) => ` ${note}`).join("")}`,
            },
        ],
        details: inline
            ? { id, title: args.title, version, inline: true }
            : { id, title: args.title, version },
    };
}

const bundleParameters = {
    assets: Type.Optional(
        Type.Array(
            Type.Object({
                name: Type.String({
                    description:
                        "Relative path in the bundle, up to 200 characters, with no . or .. segment.",
                }),
                path: Type.Optional(
                    Type.String({ description: "A local file to copy (binary allowed)." }),
                ),
                content: Type.Optional(
                    Type.String({ description: "UTF-8 text, instead of path." }),
                ),
            }),
            {
                description:
                    "Files the page loads by relative URL (images, fonts, data, scripts, pages), added or replaced by name; earlier ones stay. Up to 5 MB each, 20 MB per version.",
            },
        ),
    ),
    removeAssets: Type.Optional(
        Type.Array(Type.String(), { description: "Bundle paths to drop." }),
    ),
    group: Type.Optional(
        Type.String({ description: "Group variations under one kebab-case slug." }),
    ),
    kind: Type.Optional(
        StringEnum(["page", "deck"] as const, { description: "page or deck (a slide deck)." }),
    ),
    id: Type.String({ description: "Stable kebab-case id; reuse it for a new version." }),
    title: Type.String({ description: "Short title." }),
    edits: Type.Optional(
        Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), {
            description: "Exact, unique replacements on the latest version.",
        }),
    ),
};

export default function createArtifacts(_host: PocketHost) {
    const artifact = defineTool({
        name: "artifact",
        description:
            "Publish an HTML page, Markdown document, or SVG image that the user opens in the app's artifact viewer. The same id publishes a new version. Give exactly one of content, edits, or path (up to 2,000,000 bytes).",
        parameters: Type.Object({
            ...bundleParameters,
            type: Type.Optional(
                StringEnum(["html", "markdown", "svg"] as const, {
                    description:
                        "Default: html, or from a new path's extension. A path cannot change an existing type.",
                }),
            ),
            content: Type.Optional(Type.String({ description: "The whole new version." })),
            path: Type.Optional(
                Type.String({
                    description:
                        "A local UTF-8 file to copy as this version (a snapshot, not a live link, without the files beside it): absolute, ~/…, or relative to the session folder.",
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
            "Show an HTML page as a card in your reply, where the person uses it right there (Preview/Code, Run/Stop, and a button for the viewer). It shares artifact's store: the same id adds a version, and each card keeps the version its call made. Give exactly one of content or edits.",
        parameters: Type.Object({
            ...bundleParameters,
            content: Type.Optional(
                Type.String({ description: "The whole HTML of the new version." }),
            ),
        }),
        replay: "safe",
        // Only its own fields: the model may send others, and a path or a type is the artifact tool's.
        execute: (args, api, context) =>
            publish(
                {
                    id: args.id,
                    title: args.title,
                    content: args.content,
                    edits: args.edits,
                    assets: args.assets,
                    removeAssets: args.removeAssets,
                    group: args.group,
                    kind: args.kind,
                },
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
