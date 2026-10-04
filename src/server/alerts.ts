/**
 * Push notifications: who hears about what, and when. Pi finished, Pi needs approval, mentions, and chat messages go
 * to the people who take part in a session, unless they are looking at it or turned that kind off.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { AuthorsDoc, ChatDoc } from "./docs.ts";
import { describe } from "./errors.ts";
import { entryText, projectEntry, snippet } from "./projection.ts";
import type { PushMessage, PushPrefs } from "./push.ts";

const context = BACKGROUND_CONTEXT;

/** How long a run must stay finished before "Pi finished" is pushed: a queued follow-up often starts right away. */
const DONE_DELAY_MS = 3000;
/**
 * A call is offered for allowing from a notification only when all of it shows there, collapsed: one short line. A
 * longer one could hide its risky part below the fold; it opens the app instead. Denying is always offered.
 */
const MAX_NOTIFIED_CALL = 120;
/** Characters that break a line, are invisible, or reorder text: a call with any of them may not read as it runs. */
const DISGUISING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export class Alerts {
	readonly #app: PocketApp;
	readonly #doneTimers = new Map<ConversationId, NodeJS.Timeout>();
	/** Approvals already announced, so each one is pushed once. */
	#approvalIds = new Set<string>();

	constructor(app: PocketApp) {
		this.#app = app;
	}

	/** Push to one person about a conversation, unless they cannot see it, turned that kind off, or are looking at it. */
	async push(userId: string, id: ConversationId, kind: keyof PushPrefs, message: PushMessage, urgency: "normal" | "high" = "normal"): Promise<void> {
		const app = this.#app;
		const store = app.pushStore;
		const user = app.config.userById(userId);
		if (store === undefined || user === undefined || !app.canSee(user, id)) return;
		if (!store.prefs(userId)[kind] || app.watching(userId, id) || store.subscriptions(userId).length === 0) return;
		// Push services want a real contact; Apple rejects placeholders. A tunnel's https address will do.
		const subject = app.access?.url?.startsWith("https://") ? app.access.url : undefined;
		await store.notify(userId, message, { urgency, ...(subject === undefined ? {} : { subject }) });
	}

	/** A run started or ended. "Pi finished" goes out once it has stayed finished for a moment. */
	runChanged(id: ConversationId, busy: boolean): void {
		clearTimeout(this.#doneTimers.get(id));
		this.#doneTimers.delete(id);
		if (busy || this.#app.sessionMeta(id) === undefined || this.#app.pushStore === undefined) return;
		const timer = setTimeout(() => {
			this.#doneTimers.delete(id);
			void this.#pushDone(id).catch((error: unknown) => this.#app.log(`push failed: ${describe(error)}`));
		}, DONE_DELAY_MS);
		timer.unref();
		this.#doneTimers.set(id, timer);
	}

	async #pushDone(id: ConversationId): Promise<void> {
		const app = this.#app;
		if (app.isBusy(id)) return;
		const conversation = await app.harness.conversation(id, context);
		if (conversation === undefined) return;
		const page = await conversation.entries({}, 12, undefined, context);
		const last = page.items.map((entry) => projectEntry(entry)).find((entry) => entry?.kind === "assistant");
		if (last?.kind !== "assistant" || last.stopReason === "aborted") return;
		const title = await app.conversationTitle(id);
		const failed = last.stopReason === "error";
		const message: PushMessage = {
			title: failed ? `Pi stopped with an error · ${title}` : `Pi finished · ${title}`,
			body: snippet(failed ? (last.error ?? "The model request failed.") : entryText(last) || "Done.", 400),
			url: `/s/${String(id)}`,
			tag: `done-${String(id)}`,
		};
		for (const userId of await this.participants(id)) void this.push(userId, id, "done", message);
	}

	/** New approvals go out to everyone in the session who can answer them. */
	announceApprovals(): void {
		const app = this.#app;
		const pending = app.approvals.all();
		const fresh = pending.filter((approval) => !this.#approvalIds.has(approval.id));
		this.#approvalIds = new Set(pending.map((approval) => approval.id));
		if (app.pushStore === undefined) return;
		for (const approval of fresh) {
			void (async () => {
				const root = app.rootOf(approval.conversationId);
				const title = await app.conversationTitle(root);
				const call = `${approval.tool}: ${approval.subject}`;
				const shown = !DISGUISING.test(approval.subject) && call.length <= MAX_NOTIFIED_CALL;
				let people = await this.participants(root);
				if (people.size === 0) people = new Set(app.config.users.map((each) => each.id));
				for (const userId of people) {
					const user = app.config.userById(userId);
					if (user === undefined || user.role === "viewer") continue;
					const message: PushMessage = {
						title: `Pi needs approval · ${title}`,
						body: snippet(call, 400),
						url: `/s/${String(approval.conversationId)}`,
						tag: `approval-${approval.id}`,
						approval: { id: approval.id, allow: shown && app.cannotAllow(user, approval) === undefined },
					};
					void this.push(userId, approval.conversationId, "approval", message, "high");
				}
			})().catch((error: unknown) => app.log(`push failed: ${describe(error)}`));
		}
	}

	/** People who take part in a session: whoever started it, wrote to Pi, or chatted there. */
	async participants(id: ConversationId): Promise<Set<string>> {
		const app = this.#app;
		const root = app.rootOf(id);
		const people = new Set<string>();
		const createdBy = app.sessionMeta(root)?.createdBy;
		if (createdBy !== undefined) people.add(createdBy);
		for (const userId of Object.values((await app.harness.snapshot(AuthorsDoc, root, context))?.entries ?? {})) people.add(userId);
		for (const message of (await app.harness.snapshot(ChatDoc, root, context))?.messages ?? []) if (message.kind !== "event") people.add(message.userId);
		return people;
	}

	close(): void {
		for (const timer of this.#doneTimers.values()) clearTimeout(timer);
		this.#doneTimers.clear();
	}
}
