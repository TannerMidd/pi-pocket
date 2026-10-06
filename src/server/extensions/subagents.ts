/**
 * Persistent background subagents, after Pi Durable's example 23. One `subagent` tool spawns named subagents,
 * messages them, stops them, and lists them. Each subagent is its own conversation, so a user can open it, watch it
 * work, and talk to it. Answers are reported back to the parent as follow-up messages once they arrive.
 *
 * Everything survives a restart: anchors and reporters are durable tasks, and request IDs keep a restarted reporter
 * from delivering a message or a report twice.
 */
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
    AssistantEntry,
    type ConversationId,
    configure,
    defineExtension,
    defineTask,
    defineTool,
    type Extension,
    LiveDoc,
    section,
} from "@earendil-works/pi-durable";
import { REPORT_PREFIX, SubagentsDoc } from "../docs.ts";
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

/** Delivers one message to a subagent, waits for the answer, and reports it to the parent. */
const Reporter = defineTask<ReporterInput, ReporterState, null>({
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

                if (settled.status === "unanswered") {
                    return next(
                        settled.reason === "aborted"
                            ? undefined
                            : `${REPORT_PREFIX}${name} failed: ${settled.reason}]`,
                    );
                }

                if (settled.type !== "input") {
                    return next();
                }

                const agent = (await tx.doc(SubagentsDoc, runtime.conversationId)).agents[name];

                if (agent === undefined || agent.reported.includes(settled.answer)) {
                    return next();
                }

                agent.reported.push(settled.answer);
                const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
                    AssistantMessage | undefined;

                return next(`${REPORT_PREFIX}${name} answered, no reply needed] ${textOf(answer)}`);
            }, context);
        },
        report: async (reporter, runtime, context) => {
            const report = reporter.state.checkpoint.report;

            if (report !== undefined) {
                const parent = (await runtime.conversation(runtime.conversationId, context))!;
                const input = { type: "input", content: report, whenBusy: "followUp" } as const;

                await parent.submit(
                    { ...input, requestId: `subagent-report:${reporter.id}` },
                    context,
                );
            }

            await runtime.commit(
                () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
                context,
            );
        },
    },
    abort: (_reporter, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const GUIDE = `You can delegate to background subagents with the subagent tool. A subagent is a separate agent with its own transcript that works while you keep talking to the user; its answer comes back to you later as a message starting with "${REPORT_PREFIX}<name> answered". Use them for independent, self-contained work (research, long builds, test runs, a second opinion). Give each message everything the subagent needs: it does not see this conversation. Do not poll: wait for the report. The user can open a subagent and talk to it directly.`;

export default function createSubagents(host: PocketHost) {
    const subagent = defineTool({
        name: "subagent",
        description:
            "Manage persistent background subagents. Actions: spawn (name, message; optional model as provider/modelId, " +
            "thinking level, and tools to allow), send (name, message; followUp: true queues it after the current answer " +
            "instead of steering), stop (name: aborts its current work), status (one name, or all). Answers are reported " +
            "back to you as messages when they arrive.",
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
                const background = {
                    ownership: { kind: "conversation" },
                    background: true,
                } as const;

                if (action === "spawn") {
                    if (Object.hasOwn(state.agents, name)) {
                        return `${name} already exists; use send.`;
                    }

                    const anchor = await tx.createTask(Anchor, null, background);
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

                const conversationId = state.agents[name]!.conversationId;
                const requestedBy = host.requesterOf(api.conversationId);
                const input = {
                    name,
                    conversationId,
                    message,
                    followUp: action === "send" && followUp === true,
                    ...(requestedBy === undefined ? {} : { requestedBy }),
                };

                state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);

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
        tasks: [Anchor, Reporter],
        tools: [subagent],
        sections: [section("subagents", () => GUIDE)],
    });

    return SubagentTools;
}
