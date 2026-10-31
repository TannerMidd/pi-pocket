/**
 * What people ask of Pi: start and rename sessions, send messages (steer or queue), stop, withdraw, and change the
 * model, thinking level, or folder of a conversation; compact or reset its context and set its instructions; fork it,
 * or send a message again; set plan mode, a goal, or scheduled messages; and remove a session's worktree. Every
 * command checks who may do it, and changes others should know about become activity lines in the session's chat.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { type Context, copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    clampThinkingLevel,
    type ImageContent,
    type ModelThinkingLevel,
    type TextContent,
} from "@earendil-works/pi-ai";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import {
    type AgentChange,
    AgentDoc,
    type ConversationCreateOptions,
    type ConversationId,
    type Cursor,
    defineTask,
    type EntryId,
    type InputEntry,
    InboxDoc,
    LiveDoc,
    type ModelRef,
    type SettledSubmissionRecord,
    type SubmissionId,
    type Task,
    type TaskId,
    type TaskRuntime,
    type UserInput,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import {
    AuthorsDoc,
    ChatDoc,
    NotesDoc,
    PinsDoc,
    PlanDoc,
    type Schedule,
    SessionsDoc,
    STOPPED,
    type SubagentRecord,
    SubagentsDoc,
} from "./docs.ts";
import {
    ATTACHMENTS_HEADING,
    FILE_BLOCK,
    FROM_PREFIX,
    NOTE_ENTRY,
    splitAttachments,
} from "./entry-format.ts";
import { describe, HttpError, optionalText } from "./errors.ts";
import { homePath } from "./paths.ts";
import { mentionedPaths, viewFile } from "./files.ts";
import { isThinkingLevel, THINKING_LEVELS } from "./models.ts";
import { writePiSession } from "./pi-sessions.ts";
import { snippet } from "./projection.ts";
import { globalModelSettings, projectModelDefault } from "./project-model.ts";
import { expandPromptTemplate, expandSkillCommand, unwrapSkill } from "./prompts.ts";
import { clientKey, ownRequest, requestFor } from "./requests.ts";
import {
    type Interrupt,
    interruptTask,
    type Requeue,
    type Resend,
    resendContent,
    resendRequest,
    ResendTask,
    userContent,
} from "./resend.ts";
import { whyUnanswered } from "./subagent-runs.ts";
import { wantsTitle, writeTitle } from "./titles.ts";
import { describeMoment, describeRepeat, knownZone } from "./when.ts";
import {
    createWorktree,
    discardWorktree,
    inWorktree,
    removeWorktree,
    sourceFolders,
    type Worktree,
} from "./worktrees.ts";

const context = BACKGROUND_CONTEXT;

export type Attachment = { path: string; name: string; mime: string; size: number };

// A name can hold " (", so the path is the part that ends with "-name".
function attachedFile(line: string, uploads: string): Attachment[] {
    const tail = /, ([^,]+), (\d+) bytes\)$/.exec(line);

    if (!line.startsWith("- ") || tail === null) {
        return [];
    }

    const head = line.slice(2, tail.index);

    for (let at = head.indexOf(" ("); at !== -1; at = head.indexOf(" (", at + 1)) {
        const path = head.slice(0, at);
        const name = head.slice(at + 2);

        if (path.startsWith(uploads + sep) && path.endsWith(`-${name}`)) {
            const mime = tail[1] === "unknown type" ? "" : tail[1]!;

            return [{ path, name, mime, size: Number(tail[2]) }];
        }
    }

    return [];
}

export interface SubmitRequest {
    text: string;
    attachments?: Attachment[];
    /**
     * `steer` joins the running work after its current tool round; `interrupt` stops the run at once (as Stop does) and
     * sends the message to the idle conversation; anything else queues a follow-up while busy.
     */
    mode?: "steer" | "followUp" | "interrupt";
    /** Client-generated, so a retried POST does not submit twice. */
    requestId: string;
    /** Send the files the message mentions with `@` along with it, so Pi need not read them first. */
    inlineFiles?: boolean;
}

/** Attached images that also go to the model itself, when it takes images. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;
/** How many `@` mentioned files go along with a message, and how much of them. */
const MAX_MENTIONED = 10;
const MAX_MENTIONED_FILE = 100_000;
const MAX_MENTIONED_TOTAL = 300_000;
const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};
const MAX_TITLE = 120;
/** A title as stored: one line, so it cannot pass for more lines where it is quoted (PiP's lists, reports). */
const oneLine = (title: string): string => title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
/**
 * What a subagent's name drops where it is quoted, to keep its letters, marks, and digits, in every script ("हिन्दी",
 * "サーバー"), its spaces, and ". _ -": no mark of its own then closes the quotes. Every quote mark goes, and every other
 * sign or symbol ("″", "´"); every control, those that turn the text around, hide, or end its isolate too; and the
 * modifier letters that are quote marks or apostrophes in form ("ʺ", "ʼ", "ˮ", the Greek "ʹ", NKo's "ߴ", the saltillo
 * "ꞌ").
 */
const UNQUOTED = /[^\p{L}\p{M}\p{N}\s._-]|[\u02B0-\u02FF\u0374\u07F4\u07F5\uA78B\uA78C]/gu;
/** A mark with no letter or digit under it (first, or after a space), which would sit on the quote beside it. */
const UNBORNE = /(?<![\p{L}\p{M}\p{N}])\p{M}+/gu;

/**
 * A person's activity line when they dealt with a subagent's failure, in its parent session: Pi named it, so quoted, and
 * isolated (U+2068 … U+2069), so a name that ends in right-to-left letters keeps the closing quote and what follows (the
 * line's clock) after it. It cannot end the isolate itself: such controls are among what it drops.
 */
export const dealtWith = (name: string): string => {
    const shown = snippet(name.replace(UNQUOTED, "").replace(UNBORNE, ""), 60);

    return `dealt with the failure of subagent “\u2068${shown}\u2069”`;
};

/** What dismissing a subagent's failure came to: `newer` when it failed again since the failure seen. */
type Dismissal = { dismissed: boolean; newer?: true };
/** The extension that makes plan mode block changes; without it, plan mode would do nothing. */
const PLAN_EXTENSION = "pocket-plan";
/** What Pi is told when someone approves its plan. */
const PLAN_APPROVED = "The plan is approved. Go ahead and carry it out.";
/** Longest handoff note for a new context, and longest instructions for Pi. */
const MAX_HANDOFF = 20_000;
const MAX_INSTRUCTIONS = 8000;

/** Where a new session works: a folder, and the worktree it is in when the session has one of its own. */
type Place = { cwd: string; worktree?: Worktree; skipped: string[] };

/** An entry id from a request, or a 400. */
function entryIdOf(value: unknown): number {
    const id = Number(value);

    if (!Number.isInteger(id) || id < 0) {
        throw new HttpError(400, "entryId must be a message id");
    }

    return id;
}

/**
 * An image file for the model, at most 2000 pixels a side as Pi's read tool sends images: models refuse bigger ones once
 * a conversation holds many, and then every request fails until they leave its context.
 */
async function modelImage(path: string, mimeType: string): Promise<ImageContent> {
    const image = await resizeImage(readFileSync(path), mimeType);

    if (image === null) {
        throw new Error("it could not be made small enough for the model");
    }

    return { type: "image", mimeType: image.mimeType, data: image.data };
}

/** A request's model, when it names one, must name a provider and a model id. */
function checkModel(asked: { provider?: unknown; modelId?: unknown } | undefined): void {
    if (
        asked !== undefined &&
        (typeof asked !== "object" ||
            asked === null ||
            typeof asked.provider !== "string" ||
            typeof asked.modelId !== "string")
    ) {
        throw new HttpError(400, "model must name a provider and a model id");
    }
}

/** A person's message to a failed subagent (`subagent`, its conversation), followed to its end; `failure`, its own then. */
type Followed = { subagent: number; requestId: string; failure: number; by: string };

/**
 * What a person's run of subagent `id` came to, on its record in its parent's `doc`, kept as its reports keep what Pi's
 * work came to: answered, it is done and needs nobody; unanswered, it failed again (or was stopped), which is its
 * failure now, and needs someone even if the one before was dismissed. Not while its record holds a failure newer than
 * `failure`, the one they wrote to: nobody saw that one. The subagent's name when this cleared its failure.
 */
function settle(
    doc: { agents: Record<string, SubagentRecord> },
    id: ConversationId,
    failure: number,
    result: { status: string; reason?: string; detail?: unknown },
): string | undefined {
    const name = Object.keys(doc.agents).find((each) => doc.agents[each]!.conversationId === id);
    const record = name === undefined ? undefined : doc.agents[name]!;

    if (record === undefined || (record.failed === true && (record.answeredAt ?? 0) !== failure)) {
        return undefined;
    }

    const cleared = record.failed === true && result.status !== "unanswered" ? name : undefined;

    record.answeredAt = Date.now();
    record.failed = result.status === "unanswered";

    if (result.status === "unanswered") {
        record.error = whyUnanswered(result.reason ?? "", result.detail);
    } else {
        delete record.error;
    }

    return cleared;
}

/**
 * What a person's message (`requestId`) to subagent `id` came to; undefined when it is not there, or is left in the
 * subagent's queue with no run to take it. Pi Durable leaves a failed run's queue alone, so a message sent while a run
 * went on, which then failed, waits for the next one someone sends, if anyone does: its follow ends then, and the
 * message stays where it is. Its known request id gives back the message sent, as it is now: nothing is sent again.
 */
async function followed(
    runtime: TaskRuntime<Followed, { phase: "wait" }, null, object>,
    id: ConversationId,
    requestId: string,
    context: Context,
): Promise<SettledSubmissionRecord | undefined> {
    // Where it is: gone, left (queued with no run), or sent. One commit reads both, and writes nothing.
    const where = async () => {
        let found = "gone" as "gone" | "left" | "sent";

        await runtime.commit(async (tx) => {
            const record = await tx.submissionByRequest(id, requestId);

            if (record !== undefined) {
                found =
                    record.status === "queued" && (await tx.doc(LiveDoc, id)).run === undefined
                        ? "left"
                        : "sent";
            }
        }, context);

        return found;
    };

    if ((await where()) !== "sent") {
        return undefined;
    }

    const submission = await (
        await runtime.conversation(id, context)
    )?.submit({ type: "input", content: "", requestId }, context);
    const watch = await runtime.watchDoc(LiveDoc, id, context);
    let leave!: () => void;
    const left = new Promise<undefined>((resolve) => {
        leave = () => resolve(undefined);
    });
    // The look under way, if any: one the watch started may still be going when it stops.
    let looking: Promise<void> = Promise.resolve();

    // Each time the subagent has no run, a look at whether this message is left behind. A failed one is reported.
    const look = (live: { run?: unknown } | null) => {
        if (live !== null && live.run === undefined) {
            looking = where().then(
                (found) => (found === "left" ? leave() : undefined),
                (error: unknown) => runtime.report(error),
            );
        }

        return looking;
    };

    if (submission === undefined) {
        await watch?.stop();

        return undefined;
    }

    try {
        if (watch !== undefined) {
            // A listener is never called inline, so the value it started on is this one's to look at.
            await look(watch.value);
            watch.start(look);
        }

        return await Promise.race([submission.wait(context), left]);
    } finally {
        // On every way out, so no watch outlives the phase, nor a look its commit.
        await watch?.stop();
        await looking;
    }
}

export class Commands {
    readonly #app: PocketApp;
    /**
     * Follows a person's message to a failed subagent to its end and settles the failure by it (`settle`): a task of the
     * parent's, beside its work, so a restart before the run ends still settles it, as the subagent's reports do Pi's
     * work. It finds the message by its request id, and never sends one (`followed`). Answered, the parent's activity
     * says who dealt with the failure. A message left in the queue by a run that failed ends it, settling nothing.
     */
    readonly followTask: Task<Followed, { phase: "wait" }, null, object>;
    /** A queued message moved to Interrupt (`moveQueued`): it stops the run it was made for, by that run's id. */
    readonly interruptTask: Task<Interrupt, { phase: "send" }, null, object>;

    constructor(app: PocketApp) {
        this.#app = app;
        this.interruptTask = interruptTask(async (run, context) => {
            const harness = this.#app.harness;
            const task = run as unknown as TaskId;
            const record = await harness.getTask(task, context);

            if (record === undefined || record.state.status === "terminal") {
                return;
            }

            await harness.abortTask(task, context);
            await harness.waitForTask(task, context);
        });
        this.followTask = defineTask<Followed, { phase: "wait" }, null>({
            name: "pocket.follow-failure",
            version: 1,
            initial: () => ({ phase: "wait" }),
            phases: {
                wait: async (task, runtime, context) => {
                    const { subagent, requestId, failure, by } = task.input;
                    const id = subagent as unknown as ConversationId;
                    const settled = await followed(runtime, id, requestId, context);
                    let cleared: string | undefined;

                    await runtime.commit(async (tx) => {
                        if (settled !== undefined) {
                            cleared = settle(
                                await tx.doc(SubagentsDoc, runtime.conversationId),
                                id,
                                failure,
                                settled,
                            );
                        }

                        return {
                            status: "terminal",
                            outcome: { status: "completed", result: null },
                        };
                    }, context);

                    const user = app.config.userById(by);

                    if (cleared !== undefined && user !== undefined) {
                        await app.collab.activity(runtime.conversationId, user, dealtWith(cleared));
                    }
                },
            },
            abort: (_task, runtime, context) =>
                runtime.commit(
                    () => ({ status: "terminal", outcome: { status: "aborted" } }),
                    context,
                ),
        });
    }

    /** Start a session in a folder; with `worktree`, in a git worktree of its own made from that folder. */
    async createSession(
        user: User,
        request: { cwd?: string; title?: string; worktree?: unknown },
        { projectDefaults = true }: { projectDefaults?: boolean } = {},
    ): Promise<{ id: ConversationId }> {
        const app = this.#app;

        app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session and cannot start new ones.");
        }

        const given = optionalText(request.title, "title");
        const title = (given === undefined ? undefined : oneLine(given)) || undefined;
        const folder = app.workspace.checkDirectory(
            optionalText(request.cwd, "cwd") ?? app.defaultCwd,
        );
        const now = Date.now();

        return this.#inPlace(
            folder,
            request.worktree === true,
            title ?? basename(folder),
            async ({ cwd, worktree }) => {
                // An internal caller about to apply a person's explicit model keeps its previous starting pair.
                const initial = this.#defaultModel(undefined, projectDefaults ? cwd : undefined);
                const conversation = await app.harness.createConversation(
                    {
                        ownership: { kind: "ownerless" },
                        agent: {
                            cwd,
                            ...(initial.model === undefined ? {} : { model: initial.model }),
                            ...(initial.thinkingLevel === undefined
                                ? {}
                                : { thinkingLevel: initial.thinkingLevel }),
                        },
                        init: async (tx, id) => {
                            const sessions = await tx.doc(SessionsDoc);

                            sessions.items[String(id)] = {
                                cwd,
                                createdAt: now,
                                updatedAt: now,
                                createdBy: user.id,
                                ...(title === undefined ? {} : { title }),
                                ...(worktree === undefined ? {} : { worktree }),
                            };
                        },
                    },
                    context,
                );

                return { id: conversation.id };
            },
        );
    }

    /**
     * Continue one of Pi's sessions from the terminal here: a new session with its history, in its folder, with its model
     * when that one is signed in here (`pi-sessions.ts`). The owner's, as Pi's own files are.
     */
    async continuePiSession(user: User, path: string): Promise<{ id: ConversationId }> {
        const app = this.#app;
        const session = await app.piSessions.read(user, path);
        let cwd: string;

        try {
            cwd = app.workspace.checkDirectory(session.cwd);
        } catch {
            throw new HttpError(
                400,
                `The folder this Pi session worked in is not there anymore: ${session.cwd}`,
            );
        }

        const start = this.#defaultModel(session);
        const title = session.title.slice(0, MAX_TITLE);
        const now = Date.now();
        const conversation = await app.harness.createConversation(
            {
                ownership: { kind: "ownerless" },
                agent: {
                    cwd,
                    ...(start.model === undefined ? {} : { model: start.model }),
                    ...(start.thinkingLevel === undefined
                        ? {}
                        : { thinkingLevel: start.thinkingLevel }),
                },
                init: async (tx, id) => {
                    (await tx.doc(SessionsDoc)).items[String(id)] = {
                        cwd,
                        title,
                        createdAt: now,
                        updatedAt: now,
                        createdBy: user.id,
                        fromPi: { session: session.id, count: session.count },
                    };
                    await writePiSession(tx, id, session, {
                        session: session.id,
                        title: session.title,
                        file: path,
                    });
                },
            },
            context,
        );

        return { id: conversation.id };
    }

    /**
     * Run `create` with the folder a new session works in: `cwd` itself, or, when `isolated`, the matching folder in a
     * new git worktree made from it, named after `label`. A worktree whose session `create` did not make is discarded.
     */
    async #inPlace<T>(
        cwd: string,
        isolated: boolean,
        label: string,
        create: (place: Place) => Promise<T>,
    ): Promise<T> {
        if (!isolated) {
            return create({ cwd, skipped: [] });
        }

        const made = await createWorktree(cwd, join(this.#app.dataDir, "worktrees"), label);

        try {
            return await create(made);
        } catch (error) {
            await discardWorktree(made.worktree).catch((cleanup: unknown) =>
                this.#app.log(`worktree ${made.worktree.path} left behind: ${describe(cleanup)}`),
            );

            throw error;
        }
    }

    /** Remove a session's worktree folder; its branch stays. One with uncommitted changes stays too, unless `force`. */
    async removeWorktree(id: ConversationId, user: User, force: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const worktree = app.sessionMeta(id)?.worktree;

        if (worktree === undefined) {
            throw new HttpError(404, "This session has no worktree");
        }

        const inside = (cwd: string) => inWorktree(worktree, cwd);

        // Anything at work there would lose its folder: this session's runs, its subagents', or another session's.
        if (app.busyConversations().some((busy) => inside(app.cwdOf(busy)))) {
            throw new HttpError(409, "Pi is working in the worktree: stop it first.");
        }

        // A fork made without a worktree of its own works in this one.
        const sharing = app
            .sessions()
            .find(
                (session) =>
                    session.id !== Number(id) &&
                    inside(app.cwdOf(session.id as unknown as ConversationId)),
            );

        if (sharing !== undefined) {
            throw new HttpError(
                409,
                `“${sharing.title ?? "New session"}” works in this worktree too. Move it to another folder first.`,
            );
        }

        const back = await sourceFolders(worktree);
        const moves = app
            .conversationsOf(id)
            .filter((each) => inside(app.cwdOf(each)))
            .map((each) => ({ id: each, cwd: back(app.cwdOf(each)) }));

        await removeWorktree(worktree, force === true);

        // The session and its subagents go back to the folders the worktree came from.
        for (const move of moves) {
            await (await app.conversation(move.id)).configure({ cwd: move.cwd }, context);
        }

        const cwd = app.cwdOf(id);

        await app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta === undefined) {
                return;
            }

            delete meta.worktree;
            meta.cwd = cwd;
        }, context);
        await app.collab.activity(
            id,
            user,
            `removed the worktree; the branch ${worktree.branch} stays, and Pi works in ${homePath(cwd)} again`,
        );
    }

    /** The model and thinking level a new session starts with now. */
    defaultModel(): { model?: ModelRef; thinkingLevel?: ModelThinkingLevel } {
        return this.#defaultModel();
    }

    /**
     * The model a new session starts with, always one a person chose: `prefer` (with its thinking level) when it is
     * signed in here, or else the owner's default, even when it is not signed in now: the session then shows that, and
     * its first message fails in sight, where another model would spend on what nobody chose for it. Without an owner's
     * default, ordinary sessions consult trusted project defaults in their final cwd, then the last picked model,
     * then Pi's global default. A no-cwd caller (imports and PiP itself) keeps the legacy default selection. Never
     * the first model there is: with none chosen, the session starts without a model, and someone picks one.
     */
    #defaultModel(
        prefer?: {
            model: { provider: string; modelId: string } | null;
            thinkingLevel: string;
        },
        cwd?: string,
    ): {
        model?: ModelRef;
        thinkingLevel?: ModelThinkingLevel;
    } {
        const { models, config, settings } = this.#app;
        const available = models.getAvailableSnapshot();
        const pick = (provider: string | undefined, id: string | undefined) =>
            provider === undefined || id === undefined
                ? undefined
                : available.find((model) => model.provider === provider && model.id === id);
        const last = config.lastModel;
        const preferred = pick(prefer?.model?.provider, prefer?.model?.modelId);
        const chosen = config.defaultModel;
        const owners =
            chosen === undefined ? undefined : models.getModel(chosen.provider, chosen.modelId);
        const defaults =
            chosen === undefined && cwd !== undefined ? globalModelSettings(cwd) : settings;
        const project =
            chosen === undefined && cwd !== undefined
                ? projectModelDefault(cwd, defaults, models)
                : undefined;
        const lastPicked =
            chosen === undefined && project === undefined
                ? pick(last?.provider, last?.modelId)
                : undefined;
        // Ordinary sessions must not inherit a different project's settings from the server's starting folder.
        // Imported sessions and PiP's own conversation keep their existing selection behavior.
        const global = cwd === undefined ? undefined : defaults.getGlobalSettings();
        const pis =
            chosen === undefined && project === undefined && lastPicked === undefined
                ? pick(
                      cwd === undefined ? settings.getDefaultProvider() : global?.defaultProvider,
                      cwd === undefined ? settings.getDefaultModel() : global?.defaultModel,
                  )
                : undefined;
        const model = preferred ?? owners ?? project?.model ?? lastPicked ?? pis;

        if (model === undefined) {
            return {};
        }

        const level = ((preferred !== undefined
            ? prefer?.thinkingLevel
            : owners !== undefined
              ? chosen?.thinkingLevel
              : project !== undefined
                ? project.thinkingLevel
                : lastPicked !== undefined
                  ? last?.thinkingLevel
                  : cwd === undefined
                    ? settings.getDefaultThinkingLevel()
                    : global?.defaultThinkingLevel) ?? "off") as ModelThinkingLevel;

        return {
            model: { provider: model.provider, modelId: model.id },
            thinkingLevel: clampThinkingLevel(model, level),
        };
    }

    async updateSession(
        id: ConversationId,
        user: User,
        patch: { title?: string; archived?: boolean },
    ): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);
        optionalText(patch.title, "title");

        if (patch.archived !== undefined && typeof patch.archived !== "boolean") {
            throw new HttpError(400, "archived must be true or false");
        }

        const before = app.sessionMeta(id);

        await app.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);
            const meta = sessions.items[String(id)];

            if (meta === undefined) {
                throw new HttpError(404, "Not a session");
            }

            // A rename moves the session up the list. Archiving does not: brought back, or undone, it returns to where it was.
            if (patch.title !== undefined) {
                meta.title = oneLine(patch.title) || undefined;
                meta.updatedAt = Date.now();
            }

            if (patch.archived !== undefined) {
                meta.archived = patch.archived;
            }
        }, context);
        const title = patch.title === undefined ? undefined : oneLine(patch.title);

        if (title !== undefined && title !== "" && title !== before?.title) {
            await app.collab.activity(id, user, `renamed the session to “${title}”`);
        }

        if (patch.archived !== undefined && patch.archived !== (before?.archived === true)) {
            await app.collab.activity(
                id,
                user,
                patch.archived
                    ? "archived the session"
                    : "brought the session back from the archive",
            );
        }
    }

    /**
     * Send a message to Pi as `user`. With `via`, an assistant (PiP) sends it for them: it is marked as sent through it,
     * and is theirs to pay for and steer, but not their own words (`requestFor`). Only server code passes `via`.
     */
    async submit(
        id: ConversationId,
        user: User,
        request: SubmitRequest,
        via?: string,
        admission?: {
            beforeSubmit(): Promise<{ user: User; context: Context }>;
            afterSubmit(): void;
        },
    ): Promise<{ submissionId: SubmissionId; requestId: string }> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        // PiP turned off takes nothing, from its person either: it would run without its rules, and be compacted without
        // its own summary (`pip-compact.ts`). What else goes to it (reports, schedules, watches) waits meanwhile.
        if (app.pip.ownerOf(id) !== undefined && !app.pip.available(user)) {
            throw new HttpError(409, "PiP is turned off in Extensions.");
        }

        const conversation = await app.conversation(id);
        const typed = request.text.trim();
        // `/skill:name request` sends the skill with the request; `/name arguments`, Pi's prompt template of that name.
        const expanded = typed.startsWith("/skill:")
            ? (expandSkillCommand(typed, app.skillCommands(id)) ?? typed)
            : typed.startsWith("/")
              ? (expandPromptTemplate(typed, app.promptTemplates(id)) ?? typed)
              : typed;
        // A value an extension hides (`host.hide`), pasted into the message, is never stored nor sent to the model.
        const text = app.hidden.replace(expanded, id);
        const attachments = request.attachments ?? [];

        if (text === "" && attachments.length === 0) {
            throw new HttpError(400, "Nothing to send");
        }

        const agent = await app.agentState(id);
        const model =
            agent?.model === undefined
                ? undefined
                : app.models.getModel(agent.model.provider, agent.model.modelId);

        if (model === undefined) {
            throw new HttpError(409, "Pick a model for this conversation first.");
        }

        app.spend.check(user, id);

        const lines = attachments.map(
            (file) =>
                `- ${file.path} (${file.name}, ${file.mime || "unknown type"}, ${file.size} bytes)`,
        );
        // The heading whole, with files alone too: what reads the message splits it there.
        const written =
            lines.length === 0 ? text : `${text}${ATTACHMENTS_HEADING}${lines.join("\n")}`;
        const body = this.messageText(
            user,
            via === undefined ? written : `[via ${via}] ${written}`,
        );
        const mentioned =
            request.inlineFiles === true
                ? await this.#mentionedFiles(id, user, typed, model.input.includes("image"))
                : [];
        // A file's text that a message brings along hides what extensions hide (`host.hide`), as the message does.
        const parts: (TextContent | ImageContent)[] = [
            { type: "text", text: body },
            ...mentioned.map((part) =>
                part.type === "text" ? { ...part, text: app.hidden.replace(part.text, id) } : part,
            ),
        ];

        for (const file of attachments) {
            if (
                !model.input.includes("image") ||
                !IMAGE_TYPES.has(file.mime) ||
                file.size > MAX_INLINE_IMAGE
            ) {
                continue;
            }

            try {
                parts.push(await modelImage(file.path, file.mime));
            } catch (error) {
                app.notice("warning", `Could not attach ${file.name}: ${describe(error)}`, id);
            }
        }

        const content = parts.length === 1 ? body : parts;
        const requestId =
            via === undefined
                ? ownRequest(user.id, clientKey(request.requestId))
                : requestFor(user.id, clientKey(request.requestId));
        // A failed subagent's failure as the person writes to it: what their message comes to settles it.
        const failure = await this.#failureOf(id);

        let submitContext = context;

        // Human extension starts acquire a short policy lease after preparation. Its context checks policy again
        // when durable admission reaches the mutation line, not just before it joins the queue.
        if (admission !== undefined) {
            const accepted = await admission.beforeSubmit();

            user = accepted.user;
            submitContext = accepted.context;
            submitContext.abortSignal?.throwIfAborted();
        }

        // Interrupt: stop the run now, rather than waiting for its tool round or turn to end. Like Stop, this withdraws
        // what waits in the queue. Only a person's own message interrupts, never one sent for them (`via`).
        // A retried request finds its first submission: it must not stop the run that the first one started. (Two POSTs
        // of one request at the same moment can both find none and both stop the run: a rare race, left as it is.)
        if (
            request.mode === "interrupt" &&
            via === undefined &&
            app.isBusy(id) &&
            (await app.harness.commit((tx) => tx.submissionByRequest(id, requestId), context)) ===
                undefined
        ) {
            await this.#discardReports(id);
            await conversation.abort(context);
            await app.collab.activity(id, user, "interrupted the run");
        }

        // A retry of a request finds its first submission: it is no new message, and no event goes out for it again.
        const known =
            app.pip.ownerOf(id) === undefined &&
            (await app.harness.commit((tx) => tx.submissionByRequest(id, requestId), context)) !==
                undefined;
        const submission = await conversation
            .submit(
                {
                    type: "input",
                    content,
                    whenBusy: request.mode === "steer" ? "steer" : "followUp",
                    requestId,
                },
                submitContext,
            )
            .finally(() => admission?.afterSubmit());

        app.collab.setTyping(id, user, null);
        // The title comes from the message as it was stored: without hidden values.
        const titled = app.hidden.replace(typed, id);

        await this.#touched(id, titled, text === titled ? undefined : text);

        // A person's own words: linked sessions may message each other again (`linked-sessions.ts`).
        if (via === undefined) {
            await app.linkedSessions.personWrote(id);
        }

        this.#reportUnanswered(id, submission.wait(context));

        if (failure !== undefined) {
            await this.#followFailure(id, user, failure, requestId);
        }

        // For extensions (`host.on`): once for each message (two retries at once, too), never for PiP's conversation,
        // which is its person's alone.
        if (app.pip.ownerOf(id) === undefined && !known && this.#announce(submission.id)) {
            app.events.emit("message.sent", {
                conversationId: Number(id),
                by: user.id,
                submissionId: String(submission.id),
                text,
                ...(via === undefined ? {} : { via }),
            });
        }

        return { submissionId: submission.id, requestId };
    }

    /** Submissions `message.sent` went out for lately: a retry that raced its first try finds its id here. */
    readonly #announced = new Set<string>();

    /** Whether to send `message.sent` for a submission: once only, as far as this process knows. */
    #announce(submissionId: unknown): boolean {
        const key = String(submissionId);

        if (this.#announced.has(key)) {
            return false;
        }

        this.#announced.add(key);

        // The newest few hundred are enough: a retry comes within seconds.
        if (this.#announced.size > 500) {
            this.#announced.delete(this.#announced.values().next().value!);
        }

        return true;
    }

    /** When a subagent (`id`, its conversation) failed, if it is failed now (not stopped); undefined otherwise. */
    async #failureOf(id: ConversationId): Promise<number | undefined> {
        const parent = this.#app.parentOf(id);

        if (parent === undefined) {
            return undefined;
        }

        const agents = (await this.#app.harness.snapshot(SubagentsDoc, parent, context))?.agents;
        const record = Object.values(agents ?? {}).find((each) => each.conversationId === id);

        return record?.failed === true && record.error !== STOPPED
            ? (record.answeredAt ?? 0)
            : undefined;
    }

    /**
     * Follow a person's message (`requestId`) to failed subagent `id` to its end, in a task of its parent's (`followTask`).
     * The message went: a failure to start following it is logged, not answered.
     */
    async #followFailure(
        id: ConversationId,
        user: User,
        failure: number,
        requestId: string,
    ): Promise<void> {
        const app = this.#app;
        const parent = app.parentOf(id);

        if (parent === undefined) {
            return;
        }

        try {
            await app.harness.commit(async (tx) => {
                await tx.createTask(
                    this.followTask,
                    { subagent: Number(id), requestId, failure, by: user.id },
                    {
                        ownership: { kind: "conversation" },
                        background: true,
                        conversationId: parent,
                    },
                );
            }, context);
        } catch (error) {
            app.log(`not following a message to ${String(id)}: ${describe(error)}`);
        }
    }

    /**
     * A person dealt with a failed subagent (`id`, its conversation): seen or dismissed, it needs nobody now, on the
     * board, the rail, or the session list, until it fails again. `at` is the failure they saw (its `answeredAt`): a
     * newer one still needs them, and `newer` says so. Not dismissed either when it has no failure, or someone dealt
     * with it already.
     */
    async dismissSubagent(id: ConversationId, user: User, at: unknown): Promise<Dismissal> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        if (typeof at !== "number" || !Number.isFinite(at)) {
            throw new HttpError(400, "at must be the time of the failure seen");
        }

        if (app.parentOf(id) === undefined) {
            throw new HttpError(404, "Not a subagent");
        }

        return this.#dismissFailure(id, user, at);
    }

    /**
     * Mark a subagent's failure, the one at `at`, dealt with by `user`, as the parent's activity says: as
     * `dismissSubagent` answers.
     */
    async #dismissFailure(id: ConversationId, user: User, at: number): Promise<Dismissal> {
        const parent = this.#app.parentOf(id);
        let name: string | undefined;

        if (parent === undefined) {
            return { dismissed: false };
        }

        const answer = await this.#app.harness.commit(async (tx): Promise<Dismissal> => {
            const agents = (await tx.doc(SubagentsDoc, parent)).agents;

            name = Object.keys(agents).find((each) => agents[each]!.conversationId === id);
            const record = name === undefined ? undefined : agents[name]!;
            // Its failure is known by when it failed; a failure from before that was recorded has none.
            const failure = record?.answeredAt ?? 0;

            if (
                record === undefined ||
                record.failed !== true ||
                record.error === STOPPED ||
                record.dealtAt === failure
            ) {
                return { dismissed: false };
            }

            if (at !== failure) {
                return { dismissed: false, newer: true };
            }

            record.dealtAt = failure;

            return { dismissed: true };
        }, context);

        if (answer.dismissed && name !== undefined) {
            await this.#app.collab.activity(parent, user, dealtWith(name));
        }

        return answer;
    }

    /**
     * The files a message mentions with `@`, for Pi: text files as `<file>` blocks, as Pi's terminal app sends files
     * given on its command line, and images as images when the model takes them. Only files this person may load
     * through the session; anything else stays a mention, which Pi can read itself.
     */
    async #mentionedFiles(
        id: ConversationId,
        user: User,
        text: string,
        images: boolean,
    ): Promise<(TextContent | ImageContent)[]> {
        const app = this.#app;
        const parts: (TextContent | ImageContent)[] = [];
        let total = 0;

        for (const mention of mentionedPaths(text).slice(0, MAX_MENTIONED)) {
            let file: string | undefined;

            for (const candidate of mention.candidates) {
                try {
                    const resolved = app.workspace.readableFile(user, id, candidate);

                    if (statSync(resolved).isFile()) {
                        file = resolved;
                        break;
                    }
                } catch {
                    // Not there, or not this person's to load.
                }
            }

            if (file === undefined) {
                continue;
            }

            try {
                const mime = IMAGE_MIME[extname(file).toLowerCase()];

                if (mime !== undefined) {
                    if (images && statSync(file).size <= MAX_INLINE_IMAGE) {
                        parts.push(await modelImage(file, mime));
                    }

                    continue;
                }

                const view = await viewFile(file);

                if (view.kind !== "text" || total >= MAX_MENTIONED_TOTAL) {
                    continue;
                }

                const room = Math.min(MAX_MENTIONED_FILE, MAX_MENTIONED_TOTAL - total);
                const content = view.text.slice(0, room);

                total += content.length;
                const cut =
                    view.truncated || view.text.length > room
                        ? "\n… (the rest of the file is left out)"
                        : "";

                parts.push({
                    type: "text",
                    text: `${FILE_BLOCK}${file}">\n${content}${cut}\n</file>`,
                });
            } catch (error) {
                app.notice("warning", `Could not send ${mention.written}: ${describe(error)}`, id);
            }
        }

        return parts;
    }

    /** A message to Pi as the model gets it: with more than one person on this server, it says who is talking. */
    messageText(user: Pick<User, "name">, text: string): string {
        return this.#app.config.users.length > 1
            ? `[from: ${user.name.replace(/[[\]]/g, "")}] ${text}`
            : text;
    }

    /**
     * A session just got a message: it moves up the list, and its first message names it. A long first message gets a
     * short title written for it afterwards (`titles.ts`), and so does a command (`/skill:name`, a prompt template),
     * whose name says little: written from the command and what it `expanded` to, which says what it asks (a skill's
     * instructions without the paths of its files, which would pull the title toward a folder's name).
     */
    async #touched(id: ConversationId, text: string, expanded?: string): Promise<void> {
        if (this.#app.sessionMeta(id) === undefined) {
            return;
        }

        let provisional: string | undefined;

        await this.#app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta === undefined) {
                return;
            }

            meta.updatedAt = Date.now();

            if (meta.title === undefined && text !== "") {
                meta.title = provisional = text.replace(/\s+/g, " ").slice(0, 80);
            }
        }, context);

        if (provisional !== undefined && (expanded !== undefined || wantsTitle(text))) {
            void writeTitle(
                this.#app,
                id,
                expanded === undefined ? text : `${text}\n\n${unwrapSkill(expanded)}`,
                provisional,
            );
        }
    }

    /**
     * A line in the transcript about something a person did that Pi should know about, such as undoing a file's
     * changes. Pi gets it too, with its next message; while Pi works, it waits for a place in the conversation.
     */
    async note(id: ConversationId, user: User, text: string): Promise<void> {
        const conversation = await this.#app.conversation(id);
        const model = [
            {
                role: "user" as const,
                content: [{ type: "text" as const, text: `[note] ${user.name} ${text}` }],
                timestamp: Date.now(),
            },
        ];

        // The person's, as their messages are: Pi works for them from there.
        await conversation.submit(
            {
                type: "write",
                entry: { kind: NOTE_ENTRY, data: { text, by: user.id, name: user.name }, model },
                requestId: ownRequest(user.id, `note-${randomUUID()}`),
            },
            context,
        );
    }

    /** A message Pi could not answer, other than one someone stopped, shows as an error to the people there. */
    #reportUnanswered(
        id: ConversationId,
        settled: Promise<{ status: string; reason?: string; detail?: unknown }>,
    ): void {
        const app = this.#app;

        void settled.then(
            (result) => {
                if (result.status === "unanswered" && result.reason !== "aborted") {
                    const detail =
                        result.detail === undefined
                            ? ""
                            : `: ${JSON.stringify(result.detail).slice(0, 400)}`;

                    app.notice("error", `No answer (${result.reason})${detail}`, id);
                }
            },
            (error: unknown) => app.notice("error", describe(error), id),
        );
    }

    /**
     * Send the request of a run that waits for a provider's limit now, rather than at its time (`limit-gate.ts`): of
     * this conversation, or of its subagents. The request goes whether or not the limit has cleared: the provider
     * rejects it at no cost, or answers. Who may see and steer the session may. False: nothing there waits.
     */
    async retryLimit(id: ConversationId, user: User): Promise<boolean> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        let sent = app.limits.retryNow(Number(id));

        for (const wait of app.limits.waits()) {
            if (app.rootOf(wait.conversationId as unknown as ConversationId) === id) {
                sent = app.limits.retryNow(wait.conversationId) || sent;
            }
        }

        if (sent) {
            await app.collab.activity(id, user, "tried again without waiting for the limit");
        }

        return sent;
    }

    /** Stop the run. Anyone who can steer may, even while someone else drives: stopping is the safe direction. */
    async abort(id: ConversationId, user: User): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);
        const conversation = await app.conversation(id);
        const busy = app.isBusy(id);

        // Stop withdraws what waits in the queue, subagents' reports too: a person meant them gone.
        await this.#discardReports(id);
        void conversation
            .abort(context)
            .catch((error: unknown) => app.notice("error", `Abort failed: ${describe(error)}`, id));

        if (busy) {
            await app.collab.activity(id, user, "stopped the run");
        }
    }

    /**
     * Mark the batch of subagents' reports in `id`'s queue (or, given `submissionId`, only if that is it) as a person's
     * to withdraw: the courier then lets it go instead of sending it again, as it does with one a spend limit's stop
     * withdrew.
     */
    async #discardReports(id: ConversationId, submissionId?: number): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            const state = await tx.doc(SubagentsDoc, id);
            const sending = state.sending;

            if (sending === undefined || sending.discarded === true) {
                return;
            }

            if (submissionId !== undefined) {
                const record = await tx.submissionByRequest(id, sending.request);

                if (record === undefined || Number(record.id) !== submissionId) {
                    return;
                }
            }

            state.sending = { ...sending, discarded: true };
        }, context);
    }

    /** Take back a queued message. Anyone may take back their own; someone else's needs the right to drive. */
    async withdraw(id: ConversationId, user: User, submissionId: number): Promise<string> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);
        const by = await app.attribution.submitter(submissionId);

        if (by !== user.id) {
            await app.requireDriver(id, user);
        }

        await this.#discardReports(id, submissionId);
        const result = await app.harness.abortSubmission(
            submissionId as unknown as SubmissionId,
            context,
            id,
        );

        if (by !== undefined && by !== user.id) {
            const author = app.config.userById(by)?.name ?? "someone";

            await app.collab.activity(id, user, `withdrew ${author}’s queued message`);
        }

        return result;
    }

    async editQueued(
        id: ConversationId,
        user: User,
        submissionId: number,
    ): Promise<{ text: string; attachments: Attachment[] }> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        if (!Number.isInteger(submissionId) || submissionId <= 0) {
            throw new HttpError(400, "Say which queued message to edit.");
        }

        if ((await app.attribution.submitter(submissionId)) !== user.id) {
            throw new HttpError(403, "Only its sender can edit a queued message.");
        }

        const item = (await app.harness.snapshot(InboxDoc, id, context))?.items.find(
            (entry) => Number(entry.id) === submissionId,
        );
        const result =
            item === undefined || item.mode === "write"
                ? "not_found"
                : await app.harness.abortSubmission(
                      submissionId as unknown as SubmissionId,
                      context,
                      id,
                  );

        if (item === undefined || item.mode === "write" || result !== "aborted") {
            throw new HttpError(409, "That message has already gone to Pi.");
        }

        // A `/skill:` or prompt template message comes back as it was sent: expanded.
        const [written, files] = splitAttachments(
            userContent({ content: item.content }).text.replace(FROM_PREFIX, ""),
        );
        const uploads = app.workspace.uploadDirectory(id);

        return {
            text: written,
            attachments: (files ?? "").split("\n").flatMap((line) => attachedFile(line, uploads)),
        };
    }

    /**
     * Move a queued message to Steer or Queue, or send it now as an Interrupt. Only its sender may, as with taking it
     * back (`withdraw`): who else may move someone's message is left to the maintainers. Interrupt stops the run like
     * the composer's Interrupt, but only this message goes now: the others in the queue, from everyone, stay queued
     * in their order, with their senders and modes (Stop withdraws them; the stop here would, so the task queues them
     * again). Subagents' reports it withdraws wait again for the courier. The message leaves the queue, and the others
     * are noted in the task, in one commit.
     */
    async moveQueued(
        id: ConversationId,
        user: User,
        submissionId: number,
        mode: string,
    ): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        if (!Number.isInteger(submissionId) || submissionId <= 0) {
            throw new HttpError(400, "Say which queued message to move.");
        }

        if (mode !== "steer" && mode !== "followUp" && mode !== "interrupt") {
            throw new HttpError(400, "Move a message to steer, followUp, or interrupt.");
        }

        // Its sender moves it, as with taking it back: after a restart this process may not know the sender yet.
        if ((await app.attribution.submitter(submissionId)) !== user.id) {
            throw new HttpError(403, "Only its sender can move a queued message.");
        }

        // To the queue, it only waits longer. To Steer or Interrupt, it acts on the run now: that is the driver's turn,
        // as sending is.
        if (mode !== "followUp") {
            await app.requireDriver(id, user);
        }

        // Request ids of the queued messages, from Pi Durable's records: a commit cannot read a submission by its id.
        const requests = new Map<number, string | undefined>();
        let moved: boolean | "again" = "again";

        for (let attempt = 0; moved === "again"; attempt++) {
            if (mode === "interrupt") {
                const queued = (await app.harness.snapshot(InboxDoc, id, context))?.items ?? [];

                for (const item of queued) {
                    if (item.mode !== "write" && !requests.has(Number(item.id))) {
                        const record = await (
                            await app.harness.submission(item.id, context)
                        )?.status(context);

                        requests.set(Number(item.id), record?.requestId);
                    }
                }
            }

            moved = await app.harness.commit(async (tx) => {
                const items = (await tx.doc(InboxDoc, id)).items;
                const index = items.findIndex((entry) => Number(entry.id) === submissionId);
                const item = items[index];

                if (item === undefined || item.mode === "write") {
                    return false;
                }

                if (mode !== "interrupt") {
                    item.mode = mode;

                    return true;
                }

                // Every table read comes before the commit's first table write.
                const subagents = await tx.doc(SubagentsDoc, id);
                const batch =
                    subagents.sending === undefined
                        ? undefined
                        : await tx.submissionByRequest(id, subagents.sending.request);
                const live = await tx.doc(LiveDoc, id);
                const others: Requeue[] = [];
                const stay: number[] = [];

                for (const other of items) {
                    // Writes stay in the queue by themselves; the reports go back to their courier when withdrawn.
                    if (
                        Number(other.id) === submissionId ||
                        other.mode === "write" ||
                        other.id === batch?.id
                    ) {
                        continue;
                    }

                    if (!requests.has(Number(other.id))) {
                        // Queued since the requests were read.
                        if (attempt >= 3) {
                            throw new HttpError(409, "The queue is changing; try again.");
                        }

                        return "again";
                    }

                    const first = requests.get(Number(other.id));

                    stay.push(Number(other.id));
                    others.push({
                        content: copyJson(other.content) as UserInput,
                        mode: other.mode,
                        // The person is in the request id: the new one keeps it, for who wrote it and whose work it is.
                        requestId:
                            first === undefined
                                ? `interrupt-${submissionId}-${others.length}`
                                : `${first.replace(/(~\d+)+$/, "")}~${submissionId}`,
                        ...(other.entry === undefined
                            ? {}
                            : { entry: copyJson(other.entry) as InputEntry }),
                    });
                }

                const content = copyJson(item.content) as UserInput;
                const run = live.run === undefined ? undefined : Number(live.run.taskId);

                // Taken out of the queue here, so the stop's withdrawal cannot reach them: the task puts them back.
                for (let at = items.length - 1; at >= 0; at--) {
                    const queued = Number(items[at]!.id);

                    if (queued === submissionId || stay.includes(queued)) {
                        items.splice(at, 1);
                    }
                }

                tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });

                for (const taken of stay) {
                    tx.settleSubmission(taken as unknown as SubmissionId, {
                        status: "unanswered",
                        reason: "aborted",
                    });
                }

                await tx.createTask(
                    this.interruptTask,
                    {
                        content,
                        requestId: ownRequest(user.id, `interrupt-${submissionId}`),
                        ...(run === undefined ? {} : { run }),
                        others,
                    },
                    { ownership: { kind: "conversation" }, background: true, conversationId: id },
                );

                return true;
            }, context);
        }

        if (!moved) {
            throw new HttpError(409, "That message has already gone to Pi.");
        }

        if (mode === "interrupt") {
            await app.collab.activity(id, user, "interrupted the run");
        }
    }

    async configure(
        id: ConversationId,
        user: User,
        request: {
            model?: { provider: string; modelId: string };
            thinkingLevel?: string;
            cwd?: string;
            pipPanel?: boolean;
        },
    ): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (request.pipPanel === true && app.pip.ownerOf(id) !== user.id) {
            throw new HttpError(403, "Only your own PiP can use this control.");
        }

        const asked = request.model as { provider?: unknown; modelId?: unknown } | undefined;

        checkModel(asked);

        if (
            optionalText(request.thinkingLevel, "thinkingLevel") !== undefined &&
            !isThinkingLevel(request.thinkingLevel)
        ) {
            throw new HttpError(400, `thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
        }

        optionalText(request.cwd, "cwd");

        // Someone invited to one session sees files in its folder only: moving it would move what they see.
        if (request.cwd !== undefined && user.sessions !== undefined) {
            throw new HttpError(
                403,
                "You were invited to one session and cannot move it to another folder.",
            );
        }

        const conversation = await app.conversation(id);
        const current = await app.agentState(id);
        const ref = request.model ?? current?.model;
        const model =
            ref === undefined ? undefined : app.models.getModel(ref.provider, ref.modelId);

        if (request.model !== undefined && model === undefined) {
            throw new HttpError(
                400,
                `Unknown model ${request.model.provider}/${request.model.modelId}`,
            );
        }

        const wanted = (request.thinkingLevel ??
            current?.thinkingLevel ??
            "off") as ModelThinkingLevel;
        const thinkingLevel = model === undefined ? wanted : clampThinkingLevel(model, wanted);
        const cwd =
            request.cwd === undefined ? undefined : app.workspace.checkDirectory(request.cwd);

        const change = {
            ...(request.model === undefined
                ? {}
                : { model: { provider: request.model.provider, modelId: request.model.modelId } }),
            thinkingLevel,
            ...(cwd === undefined ? {} : { cwd }),
        };

        if (request.pipPanel === true) {
            // Check and save together: a turn may have started while the picker was open.
            await app.harness.commit(async (tx) => {
                const live = await tx.doc(LiveDoc, id);

                if (live.run !== undefined || (live.compactions?.length ?? 0) > 0) {
                    throw new HttpError(409, "PiP is working. Change its model when it is idle.");
                }

                Object.assign(await tx.doc(AgentDoc, id), change);
            }, context);
        } else {
            await conversation.configure(change, context);
        }

        if (cwd !== undefined && app.sessionMeta(id) !== undefined) {
            await app.harness.commit(async (tx) => {
                const meta = (await tx.doc(SessionsDoc)).items[String(id)];

                if (meta !== undefined) {
                    meta.cwd = cwd;
                }
            }, context);
        }

        if (ref !== undefined && request.pipPanel !== true) {
            app.config.lastModel = { provider: ref.provider, modelId: ref.modelId, thinkingLevel };
        }

        const changes: string[] = [];
        const modelChanged =
            request.model !== undefined &&
            (request.model.provider !== current?.model?.provider ||
                request.model.modelId !== current?.model?.modelId);

        if (modelChanged) {
            changes.push(`switched the model to ${model?.name ?? request.model!.modelId}`);
        }

        if (
            request.thinkingLevel !== undefined &&
            thinkingLevel !== (current?.thinkingLevel ?? "off")
        ) {
            changes.push(`set thinking to ${thinkingLevel}`);
        }

        if (cwd !== undefined && cwd !== current?.cwd) {
            changes.push(`moved the session to ${homePath(cwd)}`);
        }

        if (changes.length > 0) {
            await app.collab.activity(id, user, changes.join(" and "));
        }
    }

    /** Start a new context: Pi no longer sees what came before, though everyone still can. An optional note carries over. */
    async reset(id: ConversationId, user: User, note: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const handoff = optionalText(note, "note")?.trim() || undefined;

        if (handoff !== undefined && handoff.length > MAX_HANDOFF) {
            throw new HttpError(413, `Handoff notes are limited to ${MAX_HANDOFF} characters`);
        }

        await (await app.conversation(id)).reset(handoff, context);
        await app.collab.activity(
            id,
            user,
            handoff === undefined
                ? "started a new context"
                : "started a new context with a handoff note",
        );
    }

    /**
     * Set what Pi is told in every request of a session, after its own system prompt: ground rules everyone here shares.
     * Empty text clears them. Subagents keep theirs: they say who the subagent is.
     */
    async setInstructions(id: ConversationId, user: User, text: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (app.sessionMeta(id) === undefined) {
            throw new HttpError(400, "Only sessions have instructions for Pi");
        }

        const instructions = (optionalText(text, "instructions") ?? "").trim();

        if (instructions.length > MAX_INSTRUCTIONS) {
            throw new HttpError(413, `Instructions are limited to ${MAX_INSTRUCTIONS} characters`);
        }

        const before = (await app.agentState(id))?.instructions ?? "";

        if (instructions === before) {
            return;
        }

        await (
            await app.conversation(id)
        ).configure({ instructions: instructions === "" ? null : instructions }, context);
        await app.collab.activity(
            id,
            user,
            instructions === ""
                ? "cleared the instructions for Pi"
                : "changed the instructions for Pi",
        );
    }

    /** Turn plan mode on or off: while it is on, Pi reads and proposes a plan, and anything that changes something is blocked. */
    async setPlan(id: ConversationId, user: User, on: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (typeof on !== "boolean") {
            throw new HttpError(400, "on must be true or false");
        }

        this.#requireSession(id);

        if (on && !app.loader.extensionNames().includes(PLAN_EXTENSION)) {
            throw new HttpError(409, "Plan mode is turned off in Extensions.");
        }

        if (await this.#switchPlan(id, user, on)) {
            await app.collab.activity(
                id,
                user,
                on ? "turned on plan mode" : "turned off plan mode",
            );
        }
    }

    /** Approve Pi's plan: plan mode goes off, and Pi is told to carry the plan out. */
    async approvePlan(id: ConversationId, user: User): Promise<{ submissionId: SubmissionId }> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        this.#requireSession(id);

        if (!(await this.#switchPlan(id, user, false))) {
            throw new HttpError(409, "Plan mode is not on.");
        }

        await app.collab.activity(id, user, "approved the plan");

        return this.submit(id, user, { text: PLAN_APPROVED, requestId: randomUUID() });
    }

    /** Plan mode is set for a whole session, not for one of its subagents. */
    #requireSession(id: ConversationId): void {
        if (this.#app.parentOf(id) !== undefined) {
            throw new HttpError(
                400,
                "Plan mode is set for the whole session, in its main conversation.",
            );
        }
    }

    /** Set plan mode for a session and the subagents under it; true when that changed it. */
    #switchPlan(id: ConversationId, user: User, on: boolean): Promise<boolean> {
        return this.#app.harness.commit(async (tx) => {
            if ((await tx.doc(PlanDoc, id)).on === on) {
                return false;
            }

            // Subagents follow their session: one already at work stops changing things too.
            const conversations = [id];

            for (let index = 0; index < conversations.length; index++) {
                for (const agent of Object.values(
                    (await tx.doc(SubagentsDoc, conversations[index]!)).agents,
                )) {
                    conversations.push(agent.conversationId);
                }
            }

            const at = Date.now();

            for (const each of conversations) {
                Object.assign(await tx.doc(PlanDoc, each), { on, by: user.id, at });
            }

            return true;
        }, context);
    }

    /** Set up a message to Pi for later, or on repeat: `when` is when, then what it says (`in 2h check the deploy`). */
    async schedule(
        id: ConversationId,
        user: User,
        request: { when?: unknown; zone?: unknown },
    ): Promise<Schedule> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const zone = optionalText(request.zone, "zone");

        if (zone !== undefined && !knownZone(zone)) {
            throw new HttpError(400, `Unknown time zone ${zone}`);
        }

        app.spend.check(user, id);
        const schedule = await app.schedules.add(id, {
            when: optionalText(request.when, "when") ?? "",
            by: user,
            ...(zone === undefined ? {} : { zone }),
        });
        const when =
            schedule.every === undefined
                ? `for ${describeMoment(schedule.next, schedule.zone)}`
                : describeRepeat(schedule.every);

        await app.collab.activity(id, user, `scheduled “${snippet(schedule.text, 60)}” ${when}`);

        return schedule;
    }

    async cancelSchedule(id: ConversationId, user: User, scheduleId: string): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const schedule = await app.schedules.cancel(id, scheduleId);

        if (schedule === undefined) {
            throw new HttpError(404, "No such scheduled message");
        }

        await app.collab.activity(
            id,
            user,
            `cancelled the scheduled “${snippet(schedule.text, 60)}”`,
        );
    }

    /** Watch the session's pull request (its branch's, or `pr`): Pi hears of failed checks, conflicts, and reviews. */
    async watchPr(id: ConversationId, user: User, pr: unknown): Promise<{ number: number }> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        app.spend.check(user, id);
        const asked = optionalText(pr, "pr");
        const watch = await app.watches.start(
            id,
            user.id,
            asked === undefined ? {} : { pr: asked },
        );

        await app.collab.activity(
            id,
            user,
            `started watching PR #${watch.number} “${snippet(watch.title, 60)}”`,
        );

        return { number: watch.number };
    }

    /** Stop watching the session's pull request, or clear a watch that ended. */
    async unwatchPr(id: ConversationId, user: User): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        const watch = await app.watches.stop(id);

        if (watch?.status === "watching") {
            await app.collab.activity(id, user, `stopped watching PR #${watch.number}`);
        }
    }

    /**
     * The webhooks a person may manage, each with where it sends (a session's title, or PiP), and the address other
     * services reach this server at, when it has a public one.
     */
    async hooks(user: User) {
        const app = this.#app;
        const hooks = (await app.hooks.list(user)).map((hook) => {
            const target = hook.target as unknown as ConversationId;
            const meta = app.sessionMeta(target);

            return {
                ...hook,
                // A session the person can no longer open keeps its title to itself.
                targetTitle:
                    meta?.pip !== undefined
                        ? "PiP"
                        : app.canSee(user, target)
                          ? (meta?.title ?? "New session")
                          : "a session you cannot open",
                pip: meta?.pip !== undefined,
            };
        });

        // Repository watches (`repo-watches.ts`), which PiP sets up: shown with the hooks, to see and remove.
        const repoWatches = (await app.repoWatches.list(user)).map((watch) => {
            const target = watch.target as unknown as ConversationId;
            const meta = app.sessionMeta(target);

            return {
                ...watch,
                targetTitle:
                    meta?.pip !== undefined
                        ? "PiP"
                        : app.canSee(user, target)
                          ? (meta?.title ?? "New session")
                          : "a session you cannot open",
                pip: meta?.pip !== undefined,
            };
        });

        return { hooks, repoWatches, base: app.access?.url ?? null };
    }

    /** Make a webhook that messages a session (or PiP) for this person. */
    async addHook(
        user: User,
        body: {
            target?: unknown;
            name?: unknown;
            instructions?: unknown;
            signed?: unknown;
            anyone?: unknown;
        },
    ) {
        const app = this.#app;
        // "pip": this person's PiP, made now if they have none yet.
        const target =
            body.target === "pip" && app.pip.available(user)
                ? Number(await app.pip.ensure(user))
                : Number(body.target);

        if (!Number.isSafeInteger(target) || target < 0) {
            throw new HttpError(400, "Say which session the webhook messages.");
        }

        const id = target as unknown as ConversationId;
        const hook = await app.hooks.add(user, id, body);

        if (app.sessionMeta(id)?.pip === undefined) {
            await app.collab.activity(id, user, `made the webhook “${snippet(hook.name, 60)}”`);
        }

        return hook;
    }

    async removeHook(user: User, hookId: string): Promise<void> {
        const app = this.#app;
        const hook = await app.hooks.remove(user, hookId);
        const target = hook.target as unknown as ConversationId;

        // No line where the remover can no longer go.
        if (
            app.sessionMeta(target) !== undefined &&
            app.sessionMeta(target)?.pip === undefined &&
            app.canSee(user, target)
        ) {
            await app.collab.activity(
                target,
                user,
                `removed the webhook “${snippet(hook.name, 60)}”`,
            );
        }
    }

    /** Pi keeps working until `command` passes, checked after each of its answers. */
    async setGoal(id: ConversationId, user: User, command: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (app.sessionMeta(id) === undefined) {
            throw new HttpError(400, "Only sessions can have a goal");
        }

        const goal = await app.goals.set(id, user.id, optionalText(command, "command") ?? "");

        await app.collab.activity(
            id,
            user,
            `set a goal: keep going until \`${snippet(goal.command, 80)}\` passes`,
        );
    }

    /** Drop the goal: Pi stops checking. Anyone who can steer may, as with stopping a run. */
    async clearGoal(id: ConversationId, user: User): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);
        const goal = await app.goals.get(id);

        if (!(await app.goals.clear(id)) || goal === undefined) {
            return;
        }

        if (goal.status === "working") {
            await app.collab.activity(
                id,
                user,
                `dropped the goal \`${snippet(goal.command, 80)}\``,
            );
        }
    }

    async fork(
        id: ConversationId,
        user: User,
        request: { entryId?: unknown; worktree?: unknown },
    ): Promise<{ id: ConversationId }> {
        this.#requireForkable(id, user);

        if (request.entryId === undefined) {
            return {
                id: await this.#branch(id, user, {
                    at: await this.#latestReply(id),
                    label: "fork",
                    worktree: request.worktree === true,
                }),
            };
        }

        const entryId = entryIdOf(request.entryId);
        const entry = await this.#app.transcripts.visibleEntry(id, entryId);

        if (entry === undefined) {
            throw new HttpError(404, "No such message");
        }

        // A fork goes on from one of Pi's replies. One that called tools would leave the fork waiting for their results.
        const reply = entry.model?.[0];

        if (
            entry.kind !== "pi.assistant" ||
            (reply?.role === "assistant" && reply.stopReason === "toolUse")
        ) {
            throw new HttpError(400, "Fork from one of Pi's finished replies.");
        }

        return {
            id: await this.#branch(id, user, {
                at: entryId,
                label: "fork",
                worktree: request.worktree === true,
            }),
        };
    }

    /**
     * Send one of this session's messages again in a fork that ends just before it: edited (`text`), or as it was, maybe
     * to another model (`model`). The original stays as it is.
     */
    async resend(
        id: ConversationId,
        user: User,
        request: { entryId?: unknown; text?: unknown; model?: unknown; worktree?: unknown },
    ): Promise<{ id: ConversationId }> {
        const app = this.#app;

        this.#requireForkable(id, user);
        const entryId = entryIdOf(request.entryId);
        const edited = optionalText(request.text, "text")?.trim();
        const asked = request.model as { provider?: unknown; modelId?: unknown } | undefined;

        checkModel(asked);

        const entry = await app.transcripts.visibleEntry(id, entryId);

        if (entry?.kind !== "pi.user") {
            throw new HttpError(404, "No such message to Pi");
        }

        app.spend.check(user, id);
        const source = await app.agentState(id);
        const ref =
            asked === undefined
                ? source?.model
                : { provider: asked.provider as string, modelId: asked.modelId as string };
        const model =
            ref === undefined ? undefined : app.models.getModel(ref.provider, ref.modelId);

        if (ref === undefined || model === undefined) {
            throw new HttpError(
                400,
                ref === undefined
                    ? "Pick a model first."
                    : `Unknown model ${ref.provider}/${ref.modelId}`,
            );
        }

        const original = userContent(entry.model?.[0]);
        // Who sent it comes first, then the heading, whole or (from before 0.14.0) without its blank line.
        const [written, files] = splitAttachments(original.text.replace(FROM_PREFIX, ""));
        // An edit that changes nothing is the same as sending the message again.
        const edit =
            edited !== undefined && edited !== written.trim()
                ? app.hidden.replace(edited, id)
                : undefined;

        if (edit === "" && files === undefined) {
            throw new HttpError(400, "Nothing to send");
        }

        // Sent again, edited or not, the message is from whoever sent it again, with the original's files attached: what
        // Pi does next is on them.
        const body = edit ?? written.trim();
        const text = this.messageText(
            user,
            files === undefined ? body : `${body}${ATTACHMENTS_HEADING}${files}`,
        );
        const author =
            (await app.harness.snapshot(AuthorsDoc, id, context))?.entries[String(entryId)] ??
            user.id;
        const images = model.input.includes("image") ? original.images : [];
        const resend: Resend = {
            text,
            by: user.id,
            ...(images.length === 0 ? {} : { images: { entry: entryId as unknown as EntryId } }),
        };

        const previous = (
            await (
                await app.conversation(id)
            ).entries({ maxEntryId: (entryId - 1) as unknown as EntryId }, 1, undefined, context)
        ).items[0];
        const agent: AgentChange = {
            model: ref,
            thinkingLevel: clampThinkingLevel(
                model,
                (source?.thinkingLevel ?? "off") as ModelThinkingLevel,
            ),
        };
        const label = edit !== undefined ? "edit" : asked !== undefined ? model.name : "retry";
        const forked = await this.#branch(id, user, {
            at: previous?.id as unknown as number | undefined,
            label,
            agent,
            worktree: request.worktree === true,
            resend,
        });
        const submission = await (
            await app.conversation(forked)
        ).submit(
            {
                type: "input",
                content: resendContent(text, images),
                requestId: resendRequest(resend),
            },
            context,
        );
        const whose =
            author === user.id
                ? "a message"
                : `${app.config.userById(author)?.name ?? "someone"}’s message`;
        const line =
            edit !== undefined
                ? "edited a message and sent it again"
                : asked !== undefined
                  ? `sent ${whose} again to ${model.name}`
                  : `sent ${whose} again`;

        await app.collab.activity(forked, user, line, false);
        this.#reportUnanswered(forked, submission.wait(context));

        return { id: forked };
    }

    /** A reply that called tools is not finished: a fork from it would wait for their results. */
    async #latestReply(id: ConversationId): Promise<number | undefined> {
        const conversation = await this.#app.conversation(id);
        let cursor: Cursor | undefined;

        do {
            const page = await conversation.entries({}, 64, cursor, context);

            for (const entry of page.items) {
                const reply = entry.model?.[0];

                if (
                    entry.kind === "pi.assistant" &&
                    !(reply?.role === "assistant" && reply.stopReason === "toolUse")
                ) {
                    return Number(entry.id);
                }
            }

            cursor = page.next;
        } while (cursor !== undefined);

        return undefined;
    }

    /** Forks are new sessions: who may start one may fork, from a session they can see. */
    #requireForkable(id: ConversationId, user: User): void {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session and cannot start new ones.");
        }

        if (app.sessionMeta(id) === undefined) {
            throw new HttpError(400, "Only sessions can be forked");
        }

        // A fork would carry PiP's tools and none of PiP: they act as PiP's person, which a fork is not.
        if (app.sessionMeta(id)?.pip !== undefined) {
            throw new HttpError(400, "PiP's conversation cannot be forked. Start fresh instead.");
        }
    }

    /**
     * Start a session from this one's history through entry `at`, or from none of it, named after this one with
     * `label`; in a git worktree of its own when asked.
     */
    async #branch(
        id: ConversationId,
        user: User,
        branch: {
            at: number | undefined;
            label: string;
            agent?: AgentChange;
            worktree: boolean;
            resend?: Resend;
        },
    ): Promise<ConversationId> {
        const app = this.#app;
        const meta = app.sessionMeta(id)!;
        const source = await app.agentState(id);
        const sourceTitle = meta.title ?? "New session";
        const title = `${sourceTitle} · ${branch.label}`.slice(0, MAX_TITLE);

        return this.#inPlace(source?.cwd ?? meta.cwd, branch.worktree, title, (place) =>
            this.#fork(id, user, { ...branch, title, sourceTitle, place }),
        );
    }

    /**
     * Make the fork in `place`. It starts its own chat, with the pins of messages it inherited; both sessions get an
     * activity line about it. With `resend`, the fork comes with the task that sends that message.
     */
    async #fork(
        id: ConversationId,
        user: User,
        fork: {
            at: number | undefined;
            title: string;
            sourceTitle: string;
            agent?: AgentChange;
            place: Place;
            resend?: Resend;
        },
    ): Promise<ConversationId> {
        const app = this.#app;
        const source = await app.agentState(id);
        const { at, title, place } = fork;
        const agent: AgentChange = {
            ...fork.agent,
            ...(place.worktree === undefined ? {} : { cwd: place.cwd }),
        };
        const now = Date.now();
        // A new session rather than a fork gets plan mode and the notes by hand.
        const plan =
            at === undefined ? await app.harness.snapshot(PlanDoc, id, context) : undefined;
        const notes =
            at === undefined ? await app.harness.snapshot(NotesDoc, id, context) : undefined;

        const init: ConversationCreateOptions["init"] = async (tx, forked) => {
            const sessions = await tx.doc(SessionsDoc);

            sessions.items[String(forked)] = {
                cwd: place.cwd,
                title,
                createdAt: now,
                updatedAt: now,
                createdBy: user.id,
                forkedFrom: { id: Number(id), ...(at === undefined ? {} : { entryId: at }) },
                ...(place.worktree === undefined ? {} : { worktree: place.worktree }),
            };

            if (fork.resend !== undefined) {
                await tx.createTask(ResendTask, fork.resend, {
                    ownership: { kind: "conversation" },
                    background: true,
                    conversationId: forked,
                });
            }

            if (at === undefined) {
                if (plan !== undefined) {
                    Object.assign(await tx.doc(PlanDoc, forked), structuredClone(plan));
                }

                if (notes !== undefined) {
                    Object.assign(await tx.doc(NotesDoc, forked), structuredClone(notes));
                }

                return;
            }

            // A fork copies its parent's documents. The chat is the parent's conversation, not this one's.
            const chat = await tx.doc(ChatDoc, forked);

            chat.messages.splice(0);
            const pins = await tx.doc(PinsDoc, forked);

            for (let index = pins.items.length - 1; index >= 0; index--) {
                const pin = pins.items[index]!;

                if (pin.entryId === undefined || pin.entryId > at) {
                    pins.items.splice(index, 1);
                }
            }

            // Authors of the parent's later messages did not take part here.
            const authors = await tx.doc(AuthorsDoc, forked);

            for (const entryId of Object.keys(authors.entries)) {
                if (Number(entryId) > at) {
                    delete authors.entries[entryId];
                }
            }
        };

        const ownership = { kind: "ownerless" } as const;
        const forked =
            at === undefined
                ? // Before the first message there is nothing to fork: a new session that runs like this one.
                  await app.harness.createConversation(
                      {
                          ownership,
                          agent: {
                              ...(source?.model === undefined ? {} : { model: source.model }),
                              ...(source?.thinkingLevel === undefined
                                  ? {}
                                  : { thinkingLevel: source.thinkingLevel }),
                              ...(source?.instructions === undefined
                                  ? {}
                                  : { instructions: source.instructions }),
                              cwd: place.cwd,
                              ...agent,
                          },
                          init,
                      },
                      context,
                  )
                : await (
                      await app.conversation(id)
                  ).fork(at as unknown as EntryId, { ownership, agent, init }, context);
        const where =
            place.worktree === undefined
                ? ""
                : ` into a worktree on ${place.worktree.branch}${place.skipped.length === 0 ? "" : ` (${place.skipped.length} big new files were not copied)`}`;

        await app.collab.activity(
            forked.id,
            user,
            `forked this from “${fork.sourceTitle}”${where}`,
            false,
        );
        await app.collab.activity(id, user, `forked “${title}” from this session${where}`, false);

        return forked.id;
    }

    async compact(id: ConversationId, user: User, instructions: string | undefined): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);
        // PiP's summaries are its own, written by its extension's hook with outside text left out: while PiP is off,
        // there is no hook, and Pi Durable's summary would read what came from outside as it is.
        const pip = app.pip.ownerOf(id) !== undefined;

        if (pip && !app.pip.available(user)) {
            throw new HttpError(409, "PiP is turned off in Extensions.");
        }

        // Compacting asks the model for a summary, which costs like any other request.
        app.spend.check(user, id);
        const conversation = await app.conversation(id);
        const taskId = await conversation.compact(instructions, context);
        const done = pip ? "PiP's context compacted." : "Compacted.";

        app.notice("info", pip ? "Compacting PiP's context…" : "Compacting…", id);
        await app.collab.activity(id, user, "started compacting the context", false);
        void app.harness.waitForTask(taskId, context).then(
            (receipt) => {
                const outcome = receipt.state.outcome;

                if (outcome.status === "completed") {
                    const { entryId, submissionId } = outcome.result;
                    // PiP's own summary could not be written: it declined, rather than let Pi Durable write one.
                    const failed = pip ? app.pipCompaction.failure(Number(taskId)) : undefined;

                    if (failed !== undefined) {
                        app.notice("error", `PiP's context was not compacted: ${failed}`, id);
                    } else {
                        app.notice(
                            "info",
                            entryId === undefined && submissionId === undefined
                                ? "Nothing to compact: the context fits in the recent window."
                                : done,
                            id,
                        );
                    }
                } else if (outcome.status === "aborted") {
                    app.notice("info", "Compaction aborted.", id);
                } else {
                    const why = "error" in outcome ? outcome.error?.message : undefined;

                    app.notice("error", `Compaction ${outcome.status}${why ? `: ${why}` : ""}`, id);
                }
            },
            (error: unknown) => app.notice("error", describe(error), id),
        );
    }
}
