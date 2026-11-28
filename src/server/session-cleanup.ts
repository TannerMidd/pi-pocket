/**
 * Removing a session takes it out of the app, but its transcript stays in storage: Pi Durable cannot purge a
 * conversation yet. `pocket.deleted` keeps each removed session, the queue for such a purge. A removal is one commit,
 * then the files: after a restart, `resume` goes on with the files.
 */
import type { BigIntStats } from "node:fs";
import { lstat, opendir, rmdir, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { retireArtifacts, startAssetSweep } from "./artifacts.ts";
import {
    ArtifactSharesDoc,
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
import { git } from "./git.ts";
import type { ManagedFolderProof } from "./managed-storage.ts";
import { sessionKey } from "./memory.ts";
import { isEnvFile } from "./secrets.ts";
import { inWorktree, removeWorktree, type Worktree } from "./worktrees.ts";

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
    uploads: UploadEstimate;
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

type UploadEstimate = {
    bytes: number;
    removableBytes: number;
    retainedBytes: number;
    kept: boolean;
};

function noUploads(): UploadEstimate {
    return { bytes: 0, removableBytes: 0, retainedBytes: 0, kept: false };
}

export type CleanupOutcome = { id: number; done: boolean; why?: string; bytes?: number };

/** Links not followed; 0 when it is not there. */
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
async function hasIgnoredEnv(path: string): Promise<boolean> {
    const listed = await git(path, ["status", "--porcelain", "-z", "--ignored"]);
    let counted = 0;

    const walk = async (folder: string): Promise<boolean> => {
        let dir;

        try {
            dir = await opendir(folder);
        } catch {
            return false;
        }

        for await (const entry of dir) {
            // Too many to read them all: one may still be there, so the worktree stays, as for a git error.
            if (++counted > MAX_COUNTED) {
                return true;
            }

            if (isEnvFile(entry.name)) {
                return true;
            }

            if (
                entry.isDirectory() &&
                entry.name !== "node_modules" &&
                (await walk(join(folder, entry.name)))
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
        if (name.endsWith("/") && basename(name) === "node_modules") {
            continue;
        }

        if (name.endsWith("/") ? await walk(join(path, name)) : isEnvFile(basename(name))) {
            return true;
        }
    }

    return false;
}

type UploadHold = "all" | Set<string> | undefined;
type UploadRetention = (owner: number) => UploadHold;

function validId(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Retention is not authorization. A damaged catalogue must not grant reads or lose files. */
function uploadRetention(
    sessions: Record<string, SessionMeta> | undefined,
    deleted: Record<string, RemovedSession>,
    leaving: ReadonlySet<number>,
): UploadRetention {
    const holds = new Map<number, Exclude<UploadHold, undefined>>();
    let unknownOwner = sessions === undefined;

    for (const [key, meta] of Object.entries(sessions ?? {})) {
        if (leaving.has(Number(key))) {
            continue;
        }

        holds.set(Number(key), "all");

        if (meta.forkedFrom === undefined && meta.inheritedUploads === undefined) {
            continue;
        }

        const ancestors = new Set<number>();
        let uncertain = !Array.isArray(meta.inheritedUploads);
        let link = meta.forkedFrom;

        while (link !== undefined) {
            if (!validId(link?.id) || ancestors.has(link.id)) {
                unknownOwner = true;
                uncertain = true;
                break;
            }

            ancestors.add(link.id);
            const source = sessions?.[String(link.id)] ?? deleted[String(link.id)];

            if (source === undefined) {
                // A missing record can hide an earlier source whose ID we cannot recover.
                unknownOwner = true;
                uncertain = true;
                break;
            }

            link = source.forkedFrom;
        }

        for (const ref of Array.isArray(meta.inheritedUploads) ? meta.inheritedUploads : []) {
            const match = typeof ref === "string" && /^([1-9]\d*)\/([^/\\\x00-\x1f]+)$/u.exec(ref);
            const owner = match ? Number(match[1]) : NaN;

            if (!match || !validId(owner) || match[2] === "." || match[2] === "..") {
                uncertain = true;
                // A damaged name can still identify a source outside the surviving lineage.
                const source = typeof ref === "string" ? Number(ref.split("/", 1)[0]) : NaN;

                if (validId(source)) {
                    ancestors.add(source);
                }

                continue;
            }

            if (!ancestors.has(owner)) {
                uncertain = true;
                ancestors.add(owner);
            }

            const names = holds.get(owner) ?? new Set<string>();

            if (names !== "all") {
                names.add(match[2]!);
                holds.set(owner, names);
            }
        }

        if (uncertain) {
            unknownOwner ||= ancestors.size === 0;

            for (const owner of ancestors) {
                holds.set(owner, "all");
            }
        }
    }

    return (owner) => (unknownOwner ? "all" : holds.get(owner));
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

    async #retention(leaving: ReadonlySet<number>): Promise<UploadRetention> {
        const sessions = await this.#app.harness.snapshot(SessionsDoc, context);
        const deleted = await this.#app.harness.snapshot(DeletedDoc, context);

        return uploadRetention(sessions?.items, deleted?.items ?? {}, leaving);
    }

    /** The plan and sweep use the same classification. An unknown layout stays, even without known readers. */
    async #flatFiles(
        store: "uploads" | "background",
        id: number,
        hold: UploadHold,
        sweep?: { proof: ManagedFolderProof | undefined; removed(bytes: number): void },
    ): Promise<UploadEstimate> {
        const result = noUploads();
        const storage = this.#app.managedStorage;
        const checkedFolder = () =>
            sweep === undefined
                ? storage.folder(store, String(id))
                : storage.verifiedFolder(store, String(id), sweep.proof);
        const folder = checkedFolder();

        if (folder === undefined) {
            return result;
        }

        const keepAll = async () => {
            if (checkedFolder() !== folder) {
                throw new Error("The managed folder changed.");
            }

            result.kept = true;

            if (sweep === undefined) {
                result.bytes = result.retainedBytes = await sizeOf(folder);
            }

            return result;
        };

        if (hold === "all") {
            return keepAll();
        }

        const entries = new Map<string, Pick<BigIntStats, "size" | "dev" | "ino" | "ctimeNs">>();
        const dir = await opendir(folder);

        for await (const entry of dir) {
            if (!entry.isFile() || entries.size >= MAX_COUNTED) {
                return keepAll();
            }

            const stat = await lstat(join(folder, entry.name), { bigint: true });

            if (!stat.isFile() || !stat.ino || stat.nlink !== 1n) {
                return keepAll();
            }

            const { size, dev, ino, ctimeNs } = stat;

            entries.set(entry.name, { size, dev, ino, ctimeNs });
        }

        if (hold !== undefined && [...hold].some((name) => !entries.has(name))) {
            return keepAll();
        }

        result.kept = hold !== undefined;

        for (const [name, stat] of entries) {
            const size = Number(stat.size);

            result.bytes += size;

            if (hold?.has(name)) {
                result.retainedBytes += size;
            } else {
                result.removableBytes += size;

                if (sweep !== undefined) {
                    const path = join(folder, name);
                    const current = await lstat(path, { bigint: true });

                    if (
                        checkedFolder() !== folder ||
                        current.dev !== stat.dev ||
                        current.ino !== stat.ino ||
                        current.ctimeNs !== stat.ctimeNs
                    ) {
                        throw new Error("The file changed during cleanup.");
                    }

                    await unlink(path);
                    sweep.removed(size);
                }
            }
        }

        if (sweep !== undefined && !result.kept) {
            if (checkedFolder() !== folder) {
                throw new Error("The managed folder changed.");
            }

            await rmdir(folder);
        }

        return result;
    }

    #worktreeName(worktree: Worktree): string {
        const name = basename(worktree.path);

        if (
            !name ||
            name === "." ||
            name === ".." ||
            resolve(this.#app.dataDir, "worktrees", name) !== worktree.path
        ) {
            throw new Error("Not a managed worktree folder.");
        }

        return name;
    }

    #worktreeFolder(worktree: Worktree): string | undefined {
        return this.#app.managedStorage.folder("worktrees", this.#worktreeName(worktree));
    }

    async #worktree(id: ConversationId, worktree: Worktree): Promise<SessionPlan["worktree"]> {
        if (this.#worktreeFolder(worktree) === undefined) {
            return undefined;
        }

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
            const status = await git(worktree.path, ["status", "--porcelain"]);

            if (status.trim() !== "") {
                state = "changes";
            } else if (await hasIgnoredEnv(worktree.path).catch(() => true)) {
                state = "env";
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

        if (meta === undefined || meta.pip !== undefined) {
            return undefined;
        }

        const tree = app.conversationsOf(id);
        const numbers = new Set(tree.map(Number));
        let schedules = 0;
        let background = 0;
        let logs = 0;

        for (const each of tree) {
            schedules += (await app.schedules.list(each)).length;
            background += (await app.background.list(each)).filter(
                (task) => task.status === "running" || task.status === "starting",
            ).length;

            try {
                logs += (await this.#flatFiles("background", Number(each), undefined))
                    .removableBytes;
            } catch {
                // An unverified folder contributes no removable bytes.
            }
        }

        const watch = await app.watches.get(id);
        let worktree;
        let unverified: string | undefined;

        if (meta.worktree !== undefined) {
            try {
                worktree = await this.#worktree(id, meta.worktree);
            } catch {
                unverified = "Its worktree could not be verified.";
            }
        }

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
                      : worktree?.state === "env"
                        ? ENV_STAYS
                        : unverified;

        return {
            id: Number(id),
            title: meta.title ?? "New session",
            updatedAt: meta.updatedAt,
            archived: meta.archived === true,
            ...(blocked === undefined ? {} : { blocked }),
            ...(worktree === undefined ? {} : { worktree }),
            uploads: noUploads(),
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
        this.#requireOwner(userId);
        const chosen = this.#ids(ids);
        const docs = await this.#docs();
        const plans: SessionPlan[] = [];

        for (const id of chosen) {
            const plan = await this.#plan(id, docs);

            if (plan !== undefined) {
                plans.push(plan);
            }
        }

        const retention = await this.#retention(
            new Set(plans.filter((plan) => !plan.blocked).map((plan) => plan.id)),
        );

        for (const plan of plans) {
            for (const each of this.#app.conversationsOf(plan.id as unknown as ConversationId)) {
                const uploads = await this.#flatFiles(
                    "uploads",
                    Number(each),
                    plan.blocked ? "all" : retention(Number(each)),
                ).catch(() => ({ ...noUploads(), kept: true }));

                plan.uploads.bytes += uploads.bytes;
                plan.uploads.removableBytes += uploads.removableBytes;
                plan.uploads.retainedBytes += uploads.retainedBytes;
                plan.uploads.kept ||= uploads.kept;
            }
        }

        return plans;
    }

    /** Removes only the worktrees: the sessions and their transcripts stay. */
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

            let folder;

            try {
                folder = this.#worktreeFolder(meta.worktree);
            } catch (error) {
                outcomes.push({ id: Number(id), done: false, why: describe(error) });
                continue;
            }

            if (folder !== undefined && (await hasIgnoredEnv(folder).catch(() => true))) {
                outcomes.push({ id: Number(id), done: false, why: ENV_STAYS });
                continue;
            }

            const bytes = folder === undefined ? 0 : await sizeOf(folder);

            try {
                if (this.#worktreeFolder(meta.worktree) !== folder) {
                    throw new Error("The worktree changed during cleanup.");
                }

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
        this.#requireOwner(userId);

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
                outcome = await this.#removeOne(userId, id, new Set([...removed, Number(id)]));
            } catch (error) {
                outcome = { id: Number(id), done: false, why: describe(error) };
            }

            if (outcome.done) {
                removed.add(Number(id));
            }

            outcomes.set(Number(id), outcome);
        }

        if (removed.size > 0) {
            startAssetSweep(this.#app);
            await this.#releaseUploads().catch((error: unknown) =>
                this.#app.log(`Kept uploads could not be checked: ${describe(error)}`),
            );
        }

        return named.map((id) => outcomes.get(Number(id))!);
    }

    async #removeOne(
        userId: string,
        id: ConversationId,
        leaving: ReadonlySet<number>,
    ): Promise<CleanupOutcome> {
        const app = this.#app;
        const plan = await this.#plan(id, await this.#docs());

        if (plan === undefined) {
            return { id: Number(id), done: false, why: "There is no such session." };
        }

        if (plan.blocked !== undefined) {
            return { id: Number(id), done: false, why: plan.blocked };
        }

        const conversations = app.conversationsOf(id);
        const tree = conversations.map(Number);
        const numbers = new Set(tree);
        const watchTasks: TaskId[] = [];

        // The plan took a while (sizes): a run that started meanwhile keeps the session.
        if (tree.some((each) => app.isBusy(each as unknown as ConversationId))) {
            return { id: Number(id), done: false, why: "Pi is working in it. Stop it first." };
        }

        await app.harness.commit(async (tx) => {
            const sessions = await tx.doc(SessionsDoc);
            const meta = sessions.items[String(id)];

            if (meta?.archived !== true || meta.pip !== undefined) {
                throw new HttpError(409, "It is not archived.");
            }

            const deleted = await tx.doc(DeletedDoc);
            // A fork can finish while the plan runs. Include it before queuing any removal.
            const retention = uploadRetention(sessions.items, deleted.items, leaving);

            const keepUploads = tree.filter((each) => retention(each) !== undefined);
            const worktree = plan.worktree?.state === "clean" ? meta.worktree : undefined;

            if (
                worktree !== undefined &&
                (worktree.path !== plan.worktree?.path || worktree.branch !== plan.worktree.branch)
            ) {
                throw new HttpError(409, "The session worktree changed during cleanup.");
            }

            const folders: NonNullable<RemovedSession["folders"]> = { uploads: {}, background: {} };

            for (const each of tree) {
                const name = String(each);

                folders.uploads[name] = app.managedStorage.capture("uploads", name);
                folders.background[name] = app.managedStorage.capture("background", name);
            }

            if (worktree !== undefined) {
                folders.worktree = app.managedStorage.capture(
                    "worktrees",
                    this.#worktreeName(worktree),
                );
            }

            delete sessions.items[String(id)];
            const record: RemovedSession = {
                ...(meta.title === undefined ? {} : { title: meta.title }),
                cwd: meta.cwd,
                ...(meta.forkedFrom === undefined ? {} : { forkedFrom: meta.forkedFrom }),
                conversations: tree,
                folders,
                by: userId,
                at: Date.now(),
                ...(worktree === undefined ? {} : { worktree }),
                ...(keepUploads.length === 0 ? {} : { keepUploads }),
            };

            deleted.items[String(id)] = record;
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

            for (const conversation of conversations) {
                await retireArtifacts(tx, conversation, null);
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

        const bytes = record === undefined ? 0 : await this.#finish(id, record);

        return { id: Number(id), done: true, bytes };
    }

    /** Each step can run again: a restart runs what is left. */
    async #finish(id: ConversationId, record: RemovedSession): Promise<number> {
        let bytes = 0;
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

        const tree = record.worktree;

        if (tree !== undefined) {
            await step(`its worktree ${tree.path}`, async () => {
                const name = this.#worktreeName(tree);
                const checkedFolder = () =>
                    app.managedStorage.verifiedFolder("worktrees", name, record.folders?.worktree);
                const folder = checkedFolder();

                if (folder === undefined) {
                    return;
                }

                if (await hasIgnoredEnv(folder).catch(() => true)) {
                    throw new Error(ENV_STAYS);
                }

                const size = await sizeOf(folder);

                await removeWorktree(tree, false, () => {
                    if (checkedFolder() !== folder) {
                        throw new Error("The worktree changed during cleanup.");
                    }
                });
                bytes += size;
            });
        }

        const retention = await this.#retention(new Set());
        const kept: number[] = [];

        const removed = (size: number) => {
            bytes += size;
        };

        for (const each of record.conversations) {
            // Leave the root queued if its guard or a filesystem operation fails.
            kept.push(each);
            await step("its uploads", async () => {
                const uploads = await this.#flatFiles("uploads", each, retention(each), {
                    proof: record.folders?.uploads?.[String(each)],
                    removed,
                });

                if (!uploads.kept) {
                    kept.pop();
                }
            });
            await step("its background logs", async () => {
                const logs = await this.#flatFiles("background", each, undefined, {
                    proof: record.folders?.background?.[String(each)],
                    removed,
                });

                if (logs.kept) {
                    throw new Error("Its background logs have an unexpected layout.");
                }
            });
        }

        if (left.length > 0) {
            app.log(`Session ${String(id)} was removed, but some of it stays: ${left.join("; ")}`);
        }

        await app.harness.commit(async (tx) => {
            const item = (await tx.doc(DeletedDoc)).items[String(id)];

            if (item !== undefined) {
                item.done = Date.now();

                if (kept.length > 0) {
                    item.keepUploads = kept;
                } else {
                    delete item.keepUploads;
                }

                if (left.length > 0) {
                    item.left = left;
                }
            }
        }, context);

        return bytes;
    }

    /** Once no session that stays reads them. */
    async #releaseUploads(): Promise<void> {
        const items = (await this.#app.harness.snapshot(DeletedDoc, context))?.items ?? {};
        const retention = await this.#retention(new Set());

        for (const [key, record] of Object.entries(items)) {
            const gone: number[] = [];

            for (const each of record.keepUploads ?? []) {
                const proof = record.folders?.uploads?.[String(each)];

                if (
                    record.done === undefined ||
                    !record.conversations.includes(each) ||
                    proof === undefined
                ) {
                    continue;
                }

                try {
                    const uploads = await this.#flatFiles("uploads", each, retention(each), {
                        proof,
                        removed: () => {},
                    });

                    if (!uploads.kept) {
                        gone.push(each);
                    }
                } catch (error) {
                    this.#app.log(`Uploads ${each} could not go: ${describe(error)}`);
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
