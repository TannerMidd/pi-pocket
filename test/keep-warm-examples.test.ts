// The fixed examples in the keep-warm sheet use the current settings and one calculation.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

/** The sheet's browser imports are not used by the arithmetic, as in voice.test.ts. */
const STUBS: Record<string, string> = {
    "preact/hooks": `export const useState = () => {}; export const useRef = () => {}; export const useEffect = () => {};`,
    "../store.js": `export const actions = {}; export const api = () => {}; export const attempt = () => {}; export const canSteer = () => {}; export const closeSheet = () => {}; export const store = {};`,
    "../ui.js": `export const html = () => {}; export const Icon = () => {}; export const Loader = () => {}; export const Sheet = () => {}; export const Switch = () => {};`,
};
const hooks = registerHooks({
    resolve(specifier, context, next) {
        const stub = STUBS[specifier];

        return stub !== undefined && context.parentURL?.endsWith("/web/sheets/keep-warm.js")
            ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
            : next(specifier, context);
    },
});

type Settings = { share: number; maxRefreshes: number; maxCost: number };
type Example = { input: number; read: number; writeMultiplier: number; cacheMinutes: number };
type Estimate = {
    refreshes: number;
    cost: number;
    lasts: number;
    uncached: number;
    everyMs: number;
    breakEven: number;
};
const { estimate } = (await import(
    new URL("../web/sheets/keep-warm.js", import.meta.url).href
)) as {
    estimate(hours: number | "break-even", settings: Settings, example?: Example): Estimate;
};

hooks.deregister();

const uncapped: Settings = { share: 75, maxRefreshes: 10_000, maxCost: 0 };

test("keep-warm examples: Claude Break-even is 39 refreshes without caps", () => {
    const result = estimate("break-even", uncapped);

    assert.equal(result.refreshes, 39);
    assert.equal(result.cost, 1.17);
    assert.equal(result.everyMs, 45 * 60_000);
    assert.equal(result.lasts, 39 * 45 * 60_000);
});

test("keep-warm examples: the refresh cap stops Claude at 30", () => {
    const result = estimate("break-even", { ...uncapped, maxRefreshes: 30 });

    assert.equal(result.refreshes, 30);
    assert.ok(Math.abs(result.cost - 0.9) < 1e-12);
});

test("keep-warm examples: No cache is the input price, not the cache write price", () => {
    assert.equal(estimate(0, uncapped).uncached, 0.6);
    assert.equal(estimate(0, uncapped).refreshes, 0);
    assert.equal(estimate(0, uncapped).cost, 0);
    assert.equal(estimate(0, uncapped).lasts, 0);
});

test("keep-warm examples: the cost cap limits both Break-even and fixed hours", () => {
    for (const hours of ["break-even", 8] as const) {
        const result = estimate(hours, { ...uncapped, maxCost: 0.1 });

        assert.equal(result.refreshes, 3);
        assert.equal(result.cost, 0.09);
        assert.ok(result.cost <= 0.1);
        assert.equal(estimate(hours, { ...uncapped, maxCost: 0.02 }).refreshes, 0);
        assert.equal(estimate(hours, { ...uncapped, maxRefreshes: 2 }).refreshes, 2);
    }
});

test("keep-warm examples: Sol's write is Pi's listed $2.50, with an exact millisecond interval", () => {
    const sol = { input: 2, read: 0.1, writeMultiplier: 1.25, cacheMinutes: 30 };
    const result = estimate("break-even", uncapped, sol);

    assert.equal(result.refreshes, 24, "as the server's Break-even for Sol");
    assert.equal(result.uncached, 0.3);
    assert.equal(result.everyMs, 22.5 * 60_000);
    assert.equal(result.lasts, 24 * 22.5 * 60_000);
    assert.equal(estimate(0.5, uncapped).refreshes, 0);
    assert.equal(estimate(1, uncapped, sol).refreshes, 2);
    assert.equal(
        estimate("break-even", { ...uncapped, share: 95 }, { ...sol, cacheMinutes: 1 }).everyMs,
        50_000,
    );
});

test("keep-warm examples: Claude's 5-minute cache stops at 24 refreshes, every 3 min 45 s", () => {
    const fiveMinutes = { input: 4, read: 0.2, writeMultiplier: 1.25, cacheMinutes: 5 };
    const result = estimate("break-even", uncapped, fiveMinutes);

    assert.equal(result.everyMs, 225_000);
    assert.equal(result.refreshes, 24);
    assert.equal(result.lasts, 24 * 225_000);
    assert.ok(Math.abs(result.cost - 0.72) < 1e-12);
});
