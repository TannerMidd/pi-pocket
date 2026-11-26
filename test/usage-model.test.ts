// web/usage.js in Node: which window is tightest, a provider's state, the order of the others, and the words.
import assert from "node:assert/strict";
import { test } from "node:test";

type Fn = (...args: any[]) => any;
const {
    agoWords,
    hoursMinutes,
    inWords,
    modelHoldWords,
    providerView,
    sortProviders,
    summary,
    tightestWindow,
} = (await import(new URL("../web/usage.js", import.meta.url).href)) as {
    [
        name in
            | "agoWords"
            | "hoursMinutes"
            | "inWords"
            | "modelHoldWords"
            | "providerView"
            | "sortProviders"
            | "summary"
            | "tightestWindow"
    ]: Fn;
};
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const win = (id: string, left: number, state: string, resetIn?: number, tag = id) => ({
    ...{ id, tag, label: `${id} window`, left, state },
    ...(resetIn === undefined ? {} : { resetAt: NOW + resetIn }),
});
const provider = (name: string, windows: unknown[], extra: Record<string, unknown> = {}) => ({
    ...{ id: name.toLowerCase(), name, kind: "key", status: "reported", asOf: NOW - MIN, windows },
    ...extra,
});

test("the tightest window is the least left, a limited one first, and a reset one counts for nothing", () => {
    const five = win("5h", 68, "ok", 120 * MIN);
    const week = win("7d", 41, "ok", 3000 * MIN);

    assert.equal(tightestWindow(provider("A", [five, week]), NOW)?.id, "7d");
    // The 5-hour window reset: only the weekly one is live.
    assert.equal(tightestWindow(provider("A", [win("5h", 10, "low", -MIN), week]), NOW)?.id, "7d");
    // Both limited: back when the later one resets.
    const both = [win("5h", 0, "limited", 60 * MIN), win("7d", 0, "limited", 600 * MIN)];

    assert.equal(tightestWindow(provider("A", both), NOW)?.id, "7d");
    assert.equal(tightestWindow(provider("A", [win("5h", 10, "low", -MIN)]), NOW), null);
});

test("a provider's state: ok, low, limited, reset, no data, not reported, and held by the limit gate", () => {
    const view = (p: ReturnType<typeof provider>) => providerView(p, NOW);

    assert.equal(view(provider("A", [win("5h", 68, "ok", MIN)])).state, "ok");
    assert.equal(view(provider("A", [win("5h", 9, "low", MIN)])).state, "low");

    const limited = view(provider("A", [win("5h", 0, "limited", 72 * MIN)]));

    assert.equal(limited.state, "limited");
    assert.equal(limited.until, NOW + 72 * MIN);
    assert.equal(view(provider("A", [win("5h", 50, "ok", -MIN)])).state, "reset");
    assert.equal(view(provider("A", [], { status: "no-data" })).state, "no-data");
    assert.equal(view(provider("A", [], { status: "not-reported" })).state, "not-reported");

    // The gate holds it though its numbers look fine; once its time passes it does not.
    const held = view(
        provider("A", [win("5h", 50, "ok", 600 * MIN)], {
            held: { until: NOW + 5 * MIN, reason: "x" },
        }),
    );

    assert.equal(held.state, "limited");
    assert.equal(held.until, NOW + 5 * MIN);
    assert.equal(
        view(
            provider("A", [win("5h", 50, "ok", 600 * MIN)], {
                held: { until: NOW - MIN, reason: "x" },
            }),
        ).state,
        "ok",
    );
});

test("others come limited (back soonest first), low, then the least left, then by name", () => {
    const views = [
        provider("Zed", [win("r", 90, "ok", MIN)]),
        provider("Beta", [win("r", 34, "ok", MIN)]),
        provider("Gamma", [win("r", 0, "limited", 300 * MIN)]),
        provider("Delta", [win("r", 9, "low", MIN)]),
        provider("Alpha", [win("r", 0, "limited", 60 * MIN)]),
        provider("Eps", [win("r", 34, "ok", MIN)]),
        provider("Old", [win("r", 20, "ok", -MIN)]),
    ].map((each) => providerView(each, NOW));

    assert.deepEqual(
        sortProviders(views).map((view: { provider: { name: string } }) => view.provider.name),
        ["Alpha", "Gamma", "Delta", "Beta", "Eps", "Zed", "Old"],
    );
});

test("the words", () => {
    assert.equal(hoursMinutes(72 * MIN + 30_000), "1:13");
    assert.equal(hoursMinutes(0), "0:00");
    assert.equal(inWords(40_000), "40 s");
    assert.equal(inWords(125 * MIN), "2 h 5 min");
    assert.equal(inWords((3 * 24 + 18) * 60 * MIN), "3 d 18 h");
    assert.equal(agoWords(2000), "just now");
    assert.equal(agoWords(6 * MIN), "6 min ago");

    const ok = providerView(provider("Anthropic", [win("7d", 41, "ok", 3000 * MIN)]), NOW);

    assert.equal(summary(ok, NOW)?.text, "7d 41% left");
    assert.match(
        summary(ok, NOW)?.aria ?? "",
        /^Anthropic usage: 41% left in the 7d window\. It resets in 2 d 2 h\.$/,
    );

    const limited = providerView(provider("OpenAI", [win("5h", 0, "limited", 72 * MIN)]), NOW);

    assert.equal(summary(limited, NOW)?.text, "Limited 1:12");
    assert.equal(summary(providerView(provider("G", [], { status: "no-data" }), NOW), NOW), null);
});

test("a hold is checked before the numbers: after a restart a waiting provider is still limited", () => {
    const held = { until: NOW + 5 * MIN, reason: "x" };

    for (const status of ["no-data", "not-reported"]) {
        const view = providerView(provider("A", [], { status, held }), NOW);

        assert.equal(view.state, "limited", status);
        assert.equal(view.until, NOW + 5 * MIN);
        assert.equal(view.window, null);
        assert.equal(summary(view, NOW)?.text, "Limited 0:05");
        // A hold that has passed leaves what the provider has: no usage.
        assert.equal(
            providerView(provider("A", [], { status, held: { ...held, until: NOW - 1 } }), NOW)
                .state,
            status,
        );
    }

    // The session's model's own hold counts too, and with no model given it does not.
    const modelHolds = [{ modelId: "claude-fable", until: NOW + 7 * MIN, reason: "y" }];
    const own = providerView(
        provider("A", [], { status: "no-data", modelHolds }),
        NOW,
        "claude-fable",
    );

    assert.equal(own.state, "limited");
    assert.equal(own.until, NOW + 7 * MIN);
    assert.equal(
        providerView(provider("A", [], { status: "no-data", modelHolds }), NOW).state,
        "no-data",
    );
});

test("a model's hold limits the provider only for that model, and is a detail for the others", () => {
    const modelHolds = [
        { modelId: "claude-fable", until: NOW + 72 * MIN, reason: "y" },
        { modelId: "stale", until: NOW - MIN, reason: "y" },
    ];
    const reported = provider("Anthropic", [win("5h", 68, "ok", 120 * MIN)], { modelHolds });
    const other = providerView(reported, NOW, "claude-sonnet");
    const same = providerView(reported, NOW, "claude-fable");

    assert.equal(other.state, "ok");
    assert.equal(summary(other, NOW)?.text, "5h 68% left");
    assert.deepEqual(modelHoldWords(other, NOW), ["claude-fable limited · 1:12"]);
    assert.equal(providerView(reported, NOW).state, "ok");
    assert.equal(same.state, "limited");
    assert.equal(same.until, NOW + 72 * MIN);
    assert.equal(summary(same, NOW)?.text, "Limited 1:12");
    // An account-wide hold limits every model.
    assert.equal(
        providerView({ ...reported, held: { until: NOW + MIN, reason: "z" } }, NOW, "claude-sonnet")
            .state,
        "limited",
    );
});

test("less than one percent left says <1%, and is not limited", () => {
    const tiny = { ...win("tokens", 0, "low", 6 * MIN, "tok"), tiny: true };
    const view = providerView(provider("A", [tiny]), NOW);

    assert.equal(view.state, "low");
    assert.equal(summary(view, NOW)?.text, "tok <1% left");
    assert.match(summary(view, NOW)?.aria ?? "", /low, <1% left/);
});
