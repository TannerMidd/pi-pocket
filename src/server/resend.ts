/**
 * Sending a message again: it goes out in a new fork, made in one commit with a task that sends it. A restart before
 * the message went out cannot leave the fork without it. Whoever sends it again sends it right away as well; with one
 * request id per fork, it goes out once either way.
 */
import type { Context } from "@earendil-works/chord/context";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
    type ConversationId,
    defineTask,
    type EntryId,
    type InputEntry,
    type UserInput,
} from "@earendil-works/pi-durable";
import { InterruptsDoc, SessionsDoc, type SessionMeta } from "./docs.ts";
import { CONTEXT_BLOCK, FILE_BLOCK } from "./entry-format.ts";
import { describe } from "./errors.ts";
import { ownRequest, requestPerson } from "./requests.ts";
import { sameContent, uploadContent, type UploadContent } from "./upload-content.ts";
import { uploadInput } from "./upload-references.ts";

/** What a fork sends: the text, by whom, and the message whose images go along, when the model takes images. */
export type Resend = {
    text: string;
    by: string;
    uploads?: string[];
    /** Only set when this exact input was checked against the source policy before creating the fork. */
    uploadsApproved?: true;
    contentByRef?: Record<string, UploadContent>;
    images?: { entry: EntryId };
};

/** The request id of the message a fork was made to send. */
export const resendRequest = (resend: Resend) => ownRequest(resend.by, "resend");

/**
 * A message's text and images, from a `pi.user` entry's model message. Files sent along with it (`<file>` parts) are
 * left out: sent again, the message mentions them as before.
 */
export function userContent(model: unknown): { text: string; images: ImageContent[] } {
    const content = (model as { content?: unknown } | undefined)?.content;

    if (typeof content === "string") {
        return { text: content, images: [] };
    }

    const parts = Array.isArray(content) ? (content as (TextContent | ImageContent)[]) : [];

    return {
        text: parts
            .flatMap((part, index) =>
                part.type === "text" &&
                (index === 0 ||
                    (!part.text.startsWith(FILE_BLOCK) && !part.text.startsWith(CONTEXT_BLOCK)))
                    ? [part.text]
                    : [],
            )
            .join("\n"),
        images: parts.filter((part): part is ImageContent => part.type === "image"),
    };
}

/** The message to send: its text, with the images of the message it repeats. */
export const resendContent = (text: string, images: readonly ImageContent[]) =>
    images.length === 0 ? text : [{ type: "text" as const, text }, ...images];

export function resendDraft(
    resend: Resend,
    images: readonly ImageContent[],
    grants: ReadonlySet<string>,
    fork?: SessionMeta,
) {
    const refs =
        resend.uploadsApproved === true && Array.isArray(resend.uploads) ? resend.uploads : [];

    const retained = new Set(
        fork?.forkedFrom && Array.isArray(fork.inheritedUploads) ? fork.inheritedUploads : [],
    );

    return {
        type: "input" as const,
        content: resendContent(resend.text, images),
        ...uploadInput(
            refs.filter(
                (ref) =>
                    grants.has(ref) &&
                    retained.has(ref) &&
                    sameContent(
                        uploadContent(resend.contentByRef?.[ref]),
                        uploadContent(fork?.inheritedUploadContent?.[ref]),
                    ),
            ),
        ),
        requestId: resendRequest(resend),
    };
}

const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;

export type CanSteer = (id: ConversationId, person: string | undefined) => boolean;

/** A deferred input must name its requester. Legacy unowned inputs cannot borrow the driver's access. */
export function canRequeue(
    id: ConversationId,
    requestId: string | undefined,
    canSteer: CanSteer,
): boolean {
    const person = requestPerson(requestId);

    return person !== undefined && canSteer(id, person.userId);
}

/** Sends a fork's message, with the original's images read from where it was sent first. */
export const resendTask = (
    canSteer: CanSteer,
    checkedGrants: (id: ConversationId, input: Resend) => Promise<ReadonlySet<string>>,
) =>
    defineTask<Resend, { phase: "send" }, null>({
        name: "pocket.resend",
        version: 1,
        initial: () => ({ phase: "send" }),
        phases: {
            send: async (task, runtime, context) => {
                const resend = task.input;
                const original = resend.images?.entry;
                const conversation = await runtime.conversation(runtime.conversationId, context);
                const grants = canSteer(runtime.conversationId, resend.by)
                    ? await checkedGrants(runtime.conversationId, resend)
                    : new Set<string>();

                await runtime.commit(async (tx) => {
                    const images =
                        original === undefined
                            ? []
                            : userContent((await tx.entry(original))?.model?.[0]).images;

                    const fork =
                        resend.uploadsApproved === true
                            ? (await tx.doc(SessionsDoc)).items[String(runtime.conversationId)]
                            : undefined;

                    if (canSteer(runtime.conversationId, resend.by)) {
                        await conversation?.submit(tx, resendDraft(resend, images, grants, fork));

                        if (!canSteer(runtime.conversationId, resend.by)) {
                            throw new Error("The requester can no longer submit this message.");
                        }
                    }

                    return finished;
                }, context);
            },
        },
        abort: (_task, runtime, context) =>
            runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });

/** A queued message that stays queued across an Interrupt: sent again, in its place, under its own request id. */
export type Requeue = {
    content: UserInput;
    mode: "steer" | "followUp";
    requestId: string;
    entry?: InputEntry;
};

/**
 * An Interrupt: what it says, the request id it goes out with, the run it stops, and the other queued messages, in
 * their order, which the stop would withdraw and which are queued again after it.
 */
export type Interrupt = {
    content: UserInput;
    requestId: string;
    entry?: InputEntry;
    /** The run going at admission: only that run is stopped, never one that came after. */
    run?: number;
    others?: Requeue[];
};

/** Stops run `run` (a task id) and waits for its end; nothing when it has ended or is not known. */
export type StopRun = (run: number, context: Context, allowed: () => boolean) => Promise<void>;

/**
 * Stops the run, then sends the message stored by the commit making this task, so a restart in between cannot lose
 * it, and puts the other messages that were queued back. Every message has a request id, so a
 * restart at any point sends each once. Background, so the stop does not stop this task too. It stops the run it was
 * made for by its id (`stopRun`, from the app's harness), never whichever run is going: one that started after it ended
 * goes on.
 */
export const interruptTask = (stopRun: StopRun, canSteer: CanSteer) =>
    defineTask<Interrupt, { phase: "send" }, null>({
        name: "pocket.interrupt",
        version: 1,
        initial: () => ({ phase: "send" }),
        phases: {
            send: async (task, runtime, context) => {
                const { content, requestId, entry, run, others } = task.input;
                const id = runtime.conversationId;
                const allowed = () => canRequeue(id, requestId, canSteer);
                let sent = false;

                // Run again after a restart: after the send, the run it started must not be stopped.
                await runtime.commit(async (tx) => {
                    sent = (await tx.submissionByRequest(id, requestId)) !== undefined;

                    return undefined;
                }, context);

                const conversation = await runtime.conversation(id, context);

                if (!sent && allowed()) {
                    // The message has left the queue: a failure here must say so, not fault the task without a word.
                    try {
                        if (run !== undefined) {
                            await stopRun(run, context, allowed);
                        }

                        await runtime.commit(async (tx) => {
                            const interrupts = await tx.doc(InterruptsDoc, id);

                            if (!allowed()) {
                                return;
                            }

                            await conversation?.submit(tx, {
                                type: "input",
                                content,
                                requestId,
                                ...(entry === undefined ? {} : { entry }),
                            });
                            delete interrupts.pending[requestId];
                        }, context);
                    } catch (error) {
                        if (context.abortSignal?.aborted === true) {
                            throw error;
                        }

                        runtime.report(
                            new Error(
                                `A message moved to Interrupt was not sent: ${describe(error)}`,
                            ),
                        );
                    }
                }

                // In their order, behind the message: a request id already known finds its submission.
                for (const other of others ?? []) {
                    try {
                        await runtime.commit(async (tx) => {
                            if (canRequeue(id, other.requestId, canSteer)) {
                                await conversation?.submit(tx, {
                                    type: "input",
                                    content: other.content,
                                    whenBusy: other.mode,
                                    requestId: other.requestId,
                                    ...(other.entry === undefined ? {} : { entry: other.entry }),
                                });
                            }
                        }, context);
                    } catch (error) {
                        if (context.abortSignal?.aborted === true) {
                            throw error;
                        }

                        runtime.report(
                            new Error(`A queued message was not queued again: ${describe(error)}`),
                        );
                    }
                }

                // A message that was not sent leaves no receipt: a retry of its request makes a new handoff.
                await runtime.commit(async (tx) => {
                    delete (await tx.doc(InterruptsDoc, id)).pending[requestId];

                    return finished;
                }, context);
            },
        },
        abort: (_task, runtime, context) =>
            runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
