import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRepeat, describeRepeat, nextRepeat, parseWhen } from "../src/server/when.ts";
import type { Repeat } from "../src/server/when.ts";

const york = "America/New_York";
/** Friday, October 9, 2026, 16:00 in New York (20:00 UTC). */
const friday = Date.UTC(2026, 9, 9, 20, 0);
const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: york,
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
});

function runs(every: Repeat, after: number, count: number): string {
    const times: string[] = [];

    for (let at = after; times.length < count; times.push(clock.format(at).replace(",", ""))) {
        at = nextRepeat(every, at, york);
    }

    return times.join(", ");
}

test("a window reads as people write it or as the editor sends it, and a bad one is refused", () => {
    const parsed = parseWhen("every 30m between 9:00 and 5pm on weekdays check it", friday, york);
    const weekdays = { minutes: 30, window: { from: "09:00", to: "17:00", days: [1, 2, 3, 4, 5] } };

    assert.deepEqual(parsed.every, weekdays);
    assert.equal(parsed.rest, "check it");
    // "between" with no time after it is a message, as before windows.
    assert.equal(parseWhen("every 30m between us", friday, york).rest, "between us");
    assert.equal(parseWhen("every day 8:00 between us", friday, york).rest, "between us");
    assert.equal(describeRepeat(weekdays), "every 30 minutes, 09:00 to 17:00 on weekdays");
    assert.deepEqual(
        checkRepeat({ minutes: 30, window: { from: "9:00", to: "17:00", days: [5, 1, 2, 3, 4] } }),
        weekdays,
    );

    for (const [text, error] of [
        ["every 30m between 9:00 17:00 x", /Say a window as/],
        ["every 30m between 9:00 and 9:00 x", /end at another time/],
        ["every 30m between 9:00 and 17:00 on someday x", /window's days/],
        ["every day 8:00 between 9:00 and 17:00 x", /Only a repeat every so many minutes/],
    ] as const) {
        assert.throws(() => parseWhen(text, friday, york), error);
    }

    for (const window of [{ from: "9:00", to: "9:00" }, { from: "25:00", to: "9:00" }, "9-17"]) {
        assert.throws(() => checkRepeat({ minutes: 30, window }));
    }

    assert.throws(() =>
        checkRepeat({ minutes: 30, window: { from: "9:00", to: "5:00", days: [] } }),
    );
    assert.throws(() => checkRepeat({ at: "08:00", window: { from: "9:00", to: "17:00" } }));
});

test("a window runs from its start, every so often, before its end, across midnight and DST", () => {
    const weekdays = parseWhen("every 30m between 9:00 and 17:00 on weekdays x", friday, york);
    const fridays: Repeat = { minutes: 60, window: { from: "22:00", to: "02:00", days: [5] } };

    assert.equal(runs(weekdays.every!, friday, 3), "Fri 16:30, Mon 09:00, Mon 09:30");
    // Longer than its window: once a day, at the start.
    assert.equal(
        runs({ minutes: 180, window: { from: "09:00", to: "10:00" } }, friday, 2),
        "Sat 09:00, Sun 09:00",
    );
    assert.equal(runs(fridays, friday, 5), "Fri 22:00, Fri 23:00, Sat 00:00, Sat 01:00, Fri 22:00");
    // Saturday 00:30 is inside Friday's window.
    assert.equal(runs(fridays, Date.UTC(2026, 9, 10, 4, 30), 1), "Sat 01:00");
    // November 1, 2026: at 2:00 the clocks go back to 1:00, so the night's window has a run more.
    assert.equal(
        runs({ minutes: 60, window: { from: "23:00", to: "03:00" } }, Date.UTC(2026, 9, 31, 20), 6),
        "Sat 23:00, Sun 00:00, Sun 01:00, Sun 01:00, Sun 02:00, Sun 23:00",
    );
});
