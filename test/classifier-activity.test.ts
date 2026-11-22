import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClassifierAnswer } from "@earendil-works/pi-ai";
import { classifyFor, trackClassifier } from "../src/server/classifier-activity.ts";

const request = { model: "unused", state: {}, questions: {} };

test("the Hub records a timeout once, ignores a late reply, and distinguishes provider failure", async () => {
    const provider = Promise.withResolvers<Record<string, ClassifierAnswer>>();
    const classify = () => provider.promise;
    const hub = trackClassifier(classify);

    assert.equal(await classifyFor(classify, "browser-screenshots", request, 5), undefined);
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

    assert.equal(await classifyFor(broken, "relay-inbound", request, 100), undefined);
    assert.deepEqual(
        another.snapshot().recent.map((event) => [event.status, event.verdicts]),
        [["failed", []]],
    );
    another.stop();
});

test("recent activity is bounded, counts stay, and turning the Hub off clears the history", async () => {
    const classify = async (): Promise<Record<string, ClassifierAnswer>> => ({
        privateQuestionId: { type: "score", score: 1, confidence: 1 },
    });
    const hub = trackClassifier(classify);

    for (let index = 0; index < 65; index += 1) {
        await classifyFor(classify, "pip-search", request, 100);
    }

    const snapshot = hub.snapshot();

    assert.equal(snapshot.recent.length, 60);
    assert.equal(snapshot.totals.find((source) => source.source === "pip-search")?.answered, 65);
    assert.deepEqual(snapshot.recent[0]?.verdicts, ["1 score"]);
    assert.ok(!JSON.stringify(snapshot).includes("privateQuestionId"));

    hub.stop();
    await classifyFor(classify, "pip-search", request, 100);
    const reopened = trackClassifier(classify);

    assert.deepEqual(reopened.snapshot().recent, []);
    assert.equal(
        reopened.snapshot().totals.find((source) => source.source === "pip-search")?.answered,
        0,
    );
    reopened.stop();
});
