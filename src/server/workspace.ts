/**
 * A conversation's folder on this machine, as people reach it through the app: which files a person may load or read,
 * the file viewer, the files for `@` mentions, the Changes sheet, uploads, and new folders from the folder picker. The
 * operations people call directly check who may do them; the path helpers (`conversationPath`, `conversationFile`,
 * `readableFile`, `uploadDirectory`) leave seeing the conversation to their callers.
 */
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { type Changes, changesIn, diffOf, revertFile } from "./changes.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { FileLists, type FileListing, type FileView, viewFile } from "./files.ts";
import { displayPath, expandHome } from "./paths.ts";
import { inRepository } from "./worktrees.ts";

export class Workspace {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The files in each folder, for `@` mentions. */
    readonly #files = new FileLists();

    /** Folders known to be in a git repository or not, for a minute: views ask on every update. */
    readonly #repositories = new Map<string, { inside: boolean; at: number }>();

    /** Whether a folder is in a git repository. */
    inRepository(cwd: string): boolean {
        const known = this.#repositories.get(cwd);

        if (known !== undefined && Date.now() - known.at < 60_000) {
            return known.inside;
        }

        const inside = inRepository(cwd);

        this.#repositories.set(cwd, { inside, at: Date.now() });

        return inside;
    }

    checkDirectory(path: string): string {
        const absolute = resolve(expandHome(path.trim() === "" ? "~" : path.trim()));
        let ok = false;

        try {
            ok = statSync(absolute).isDirectory();
        } catch {
            ok = false;
        }

        if (!ok) {
            throw new HttpError(400, `${absolute} is not a directory`);
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

        const expanded = expandHome(written);

        if (!isAbsolute(expanded)) {
            throw new HttpError(400, "Give the folder's whole path, from / or ~.");
        }

        const absolute = resolve(expanded);

        try {
            mkdirSync(absolute, { recursive: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            throw new HttpError(
                409,
                code === "EEXIST" || code === "ENOTDIR"
                    ? `${absolute} is a file, or inside one.`
                    : `Could not make ${absolute}: ${describe(error)}`,
            );
        }

        // Made, or a folder already: either way it must be a folder now.
        return this.checkDirectory(absolute);
    }

    /** A path as a conversation means it: absolute, `~/…`, or relative to the conversation's working directory. */
    conversationPath(id: ConversationId, path: string): string {
        return resolve(this.#app.cwdOf(id), expandHome(path.trim()));
    }

    /**
     * A file a person may load through a conversation. People who can steer reach the whole machine through Pi anyway;
     * viewers and people invited to one session get only files under the conversation's folder or its uploads.
     */
    conversationFile(user: User, id: ConversationId, path: string): string {
        const file = this.conversationPath(id, path);

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
     * are the owner's alone. Uploads and worktrees, which sessions use, are not kept back.
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
            (inside(data) && !inside(join(data, "uploads")) && !inside(join(data, "worktrees")))
        ) {
            throw new HttpError(404, "Not found");
        }

        return file;
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
        this.#app.requireSteer(user);
        await this.#app.conversation(id);

        return this.#files.get(this.#app.cwdOf(id));
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
            file = this.readableFile(user, id, path);

            return {
                path: file,
                display: displayPath(file, this.#app.cwdOf(id)),
                ...(await viewFile(file)),
            };
        } catch (error) {
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
        await this.#app.requireDriver(id, user);

        if (this.#app.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before undoing a file.",
            );
        }

        const kind = await revertFile(this.#app.cwdOf(id), path, user.sessions !== undefined).catch(
            (error: unknown) => {
                throw new HttpError(409, describe(error));
            },
        );
        const what =
            kind === "new" || kind === "added"
                ? `deleted ${path}, which was new since the last commit`
                : `undid the uncommitted changes to ${path}`;

        await this.#app.commands.note(id, user, what);
        await this.#app.collab.activity(id, user, what);
    }

    /** What changed in a session's folder: Pi's edits, and the uncommitted changes of its git repository. */
    async changes(id: ConversationId, user: User): Promise<Changes> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        // Someone invited to this session only sees the files in its folder, here as in `conversationFile`.
        return changesIn(
            this.#app.cwdOf(id),
            await this.#app.transcripts.allEntries(id, false),
            user.sessions !== undefined,
        );
    }

    /** The diff of one changed file in a session's repository. */
    async changeDiff(id: ConversationId, user: User, path: string): Promise<string> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        try {
            return await diffOf(this.#app.cwdOf(id), path, user.sessions !== undefined);
        } catch (error) {
            throw new HttpError(404, describe(error));
        }
    }

    uploadDirectory(id: ConversationId): string {
        const directory = join(this.#app.dataDir, "uploads", String(id));

        mkdirSync(directory, { recursive: true });

        return directory;
    }
}
