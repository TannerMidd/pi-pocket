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
    ImageContent,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** What `host.classify` throws when no classifier model is named and the owner chose none. */
export const NO_CLASSIFIER_MESSAGE =
    "No classifier model is chosen: pick one in Providers (Menu → Providers).";

/** The error `host.classify` throws when no classifier model is named and the owner chose none. */
export class NoClassifierError extends Error {
    readonly code = "no-classifier";

    constructor() {
        super(NO_CLASSIFIER_MESSAGE);
    }
}

/** Whether an error says no classifier model is chosen: a module treats it as "the feature is off", not a failure. */
export function isNoClassifier(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === "no-classifier";
}

/** One classifier call: what the model judges, and what it answers. `host.classify` takes this. */
export interface ClassifyRequest {
    /**
     * The classifier model, `provider/modelId`; the id may hold more slashes. A chat model is refused. Left out, or
     * empty, the call uses the classifier model the owner chose in Providers, and throws when there is none.
     */
    model?: string;
    /** What the model judges. */
    state: Record<string, unknown>;
    /** Images judged together with `state`. Only models whose input accepts images answer them. */
    images?: ImageContent[];
    /** What it answers, by question id: a choice, a score, or yes/no. At least one. */
    questions: Record<string, ClassifierQuestion>;
}

/**
 * The classifier a module uses: its own "Classify model" setting when that is set, else the owner's choice in
 * Providers. Undefined when neither is: the module does nothing then, as when the classifier is down.
 */
export function classifierFor(
    host: { classifierModel?: () => string | undefined },
    own: unknown,
): string | undefined {
    if (typeof own === "string" && own.trim() !== "") {
        return own.trim();
    }

    // A module reloads into a running server before its host changes: until a restart, no shared choice.
    return (
        (typeof host.classifierModel === "function" ? host.classifierModel() : undefined) ||
        undefined
    );
}

/** The text a module sends to a classifier is cut to this many characters: an outsider's text has no other bound. */
export const MAX_CLASSIFY_TEXT = 6_000;

/** `text` cut to `max` characters, with a mark where it was cut. */
export function capText(text: string, max = MAX_CLASSIFY_TEXT): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The slice of Pi's model runtime a classifier call needs, so a test can fake it. */
export type ClassifyRuntime = Pick<
    ModelRuntime,
    "getModelOfType" | "getModelsOfType" | "hasConfiguredAuth" | "classify"
>;

/** Run one call with a deadline: its value, or undefined when it failed or ran out of time, so the caller goes on. */
export async function withDeadline<T>(
    run: () => Promise<T>,
    timeoutMs: number,
): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;

    try {
        return await Promise.race([
            run(),
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), timeoutMs);
            }),
        ]);
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}

const SHAPE =
    'Expected: { model?: "provider/modelId", state: { ... }, questions: { <id>: { type: "choice" | "score" | "bool", instructions, criteria } } }.';

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
    if (request.model !== undefined && typeof request.model !== "string") {
        throw new Error(`host.classify: model is the spec of a classifier model. ${SHAPE}`);
    }

    if (
        typeof request.state !== "object" ||
        request.state === null ||
        Array.isArray(request.state)
    ) {
        throw new Error(`host.classify: state is an object, got ${describe(request.state)}`);
    }

    if (request.images !== undefined && !Array.isArray(request.images)) {
        throw new Error(
            `host.classify: images is an array of images, got ${describe(request.images)}`,
        );
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
    const hint = 'Name a classifier model as "provider/modelId", as the Providers sheet lists it.';
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
 * One classifier call, through the model runtime: `answers` by question id. The request's model, or else `shared`
 * (the owner's choice in Providers). It throws when neither names one (`NoClassifierError`), when no such classifier
 * exists, when the spec names a chat model, when the model's provider has no stored sign-in or key, and when the
 * call fails; nothing is sent without the owner's stored key.
 */
export async function classifyThrough(
    models: ClassifyRuntime,
    request: ClassifyRequest,
    shared?: string,
): Promise<Record<string, ClassifierAnswer>> {
    checkRequest(request);

    const spec = request.model?.trim() || shared?.trim();

    if (!spec) {
        throw new NoClassifierError();
    }

    const model = classifierOf(models, spec);

    if (!models.hasConfiguredAuth(model.provider)) {
        throw new Error(
            `host.classify: no sign-in or key is stored for ${model.provider}, the provider of "${spec}". Sign in to it in Menu → Providers first.`,
        );
    }

    const context: ClassifierContext = {
        state: request.state as ClassifierContext["state"],
        ...(request.images === undefined ? {} : { images: request.images }),
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
