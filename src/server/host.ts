import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { ConversationId, Extension, ModelRef, TaskId } from "@earendil-works/pi-durable";
import type { Browsers } from "./browser.ts";
import type { Goals } from "./goals.ts";
import type { LancetGuard } from "./lancet.ts";
import type { Schedules } from "./schedules.ts";

export interface ApprovalRequest {
	id: string;
	conversationId: ConversationId;
	taskId: TaskId;
	/** The model's tool call id, to show the decision on the call's card afterwards. */
	callId?: string;
	tool: string;
	subject: string;
	reason: string;
	score?: number;
	createdAt: number;
	/** Who Pi was working for when the call asked: set by `Approvals`, not by the asker. */
	requestedBy?: string;
}

export type ApprovalAnswer = { allow: boolean; by: string };

/**
 * Tool calls waiting for a human. In memory on purpose: the guard hook runs before a call's intent is stored, so after
 * a restart the hook runs again and asks again, unless its memo already holds the answer.
 */
export class Approvals {
	readonly #pending = new Map<string, { request: ApprovalRequest; resolve: (answer: ApprovalAnswer) => void }>();
	readonly #listeners = new Set<(conversationId: ConversationId) => void>();
	readonly #requesterOf: (conversationId: ConversationId) => string | undefined;

	/** `requesterOf`: who Pi works for in a conversation right now. */
	constructor(requesterOf: (conversationId: ConversationId) => string | undefined) {
		this.#requesterOf = requesterOf;
	}

	request(asked: ApprovalRequest, context: Context): Promise<ApprovalAnswer> {
		// Who asked is fixed now: someone writing to Pi while the call waits does not become its requester.
		const { requestedBy: _ignored, ...rest } = asked;
		const requestedBy = this.#requesterOf(asked.conversationId);
		const request: ApprovalRequest = requestedBy === undefined ? rest : { ...rest, requestedBy };
		const existing = this.#pending.get(request.id);
		if (existing !== undefined) existing.resolve({ allow: false, by: "superseded" });
		const answered = new Promise<ApprovalAnswer>((resolve) => {
			this.#pending.set(request.id, { request, resolve });
		});
		this.#emit(request.conversationId);
		return awaitWithContext(answered, context).finally(() => {
			if (this.#pending.get(request.id)?.request === request) {
				this.#pending.delete(request.id);
				this.#emit(request.conversationId);
			}
		});
	}

	answer(id: string, answer: ApprovalAnswer): boolean {
		const pending = this.#pending.get(id);
		if (pending === undefined) return false;
		this.#pending.delete(id);
		pending.resolve(answer);
		this.#emit(pending.request.conversationId);
		return true;
	}

	forConversation(conversationId: ConversationId): ApprovalRequest[] {
		return [...this.#pending.values()]
			.map((pending) => pending.request)
			.filter((request) => request.conversationId === conversationId);
	}

	all(): ApprovalRequest[] {
		return [...this.#pending.values()].map((pending) => pending.request);
	}

	subscribe(listener: (conversationId: ConversationId) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(conversationId: ConversationId): void {
		for (const listener of this.#listeners) listener(conversationId);
	}
}

/** What the app gives its extensions. Extensions are reloaded on edit; the host is not. */
export interface PocketHost {
	readonly guard: LancetGuard;
	readonly approvals: Approvals;
	readonly agentDir: string;
	readonly dataDir: string;
	/** Pi's configured extra skill paths, from its settings. */
	skillPaths(): string[];
	/** `provider/modelId` (or a bare model id) to an available model, or an error naming the choices. */
	resolveModel(spec: string): ModelRef;
	/** Who Pi works for in a conversation now: whose message led to its current work. */
	requesterOf(conversationId: ConversationId): string | undefined;
	/** Report something odd to the log and the connected clients. */
	notice(level: "info" | "warning" | "error", message: string): void;
	/** Messages to Pi for later: the schedule tool sets up Pi's own. */
	readonly schedules: Pick<Schedules, "add" | "cancel" | "list" | "task">;
	/** Sessions' goals: the goals extension runs their checks and counts them. */
	readonly goals: Pick<Goals, "get" | "run" | "record" | "mayContinue">;
	/** The built-in browser: a page per conversation, which the people in it watch and use too. */
	readonly browsers: Pick<Browsers, "open">;
}

/** The shape of every module in `src/server/extensions/`: a default export building one or more extensions. */
export type ExtensionModule = {
	default: (host: PocketHost) => Extension | readonly Extension[];
};
