/**
 * Persistent background subagents, after Pi Durable's example 23. One `subagent` tool spawns named subagents,
 * messages them, stops them, and lists them. Each subagent is its own conversation, so a user can open it, watch it
 * work, and talk to it. Their answers go back to the parent at its next pause: after a tool call, or, when it is idle,
 * a moment after. Answers that arrive meanwhile wait together, and go as one message, so many subagents cost the
 * parent one extra turn at most rather than one each, and its queue holds one message of theirs at a time.
 *
 * Everything survives a restart: anchors, reporters, and the courier that delivers reports are durable tasks, and
 * request IDs keep a restarted task from delivering a message or a report twice.
 */
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import {
    AssistantEntry,
    type ConversationId,
    configure,
    defineExtension,
    defineTask,
    defineTool,
    type Extension,
    InboxDoc,
    LiveDoc,
    section,
    type SubmissionId,
    type TaskRuntime,
    type Tx,
} from "@earendil-works/pi-durable";
import { REPORT_PREFIX, STOPPED, SubagentsDoc } from "../docs.ts";
import type { PocketHost } from "../host.ts";
import { requestFor } from "../requests.ts";

function textOf(message: AssistantMessage | undefined): string {
    return (message?.content ?? [])
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
}

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * A subagent's conversation is owned by an anchor: a background task that finishes at once. Background tasks are a
 * boundary, so the parent's Esc and idle waits do not reach the subagent, while `abort({ background: true })` still does.
 */
const Anchor = defineTask<null, { phase: "done" }, null>({
    name: "pocket.subagent-anchor",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
        done: (_anchor, runtime, context) =>
            runtime.commit(
                () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
                context,
            ),
    },
    abort: (_anchor, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** `requestedBy`: whom the parent worked for when it sent the message, whose work the subagent's then is. */
type ReporterInput = {
    name: string;
    conversationId: ConversationId;
    message: string;
    followUp: boolean;
    requestedBy?: string;
};
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

/** Delivers one message to a subagent, waits for the answer, and reports it to the parent, through `Courier`. */
function reporterFor(Courier: CourierTask) {
    return defineTask<ReporterInput, ReporterState, null>({
        name: "pocket.subagent-reporter",
        version: 1,
        initial: () => ({ phase: "deliver" }),
        phases: {
            deliver: async (reporter, runtime, context) => {
                const { name, conversationId, message, followUp, requestedBy } = reporter.input;
                const subagent = (await runtime.conversation(conversationId, context))!;
                const request = {
                    type: "input",
                    content: message,
                    whenBusy: followUp ? "followUp" : "steer",
                } as const;
                const requestId =
                    requestedBy === undefined
                        ? `subagent:${reporter.id}`
                        : requestFor(requestedBy, `subagent-${reporter.id}`);
                const submission = await subagent.submit({ ...request, requestId }, context);
                const settled = await submission.wait(context);

                await runtime.commit(async (tx) => {
                    const next = (report?: string) =>
                        ({ status: "running", checkpoint: { phase: "report", report } }) as const;

                    const agent = (await tx.doc(SubagentsDoc, runtime.conversationId)).agents[name];

                    if (settled.status === "unanswered") {
                        const why = whyUnanswered(settled.reason, settled.detail);

                        if (agent !== undefined) {
                            agent.answeredAt = Date.now();
                            agent.failed = true;
                            agent.error = why;
                        }

                        // Stopped too: Pi may be waiting for its answer, and is told none comes.
                        return next(`${REPORT_PREFIX}${name} failed: ${why}]`);
                    }

                    if (settled.type !== "input") {
                        return next();
                    }

                    if (agent === undefined || agent.reported.includes(settled.answer)) {
                        return next();
                    }

                    agent.reported.push(settled.answer);
                    agent.answeredAt = Date.now();
                    agent.failed = false;
                    delete agent.error;
                    const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
                        AssistantMessage | undefined;

                    return next(
                        `${REPORT_PREFIX}${name} answered, no reply needed] ${textOf(answer)}`,
                    );
                }, context);
            },
            // The report waits with the others for the courier, which this starts when none is at work. A batch still in the
            // parent's queue takes it too: it is taken back out, and goes again with this one, so the queue holds one
            // message of reports, with all of them.
            report: (reporter, runtime, context) =>
                runtime.commit(async (tx) => {
                    const report = reporter.state.checkpoint.report;

                    // Before 0.12 a reporter sent its report itself, under this request: one stopped by a restart (an
                    // upgrade) after sending it, and before it ended, has nothing left to send.
                    const sentBefore =
                        report !== undefined &&
                        (await tx.submissionByRequest(
                            runtime.conversationId,
                            `subagent-report:${reporter.id}`,
                        )) !== undefined;

                    if (report !== undefined && !sentBefore) {
                        const id = runtime.conversationId;
                        const state = await tx.doc(SubagentsDoc, id);
                        // Reads first: a commit reads the tables only before it writes one.
                        const queued = await queuedBatch(tx, id, state.sending?.request);
                        const idle = !(await working(tx, state.courier));
                        const taken = queued === undefined ? [] : (state.sending?.reports ?? []);

                        if (queued !== undefined) {
                            await unqueue(tx, id, queued);
                            delete state.sending;
                        }

                        // Assigned whole: a document keeps its own copy of what is assigned to it.
                        state.outbox = [
                            ...taken,
                            ...(state.outbox ?? []),
                            { name: reporter.input.name, text: report },
                        ];

                        if (idle) {
                            state.courier = await tx.createTask(Courier, null, BACKGROUND);
                        }
                    }

                    return { status: "terminal", outcome: { status: "completed", result: null } };
                }, context),
        },
        abort: (_reporter, runtime, context) =>
            runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
}

/** Tasks of a conversation that run beside its work: its Esc and idle waits do not reach them. */
const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

/** Why a subagent did not answer, for its report and its row: what went wrong, in a line, or that it was stopped. */
function whyUnanswered(reason: string, detail: unknown): string {
    if (reason === "aborted") {
        return STOPPED;
    }

    const text = typeof detail === "string" && detail.trim() !== "" ? detail : reason;

    // One line, and no "]", which ends a report's head.
    return text.replace(/\s+/g, " ").replace(/]/g, ")").trim().slice(0, 200);
}

/** The submission of the batch `request`, while it waits in `conversationId`'s queue; undefined once it has left. */
async function queuedBatch(
    tx: Tx,
    conversationId: ConversationId,
    request: string | undefined,
): Promise<SubmissionId | undefined> {
    if (request === undefined) {
        return undefined;
    }

    const record = await tx.submissionByRequest(conversationId, request);

    return record?.status === "queued" ? record.id : undefined;
}

/** Take a waiting batch back out of the queue, as withdrawing it does, to send its reports again with more. */
async function unqueue(tx: Tx, conversationId: ConversationId, id: SubmissionId): Promise<void> {
    const items = (await tx.doc(InboxDoc, conversationId)).items;
    const index = items.findIndex((item) => item.id === id);

    if (index !== -1) {
        items.splice(index, 1);
    }

    tx.settleSubmission(id, { status: "unanswered", reason: "merged" });
}

/** Whether a task is there and can still take reports. */
async function working(tx: Tx, task: number | undefined): Promise<boolean> {
    if (task === undefined) {
        return false;
    }

    const status = (await tx.task(task as never))?.state.status;

    // One completing has taken its last reports already.
    return status === "pending" || status === "running" || status === "waiting";
}

/** Wait until the submission `id` has left `conversationId`'s queue: placed, withdrawn, or aborted. */
async function leftQueue(
    runtime: TaskRuntime<null, CourierState, null, object>,
    conversationId: ConversationId,
    id: SubmissionId,
    context: Context,
): Promise<void> {
    const queued = (value: { items?: readonly { id: SubmissionId }[] } | null) =>
        (value?.items ?? []).some((item) => item.id === id);
    const watch = await runtime.watchDoc(InboxDoc, conversationId, context);

    if (watch === undefined || !queued(watch.value)) {
        await watch?.stop();

        return;
    }

    try {
        await new Promise<void>((resolve, reject) => {
            watch.start(async (value) => {
                if (!queued(value)) {
                    resolve();
                }
            });
            // The watch ends with the invocation (a restart, say): the phase runs again then.
            void watch.closed.then(() => reject(new Error("The queue's watch ended")), reject);
        });
    } finally {
        await watch.stop();
    }
}

/**
 * `batch` and `text`: where an earlier build kept the batch, for a courier it left in "send". "hold": a spend limit
 * holds the reports back.
 */
type CourierState =
    | { phase: "gather" }
    | { phase: "next" }
    | { phase: "hold" }
    | { phase: "send"; batch?: number; text?: string };

/** What the courier asks Pi Pocket about spend limits. */
type Limits = Pick<PocketHost, "heldBack" | "onLimitsChanged">;

type CourierTask = ReturnType<typeof courierFor>;

/**
 * How long reports a limit holds back wait before the courier looks again, at most: a changed limit wakes it at once,
 * and this catches the rest (someone else, with spend left, now pays there).
 */
const HOLD_MS = 30_000;

/** How long a courier waits, for a parent that is idle, for more reports to go with the first. */
const GATHER_MS = 2_000;

/** Wait `ms`, or until `signal` ends the wait, as Pi Durable's own waits do. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();

    return new Promise((resolve, reject) => {
        const stop = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };

        const timer = setTimeout(() => {
            signal.removeEventListener("abort", stop);
            resolve();
        }, ms);

        signal.addEventListener("abort", stop, { once: true });
    });
}

/**
 * Takes all the reports waiting and sends them to the parent as one message, to steer it at its next pause, or to wake
 * it when it is idle, after a moment for others. It sends the next ones only once that message has left the parent's
 * queue, so the queue holds one at a time; reports that arrive meanwhile join it there, or go in the next. It ends
 * when none are waiting. The batch it took stays in `sending` until it has left the queue, so a courier that stops
 * early loses none: the next sends it, once. While the parent's session, or whoever pays there, is past a spend limit,
 * the reports wait (saying why, in `held`) rather than start a turn nobody may pay for, and go once the limit is raised.
 */
function courierFor(limits: Limits) {
    return defineTask<null, CourierState, null>({
        name: "pocket.subagent-courier",
        version: 1,
        initial: () => ({ phase: "gather" }),
        phases: {
            // A parent that is idle would start a turn for the first report alone: subagents started together often finish
            // a moment apart, so it waits that moment for theirs. A busy parent takes the batch at its next pause, and
            // reports that come meanwhile join it in its queue.
            gather: async (_courier, runtime, context) => {
                const live = await runtime.snapshot(LiveDoc, runtime.conversationId, context);

                if (live?.run === undefined) {
                    // Ended by the invocation's signal, or the phase's own, as Pi Durable's waits are.
                    const signals = [runtime.signal, context.abortSignal].filter(
                        (signal): signal is AbortSignal => signal !== undefined,
                    );

                    await pause(GATHER_MS, AbortSignal.any(signals));
                }

                await runtime.commit(
                    () => ({ status: "running", checkpoint: { phase: "next" } }),
                    context,
                );
            },
            next: (courier, runtime, context) =>
                runtime.commit(async (tx) => {
                    const state = await tx.doc(SubagentsDoc, runtime.conversationId);

                    delete state.delivering;

                    if (state.sending === undefined && (state.outbox ?? []).length === 0) {
                        delete state.courier;
                        delete state.held;

                        return {
                            status: "terminal",
                            outcome: { status: "completed", result: null },
                        };
                    }

                    // Past a spend limit, the parent may start no turn for them: they wait, and say why.
                    const held = limits.heldBack(runtime.conversationId);

                    if (held !== undefined) {
                        if (state.held !== held) {
                            state.held = held;
                        }

                        return { status: "running", checkpoint: { phase: "hold" } };
                    }

                    delete state.held;

                    // A batch an earlier courier took and did not see leave the queue goes first, under its own id.
                    if (state.sending === undefined) {
                        const reports = state.outbox ?? [];
                        const batch = (state.batches ?? 0) + 1;

                        state.batches = batch;
                        state.outbox = [];
                        state.sending = {
                            request: `subagent-reports:${courier.id}:${batch}`,
                            reports,
                        };
                    }

                    return { status: "running", checkpoint: { phase: "send" } };
                }, context),
            // Until a limit changes (the owner raised it) or a while passes, then look again.
            hold: async (_courier, runtime, context) => {
                const signals = [runtime.signal, context.abortSignal].filter(
                    (signal): signal is AbortSignal => signal !== undefined,
                );
                const changed = new AbortController();
                const stop = limits.onLimitsChanged(() => changed.abort());

                try {
                    await pause(HOLD_MS, AbortSignal.any([...signals, changed.signal]));
                } catch (error) {
                    // A changed limit ends the wait early; anything else (the task stopping) is the task's to handle.
                    if (!changed.signal.aborted) {
                        throw error;
                    }
                } finally {
                    stop();
                }

                await runtime.commit(
                    () => ({ status: "running", checkpoint: { phase: "next" } }),
                    context,
                );
            },
            send: async (courier, runtime, context) => {
                const checkpoint = courier.state.checkpoint as Extract<
                    CourierState,
                    { phase: "send" }
                >;
                const parentId = runtime.conversationId;
                const sending =
                    checkpoint.text === undefined
                        ? (await runtime.snapshot(SubagentsDoc, parentId, context))?.sending
                        : {
                              request: `subagent-reports:${courier.id}:${checkpoint.batch}`,
                              reports: [{ name: "", text: checkpoint.text }],
                          };

                if (sending !== undefined) {
                    const parent = (await runtime.conversation(parentId, context))!;
                    const submission = await parent.submit(
                        {
                            type: "input",
                            content: sending.reports.map((report) => report.text).join("\n\n"),
                            whenBusy: "steer",
                            requestId: sending.request,
                        },
                        context,
                    );

                    await leftQueue(runtime, parentId, submission.id, context);
                }

                await runtime.commit(async (tx) => {
                    const state = await tx.doc(SubagentsDoc, parentId);
                    // Reads first: a commit reads the tables only before it writes one.
                    const record =
                        sending === undefined
                            ? undefined
                            : await tx.submissionByRequest(parentId, sending.request);

                    if (state.sending !== undefined && state.sending.request === sending?.request) {
                        // Taken out of the queue before Pi had it while a spend limit is reached: the limit's stop
                        // withdrew it, with all that waited there. Its reports wait again, first. (Once a limit holds
                        // reports back, none are sent; a batch can be in the queue then only if it went before.)
                        if (
                            record?.status === "unanswered" &&
                            record.entry === undefined &&
                            limits.heldBack(parentId) !== undefined
                        ) {
                            state.outbox = [...state.sending.reports, ...(state.outbox ?? [])];
                        }

                        delete state.sending;
                    }

                    delete state.delivering;

                    return { status: "running", checkpoint: { phase: "next" } };
                }, context);
            },
        },
        // Stopped with its conversation: what waits, and the batch it took, stay for the next courier.
        abort: (_courier, runtime, context) =>
            runtime.commit(async (tx) => {
                delete (await tx.doc(SubagentsDoc, runtime.conversationId)).courier;

                return { status: "terminal", outcome: { status: "aborted" } };
            }, context),
    });
}

const GUIDE = `You can delegate to background subagents with the subagent tool. A subagent is a separate agent with its own transcript that works while you keep talking to the user; its answer comes back to you at your next pause (after a tool call, or when you are done) as a message starting with "${REPORT_PREFIX}<name> answered". Answers that arrive together come in one message. Use them for independent, self-contained work (research, long builds, test runs, a second opinion). Give each message everything the subagent needs: it does not see this conversation. Do not poll: wait for the report. The user can open a subagent and talk to it directly.`;

export default function createSubagents(host: PocketHost) {
    const Courier = courierFor(host);
    const Reporter = reporterFor(Courier);

    const subagent = defineTool({
        name: "subagent",
        description:
            "Manage persistent background subagents. Actions: spawn (name, message; optional model as provider/modelId, " +
            "thinking level, and tools to allow), send (name, message; followUp: true queues it after the current answer " +
            "instead of steering), stop (name: aborts its current work), status (one name, or all). Answers come back " +
            "to you as messages at your next pause; those that arrive together come in one.",
        parameters: Type.Object({
            action: Type.Union([
                Type.Literal("spawn"),
                Type.Literal("send"),
                Type.Literal("stop"),
                Type.Literal("status"),
            ]),
            name: Type.Optional(
                Type.String({ description: "Short kebab-case name, for example test-runner." }),
            ),
            message: Type.Optional(Type.String()),
            followUp: Type.Optional(Type.Boolean()),
            model: Type.Optional(
                Type.String({ description: "spawn only: provider/modelId. Default: your model." }),
            ),
            thinking: Type.Optional(Type.Union(THINKING.map((level) => Type.Literal(level)))),
            tools: Type.Optional(
                Type.Array(Type.String(), {
                    description: "spawn only: the tool names it may use. Default: your tools.",
                }),
            ),
        }),
        // Not rerun after a crash: repeating stop could stop newer work. The model sees the interruption and can check
        // with status.
        replay: "unsafe",
        execute: async (args, api, context) => {
            const { action, name, message, followUp } = args;
            const reply = (text: string, conversationId?: ConversationId) => ({
                content: [{ type: "text" as const, text }],
                ...(conversationId === undefined || name === undefined
                    ? {}
                    : {
                          details: {
                              action,
                              name,
                              conversationId,
                              ...(message === undefined ? {} : { message }),
                          },
                      }),
            });
            const registry = (await api.snapshot(SubagentsDoc, api.conversationId, context)) ?? {
                agents: {},
                reporters: {},
            };

            if (action === "status") {
                const names = name === undefined ? Object.keys(registry.agents) : [name];
                const lines: string[] = [];

                for (const each of names) {
                    const found = Object.hasOwn(registry.agents, each)
                        ? registry.agents[each]
                        : undefined;

                    if (found === undefined) {
                        continue;
                    }

                    const busy =
                        (await api.snapshot(LiveDoc, found.conversationId, context))?.run !==
                        undefined;

                    lines.push(`${each}: ${busy ? "working" : "idle"}`);
                }

                return reply(lines.length === 0 ? "No subagents." : lines.join("\n"));
            }

            if (name === undefined || name.trim() === "") {
                return reply(`${action} needs a name.`);
            }

            const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined;

            if (action !== "spawn" && agent === undefined) {
                return reply(`No subagent named ${name}.`);
            }

            if (action === "stop") {
                await (await api.conversation(agent!.conversationId, context))!.abort(context);

                return reply(`Stopped ${name}.`, agent!.conversationId);
            }

            if (message === undefined || message.trim() === "") {
                return reply(`${action} needs a message.`);
            }

            // Resolve spawn options before the commit, so a bad model name fails without side effects.
            const model =
                action === "spawn" && args.model !== undefined
                    ? host.resolveModel(args.model)
                    : undefined;
            const parentTools =
                action === "spawn" && args.tools !== undefined
                    ? (await api.agent(context)).tools
                    : [];
            const tools =
                args.tools === undefined
                    ? undefined
                    : args.tools.map((tool) => {
                          const found = parentTools.find((each) => each.name === tool);

                          if (found === undefined) {
                              throw new Error(
                                  `Unknown tool ${tool}. Available: ${parentTools.map((each) => each.name).join(", ")}`,
                              );
                          }

                          return found;
                      });

            const result = await api.commit(async (tx) => {
                const state = await tx.doc(SubagentsDoc, api.conversationId);

                if (action === "spawn") {
                    if (Object.hasOwn(state.agents, name)) {
                        return `${name} already exists; use send.`;
                    }

                    const anchor = await tx.createTask(Anchor, null, BACKGROUND);
                    // Owned by a task of this conversation, so it starts as a copy of this agent.
                    const child = await tx.createConversation({
                        ownership: { kind: "task", taskId: anchor },
                    });

                    await configure(tx, child.id, {
                        extensions: { remove: [SubagentTools] },
                        instructions: `You are the subagent "${name}". You work for another agent, not directly for a person, although a person may open your conversation and talk to you. Answer requests completely but concisely: your final answer is what gets reported back.`,
                        ...(model === undefined ? {} : { model }),
                        ...(args.thinking === undefined
                            ? {}
                            : { thinkingLevel: args.thinking as ModelThinkingLevel }),
                        ...(tools === undefined ? {} : { tools }),
                    });
                    state.agents[name] = { conversationId: child.id, reported: [] };
                }

                const record = state.agents[name]!;
                const conversationId = record.conversationId;
                const requestedBy = host.requesterOf(api.conversationId);

                // For the subagents bar: what it works on now, and since when.
                record.asked = message.trim().slice(0, 300);
                record.askedAt = Date.now();
                const input = {
                    name,
                    conversationId,
                    message,
                    followUp: action === "send" && followUp === true,
                    ...(requestedBy === undefined ? {} : { requestedBy }),
                };

                state.reporters[api.taskId] = await tx.createTask(Reporter, input, BACKGROUND);

                return action === "send" ? `Sent to ${name}.` : `Started ${name}.`;
            }, context);
            const current = (await api.snapshot(SubagentsDoc, api.conversationId, context))?.agents[
                name
            ];

            return reply(result, current?.conversationId);
        },
    });

    const SubagentTools: Extension = defineExtension({
        name: "pocket-subagents",
        tasks: [Anchor, Reporter, Courier],
        tools: [subagent],
        sections: [section("subagents", () => GUIDE)],
    });

    return SubagentTools;
}
