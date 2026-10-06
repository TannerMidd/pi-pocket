/**
 * Who Pi works for. Each message to Pi carries its person in its request id (`requests.ts`); as messages enter, this
 * notes who wrote each one, or whose work it is, in the conversation's authors document, and who queued each
 * submission. Pi works for whoever wrote the newest message. At startup it is read back, and what a crash kept out of
 * the authors documents is recovered from Pi Durable's records.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
    ConversationId,
    Cursor,
    EntryId,
    Storage,
    SubmissionId,
    SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { AuthorsDoc } from "./docs.ts";
import { describe } from "./errors.ts";
import { requestPerson } from "./requests.ts";
import type { Room } from "./room.ts";

const context = BACKGROUND_CONTEXT;

/** A message whose person its conversation's authors document misses. */
export type Missing = { entry: EntryId; userId: string; wrote: boolean };

/** Note in an authors document who wrote an entry, or (`wrote` false) whose work it is; a note stays once made. */
function noteAuthor(
    doc: { entries: Record<string, string>; requesters?: Record<string, string> },
    entry: EntryId,
    userId: string,
    wrote: boolean,
): void {
    // A draft copies what is assigned to it: the map is read back from the draft before it changes.
    if (!wrote) {
        doc.requesters ??= {};
    }

    (wrote ? doc.entries : doc.requesters!)[String(entry)] ??= userId;
}

export class Attribution {
    readonly #app: PocketApp;
    /** The messages (`conversation:entry`) whose person is noted already: each is noted once. */
    readonly #authored = new Set<string>();
    /** Who wrote to Pi last in each conversation: whoever asked for what Pi is doing there now. */
    readonly #lastAuthor = new Map<ConversationId, string>();
    /**
     * The entry `#lastAuthor` comes from. Pi works for whoever wrote the newest message: an older one that settles
     * later (after a restart, say) does not take that back.
     */
    readonly #lastAuthorEntry = new Map<ConversationId, number>();
    /** Who sent each submission, for queued messages. Filled from commits, or looked up once when missing. */
    readonly #submitters = new Map<number, string>();
    /** The submissions whose sender was looked up already, found or not. */
    readonly #lookups = new Set<number>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /**
     * Read back at startup who Pi works for in a conversation, from its authors document and, for the messages that
     * misses, from Pi Durable's records. Returns the ones it missed, for `repair`.
     */
    async recover(
        storage: Storage,
        id: ConversationId,
        authorsDoc:
            { entries: Record<string, string>; requesters?: Record<string, string> } | undefined,
    ): Promise<Missing[]> {
        const known: Record<string, string> = {
            ...authorsDoc?.requesters,
            ...authorsDoc?.entries,
        };
        const missing = await this.#unrecordedAuthors(storage, id, known);

        for (const { entry, userId } of missing) {
            known[String(entry)] = userId;
        }

        const newest = Object.entries(known).reduce<[string, string] | undefined>(
            (best, each) => (best === undefined || Number(each[0]) > Number(best[0]) ? each : best),
            undefined,
        );

        if (newest !== undefined) {
            this.#lastAuthor.set(id, newest[1]);
            this.#lastAuthorEntry.set(id, Number(newest[0]));
        }

        // Their authors are known: a message settling after the restart is not noted again.
        for (const entry of Object.keys(known)) {
            this.#authored.add(`${String(id)}:${entry}`);
        }

        return missing;
    }

    /** Write what `recover` found missing into the authors documents, all in one commit. */
    async repair(unrecorded: ReadonlyMap<ConversationId, readonly Missing[]>): Promise<void> {
        if (unrecorded.size > 0) {
            await this.#app.harness.commit(async (tx) => {
                for (const [id, missing] of unrecorded) {
                    const doc = await tx.doc(AuthorsDoc, id);

                    for (const { entry, userId, wrote } of missing) {
                        noteAuthor(doc, entry, userId, wrote);
                    }
                }
            }, context);
        }
    }

    /**
     * Store who wrote an entry, or (`wrote` false) whose work it is. Commit listeners may not call Session APIs, so
     * this commits right after.
     */
    #noteAuthor(
        conversationId: ConversationId,
        entry: EntryId,
        userId: string,
        wrote: boolean,
    ): void {
        setImmediate(() => {
            this.#app.harness
                .commit(
                    async (tx) =>
                        noteAuthor(await tx.doc(AuthorsDoc, conversationId), entry, userId, wrote),
                    context,
                )
                .catch((error: unknown) =>
                    this.#app.log(`author not recorded: ${describe(error)}`),
                );
        });
    }

    /**
     * Messages in a conversation whose person the authors document misses, from Pi Durable's records of them: it is
     * written just after a message enters, and a crash in between loses that.
     */
    async #unrecordedAuthors(
        storage: Storage,
        id: ConversationId,
        known: Readonly<Record<string, string>>,
    ): Promise<{ entry: EntryId; userId: string; wrote: boolean }[]> {
        const missing: { entry: EntryId; userId: string; wrote: boolean }[] = [];
        let cursor: Cursor | undefined;

        do {
            const page = await storage.scanSubmissions(
                { conversationId: id },
                256,
                cursor,
                context,
            );

            for (const record of page.items) {
                // Writes too: a `!` command Pi sees, or a note, is its person's (`shell.ts`, `Commands.note`).
                const entry = record.entry;
                const person = requestPerson(record.requestId);

                if (
                    entry !== undefined &&
                    person !== undefined &&
                    known[String(entry)] === undefined
                ) {
                    missing.push({ entry, ...person });
                }
            }

            cursor = page.next;
        } while (cursor !== undefined);

        return missing;
    }

    /** A message or write to Pi was placed or settled: who sent it, and whose work it is. */
    submissionCommitted(record: SubmissionRecord): void {
        const person = requestPerson(record.requestId);

        if (person?.wrote === true) {
            this.#submitters.set(record.id as unknown as number, person.userId);
        }

        // A message's submission changes as it is placed and answered; its author is noted once, when it enters.
        // A write that is a person's (a `!` command Pi sees, a note) counts as theirs too: it speaks to Pi.
        const key = `${record.conversationId}:${String(record.entry)}`;

        if (
            (record.type === "input" || person !== undefined) &&
            record.entry !== undefined &&
            !this.#authored.has(key)
        ) {
            const conversationId = record.conversationId;
            const parent = this.#app.parentOf(conversationId);
            // Subagent tasks started before they carried their person are the work of whoever the parent works for.
            const requester =
                person?.userId ??
                (record.requestId?.startsWith("subagent:") && parent !== undefined
                    ? this.requesterOf(parent)
                    : undefined);

            if (requester !== undefined) {
                this.#authored.add(key);
                const entry = Number(record.entry);

                if (entry >= (this.#lastAuthorEntry.get(conversationId) ?? -1)) {
                    this.#lastAuthorEntry.set(conversationId, entry);
                    this.#lastAuthor.set(conversationId, requester);
                }

                this.#noteAuthor(conversationId, record.entry, requester, person?.wrote === true);
            }
        }
    }

    /** Who queued a message, when known without a lookup. */
    knownSubmitter(submissionId: number): string | undefined {
        return this.#submitters.get(submissionId);
    }

    /** Who queued a message: `{ by }` when known. Unknown ones (from before a restart) are looked up once. */
    submitterOf(submissionId: number, room: Room): { by?: string } {
        const by = this.#submitters.get(submissionId);

        if (by !== undefined) {
            return { by };
        }

        if (!this.#lookups.has(submissionId)) {
            this.#lookups.add(submissionId);
            void this.#app.harness
                .submission(submissionId as unknown as SubmissionId, context)
                .then((submission) => submission?.status(context))
                .then((record) => {
                    const person = requestPerson(record?.requestId);

                    if (person?.wrote === true) {
                        this.#submitters.set(submissionId, person.userId);
                        room.schedule();
                    }
                })
                .catch(() => {});
        }

        return {};
    }

    /**
     * Who Pi works for in a conversation: the last person who wrote to it, or, for a subagent, whoever its parent worked
     * for when it sent the subagent its last message.
     */
    requesterOf(id: ConversationId): string | undefined {
        return this.#lastAuthor.get(id) ?? this.#lastAuthor.get(this.#app.rootOf(id));
    }
}
