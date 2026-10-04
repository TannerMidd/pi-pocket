import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { ConversationId, Extension, ModelRef, TaskId } from "@earendil-works/pi-durable";
import type { LancetGuard } from "./lancet.ts";

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
}

export type ApprovalAnswer = { allow: boolean; by: string };

/**
 * Tool calls waiting for a human. In memory on purpose: the guard hook runs before a call's intent is stored, so after
 * a restart the hook runs again and asks again, unless its memo already holds the answer.
 */
export class Approvals {
	readonly #pending = new Map<string, { request: ApprovalRequest; resolve: (answer: ApprovalAnswer) => void }>();
	readonly #listeners = new Set<(conversationId: ConversationId) => void>();

	request(request: ApprovalRequest, context: Context): Promise<ApprovalAnswer> {
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
	/** Report something odd to the log and the connected clients. */
	notice(level: "info" | "warning" | "error", message: string): void;
}

/** The shape of every module in `src/server/extensions/`: a default export building one or more extensions. */
export type ExtensionModule = {
	default: (host: PocketHost) => Extension | readonly Extension[];
};
