/** Opt-in, durable continuation of a chat after its provider's five-hour subscription usage window resets. */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AgentDoc,
    type ConversationId,
    defineTask,
    GenerationTask,
    hook,
    type HookApi,
    InboxDoc,
    LiveDoc,
    type ModelRef,
    type TaskId,
    UserEntry,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { addActivity } from "./collab.ts";
import type { User } from "./config.ts";
import { ChatDoc, TurnsDoc, UsageResumeDoc, type UsageResume } from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { requestFor } from "./requests.ts";
import { usageResetAt } from "./usage-reset.ts";
import { describeMoment } from "./when.ts";

const context = BACKGROUND_CONTEXT;

export const USAGE_RESUME_PREFIX = "[usage reset] ";
const CONTINUE =
    `${USAGE_RESUME_PREFIX}The provider's subscription usage window should have reset. ` +
    "Continue the unfinished request in this chat from where you stopped. Check the existing progress first; " +
    "do not repeat completed work or rerun tool calls merely because of the limit. " +
    "Keep the same model and credentials.";
const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;

type ResumeInput = { sourceTaskId: TaskId; at: number; model: ModelRef; requestedBy: string };
type ResumeState = { phase: "wait" } | { phase: "send" };

/** A config-file permission change during the awaited writes rolls the admission back. */
class ResumeAdmissionCancelled extends Error {}

export class UsageResumes {
    readonly #app: PocketApp;
    readonly hook = hook(GenerationTask, {
        afterResponse: (message, api, context) => this.#afterResponse(message, api, context),
    });
    readonly task;

    constructor(app: PocketApp) {
        this.#app = app;
        this.task = defineTask<ResumeInput, ResumeState, null>({
            name: "pocket.usage-resume",
            version: 1,
            initial: () => ({ phase: "wait" }),
            phases: {
                wait: async (task, runtime, context) => {
                    await runtime.sleep(task.input.at, context);
                    await runtime.commit(
                        () => ({ status: "running", checkpoint: { phase: "send" } }),
                        context,
                    );
                },
                send: async (task, runtime, context) => {
                    const id = runtime.conversationId;
                    const input = task.input;
                    const requestId = requestFor(
                        input.requestedBy,
                        `usage-resume-${runtime.taskId}`,
                    );

                    await runtime
                        .commit(async (tx) => {
                            const doc = await tx.doc(UsageResumeDoc, id);

                            if (doc.pending?.taskId !== runtime.taskId) {
                                return finished;
                            }

                            const source = await tx.task(input.sourceTaskId);
                            const latest = (await tx.scanEntries({ conversationId: id }, 1))
                                .items[0];
                            const agent = await tx.doc(AgentDoc, id);
                            const live = await tx.doc(LiveDoc, id);
                            const inbox = await tx.doc(InboxDoc, id);
                            const turns = await tx.doc(TurnsDoc, this.#app.rootOf(id));
                            const alreadySent = await tx.submissionByRequest(id, requestId);
                            const error = latest?.model?.some(
                                (message) =>
                                    message.role === "assistant" && message.stopReason === "error",
                            );

                            if (
                                alreadySent !== undefined ||
                                !this.enabled(id, doc) ||
                                this.#personMayResume(id, input.requestedBy) === undefined ||
                                (turns.on && turns.driver !== input.requestedBy) ||
                                source?.state.status !== "terminal" ||
                                source.state.outcome.status !== "failed" ||
                                latest?.byTaskId !== input.sourceTaskId ||
                                !error ||
                                live.run !== undefined ||
                                inbox.items.length > 0 ||
                                agent.model?.provider !== input.model.provider ||
                                agent.model?.modelId !== input.model.modelId
                            ) {
                                delete doc.pending;

                                return finished;
                            }

                            // Implement only Durable's empty-inbox, idle-input admission using its public Tx API. The
                            // eligibility checks, user entry, placed submission, new run, and wake-up settlement share
                            // one Session commit: no permission/model/spend change can slip between check and admission.
                            const entry = await tx.appendEntry(UserEntry, id, {
                                model: [
                                    { role: "user", content: CONTINUE, timestamp: runtime.now() },
                                ],
                            });
                            const submission = await tx.createSubmission({
                                conversationId: id,
                                type: "input",
                                status: "placed",
                                entry: entry.id,
                                requestId,
                            });
                            const generation = await tx.createTask(
                                GenerationTask,
                                {},
                                {
                                    ownership: { kind: "conversation" },
                                    conversationId: id,
                                },
                            );

                            live.run = { taskId: generation, inputs: [submission.id] };
                            delete doc.pending;

                            // Roles and person budgets are config state, not Session documents: check once more after
                            // awaited writes, before publishing the admission. Throwing rolls back all staged work.
                            if (
                                !this.enabled(id, doc) ||
                                this.#personMayResume(id, input.requestedBy) === undefined
                            ) {
                                throw new ResumeAdmissionCancelled();
                            }

                            return finished;
                        }, context)
                        .catch(async (error: unknown) => {
                            if (!(error instanceof ResumeAdmissionCancelled)) {
                                throw error;
                            }

                            await runtime.commit(async (tx) => {
                                const doc = await tx.doc(UsageResumeDoc, id);

                                if (doc.pending?.taskId === runtime.taskId) {
                                    delete doc.pending;
                                }

                                return finished;
                            }, context);
                        });
                },
            },
            abort: (_task, runtime, context) =>
                runtime.commit(async (tx) => {
                    const doc = await tx.doc(UsageResumeDoc, runtime.conversationId);

                    if (doc.pending?.taskId === runtime.taskId) {
                        delete doc.pending;
                    }

                    return { status: "terminal", outcome: { status: "aborted" } };
                }, context),
        });
    }

    /** Main chats follow the global default; older explicit opt-ins remain enabled. */
    enabled(id: ConversationId, doc?: UsageResume): boolean {
        const meta = this.#app.sessionMeta(id);

        return (
            doc?.override ??
            (doc?.on === true ||
                (meta !== undefined &&
                    meta.pip === undefined &&
                    this.#app.config.usageResumeDefault))
        );
    }

    /** Cancel inherited wake-ups after the owner turns the default off, including rooms with no open browser. */
    async cancelDisabled(): Promise<void> {
        const app = this.#app;

        for (const session of app.sessions()) {
            const id = session.id as unknown as ConversationId;
            const saved = await app.harness.snapshot(UsageResumeDoc, id, context);

            if (!saved?.pending || this.enabled(id, saved)) {
                continue;
            }

            const cancelled = await app.harness.commit(async (tx) => {
                const doc = await tx.doc(UsageResumeDoc, id);

                if (this.enabled(id, doc)) {
                    return undefined;
                }

                const taskId = doc.pending?.taskId;

                delete doc.pending;

                return taskId;
            }, context);

            if (cancelled !== undefined) {
                await app.harness.abortTask(cancelled, context);
            }
        }
    }

    /** Shared per-chat override. Null follows the app default again. */
    async set(id: ConversationId, user: User, on: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (on !== null && typeof on !== "boolean") {
            throw new HttpError(400, "on must be true, false, or null (app default)");
        }

        if (app.sessionMeta(id) === undefined) {
            throw new HttpError(400, "Auto-resume is set in a chat's main conversation.");
        }

        const cancelled = await app.harness.commit(async (tx) => {
            const doc = await tx.doc(UsageResumeDoc, id);

            doc.on = on === true;

            if (on === null) {
                delete doc.override;
            } else {
                doc.override = on;
            }

            const pending = this.enabled(id, doc) ? undefined : doc.pending?.taskId;

            if (pending !== undefined) {
                delete doc.pending;
            }

            return pending;
        }, context);

        if (cancelled !== undefined) {
            await app.harness.abortTask(cancelled, context);
        }

        await app.collab.activity(
            id,
            user,
            on === null
                ? "set auto-resume to follow the app default"
                : `${on ? "turned on" : "turned off"} auto-resume after usage reset`,
        );
    }

    /** Stop one pending wake-up without stopping unrelated work or turning off the preference. */
    async cancel(id: ConversationId, user: User, taskId: unknown): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);

        if (typeof taskId !== "number" || !Number.isSafeInteger(taskId) || taskId <= 0) {
            throw new HttpError(400, "taskId must be a positive integer");
        }

        const pending = (await app.harness.snapshot(UsageResumeDoc, id, context))?.pending;

        if (pending !== undefined && Number(pending.taskId) === taskId) {
            await app.harness.abortTask(pending.taskId, context);
        }
    }

    #personMayResume(id: ConversationId, requestedBy: string): User | undefined {
        const app = this.#app;
        const person = app.config.userById(requestedBy);

        if (
            person === undefined ||
            person.role === "viewer" ||
            !app.canSee(person, id) ||
            app.sessionMeta(id)?.archived === true ||
            app.spend.heldBack(id, person.id) !== undefined
        ) {
            return undefined;
        }

        return person;
    }

    async #mayResume(id: ConversationId, requestedBy: string): Promise<User | undefined> {
        const person = this.#personMayResume(id, requestedBy);

        if (person === undefined) {
            return undefined;
        }

        // A changed driver must not have work started for the old one.
        try {
            await this.#app.requireDriver(id, person);
        } catch (error) {
            if (!(error instanceof HttpError)) {
                throw error;
            }

            return undefined;
        }

        return person;
    }

    async #afterResponse(message: AssistantMessage, api: HookApi, context: Context): Promise<void> {
        if (
            message.stopReason !== "error" ||
            !this.enabled(
                api.conversationId,
                await api.snapshot(UsageResumeDoc, api.conversationId, context),
            )
        ) {
            return;
        }

        const app = this.#app;
        const agent = await api.snapshot(AgentDoc, api.conversationId, context);
        const model = agent?.model;
        const requestedBy = app.attribution.requesterOf(api.conversationId);

        if (
            model === undefined ||
            model.provider !== message.provider ||
            model.modelId !== message.model ||
            requestedBy === undefined ||
            (await this.#mayResume(api.conversationId, requestedBy)) === undefined
        ) {
            return;
        }

        const at = usageResetAt(
            message.errorMessage ?? "",
            message.provider,
            app.providerLimits.forResponse(message),
            app.now(),
        );

        if (at === undefined) {
            return;
        }

        try {
            await app.harness.commit(async (tx) => {
                const doc = await tx.doc(UsageResumeDoc, api.conversationId);

                if (
                    !this.enabled(api.conversationId, doc) ||
                    doc.pending?.sourceTaskId === api.taskId
                ) {
                    return;
                }

                const taskId = await tx.createTask(
                    this.task,
                    { sourceTaskId: api.taskId, at, model, requestedBy },
                    { ownership: { kind: "conversation" }, conversationId: api.conversationId },
                );

                doc.pending = { taskId, sourceTaskId: api.taskId, at, provider: model.provider };
                addActivity(
                    await tx.doc(ChatDoc, api.conversationId),
                    { id: "pi", name: "Pi" },
                    `will resume after the usage reset at ${describeMoment(at, Intl.DateTimeFormat().resolvedOptions().timeZone)}. Stop it in Running now, or turn off auto-resume.`,
                    app.now(),
                );
            }, context);
        } catch (error) {
            app.notice(
                "warning",
                `Could not arrange auto-resume: ${describe(error)}`,
                api.conversationId,
            );
        }
    }
}
