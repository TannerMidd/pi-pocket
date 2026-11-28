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
import { classifyFor, trackClassifier } from "../src/server/classifier-activity.ts";
import {
    capText,
    classifierFor,
    isNoClassifier,
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

test("no default classifier: with no model named and none chosen, the call throws and sends nothing", async () => {
    const { runtime, calls } = fakeRuntime();
    const { model: _model, ...bareRequest } = request;

    await assert.rejects(
        classifyThrough(runtime, bareRequest),
        (error: unknown) =>
            isNoClassifier(error) &&
            /No classifier model is chosen: pick one in Providers/.test((error as Error).message),
    );
    await assert.rejects(classifyThrough(runtime, { ...bareRequest, model: "  " }, "  "), /chosen/);
    assert.equal(calls.length, 0, "nothing was sent");
});

test("the owner's shared choice answers a call that names no model; a named model wins", async () => {
    const { runtime, calls } = fakeRuntime();
    const { model: _model, ...bareRequest } = request;

    await classifyThrough(runtime, bareRequest, "faux-router/~typesafe/jev-latest");
    assert.equal(calls[0]!.spec, "faux-router/~typesafe/jev-latest");

    await classifyThrough(
        runtime,
        { ...bareRequest, model: "faux-router/jev-latest" },
        "faux-router/~typesafe/jev-latest",
    );
    assert.equal(calls[1]!.spec, "faux-router/jev-latest");
});

test("a module's own setting wins over the shared choice, and neither means none", () => {
    const host = { classifierModel: () => "a/shared" };

    assert.equal(classifierFor(host, " a/own "), "a/own");
    assert.equal(classifierFor(host, ""), "a/shared");
    assert.equal(classifierFor({ classifierModel: () => undefined }, ""), undefined);
    assert.equal(classifierFor({}, undefined), undefined, "a host with no such member: none");
    assert.equal(capText("x".repeat(10_000)).length, 6_000);
    assert.equal(capText("short"), "short");
});

test("the Hub records a timeout once, ignores a late reply, and distinguishes provider failure", async () => {
    const activityRequest = { model: "unused", state: {}, questions: {} };
    const provider = Promise.withResolvers<Record<string, ClassifierAnswer>>();
    const classify = () => provider.promise;
    const hub = trackClassifier(classify);

    assert.equal(await classifyFor(classify, "browser-screenshots", activityRequest, 5), undefined);
    provider.resolve({
        shot: { type: "choice", choice: "loading", confidence: 1, probabilities: { loading: 1 } },
    });
    await provider.promise;
    assert.deepEqual(
        hub.snapshot().recent.map((event) => [event.status, event.verdicts]),
        [["timed-out", []]],
    );
    hub.stop();

    const broken = async () => {
        throw new Error("provider detail that must not be retained");
    };

    const another = trackClassifier(broken);

    assert.equal(await classifyFor(broken, "relay-inbound", activityRequest, 100), undefined);
    assert.deepEqual(
        another.snapshot().recent.map((event) => [event.status, event.verdicts]),
        [["failed", []]],
    );
    another.stop();
});

test("recent activity is bounded, counts stay, and turning the Hub off clears the history", async () => {
    const activityRequest = { model: "unused", state: {}, questions: {} };
    const classify = async (): Promise<Record<string, ClassifierAnswer>> => ({
        privateQuestionId: { type: "score", score: 1, confidence: 1 },
    });
    const hub = trackClassifier(classify);

    for (let index = 0; index < 65; index += 1) {
        await classifyFor(classify, "pip-search", activityRequest, 100);
    }

    const snapshot = hub.snapshot();

    assert.equal(snapshot.recent.length, 60);
    assert.equal(snapshot.totals.find((source) => source.source === "pip-search")?.answered, 65);
    assert.deepEqual(snapshot.recent[0]?.verdicts, ["1 score"]);
    assert.ok(!JSON.stringify(snapshot).includes("privateQuestionId"));

    hub.stop();
    await classifyFor(classify, "pip-search", activityRequest, 100);
    const reopened = trackClassifier(classify);

    assert.deepEqual(reopened.snapshot().recent, []);
    assert.equal(
        reopened.snapshot().totals.find((source) => source.source === "pip-search")?.answered,
        0,
    );
    reopened.stop();
});
