/**
 * Pi's sessions from the terminal, to continue in Pi Pocket. Pi keeps each in a JSONL file in its sessions folder
 * (`~/.pi/agent/sessions/`, a folder per project; or the one folder `PI_CODING_AGENT_SESSION_DIR` or `sessionDir` in
 * Pi's settings names), and finds them all with `SessionManager.listAll`, as `pi -r` lists every folder's. Their files
 * are only read, never written: Pi's own loader mends a file whose last line is cut off, and a `pi` still running may be
 * writing that line.
 *
 * A session continues here as a copy of where Pi left it, its current branch. People get every message of it to read,
 * and Pi gets the context Pi itself builds from the file (`buildSessionProjection`): a compaction becomes Pi Durable's,
 * keeping the same messages, and a context edit edits the same message. Pi's system prompt, its extensions' state, and
 * its model changes stay behind; Pi Pocket's prompt and tools apply. Nothing Pi did runs again: a tool call that never
 * finished gets a result saying so (Pi's says "No result provided"). Where Pi would send a tool result whose call is
 * not there (a stray one, or one whose call a context edit took out), Pi Durable leaves it out, as providers refuse it.
 */
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import {
    AssistantEntry,
    CompactionEntry,
    type ContextEdit,
    type ConversationId,
    type EntryId,
    ToolResultEntry,
    type Tx,
    UserEntry,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { FROM_PI_ENTRY, type FromPiData } from "./entry-format.ts";
import { HttpError } from "./errors.ts";

import {
    FOUND_FOR_MS,
    MAX_LISTED,
    SESSION_DIR_VARIABLE,
    PiSessionError,
    piSessionOf,
    readSessionEntries,
    readPiTail,
    titleOf,
    type PiSession,
} from "./pi-session-files.ts";
export { PiSessionError, readPiSession, type PiSession, type PiEntry } from "./pi-session-files.ts";
type Listed = { info: SessionInfo; words: string };

/**
 * Write a Pi session's copy into a new conversation, from its `init`: its messages, then where it came from. One
 * commit, so a copy is whole or not there at all (a big one too: its text is held once already).
 */
export async function writePiSession(
    tx: Tx,
    id: ConversationId,
    session: PiSession,
    data: FromPiData,
): Promise<void> {
    const made = new Map<string, EntryId>();

    for (const entry of session.entries) {
        const written =
            entry.kind === "compaction"
                ? await tx.appendEntry(CompactionEntry, id, {
                      model: [entry.message],
                      // A kept entry is written before its compaction, as Pi keeps them.
                      head: entry.head === null ? "self" : made.get(entry.head)!,
                      data: { reason: "threshold" },
                  })
                : entry.kind === "toolResult"
                  ? await tx.appendEntry(ToolResultEntry, id, {
                        model: [entry.message],
                        data: { diagnostics: [] },
                    })
                  : await tx.appendEntry(entry.kind === "user" ? UserEntry : AssistantEntry, id, {
                        model: [entry.message],
                    });

        if (entry.from !== undefined && !made.has(entry.from)) {
            made.set(entry.from, written.id);
        }
    }

    const edits: ContextEdit[] = session.edits.flatMap(({ target, messages }) => {
        const entry = made.get(target);

        if (entry === undefined) {
            return [];
        }

        return [
            messages.length === 0
                ? { target: entry, action: "omit" as const }
                : { target: entry, action: "replace" as const, messages },
        ];
    });

    // Last, after every entry it edits; it adds nothing for Pi itself.
    await tx.appendEntry(id, {
        kind: FROM_PI_ENTRY,
        data,
        ...(edits.length === 0 ? {} : { edits }),
    });
}

/** A Pi session as the list shows it. */
export type PiSessionSummary = {
    path: string;
    title: string;
    cwd: string;
    modified: number;
    messages: number;
    /** The newest session here that continues it, and whether Pi went on in the terminal since. */
    pocket?: { id: number; behind: boolean };
};

/** Local Pi files are the owner's. A runner controls access to its own Pi files. */
export class PiSessions {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /**
     * The last list, for a few seconds: reading every session's file again for each look, or each letter of a search,
     * is slow with many. It holds the words of every session, so it is let go when its time is up.
     */
    #found: { at: number; list: Promise<Listed[]> } | undefined;

    /**
     * Pi's sessions, newest first, as `pi -r` lists them all, each with what a search looks through, in lower case:
     * made once per list, not for every letter typed. `fresh` reads them again.
     */
    #find(fresh = true): Promise<Listed[]> {
        if (!fresh && this.#found !== undefined && Date.now() - this.#found.at < FOUND_FOR_MS) {
            return this.#found.list;
        }

        let configured: string | undefined;

        try {
            configured = this.#app.settings.getSessionDir();
        } catch {
            // Unreadable settings: Pi's own folder.
        }

        const folder = process.env[SESSION_DIR_VARIABLE] || configured;
        const list = (folder ? SessionManager.listAll(folder) : SessionManager.listAll()).then(
            (infos) =>
                infos.map((info) => {
                    const words = [
                        info.name ?? "",
                        info.cwd,
                        info.firstMessage,
                        info.allMessagesText,
                    ]
                        .join("\n")
                        .toLowerCase();

                    // Kept once, as the search's words: a session's whole text is the bulk of the list.
                    info.allMessagesText = "";

                    return { info, words };
                }),
        );
        const found = { at: Date.now(), list };

        this.#found = found;
        setTimeout(() => {
            if (this.#found === found) {
                this.#found = undefined;
            }
        }, FOUND_FOR_MS).unref();
        // A list that failed is not kept.
        list.catch(() => {
            if (this.#found === found) {
                this.#found = undefined;
            }
        });

        return list;
    }

    /** The newest session here that continues each of Pi's, by its id. */
    #continued(runner?: string): Map<string, { id: number; count: number }> {
        const found = new Map<string, { id: number; count: number }>();

        // Newest first: the first one seen of each is the one to open.
        for (const session of this.#app.sessions()) {
            const meta = this.#app.sessionMeta(session.id as unknown as ConversationId);
            const from = meta?.fromPi;

            if (meta?.runner === runner && from !== undefined && !found.has(from.session)) {
                found.set(from.session, { id: session.id, count: from.count });
            }
        }

        return found;
    }

    #requireOwner(user: User): void {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can continue Pi's sessions here.");
        }
    }

    /** Pi's sessions on this machine, newest first; with `query`, those whose title, folder, or words have it. */
    async list(user: User, query = "", runner?: string): Promise<{ sessions: PiSessionSummary[] }> {
        if (runner !== undefined) {
            this.#requireRunner(user, runner);
            const result = await this.#app.runners
                .link(runner)
                .piSessions({ op: "list", person: user.name });
            const needle = query.trim().toLowerCase();
            const continued = this.#continued(runner);

            return {
                sessions: (result.sessions ?? [])
                    .filter(
                        (info) =>
                            needle === "" ||
                            `${info.title}\n${info.cwd}`.toLowerCase().includes(needle),
                    )
                    .map((info) => {
                        const pocket = continued.get(info.id);

                        return {
                            path: info.path,
                            id: info.id,
                            title: info.title,
                            cwd: info.cwd,
                            modified: info.modified,
                            messages: info.messages,
                            ...(pocket === undefined
                                ? {}
                                : {
                                      pocket: {
                                          id: pocket.id,
                                          behind: info.messages > pocket.count,
                                      },
                                  }),
                        };
                    }),
            };
        }

        this.#requireOwner(user);
        const continued = this.#continued();
        const needle = query.trim().toLowerCase();
        // Opening the list reads it again; a search narrows the one just read.
        const found = (await this.#find(needle === ""))
            .filter((each) => needle === "" || each.words.includes(needle))
            .map((each) => each.info);

        return {
            sessions: found.slice(0, MAX_LISTED).map((info) => {
                const pocket = continued.get(info.id);

                return {
                    path: info.path,
                    title: titleOf(info),
                    cwd: info.cwd,
                    modified: info.modified.getTime(),
                    messages: info.messageCount,
                    ...(pocket === undefined
                        ? {}
                        : { pocket: { id: pocket.id, behind: info.messageCount > pocket.count } }),
                };
            }),
        };
    }

    #requireRunner(user: User, runner: string): void {
        this.#app.runners.require(runner);

        if (!this.#app.runners.mayUse(runner, user)) {
            throw new HttpError(
                403,
                "Only the person who linked this computer or the people they chose can use its Pi sessions.",
            );
        }
    }

    /** What Pi lists of one of its sessions: only a file Pi lists is read, so nothing else can be read through this. */
    async #listed(user: User, path: string): Promise<SessionInfo> {
        this.#requireOwner(user);

        const find = async (fresh: boolean) =>
            (await this.#find(fresh)).find((each) => each.info.path === path)?.info;
        // The list the sheet just showed, or, for a session new since, the list as it is now.
        const info = (await find(false)) ?? (await find(true));

        if (info === undefined) {
            throw new HttpError(404, "Pi has no such session. It may have been deleted.");
        }

        return info;
    }

    /** Read one of Pi's listed sessions with `read`, in words for people when it cannot be. */
    async #reading<T>(path: string, read: () => Promise<T>): Promise<T> {
        try {
            return await read();
        } catch (error) {
            // Gone since the list was read (it is kept a few seconds): as Pi not having it.
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
                throw new HttpError(404, "Pi has no such session. It may have been deleted.");
            }

            if (error instanceof PiSessionError) {
                throw new HttpError(400, error.message);
            }

            throw error;
        }
    }

    /** One of Pi's sessions, read whole, to continue it. */
    async read(user: User, path: string): Promise<PiSession> {
        await this.#listed(user, path);

        return this.#reading(path, async () => piSessionOf(await readSessionEntries(path)));
    }

    /**
     * One of Pi's sessions, to decide whether to continue it: where it worked, and its last messages. Quick for a big
     * one: what Pi lists of it, and its file's end.
     */
    async preview(user: User, path: string, runner?: string, signal?: AbortSignal) {
        if (runner !== undefined) {
            this.#requireRunner(user, runner);
            const info = (await this.list(user, "", runner)).sessions.find(
                (each) => each.path === path,
            );

            if (info === undefined) {
                throw new HttpError(
                    404,
                    `Pi has no such session on ${this.#app.runners.name(runner)}.`,
                );
            }

            const result = await this.#app.runners
                .link(runner)
                .piSessions({ op: "preview", path, person: user.name }, signal, user.id);
            const preview = result.preview;

            if (preview === undefined) {
                throw new HttpError(409, "The computer did not return the Pi session preview.");
            }

            const cwdExists = await this.#app.runners.checkFolder(runner, info.cwd).then(
                () => true,
                () => false,
            );
            const modelHere =
                preview.model !== null &&
                this.#app.models
                    .getAvailableSnapshot()
                    .some((each) => `${each.provider}/${each.id}` === preview.model);

            return { ...info, cwdExists, modelHere, model: preview.model, last: preview.last };
        }

        const info = await this.#listed(user, path);
        const { model, last } = await this.#reading(path, () => readPiTail(path));
        const pocket = this.#continued().get(info.id);
        let cwdExists = true;

        try {
            this.#app.workspace.checkDirectory(info.cwd);
        } catch {
            cwdExists = false;
        }

        const modelHere =
            model !== null &&
            this.#app.models
                .getAvailableSnapshot()
                .some((each) => each.provider === model.provider && each.id === model.modelId);

        return {
            path,
            title: titleOf(info),
            cwd: info.cwd,
            cwdExists,
            messages: info.messageCount,
            model: model === null ? null : `${model.provider}/${model.modelId}`,
            modelHere,
            last,
            ...(pocket === undefined
                ? {}
                : { pocket: { id: pocket.id, behind: info.messageCount > pocket.count } }),
        };
    }
}
