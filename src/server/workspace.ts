/**
 * A conversation's folder, on this machine or on the computer its session runs on (`folder-access.ts`), as people reach
 * it through the app: which files a person may load or read,
 * the file viewer, the files for `@` mentions, Changes, its git branch, uploads, and new folders from the folder picker. The
 * operations people call directly check who may do them; the path helpers (`conversationPath`, `conversationFile`,
 * `readableFile`, `uploadDirectory`) leave seeing the conversation to their callers.
 */
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, resolve, sep, win32 } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import {
    type Branches,
    branchesIn,
    gitDirOf,
    type Head,
    headIn,
    headOf,
    isRemoteBranch,
    localName,
    switchBranch,
    validBranchName,
} from "./branches.ts";
import { type Changes, changesIn, diffOf, editFacts, revertFile } from "./changes.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { FileLists, type FileListing, type FileView, viewFile } from "./files.ts";
import { type FolderAccess, localAccess, remoteAccess, Unreachable } from "./folder-access.ts";
import { GitError } from "./git.ts";
import { displayPath, expandFolder, expandHome } from "./paths.ts";
import { reveal, revealOn } from "./reveal.ts";
import type { ClientEntry } from "./projection.ts";
import { isImagePath } from "./http/assets.ts";
import { RunnerImages, type ImageSource } from "./runner-images.ts";

/** How many sessions' Pi edits are kept between looks at Changes (`#edits`). */
const EDITS_KEPT = 64;
/** How often a session on another computer is asked what it has checked out, at most, and for how many sessions. */
const REMOTE_HEAD_MS = 3000;
const REMOTE_HEAD_TIMEOUT_MS = 10_000;
const REMOTE_HEADS_KEPT = 256;

/** A failure to reach a session's computer, as people read it; anything else as it is. */
function unreachable(error: unknown): never {
    throw error instanceof Unreachable ? new HttpError(409, describe(error)) : error;
}

/** A path on another computer as people read it in a session: relative to its folder there, else `~/x` or whole. */
function remoteDisplay(path: string, cwd: string, home: string, access: FolderAccess): string {
    const { sep, relative } = access.path;

    if (path.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep)) {
        return relative(cwd, path);
    }

    return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

export class Workspace {
    readonly #app: PocketApp;
    #runnerImages: RunnerImages | undefined;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    get #images(): RunnerImages {
        // Workspace is constructed before PocketApp's constructor assigns its data directory.
        return (this.#runnerImages ??= new RunnerImages(this.#app.dataDir));
    }

    /** The files in each folder, for `@` mentions. */
    readonly #files = new FileLists();

    /** Refuse a local file or Git action for a session on a workspace URI. */
    requireLocal(id: ConversationId): void {
        if (this.#app.workspaceScheme(this.#app.cwdOf(id)) !== undefined) {
            throw new HttpError(
                400,
                "Local file and Git operations are not available for remote workspaces.",
            );
        }
    }

    /**
     * The looks at what a conversation's folder changed that are under way, per reach (its folder only, or its
     * repository). Every tab that shows a session asks (the top bar's count), often together as Pi moves on; those that
     * ask while a look is under way share it, as each reads the new history for Pi's edits and runs git. One asked after
     * it ends looks again, so what it says is never older than the question.
     */
    readonly #changesUnderWay = new Map<string, Promise<Changes>>();

    /**
     * What Changes needs of each session's history (`editFacts`) and the newest entry it read, for the sessions looked
     * at last: entries never change, so a look reads only those added since, not the whole history each time.
     */
    readonly #edits = new Map<ConversationId, { last: number; entries: ClientEntry[] }>();

    /**
     * Where each folder's repository keeps its files, for a minute: views ask on every update. A folder in none is
     * asked about again after a few seconds, so one Pi has just run `git init` in shows its branch soon.
     */
    readonly #gitDirs = new Map<string, { gitDir: string | undefined; at: number }>();

    #gitDir(cwd: string): string | undefined {
        if (this.#app.workspaceScheme(cwd) !== undefined) {
            // View metadata has no local repository; explicit local Git actions stay guarded.
            return undefined;
        }

        const known = this.#gitDirs.get(cwd);

        if (
            known !== undefined &&
            Date.now() - known.at < (known.gitDir === undefined ? 5000 : 60_000)
        ) {
            return known.gitDir;
        }

        const gitDir = gitDirOf(cwd);

        this.#gitDirs.set(cwd, { gitDir, at: Date.now() });

        return gitDir;
    }

    /**
     * What each session on another computer has checked out, as it last said, and when it was last asked: its HEAD file
     * is there, and views ask on every update, so `head` answers from here and asks again in the background.
     */
    readonly #remoteHeads = new Map<
        ConversationId,
        { head: Head | undefined; at: number; asking: boolean }
    >();

    /**
     * How a session's folder is reached: this machine's disk, or its computer's daemon. A computer that is offline is a
     * 409 that says so: nothing falls back to this machine.
     */
    async #access(id: ConversationId): Promise<FolderAccess> {
        const runner = this.#app.runnerOf(id);

        if (runner === undefined) {
            return localAccess;
        }

        // What a person waits on: a computer that is offline says so at once.
        const info = await this.#app.runners
            .link(runner)
            .infoNow()
            .catch((error: unknown) => {
                throw error instanceof HttpError ? error : new HttpError(409, describe(error));
            });

        return remoteAccess(
            this.#app.runners.env(runner, this.#app.cwdOf(id), this.#app.runnerScope(id)),
            info,
        );
    }

    /** Whether a folder is in a git repository. */
    inRepository(cwd: string): boolean {
        return this.#gitDir(cwd) !== undefined;
    }

    /**
     * What a conversation's folder has checked out, for its view: its repository's HEAD file, read as it is now. For a
     * session on another computer, what it said last, asked again at most every few seconds; `changed` is told when
     * the answer differs. Nothing while that computer is offline.
     */
    head(id: ConversationId, changed?: () => void): Head | undefined {
        if (this.#app.runnerOf(id) !== undefined) {
            return this.#remoteHead(id, changed);
        }

        const gitDir = this.#gitDir(this.#app.cwdOf(id));

        return gitDir === undefined ? undefined : headOf(gitDir);
    }

    #remoteHead(id: ConversationId, changed?: () => void): Head | undefined {
        const known = this.#remoteHeads.get(id) ?? { head: undefined, at: 0, asking: false };

        if (known.asking || Date.now() - known.at < REMOTE_HEAD_MS) {
            return known.head;
        }

        known.asking = true;
        known.at = Date.now();
        this.#remoteHeads.delete(id);
        this.#remoteHeads.set(id, known);

        if (this.#remoteHeads.size > REMOTE_HEADS_KEPT) {
            this.#remoteHeads.delete(this.#remoteHeads.keys().next().value!);
        }

        const runner = this.#app.runnerOf(id)!;
        const ask = this.#app.runners.link(runner).online
            ? this.#access(id).then((access) =>
                  headIn(this.#app.cwdOf(id), access, REMOTE_HEAD_TIMEOUT_MS),
              )
            : Promise.resolve(undefined);

        void ask
            // Offline, or not answering: no branch to show.
            .catch(() => undefined)
            .then((head) => {
                const before = JSON.stringify(known.head);

                known.head = head;
                known.asking = false;
                known.at = Date.now();

                if (JSON.stringify(head) !== before) {
                    changed?.();
                }
            });

        return known.head;
    }

    /** The branches of a session's repository, for the branch sheet: for people who can steer, as Changes is. */
    async branches(id: ConversationId, user: User): Promise<Branches> {
        this.#app.requireSee(user, id);
        this.requireLocal(id);
        this.#app.requireSteer(user);

        const cwd = this.#app.cwdOf(id);
        const access = await this.#access(id);
        const notInRepository = () =>
            new HttpError(404, "This session's folder is not in a git repository.");

        // Here the repository is found on disk; on another computer git says, in the same round trip.
        if (access === localAccess && this.#gitDir(cwd) === undefined) {
            throw notInRepository();
        }

        return branchesIn(cwd, access).catch((error: unknown) => {
            if (error instanceof GitError && /not a git repository/i.test(error.message)) {
                throw notInRepository();
            }

            throw new HttpError(409, describe(error));
        });
    }

    /**
     * Switch a session's folder to another branch: one there already, a new one from what is checked out (`create`),
     * or a new one following a remote branch (`track`). It changes the files under Pi, so as with moving the session to
     * another folder it takes the right to drive, someone not invited to one session only, and Pi not working; Pi is
     * told with its next message.
     */
    async switchBranch(
        id: ConversationId,
        user: User,
        request: { name?: unknown; create?: unknown; track?: unknown },
    ): Promise<{ branch: string }> {
        this.#app.requireSee(user, id);
        this.requireLocal(id);
        this.#app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session.");
        }

        await this.#app.requireDriver(id, user);

        const track = typeof request.track === "string" ? request.track : undefined;
        const name =
            typeof request.name === "string" ? request.name.trim() : track && localName(track);
        const cwd = this.#app.cwdOf(id);
        const access = await this.#access(id);
        // Both at once: on another computer each is a round trip.
        const [remote, valid] = await Promise.all([
            track === undefined ? true : isRemoteBranch(cwd, track, access),
            name ? validBranchName(cwd, name, access) : false,
        ]).catch(unreachable);

        if (!remote) {
            throw new HttpError(400, `${track} is not a remote branch here.`);
        }

        if (!name || !valid) {
            throw new HttpError(400, `${name ? `“${name}”` : "That"} cannot be a branch name.`);
        }

        if (this.#app.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before switching branches.",
            );
        }

        const before = this.head(id);

        await switchBranch(
            cwd,
            {
                name,
                create: request.create === true,
                ...(track ? { track } : {}),
            },
            access,
        ).catch((error: unknown) => {
            throw new HttpError(409, describe(error));
        });

        // The top bar shows it now, without waiting for the next look.
        const known = this.#remoteHeads.get(id);

        if (known !== undefined) {
            known.head = { branch: name };
            known.at = Date.now();
        }

        const from = before !== undefined && "branch" in before ? ` from ${before.branch}` : "";
        const what =
            request.create === true || track !== undefined
                ? `made the branch ${name}${track ? `, following ${track},` : ""} and switched to it${from}`
                : `switched the branch${from} to ${name}`;

        await this.#app.commands.note(id, user, what);
        await this.#app.collab.activity(id, user, what);

        return { branch: name };
    }

    /** A folder to work in, as its whole path: a 404 when it is not there, so the folder picker can offer to make it. */
    checkDirectory(path: string): string {
        if (this.#app.workspaceScheme(path.trim()) !== undefined) {
            throw new HttpError(
                400,
                "Use the registered workspace resolver for remote workspace URIs.",
            );
        }

        const absolute = resolve(expandFolder(path.trim() === "" ? "~" : path.trim()));
        let found;

        try {
            found = statSync(absolute);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code === "ENOTDIR") {
                throw new HttpError(400, `${absolute} is inside a file, not a folder.`);
            }

            if (code === "ELOOP") {
                throw new HttpError(400, `${absolute} is a link to nothing.`);
            }

            if (code !== "ENOENT") {
                throw new HttpError(400, `Could not open ${absolute}: ${describe(error)}`);
            }

            // Not there, unless it is a link to nowhere: that cannot be made a folder either.
            throw lstatSync(absolute, { throwIfNoEntry: false }) === undefined
                ? new HttpError(404, `${absolute} isn't there.`)
                : new HttpError(400, `${absolute} is a link to nothing.`);
        }

        if (!found.isDirectory()) {
            throw new HttpError(400, `${absolute} is a file, not a folder.`);
        }

        return absolute;
    }

    /**
     * Make a folder to start a session in or move one to, with any folders missing above it, for someone who may browse
     * folders (`/api/fs`): who can steer, and was not invited to one session. A folder already there is fine: it is the
     * one asked for. Returns its path.
     */
    makeFolder(user: User, path: string): string {
        this.#app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session.");
        }

        const written = path.trim();

        if (written === "" || written.includes("\0")) {
            throw new HttpError(400, "Name the folder to make.");
        }

        const expanded = expandFolder(written);

        if (!isAbsolute(expanded)) {
            throw new HttpError(
                400,
                "Give the folder's whole path, from / or ~ (or a drive, as D:\\).",
            );
        }

        const absolute = resolve(expanded);

        try {
            mkdirSync(absolute, { recursive: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            // A file in the way, or a link that leads nowhere (or in a loop): the path cannot be a folder.
            throw new HttpError(
                409,
                code === "EEXIST" || code === "ENOTDIR"
                    ? `${absolute} is a file, or inside one.`
                    : code === "ENOENT" || code === "ELOOP"
                      ? `${absolute} is a broken link, or inside one.`
                      : `Could not make ${absolute}: ${describe(error)}`,
            );
        }

        // Made, or a folder already: either way it must be a folder now.
        return this.checkDirectory(absolute);
    }

    /** A path as a conversation means it: absolute, `~/…`, or relative to the conversation's working directory. */
    /**
     * Show a path in a file manager (the owner only; the route checks): this machine's for a session here, and for a
     * session on another computer, that computer's, through its runner. Nothing opens on this machine for a path there.
     */
    async reveal(user: User, id: ConversationId, path: string): Promise<void> {
        const runner = this.#app.runnerOf(id);

        if (runner === undefined) {
            await reveal(this.conversationPath(id, path));

            return;
        }

        const { access, file } = await this.remoteFile(user, id, path);
        const info = await this.#app.runners.link(runner).infoNow();
        const kind = await access
            .peek(file, 0)
            .then((found) => found.kind)
            .catch((error: unknown) => {
                if (error instanceof Unreachable) {
                    throw new HttpError(409, describe(error));
                }

                throw new HttpError(404, `${file} is not there`);
            });
        const env = this.#app.runners.env(runner, this.#app.cwdOf(id), this.#app.runnerScope(id));

        await revealOn(
            this.#app.runners.name(runner),
            file,
            kind === "directory",
            info.os,
            async ([command, args]) => {
                const result = await env.exec(
                    [command, ...args],
                    { timeout: 5 },
                    BACKGROUND_CONTEXT,
                );

                if (!result.ok) {
                    if (result.error.code === "timeout" || result.error.code === "spawn_error") {
                        return false;
                    }

                    throw new HttpError(409, describe(result.error));
                }

                // Explorer answers 1 even when it showed the file.
                return result.value.exitCode === 0 || command === "explorer.exe";
            },
        );
    }

    conversationPath(id: ConversationId, path: string): string {
        this.requireLocal(id);

        return resolve(this.#app.cwdOf(id), expandHome(path.trim()));
    }

    /**
     * A file a person may load through a conversation. People who can steer reach the whole machine through Pi anyway;
     * viewers and people invited to one session get only files under the conversation's folder or its uploads.
     */
    conversationFile(user: User, id: ConversationId, path: string): string {
        const file = this.conversationPath(id, path);

        // A session on another computer: its paths are there; only its uploads, kept here, load here.
        if (this.#app.runnerOf(id) !== undefined) {
            return this.#uploaded(id, path);
        }

        if (user.role !== "viewer" && user.sessions === undefined) {
            return file;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return undefined;
            }
        };

        const target = real(file);
        const cwd = this.#app.cwdOf(id);
        // A fork shows the messages it inherited, with the files attached to them in the sessions it came from. Their
        // later uploads are in the same folders, but an upload's name has random bits in it and shows only in its
        // message, so nobody who cannot read that message can name the file.
        const uploads = this.#lineage(id).map((each) =>
            join(this.#app.dataDir, "uploads", String(each)),
        );
        const roots = [cwd, ...uploads]
            .map(real)
            .filter((root): root is string => root !== undefined);

        if (
            target === undefined ||
            !roots.some((root) => target === root || target.startsWith(root + sep))
        ) {
            throw new HttpError(404, "Image not found");
        }

        return target;
    }

    /**
     * A file a person may read whole through a session: the viewer, and files sent along with a message. As
     * `conversationFile`, but Pi's own folder (sign-ins, settings) and this app's data (people, tokens, the database)
     * are the owner's alone. Uploads, worktrees, and PiP's clones (`repos/`), which sessions use, are not kept back.
     */
    readableFile(user: User, id: ConversationId, path: string): string {
        const file = this.conversationFile(user, id, path);

        if (user.role === "owner") {
            return file;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return resolve(target);
            }
        };

        const target = real(file);
        const inside = (root: string) => target === root || target.startsWith(root + sep);
        const data = real(this.#app.dataDir);

        if (
            inside(real(getAgentDir())) ||
            (inside(data) &&
                !inside(join(data, "uploads")) &&
                !inside(join(data, "worktrees")) &&
                !inside(join(data, "repos")))
        ) {
            throw new HttpError(404, "Not found");
        }

        return file;
    }

    /**
     * Where a file of a session on another computer is, for a person who may read it there: a path there, in its path
     * rules, with `~` its home there. Owners and people granted this computer read what Pi can; anyone else only what is
     * under the session's folder, links followed, as viewers here. Not there, or not theirs: 404.
     */
    async remoteFile(
        user: User,
        id: ConversationId,
        path: string,
    ): Promise<{ access: FolderAccess; file: string; home: string }> {
        const runner = this.#app.runnerOf(id)!;
        const access = await this.#access(id);
        const { home } = await this.#app.runners.link(runner).infoNow();
        const paths = access.path;
        const trimmed = path.trim();
        const expanded =
            trimmed === "~"
                ? home
                : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
                  ? paths.join(home, trimmed.slice(2))
                  : trimmed;
        const cwd = this.#app.cwdOf(id);
        const file = paths.resolve(cwd, expanded);

        // Pi's own read access (`docs/runners.md`): the owner's, and a chosen person's in the sessions they started there.
        // In another person's session shared with them, they read what anyone it is shared with may: its folder.
        if (
            user.role === "owner" ||
            (this.#app.runners.mayUse(runner, user) &&
                this.#app.sessionMeta(this.#app.rootOf(id))?.createdBy === user.id)
        ) {
            return { access, file, home };
        }

        // Both at once: each is a round trip.
        const [target, root] = await Promise.all([
            access.realpath(file),
            access.realpath(cwd),
        ]).catch((error: unknown) => {
            if (error instanceof Unreachable) {
                throw new HttpError(409, describe(error));
            }

            throw new HttpError(404, "Not found");
        });
        const inside = (base: string) =>
            target === base ||
            target.startsWith(base.endsWith(paths.sep) ? base : base + paths.sep);

        if (!inside(root)) {
            throw new HttpError(404, "Not found");
        }

        return { access, file: target, home };
    }

    /** Normalize without a remote read, so a kept image can load while its computer is offline, also after restart. */
    #imageSource(id: ConversationId, path: string): ImageSource {
        const runner = this.#app.runnerOf(id)!;
        const info = this.#app.runners.stored(runner)?.platform;
        const paths = info?.os === "windows" ? win32 : posix;
        const trimmed = path.trim();
        const home = info?.home;
        const expanded =
            home === undefined
                ? trimmed
                : trimmed === "~"
                  ? home
                  : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
                    ? paths.join(home, trimmed.slice(2))
                    : trimmed;
        const cwd = this.#app.cwdOf(id);

        return { runner, cwd, file: paths.resolve(cwd, expanded) };
    }

    async #keptImage(
        user: User,
        id: ConversationId,
        source: ImageSource,
    ): Promise<string | undefined> {
        for (const each of this.#lineage(id)) {
            const file = await this.#images.latest(each, source, user.role !== "owner");

            if (file !== undefined) {
                return file;
            }
        }

        return undefined;
    }

    async #copyImage(
        id: ConversationId,
        source: ImageSource,
        access: FolderAccess,
        file: string,
    ): Promise<string> {
        const [target, root] = await Promise.all([
            access.realpath(file),
            access.realpath(source.cwd),
        ]).catch((error: unknown) => {
            throw new HttpError(
                error instanceof Unreachable ? 409 : 404,
                error instanceof Unreachable ? error.message : "Image not found",
            );
        });
        const shared =
            target === root ||
            target.startsWith(root.endsWith(access.path.sep) ? root : root + access.path.sep);

        return this.#images.copy(id, source, access, shared, target);
    }

    /** Keep a successful tool write before the computer can go away, even if nobody has opened its image yet. */
    async copyRunnerImage(id: ConversationId, path: string): Promise<void> {
        if (this.#app.runnerOf(id) === undefined || !isImagePath(path)) {
            return;
        }

        const source = this.#imageSource(id, path);
        const access = await this.#access(id);

        await this.#copyImage(id, source, access, source.file);
    }

    /** The image route always serves this disk: a local file, an upload, or a checked copy from the session's computer. */
    async imageFile(user: User, id: ConversationId, path: string): Promise<{ file: string }> {
        if (this.#app.runnerOf(id) === undefined) {
            return { file: this.conversationFile(user, id, path) };
        }

        const uploaded = this.#uploadedOrUndefined(id, path);

        if (uploaded !== undefined) {
            return { file: uploaded };
        }

        const source = this.#imageSource(id, path);

        if (!this.#app.runners.link(source.runner).online) {
            const kept = await this.#keptImage(user, id, source);

            if (kept !== undefined) {
                return { file: kept };
            }
        }

        const { access, file } = await this.remoteFile(user, id, path);

        return { file: await this.#copyImage(id, source, access, file) };
    }

    /** A file people attached to a session, or to the sessions it was forked from: those are all that load here. */
    #uploaded(id: ConversationId, path: string): string {
        const file = this.#uploadedOrUndefined(id, path);

        if (file === undefined) {
            throw new HttpError(404, "Image not found");
        }

        return file;
    }

    #uploadedOrUndefined(id: ConversationId, path: string): string | undefined {
        const file = resolve(expandHome(path.trim()));

        // Only a path in the uploads folder is looked up on this disk: any other is a session's path, maybe elsewhere.
        if (!file.startsWith(join(this.#app.dataDir, "uploads") + sep)) {
            return undefined;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return undefined;
            }
        };

        const target = real(file);
        const roots = this.#lineage(id)
            .map((each) => real(join(this.#app.dataDir, "uploads", String(each))))
            .filter((root): root is string => root !== undefined);

        return target !== undefined && roots.some((root) => target.startsWith(root + sep))
            ? target
            : undefined;
    }

    /** This session and the sessions it was forked from, nearest first. */
    #lineage(id: ConversationId): ConversationId[] {
        const lineage = [id];

        for (
            let meta = this.#app.sessionMeta(id);
            meta?.forkedFrom !== undefined && lineage.length < 64;
        ) {
            const parent = meta.forkedFrom.id as unknown as ConversationId;

            if (lineage.includes(parent)) {
                break;
            }

            lineage.push(parent);
            meta = this.#app.sessionMeta(parent);
        }

        return lineage;
    }

    /**
     * The files in a conversation's folder, for `@` mentions in the message box: for people who can write to Pi. It lists
     * names under the folder only, so someone invited to one session sees no more than `conversationFile` lets them load.
     */
    async fileList(id: ConversationId, user: User): Promise<FileListing> {
        this.#app.requireSee(user, id);
        this.requireLocal(id);
        this.#app.requireSteer(user);
        await this.#app.conversation(id);

        const access = await this.#access(id);

        return this.#files.get(this.#app.cwdOf(id), access).catch(unreachable);
    }

    /**
     * A file or folder for the viewer, as a person who can steer may load it through the session (`conversationFile`):
     * its text, or that it is an image, a folder's entries, or binary.
     */
    async viewFile(
        id: ConversationId,
        user: User,
        path: string,
    ): Promise<{ path: string; display: string } & FileView> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        await this.#app.conversation(id);
        let file: string;

        try {
            // A session on another computer: its files are there, but for its uploads, kept here.
            const uploaded =
                this.#app.runnerOf(id) === undefined
                    ? undefined
                    : this.#uploadedOrUndefined(id, path);

            if (this.#app.runnerOf(id) !== undefined && uploaded === undefined) {
                const source = this.#imageSource(id, path);

                if (!this.#app.runners.link(source.runner).online) {
                    const kept = await this.#keptImage(user, id, source);

                    if (kept !== undefined) {
                        return {
                            path: source.file,
                            display: path,
                            ...(await viewFile(kept)),
                        };
                    }
                }

                const remote = await this.remoteFile(user, id, path);

                return {
                    path: remote.file,
                    display: remoteDisplay(
                        remote.file,
                        this.#app.cwdOf(id),
                        remote.home,
                        remote.access,
                    ),
                    ...(await viewFile(remote.file, remote.access)),
                };
            }

            file = uploaded ?? this.readableFile(user, id, path);

            return {
                path: file,
                display: displayPath(file, this.#app.cwdOf(id)),
                ...(await viewFile(file)),
            };
        } catch (error) {
            if (
                error instanceof Unreachable ||
                (error instanceof HttpError && error.status === 409)
            ) {
                throw new HttpError(409, describe(error));
            }

            if (error instanceof HttpError || (error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new HttpError(404, `${path} is not there.`);
            }

            throw new HttpError(409, describe(error));
        }
    }

    /**
     * Undo the uncommitted changes to one file of a session's repository. It changes files under Pi, so it takes the
     * right to drive and waits until Pi is not working; Pi is told, with its next message.
     */
    async revertChange(id: ConversationId, user: User, path: string): Promise<void> {
        this.#app.requireSee(user, id);
        this.requireLocal(id);
        await this.#app.requireDriver(id, user);

        if (this.#app.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before undoing a file.",
            );
        }

        const access = await this.#access(id);
        const kind = await revertFile(
            this.#app.cwdOf(id),
            path,
            user.sessions !== undefined,
            access,
        ).catch((error: unknown) => {
            throw new HttpError(409, describe(error));
        });
        const what =
            kind === "new" || kind === "added"
                ? `deleted ${path}, which was new since the last commit`
                : `undid the uncommitted changes to ${path}`;

        this.#forgetChanges(id);
        await this.#app.commands.note(id, user, what);
        await this.#app.collab.activity(id, user, what);
    }

    /** What changed in a session's folder: Pi's edits, and the uncommitted changes of its git repository. */
    async changes(id: ConversationId, user: User): Promise<Changes> {
        this.#app.requireSee(user, id);
        this.requireLocal(id);
        this.#app.requireSteer(user);

        // Someone invited to this session only sees the files in its folder, here as in `conversationFile`.
        const onlyHere = user.sessions !== undefined;
        const key = `${id}:${onlyHere}`;
        const underWay = this.#changesUnderWay.get(key);

        if (underWay !== undefined) {
            return underWay;
        }

        const pending = (async () => {
            const [access, entries] = await Promise.all([this.#access(id), this.#editEntries(id)]);

            return changesIn(this.#app.cwdOf(id), entries, onlyHere, access).catch(unreachable);
        })().finally(() => {
            if (this.#changesUnderWay.get(key) === pending) {
                this.#changesUnderWay.delete(key);
            }
        });

        this.#changesUnderWay.set(key, pending);

        return pending;
    }

    /** A session's history as far as Changes reads it, oldest first, read from storage since the last look. */
    async #editEntries(id: ConversationId): Promise<ClientEntry[]> {
        const read = await this.#app.transcripts.entriesAfter(
            id,
            this.#edits.get(id)?.last ?? 0,
            false,
        );
        // Another look may have read some of them meanwhile: keep each entry once, in order.
        const known = this.#edits.get(id) ?? { last: 0, entries: [] };
        const added = read.entries.flatMap((entry) => {
            const facts = entry.id > known.last ? editFacts(entry) : undefined;

            return facts === undefined ? [] : [facts];
        });
        const next = {
            last: Math.max(known.last, read.last),
            entries: added.length === 0 ? known.entries : [...known.entries, ...added],
        };

        this.#edits.delete(id);
        this.#edits.set(id, next);

        if (this.#edits.size > EDITS_KEPT) {
            this.#edits.delete(this.#edits.keys().next().value!);
        }

        return next.entries;
    }

    /** Looks under way began before a file was undone: one asked from now on looks again. */
    #forgetChanges(id: ConversationId): void {
        this.#changesUnderWay.delete(`${id}:true`);
        this.#changesUnderWay.delete(`${id}:false`);
    }

    /** The diff of one changed file in a session's repository. */
    async changeDiff(id: ConversationId, user: User, path: string): Promise<string> {
        this.#app.requireSee(user, id);
        this.requireLocal(id);
        this.#app.requireSteer(user);

        const access = await this.#access(id);

        try {
            return await diffOf(this.#app.cwdOf(id), path, user.sessions !== undefined, access);
        } catch (error) {
            throw new HttpError(error instanceof Unreachable ? 409 : 404, describe(error));
        }
    }

    uploadDirectory(id: ConversationId): string {
        const directory = join(this.#app.dataDir, "uploads", String(id));

        mkdirSync(directory, { recursive: true });

        return directory;
    }
}
