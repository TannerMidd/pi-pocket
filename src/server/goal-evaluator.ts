/** Check a goal against session evidence in a separate model request with no tools. */
import { once } from "node:events";
import type { Context } from "@earendil-works/chord/context";
import { type AssistantMessage, clampThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import { type HookApi, type ModelRef, ProviderDoc } from "@earendil-works/pi-durable";
import { clip } from "./fence.ts";
import { noWait } from "./limit-gate.ts";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 2048;
const MAX_EVIDENCE_CHARS = 24_000;

export type GoalVerdict = "met" | "continue" | "blocked";

export interface GoalEvaluationPolicy {
    readonly instructions: string;
    readonly emptyTurnLimit: number;
    readVerdict(message: AssistantMessage): { verdict: GoalVerdict; reason: string } | undefined;
    followUp(reason: string): string;
}

export type GoalEvaluationUsage = Pick<
    Usage,
    "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens" | "cacheWrite1h" | "reasoning"
> & { cost: Pick<Usage["cost"], "input" | "output" | "cacheRead" | "cacheWrite" | "total"> };

export type GoalEvaluation =
    | { verdict: GoalVerdict; reason: string; model: ModelRef; usage: GoalEvaluationUsage }
    | { verdict: "unavailable"; reason: string; model?: ModelRef; usage?: GoalEvaluationUsage };

function plainUsage(usage: Usage): GoalEvaluationUsage {
    return {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
        ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
        cost: {
            input: usage.cost.input,
            output: usage.cost.output,
            cacheRead: usage.cost.cacheRead,
            cacheWrite: usage.cost.cacheWrite,
            total: usage.cost.total,
        },
    };
}

export async function evaluateGoal(
    api: HookApi,
    context: Context,
    input: {
        objective: string;
        evidence: string;
        currentModel?: ModelRef;
        evaluatorModel?: ModelRef;
    },
    policy: GoalEvaluationPolicy,
): Promise<GoalEvaluation> {
    context.abortSignal?.throwIfAborted();

    const ref = input.evaluatorModel ?? input.currentModel;
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    const signal =
        context.abortSignal === undefined
            ? deadline
            : AbortSignal.any([context.abortSignal, deadline]);
    const listener = new AbortController();

    try {
        const model =
            ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);

        if (model === undefined) {
            return {
                verdict: "unavailable",
                reason: "No model is available to evaluate the goal.",
                ...(ref === undefined ? {} : { model: ref }),
            };
        }

        const sessionId = (await api.snapshot(ProviderDoc, api.conversationId, context))?.sessionId;
        const timestamp = Date.now();
        const reasoning = clampThinkingLevel(model, "low");

        signal.throwIfAborted();

        const stopped = once(signal, "abort", { signal: listener.signal }).then(() => {
            throw signal.reason;
        });
        const request = Promise.resolve().then(() =>
            api.models.completeSimple(
                model,
                {
                    messages: [
                        { role: "system", content: policy.instructions, timestamp },
                        {
                            role: "user",
                            content: JSON.stringify({
                                objective: input.objective,
                                evidence: clip(input.evidence, MAX_EVIDENCE_CHARS),
                            }),
                            timestamp,
                        },
                    ],
                },
                noWait({
                    signal,
                    timeoutMs: TIMEOUT_MS,
                    maxRetries: 0,
                    ...(reasoning === "off" ? {} : { reasoning }),
                    maxTokens:
                        model.maxTokens > 0
                            ? Math.min(model.maxTokens, MAX_OUTPUT_TOKENS)
                            : MAX_OUTPUT_TOKENS,
                    cacheRetention: "none",
                    disableContinuation: true,
                    ...(sessionId === undefined ? {} : { sessionId }),
                }),
            ),
        );
        const response = await Promise.race([stopped, request]);

        context.abortSignal?.throwIfAborted();

        const modelRef = { provider: response.provider, modelId: response.model };
        const usage = plainUsage(response.usage);

        if (response.stopReason === "error" || response.stopReason === "aborted") {
            return {
                verdict: "unavailable",
                reason: deadline.aborted
                    ? "The goal evaluation timed out."
                    : "The goal evaluation failed.",
                model: modelRef,
                usage,
            };
        }

        if (response.stopReason === "length") {
            return {
                verdict: "unavailable",
                reason: "The goal evaluator reached its output limit.",
                model: modelRef,
                usage,
            };
        }

        const verdict = policy.readVerdict(response);

        return verdict === undefined
            ? {
                  verdict: "unavailable",
                  reason: "The evaluator did not return a valid verdict.",
                  model: modelRef,
                  usage,
              }
            : { ...verdict, model: modelRef, usage };
    } catch {
        context.abortSignal?.throwIfAborted();

        return {
            verdict: "unavailable",
            reason: deadline.aborted
                ? "The goal evaluation timed out."
                : "The goal evaluation failed.",
            ...(ref === undefined ? {} : { model: ref }),
        };
    } finally {
        listener.abort();
    }
}
