// The server's clock as a tab knows it (web/clock.js): a hello handled late does not move the times the tab shows.
import assert from "node:assert/strict";
import { test } from "node:test";

type Moment = { wall: number; steady: number };
const { fitClock } = (await import(new URL("../web/clock.js", import.meta.url).href)) as {
    fitClock: (kept: number | undefined, now: number, handled: Moment, asked?: Moment) => number;
};

const MINUTE = 60_000;
/** A moment whose browser clock reads `wall`, and whose steady clock reads `steady` (by default the same). */
const at = (wall: number, steady = wall): Moment => ({ wall, steady });
/** The moment the browser shows for a fixed server time with an offset (`seen.js` `fromServer`). */
const shown = (offset: number) => 1_000_000_000_000 - offset;

test("a first hello it asked for sets the offset between what the request proves", () => {
    // The browser is 5 minutes behind the server; the hello took 200 ms there and back.
    assert.equal(fitClock(undefined, 2_100 + 5 * MINUTE, at(2_200), at(2_000)), 5 * MINUTE);
});

test("a hello handled 3 minutes late does not move the times shown", () => {
    // Same clocks: the first hello answers quickly.
    const first = fitClock(undefined, 10_050, at(10_100), at(10_000));
    const before = shown(first);
    // The server sends a hello of itself at 15:42; the tab sleeps and handles it at 15:45.
    const now = 20 * MINUTE;
    const late = fitClock(first, now, at(now + 3 * MINUTE), undefined);

    assert.equal(late, first);
    assert.equal(shown(late), before);
    // A new connection's first hello, handled late as the tab wakes, moves nothing either.
    assert.equal(fitClock(first, now, at(now + 3 * MINUTE), at(now - 10)), first);
    // Nor when the steady clock stopped while the device slept: the clocks part, so the request bounds nothing.
    assert.equal(
        fitClock(first, now, at(now + 3 * MINUTE, now + 100), at(now - 10, now - 10)),
        first,
    );
});

test("a device clock that changes between hellos is followed", () => {
    const first = fitClock(undefined, 10_050, at(10_100), at(10_000));
    // The browser's clock goes back 2 minutes: any hello proves the server is further ahead now.
    const back = fitClock(first, 30_000, at(30_000 - 2 * MINUTE + 10), undefined);

    assert.ok(Math.abs(back - 2 * MINUTE) < 100);

    // It goes forward 4 minutes: the next hello it asks for proves the server is 2 minutes behind.
    const asked = 40_000 + 2 * MINUTE;
    const forward = fitClock(back, 40_020, at(asked + 40), at(asked));

    assert.ok(forward <= -2 * MINUTE + 20 && forward >= -2 * MINUTE - 40);
});

test("a device clock that changes while it asks does not bound the offset wrongly", () => {
    // It asks at 100 s; its clock goes back 2 minutes; the server answers at 100.05 s; it handles that 100 ms in.
    const back = fitClock(0, 100_050, at(100_100 - 2 * MINUTE, 100_100), at(100_000));

    assert.ok(back >= 2 * MINUTE - 50 && back <= 2 * MINUTE + 50, `${back}`);

    // Its clock goes forward 2 minutes instead: the request bounds nothing, and the old offset stays.
    assert.equal(fitClock(0, 100_050, at(100_100 + 2 * MINUTE, 100_100), at(100_000)), 0);
    // A first hello then takes what the server's clock surely proves.
    assert.equal(
        fitClock(undefined, 100_050, at(100_100 + 2 * MINUTE, 100_100), at(100_000)),
        -50 - 2 * MINUTE,
    );
});

test("without a request to bound it, a first hello still counts", () => {
    assert.equal(fitClock(undefined, 5_000, at(4_000), undefined), 1_000);
});
