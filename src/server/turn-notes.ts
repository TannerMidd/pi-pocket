/**
 * Turn notes (`host.annotateTurns`): text that extensions add for the model after a person's message. Only a message
 * that Pi Durable places at once gets notes, so that the note goes in the same commit: Durable places a queued message
 * at the next boundary. A note is stored once and never recomputed, so the provider's prompt cache holds.
 */
import type { Context } from "@earendil-works/chord/context";
import {
    type Conversation,
    type ConversationId,
    InboxDoc,
    LiveDoc,
    type InputSubmissionDraft,
    type SubmissionId,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { TURN_NOTE_ENTRY, type TurnNoteData } from "./entry-format.ts";
import { describe } from "./errors.ts";

export type Turn = {
    readonly conversationId: number;
    readonly by: string;
    /** What sent it for them (PiP, a linked session, a webhook), when not their own typing. */
    readonly via?: string;
    /** As stored: hidden values hidden, attachments left out. */
    readonly text: string;
    readonly at: number;
    /** The newest time of a message, an answer, or a tool result among the conversation's last 32 entries. */
    readonly previousActivityAt?: number;
    readonly signal: AbortSignal;
};

export type TurnAnnotator = (turn: Turn) => string | undefined | Promise<string | undefined>;

/** For all annotators together: the message goes without the late ones. */
const ANNOTATE_TIMEOUT_MS = 2000;
const NOTE_MAX = 4000;

const NAME = /^[A-Za-z0-9][\w.:-]{0,59}$/;

type TurnNotesApp = Pick<PocketApp, "harness" | "hidden" | "notice" | "now">;

/** No string an annotator can return. */
const LATE = Symbol("late");

export class TurnNotes {
    readonly #annotators: { name: string; annotate: TurnAnnotator }[] = [];
    readonly #app: TurnNotesApp;

    constructor(app: TurnNotesApp) {
        this.#app = app;
    }

    add(name: string, annotate: TurnAnnotator): () => void {
        if (typeof name !== "string" || !NAME.test(name)) {
            throw new Error(
                "host.annotateTurns: the name must be 1 to 60 letters, digits, `.`, `_`, `:`, or `-`",
            );
        }

        if (typeof annotate !== "function") {
            throw new Error("host.annotateTurns: give it a function");
        }

        const entry = { name, annotate };

        this.#annotators.push(entry);

        return () => {
            const index = this.#annotators.indexOf(entry);

            if (index >= 0) {
                this.#annotators.splice(index, 1);
            }
        };
    }

    /** Undefined when no note goes with the message: the caller submits as usual. */
    async submit(
        conversation: Conversation,
        draft: InputSubmissionDraft & { requestId: string },
        turn: Omit<Turn, "signal" | "previousActivityAt" | "conversationId">,
        context: Context,
    ): Promise<SubmissionId | undefined> {
        if (this.#annotators.length === 0) {
            return undefined;
        }

        const id = conversation.id;

        if (!(await this.#idle(id, context))) {
            return undefined;
        }

        const notes = await this.#notes(conversation, turn, context);

        if (notes.length === 0) {
            return undefined;
        }

        return this.#app.harness.commit(async (tx) => {
            // A retry of the request finds its first submission: no second input, and no second note.
            const known = await tx.submissionByRequest(id, draft.requestId);

            if (known !== undefined) {
                return known.id;
            }

            // Read before the admission: it places the input now only when no run works and nothing waits.
            const idle =
                (await tx.doc(LiveDoc, id)).run === undefined &&
                (await tx.doc(InboxDoc, id)).items.length === 0;
            const submissionId = await conversation.submit(tx, draft);

            if (idle && (await tx.doc(LiveDoc, id)).run?.inputs.includes(submissionId) === true) {
                // The time of this commit, as the input's own: Durable stamps it here too.
                const timestamp = this.#app.now();

                for (const note of notes) {
                    await tx.appendEntry(id, {
                        kind: TURN_NOTE_ENTRY,
                        data: note,
                        model: [
                            {
                                role: "user",
                                content: [{ type: "text", text: modelText(note) }],
                                timestamp,
                            },
                        ],
                    });
                }
            }

            return submissionId;
        }, context);
    }

    async #idle(id: ConversationId, context: Context): Promise<boolean> {
        const live = await this.#app.harness.snapshot(LiveDoc, id, context);
        const inbox = await this.#app.harness.snapshot(InboxDoc, id, context);

        return live?.run === undefined && (inbox?.items.length ?? 0) === 0;
    }

    /** One that throws, is late, or is too long gives none. */
    async #notes(
        conversation: Conversation,
        turn: Omit<Turn, "signal" | "previousActivityAt" | "conversationId">,
        context: Context,
    ): Promise<TurnNoteData[]> {
        const id = conversation.id;
        const previousActivityAt = await lastActivity(conversation, context);
        const controller = new AbortController();
        const given: Turn = Object.freeze({
            ...turn,
            conversationId: Number(id),
            ...(previousActivityAt === undefined ? {} : { previousActivityAt }),
            signal: controller.signal,
        });
        const annotators = [...this.#annotators];
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<typeof LATE>((resolve) => {
            timer = setTimeout(() => {
                controller.abort(new Error("Time for turn notes ended"));
                resolve(LATE);
            }, ANNOTATE_TIMEOUT_MS);
        });
        const results = await Promise.all(
            annotators.map(async ({ name, annotate }) => {
                try {
                    const text = await Promise.race([
                        Promise.resolve().then(() => annotate(given)),
                        late,
                    ]);

                    if (text === LATE) {
                        throw new Error(`no note after ${ANNOTATE_TIMEOUT_MS} ms`);
                    }

                    if (text === undefined || text === null) {
                        return undefined;
                    }

                    if (typeof text !== "string") {
                        throw new Error("a note must be a string or undefined");
                    }

                    const trimmed = text.trim();

                    if (trimmed === "") {
                        return undefined;
                    }

                    if (trimmed.length > NOTE_MAX) {
                        throw new Error(`a note must be at most ${NOTE_MAX} characters`);
                    }

                    return { source: name, text: this.#app.hidden.replace(trimmed, id) };
                } catch (error) {
                    try {
                        this.#app.notice(
                            "warning",
                            `Turn note from ${name}: ${describe(error)}`,
                            id,
                        );
                    } catch {
                        // A notice that fails must not stop the message.
                    }

                    return undefined;
                }
            }),
        ).finally(() => clearTimeout(timer));

        return results.filter((note) => note !== undefined);
    }
}

/** The source comes before the text, so a note that looks like a person or another source still shows its source. */
export function modelText(note: TurnNoteData): string {
    return `Note from extension ${note.source}:\n${note.text}`;
}

/** Among the conversation's last 32 entries, a reset's or not. */
async function lastActivity(
    conversation: Conversation,
    context: Context,
): Promise<number | undefined> {
    const page = await conversation.entries({}, 32, undefined, context);
    const times = page.items
        .flatMap((entry) => entry.model ?? [])
        .map((message) => (message as { timestamp?: unknown }).timestamp)
        .filter((time): time is number => typeof time === "number" && Number.isFinite(time));

    return times.length === 0 ? undefined : Math.max(...times);
}
