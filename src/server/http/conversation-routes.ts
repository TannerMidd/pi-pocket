/** `/api/c/:id`: one conversation's routes, for people the API has checked may see it. */
import { randomUUID } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ConversationId } from "@earendil-works/pi-durable";
import { readState, writeState } from "../artifact-state.ts";
import type { Attachment, SubmitRequest } from "../commands.ts";
import { HttpError } from "../errors.ts";
import type { CommandRequest } from "../extension-commands.ts";
import { reveal } from "../reveal.ts";
import { serveImage, TYPES } from "./assets.ts";
import { type ApiRequest, json, readJson, send } from "./io.ts";

const MAX_UPLOAD = 50 * 1024 * 1024;

const ENTRY_IMAGE_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
]);

function safeName(name: string): string {
    const base = basename(name)
        .replace(/[^\w.\- ()]+/g, "_")
        .trim();

    return base === "" || base.startsWith(".") ? `upload${base}` : base.slice(0, 120);
}

export async function conversationRoutes(
    api: ApiRequest,
    id: ConversationId,
    parts: string[],
): Promise<void> {
    const { app, request, response, url, user } = api;
    const method = request.method ?? "GET";
    const [, , third, fourth] = parts;

    if (third === "submit" && method === "POST") {
        const body = await readJson<SubmitRequest>(request);

        if (typeof body.text !== "string" || typeof body.requestId !== "string") {
            throw new HttpError(400, "text and requestId are required");
        }

        if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
            throw new HttpError(400, "attachments must be a list");
        }

        const attachments = (body.attachments ?? []).filter((file): file is Attachment => {
            // Only files this server stored for this conversation.
            return (
                typeof file?.path === "string" &&
                resolve(file.path).startsWith(app.workspace.uploadDirectory(id) + sep)
            );
        });

        return json(response, 200, await app.commands.submit(id, user, { ...body, attachments }));
    }

    if (third === "extension-commands" && fourth === undefined && method === "POST") {
        const body = await readJson<CommandRequest>(request);
        const gone = new AbortController();

        // The browser stopped waiting: so does this request. The run goes on, and a retry finds it.
        response.on("close", () => gone.abort());

        return json(response, 200, await app.extensionCommands.run(id, user, body, gone.signal));
    }

    if (third === "extension-commands" && parts[4] === "stop" && method === "POST") {
        await app.extensionCommands.stop(id, user, Number(fourth));

        return json(response, 200, { ok: true });
    }

    if (third === "chat" && method === "POST") {
        const body = await readJson<{
            text?: unknown;
            requestId?: unknown;
            quote?: { entryId?: unknown };
        }>(request);

        if (typeof body.text !== "string" || typeof body.requestId !== "string") {
            throw new HttpError(400, "text and requestId are required");
        }

        const quote =
            typeof body.quote === "object" && body.quote !== null
                ? { entryId: body.quote.entryId }
                : undefined;

        return json(
            response,
            200,
            await app.collab.postChat(id, user, {
                text: body.text,
                requestId: body.requestId,
                ...(quote === undefined ? {} : { quote }),
            }),
        );
    }

    if (third === "react" && method === "POST") {
        const body = await readJson<{ entryId?: unknown; emoji?: unknown }>(request);

        await app.collab.react(id, user, Number(body.entryId), String(body.emoji ?? ""));

        return json(response, 200, { ok: true });
    }

    if (third === "pin" && method === "POST") {
        return json(response, 200, await app.collab.pin(id, user, await readJson(request)));
    }

    if (third === "notes" && method === "POST") {
        const body = await readJson<{ text?: unknown; rev?: unknown }>(request);

        if (typeof body.text !== "string" || typeof body.rev !== "number") {
            throw new HttpError(400, "text and rev are required");
        }

        return json(response, 200, await app.collab.saveNotes(id, user, body.text, body.rev));
    }

    if (third === "turns" && method === "POST") {
        await app.collab.turns(id, user, await readJson(request));

        return json(response, 200, { ok: true });
    }

    if (third === "typing" && method === "POST") {
        const body = await readJson<{ where?: unknown }>(request);

        app.collab.setTyping(id, user, body.where);

        return json(response, 200, { ok: true });
    }

    if (third === "abort" && method === "POST") {
        await app.commands.abort(id, user);

        return json(response, 200, { ok: true });
    }

    // A failed subagent dealt with: `at` says which failure the person saw.
    if (third === "dismiss" && method === "POST") {
        const body = await readJson<{ at?: unknown }>(request);

        return json(response, 200, await app.commands.dismissSubagent(id, user, body.at));
    }

    if (third === "withdraw" && method === "POST") {
        const body = await readJson<{ submissionId?: number }>(request);

        return json(response, 200, {
            result: await app.commands.withdraw(id, user, Number(body.submissionId)),
        });
    }

    if (third === "move" && method === "POST") {
        const body = await readJson<{ submissionId?: number; mode?: string }>(request);

        await app.commands.moveQueued(id, user, Number(body.submissionId), String(body.mode));

        return json(response, 200, { ok: true });
    }

    if (third === "configure" && method === "POST") {
        await app.commands.configure(id, user, await readJson(request));

        return json(response, 200, { ok: true });
    }

    if (third === "reset" && method === "POST") {
        const body = await readJson<{ note?: unknown }>(request);

        await app.commands.reset(id, user, body.note);

        return json(response, 200, { ok: true });
    }

    if (third === "instructions" && method === "POST") {
        const body = await readJson<{ text?: unknown }>(request);

        await app.commands.setInstructions(id, user, body.text);

        return json(response, 200, { ok: true });
    }

    if (third === "plan" && method === "POST") {
        const body = await readJson<{ on?: unknown; approve?: unknown }>(request);

        if (body.approve === true) {
            return json(response, 200, await app.commands.approvePlan(id, user));
        }

        await app.commands.setPlan(id, user, body.on);

        return json(response, 200, { ok: true });
    }

    if (third === "schedules" && fourth === undefined && method === "POST") {
        return json(response, 200, await app.commands.schedule(id, user, await readJson(request)));
    }

    if (
        third === "schedules" &&
        fourth !== undefined &&
        parts[4] === "cancel" &&
        method === "POST"
    ) {
        await app.commands.cancelSchedule(id, user, fourth);

        return json(response, 200, { ok: true });
    }

    if (third === "watch" && method === "POST") {
        const body = await readJson<{ pr?: unknown; stop?: unknown }>(request);

        if (body.stop === true) {
            await app.commands.unwatchPr(id, user);

            return json(response, 200, { ok: true });
        }

        return json(response, 200, await app.commands.watchPr(id, user, body.pr));
    }

    // Memory normally applies here. The owner's pending queue reviews all projects, but never adds or edits: `Memory`
    // checks who may use it, and what it may do with a lesson.
    const pendingMemory = third === "memory" && url.searchParams.get("pending") === "all";

    if (third === "memory" && fourth === undefined) {
        if (method === "GET") {
            return json(response, 200, await app.memory.view(id, user, pendingMemory));
        }

        if (method === "POST") {
            // Saving takes no queue: it would save a lesson as usual.
            if (pendingMemory) {
                throw new HttpError(400, "The pending queue only approves or discards lessons.");
            }

            return json(
                response,
                200,
                await app.memory.remember(id, user, await readJson(request)),
            );
        }
    }

    if (third === "memory" && fourth !== undefined && method === "POST") {
        const action = parts[4];
        const change =
            action === "remove" || action === "approve" || action === "discard"
                ? action
                : action === undefined
                  ? { text: (await readJson<{ text?: unknown }>(request)).text }
                  : undefined;

        // An approval says what the person saw: it holds only if that is still what waits.
        if (change === "approve") {
            const seen = await readJson<{ text?: unknown; forget?: unknown }>(request);

            return json(
                response,
                200,
                await app.memory.edit(
                    id,
                    user,
                    fourth,
                    change,
                    {
                        text: typeof seen.text === "string" ? seen.text : undefined,
                        forget: seen.forget === true,
                    },
                    pendingMemory,
                ),
            );
        }

        if (change !== undefined) {
            return json(
                response,
                200,
                await app.memory.edit(id, user, fourth, change, undefined, pendingMemory),
            );
        }
    }

    if (third === "goal" && method === "POST") {
        const body = await readJson<{ command?: unknown; clear?: unknown }>(request);

        if (body.clear === true) {
            await app.commands.clearGoal(id, user);
        } else {
            await app.commands.setGoal(id, user, body.command);
        }

        return json(response, 200, { ok: true });
    }

    if (third === "worktree" && method === "POST") {
        const body = await readJson<{ remove?: unknown; force?: unknown }>(request);

        if (body.remove !== true) {
            throw new HttpError(400, "Only removing a worktree is asked for here");
        }

        await app.commands.removeWorktree(id, user, body.force);

        return json(response, 200, { ok: true });
    }

    // Whether Pi trusts the session's project, which its own skills wait for; only the owner answers.
    if (third === "trust" && method === "GET") {
        return json(response, 200, app.projectTrust(id, user));
    }

    if (third === "trust" && method === "POST") {
        const body = await readJson<{ choice?: unknown }>(request);

        if (
            body.choice !== "trust" &&
            body.choice !== "trust-parent" &&
            body.choice !== "distrust"
        ) {
            throw new HttpError(400, "choice must be trust, trust-parent, or distrust");
        }

        return json(response, 200, app.setProjectTrust(id, user, body.choice));
    }

    if (third === "fork" && method === "POST") {
        return json(response, 200, await app.commands.fork(id, user, await readJson(request)));
    }

    if (third === "resend" && method === "POST") {
        return json(response, 200, await app.commands.resend(id, user, await readJson(request)));
    }

    if (third === "compact" && method === "POST") {
        const body = await readJson<{ instructions?: unknown }>(request);

        if (
            body.instructions !== undefined &&
            body.instructions !== null &&
            typeof body.instructions !== "string"
        ) {
            throw new HttpError(400, "instructions must be text");
        }

        await app.commands.compact(
            id,
            user,
            (body.instructions as string | null | undefined)?.trim() || undefined,
        );

        return json(response, 200, { ok: true });
    }

    if (third === "image" && fourth !== undefined && method === "GET") {
        const image = await app.transcripts.entryImage(id, Number(fourth), Number(parts[4] ?? 0));

        if (image === undefined || !ENTRY_IMAGE_TYPES.has(image.mimeType)) {
            throw new HttpError(404, "No such image");
        }

        // Stored entries never change.
        return send(response, 200, image.data, image.mimeType, {
            "cache-control": "private, max-age=31536000, immutable",
        });
    }

    // Show a path in the file manager of the machine the server runs on: the owner's, at that machine (`reveal.ts`).
    if (third === "reveal" && method === "POST") {
        app.requireSee(user, id);

        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner opens the server's file manager");
        }

        const body = await readJson<{ path?: unknown }>(request);

        if (typeof body.path !== "string" || body.path.trim() === "") {
            throw new HttpError(400, "path is required");
        }

        await reveal(app.workspace.conversationPath(id, body.path));

        return json(response, 200, { ok: true });
    }

    if (third === "file" && method === "GET") {
        const requested = url.searchParams.get("path") ?? "";

        if (requested.trim() === "") {
            throw new HttpError(400, "path is required");
        }

        return serveImage(request, response, app.workspace.conversationFile(user, id, requested));
    }

    if (third === "entry" && fourth !== undefined && method === "GET") {
        const entry = await app.transcripts.fullEntry(id, Number(fourth));

        if (entry === undefined) {
            throw new HttpError(404, "No such entry");
        }

        return json(response, 200, entry);
    }

    if (third === "export" && method === "GET") {
        const { filename, markdown } = await app.transcripts.exportMarkdown(id, user);

        return send(response, 200, markdown, "text/markdown; charset=utf-8", {
            "content-disposition": `attachment; filename="${filename}"`,
        });
    }

    if (third === "changes" && fourth === undefined && method === "GET") {
        return json(response, 200, await app.workspace.changes(id, user));
    }

    if (third === "changes" && fourth === "diff" && method === "GET") {
        return send(
            response,
            200,
            await app.workspace.changeDiff(id, user, url.searchParams.get("path") ?? ""),
            "text/plain; charset=utf-8",
        );
    }

    // What an artifact's page saved for this person (`artifact-state.ts`): anyone who sees the session keeps their own.
    if (third === "artifact-state" && fourth !== undefined && parts.length === 4) {
        if (method === "GET") {
            return json(
                response,
                200,
                await readState(app, id, user, fourth, url.searchParams.get("schema")),
            );
        }

        if (method === "POST") {
            return json(
                response,
                200,
                await writeState(app, id, user, fourth, await readJson(request)),
            );
        }
    }

    // An artifact published to anyone with its address: the shares of this session, and ending one.
    if (third === "shares" && fourth === undefined && method === "GET") {
        // The address others reach this server by, as webhooks give it: a tunnel's, when one is up.
        return json(response, 200, {
            shares: await app.shares.list(id, user),
            base: app.access?.url ?? null,
        });
    }

    if (third === "shares" && fourth === undefined && method === "POST") {
        return json(response, 200, await app.shares.create(id, user, await readJson(request)));
    }

    if (third === "shares" && fourth !== undefined && method === "POST") {
        await app.shares.revoke(user, id, fourth);

        return json(response, 200, { ok: true });
    }

    // The folder's files for `@` mentions. A browser that has the newest list says so with `since` and gets only
    // that; a whole list goes compressed when the browser takes it so.
    if (third === "files" && method === "GET") {
        const listing = await app.workspace.fileList(id, user);

        if (url.searchParams.get("since") === listing.version) {
            return json(response, 200, { version: listing.version, same: true });
        }

        if (!/\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""))) {
            return send(response, 200, listing.json, "application/json");
        }

        return send(response, 200, await listing.gzipped(), "application/json", {
            "content-encoding": "gzip",
            vary: "accept-encoding",
        });
    }

    // Prompt templates and skills, for the message box's slash commands.
    if (third === "prompts" && method === "GET") {
        const templates = app.promptTemplates(id).map(({ name, description, argumentHint }) => ({
            name,
            description,
            ...(argumentHint === undefined ? {} : { argumentHint }),
        }));
        const skills = app.skillCommands(id).map(({ name, description }) => ({
            name: `skill:${name}`,
            description,
            argumentHint: "[what to do]",
            skill: true,
        }));

        return json(response, 200, [...templates, ...skills]);
    }

    if (third === "view" && method === "GET") {
        const requested = url.searchParams.get("path") ?? "";

        if (requested.trim() === "") {
            throw new HttpError(400, "path is required");
        }

        return json(response, 200, await app.workspace.viewFile(id, user, requested));
    }

    if (third === "changes" && fourth === "revert" && method === "POST") {
        const body = await readJson<{ path?: unknown }>(request);

        if (typeof body.path !== "string" || body.path === "") {
            throw new HttpError(400, "path is required");
        }

        await app.workspace.revertChange(id, user, body.path);

        return json(response, 200, { ok: true });
    }

    if (third === "branches" && fourth === undefined && method === "GET") {
        return json(response, 200, await app.workspace.branches(id, user));
    }

    if (third === "branch" && fourth === undefined && method === "POST") {
        return json(
            response,
            200,
            await app.workspace.switchBranch(id, user, (await readJson(request)) ?? {}),
        );
    }

    if (third === "shell" && fourth === undefined && method === "POST") {
        return json(response, 200, await app.shell.start(id, user, await readJson(request)));
    }

    if (third === "shell" && fourth !== undefined && parts[4] === "stop" && method === "POST") {
        await app.shell.stop(id, user, Number(fourth));

        return json(response, 200, { ok: true });
    }

    if (third === "history" && method === "GET") {
        return json(
            response,
            200,
            await app.transcripts.history(
                id,
                Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER),
            ),
        );
    }

    // Earlier entries of the active context, for a tab that got only the newest with its view (protocol 4).
    if (third === "context" && method === "GET") {
        const number = (name: string) => {
            const value = url.searchParams.get(name);

            return value === null ? undefined : Number(value);
        };

        const before = number("before");
        const rows = number("rows");
        const from = number("from");

        if (
            before === undefined ||
            ![before, rows ?? 1, from ?? 1].every(
                (value) => Number.isSafeInteger(value) && value > 0,
            )
        ) {
            throw new HttpError(
                400,
                "before (an entry id), and rows or from, if given, must be positive whole numbers",
            );
        }

        const room = await app.room(id);

        try {
            return json(response, 200, room.entriesBefore(before, { rows, from }));
        } finally {
            app.releaseRoom(room);
        }
    }

    // The people's messages, a page at a time, for extensions' outlines (`pocket.messages`).
    if (third === "messages" && method === "GET") {
        const before = url.searchParams.get("before");
        const limit = Number(url.searchParams.get("limit") ?? 50);

        if (
            (before !== null && !(Number.isSafeInteger(Number(before)) && Number(before) > 0)) ||
            !(Number.isSafeInteger(limit) && limit > 0 && limit <= 200)
        ) {
            throw new HttpError(
                400,
                "before is an entry id, and limit a whole number from 1 to 200, if given",
            );
        }

        const room = await app.room(id);

        try {
            const page = room.userMessages(before === null ? undefined : Number(before), limit);

            if (page === null) {
                throw new HttpError(409, "That page is gone: the session's context changed.");
            }

            return json(response, 200, page);
        } finally {
            app.releaseRoom(room);
        }
    }

    if (third === "upload" && method === "POST") {
        app.requireSteer(user);

        if (Number(request.headers["content-length"] ?? 0) > MAX_UPLOAD) {
            throw new HttpError(413, "Files can be up to 50 MB");
        }

        await app.conversation(id);
        const name = safeName(url.searchParams.get("name") ?? "upload");
        const directory = app.workspace.uploadDirectory(id);
        // Unique, and never written over: pasted images all arrive as image.png, often at once.
        const file = join(
            directory,
            `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${name}`,
        );
        let size = 0;

        request.on("data", (chunk: Buffer) => {
            size += chunk.length;

            if (size > MAX_UPLOAD) {
                request.destroy(new HttpError(413, "Files can be up to 50 MB"));
            }
        });

        try {
            await pipeline(request, createWriteStream(file, { mode: 0o600, flags: "wx" }));
        } catch (error) {
            // A cut-off or oversized upload leaves nothing behind (and a name already taken was never this upload's).
            // Cut off is the client's doing, not a server error.
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                rmSync(file, { force: true });
            }

            if (error instanceof HttpError || request.complete) {
                throw error;
            }

            throw new HttpError(400, "The upload stopped before it finished");
        }

        const mime =
            String(request.headers["content-type"] ?? "") ||
            TYPES[extname(name).toLowerCase()] ||
            "application/octet-stream";
        const attachment: Attachment = {
            path: file,
            name,
            mime: mime.split(";")[0]!.trim(),
            size,
        };

        return json(response, 200, attachment);
    }

    throw new HttpError(404, "Unknown API route");
}
