/** Measuring a model's stream for the footer's speed must never hold back its result. */
import assert from "node:assert/strict";
import test from "node:test";
import {
    type AssistantMessage,
    type AssistantMessageEventStream,
    createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { measureModelStreams } from "../src/server/timing.ts";

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
