/**
 * Archived sessions cleaned up by the owner (`extensions/session-cleanup.ts` is their way to it). Cleaning up removes
 * the worktrees of archived sessions; their transcripts stay. Removing takes a session out of the app: its work ends,
 * its webhooks, repository watches, shares, and lessons go, and Pocket's own files of it are removed (its worktree, its
 * uploads, its background logs). The transcript stays in storage: Pi Durable cannot purge a conversation yet, and
 * Pocket never writes to its tables. `pocket.deleted` keeps each removed session, the queue for such a purge.
 *
 * A removal is one commit (the catalogue entry goes as the queue entry comes), then the files. A restart between them
 * goes on with the files (`resume`), so nothing is left half done.
 */
import { lstat, opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import {
    ArtifactSharesDoc,
    DeletedDoc,
    HooksDoc,
    MemoryDoc,
    type RemovedSession,
    RepoWatchesDoc,
    SessionsDoc,
} from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { git } from "./git.ts";
import { sessionKey } from "./memory.ts";
import { inWorktree, removeWorktree, type Worktree } from "./worktrees.ts";

const context = BACKGROUND_CONTEXT;

/** The most files a size counts in one folder tree: a huge one shows as at least that much. */
const MAX_COUNTED = 200_000;

/** How many sessions one request may name. */
export const MAX_SESSIONS = 500;

/**
 * A session's worktree, as cleaning up finds it: `clean` goes; `changes` has uncommitted changes and stays; `shared`
 * is where another session works, and stays; `busy` is where Pi works now.
 */
export type WorktreeState = "clean" | "changes" | "shared" | "busy";

/** What cleaning up or removing a session would do. */
export type SessionPlan = {
    id: number;
    title: string;
    updatedAt: number;
    archived: boolean;
    /** Why it cannot be removed now; absent: it can. */
    blocked?: string;
    worktree?: { path: string; branch: string; bytes: number; state: WorktreeState };
    /** Its uploads; `kept`: a live fork reads them, so they stay. */
    uploads: { bytes: number; kept: boolean };
    /** Its background logs. */
    logs: number;
    /** What a removal ends. */
    ends: {
        schedules: number;
        background: number;
        prWatch: boolean;
        hooks: number;
        repoWatches: number;
        shares: number;
        lessons: number;
    };
};

export type CleanupOutcome = { id: number; done: boolean; why?: string; bytes?: number };

/** The bytes of the files under `path`, links not followed: 0 when it is not there. */
async function sizeOf(path: string): Promise<number> {
    let bytes = 0;
    let counted = 0;

    const walk = async (folder: string): Promise<void> => {
        let dir;

        try {
            dir = await opendir(folder);
        } catch {
            return;
        }

        for await (const entry of dir) {
            if (++counted > MAX_COUNTED) {
                return;
            }

            const full = join(folder, entry.name);

            if (entry.isDirectory()) {
                await walk(full);
            } else {
                bytes += (await lstat(full).catch(() => undefined))?.size ?? 0;
            }
        }
    };

    const top = await lstat(path).catch(() => undefined);

    if (top === undefined) {
        return 0;
    }

    if (!top.isDirectory()) {
        return top.size;
    }

    await walk(path);

    return bytes;
}

export class SessionCleanup {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    #requireOwner(userId: string): void {
        if (this.#app.config.userById(userId)?.role !== "owner") {
            throw new HttpError(403, "Only the owner can clean up sessions.");
        }
    }

    #ids(ids: readonly unknown[]): ConversationId[] {
        if (!Array.isArray(ids) || ids.length > MAX_SESSIONS) {
            throw new HttpError(400, `Name 1 to ${MAX_SESSIONS} sessions.`);
        }

        return [...new Set(ids)].map((id) => {
            if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
                throw new HttpError(400, "A session id is a number.");
            }

            return id as unknown as ConversationId;
        });
    }

    #uploads(id: number): string {
        return join(this.#app.dataDir, "uploads", String(id));
    }

    #logs(id: number): string {
        return join(this.#app.dataDir, "background", String(id));
    }

    /** The sessions whose uploads a live session reads: itself, and the sessions it was forked from (`workspace.ts`). */
    #readByForks(leaving: ReadonlySet<number>): Set<number> {
        const read = new Set<number>();

        for (const session of this.#app.sessions()) {
            if (leaving.has(session.id)) {
                continue;
            }

            let at = this.#app.sessionMeta(session.id as unknown as ConversationId)?.forkedFrom;

            for (let depth = 0; at !== undefined && depth < 64; depth++) {
                read.add(at.id);
                at = this.#app.sessionMeta(at.id as unknown as ConversationId)?.forkedFrom;
            }
        }

        return read;
    }

    async #worktree(id: ConversationId, worktree: Worktree): Promise<SessionPlan["worktree"]> {
        const app = this.#app;
        const inside = (cwd: string) => inWorktree(worktree, cwd);
        const mine = new Set(app.conversationsOf(id).map(Number));
        let state: WorktreeState = "clean";

        if (app.busyConversations().some((busy) => inside(app.cwdOf(busy)))) {
            state = "busy";
        } else if (
            app
                .sessions()
                .some(
                    (session) =>
                        !mine.has(session.id) &&
                        inside(app.cwdOf(session.id as unknown as ConversationId)),
                )
        ) {
            state = "shared";
        } else {
            const status = await git(worktree.path, ["status", "--porcelain"]).catch(
                () => undefined,
            );

            if (status === undefined) {
                return undefined;
            }

            if (status.trim() !== "") {
                state = "changes";
            }
        }

        return {
            path: worktree.path,
            branch: worktree.branch,
            bytes: await sizeOf(worktree.path),
            state,
        };
    }

    async #plan(
        id: ConversationId,
        readByForks: ReadonlySet<number>,
        docs: {
            hooks: { target: number }[];
            watches: { target: number }[];
            shares: { conversation: string }[];
            lessons: { project?: string }[];
        },
    ): Promise<SessionPlan | undefined> {
        const app = this.#app;
        const meta = app.sessionMeta(id);

        if (meta === undefined || meta.pip !== undefined) {
            return undefined;
        }

        const tree = app.conversationsOf(id);
        const numbers = new Set(tree.map(Number));
        let schedules = 0;
        let background = 0;
        let uploads = 0;
        let logs = 0;

        for (const each of tree) {
            schedules += (await app.schedules.list(each)).length;
            background += (await app.background.list(each)).filter(
                (task) => task.status === "running" || task.status === "starting",
            ).length;
            uploads += await sizeOf(this.#uploads(Number(each)));
            logs += await sizeOf(this.#logs(Number(each)));
        }

        const watch = await app.watches.get(id);
        const worktree =
            meta.worktree === undefined ? undefined : await this.#worktree(id, meta.worktree);
        const busy = tree.some((each) => app.isBusy(each));
        const blocked =
            meta.archived !== true
                ? "Archive it first."
                : busy
                  ? "Pi is working in it. Stop it first."
                  : worktree?.state === "busy"
                    ? "Pi is working in its worktree. Stop it first."
                    : worktree?.state === "changes"
                      ? "Its worktree has uncommitted changes. Commit or discard them first."
                      : undefined;

        return {
            id: Number(id),
            title: meta.title ?? "New session",
            updatedAt: meta.updatedAt,
            archived: meta.archived === true,
            ...(blocked === undefined ? {} : { blocked }),
            ...(worktree === undefined ? {} : { worktree }),
            uploads: { bytes: uploads, kept: readByForks.has(Number(id)) },
            logs,
            ends: {
                schedules,
                background,
                prWatch: watch?.status === "watching",
                hooks: docs.hooks.filter((hook) => numbers.has(hook.target)).length,
                repoWatches: docs.watches.filter((watch) => numbers.has(watch.target)).length,
                shares: docs.shares.filter((share) => numbers.has(Number(share.conversation)))
                    .length,
                lessons: docs.lessons.filter((lesson) => lesson.project === sessionKey(id)).length,
            },
        };
    }

    async #docs() {
        const snapshot = this.#app.harness.snapshot.bind(this.#app.harness);

        return {
            hooks: Object.values((await snapshot(HooksDoc, context))?.items ?? {}),
            watches: Object.values((await snapshot(RepoWatchesDoc, context))?.items ?? {}),
            shares: Object.values((await snapshot(ArtifactSharesDoc, context))?.items ?? {}),
            lessons: Object.values((await snapshot(MemoryDoc, context))?.items ?? {}),
        };
    }

    /** What cleaning up or removing these sessions would do. Sessions that are not there, and PiP, are left out. */
    async plan(userId: string, ids: readonly unknown[]): Promise<SessionPlan[]> {
        this.#requireOwner(userId);
        const chosen = this.#ids(ids);
        const readByForks = this.#readByForks(new Set(chosen.map(Number)));
        const docs = await this.#docs();
        const plans: SessionPlan[] = [];

        for (const id of chosen) {
            const plan = await this.#plan(id, readByForks, docs);

            if (plan !== undefined) {
                plans.push(plan);
            }
        }

        return plans;
    }

    /**
     * Remove the worktrees of these archived sessions, as the session's own Remove worktree does: one with uncommitted
     * changes, or where Pi or another session works, stays. The sessions and their transcripts stay.
     */
    async cleanUp(userId: string, ids: readonly unknown[]): Promise<CleanupOutcome[]> {
        this.#requireOwner(userId);
        const user = this.#app.config.userById(userId)!;
        const outcomes: CleanupOutcome[] = [];

        for (const id of this.#ids(ids)) {
            const meta = this.#app.sessionMeta(id);

            if (meta?.archived !== true || meta.pip !== undefined) {
                outcomes.push({ id: Number(id), done: false, why: "It is not archived." });
                continue;
            }

            if (meta.worktree === undefined) {
                outcomes.push({ id: Number(id), done: false, why: "It has no worktree." });
                continue;
            }

            const bytes = await sizeOf(meta.worktree.path);

            try {
                await this.#app.commands.removeWorktree(id, user, false);
                outcomes.push({ id: Number(id), done: true, bytes });
            } catch (error) {
                outcomes.push({ id: Number(id), done: false, why: describe(error) });
            }
        }

        return outcomes;
    }

    /**
     * Take these archived sessions out of the app, and remove Pocket's own files of them. Each is checked again first:
     * one that cannot go now (see `SessionPlan.blocked`) stays, with why.
     */
    async remove(userId: string, ids: readonly unknown[]): Promise<CleanupOutcome[]> {
        this.#requireOwner(userId);
        const chosen = this.#ids(ids);
        const outcomes: CleanupOutcome[] = [];

        for (const id of chosen) {
            try {
                outcomes.push(await this.#removeOne(userId, id, new Set(chosen.map(Number))));
            } catch (error) {
                outcomes.push({ id: Number(id), done: false, why: describe(error) });
            }
        }

        return outcomes;
    }

    async #removeOne(
        userId: string,
        id: ConversationId,
        leaving: ReadonlySet<number>,
    ): Promise<CleanupOutcome> {
        const app = this.#app;
        const plan = await this.#plan(id, this.#readByForks(leaving), await this.#docs());

        if (plan === undefined) {
            return { id: Number(id), done: false, why: "There is no such session." };
        }

        if (plan.blocked !== undefined) {
            return { id: Number(id), done: false, why: plan.blocked };
        }

        const tree = app.conversationsOf(id).map(Number);
        const numbers = new Set(tree);
        const worktree =
            plan.worktree?.state === "clean" ? app.sessionMeta(id)?.worktree : undefined;
        const watchTasks: TaskId[] = [];

        await app.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);
            const meta = sessions.items[String(id)];

            if (meta?.archived !== true || meta.pip !== undefined) {
                throw new HttpError(409, "It is not archived.");
            }

            delete sessions.items[String(id)];
            const record: RemovedSession = {
                ...(meta.title === undefined ? {} : { title: meta.title }),
                cwd: meta.cwd,
                conversations: tree,
                by: userId,
                at: Date.now(),
                ...(worktree === undefined ? {} : { worktree }),
                ...(plan.uploads.kept ? { keepUploads: [Number(id)] } : {}),
            };

            (await tx.doc(DeletedDoc)).items[String(id)] = record;
            const hooks = await tx.doc(HooksDoc);

            for (const [key, hook] of Object.entries(hooks.items)) {
                if (numbers.has(hook.target)) {
                    delete hooks.items[key];
                }
            }

            const watches = await tx.doc(RepoWatchesDoc);

            for (const [key, watch] of Object.entries(watches.items)) {
                if (numbers.has(watch.target)) {
                    watchTasks.push(watch.taskId);
                    delete watches.items[key];
                }
            }

            const shares = await tx.doc(ArtifactSharesDoc);

            for (const [key, share] of Object.entries(shares.items)) {
                if (numbers.has(Number(share.conversation))) {
                    delete shares.items[key];
                }
            }

            const memory = await tx.doc(MemoryDoc);

            for (const [key, lesson] of Object.entries(memory.items)) {
                if (lesson.project === sessionKey(id)) {
                    delete memory.items[key];
                }
            }
        }, context);

        for (const task of watchTasks) {
            await app.harness.abortTask(task, context).catch(() => undefined);
        }

        const record = (await app.harness.snapshot(DeletedDoc, context))?.items[String(id)];

        if (record !== undefined) {
            await this.#finish(id, record);
        }

        return {
            id: Number(id),
            done: true,
            bytes:
                (plan.worktree?.state === "clean" ? plan.worktree.bytes : 0) +
                (plan.uploads.kept ? 0 : plan.uploads.bytes) +
                plan.logs,
        };
    }

    /** End a removed session's work and remove its files. Each step can run again: a restart runs what is left. */
    async #finish(id: ConversationId, record: RemovedSession): Promise<void> {
        const app = this.#app;
        const left: string[] = [];

        const step = async (what: string, run: () => Promise<unknown>) => {
            try {
                await run();
            } catch (error) {
                left.push(`${what}: ${describe(error)}`);
            }
        };

        for (const each of record.conversations) {
            const conversation = each as unknown as ConversationId;

            if (app.isBusy(conversation)) {
                await step("its run", async () =>
                    (await app.conversation(conversation)).abort(context),
                );
            }

            await step("its schedules", async () => {
                for (const schedule of await app.schedules.list(conversation)) {
                    await app.schedules.cancel(conversation, schedule.id);
                }
            });
            await step("its background tasks", async () => {
                for (const task of await app.background.list(conversation)) {
                    await app.background.stop(conversation, task.id);
                }
            });
            await step("its browser page", () => app.browsers.close(each));
        }

        await step("its PR watch", () => app.watches.stop(id));

        if (record.worktree !== undefined) {
            await step(`its worktree ${record.worktree.path}`, () =>
                removeWorktree(record.worktree!, false),
            );
        }

        for (const each of record.conversations) {
            if (!(record.keepUploads ?? []).includes(each)) {
                await step("its uploads", () =>
                    rm(this.#uploads(each), { recursive: true, force: true }),
                );
            }

            await step("its background logs", () =>
                rm(this.#logs(each), { recursive: true, force: true }),
            );
        }

        if (left.length > 0) {
            app.log(`Session ${String(id)} was removed, but some of it stays: ${left.join("; ")}`);
        }

        await app.harness.commit(async (tx) => {
            const item = (await tx.doc(DeletedDoc)).items[String(id)];

            if (item !== undefined) {
                item.done = Date.now();

                if (left.length > 0) {
                    item.left = left;
                }
            }
        }, context);
    }

    /** At start: go on with the removals a restart cut short. */
    async resume(): Promise<void> {
        const items = (await this.#app.harness.snapshot(DeletedDoc, context))?.items ?? {};

        for (const [key, record] of Object.entries(items)) {
            if (record.done === undefined) {
                await this.#finish(Number(key) as unknown as ConversationId, record).catch(
                    (error: unknown) =>
                        this.#app.log(`A session's removal could not go on: ${describe(error)}`),
                );
            }
        }
    }
}
