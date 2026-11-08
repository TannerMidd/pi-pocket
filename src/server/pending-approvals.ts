/** Read-only approval observations, filtered for the person and the whole audience of a source session. */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { HttpError } from "./errors.ts";
import type { ApprovalRequest } from "./host.ts";

/** A pending approval. No arguments, free-text reasons, form fields, or answers leave this API. */
export interface PendingApproval {
    readonly id: string;
    readonly conversationId: ConversationId;
    readonly session: ConversationId;
    readonly createdAt: number;
    readonly tool: "bash" | "write" | "edit" | "ask" | "tool";
    readonly summary: string;
    readonly state: "pending";
}

export interface ResolvedApproval extends Omit<PendingApproval, "state"> {
    readonly state: "resolved";
    readonly outcome: "allowed" | "denied" | "cancelled" | "superseded";
}

export interface ApprovalEvents {
    created: PendingApproval;
    resolved: ResolvedApproval;
}

export interface PendingApprovalsApi {
    /** Pending approvals visible to the requester and everyone who can see `source`. */
    list(source: ConversationId): readonly PendingApproval[];
    /** Subscribe before listing; reconcile by id. Pass the returned disposer to `web.onDispose`. */
    on<E extends keyof ApprovalEvents>(
        source: ConversationId,
        event: E,
        listener: (approval: ApprovalEvents[E]) => unknown,
    ): () => void;
}

/** Internal transitions carry the original request, never exposed to an extension through the public facade. */
export type ApprovalTransition =
    | { event: "created"; request: ApprovalRequest }
    | { event: "resolved"; request: ApprovalRequest; outcome: ResolvedApproval["outcome"] };

const summaries = {
    bash: "Run a command (arguments redacted)",
    write: "Write a file (arguments redacted)",
    edit: "Edit a file (arguments redacted)",
    ask: "Answer a question (contents redacted)",
    tool: "Run a tool (arguments redacted)",
} as const;

function describe(app: PocketApp, request: ApprovalRequest): PendingApproval {
    // Do not try to recognize secrets in arbitrary shell commands, paths, or prose. Withhold all such text.
    const tool =
        request.form !== undefined
            ? "ask"
            : request.tool === "bash" || request.tool === "write" || request.tool === "edit"
              ? request.tool
              : "tool";

    return Object.freeze({
        id: request.id,
        conversationId: request.conversationId,
        session: app.rootOf(request.conversationId),
        createdAt: request.createdAt,
        tool,
        summary: summaries[tool],
        state: "pending",
    });
}

export function pendingApprovalsFor(app: PocketApp): PendingApprovalsApi {
    function person(source: ConversationId): string {
        const meta = app.sessionMeta(source);
        const by = app.attribution.requesterOf(source);
        const user = by === undefined ? undefined : app.config.userById(by);

        if (meta === undefined || meta.pip !== undefined || user === undefined) {
            throw new HttpError(
                403,
                "Approval observations need a session where Pi works for someone.",
            );
        }

        app.requireSee(user, source);

        return user.id;
    }

    function visible(source: ConversationId, by: string, request: ApprovalRequest): boolean {
        const user = app.config.userById(by);
        const meta = app.sessionMeta(source);
        const target = app.sessionMeta(app.rootOf(request.conversationId));

        return (
            user !== undefined &&
            meta !== undefined &&
            meta.pip === undefined &&
            target !== undefined &&
            target.pip === undefined &&
            app.canSee(user, source) &&
            app.canSee(user, request.conversationId) &&
            app.config.users
                .filter((each) => app.canSee(each, source))
                .every((each) => app.canSee(each, request.conversationId))
        );
    }

    return Object.freeze({
        list(source: ConversationId): readonly PendingApproval[] {
            const by = person(source);

            return Object.freeze(
                app.approvals
                    .all()
                    .filter((request) => visible(source, by, request))
                    .map((request) => describe(app, request)),
            );
        },
        on<E extends keyof ApprovalEvents>(
            source: ConversationId,
            event: E,
            listener: (approval: ApprovalEvents[E]) => unknown,
        ): () => void {
            const by = person(source);

            if (event !== "created" && event !== "resolved") {
                throw new Error(`host.pendingApprovals.on: no event ${String(event)}`);
            }

            if (typeof listener !== "function") {
                throw new Error("host.pendingApprovals.on: give it a function");
            }

            let active = true;
            const off = app.approvals.observe((change) => {
                if (change.event !== event) {
                    return;
                }

                const pending = describe(app, change.request);
                const value =
                    change.event === "created"
                        ? pending
                        : Object.freeze({
                              ...pending,
                              state: "resolved" as const,
                              outcome: change.outcome,
                          });

                // Deliver after the change, outside the approval's path. Recheck access on delivery, not enqueue.
                queueMicrotask(() => {
                    if (!active || !visible(source, by, change.request)) {
                        return;
                    }

                    try {
                        Promise.resolve(listener(value as ApprovalEvents[E])).catch(failed);
                    } catch (error) {
                        failed(error);
                    }
                });
            });

            const failed = (_error: unknown) => {
                // A listener's exception can itself hold a secret. Do not copy it to a log.
                app.log(`host.pendingApprovals.on(${event}): a listener failed`);
            };

            return () => {
                active = false;
                off();
            };
        },
    });
}
