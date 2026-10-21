/**
 * Memory: short lessons Pi keeps across sessions, each for one project or for everywhere, and linked to the session it
 * came from. A project is a git repository with all its worktrees (they share one git folder), or a folder outside
 * any repository. Pi saves lessons with its memory tool and gets those that apply in its system prompt
 * (`extensions/memory.ts`); people see, add, change, and remove them in the Memory sheet.
 *
 * A lesson added or changed for someone who is not the owner waits for the owner's approval before Pi uses it: a guest
 * could otherwise write instructions into every later session.
 */
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { addActivity } from "./collab.ts";
import type { User } from "./config.ts";
import { ChatDoc, type Lesson, MemoryDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import { INVISIBLE_CLASS } from "./fence.ts";
import { git } from "./git.ts";
import { snippet } from "./projection.ts";

const context: Context = BACKGROUND_CONTEXT;

/** Memory's extension: the tool and the prompt section. */
export const MEMORY_EXTENSION = "pocket-memory";
/** How long a lesson may be. */
export const MAX_LESSON = 300;
/** Lessons a project keeps, and lessons for everywhere, approved ones: pending ones do not take their room. */
export const MAX_PROJECT_LESSONS = 40;
export const MAX_EVERYWHERE_LESSONS = 30;
/** Lessons waiting for approval that one person (or Pi for them) may have, so nobody fills the owner's list. */
export const MAX_PENDING = 20;
/** How long a folder's project is kept before git is asked again (a folder can become a repository). */
const PROJECT_FOR_MS = 60_000;

export type Project = { key: string; name: string };
export type LessonScope = "project" | "everywhere";

/** Who writes: a person, or Pi working for one (`userId` undefined when nobody is known). */
export type Writer = { userId: string | undefined; byPi: boolean; name: string };

/** A lesson as a person's Memory sheet shows it. */
export type LessonView = {
    id: string;
    text: string;
    scope: LessonScope;
    /** The lesson's project label in the owner's all-project pending queue. */
    projectName?: string;
    byPi: boolean;
    by: string;
    byName: string;
    createdAt: number;
    updatedAt?: number;
    pending: boolean;
    /** The session it came from, when this person may see it. */
    from?: { id: number; title: string };
    /** Whether this person may change or remove it. */
    mine: boolean;
    /** A change that waits for the owner, for the owner and whoever proposed it to see. */
    proposal?: { text?: string; forget?: boolean; byPi: boolean; byName: string; mine: boolean };
};

export type MemoryView = {
    /** Present only for the all-project pending queue, so an older server's scoped view is not mistaken for it. */
    pendingAll?: true;
    /** This session's project; null for PiP or the all-project pending queue. */
    project: { name: string } | null;
    lessons: LessonView[];
    owner: boolean;
    canWrite: boolean;
    limits: { project: number; everywhere: number; text: number };
};

/** A plain copy of a lesson out of a commit's document. */
const copy = (lesson: Lesson): Lesson => JSON.parse(JSON.stringify(lesson)) as Lesson;
/**
 * Characters nobody sees: controls, format characters (zero-width, bidi, tags), lone surrogates, private use,
 * unassigned, the variation selectors, and the blank letters (Hangul fillers, the braille blank). The owner approves the
 * text they see, so Pi must read no other.
 */
const INVISIBLE = new RegExp("[" + INVISIBLE_CLASS + "]", "gu");

/** Text on one line with nothing hidden: whitespace first, so a newline becomes a space before controls go. */
export const flat = (text: string) =>
    text.replace(/\s+/g, " ").replace(INVISIBLE, "").replace(/ {2,}/g, " ").trim();
/** A folder's name as Pi's prompt and the sheet show it. */
// Cut by code points, so an emoji at the 80th is kept whole, not halved into a lone surrogate.
const cut = (text: string) => Array.from(text).slice(0, 80).join("");
const named = (name: string, key: string) => cut(flat(name)) || cut(flat(key));
const ordered = (lessons: Lesson[]) =>
    lessons.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

/** The project a folder belongs to: its repository's shared git folder, or the folder itself. */
async function projectOf(cwd: string): Promise<Project> {
    const folder = await realpath(cwd).catch(() => resolve(cwd));
    const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .catch(() => git(folder, ["rev-parse", "--git-common-dir"]))
        .then(
            (out) => out.trim(),
            () => "",
        );

    if (common === "") {
        return { key: folder, name: named(basename(folder), folder) };
    }

    const key = await realpath(resolve(folder, common)).catch(() => resolve(folder, common));
    // `repo/.git` is named for `repo`; a bare repository (`repo.git`) for itself.
    const name =
        basename(key) === ".git" ? basename(dirname(key)) : basename(key).replace(/\.git$/, "");

    return { key, name: named(name, key) };
}

export class Memory {
    readonly #app: PocketApp;
    readonly #projects = new Map<string, { at: number; project: Promise<Project> }>();
    #timer: NodeJS.Timeout | undefined;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The project of a conversation working in `cwd`; undefined for PiP, which has lessons for everywhere only. */
    async project(
        conversationId: ConversationId,
        cwd: string | undefined,
    ): Promise<Project | undefined> {
        const app = this.#app;

        if (app.sessionMeta(app.rootOf(conversationId))?.pip !== undefined) {
            return undefined;
        }

        const folder = cwd ?? app.cwdOf(conversationId);

        const now = this.#app.now();
        let cached = this.#projects.get(folder);

        if (cached === undefined || now - cached.at > PROJECT_FOR_MS) {
            cached = { at: now, project: projectOf(folder) };
            this.#projects.set(folder, cached);
        }

        return cached.project;
    }

    async #all(): Promise<Lesson[]> {
        const doc = await this.#app.harness.snapshot(MemoryDoc, context);

        return Object.values(doc?.items ?? {});
    }

    /** The lessons that apply in a project (and everywhere's), oldest first, pending ones included. */
    async applying(project: Project | undefined): Promise<Lesson[]> {
        return ordered(
            (await this.#all()).filter(
                (lesson) => lesson.project === undefined || lesson.project === project?.key,
            ),
        );
    }

    /** What Pi's prompt has: the lessons in force for a conversation working in `cwd`, and its project. */
    async inForce(
        conversationId: ConversationId,
        cwd: string | undefined,
    ): Promise<{ project: Project | undefined; lessons: Lesson[] }> {
        const project = await this.project(conversationId, cwd);
        const lessons = (await this.applying(project)).filter((lesson) => lesson.pending !== true);

        return { project, lessons };
    }

    #isOwner(userId: string | undefined): boolean {
        return userId !== undefined && this.#app.config.userById(userId)?.role === "owner";
    }

    /**
     * Whether a write waits for the owner: every one of Pi's, and every one of someone who is not the owner. What Pi
     * read (a web page, a post, a comment, a file) can talk it into "a lesson", and a lesson reaches every later session:
     * Pi proposes, the owner approves.
     */
    #held(writer: Writer): boolean {
        return writer.byPi || !this.#isOwner(writer.userId);
    }

    /** A 409 when a project's (or everywhere's) approved lessons are full. */
    #roomFor(
        doc: { items: Record<string, Lesson> },
        lesson: Pick<Lesson, "project" | "projectName">,
    ) {
        const max = lesson.project === undefined ? MAX_EVERYWHERE_LESSONS : MAX_PROJECT_LESSONS;
        const kept = Object.values(doc.items).filter(
            (item) => item.project === lesson.project && item.pending !== true,
        ).length;

        if (kept >= max) {
            throw new HttpError(
                409,
                `${lesson.project === undefined ? "Lessons for everywhere" : `${lesson.projectName ?? "This project"}'s lessons`} are full (${String(max)}): forget one first, or fold two into one.`,
            );
        }
    }

    #mayChange(lesson: Lesson, userId: string | undefined): boolean {
        return this.#isOwner(userId) || (userId !== undefined && lesson.by === userId);
    }

    /** Cross-project review is for the human owner in their private PiP, before reading any lesson or writing activity. */
    #requirePendingOwner(writer: Writer, conversationId: ConversationId): void {
        if (writer.byPi || !this.#isOwner(writer.userId)) {
            throw new HttpError(403, "Only the owner can review all pending lessons.");
        }

        if (this.#app.sessionMeta(this.#app.rootOf(conversationId))?.pip !== writer.userId) {
            throw new HttpError(403, "Review all pending lessons from your private PiP.");
        }
    }

    /** A lesson that applies here (or anywhere for an authorized pending review), or a 404. */
    #find(
        doc: { items: Record<string, Lesson> },
        project: Project | undefined,
        id: string,
        allProjects = false,
    ): Lesson {
        const key = id.trim().replace(/^\[|\]$/g, "");
        // Own keys only: `constructor` or `__proto__` is no lesson.
        const lesson = Object.hasOwn(doc.items, key) ? doc.items[key] : undefined;

        if (
            lesson === undefined ||
            (!allProjects && lesson.project !== undefined && lesson.project !== project?.key)
        ) {
            throw new HttpError(404, `There is no lesson ${id} here.`);
        }

        return lesson;
    }

    /** A line in the session's chat, as people see the rest of what changes. */
    async #activity(tx: Tx, conversationId: ConversationId, writer: Writer, text: string) {
        const root = this.#app.rootOf(conversationId);

        addActivity(
            await tx.doc(ChatDoc, root),
            writer.byPi
                ? { id: "pi", name: "Pi" }
                : { id: writer.userId ?? "someone", name: writer.name },
            text,
        );
    }

    #text(text: unknown): string {
        if (typeof text !== "string" || flat(text) === "") {
            throw new HttpError(400, "Say what to remember.");
        }

        const lesson = flat(text);

        if (lesson.length > MAX_LESSON) {
            throw new HttpError(
                413,
                `A lesson is ${String(MAX_LESSON)} characters at most (this one is ${String(lesson.length)}): make it shorter.`,
            );
        }

        return lesson;
    }

    /**
     * Save a lesson. The same `key` saves it once: a tool call run again finds the one it made. Throws an HttpError a
     * person (or Pi) can act on when it will not do.
     */
    async add(
        conversationId: ConversationId,
        cwd: string | undefined,
        writer: Writer,
        request: { text: unknown; scope: LessonScope; key?: string },
    ): Promise<Lesson> {
        const app = this.#app;
        const text = this.#text(request.text);
        const project =
            request.scope === "project" ? await this.project(conversationId, cwd) : undefined;
        const root = app.rootOf(conversationId);
        const meta = app.sessionMeta(root);
        const by = writer.userId ?? meta?.createdBy ?? "";
        const pending = this.#held(writer);

        return app.harness.commit(async (tx) => {
            const doc = await tx.doc(MemoryDoc);
            const items = Object.values(doc.items);
            const same =
                request.key === undefined
                    ? undefined
                    : items.find((item) => item.key === request.key);

            if (same !== undefined) {
                return copy(same);
            }

            if (
                pending &&
                items.filter((item) => item.pending === true && item.by === by).length >=
                    MAX_PENDING
            ) {
                throw new HttpError(
                    409,
                    `${String(MAX_PENDING)} lessons wait for the owner's approval already: wait for them first.`,
                );
            }

            if (!pending) {
                this.#roomFor(doc, {
                    ...(project === undefined
                        ? {}
                        : { project: project.key, projectName: project.name }),
                });
            }

            let id = randomUUID().slice(0, 5);

            while (Object.hasOwn(doc.items, id)) {
                id = randomUUID().slice(0, 5);
            }

            const lesson: Lesson = {
                id,
                text,
                ...(project === undefined
                    ? {}
                    : { project: project.key, projectName: project.name }),
                ...(meta === undefined
                    ? {}
                    : { from: { conversationId: Number(root), title: meta.title ?? "Untitled" } }),
                by,
                byPi: writer.byPi,
                createdAt: this.#app.now(),
                ...(pending ? { pending: true } : {}),
                ...(request.key === undefined ? {} : { key: request.key }),
            };

            doc.items[id] = lesson;
            await this.#activity(
                tx,
                conversationId,
                writer,
                `saved a lesson for ${project === undefined ? "everywhere" : project.name}: “${snippet(text, 80)}”${pending ? ", for the owner to approve" : ""}`,
            );

            return copy(lesson);
        }, context);
    }

    /**
     * Change a lesson's text or forget it; approve or discard what waits. Only the owner, or whoever saved a lesson,
     * changes or forgets it; only the owner approves. A change from Pi or a guest to a lesson in force is a proposal:
     * the lesson stays as it is until the owner approves it. One that waits anyway changes as it is.
     *
     * An approval says what the owner saw (`expected`): what waits can change between their look and their tap, so
     * approving holds only when it would make true what they saw. `pendingOnly` is a cross-project review mode for the
     * human owner in their private PiP, limited to approving or discarding lessons that still wait; the Pi tool never sets it.
     */
    async change(
        conversationId: ConversationId,
        cwd: string | undefined,
        writer: Writer,
        id: string,
        change: { text: unknown } | "remove" | "approve" | "discard",
        expected?: { text?: string; forget?: boolean },
        pendingOnly = false,
    ): Promise<Lesson> {
        const app = this.#app;

        // Never let Pi, a guest, or a shared-session review use the cross-project lookup.
        if (pendingOnly) {
            this.#requirePendingOwner(writer, conversationId);

            if (change !== "approve" && change !== "discard") {
                throw new HttpError(400, "The pending queue only approves or discards lessons.");
            }
        }

        const text = typeof change === "object" ? this.#text(change.text) : undefined;
        const project = pendingOnly ? undefined : await this.project(conversationId, cwd);
        const said = (tx: Tx, line: string) => this.#activity(tx, conversationId, writer, line);

        return app.harness.commit(async (tx) => {
            const doc = await tx.doc(MemoryDoc);

            if (pendingOnly) {
                // Recheck after waiting for the transaction: a person's role may have changed meanwhile.
                this.#requirePendingOwner(writer, conversationId);
            }

            const lesson = this.#find(doc, project, id, pendingOnly);

            if (pendingOnly && lesson.pending !== true && lesson.proposal === undefined) {
                throw new HttpError(409, "This lesson changed since you looked: check it again.");
            }

            const before = copy(lesson);
            const quoted = `“${snippet(lesson.text, 80)}”`;
            const owner = !writer.byPi && this.#isOwner(writer.userId);

            if (change === "approve") {
                if (!owner) {
                    throw new HttpError(403, "Only the owner approves lessons.");
                }

                // What approving makes true; with nothing waiting, the text in force, so a second tap does nothing.
                const waiting =
                    lesson.pending !== true && lesson.proposal?.forget === true
                        ? { forget: true }
                        : {
                              text:
                                  lesson.pending !== true && lesson.proposal?.text !== undefined
                                      ? lesson.proposal.text
                                      : lesson.text,
                          };

                if (
                    expected === undefined ||
                    (expected.forget === true) !== (waiting.forget === true) ||
                    (waiting.forget !== true && expected.text !== waiting.text)
                ) {
                    throw new HttpError(
                        409,
                        "This lesson changed since you looked: check it again.",
                    );
                }

                if (lesson.pending === true) {
                    this.#roomFor(doc, lesson);
                    delete lesson.pending;
                    await said(tx, `approved the lesson ${quoted}`);
                } else if (lesson.proposal?.forget === true) {
                    delete doc.items[lesson.id];
                    await said(tx, `approved forgetting the lesson ${quoted}`);

                    return before;
                } else if (lesson.proposal?.text !== undefined) {
                    lesson.text = lesson.proposal.text;
                    lesson.updatedAt = app.now();
                    delete lesson.proposal;
                    await said(tx, `approved a lesson's new text: “${snippet(lesson.text, 80)}”`);
                }

                return copy(lesson);
            }

            if (change === "discard") {
                const proposer = lesson.proposal?.by;
                const own = (by: string | undefined) =>
                    !writer.byPi && by !== undefined && by === writer.userId;

                if (lesson.pending === true && (owner || own(lesson.by))) {
                    delete doc.items[lesson.id];
                    await said(tx, `discarded the lesson ${quoted}`);

                    return before;
                }

                if (lesson.proposal !== undefined && (owner || own(proposer))) {
                    delete lesson.proposal;
                    await said(tx, `kept the lesson ${quoted} as it was`);

                    return copy(lesson);
                }

                throw new HttpError(403, "Only the owner, or whoever asked, can discard this.");
            }

            if (!this.#mayChange(lesson, writer.userId)) {
                throw new HttpError(
                    403,
                    "Only the owner, or whoever saved it, can change or forget this lesson.",
                );
            }

            const held = this.#held(writer);
            const inForce = lesson.pending !== true;

            if (change === "remove") {
                // Forgetting one's own (or one nobody uses yet) goes at once; Pi's forgetting one in force is a proposal.
                if (inForce && writer.byPi) {
                    if (lesson.proposal?.forget !== true) {
                        lesson.proposal = {
                            forget: true,
                            by: writer.userId ?? lesson.by,
                            byPi: true,
                            at: app.now(),
                        };
                        await said(
                            tx,
                            `proposed forgetting the lesson ${quoted}, for the owner to approve`,
                        );
                    }

                    return copy(lesson);
                }

                delete doc.items[lesson.id];
                await said(tx, `forgot the lesson ${quoted}`);

                return before;
            }

            if (inForce && held) {
                // Back to the text in force: nothing to propose. The writer's own proposal goes (it changed its mind);
                // someone else's stays for the owner.
                if (text === lesson.text) {
                    const proposal = lesson.proposal;

                    if (
                        proposal !== undefined &&
                        proposal.by === (writer.userId ?? lesson.by) &&
                        proposal.byPi === writer.byPi
                    ) {
                        delete lesson.proposal;
                        await said(tx, `withdrew the proposal for the lesson ${quoted}`);
                    }

                    return copy(lesson);
                }

                if (lesson.proposal?.text !== text) {
                    lesson.proposal = {
                        text: text!,
                        by: writer.userId ?? lesson.by,
                        byPi: writer.byPi,
                        at: app.now(),
                    };
                    await said(
                        tx,
                        `proposed new text for the lesson ${quoted}: “${snippet(text!, 80)}”, for the owner to approve`,
                    );
                }

                return copy(lesson);
            }

            if (text === lesson.text && (held || inForce)) {
                return before;
            }

            // The owner's own edit is in force at once: of a lesson waiting, it approves it too.
            if (!held && !inForce) {
                this.#roomFor(doc, lesson);
                delete lesson.pending;
            }

            lesson.text = text!;
            lesson.updatedAt = app.now();
            delete lesson.proposal;
            await said(
                tx,
                `changed a lesson to “${snippet(lesson.text, 80)}”${lesson.pending === true ? ", for the owner to approve" : ""}`,
            );

            return copy(lesson);
        }, context);
    }

    // ─── People ────────────────────────────────────────────────────────────

    #person(user: User): Writer {
        return { userId: user.id, byPi: false, name: user.name };
    }

    /** The session's lessons, or the human owner's pending lessons across all projects and everywhere in their private PiP. */
    async view(id: ConversationId, user: User, pendingOnly = false): Promise<MemoryView> {
        const app = this.#app;

        if (pendingOnly) {
            this.#requirePendingOwner(this.#person(user), id);
        }

        app.requireSee(user, id);
        const owner = user.role === "owner";
        const project = pendingOnly ? undefined : await this.project(id, app.cwdOf(id));
        const applying = pendingOnly
            ? ordered(
                  (await this.#all()).filter(
                      (lesson) => lesson.pending === true || lesson.proposal !== undefined,
                  ),
              )
            : await this.applying(project);
        const lessons = applying
            .filter((lesson) => lesson.pending !== true || owner || lesson.by === user.id)
            .map((lesson): LessonView => {
                const from = lesson.from;
                const source =
                    from === undefined
                        ? undefined
                        : (from.conversationId as unknown as ConversationId);
                const seen = source !== undefined && app.sessionMeta(source) !== undefined;

                return {
                    id: lesson.id,
                    text: lesson.text,
                    scope: lesson.project === undefined ? "everywhere" : "project",
                    ...(pendingOnly && lesson.projectName !== undefined
                        ? { projectName: lesson.projectName }
                        : {}),
                    byPi: lesson.byPi,
                    by: lesson.by,
                    byName: app.config.userById(lesson.by)?.name ?? "someone",
                    createdAt: lesson.createdAt,
                    ...(lesson.updatedAt === undefined ? {} : { updatedAt: lesson.updatedAt }),
                    pending: lesson.pending === true,
                    ...(seen && app.canSee(user, source)
                        ? {
                              from: {
                                  id: from!.conversationId,
                                  title: app.sessionMeta(source)?.title ?? from!.title,
                              },
                          }
                        : {}),
                    mine:
                        !pendingOnly && user.role !== "viewer" && this.#mayChange(lesson, user.id),
                    ...(lesson.proposal !== undefined && (owner || lesson.proposal.by === user.id)
                        ? {
                              proposal: {
                                  ...(lesson.proposal.text === undefined
                                      ? {}
                                      : { text: lesson.proposal.text }),
                                  ...(lesson.proposal.forget === true ? { forget: true } : {}),
                                  byPi: lesson.proposal.byPi,
                                  byName:
                                      app.config.userById(lesson.proposal.by)?.name ?? "someone",
                                  mine: !pendingOnly && lesson.proposal.by === user.id,
                              },
                          }
                        : {}),
                };
            });

        return {
            ...(pendingOnly ? { pendingAll: true as const } : {}),
            project: project === undefined ? null : { name: project.name },
            lessons,
            owner,
            canWrite: !pendingOnly && user.role !== "viewer",
            limits: {
                project: MAX_PROJECT_LESSONS,
                everywhere: MAX_EVERYWHERE_LESSONS,
                text: MAX_LESSON,
            },
        };
    }

    /** A person saves a lesson by hand. */
    async remember(
        id: ConversationId,
        user: User,
        request: { text?: unknown; scope?: unknown },
    ): Promise<Lesson> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        return this.add(id, app.cwdOf(id), this.#person(user), {
            text: request.text,
            scope: request.scope === "everywhere" ? "everywhere" : "project",
        });
    }

    /** A person changes, forgets, or approves a lesson; an approval says what they saw (see `change`). */
    async edit(
        id: ConversationId,
        user: User,
        lessonId: string,
        change: { text: unknown } | "remove" | "approve" | "discard",
        expected?: { text?: string; forget?: boolean },
        pendingOnly = false,
    ): Promise<Lesson> {
        const app = this.#app;

        if (pendingOnly) {
            this.#requirePendingOwner(this.#person(user), id);
        }

        app.requireSee(user, id);
        app.requireSteer(user);

        return this.change(
            id,
            app.cwdOf(id),
            this.#person(user),
            lessonId,
            change,
            expected,
            pendingOnly,
        );
    }

    // ─── Tabs ──────────────────────────────────────────────────────────────

    /** Lessons changed: tabs showing them fetch them again. */
    committed(): void {
        if (this.#timer !== undefined) {
            return;
        }

        this.#timer = setTimeout(() => {
            this.#timer = undefined;

            for (const client of this.#app.clients) {
                client.send("memory", {});
            }
        }, 200);
        this.#timer.unref();
    }
}
