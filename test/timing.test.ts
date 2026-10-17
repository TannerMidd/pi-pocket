/** The footer's speed metrics: a real stream window yields tokens per second, a buffered flush does not. */
import assert from "node:assert/strict";
import test from "node:test";
import {
    type AssistantMessage,
    type AssistantMessageEventStream,
    createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { projectStats } from "../src/server/projection.ts";
import { measureModelStreams, type StreamTiming } from "../src/server/timing.ts";

let id = 0;

function assistant(usage: Record<string, number>, timing?: StreamTiming): EntryRecord {
    return {
        id: ++id,
        conversationId: 1,
        kind: "pi.assistant",
        model: [{ usage, stopReason: "stop", ...(timing ? { pocketTiming: timing } : {}) }],
    } as unknown as EntryRecord;
}

test("a genuine stream window yields tokens per second and time to first token", () => {
    const stats = projectStats(undefined, [
        assistant(
            { input: 10, output: 300, cacheRead: 0, cacheWrite: 0 },
            { startedAt: 1000, firstTokenAt: 1500, endedAt: 3500 },
        ),
    ]);

    assert.equal(stats.ttftMs, 500);
    assert.equal(stats.tokensPerSec, 150);
});

test("a buffered flush measures no window and is not reported as an absurd rate", () => {
    const stats = projectStats(undefined, [
        assistant(
            { input: 10, output: 24, cacheRead: 0, cacheWrite: 0 },
            { startedAt: 1000, firstTokenAt: 1098, endedAt: 1099 },
        ),
    ]);

    assert.equal(stats.ttftMs, 98);
    assert.equal(stats.tokensPerSec, undefined);
});

test("responses without a timing stamp show nothing rather than guessing", () => {
    const stats = projectStats(undefined, [
        assistant({ input: 10, output: 100, cacheRead: 0, cacheWrite: 0 }),
    ]);

    assert.equal(stats.tokensPerSec, undefined);
    assert.equal(stats.ttftMs, undefined);
});

test("the speed and the time to first token are the newest response's, never an older one's", () => {
    const streamed = assistant(
        { input: 10, output: 100, cacheRead: 0, cacheWrite: 0 },
        { startedAt: 0, firstTokenAt: 1000, endedAt: 3000 },
    );
    const flushed = projectStats(undefined, [
        streamed,
        assistant(
            { input: 10, output: 24, cacheRead: 0, cacheWrite: 0 },
            { startedAt: 0, firstTokenAt: 98, endedAt: 99 },
        ),
    ]);

    assert.equal(flushed.tokensPerSec, undefined);
    assert.equal(flushed.ttftMs, 98);

    const unstamped = projectStats(undefined, [
        streamed,
        assistant({ input: 10, output: 24, cacheRead: 0, cacheWrite: 0 }),
    ]);

    assert.equal(unstamped.tokensPerSec, undefined);
    assert.equal(unstamped.ttftMs, undefined);
});

function message(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: text === "" ? [] : [{ type: "text", text }],
        api: "faux",
        provider: "faux",
        model: "faux-1",
        usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

/** A model runtime whose one stream `script` drives. */
function runtime(script: (stream: AssistantMessageEventStream) => Promise<void>) {
    const models = {
        streamSimple: () => {
            const stream = createAssistantMessageEventStream();

            void script(stream);

            return stream;
        },
    };

    measureModelStreams(models as never);

    return models.streamSimple as unknown as () => AssistantMessageEventStream;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a measured stream passes every event on, and stamps its terminal message", async () => {
    const final = message("hi");
    const stream = runtime(async (source) => {
        source.push({ type: "start", partial: message("") });
        await pause(30);
        source.push({ type: "text_start", contentIndex: 0, partial: message("") });
        source.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial: message("hi") });
        await pause(30);
        source.push({ type: "done", reason: "stop", message: final });
    })();
    const types: string[] = [];

    for await (const event of stream) {
        types.push(event.type);
    }

    const result = (await stream.result()) as AssistantMessage & { pocketTiming?: StreamTiming };

    assert.deepEqual(types, ["start", "text_start", "text_delta", "done"]);
    assert.equal(result, final);

    const timing = result.pocketTiming!;

    assert.ok(timing.firstTokenAt! - timing.startedAt >= 20);
    assert.ok(timing.endedAt - timing.firstTokenAt! >= 20);
});

test("a measured stream that ends without a terminal event still gives its result", async () => {
    const final = message("hi");
    const stream = runtime(async (source) => {
        source.push({ type: "start", partial: message("") });
        source.end(final);
    })();

    const consumed = (async () => {
        for await (const event of stream) {
            assert.equal(event.type, "start");
        }

        return stream.result();
    })();
    const result = await Promise.race([consumed, pause(1000).then(() => "hung")]);

    assert.equal(result, final);
});
