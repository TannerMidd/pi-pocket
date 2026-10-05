/**
 * Sending a message again: it goes out in a new fork, made in one commit with a task that sends it. A restart before
 * the message went out cannot leave the fork without it. Whoever sends it again sends it right away as well; with one
 * request id per fork, it goes out once either way.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineTask, type EntryId } from "@earendil-works/pi-durable";
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
	if (typeof content === "string") return { text: content, images: [] };
	const parts = Array.isArray(content) ? (content as (TextContent | ImageContent)[]) : [];
	return {
		text: parts.flatMap((part, index) => (part.type === "text" && (index === 0 || !part.text.startsWith('<file name="')) ? [part.text] : [])).join("\n"),
		images: parts.filter((part): part is ImageContent => part.type === "image"),
	};
}

/** The message to send: its text, with the images of the message it repeats. */
export const resendContent = (text: string, images: readonly ImageContent[]) => (images.length === 0 ? text : [{ type: "text" as const, text }, ...images]);

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
			await conversation?.submit({ type: "input", content: resendContent(resend.text, images), requestId: resendRequest(resend) }, context);
			await runtime.commit(() => finished, context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
