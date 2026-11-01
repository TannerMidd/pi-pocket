// Whether an activity group opens (web/activity-fold.js): Appearance's Keep activity folded keeps groups on their one
// line while they run and in the newest turn, until someone opens one; off, the newest turn's groups open as they did.
import assert from "node:assert/strict";
import { test } from "node:test";

type Lone = { partial?: boolean; streaming?: boolean; text?: string };
type Options = {
    chosen?: boolean;
    lone?: Lone | null;
    live?: boolean;
    newest?: boolean;
    reading?: boolean;
    fold?: boolean;
};

const { activityOpen } = (await import(
    new URL("../web/activity-fold.js", import.meta.url).href
)) as { activityOpen: (options: Options) => boolean };

test("with folding on, a live group in the newest turn stays folded until opened", () => {
    const live = { live: true, newest: true, fold: true };

    assert.equal(activityOpen(live), false);
    // A click, or a jump to one of its answers, opens it.
    assert.equal(activityOpen({ ...live, chosen: true }), true);
    // A click that closed it keeps it closed, even with folding off.
    assert.equal(activityOpen({ ...live, fold: false, chosen: false }), false);
});

test("with folding off, the newest turn's groups open as before", () => {
    assert.equal(activityOpen({ live: true, newest: false, fold: false }), true);
    assert.equal(activityOpen({ live: false, newest: true, fold: false }), true);
    assert.equal(activityOpen({ live: false, newest: false, fold: false }), false);
});

test("a lone thought keeps its Show thinking rule, with folding on or off", () => {
    const thought = { streaming: false, text: "hmm" };

    for (const fold of [true, false]) {
        assert.equal(activityOpen({ lone: thought, reading: true, fold }), true);
        assert.equal(activityOpen({ lone: thought, reading: false, fold }), false);
        assert.equal(
            activityOpen({ lone: { ...thought, partial: true }, reading: true, fold }),
            false,
        );
    }
});
