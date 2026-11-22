/**
 * One classifier-model call through Pi's model runtime (`host.classify`): classifier models (TypeSafe's Jev,
 * Cloudflare's Clef, OpenAI's GPT-6 Luna) answer typed questions about JSON state. The call uses the owner's stored
 * provider sign-ins and keys, exactly as a session's own model calls do.
 */
import type {
    ClassifierApi,
    ClassifierAnswer,
    ClassifierContext,
    ClassifierModel,
    ClassifierQuestion,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** One classifier call: what the model judges, and what it answers. `host.classify` takes this. */
export interface ClassifyRequest {
    /**
     * The classifier model, `provider/modelId`. The id may hold more slashes, as in
     * `openrouter/~typesafe/jev-latest`, TypeSafe's Jev through OpenRouter. A chat model is refused.
     */
    model: string;
    /** What the model judges. */
    state: Record<string, unknown>;
    /** What it answers, by question id: a choice, a score, or yes/no. At least one. */
    questions: Record<string, ClassifierQuestion>;
}

/** The slice of Pi's model runtime a classifier call needs, so a test can fake it. */
export type ClassifyRuntime = Pick<
    ModelRuntime,
    "getModelOfType" | "getModelsOfType" | "hasConfiguredAuth" | "classify"
>;

const SHAPE =
    'Expected: { model: "provider/modelId", state: { ... }, questions: { <id>: { type: "choice" | "score" | "bool", instructions, criteria } } }.';

/** A value in an error message: itself when short, or its kind. */
function describe(value: unknown): string {
    if (value === undefined) {
        return "undefined";
    }

    if (typeof value !== "object" || value === null) {
        return typeof value === "string" ? JSON.stringify(value) : String(value);
    }

    const keys = Object.keys(value);

    return Array.isArray(value)
        ? "an array"
        : keys.length === 0
          ? "{}"
          : `{ ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""} }`;
}

/** Check a request, so a mistake fails with the expected shape instead of a provider error. */
function checkRequest(request: ClassifyRequest): void {
    if (typeof request.model !== "string" || request.model.trim() === "") {
        throw new Error(`host.classify: model is the spec of a classifier model. ${SHAPE}`);
    }

    if (
        typeof request.state !== "object" ||
        request.state === null ||
        Array.isArray(request.state)
    ) {
        throw new Error(`host.classify: state is an object, got ${describe(request.state)}`);
    }

    if (
        typeof request.questions !== "object" ||
        request.questions === null ||
        Object.keys(request.questions).length === 0
    ) {
        throw new Error(
            `host.classify: questions map question ids to questions, got ${describe(request.questions)}`,
        );
    }

    for (const [id, question] of Object.entries(request.questions)) {
        const at = `questions.${id}`;

        if (typeof question !== "object" || question === null) {
            throw new Error(`host.classify: ${at} is a question, got ${describe(question)}`);
        }

        if (typeof question.instructions !== "string") {
            throw new Error(`host.classify: ${at}.instructions is a string`);
        }

        if (question.type === "choice") {
            if (
                typeof question.criteria !== "object" ||
                question.criteria === null ||
                Object.values(question.criteria).some((each) => typeof each !== "string")
            ) {
                throw new Error(
                    `host.classify: ${at} is a choice, so criteria maps each label to its meaning`,
                );
            }
        } else if (question.type === "score") {
            if (
                !Array.isArray(question.criteria) ||
                question.criteria.some((each) => typeof each !== "string")
            ) {
                throw new Error(
                    `host.classify: ${at} is a score, so criteria lists the levels as strings, lowest first`,
                );
            }
        } else if (question.type === "bool") {
            if (
                typeof question.criteria !== "object" ||
                question.criteria === null ||
                typeof question.criteria.true !== "string" ||
                typeof question.criteria.false !== "string"
            ) {
                throw new Error(
                    `host.classify: ${at} is a bool, so criteria is { true: string, false: string }`,
                );
            }
        } else {
            throw new Error(
                `host.classify: ${at}.type is "choice", "score", or "bool", got ${JSON.stringify((question as { type?: unknown }).type)}`,
            );
        }
    }
}

/** The classifier that `spec` names, or an error that says what to do. A chat model is refused. */
function classifierOf(models: ClassifyRuntime, spec: string): ClassifierModel<ClassifierApi> {
    const trimmed = spec.trim();
    const hint =
        'Name a classifier model as "provider/modelId", for example "openrouter/~typesafe/jev-latest".';
    const slash = trimmed.indexOf("/");

    if (slash > 0) {
        const found = models.getModelOfType(
            "classifier",
            trimmed.slice(0, slash),
            trimmed.slice(slash + 1),
        );

        if (found !== undefined) {
            return found;
        }
    } else {
        // A bare id names one classifier only when no other provider has an id like it.
        const matches = models.getModelsOfType("classifier").filter((each) => each.id === trimmed);

        if (matches.length === 1) {
            return matches[0]!;
        }

        if (matches.length > 1) {
            throw new Error(
                `host.classify: "${trimmed}" names classifiers of ${matches.map((each) => each.provider).join(", ")}. ${hint}`,
            );
        }
    }

    const other =
        slash > 0
            ? (["chat", "image"] as const).find(
                  (type) =>
                      models.getModelOfType(
                          type,
                          trimmed.slice(0, slash),
                          trimmed.slice(slash + 1),
                      ) !== undefined,
              )
            : undefined;

    throw new Error(
        other === undefined
            ? `host.classify: no classifier model "${trimmed}" is known here. ${hint}`
            : `"${trimmed}" is a ${other} model, not a classifier model. ${hint}`,
    );
}

/**
 * One classifier call, through the model runtime: `answers` by question id. It throws when no such classifier
 * exists, when the spec names a chat model, when the model's provider has no stored sign-in or key, and when the
 * call fails; nothing is sent without the owner's stored key.
 */
export async function classifyThrough(
    models: ClassifyRuntime,
    request: ClassifyRequest,
): Promise<Record<string, ClassifierAnswer>> {
    checkRequest(request);

    const model = classifierOf(models, request.model);

    if (!models.hasConfiguredAuth(model.provider)) {
        throw new Error(
            `host.classify: no sign-in or key is stored for ${model.provider}, the provider of "${request.model.trim()}". Sign in to it in Menu → Providers first.`,
        );
    }

    const context: ClassifierContext = {
        state: request.state as ClassifierContext["state"],
        questions: request.questions,
    };
    const result = await models.classify(model, context);

    if (result.stopReason !== "stop") {
        throw new Error(
            `host.classify: ${model.provider}/${model.id} failed${result.errorMessage === undefined ? "" : `: ${result.errorMessage}`}`,
        );
    }

    return result.answers;
}
