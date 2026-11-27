/**
 * The one wrapper around `conversation.submit` (sandbox v2, design 2.3 and 4.8). A delivery only queues a message, and
 * the turn's tool calls take their own leases, but a delivery to a tree that is changing, or whose group breaks
 * invariant I1, must not be made: it defers. The check reads memory only and never waits (`Sandboxes.deliver`), and it
 * runs in the delivering commit, before anything is written, so a deferral leaves the item and its checkpoint as they
 * were. The caller catches `Deferred`, keeps its record, and asks again after `retryMs`.
 *
 * A source test (`test/sandbox-source.test.ts`) closes the list of `.submit(` callers: a direct call on a conversation
 * is allowed in this file only.
 */
import type { Context } from "@earendil-works/chord/context";
import type {
    ConversationHandle,
    ConversationId,
    Submission,
    SubmissionDraft,
    SubmissionId,
    Tx,
} from "@earendil-works/pi-durable";
import { Deferred } from "./sandbox.ts";

export { Deferred };

/** Throws `Deferred` when a delivery to the conversation's tree may not be made now (`Sandboxes.requireDelivery`). */
export type DeliveryCheck = (id: ConversationId) => void;

/** What both a `Conversation` and a task's `ConversationHandle` offer. */
export type Submitter = Pick<ConversationHandle, "id" | "submit">;

/** Deliver a message in the caller's commit `tx`. Throws `Deferred` before writing anything. */
export async function submitIn(
    check: DeliveryCheck,
    conversation: Submitter,
    tx: Tx,
    draft: SubmissionDraft,
): Promise<SubmissionId> {
    check(conversation.id);

    return await conversation.submit(tx, draft);
}

/** Deliver a message in its own commit. Throws `Deferred` before writing anything. */
export async function submitNow(
    check: DeliveryCheck,
    conversation: Submitter,
    draft: SubmissionDraft,
    context: Context,
): Promise<Submission> {
    check(conversation.id);

    return await conversation.submit(draft, context);
}

/**
 * A write that only records something (a person's note, the output of a `!` command): it starts no turn and runs
 * nothing, so it is no delivery of work. The `!` command that made its output ran under a lease (`shell.ts`).
 */
export function submitRecord(
    conversation: Submitter,
    draft: SubmissionDraft,
    context: Context,
): Promise<Submission> {
    return conversation.submit(draft, context);
}

/**
 * Look up a submission that was admitted before, by sending its request id again: Pi Durable returns the stored one and
 * places nothing new. It is no delivery, and it must keep working while a tree is suspended, so a follow can finish.
 */
export function replaySubmission(
    conversation: Submitter,
    draft: SubmissionDraft,
    context: Context,
): Promise<Submission> {
    return conversation.submit(draft, context);
}

/** Wait `ms`, or until `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted === true) {
            resolve();

            return;
        }

        const timer = setTimeout(resolve, ms);

        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}

/**
 * Run `work` (a delivering commit) until it is not deferred: the item and its checkpoint stay as they were, and the
 * attempt is made again after the delay the deferral names. `onDefer` is told once for each wait, so it can leave one
 * note. Any other error, and an abort, ends the loop as before.
 */
export async function untilDelivered<T>(
    work: () => Promise<T>,
    context: Context,
    onDefer?: (reason: string) => void,
): Promise<T> {
    for (;;) {
        try {
            return await work();
        } catch (error) {
            if (!(error instanceof Deferred)) {
                throw error;
            }

            onDefer?.(error.message);
            await pause(error.retryMs, context.abortSignal);
            context.abortSignal?.throwIfAborted();
        }
    }
}
