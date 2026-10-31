/**
 * Design: a canvas beside the chat for interactive designs. It shows an HTML artifact in a frame at phone, tablet, and
 * desktop sizes, keeps its versions to compare and go back to, holds shared comments pinned to elements, edit and tweak
 * modes, a grid for variations, and a present mode for decks, and hands each change to Pi as a message for the person to
 * send. The agent's side (tools, prompt guide, export) is in `../design/`; this module is the workspace.
 */
import { randomUUID } from "node:crypto";
import { defineExtension } from "@earendil-works/pi-durable";
import { designGuide, designRoutes, designTools } from "../design/index.ts";
import {
    type ArtifactMeta,
    ArtifactBodyDoc,
    ArtifactsDoc,
    type DesignComment,
    DesignCommentsDoc,
    type DesignItem,
} from "../docs.ts";
import type { ConversationWebRequest, ExtensionWeb, PocketHost } from "../host.ts";
import { systemRoutes } from "./design/system-routes.ts";

/** An artifact as the index keeps it, with the fields of bundles (`group`, `kind`) that an older index lacks. */
type DesignArtifact = ArtifactMeta & { group?: string; kind?: string };

const MAX_COMMENT = 2000;
const MAX_COMMENTS = 200;
const MAX_ACCEPTED = 500;
/** A finding's id: rule, ten hex digits, optional repeat count (`contrast-1a2b3c4d5e-2`). */
const FINDING_ID = /^[a-z][a-z-]{0,40}-[0-9a-f]{10}(?:-\d{1,3})?$/;
const MAX_ITEMS = 100;
const MAX_KNOBS = 40;
const MAX_PEOPLE = 50;
const MAX_TARGET = 4000;

/** Text on one line or more, with no control characters but line breaks and tabs, cut to `max`. */
function body(value: unknown, max: number): string {
    return String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\p{Bidi_Control}\u2028\u2029]|[^\P{Cc}\n\t]/gu, "")
        .trim()
        .slice(0, max);
}

const text = (value: unknown, max: number): string =>
    typeof value === "string" ? value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ").slice(0, max) : "";

/** A size or a place on the page: finite, within what a page can be, to a tenth. */
const number = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value)
        ? Math.round(Math.max(-1e7, Math.min(1e7, value)) * 10) / 10
        : 0;

/**
 * The element a comment points at, as the page's inspector described it (the page is untrusted data): a fixed shape,
 * every text cut, no field the app does not know. Throws a 400 for what is no element at all.
 */
export function cleanTarget(web: Pick<ExtensionWeb, "error">, value: unknown) {
    const target = value as Record<string, unknown> | null;

    if (typeof target !== "object" || target === null || Array.isArray(target)) {
        throw web.error(400, "A comment points at an element.");
    }

    const selector = text(target.selector, 500).trim();

    if (selector === "") {
        throw web.error(400, "A comment points at an element.");
    }

    const rect = (
        typeof target.rect === "object" && target.rect !== null ? target.rect : {}
    ) as Record<string, unknown>;
    const styles: Record<string, string> = {};

    if (typeof target.styles === "object" && target.styles !== null) {
        for (const [name, style] of Object.entries(target.styles).slice(0, 12)) {
            if (/^[a-z-]{1,40}$/.test(name) && typeof style === "string") {
                styles[name] = text(style, 200);
            }
        }
    }

    const clean = {
        ...(typeof target.pid === "string" && target.pid !== ""
            ? { pid: text(target.pid, 100) }
            : {}),
        selector,
        tag: text(target.tag, 40).toLowerCase(),
        text: text(target.text, 200),
        html: text(target.html, 1000),
        rect: {
            x: number(rect.x),
            y: number(rect.y),
            width: number(rect.width),
            height: number(rect.height),
        },
        styles,
    };

    if (JSON.stringify(clean).length > MAX_TARGET) {
        throw web.error(400, "That element is too large to point at.");
    }

    return clean;
}

/**
 * Tweak values as kept: at most `MAX_KNOBS`, a name that is a CSS custom property or a plain word (any other name is
 * left out), a short value.
 */
export function cleanTweaks(web: Pick<ExtensionWeb, "error">, value: unknown) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw web.error(400, "Tweaks are a set of names and values.");
    }

    const entries = Object.entries(value);

    if (entries.length > MAX_KNOBS) {
        throw web.error(400, `A design has up to ${MAX_KNOBS} tweaks.`);
    }

    const values: Record<string, string | number | boolean> = {};

    for (const [name, each] of entries) {
        if (!/^(?:--)?[A-Za-z][\w.-]{0,99}$/.test(name) && !/^--[\w.-]{1,98}$/.test(name)) {
            // A name the server does not keep (a page may name an event "dark mode") is left out, not the whole set.
            continue;
        }

        if (typeof each === "string") {
            values[name] = text(each, 500);
        } else if (
            typeof each === "boolean" ||
            (typeof each === "number" && Number.isFinite(each))
        ) {
            values[name] = each;
        } else {
            throw web.error(400, "A tweak is text, a number, or on and off.");
        }
    }

    return values;
}

export default async function createDesign(host: PocketHost, web?: ExtensionWeb) {
    const extension = defineExtension({
        name: "pocket-design",
        tools: designTools(host),
        sections: [designGuide(host)],
    });

    if (web === undefined) {
        return extension;
    }

    // Everyone who sees every session sees the canvas, the versions, and the comments; steering is checked per route.
    web.client("design", { access: "view" });

    /** The artifacts a design can show: HTML pages, newest version last, with their group and kind. */
    const artifacts = async (request: ConversationWebRequest) => {
        const index = await request.snapshot(
            ArtifactsDoc,
            request.conversation.id,
            request.context,
        );
        const notes = await request.snapshot(
            DesignCommentsDoc,
            request.conversation.id,
            request.context,
        );

        return Object.entries(index?.items ?? {})
            .filter(([, meta]) => meta.type === "html")
            .map(([id, meta]) => {
                const design = meta as DesignArtifact;
                const restores = notes?.items[id]?.restores ?? {};

                return {
                    id,
                    title: meta.title,
                    ...(typeof design.group === "string" ? { group: design.group } : {}),
                    kind: design.kind === "deck" ? "deck" : "page",
                    versions: meta.versions.map((version) => ({
                        version: version.version,
                        size: version.size,
                        createdAt: version.createdAt,
                        ...(restores[String(version.version)] === undefined
                            ? {}
                            : { restoredFrom: restores[String(version.version)] }),
                    })),
                };
            });
    };

    /** The artifact must be one of the session's own HTML pages: an id names no other session's, nor `__proto__`. */
    const requireArtifact = async (request: ConversationWebRequest, id: string) => {
        const index = await request.snapshot(
            ArtifactsDoc,
            request.conversation.id,
            request.context,
        );

        if (
            index === undefined ||
            !Object.hasOwn(index.items, id) ||
            index.items[id]!.type !== "html"
        ) {
            throw web.error(404, "No such design.");
        }

        return index.items[id]!;
    };

    /**
     * The item for a design, made if it is not there yet. The document tracks what is assigned and what is changed through
     * it, not what is changed through the object that was assigned: so it is read back after it is made.
     */
    const itemOf = (doc: { items: Record<string, DesignItem> }, id: string): DesignItem => {
        if (!Object.hasOwn(doc.items, id)) {
            if (Object.keys(doc.items).length >= MAX_ITEMS) {
                throw web.error(409, `This session keeps notes on up to ${MAX_ITEMS} designs.`);
            }

            doc.items[id] = { comments: [] };
        }

        return doc.items[id]!;
    };

    /** An item with no comments, tweaks, restores, or accepted findings keeps nothing: it goes, and its place with it. */
    const dropIfEmpty = (doc: { items: Record<string, DesignItem> }, id: string) => {
        const item = doc.items[id];

        if (
            item !== undefined &&
            item.comments.length === 0 &&
            Object.keys(item.tweaks ?? {}).length === 0 &&
            Object.keys(item.restores ?? {}).length === 0 &&
            Object.keys(item.accepted ?? {}).length === 0
        ) {
            delete doc.items[id];
        }
    };

    /** The comments and the accepted findings are everyone's; one person's tweaks are theirs alone. */
    const view = (item: DesignItem | undefined, person: string) => ({
        comments: item?.comments ?? [],
        tweaks: item?.tweaks?.[person]?.values ?? null,
        accepted: item?.accepted ?? {},
    });

    const changed = (conversation: number, artifact: string) =>
        web.send("comments", { conversation, artifact });

    const options = { conversation: "conversation", access: "view" } as const;
    const steer = { conversation: "conversation", access: "steer" } as const;

    // The session's designs, for the picker.
    web.conversationRoute(
        "GET",
        "c/:conversation/artifacts",
        async (request) => ({ artifacts: await artifacts(request) }),
        options,
    );

    // One design's comments (all of them) and this person's tweaks.
    web.conversationRoute(
        "GET",
        "c/:conversation/designs/:artifact",
        async (request) => {
            const id = request.params.artifact!;

            await requireArtifact(request, id);

            const doc = await request.snapshot(
                DesignCommentsDoc,
                request.conversation.id,
                request.context,
            );

            return view(
                Object.hasOwn(doc?.items ?? {}, id) ? doc!.items[id] : undefined,
                request.user.id,
            );
        },
        options,
    );

    web.conversationRoute(
        "POST",
        "c/:conversation/designs/:artifact/comments",
        async (request) => {
            const id = request.params.artifact!;
            const meta = await requireArtifact(request, id);
            const version = request.body.version;
            const words = body(request.body.text, MAX_COMMENT);

            if (
                typeof version !== "number" ||
                !meta.versions.some((each) => each.version === version)
            ) {
                throw web.error(400, "That version is not there.");
            }

            if (words === "") {
                throw web.error(400, "Write what to change.");
            }

            const target = cleanTarget(web, request.body.target);
            const comment: DesignComment = {
                id: randomUUID().slice(0, 8),
                version,
                target,
                text: words,
                by: request.user.id,
                byName: text(request.user.name, 80),
                at: Date.now(),
            };

            await request.commit(async (tx) => {
                const doc = await tx.doc(DesignCommentsDoc, request.conversation.id);

                const item = itemOf(doc, id);

                if (item.comments.length >= MAX_COMMENTS) {
                    throw web.error(
                        409,
                        `A design has up to ${MAX_COMMENTS} comments: delete some.`,
                    );
                }

                item.comments.push(comment);
            });
            changed(request.conversation.id, id);

            return { comment };
        },
        steer,
    );

    // Edit a comment's words or mark it done (or open again). Anyone who steers may resolve; the words are the author's.
    web.conversationRoute(
        "POST",
        "c/:conversation/designs/:artifact/comments/:comment",
        async (request) => {
            const id = request.params.artifact!;
            const { resolved } = request.body;
            const words =
                request.body.text === undefined ? undefined : body(request.body.text, MAX_COMMENT);

            if (resolved !== undefined && typeof resolved !== "boolean") {
                throw web.error(400, "Resolved is true or false.");
            }

            if (words === "") {
                throw web.error(400, "Write what to change.");
            }

            const comment = await request.commit(async (tx) => {
                const doc = await tx.doc(DesignCommentsDoc, request.conversation.id);
                const found = Object.hasOwn(doc.items, id)
                    ? doc.items[id]!.comments.find((each) => each.id === request.params.comment)
                    : undefined;

                if (found === undefined) {
                    throw web.error(404, "No such comment.");
                }

                if (words !== undefined && words !== found.text) {
                    if (found.by !== request.user.id && request.user.role !== "owner") {
                        throw web.error(403, "Only its author changes a comment's words.");
                    }

                    found.text = words;
                }

                if (resolved === true && found.resolved === undefined) {
                    found.resolved = { by: request.user.id, at: Date.now() };
                } else if (resolved === false && found.resolved !== undefined) {
                    delete found.resolved;
                }

                // The document hands out tracked objects, which cannot be cloned: a plain copy of what the answer needs.
                return JSON.parse(JSON.stringify(found)) as DesignComment;
            });

            changed(request.conversation.id, id);

            return { comment };
        },
        steer,
    );

    web.conversationRoute(
        "DELETE",
        "c/:conversation/designs/:artifact/comments/:comment",
        async (request) => {
            const id = request.params.artifact!;

            await request.commit(async (tx) => {
                const doc = await tx.doc(DesignCommentsDoc, request.conversation.id);
                const item = Object.hasOwn(doc.items, id) ? doc.items[id]! : undefined;
                const at =
                    item?.comments.findIndex((each) => each.id === request.params.comment) ?? -1;

                if (item === undefined || at === -1) {
                    throw web.error(404, "No such comment.");
                }

                if (item.comments[at]!.by !== request.user.id && request.user.role !== "owner") {
                    throw web.error(403, "Only its author deletes a comment.");
                }

                item.comments.splice(at, 1);
                dropIfEmpty(doc, id);
            });
            changed(request.conversation.id, id);

            return {};
        },
        steer,
    );

    web.conversationRoute(
        "POST",
        "c/:conversation/designs/:artifact/accepted",
        async (request) => {
            const id = request.params.artifact!;

            await requireArtifact(request, id);

            const finding = request.body.id;

            if (typeof finding !== "string" || !FINDING_ID.test(finding)) {
                throw web.error(400, "Name the finding by its id.");
            }

            const entry = {
                by: request.user.id,
                byName: text(request.user.name, 80),
                at: Date.now(),
                rule: text(request.body.rule, 40),
                message: text(request.body.message, 300),
            };

            await request.commit(async (tx) => {
                const doc = await tx.doc(DesignCommentsDoc, request.conversation.id);
                const item = itemOf(doc, id);
                const accepted = item.accepted ?? {};

                if (!Object.hasOwn(accepted, finding)) {
                    if (Object.keys(accepted).length >= MAX_ACCEPTED) {
                        throw web.error(
                            409,
                            `A design keeps up to ${MAX_ACCEPTED} accepted findings: undo some.`,
                        );
                    }

                    item.accepted = { ...accepted, [finding]: entry };
                }
            });
            changed(request.conversation.id, id);

            return { id: finding };
        },
        steer,
    );

    web.conversationRoute(
        "DELETE",
        "c/:conversation/designs/:artifact/accepted/:finding",
        async (request) => {
            const id = request.params.artifact!;
            const finding = request.params.finding!;

            await request.commit(async (tx) => {
                const doc = await tx.doc(DesignCommentsDoc, request.conversation.id);
                const item = Object.hasOwn(doc.items, id) ? doc.items[id]! : undefined;

                if (item?.accepted !== undefined && Object.hasOwn(item.accepted, finding)) {
                    const { [finding]: _gone, ...rest } = item.accepted;

                    item.accepted = rest;
                    dropIfEmpty(doc, id);
                }
            });
            changed(request.conversation.id, id);

            return { id: finding };
        },
        steer,
    );

    // Resolve every open comment of a design at once, for after "Send to Pi".
    web.conversationRoute(
        "POST",
        "c/:conversation/designs/:artifact/resolve",
        async (request) => {
            const id = request.params.artifact!;
            const ids = request.body.ids;

            if (
                !Array.isArray(ids) ||
                ids.length > MAX_COMMENTS ||
                !ids.every((each) => typeof each === "string")
            ) {
                throw web.error(400, "Choose the comments to resolve.");
            }

            const count = await request.commit(async (tx) => {
                const doc = await tx.doc(DesignCommentsDoc, request.conversation.id);
                const item = Object.hasOwn(doc.items, id) ? doc.items[id]! : undefined;
                let done = 0;

                for (const comment of item?.comments ?? []) {
                    if ((ids as string[]).includes(comment.id) && comment.resolved === undefined) {
                        comment.resolved = { by: request.user.id, at: Date.now() };
                        done += 1;
                    }
                }

                return done;
            });

            changed(request.conversation.id, id);

            return { resolved: count };
        },
        steer,
    );

    // This person's tweak values for the design: replaced as a whole, or cleared with null.
    web.conversationRoute(
        "POST",
        "c/:conversation/designs/:artifact/tweaks",
        async (request) => {
            const id = request.params.artifact!;

            await requireArtifact(request, id);

            const values =
                request.body.values === null ? null : cleanTweaks(web, request.body.values);

            await request.commit(async (tx) => {
                const doc = await tx.doc(DesignCommentsDoc, request.conversation.id);

                const clearing = values === null || Object.keys(values).length === 0;

                // Nothing to clear, and no item to make for it: an empty item would keep a place for nothing.
                if (clearing && !Object.hasOwn(doc.items, id)) {
                    return;
                }

                const item = itemOf(doc, id);

                if (values === null || clearing) {
                    if (item.tweaks !== undefined) {
                        delete item.tweaks[request.user.id];
                    }

                    dropIfEmpty(doc, id);

                    return;
                }

                item.tweaks ??= {};

                if (
                    item.tweaks[request.user.id] === undefined &&
                    Object.keys(item.tweaks).length >= MAX_PEOPLE
                ) {
                    throw web.error(409, "Too many people keep tweaks for this design.");
                }

                item.tweaks[request.user.id] = { values, at: Date.now() };
            });

            return {};
        },
        steer,
    );

    // "Go back to this one": a new version that is a copy of an older one (its assets too), written in one commit. The
    // key makes a repeat of the same tap find the version it made.
    web.conversationRoute(
        "POST",
        "c/:conversation/designs/:artifact/restore",
        async (request) => {
            const id = request.params.artifact!;
            const from = request.body.version;
            const key = request.body.key;

            if (typeof from !== "number" || !Number.isSafeInteger(from)) {
                throw web.error(400, "Choose the version to go back to.");
            }

            if (typeof key !== "string" || !/^[\w-]{8,64}$/.test(key)) {
                throw web.error(400, "A restore needs a key.");
            }

            const meta = await requireArtifact(request, id);

            if (!meta.versions.some((each) => each.version === from)) {
                throw web.error(404, "That version is not there.");
            }

            const source = await request.snapshot(
                ArtifactBodyDoc,
                request.conversation.id,
                `${id}@${from}`,
                request.context,
            );

            if (source === undefined) {
                throw web.error(404, "That version has no content.");
            }

            const callId = `design-restore:${key}`;

            const made = await request.commit(async (tx) => {
                const doc = await tx.doc(ArtifactsDoc, request.conversation.id);
                const current = Object.hasOwn(doc.items, id) ? doc.items[id] : undefined;

                if (current === undefined || current.type !== "html") {
                    throw web.error(404, "No such design.");
                }

                const again = current.versions.find((each) => each.callId === callId);

                if (again !== undefined) {
                    return again.version;
                }

                const original = current.versions.find((each) => each.version === from);

                if (original === undefined) {
                    throw web.error(404, "That version is not there.");
                }

                if (current.versions.at(-1)!.version === from) {
                    throw web.error(409, "That is already the newest version.");
                }

                const next = current.versions.at(-1)!.version + 1;
                const { inline: _inline, ...copy } = original;

                // The task is the original's, so the record stays valid; the call id is new, so no real call matches it.
                current.versions.push({ ...copy, version: next, callId, createdAt: Date.now() });

                const stored = await tx.doc(
                    ArtifactBodyDoc,
                    request.conversation.id,
                    `${id}@${next}`,
                    {
                        content: source.content,
                    },
                );

                if (stored.content !== source.content) {
                    stored.content = source.content;
                }

                const notes = await tx.doc(DesignCommentsDoc, request.conversation.id);
                const item = itemOf(notes, id);

                item.restores = { ...item.restores, [String(next)]: from };

                return next;
            });

            return { version: made };
        },
        steer,
    );

    // `/design-open [artifact]`: opens the workspace in the tab of the person who ran it. A command's name needs a dash,
    // so it is not `/design`.
    web.command("design-open", {
        description: "Open the Design canvas (or the design system, with `system`)",
        args: "[artifact | system]",
        scope: "conversation",
        handler: (args, context) => {
            web.send(
                "open",
                { conversation: context.conversationId, artifact: args.trim().slice(0, 100) },
                { to: context.user.id },
            );

            return { type: "toast", level: "info", message: "Opening Design" };
        },
    });

    // Export (`POST export`) is the agent side's; the file comes through core's download route.
    designRoutes(web, host);
    systemRoutes(web, host);

    return extension;
}
