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
import type { ModelRuntime, ScopedModel } from "@earendil-works/pi-coding-agent";
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
    scoped?: true;
    /** Its provider's sign-in expired and could not be renewed: it works again once someone signs in. */
    signIn?: true;
};

/** Whether a provider's sign-in expired and needs a person to sign in again (`Providers.needsSignIn`). */
export type SignInNeeded = (provider: string) => boolean;

/** The highest of `model`'s thinking levels that is not above `level`; undefined when even its lowest is. */
export function levelAtMost(
    model: Model<Api>,
    level: ModelThinkingLevel,
): ModelThinkingLevel | undefined {
    const supported = model.reasoning ? getSupportedThinkingLevels(model) : ["off"];

    return THINKING_LEVELS.slice(0, THINKING_LEVELS.indexOf(level) + 1)
        .reverse()
        .find((each) => supported.includes(each));
}

/** Whether a model thinks, and at which levels, and whether it takes images. */
function capabilities(model: Model<Api>) {
    return {
        reasoning: model.reasoning === true,
        images: model.input.includes("image"),
        levels: model.reasoning ? getSupportedThinkingLevels(model) : ["off"],
    };
}

/** The models people can pick: the ones with a configured sign-in, marked when that sign-in needs renewing. */
export function modelList(
    models: ModelRuntime,
    signInNeeded: SignInNeeded = () => false,
    scopedModels: readonly ScopedModel[] = [],
): ModelSummary[] {
    const scoped = new Set(scopedModels.map(({ model }) => `${model.provider}/${model.id}`));

    return models.getAvailableSnapshot().map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        ...capabilities(model),
        ...(scoped.has(`${model.provider}/${model.id}`) ? { scoped: true as const } : {}),
        ...(signInNeeded(model.provider) ? { signIn: true as const } : {}),
    }));
}

/** A signed-in model by `provider/id`, or by id alone; undefined when there is none. */
export function findModel(models: ModelRuntime, spec: string): Model<Api> | undefined {
    const trimmed = spec.trim();
    const available = models.getAvailableSnapshot();
    const slash = trimmed.indexOf("/");

    return slash > 0
        ? available.find(
              (model) =>
                  model.provider === trimmed.slice(0, slash) &&
                  model.id === trimmed.slice(slash + 1),
          )
        : available.find((model) => model.id === trimmed);
}

/** Local metadata for one exact model, including models without configured auth. Never contacts a provider. */
export function modelInfo(models: ModelRuntime, spec: string) {
    const slash = spec.indexOf("/");
    const model =
        slash > 0 ? models.getModel(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;

    return model === undefined
        ? undefined
        : {
              model: { provider: model.provider, modelId: model.id },
              name: model.name,
              thinkingLevels: capabilities(model).levels as ModelThinkingLevel[],
              contextWindow: model.contextWindow,
              // Dollars per million tokens; left out when the catalog has no price.
              ...(model.cost.input > 0 || model.cost.output > 0
                  ? { cost: { input: model.cost.input, output: model.cost.output } }
                  : {}),
          };
}

/** Whether `spec` (`provider/id`, or an id alone) names the model `ref`. */
export function sameModel(spec: string, ref: ModelRef | undefined): boolean {
    const trimmed = spec.trim();

    return (
        ref !== undefined &&
        (trimmed === `${ref.provider}/${ref.modelId}` || trimmed === ref.modelId)
    );
}

/**
 * A signed-in model by `provider/id`, or by id alone, whose sign-in works as far as anyone knows. The error names no
 * other models: offered a list, Pi would pick from it, and models are a person's to choose.
 */
export function resolveModel(
    models: ModelRuntime,
    spec: string,
    signInNeeded: SignInNeeded = () => false,
): ModelRef {
    const found = findModel(models, spec);

    if (found === undefined) {
        throw new Error(`Model ${spec} is not available here.`);
    }

    if (signInNeeded(found.provider)) {
        throw new Error(
            `Model ${spec} is not available: the sign-in of its provider, ${found.provider}, expired and needs a person to sign in again.`,
        );
    }

    return { provider: found.provider, modelId: found.id };
}

/** What a conversation runs with, for its view: its model and what the model can do, thinking, folder, instructions. */
export function agentInfo(
    models: ModelRuntime,
    agent: AgentState,
    defaultCwd: string,
    signInNeeded: SignInNeeded = () => false,
) {
    const model =
        agent.model === undefined
            ? undefined
            : models.getModel(agent.model.provider, agent.model.modelId);

    return {
        model: agent.model ?? null,
        thinkingLevel: agent.thinkingLevel ?? "off",
        cwd: agent.cwd ?? defaultCwd,
        ...(agent.instructions === undefined ? {} : { instructions: agent.instructions }),
        available:
            model !== undefined &&
            models.hasConfiguredAuth(model.provider) &&
            !signInNeeded(model.provider),
        ...(model === undefined
            ? {}
            : {
                  modelName: model.name,
                  contextWindow: model.contextWindow,
                  ...capabilities(model),
              }),
    };
}
