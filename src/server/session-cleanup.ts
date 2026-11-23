/**
 * Removing a session takes it out of the app, but its transcript stays in storage: Pi Durable cannot purge a
 * conversation yet. `pocket.deleted` keeps each removed session, the queue for such a purge. A removal is one commit,
 * then the files: after a restart, `resume` goes on with the files.
 */
import { lstat, opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import {
    ArtifactSharesDoc,
    BackgroundDoc,
    DeletedDoc,
    HooksDoc,
    MemoryDoc,
    PublicLinksDoc,
    type RemovedSession,
    RepoWatchesDoc,
    type SessionMeta,
    SessionsDoc,
} from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { type FolderAccess, localAccess, Unreachable } from "./folder-access.ts";
import { sessionKey } from "./memory.ts";
import { isEnvFile } from "./secrets.ts";
import { inWorktree, remoteWorktrees, removeWorktree, type Worktree } from "./worktrees.ts";

const context = BACKGROUND_CONTEXT;

const ENV_STAYS = "Its worktree has an env file that git ignores. Move or delete it first.";

/** The most files a size counts in one folder tree: a huge one shows as at least that much. */
const MAX_COUNTED = 200_000;

export const MAX_SESSIONS = 500;

/** `env`: an env file that git ignores, which `git worktree remove` would delete. Only `clean` goes. */
export type WorktreeState = "clean" | "changes" | "shared" | "busy" | "env";

export type SessionPlan = {
    id: number;
    title: string;
    updatedAt: number;
    archived: boolean;
    blocked?: string;
    worktree?: { path: string; branch: string; bytes: number; state: WorktreeState };
    /** Its uploads; `kept`: a live fork reads them, so they stay. */
    uploads: { bytes: number; kept: boolean };
    logs: number;
    ends: {
        schedules: number;
        background: number;
        prWatch: boolean;
        hooks: number;
        repoWatches: number;
        shares: number;
        links: number;
        lessons: number;
    };
};

export type CleanupOutcome = { id: number; done: boolean; why?: string; bytes?: number };

/**
 * Where a session's folder is. `here`: this machine. `there`: its computer, online, with the session's approval there
 * still valid, so a request does not make that computer ask. `away`: that cannot be said now, and `why`. `gone`: the
 * computer is no longer linked, or the person who started the session may no longer use it: nothing there is reached.
 */
type Place =
    | { at: "here"; access: FolderAccess }
    | { at: "there"; runner: string; access: FolderAccess }
    | { at: "away"; why: string }
    | { at: "gone" };

/** Whether a path is there. A computer that cannot be reached is an error, never "not there". */
function exists(path: string, access: FolderAccess): Promise<boolean> {
    return access.info(path).then(
        () => true,
        (error: unknown) => {
            if (error instanceof Unreachable) {
                throw error;
            }

            return false;
        },
    );
}

/** On this machine. Links not followed; 0 when it is not there. */
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

/**
 * Whether a worktree holds an env file (`.env`, `prod.env`) that git ignores, also inside an ignored folder:
 * `git worktree remove` deletes such files with no word. Other ignored files (`dist`) do not count, and `node_modules`
 * folders are not read. A worktree with more ignored files than `MAX_COUNTED` counts as having one.
 */
async function hasIgnoredEnv(path: string, access: FolderAccess = localAccess): Promise<boolean> {
    const listed = await access.git(path, ["status", "--porcelain", "-z", "--ignored"]);
    let counted = 0;

    const walk = async (folder: string): Promise<boolean> => {
        let listing;

        try {
            listing = await access.list(folder, MAX_COUNTED - counted + 1);
        } catch (error) {
            if (error instanceof Unreachable) {
                throw error;
            }

            return false;
        }

        counted += listing.entries.length;

        // Too many to read them all: one may still be there, so the worktree stays, as for a git error.
        if (listing.more || counted > MAX_COUNTED) {
            return true;
        }

        for (const entry of listing.entries) {
            if (isEnvFile(entry.name)) {
                return true;
            }

            if (
                entry.dir &&
                entry.name !== "node_modules" &&
                (await walk(access.path.join(folder, entry.name)))
            ) {
                return true;
            }
        }

        return false;
    };

    for (const entry of listed.split("\0")) {
        if (!entry.startsWith("!! ")) {
            continue;
        }

        const name = entry.slice(3);

        // A package's own files: an install puts them back, and they are most of the files.
        if (name.endsWith("/") && access.path.basename(name) === "node_modules") {
            continue;
        }

        if (
            name.endsWith("/")
                ? await walk(access.path.join(path, name))
                : isEnvFile(access.path.basename(name))
        ) {
            return true;
        }
    }

    return false;
}

export class SessionCleanup {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    #requireOwner(userId: string): User {
        const user = this.#app.config.userById(userId);

        if (user?.role !== "owner") {
            throw new HttpError(403, "Only the owner can clean up sessions.");
        }

        return user;
    }

    /**
     * A plan and a bulk action never make a computer ask: what the session has there is reached only while its
     * approval there is valid, as that computer last said (`RunnerLink.state`, by its own clock).
     */
    async #place(id: ConversationId): Promise<Place> {
        const app = this.#app;
        const runner = app.runnerOf(id);

        if (runner === undefined) {
            return { at: "here", access: localAccess };
        }

        if (app.runners.stored(runner) === undefined) {
            return { at: "gone" };
        }

        let scope;

        try {
            scope = app.runnerScope(id);
        } catch {
            return { at: "gone" };
        }

        const link = app.runners.link(runner);
        const name = app.runners.name(runner);

        if (!link.online) {
            return { at: "away", why: `${name} is offline. Start its runner, then try again.` };
        }

        const approved = link.state?.sessions.some(
            (each) =>
                each.id === scope.id && (each.expiresAt === null || each.expiresAt > Date.now()),
        );

        if (approved !== true) {
            return {
                at: "away",
                why: `Its approval on ${name} has ended. Unarchive it and continue it there, then try again.`,
            };
        }

        return {
            at: "there",
            runner,
            access: remoteWorktrees(
                app.runners.env(runner, app.cwdOf(id), scope),
                await link.info(),
            ),
        };
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

    /**
     * The sessions whose uploads a live session reads: itself, and the sessions it was forked from (`workspace.ts`).
     * `items`: the sessions as a transaction reads them, instead of the app's.
     */
    #readByForks(leaving: ReadonlySet<number>, items?: Record<string, SessionMeta>): Set<number> {
        const read = new Set<number>();
        const live =
            items === undefined
                ? this.#app.sessions().map((session) => session.id)
                : Object.entries(items)
                      .filter(([, meta]) => meta.pip === undefined)
                      .map(([key]) => Number(key));
        const forkedFrom = (id: number) =>
            items?.[String(id)]?.forkedFrom ??
            this.#app.forkedFrom(id as unknown as ConversationId);

        for (const id of live) {
            if (leaving.has(id)) {
                continue;
            }

            let at = forkedFrom(id);

            for (let depth = 0; at !== undefined && depth < 64; depth++) {
                read.add(at.id);
                at = forkedFrom(at.id);
            }
        }

        return read;
    }

    /** Undefined when it cannot be read, here or on a computer that is `gone`: it stays where it is. */
    async #worktree(
        id: ConversationId,
        worktree: Worktree,
        place: Place,
    ): Promise<SessionPlan["worktree"]> {
        if (place.at !== "here" && place.at !== "there") {
            return undefined;
        }

        const app = this.#app;
        const { access } = place;
        const runner = app.runnerOf(id);
        // The same path on another computer is another folder.
        const anyInside = async (ids: readonly ConversationId[]) =>
            (
                await Promise.all(
                    ids.map(
                        async (each) =>
                            app.runnerOf(each) === runner &&
                            (await inWorktree(worktree, app.cwdOf(each), access)),
                    ),
                )
            ).some(Boolean);
        const mine = new Set(app.conversationsOf(id).map(Number));
        let state: WorktreeState = "clean";

        if (await anyInside(app.busyConversations())) {
            state = "busy";
        } else if (
            await anyInside(
                app
                    .sessions()
                    .filter((session) => !mine.has(session.id))
                    .map((session) => session.id as unknown as ConversationId),
            )
        ) {
            state = "shared";
        } else {
            const status = await access
                .git(worktree.path, ["status", "--porcelain"])
                .catch((error: unknown) => {
                    if (error instanceof Unreachable) {
                        throw error;
                    }

                    return undefined;
                });

            if (status === undefined) {
                return undefined;
            }

            if (status.trim() !== "") {
                state = "changes";
            } else if (
                await hasIgnoredEnv(worktree.path, access).catch((error: unknown) => {
                    if (error instanceof Unreachable) {
                        throw error;
                    }

                    return true;
                })
            ) {
                state = "env";
            }
        }

        return {
            path: worktree.path,
            branch: worktree.branch,
            // A worktree on another computer is not sized: that would read every file of it over the link.
            bytes: place.at === "here" ? await sizeOf(worktree.path) : 0,
            state,
        };
    }

    async #plan(
        user: User,
        id: ConversationId,
        readByForks: ReadonlySet<number>,
        docs: {
            hooks: { target: number }[];
            watches: { target: number }[];
            shares: { conversation: string }[];
            links: { conversation?: number }[];
            lessons: { project?: string }[];
        },
    ): Promise<SessionPlan | undefined> {
        const app = this.#app;
        const meta = app.sessionMeta(id);

        // A session the person may not see (one on another computer that is its starter's alone) is not theirs to
        // remove, and a plan tells nothing of it.
        if (meta === undefined || meta.pip !== undefined || !app.canSee(user, id)) {
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
            // From what is saved: `background.list` would ask a session's computer for what its tasks left.
            background += Object.values(
                (await app.harness.snapshot(BackgroundDoc, each, context))?.items ?? {},
            ).filter((task) => task.status === "running" || task.status === "starting").length;
            uploads += await sizeOf(this.#uploads(Number(each)));
            logs += await sizeOf(this.#logs(Number(each)));
        }

        const watch = await app.watches.get(id);
        const place = await this.#place(id);
        // What it has on a computer that cannot be reached now: it stays until that can be checked and removed.
        let away =
            place.at === "away" && (meta.worktree !== undefined || background > 0)
                ? place.why
                : undefined;
        let worktree: SessionPlan["worktree"];

        try {
            worktree =
                meta.worktree === undefined
                    ? undefined
                    : await this.#worktree(id, meta.worktree, place);
        } catch (error) {
            if (!(error instanceof Unreachable)) {
                throw error;
            }

            away = `${app.runners.name(meta.runner ?? "")} could not be reached. Try again.`;
        }

        const busy = tree.some((each) => app.isBusy(each));
        const blocked =
            meta.archived !== true
                ? "Archive it first."
                : busy
                  ? "Pi is working in it. Stop it first."
                  : away !== undefined
                    ? away
                    : worktree?.state === "busy"
                      ? "Pi is working in its worktree. Stop it first."
                      : worktree?.state === "changes"
                        ? "Its worktree has uncommitted changes. Commit or discard them first."
                        : worktree?.state === "env"
                          ? ENV_STAYS
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
                links: docs.links.filter(
                    (link) => link.conversation !== undefined && numbers.has(link.conversation),
                ).length,
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
            links: Object.values((await snapshot(PublicLinksDoc, context))?.items ?? {}),
            lessons: Object.values((await snapshot(MemoryDoc, context))?.items ?? {}),
        };
    }

    /** Sessions that are not there, and PiP, are left out. */
    async plan(userId: string, ids: readonly unknown[]): Promise<SessionPlan[]> {
        const user = this.#requireOwner(userId);
        const chosen = this.#ids(ids);
        const readByForks = this.#readByForks(new Set(chosen.map(Number)));
        const docs = await this.#docs();
        const plans: SessionPlan[] = [];

        for (const id of chosen) {
            const plan = await this.#plan(user, id, readByForks, docs);

            if (plan !== undefined) {
                plans.push(plan);
            }
        }

        return plans;
    }

    /** Removes only the worktrees: the sessions and their transcripts stay. */
    async cleanUp(userId: string, ids: readonly unknown[]): Promise<CleanupOutcome[]> {
        const user = this.#requireOwner(userId);
        const outcomes: CleanupOutcome[] = [];

        for (const id of this.#ids(ids)) {
            const meta = this.#app.sessionMeta(id);

            if (meta?.archived !== true || meta.pip !== undefined || !this.#app.canSee(user, id)) {
                outcomes.push({ id: Number(id), done: false, why: "It is not archived." });
                continue;
            }

            if (meta.worktree === undefined) {
                outcomes.push({ id: Number(id), done: false, why: "It has no worktree." });
                continue;
            }

            try {
                const place = await this.#place(id);

                if (place.at === "away") {
                    outcomes.push({ id: Number(id), done: false, why: place.why });
                    continue;
                }

                // On a computer that is `gone`, `removeWorktree` says why it cannot.
                if (
                    place.at !== "gone" &&
                    (await exists(meta.worktree.path, place.access)) &&
                    (await hasIgnoredEnv(meta.worktree.path, place.access).catch(() => true))
                ) {
                    outcomes.push({ id: Number(id), done: false, why: ENV_STAYS });
                    continue;
                }

                const bytes = place.at === "here" ? await sizeOf(meta.worktree.path) : 0;

                await this.#app.commands.removeWorktree(id, user, false);
                outcomes.push({ id: Number(id), done: true, bytes });
            } catch (error) {
                outcomes.push({ id: Number(id), done: false, why: describe(error) });
            }
        }

        return outcomes;
    }

    /** Each is checked again first: one that cannot go now stays, with why. */
    async remove(userId: string, ids: readonly unknown[]): Promise<CleanupOutcome[]> {
        const user = this.#requireOwner(userId);

        const depth = (id: ConversationId) => {
            let count = 0;

            for (let at = this.#app.forkedFrom(id); at !== undefined && count < 64; count++) {
                at = this.#app.forkedFrom(at.id as unknown as ConversationId);
            }

            return count;
        };

        // Forks before the sessions they came from: a parent's uploads go only once no fork that stays reads them.
        const named = this.#ids(ids);
        const chosen = [...named].sort((a, b) => depth(b) - depth(a));
        const removed = new Set<number>();
        const outcomes = new Map<number, CleanupOutcome>();

        for (const id of chosen) {
            let outcome: CleanupOutcome;

            try {
                outcome = await this.#removeOne(user, id, new Set([...removed, Number(id)]));
            } catch (error) {
                outcome = { id: Number(id), done: false, why: describe(error) };
            }

            if (outcome.done) {
                removed.add(Number(id));
            }

            outcomes.set(Number(id), outcome);
        }

        if (removed.size > 0) {
            await this.#releaseUploads().catch((error: unknown) =>
                this.#app.log(`Kept uploads could not be checked: ${describe(error)}`),
            );
        }

        return named.map((id) => outcomes.get(Number(id))!);
    }

    /**
     * What a session has on its computer goes before the session does, while the session still says which computer
     * and with which permission: its background tasks and their files, and its worktree when that is clean. A removal
     * cut off after this leaves an archived session without its worktree, as a clean-up does.
     */
    async #clearThere(id: ConversationId, user: User, worktree: boolean): Promise<void> {
        const app = this.#app;

        for (const each of app.conversationsOf(id)) {
            const tasks = await app.background.list(each);

            for (const task of tasks) {
                await app.background.stop(each, task.id);
            }

            await app.background.forgetFiles(
                each,
                tasks.map((task) => task.id),
            );
        }

        if (worktree) {
            await app.commands.removeWorktree(id, user, false);
        }
    }

    async #removeOne(
        user: User,
        id: ConversationId,
        leaving: ReadonlySet<number>,
    ): Promise<CleanupOutcome> {
        const app = this.#app;
        const plan = await this.#plan(user, id, this.#readByForks(leaving), await this.#docs());

        if (plan === undefined) {
            return { id: Number(id), done: false, why: "There is no such session." };
        }

        if (plan.blocked !== undefined) {
            return { id: Number(id), done: false, why: plan.blocked };
        }

        const tree = app.conversationsOf(id).map(Number);
        const numbers = new Set(tree);
        const runner = app.runnerOf(id);
        // A worktree on another computer goes before the commit (`#clearThere`): after it, nothing says where it is.
        const worktree =
            runner === undefined && plan.worktree?.state === "clean"
                ? app.sessionMeta(id)?.worktree
                : undefined;
        const watchTasks: TaskId[] = [];
        let keepUploads = false;

        // The plan took a while (sizes): a run that started meanwhile keeps the session.
        if (tree.some((each) => app.isBusy(each as unknown as ConversationId))) {
            return { id: Number(id), done: false, why: "Pi is working in it. Stop it first." };
        }

        if (runner !== undefined) {
            const place = await this.#place(id);

            if (place.at === "there") {
                await this.#clearThere(id, user, plan.worktree?.state === "clean");
            }

            // Tasks on a computer that is `gone` cannot be stopped there, and must not be looked for here.
            for (const each of tree) {
                await app.background.abandon(each as unknown as ConversationId);
            }
        }

        await app.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);
            const meta = sessions.items[String(id)];

            if (meta?.archived !== true || meta.pip !== undefined) {
                throw new HttpError(409, "It is not archived.");
            }

            delete sessions.items[String(id)];
            // From this transaction: a fork made while the plan ran reads these uploads too.
            keepUploads = this.#readByForks(leaving, sessions.items).has(Number(id));
            const record: RemovedSession = {
                ...(meta.title === undefined ? {} : { title: meta.title }),
                cwd: meta.cwd,
                ...(meta.forkedFrom === undefined ? {} : { forkedFrom: meta.forkedFrom }),
                conversations: tree,
                by: user.id,
                at: Date.now(),
                ...(runner === undefined ? {} : { runner }),
                ...(worktree === undefined ? {} : { worktree }),
                ...(keepUploads ? { keepUploads: [Number(id)] } : {}),
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

            const links = await tx.doc(PublicLinksDoc);

            for (const [key, link] of Object.entries(links.items)) {
                if (link.conversation !== undefined && numbers.has(link.conversation)) {
                    delete links.items[key];
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

        const worktreeGone = worktree !== undefined && !(await exists(worktree.path, localAccess));

        return {
            id: Number(id),
            done: true,
            bytes:
                (worktreeGone ? plan.worktree!.bytes : 0) +
                (keepUploads ? 0 : plan.uploads.bytes) +
                plan.logs,
        };
    }

    /** Each step can run again: a restart runs what is left. */
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

            // A session that was on another computer has no unfinished task left (`#removeOne`), and none of its
            // tasks' processes are this machine's.
            if (record.runner === undefined) {
                await step("its background tasks", async () => {
                    for (const task of await app.background.list(conversation)) {
                        await app.background.stop(conversation, task.id);
                    }
                });
            }

            await step("its browser page", () => app.browsers.close(each));
        }

        await step("its PR watch", () => app.watches.stop(id));

        if (record.worktree !== undefined) {
            await step(`its worktree ${record.worktree.path}`, async () => {
                // One may have come since the plan, or before a restart.
                if (
                    (await exists(record.worktree!.path, localAccess)) &&
                    (await hasIgnoredEnv(record.worktree!.path).catch(() => true))
                ) {
                    throw new Error(ENV_STAYS);
                }

                await removeWorktree(record.worktree!, false);
            });
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

    /** Once no session that stays reads them. */
    async #releaseUploads(): Promise<void> {
        const items = (await this.#app.harness.snapshot(DeletedDoc, context))?.items ?? {};
        const read = this.#readByForks(new Set());

        for (const [key, record] of Object.entries(items)) {
            const gone: number[] = [];

            for (const each of record.keepUploads ?? []) {
                if (!read.has(each)) {
                    await rm(this.#uploads(each), { recursive: true, force: true }).then(
                        () => gone.push(each),
                        (error: unknown) =>
                            this.#app.log(`Uploads ${each} could not go: ${describe(error)}`),
                    );
                }
            }

            if (gone.length > 0) {
                await this.#app.harness.commit(async (tx) => {
                    const item = (await tx.doc(DeletedDoc)).items[key];
                    const kept = (item?.keepUploads ?? []).filter((each) => !gone.includes(each));

                    if (item !== undefined && kept.length > 0) {
                        item.keepUploads = kept;
                    } else if (item !== undefined) {
                        delete item.keepUploads;
                    }
                }, context);
            }
        }
    }

    /** Also removes uploads that no fork reads any more. */
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

        await this.#releaseUploads().catch((error: unknown) =>
            this.#app.log(`Kept uploads could not be checked: ${describe(error)}`),
        );
    }
}
