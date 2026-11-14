/** One durable, independently evaluated objective per session. */
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import {
    type ConversationId,
    defineDoc,
    type DocumentReader,
    type EntryId,
    type HookApi,
    InboxDoc,
    LiveDoc,
    type ModelRef,
    ToolResultEntry,
    UsageDoc,
    type UsageState,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { BackgroundDoc, GoalDoc, PlanDoc, SubagentsDoc, TurnsDoc } from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { evaluateGoal, type GoalEvaluation, type GoalEvaluationPolicy } from "./goal-evaluator.ts";
import { resolveModel } from "./models.ts";

const context = BACKGROUND_CONTEXT;
const MAX_OBJECTIVE = 4_000;
const MAX_EVIDENCE = 24_000;
const EXTENSION = "pocket-objective-goal";
const EVALUATION_MEMO = "pocket.objective-goal.evaluation";
const EVALUATION_STARTED = "pocket.objective-goal.evaluation-started";

type Status = "active" | "paused" | "blocked" | "completed" | "budget";
type ObjectiveGoal = {
    /** Stable across edits and pauses. An older stored goal's first revision supplies its identity. */
    id?: string;
    revision: string;
    objective: string;
    status: Status;
    budget: number | null;
    evaluatorModel?: ModelRef;
    turns: number;
    emptyTurns: number;
    tokens: number;
    tokenBase: number;
    startEntry: number;
    lastEvidence: number;
    activeSince?: number;
    activeMs: number;
    reason?: string;
    lastTask?: number;
    continuation?: string;
};

type Kickoff = { revision: string; objective: string; resumed: boolean; revised?: true };

export const ObjectiveGoalDoc = defineDoc<{
    goal?: ObjectiveGoal;
    lastRequest?: string;
    evaluationCharges?: string[];
    pending?: Kickoff;
}>({
    kind: "pocket.objective-goal",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    checkpointWhen: () => false,
    initial: () => ({}),
});

const label: Record<Status, string> = {
    active: "Active",
    paused: "Paused",
    blocked: "Blocked",
    completed: "Completed",
    budget: "Budget reached",
};

function tokens(usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): number {
    return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function used(ledger: UsageState | undefined): number {
    return [...Object.values(ledger?.models ?? {}), ...Object.values(ledger?.tools ?? {})].reduce(
        (sum, usage) => sum + tokens(usage),
        0,
    );
}

function usedByGoal(goal: ObjectiveGoal, ledger: number): number {
    return goal.status === "active" ? Math.max(goal.tokens, ledger - goal.tokenBase) : goal.tokens;
}

function statusText(goal: ObjectiveGoal | undefined, ledger: number, now: number): string {
    if (goal === undefined) {
        return "No goal set. Use /goal <objective> to start one.";
    }

    const elapsed = Math.floor(
        (goal.activeMs + (goal.activeSince === undefined ? 0 : now - goal.activeSince)) / 1_000,
    );

    return [
        label[goal.status],
        `Objective: ${goal.objective}`,
        `Turns evaluated: ${goal.turns}`,
        `Tokens: ${usedByGoal(goal, ledger)}${goal.budget === null ? "" : ` / ${goal.budget}`}`,
        `Active time: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`,
        ...(goal.evaluatorModel === undefined
            ? []
            : [`Evaluator: ${goal.evaluatorModel.provider}/${goal.evaluatorModel.modelId}`]),
        ...(goal.reason === undefined ? [] : [`Last result: ${goal.reason}`]),
    ].join("\n");
}

function stop(
    goal: ObjectiveGoal,
    state: Exclude<Status, "active">,
    reason: string,
    now: number,
): void {
    if (goal.activeSince !== undefined) {
        goal.activeMs += Math.max(0, now - goal.activeSince);
        delete goal.activeSince;
    }

    goal.status = state;
    goal.reason = reason;
    delete goal.continuation;
}

/** Make an in-flight verdict stale while retaining the goal's identity and usage. */
function revise(goal: ObjectiveGoal): void {
    goal.id ??= goal.revision;
    goal.revision = randomUUID();
    delete goal.continuation;
}

function budgetValue(text: string): number | null {
    if (text === "off") {
        return null;
    }

    const value = Number(text);

    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0) {
        throw new HttpError(400, "Use /goal budget <positive token count> or /goal budget off.");
    }

    return value;
}

function objectiveText(text: string): string {
    if (text.length === 0 || text.length > MAX_OBJECTIVE) {
        throw new HttpError(400, `A goal needs an objective of 1–${MAX_OBJECTIVE} characters.`);
    }

    return text;
}

function evidenceLine(message: Message): string {
    if (message.role !== "assistant" && message.role !== "user" && message.role !== "toolResult") {
        return "";
    }

    const parts =
        typeof message.content === "string"
            ? message.content
            : message.content
                  .map((part) => {
                      if (part.type === "text") {
                          return part.text;
                      }

                      if (part.type === "toolCall") {
                          return `Call ${part.name}: ${JSON.stringify(part.arguments).slice(0, 700)}`;
                      }

                      return "";
                  })
                  .filter(Boolean)
                  .join("\n");
    const text =
        parts.length <= 3_000 ? parts : `${parts.slice(0, 700)}\n[omitted]\n${parts.slice(-2_250)}`;

    if (text === "") {
        return "";
    }

    const source =
        message.role === "toolResult"
            ? `Tool ${message.toolName}${message.isError ? " (error)" : ""}`
            : message.role;

    return `${source}: ${text}`;
}

export class ObjectiveGoals {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    async activeObjective(
        reader: DocumentReader,
        id: ConversationId,
        ctx: Context,
    ): Promise<string | undefined> {
        const goal = (await reader.snapshot(ObjectiveGoalDoc, id, ctx))?.goal;

        return goal?.status === "active" ? goal.objective : undefined;
    }

    async #status(id: ConversationId): Promise<{ message: string }> {
        const app = this.#app;
        const [doc, ledger] = await Promise.all([
            app.harness.snapshot(ObjectiveGoalDoc, id, context),
            app.harness.snapshot(UsageDoc, id, context),
        ]);

        return { message: statusText(doc?.goal, used(ledger), app.now()) };
    }

    /** A small UI projection for the extension, until the workflow moves out of core. */
    async view(id: ConversationId, actor: Pick<User, "id">) {
        const app = this.#app;
        const user = app.config.userById(actor.id);

        if (user === undefined) {
            throw new HttpError(401, "Sign in again to view this goal.");
        }

        app.requireSee(user, id);

        if (app.sessionMeta(id) === undefined || app.pip.ownerOf(id) !== undefined) {
            throw new HttpError(400, "Only ordinary sessions can have a goal.");
        }

        const [doc, ledger, turns] = await Promise.all([
            app.harness.snapshot(ObjectiveGoalDoc, id, context),
            app.harness.snapshot(UsageDoc, id, context),
            app.harness.snapshot(TurnsDoc, app.rootOf(id), context),
        ]);
        const goal = doc?.goal;

        return {
            canSteer: user.role !== "viewer" && (turns?.on !== true || turns.driver === user.id),
            goal:
                goal === undefined
                    ? null
                    : {
                          revision: goal.revision,
                          objective: goal.objective,
                          status: goal.status,
                          budget: goal.budget,
                          tokens: usedByGoal(goal, used(ledger)),
                          turns: goal.turns,
                          activeMs:
                              goal.activeMs +
                              (goal.activeSince === undefined
                                  ? 0
                                  : Math.max(0, app.now() - goal.activeSince)),
                          evaluator:
                              goal.evaluatorModel === undefined
                                  ? null
                                  : `${goal.evaluatorModel.provider}/${goal.evaluatorModel.modelId}`,
                          reason: goal.reason ?? null,
                      },
        };
    }

    async command(
        id: ConversationId,
        actor: Pick<User, "id">,
        raw: string,
        requestId: string,
        expectedRevision?: string | null,
    ): Promise<{ message: string }> {
        const app = this.#app;
        const user = app.config.userById(actor.id);

        if (user === undefined) {
            throw new HttpError(401, "Sign in again to change this goal.");
        }

        app.requireSee(user, id);

        if (app.sessionMeta(id) === undefined || app.pip.ownerOf(id) !== undefined) {
            throw new HttpError(400, "Only ordinary sessions can have a goal.");
        }

        const text = app.hidden.replace(raw.trim(), id);
        const [, action, body = ""] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text) ?? [];
        const verb = action?.toLowerCase();

        if (text === "" || text === "show" || text === "status") {
            return this.#status(id);
        }

        await app.requireDriver(id, user);

        if (!app.loader.extensionNames().includes(EXTENSION)) {
            throw new HttpError(409, "Goal is turned off in Extensions.");
        }

        const now = app.now();
        const request = `${user.id}:${requestId}`;
        const kickoff = await app.harness.commit(async (tx) => {
            const doc = await tx.doc(ObjectiveGoalDoc, id);
            const goal = doc.goal;

            if (doc.lastRequest === request) {
                return doc.pending === undefined ? undefined : { ...doc.pending };
            }

            if (expectedRevision !== undefined && (goal?.revision ?? null) !== expectedRevision) {
                throw new HttpError(
                    409,
                    "The goal changed in another tab. Review the latest goal and try again.",
                );
            }

            delete doc.pending;

            if (verb === "clear" && body === "") {
                delete doc.goal;
                doc.lastRequest = request;

                return undefined;
            }

            const ledger = used(await tx.doc(UsageDoc, id));

            if (verb === "pause" && body === "") {
                if (goal?.status === "active") {
                    goal.tokens = usedByGoal(goal, ledger);
                    revise(goal);
                    stop(goal, "paused", "Paused by the user.", now);
                }
            } else if (
                verb === "edit" ||
                verb === "budget" ||
                verb === "judge" ||
                (verb === "resume" && body === "")
            ) {
                if (goal === undefined) {
                    throw new HttpError(409, "Set a goal first with /goal <objective>.");
                }

                if (verb === "edit") {
                    if (goal.status === "completed") {
                        throw new HttpError(
                            409,
                            "This goal is complete. Set a new objective to start again.",
                        );
                    }

                    const objective = objectiveText(body.trim());

                    if (objective !== goal.objective) {
                        goal.objective = objective;
                        goal.emptyTurns = 0;
                        revise(goal);
                        delete goal.reason;

                        if (goal.status === "active") {
                            // The turn that was already running belongs to the old objective.
                            const run = (await tx.doc(LiveDoc, id)).run;

                            if (run !== undefined) {
                                goal.lastTask = Number(run.taskId);
                            }

                            doc.lastRequest = request;
                            doc.pending = {
                                revision: goal.revision,
                                objective,
                                resumed: true,
                                revised: true,
                            };

                            return { ...doc.pending };
                        }
                    }
                } else if (verb === "budget") {
                    goal.budget = budgetValue(body.trim());
                } else if (verb === "judge") {
                    if (body === "off" || body === "default") {
                        delete goal.evaluatorModel;
                    } else {
                        goal.evaluatorModel = resolveModel(
                            app.models,
                            body.trim(),
                            app.signInNeeded,
                        );
                    }
                    // An evaluator already checking the same objective can finish.
                } else {
                    if (goal.status === "completed") {
                        throw new HttpError(
                            409,
                            "This goal is complete. Set a new objective to start again.",
                        );
                    }

                    if (goal.budget !== null && usedByGoal(goal, ledger) >= goal.budget) {
                        throw new HttpError(
                            409,
                            "Increase the token budget or set /goal budget off before resuming.",
                        );
                    }

                    if ((await tx.doc(GoalDoc, id)).goal?.status === "working") {
                        throw new HttpError(
                            409,
                            "Stop the active /until check before resuming this goal.",
                        );
                    }

                    const run = (await tx.doc(LiveDoc, id)).run;
                    const wasActive = goal.status === "active";

                    if (!wasActive) {
                        goal.tokenBase = ledger - goal.tokens;
                        goal.status = "active";
                        goal.activeSince = now;
                        goal.emptyTurns = 0;
                        revise(goal);
                        delete goal.reason;

                        if (run !== undefined) {
                            goal.lastTask = Number(run.taskId);
                        }
                    }

                    doc.lastRequest = request;

                    if (!wasActive || run === undefined) {
                        doc.pending = {
                            revision: goal.revision,
                            objective: goal.objective,
                            resumed: true,
                        };

                        return { ...doc.pending };
                    }

                    return undefined;
                }
            } else {
                const budgeted = /^--budget\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text);

                if (verb === "--budget" && budgeted === null) {
                    throw new HttpError(400, "Use /goal --budget <tokens> <objective>.");
                }

                if (goal?.status === "active" || (await tx.doc(LiveDoc, id)).run !== undefined) {
                    throw new HttpError(
                        409,
                        "Pause or clear the active goal and let the current run finish before starting a new one. Use /goal edit <objective> to revise it.",
                    );
                }

                if ((await tx.doc(GoalDoc, id)).goal?.status === "working") {
                    throw new HttpError(409, "Stop the active /until check before setting a goal.");
                }

                const objective = objectiveText(
                    budgeted === null ? text : (budgeted[2] ?? "").trim(),
                );
                const startEntry = Number((await tx.latestEntryId(id)) ?? 0);
                const revision = randomUUID();

                doc.goal = {
                    id: revision,
                    revision,
                    objective,
                    status: "active",
                    budget: budgeted === null ? null : budgetValue(budgeted[1]!),
                    turns: 0,
                    emptyTurns: 0,
                    tokens: 0,
                    tokenBase: ledger,
                    startEntry,
                    lastEvidence: startEntry,
                    activeSince: now,
                    activeMs: 0,
                };
                doc.lastRequest = request;

                doc.pending = { revision, objective, resumed: false };

                return { ...doc.pending };
            }

            doc.lastRequest = request;

            return undefined;
        }, context);

        if (kickoff !== undefined) {
            try {
                await app.commands.submit(
                    id,
                    user,
                    {
                        text: kickoff.revised
                            ? "Continue working toward the revised objective in the active goal."
                            : `${kickoff.resumed ? "Resume" : "Work toward"} this goal: ${kickoff.objective}`,
                        requestId: `goal-${createHash("sha256")
                            .update(`${kickoff.revision}:${requestId}`)
                            .digest("base64url")}`,
                    },
                    undefined,
                    {
                        beforeSubmit: async () => {
                            const current = await app.harness.snapshot(
                                ObjectiveGoalDoc,
                                id,
                                context,
                            );

                            if (
                                current?.goal?.revision !== kickoff.revision ||
                                current.goal.status !== "active"
                            ) {
                                throw new HttpError(409, "The goal changed before it could start.");
                            }

                            return { user, context };
                        },
                        afterSubmit: () => {},
                    },
                );
                await app.harness.commit(async (tx) => {
                    const doc = await tx.doc(ObjectiveGoalDoc, id);

                    if (doc.lastRequest === request && doc.pending?.revision === kickoff.revision) {
                        delete doc.pending;
                    }
                }, context);
            } catch (error) {
                await this.#pause(
                    id,
                    "The goal could not start. Fix the issue, then use /goal resume.",
                    kickoff.revision,
                );

                throw error;
            }
        }

        return this.#status(id);
    }

    async #pause(id: ConversationId, reason: string, revision?: string): Promise<void> {
        const app = this.#app;

        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(ObjectiveGoalDoc, id);
            const goal = doc.goal;

            if (
                goal?.status === "active" &&
                (revision === undefined || revision === goal.revision)
            ) {
                delete doc.pending;
                goal.tokens = usedByGoal(goal, used(await tx.doc(UsageDoc, id)));
                revise(goal);
                stop(goal, "paused", reason, app.now());
            }
        }, context);
    }

    async stoppedByUser(id: ConversationId): Promise<void> {
        const goal = (await this.#app.harness.snapshot(ObjectiveGoalDoc, id, context))?.goal;

        if (goal?.status === "active") {
            await this.#pause(id, "The run was stopped.", goal.revision);
        }
    }

    runEnded(id: ConversationId, outcome: "done" | "failed" | "aborted"): void {
        if (outcome === "done") {
            return;
        }

        const app = this.#app;

        void (async () => {
            const goal = (await app.harness.snapshot(ObjectiveGoalDoc, id, context))?.goal;

            if (goal?.status === "active" && !app.isBusy(id)) {
                await this.#pause(
                    id,
                    outcome === "aborted"
                        ? "The run was stopped."
                        : "The run failed. Fix the issue, then resume the goal.",
                    goal.revision,
                );
            }
        })().catch((error: unknown) => app.log(`Could not pause a goal: ${describe(error)}`));
    }

    async checkTurn(
        answer: AssistantMessage,
        api: HookApi,
        ctx: Context,
        policy: GoalEvaluationPolicy,
    ) {
        const app = this.#app;
        const id = api.conversationId;
        const goal = (await api.snapshot(ObjectiveGoalDoc, id, ctx))?.goal;

        if (goal?.status !== "active") {
            return undefined;
        }

        const task = Number(api.taskId);
        const answerCost = answer.usage.cost.total;

        if (goal.lastTask === task) {
            const held = app.spend.heldBack(id, undefined, answerCost);

            if (held !== undefined) {
                await this.#pause(id, held, goal.revision);

                return undefined;
            }

            return goal.continuation === undefined ? undefined : { continue: goal.continuation };
        }

        const [inbox, plan, background, subagents, usage] = await Promise.all([
            api.snapshot(InboxDoc, id, ctx),
            api.snapshot(PlanDoc, id, ctx),
            api.snapshot(BackgroundDoc, id, ctx),
            api.snapshot(SubagentsDoc, id, ctx),
            api.snapshot(UsageDoc, id, ctx),
        ]);

        if (
            plan?.on === true ||
            inbox?.items.some((item) => item.mode !== "write") ||
            Object.values(subagents?.agents ?? {}).some((child) => app.isBusy(child.conversationId))
        ) {
            return undefined;
        }

        const ledger = used(usage) + tokens(answer.usage);
        const total = usedByGoal(goal, ledger);
        const initialPayer = app.spend.payer(id);
        const held = app.spend.heldBack(id, initialPayer, answerCost);

        if (held !== undefined || (goal.budget !== null && total >= goal.budget)) {
            await this.#finishTurn(id, goal, policy, {
                task,
                ledger,
                latest: goal.lastEvidence,
                toolWorked: false,
                payer: initialPayer,
                answerCost,
                evaluation: {
                    verdict: "unavailable",
                    reason: held ?? "The goal's token budget was reached.",
                },
                forced: held === undefined ? "budget" : "paused",
            });

            return undefined;
        }

        const recent = await api.entries(
            { minEntryId: (goal.startEntry + 1) as EntryId },
            40,
            undefined,
            ctx,
        );
        const latest = Number(recent.items[0]?.id ?? goal.lastEvidence);
        const toolWorked = recent.items.some(
            (entry) => Number(entry.id) > goal.lastEvidence && ToolResultEntry.is(entry),
        );
        const transcript = [...recent.items].reverse().flatMap((entry) => entry.model ?? []);
        const running = Object.values(background?.items ?? {}).filter(
            (item) => item.status === "running" || item.status === "starting",
        ).length;
        const evidence = [
            `Previously evaluated turns: ${goal.turns}. Background commands still running: ${running}.`,
            [...transcript, answer]
                .map(evidenceLine)
                .filter(Boolean)
                .join("\n")
                .slice(-MAX_EVIDENCE + 200),
        ].join("\n");
        const memo = `${EVALUATION_MEMO}:${goal.revision}`;
        const started = `${EVALUATION_STARTED}:${goal.revision}`;
        let evaluation = await api.memo<GoalEvaluation>(memo, ctx);
        const prior = await api.memo<string | boolean>(started, ctx);
        const payer = typeof prior === "string" ? prior : initialPayer;

        if (evaluation === undefined) {
            if (prior !== undefined) {
                evaluation = {
                    verdict: "unavailable",
                    reason: "The server restarted during evaluation. Resume the goal to continue.",
                };
            } else {
                await api.memo(started, payer, ctx);
                evaluation = await evaluateGoal(
                    api,
                    ctx,
                    {
                        objective: goal.objective,
                        evidence: app.hidden.replace(evidence, id),
                        currentModel: { provider: answer.provider, modelId: answer.model },
                        ...(goal.evaluatorModel === undefined
                            ? {}
                            : { evaluatorModel: goal.evaluatorModel }),
                    },
                    policy,
                );
            }

            evaluation = await api.memo(memo, evaluation, ctx);
        }

        ctx.abortSignal?.throwIfAborted();

        const continuation = await this.#finishTurn(id, goal, policy, {
            task,
            ledger,
            latest,
            toolWorked,
            payer,
            answerCost,
            evaluation,
        });

        return continuation === undefined ? undefined : { continue: continuation };
    }

    async #finishTurn(
        id: ConversationId,
        observed: ObjectiveGoal,
        policy: GoalEvaluationPolicy,
        turn: {
            task: number;
            ledger: number;
            latest: number;
            toolWorked: boolean;
            payer: string;
            answerCost: number;
            evaluation: GoalEvaluation;
            forced?: "budget" | "paused";
        },
    ): Promise<string | undefined> {
        const { task, ledger, latest, toolWorked, payer, answerCost, evaluation, forced } = turn;
        const evaluated = forced === undefined;
        const app = this.#app;
        const result = await app.harness.commit<
            | {
                  continuation: string | undefined;
                  status: Status;
                  reason: string | undefined;
              }
            | undefined
        >(async (tx) => {
            const doc = await tx.doc(ObjectiveGoalDoc, id);
            const goal = doc.goal;
            const charge = `${task}:${observed.revision}`;

            if (
                evaluation.model !== undefined &&
                evaluation.usage !== undefined &&
                !doc.evaluationCharges?.includes(charge)
            ) {
                await app.spend.recordModelUsageIn(
                    tx,
                    id,
                    payer,
                    evaluation.model,
                    evaluation.usage,
                );
                doc.evaluationCharges = [...(doc.evaluationCharges ?? []), charge].slice(-8);

                if (
                    goal?.status === "paused" &&
                    (goal.id ?? goal.revision) === (observed.id ?? observed.revision)
                ) {
                    goal.tokens += tokens(evaluation.usage);
                }
            }

            if (goal?.status !== "active" || goal.revision !== observed.revision) {
                return undefined;
            }

            if (goal.lastTask === task) {
                return {
                    continuation: goal.continuation,
                    status: goal.status,
                    reason: goal.reason,
                };
            }

            goal.lastTask = task;
            goal.lastEvidence = latest;
            goal.tokens = usedByGoal(
                goal,
                ledger + (evaluation.usage === undefined ? 0 : tokens(evaluation.usage)),
            );
            goal.turns += Number(evaluated);
            goal.emptyTurns = toolWorked ? 0 : goal.emptyTurns + Number(evaluated);
            goal.reason = app.hidden.replace(evaluation.reason, id);
            const now = app.now();

            if (forced !== undefined) {
                stop(goal, forced, goal.reason, now);
            } else if (evaluation.verdict === "met") {
                stop(goal, "completed", goal.reason, now);
            } else if (evaluation.verdict === "blocked") {
                stop(goal, "blocked", goal.reason, now);
            } else if (evaluation.verdict === "unavailable") {
                stop(goal, "paused", goal.reason, now);
            } else if (goal.budget !== null && goal.tokens >= goal.budget) {
                stop(goal, "budget", "The goal's token budget was reached.", now);
            } else if (goal.emptyTurns >= policy.emptyTurnLimit) {
                stop(
                    goal,
                    "blocked",
                    `No tool activity in ${policy.emptyTurnLimit} consecutive turns. ${goal.reason}`,
                    now,
                );
            } else {
                const waiting = (await tx.doc(InboxDoc, id)).items.some(
                    (item) => item.mode !== "write",
                );
                const planning = (await tx.doc(PlanDoc, id)).on;

                if (!waiting && !planning) {
                    goal.continuation = policy.followUp(goal.reason);
                } else {
                    delete goal.continuation;
                }
            }

            return { continuation: goal.continuation, status: goal.status, reason: goal.reason };
        }, context);

        if (result !== undefined && result.status !== "active") {
            app.notice(
                "info",
                `Goal ${label[result.status].toLowerCase()}. ${result.reason ?? ""}`,
                id,
            );
        }

        const held =
            result?.continuation === undefined
                ? undefined
                : app.spend.heldBack(id, payer, answerCost);

        if (held !== undefined) {
            await this.#pause(id, held, observed.revision);

            return undefined;
        }

        return result?.continuation;
    }
}
