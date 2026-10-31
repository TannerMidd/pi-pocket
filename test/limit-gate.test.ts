// The limit gate with fake model streams: waiting, the single canary, deadlines, and what a restart keeps.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    type Api,
    createAssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { LimitGate, type LimitTuning } from "../src/server/limit-gate.ts";

const TUNING: Partial<LimitTuning> = {
    ...{ minWaitMs: 5, resetJitterMs: [0, 0], backoffMs: [30], spacingMs: [30, 30] },
    ...{ maxBackoffMs: 100 * 3_600_000, refuseMs: 300, maxTries: 6 },
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const model = (id = "m", provider = "p") =>
    ({ id, provider, api: "anthropic-messages" }) as unknown as Model<Api>;
const gate = (extra: Partial<ConstructorParameters<typeof LimitGate>[0]> = {}) =>
    new LimitGate({
        hours: () => 6,
        epoch: () => 0,
        conversationOf: () => undefined,
        changed: () => {},
        log: () => {},
        tuning: TUNING,
        ...extra,
    });

type Step = { fail: string; headers?: Record<string, string> } | { ok: true };

/** A model runtime. A request follows the next step (or `repeat`); with none, the test ends it: `end("529")`, `end()`. */
function fake(steps: Step[] = [], repeat?: Step) {
    const calls: { at: number; fetch?: unknown; end: (e?: string) => void; content: () => void }[] =
        [];
    const models = {
        streamSimple(m: Model<Api>, _context: unknown, options?: SimpleStreamOptions) {
            const stream = createAssistantMessageEventStream();

            const reply = (error?: string) =>
                ({
                    ...{ role: "assistant", api: "anthropic-messages", provider: m.provider },
                    ...{ model: m.id, usage: { input: 0, output: 0, cacheRead: 0 } },
                    ...{ timestamp: Date.now() },
                    ...(error === undefined
                        ? { content: [{ type: "text", text: "ok" }], stopReason: "stop" }
                        : { content: [], stopReason: "error", errorMessage: error }),
                }) as never;

            const end = (error?: string) => {
                const message = reply(error);

                stream.push(
                    error === undefined
                        ? { type: "done", reason: "stop", message }
                        : { type: "error", reason: "error", error: message },
                );
                stream.end(message);
            };

            const step = steps.shift() ?? repeat;

            const content = () =>
                stream.push({ type: "text_start", contentIndex: 0, partial: reply() });

            calls.push({ at: Date.now(), fetch: options?.fetch, end, content });

            if (step !== undefined) {
                queueMicrotask(async () => {
                    if ("headers" in step && step.headers !== undefined) {
                        await options!.fetch!("https://provider.example/v1").catch(() => {});
                    }

                    end("fail" in step ? step.fail : undefined);
                });
            }

            return stream;
        },
    };

    return { calls, models };
}

const ask = (
    rt: ReturnType<typeof fake>,
    id = "m",
    provider = "p",
    options?: SimpleStreamOptions,
) => rt.models.streamSimple(model(id, provider), {} as never, options).result();

const stops = async (...asked: ReturnType<typeof ask>[]) =>
    (await Promise.all(asked)).map((result) => result.stopReason);

const until = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i++) {
        await sleep(2);
    }

    assert.ok(check(), "timed out");
};

const overloaded = { fail: "529 overloaded_error" };

test("one canary goes when the gate may clear, and the rest wait for it and leave one by one", async () => {
    const g = gate({ tuning: { ...TUNING, backoffMs: [150] } });
    const rt = fake([overloaded], { ok: true });

    g.install(rt.models);

    const first = ask(rt);

    await sleep(30);

    const rest = Array.from({ length: 9 }, (_, i) => ask(rt, "m", "p", { sessionId: `s${i}` }));

    await sleep(60);
    assert.equal(rt.calls.length, 1, "nothing goes out while the gate is closed");

    assert.ok((await stops(first, ...rest)).every((stop) => stop === "stop"));
    assert.equal(rt.calls.length, 11);

    const [canary, ...later] = rt.calls.slice(1).map((call) => call.at);

    assert.ok(
        later.every((at, i) => at >= canary! + 25 * (i + 1)),
        "released together",
    );
    assert.deepEqual(g.gates(), []);
});

test("a limit that covers the account holds every model of the provider, with one canary", async () => {
    const g = gate({ tuning: { ...TUNING, backoffMs: [300] } });
    const headers = {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(Math.floor((Date.now() + 300) / 1000) + 1),
    };
    const rt = fake([{ fail: "429 rate_limit_error", headers }], { ok: true });

    g.install(rt.models);

    const fetch = async () => new Response("x", { status: 429, headers });
    const a = ask(rt, "opus", "p", { fetch });

    await sleep(20);

    const b = ask(rt, "haiku");

    await sleep(20);
    assert.equal(rt.calls.length, 1, "the other model of the provider is held too");
    assert.deepEqual(await stops(a, b), ["stop", "stop"]);
});

test("the gate opens at the canary's first content, not when its whole stream ends", async () => {
    const g = gate();
    const rt = fake();

    g.install(rt.models);

    const a = ask(rt);

    rt.calls[0]!.end("529 overloaded_error");
    await sleep(10);

    const b = ask(rt);

    await until(() => rt.calls.length === 2);
    rt.calls[1]!.content();
    await until(() => rt.calls.length === 3);
    rt.calls[1]!.end();
    rt.calls[2]!.end();
    assert.deepEqual(await stops(a, b), ["stop", "stop"]);
});

const sharingLimit = {
    fail:
        "The ChatGPT user has reached their Subscription Sharing usage limit. " +
        "Ask the user to try again after their usage limit resets or use an API key instead.",
};

test("unknown-reset OpenAI subscription limits share the full budget, not overload or try caps", async () => {
    const g = gate({
        hours: () => 3_000 / 3_600_000,
        tuning: {
            ...TUNING,
            subscriptionBackoffMs: 30,
            maxBackoffMs: 10,
            maxTries: 1,
        },
    });
    const rt = fake(Array(4).fill({ ...sharingLimit, headers: {} }), { ok: true });

    g.install(rt.models);

    try {
        const first = ask(rt, "gpt-a", "openai", {
            fetch: async () => new Response("", { status: 200 }),
        });

        await until(() => g.gates().length === 1);

        const other = ask(rt, "gpt-b", "openai");

        assert.equal(g.gates()[0]!.key, "openai");
        assert.deepEqual(await stops(first, other), ["stop", "stop"]);
        assert.equal(rt.calls.length, 6);
    } finally {
        g.close();
    }
});

test("the six-hour subscription deadline survives restarts and never starts a fresh budget", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "limit-subscription-")), "provider-limits.json");
    const clock = { now: Date.now() };
    const since = clock.now;
    const options = { file, now: () => clock.now, random: () => 0.5 };

    // An unknown reset stays a backoff, not a fabricated provider reset time.
    for (const minutes of [0, 31, 359]) {
        clock.now = since + minutes * 60_000;

        const g = gate(options);
        const rt = fake([], sharingLimit);
        const stop = new AbortController();

        g.install(rt.models);

        const result = ask(rt, "gpt", "openai", { signal: stop.signal });

        try {
            await until(
                () =>
                    g.gates()[0]?.until ===
                    Math.min(clock.now + 15 * 60_000, since + 6 * 3_600_000),
            );
            assert.equal(g.gates()[0]!.since, since);
            assert.equal(g.gates()[0]!.kind, "backoff");
            assert.equal(g.gates()[0]!.resetAt, undefined);
            assert.equal(g.gates()[0]!.refusing, undefined);
        } finally {
            stop.abort();
            await result;
            g.close();
        }
    }

    clock.now = since + 361 * 60_000;

    const expired = gate(options);
    const rt = fake([], sharingLimit);

    expired.install(rt.models);

    try {
        assert.match(
            (await ask(rt, "gpt", "openai")).errorMessage!,
            /Not waiting: it did not clear in 6 h/,
        );
        await ask(rt, "gpt", "openai");
        assert.equal(rt.calls.length, 1, "the retry layer cannot start a new six-hour wait");
    } finally {
        expired.close();
    }
});

test("OpenAI HTTP errors expose reset headers even when the SDK skips onResponse", async () => {
    const g = gate();
    const rt = fake([sharingLimit]);
    const models = {
        streamSimple(m: Model<Api>, context: unknown, options?: SimpleStreamOptions) {
            const out = createAssistantMessageEventStream();

            void (async () => {
                await options!.fetch!("https://provider.example/v1");

                const stream = rt.models.streamSimple(m, context);

                for await (const event of stream) {
                    out.push(event);
                }

                out.end(await stream.result());
            })();

            return out;
        },
    };
    const stop = new AbortController();
    const reset = Math.floor(Date.now() / 1000) + 3600;

    g.install(models);

    const result = models
        .streamSimple(
            { ...model("gpt", "openai"), api: "openai-responses" },
            {},
            {
                signal: stop.signal,
                fetch: async () =>
                    new Response("quota", {
                        status: 429,
                        headers: {
                            "x-codex-primary-reset-at": String(reset),
                            "x-codex-primary-used-percent": "100",
                        },
                    }),
            },
        )
        .result();

    try {
        await until(() => g.gates().length === 1);
        assert.equal(g.gates()[0]!.kind, "reset");
        assert.equal(g.gates()[0]!.resetAt, reset * 1000);
    } finally {
        stop.abort();
        await result;
        g.close();
    }
});

test("a weekly window found late, behind a gate that waits hours, refuses at once", async () => {
    const g = gate({ hours: () => 6 });
    const rt = fake(Array(2).fill({ fail: "429 rate_limit_error", headers: {} }));
    const window = (name: string, seconds: number) => ({
        fetch: async () =>
            new Response("x", {
                status: 429,
                headers: {
                    [`anthropic-ratelimit-unified-${name}-status`]: "rejected",
                    [`anthropic-ratelimit-unified-${name}-reset`]: String(
                        Math.floor(Date.now() / 1000) + seconds,
                    ),
                },
            }),
    });

    g.install(rt.models);

    // The first closes the account's gate for 5 hours; the second, out before it, finds the 7-day window.
    const both = Promise.all([
        ask(rt, "m", "p", window("5h", 5 * 3600)),
        ask(rt, "m", "p", window("7d", 3 * 86400)),
    ]);
    const results = await Promise.race([both, sleep(500).then(() => undefined)]);

    assert.ok(results, "nobody waits hours for a window of days");
    assert.match(results[1].errorMessage!, /a limit of days/);
    g.close();
});

test("Retry now is one try each 30 seconds, and pressing it cannot make a shared gate give up", async () => {
    const g = gate({
        tuning: { ...TUNING, backoffMs: [60_000], maxTries: 1 },
        conversationOf: () => 7,
    });
    const rt = fake([{ fail: "429 usage limit. Try again in 1h" }, overloaded]);

    g.install(rt.models);
    void ask(rt, "m", "p", { sessionId: "s" });
    await until(() => g.waitFor(7) !== undefined);
    assert.equal(g.retryNow(7), true);
    assert.equal(g.retryNow(7), false, "a second press within 30 seconds does nothing");
    await until(() => rt.calls.length === 2);
    await sleep(40);
    // The manual try failed in another scope (an overload, the model's): it counts toward no cap (maxTries is 1), the
    // gate it makes has a real time, and no third request goes at once.
    assert.equal(g.gates()[0]?.refusing, undefined);
    assert.ok(g.waitFor(7));
    assert.ok(g.gates().every((each) => Number.isFinite(each.until)));
    assert.equal(rt.calls.length, 2);
    g.close();
});

test("a canary whose failure moves the scope leaves no gate probing", async () => {
    const g = gate();
    const rt = fake([overloaded, { fail: "429 usage limit. Try again in 0s" }], { ok: true });

    g.install(rt.models);
    assert.equal((await ask(rt)).stopReason, "stop");
    await sleep(30);
    assert.deepEqual(g.gates(), []);
    assert.equal((await ask(rt)).stopReason, "stop", "the next request is not held for ever");
});

test("a request that was out before the gate closed, failing late, does not start a second canary", async () => {
    const g = gate();
    const rt = fake();

    g.install(rt.models);

    const a = ask(rt);
    const b = ask(rt);

    rt.calls[0]!.end("529 overloaded_error");
    await until(() => rt.calls.length === 3);
    rt.calls[1]!.end("529 overloaded_error");
    await sleep(120);
    assert.equal(rt.calls.length, 3, "no second canary");
    rt.calls[2]!.end();
    await until(() => rt.calls.length === 4);
    rt.calls[3]!.end();
    assert.deepEqual(await stops(a, b), ["stop", "stop"]);
});

test("a request's tries and deadline hold when the scope keeps changing", async () => {
    // An overload (the model's), a usage limit (the account's), and so on.
    const alternate = (length: number): Step[] =>
        Array.from({ length }, (_, i) => ({
            fail: i % 2 === 0 ? "529 overloaded_error" : "429 usage limit. Try again in 25ms",
        }));
    const capped = fake(alternate(30));

    gate({ tuning: { ...TUNING, maxTries: 3, backoffMs: [20] } }).install(capped.models);

    assert.match((await ask(capped)).errorMessage!, /Not waiting: it did not clear after 3 tries/);
    assert.equal(capped.calls.length, 4);

    const timed = fake(alternate(60));
    const started = Date.now();

    gate({
        hours: () => 60 / 3_600_000,
        tuning: { ...TUNING, maxTries: 40, backoffMs: [25] },
    }).install(timed.models);
    assert.match((await ask(timed)).errorMessage!, /Not waiting/);
    assert.ok(timed.calls.at(-1)!.at - started <= 80, "no request after the deadline");
});

test("a reset too far away refuses at once, and the refusal survives a restart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "limit-gate-")), "provider-limits.json");
    const options = { file, hours: () => 1, tuning: TUNING };
    const first = gate(options);
    const rt = fake([{ fail: "429 rate_limit_error retryDelay: 604800s" }], { ok: true });

    first.install(rt.models);
    assert.match((await ask(rt)).errorMessage!, /Not waiting: it resets in 7 d/);
    // Pi Durable's own retries meet the refusal: no request, no second wait.
    assert.match((await ask(rt)).errorMessage!, /Not waiting/);
    assert.equal(rt.calls.length, 1);
    first.close();

    const second = gate(options);
    const rt2 = fake([], { ok: true });

    second.install(rt2.models);
    assert.match((await ask(rt2)).errorMessage!, /Not waiting/);
    assert.equal(rt2.calls.length, 0, "the same limit sends nothing until it ends");
    second.close();
});

test("a gate nobody waits at, past its deadline, lets one request go as canary; a second limit failure gives up", async () => {
    // A request waits 15 minutes at a gate (one hour allowed) and is stopped; a new request comes 70 minutes later.
    const clock = { now: Date.now() };
    const options = {
        file: join(mkdtempSync(join(tmpdir(), "limit-gate-")), "provider-limits.json"),
        hours: () => 1,
        now: () => clock.now,
        random: () => 0.5,
        tuning: { ...TUNING, backoffMs: [15 * 60_000] },
    };
    const stop = new AbortController();
    const g = gate(options);
    const rt = fake([], overloaded);

    g.install(rt.models);

    const stopped = ask(rt, "m", "p", { signal: stop.signal });

    await until(() => g.gates().length === 1);
    stop.abort();
    assert.equal((await stopped).stopReason, "aborted");
    clock.now += 70 * 60_000;

    // The limit may have cleared: one request goes, with no refusal first. It meets the limit again: now it gives up.
    assert.match((await ask(rt)).errorMessage!, /Not waiting/);
    assert.equal(rt.calls.length, 2);
    assert.match((await ask(rt)).errorMessage!, /Not waiting/);
    assert.equal(rt.calls.length, 2, "the refusal that follows sends nothing");
    g.close();
});

test("a missing or damaged file means no limit is known", () => {
    const file = join(mkdtempSync(join(tmpdir(), "limit-gate-")), "provider-limits.json");

    assert.equal(gate({ file }).gates().length, 0);

    for (const text of ["", "{", '{"version":1,"gates":[null,1,{"key":3}]}']) {
        writeFileSync(file, text);
        assert.equal(gate({ file }).gates().length, 0, text);
    }
});

test("an adapter that refuses a custom fetch (Google) gets none", async () => {
    const rt = fake([], { ok: true });

    gate().install(rt.models);
    await rt.models.streamSimple({ ...model(), api: "google-generative-ai" }, {} as never).result();
    await ask(rt);
    assert.equal(rt.calls[0]!.fetch, undefined);
    assert.equal(typeof rt.calls[1]!.fetch, "function");
});
