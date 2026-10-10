/**
 * Models as browsers see them: the ones available, the one a conversation runs with, finding one by name, and the
 * thinking levels.
 */
import {
    type Api,
    getSupportedThinkingLevels,
    type Model,
    type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentState, ModelRef } from "@earendil-works/pi-durable";

// A record, so a level Pi adds fails the type check until it is here too.
const LEVELS: Record<ModelThinkingLevel, true> = {
    off: true,
    minimal: true,
    low: true,
    medium: true,
    high: true,
    xhigh: true,
    max: true,
};

/** Every thinking level, lowest first: what a session's model picker, the default model, and the subagent tool take. */
export const THINKING_LEVELS: readonly ModelThinkingLevel[] = Object.freeze(
    Object.keys(LEVELS) as ModelThinkingLevel[],
);

/** Whether `level` names a thinking level. */
export function isThinkingLevel(level: unknown): level is ModelThinkingLevel {
    return typeof level === "string" && Object.hasOwn(LEVELS, level);
}

type ModelSummary = {
    provider: string;
    id: string;
    name: string;
    contextWindow: number;
    reasoning: boolean;
    images: boolean;
    levels: string[];
};

/** Whether a model thinks, and at which levels, and whether it takes images. */
function capabilities(model: Model<Api>) {
    return {
        reasoning: model.reasoning === true,
        images: model.input.includes("image"),
        levels: model.reasoning ? getSupportedThinkingLevels(model) : ["off"],
    };
}

/** The models people can pick: the ones with a configured sign-in. */
export function modelList(models: ModelRuntime): ModelSummary[] {
    return models.getAvailableSnapshot().map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        ...capabilities(model),
    }));
}

/** An available model by `provider/id`, or by id alone. */
export function resolveModel(models: ModelRuntime, spec: string): ModelRef {
    const trimmed = spec.trim();
    const available = models.getAvailableSnapshot();
    const slash = trimmed.indexOf("/");
    const found =
        slash > 0
            ? available.find(
                  (model) =>
                      model.provider === trimmed.slice(0, slash) &&
                      model.id === trimmed.slice(slash + 1),
              )
            : available.find((model) => model.id === trimmed);

    if (found === undefined) {
        const names = available.slice(0, 30).map((model) => `${model.provider}/${model.id}`);

        throw new Error(`Model ${spec} is not available. Available: ${names.join(", ")}`);
    }

    return { provider: found.provider, modelId: found.id };
}

/** What a conversation runs with, for its view: its model and what the model can do, thinking, folder, instructions. */
export function agentInfo(models: ModelRuntime, agent: AgentState, defaultCwd: string) {
    const model =
        agent.model === undefined
            ? undefined
            : models.getModel(agent.model.provider, agent.model.modelId);

    return {
        model: agent.model ?? null,
        thinkingLevel: agent.thinkingLevel ?? "off",
        cwd: agent.cwd ?? defaultCwd,
        ...(agent.instructions === undefined ? {} : { instructions: agent.instructions }),
        available: model !== undefined && models.hasConfiguredAuth(model.provider),
        ...(model === undefined
            ? {}
            : {
                  modelName: model.name,
                  contextWindow: model.contextWindow,
                  ...capabilities(model),
              }),
    };
}
