/**
 * Sending a message again: it goes out in a new fork, made in one commit with a task that sends it. A restart before
 * the message went out cannot leave the fork without it. Whoever sends it again sends it right away as well; with one
 * request id per fork, it goes out once either way.
 */
import type { Context } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
    defineTask,
    type EntryId,
    type InputEntry,
    type UserInput,
} from "@earendil-works/pi-durable";
import { describe } from "./errors.ts";
import { ownRequest } from "./requests.ts";

/** What a fork sends: the text, by whom, and the message whose images go along, when the model takes images. */
export type Resend = { text: string; by: string; images?: { entry: EntryId } };

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
                part.type === "text" && (index === 0 || !part.text.startsWith('<file name="'))
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

const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;

/** Sends a fork's message, with the original's images read from where it was sent first. */
export const ResendTask = defineTask<Resend, { phase: "send" }, null>({
    name: "pocket.resend",
    version: 1,
    initial: () => ({ phase: "send" }),
    phases: {
        send: async (task, runtime, context) => {
            const resend = task.input;
            let images: ImageContent[] = [];
            const original = resend.images?.entry;

            if (original !== undefined) {
                // A commit that changes nothing, to read the original message.
                await runtime.commit(async (tx) => {
                    images = userContent((await tx.entry(original))?.model?.[0]).images;

                    return undefined;
                }, context);
            }

            const conversation = await runtime.conversation(runtime.conversationId, context);

            await conversation?.submit(
                {
                    type: "input",
                    content: resendContent(resend.text, images),
                    requestId: resendRequest(resend),
                },
                context,
            );
            await runtime.commit(() => finished, context);
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
 * A queued message moved to Interrupt: what it says, the request id it goes out with, the run it stops, and the other
 * queued messages, in their order, which the stop would withdraw and which are queued again after it.
 */
export type Interrupt = {
    content: UserInput;
    requestId: string;
    /** The run that was going when the message was moved: only that run is stopped, never one that came after. */
    run?: number;
    others?: Requeue[];
};

/** Stops run `run` (a task id) and waits for its end; nothing when it has ended or is not known. */
export type StopRun = (run: number, context: Context) => Promise<void>;

/**
 * Stops the run, then sends a queued message that the commit making this task took out of the queue, so a restart
 * in between cannot lose it, and puts the other messages that were queued back. Every message has a request id, so a
 * restart at any point sends each once. Background, so the stop does not stop this task too. It stops the run it was
 * made for by its id (`stopRun`, from the app's harness), never whichever run is going: one that started after it ended
 * goes on.
 */
export const interruptTask = (stopRun: StopRun) =>
    defineTask<Interrupt, { phase: "send" }, null>({
        name: "pocket.interrupt",
        version: 1,
        initial: () => ({ phase: "send" }),
        phases: {
            send: async (task, runtime, context) => {
                const { content, requestId, run, others } = task.input;
                const id = runtime.conversationId;
                let sent = false;

                // Run again after a restart: after the send, the run it started must not be stopped.
                await runtime.commit(async (tx) => {
                    sent = (await tx.submissionByRequest(id, requestId)) !== undefined;

                    return undefined;
                }, context);

                const conversation = await runtime.conversation(id, context);

                if (!sent) {
                    // The message has left the queue: a failure here must say so, not fault the task without a word.
                    try {
                        if (run !== undefined) {
                            await stopRun(run, context);
                        }

                        await conversation?.submit({ type: "input", content, requestId }, context);
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
                        await conversation?.submit(
                            {
                                type: "input",
                                content: other.content,
                                whenBusy: other.mode,
                                requestId: other.requestId,
                                ...(other.entry === undefined ? {} : { entry: other.entry }),
                            },
                            context,
                        );
                    } catch (error) {
                        if (context.abortSignal?.aborted === true) {
                            throw error;
                        }

                        runtime.report(
                            new Error(`A queued message was not queued again: ${describe(error)}`),
                        );
                    }
                }

                await runtime.commit(() => finished, context);
            },
        },
        abort: (_task, runtime, context) =>
            runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
