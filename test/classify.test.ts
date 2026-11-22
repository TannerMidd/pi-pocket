// `host.classify` (`src/server/classify.ts`): a classifier model is resolved from its spec, a chat model and a missing
// sign-in are refused before anything is sent, and the answers or the call's error surface. No network, no key: the
// runtime here is a fake, the models synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
    ClassifierAnswer,
    ClassifierContext,
    ClassifierModel,
    ClassifierResult,
} from "@earendil-works/pi-ai";
import {
    type ClassifyRequest,
    type ClassifyRuntime,
    classifyThrough,
} from "../src/server/classify.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const model = (provider: string, id: string): ClassifierModel<"typesafe-system-one"> => ({
    type: "classifier",
    id,
    name: `Faux ${id}`,
    api: "typesafe-system-one",
    provider,
    baseUrl: "https://faux.example/v1",
    input: ["text"],
    cost,
    contextWindow: 64000,
});

const jev = model("faux-router", "~typesafe/jev-latest");
const jevTwo = model("other-router", "~typesafe/jev-latest");
const bare = model("faux-router", "jev-latest");

const choice = (picked: string): ClassifierAnswer => ({
    type: "choice",
    choice: picked,
    probabilities: { [picked]: 1 },
    confidence: 1,
});

const ok = (answers: Record<string, ClassifierAnswer>): ClassifierResult => ({
    api: "typesafe-system-one",
    provider: "faux-router",
    model: jev.id,
    answers,
    stopReason: "stop",
    timestamp: 1,
});

/** A fake of the model runtime's slice: what it resolved, what it was asked, and what it answers. */
function fakeRuntime(options: { signedIn?: boolean; fail?: () => string } = {}) {
    const calls: { spec: string; state: unknown; questions: unknown }[] = [];
    const runtime = {
        getModelOfType: (type: string, provider: string, id: string) =>
            type === "classifier"
                ? [jev, jevTwo, bare].find((each) => each.provider === provider && each.id === id)
                : type === "chat" && provider === "faux-router" && id === "faux-1"
                  ? { id: "faux-1", name: "Faux", type: "chat" }
                  : undefined,
        getModelsOfType: (type: string) => (type === "classifier" ? [jev, jevTwo, bare] : []),
        hasConfiguredAuth: (provider: string) =>
            options.signedIn !== false && provider === "faux-router",
        classify: async (
            called: ClassifierModel<"typesafe-system-one">,
            context: ClassifierContext,
        ) => {
            calls.push({
                spec: `${called.provider}/${called.id}`,
                state: context.state,
                questions: context.questions,
            });

            const failure = options.fail?.();

            return failure === undefined
                ? ok({ triage: choice("question") })
                : {
                      ...ok({}),
                      stopReason: "error",
                      errorMessage: failure,
                  };
        },
    } as unknown as ClassifyRuntime;

    return { runtime, calls };
}

const request: ClassifyRequest = {
    model: "faux-router/~typesafe/jev-latest",
    state: { message: "Is this a bug or a feature?" },
    questions: {
        triage: {
            type: "choice",
            instructions: "Classify the message.",
            criteria: { bug: "It reports a defect.", feature: "It asks for a change." },
        },
    },
};

test("classify reaches the runtime and gives back its answers", async () => {
    const { runtime, calls } = fakeRuntime();

    assert.deepEqual(await classifyThrough(runtime, request), { triage: choice("question") });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.spec, "faux-router/~typesafe/jev-latest");
    assert.deepEqual(calls[0]!.state, request.state);
    assert.deepEqual(calls[0]!.questions, request.questions);

    // A bare id names the one classifier that has it; a spec that names none is refused.
    assert.deepEqual(await classifyThrough(runtime, { ...request, model: "jev-latest" }), {
        triage: choice("question"),
    });
    await assert.rejects(
        classifyThrough(runtime, { ...request, model: "faux-router/no-such-model" }),
        /no classifier model "faux-router\/no-such-model"/,
    );
});

test("a chat model is refused, and so is a bad request shape", async () => {
    const { runtime, calls } = fakeRuntime();

    await assert.rejects(
        classifyThrough(runtime, { ...request, model: "faux-router/faux-1" }),
        /"faux-router\/faux-1" is a chat model, not a classifier model/,
    );
    await assert.rejects(classifyThrough(runtime, { ...request, questions: {} }), /questions/);
    assert.equal(calls.length, 0, "nothing was sent");
});

test("no stored sign-in for the model's provider is refused before anything is sent", async () => {
    const { runtime, calls } = fakeRuntime({ signedIn: false });

    await assert.rejects(
        classifyThrough(runtime, request),
        /no sign-in or key is stored for faux-router/,
    );
    assert.equal(calls.length, 0, "nothing was sent");
});

test("a failed call surfaces its error", async () => {
    const { runtime } = fakeRuntime({ fail: () => "the provider refused" });

    await assert.rejects(
        classifyThrough(runtime, request),
        /faux-router\/~typesafe\/jev-latest failed: the provider refused/,
    );
});
