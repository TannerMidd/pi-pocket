/**
 * When a scheduled message goes out, in the words people type: `in 30m`, `7:00`, `tomorrow 9am`, `fri 17:30`,
 * `every 2h`, `every day 8:00`, `every weekday 8:00`, `every mon,thu 9:00`, `every 30m between 9:00 and 17:00 on weekdays`.
 * Clock times are wall-clock times in a time zone, so `every day 8:00` stays at 8:00 across daylight saving changes.
 */

/** How often a schedule may repeat, at most: a runaway loop of model calls costs money. */
const MIN_INTERVAL_MINUTES = 10;
/** How far ahead a one-time message may go. */
const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;
/** The longest repeat, in minutes: longer ones would go past what a date can hold. */
const MAX_INTERVAL_MINUTES = 366 * 1440;
const TOO_LONG = "A schedule must repeat at least once in 366 days.";

/** What `parseWhen` accepts; the defaults are the constants above. */
export type WhenLimits = {
    /** The shortest repeat, in minutes. */
    repeatMinutes?: number;
    /** How far ahead `in …` may go, in milliseconds. */
    aheadMs?: number;
};

/**
 * The hours a repeat every so many minutes runs in (since 0.29.0): from `from` (`HH:MM`) to `to`, on the days a window
 * opens (0 Sunday … 6 Saturday; all when absent). A `to` at or before `from` ends on the next day.
 */
export type RepeatWindow = { from: string; to: string; days?: number[] };

/** A repeat: every so many minutes, maybe only in a window, or at a clock time on some days of the week (all when absent). */
export type Repeat = { minutes: number; window?: RepeatWindow } | { at: string; days?: number[] };

export type When = { next: number; every?: Repeat };

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const UNITS: Record<string, number> = {
    m: 1,
    min: 1,
    mins: 1,
    minute: 1,
    minutes: 1,
    h: 60,
    hr: 60,
    hrs: 60,
    hour: 60,
    hours: 60,
    d: 1440,
    day: 1440,
    days: 1440,
};

/** Whether a time zone name is one this system knows. */
export function knownZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });

        return true;
    } catch {
        return false;
    }
}

/** One formatter per zone: making one costs far more than using it, and a repeat's next times use it hundreds of times. */
const clocks = new Map<string, Intl.DateTimeFormat>();

function clockIn(zone: string): Intl.DateTimeFormat {
    let format = clocks.get(zone);

    if (format === undefined) {
        format = new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            hourCycle: "h23",
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
            weekday: "short",
        });
        clocks.set(zone, format);
    }

    return format;
}

/** The wall clock in `zone` at a moment: its date, time, and day of the week. */
function wallClock(at: number, zone: string) {
    const parts = clockIn(zone).formatToParts(new Date(at));
    const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";

    return {
        year: Number(part("year")),
        month: Number(part("month")),
        day: Number(part("day")),
        hour: Number(part("hour")),
        minute: Number(part("minute")),
        second: Number(part("second")),
        weekday: DAY_NAMES.indexOf(part("weekday").toLowerCase().slice(0, 3)),
    };
}

/** The zone's offset from UTC at a moment: its wall clock minus UTC. */
function offsetAt(moment: number, zone: string): number {
    const clock = wallClock(moment, zone);

    return (
        Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) -
        Math.floor(moment / 1000) * 1000
    );
}

const HALF_DAY_MS = 12 * 60 * 60_000;

/**
 * The moment the wall clock in `zone` shows a date and time (days past the month's end roll over). A time that
 * happens twice, when clocks go back, is the first one; a time skipped when clocks go forward is the moment after
 * the gap, so 2:30 on that night is 3:30.
 */
export function zonedMoment(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    zone: string,
): number {
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    // The zone's offsets half a day before and after: the same, unless a daylight saving change is near.
    const candidates = [
        wanted - offsetAt(wanted - HALF_DAY_MS, zone),
        wanted - offsetAt(wanted + HALF_DAY_MS, zone),
    ].sort((a, b) => a - b);

    const shows = (moment: number) => {
        const clock = wallClock(moment, zone);

        return (
            Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute) === wanted
        );
    };

    return candidates.find(shows) ?? candidates[1]!;
}

/** The first moment after `after` when the wall clock in `zone` shows `at` (HH:MM) on one of `days`. */
export function nextClockTime(
    after: number,
    at: string,
    days: readonly number[] | undefined,
    zone: string,
): number {
    const [hour = 0, minute = 0] = at.split(":").map(Number);
    const today = wallClock(after, zone);

    // Eight days ahead always reaches the next matching weekday, even when today's time has passed.
    for (let ahead = 0; ahead <= 8; ahead++) {
        const moment = zonedMoment(today.year, today.month, today.day + ahead, hour, minute, zone);

        if (
            moment > after &&
            (days === undefined || days.includes(wallClock(moment, zone).weekday))
        ) {
            return moment;
        }
    }

    throw new Error(`No time matches ${at}`);
}

/**
 * When a window that opens on a wall-clock day (days past the month's end roll over) opens and closes; undefined on a
 * day it stays shut.
 */
function windowOn(
    window: RepeatWindow,
    year: number,
    month: number,
    day: number,
    zone: string,
): { start: number; end: number } | undefined {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

    if (window.days !== undefined && !window.days.includes(weekday)) {
        return undefined;
    }

    const [fromHour = 0, fromMinute = 0] = window.from.split(":").map(Number);
    const [toHour = 0, toMinute = 0] = window.to.split(":").map(Number);
    const overnight = window.to <= window.from;

    return {
        start: zonedMoment(year, month, day, fromHour, fromMinute, zone),
        end: zonedMoment(year, month, day + (overnight ? 1 : 0), toHour, toMinute, zone),
    };
}

/**
 * The first run of a windowed repeat after `after`: at the window's start, then every `minutes` while before its end.
 * The start and the end are wall-clock times; the runs between are `minutes` of real time apart, so a window that holds
 * a daylight saving change is an hour shorter or longer and has a run less or more.
 */
function nextInWindow(minutes: number, window: RepeatWindow, after: number, zone: string): number {
    const today = wallClock(after, zone);
    const step = minutes * 60_000;
    let best: number | undefined;

    // From yesterday, whose window may run into today, to eight days ahead, which always reaches an open day.
    for (let ahead = -1; ahead <= 8; ahead++) {
        const open = windowOn(window, today.year, today.month, today.day + ahead, zone);

        if (open === undefined) {
            continue;
        }

        if (best !== undefined && open.start >= best) {
            break;
        }

        const run =
            open.start > after
                ? open.start
                : open.start + (Math.floor((after - open.start) / step) + 1) * step;

        if (run < open.end && (best === undefined || run < best)) {
            best = run;
        }
    }

    if (best === undefined) {
        throw new Error(`No time matches ${window.from} to ${window.to}`);
    }

    return best;
}

/** Whether a repeat has a window that is shut at `at`: a run due earlier, sent late, then waits for its next run. */
export function outsideWindow(repeat: Repeat, at: number, zone: string): boolean {
    if (!("minutes" in repeat) || repeat.window === undefined) {
        return false;
    }

    const window = repeat.window;
    const today = wallClock(at, zone);

    return ![-1, 0].some((ahead) => {
        const open = windowOn(window, today.year, today.month, today.day + ahead, zone);

        return open !== undefined && at >= open.start && at < open.end;
    });
}

/** The next time a repeat goes out after `after`. */
export function nextRepeat(repeat: Repeat, after: number, zone: string): number {
    if ("minutes" in repeat) {
        return repeat.window === undefined
            ? after + repeat.minutes * 60_000
            : nextInWindow(repeat.minutes, repeat.window, after, zone);
    }

    return nextClockTime(after, repeat.at, repeat.days, zone);
}

/** `7`, `7:30`, `19:05`, `7pm`, `7:30am` as `HH:MM`; undefined for anything else. */
function clockTime(word: string): string | undefined {
    const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(word);

    if (match === null || (match[2] === undefined && match[3] === undefined)) {
        return undefined;
    }

    let hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);

    if (match[3] !== undefined) {
        if (hour < 1 || hour > 12) {
            return undefined;
        }

        hour = (hour % 12) + (match[3] === "pm" ? 12 : 0);
    }

    if (hour > 23 || minute > 59) {
        return undefined;
    }

    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const FULL_DAY_NAMES = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

/** `mon`, `tues`, `friday`: a day of the week (0 Sunday … 6 Saturday) from its first three letters on; -1 otherwise. */
function dayOfWeek(name: string): number {
    return name.length < 3 ? -1 : FULL_DAY_NAMES.findIndex((day) => day.startsWith(name));
}

/** `mon`, `mon,wed,fri`, `weekday(s)`, `weekend(s)` as days of the week, `day` or `daily` as every day; else undefined. */
function dayList(word: string): number[] | "every" | undefined {
    if (word === "day" || word === "daily") {
        return "every";
    }

    if (word === "weekday" || word === "weekdays") {
        return WEEKDAYS;
    }

    if (word === "weekend" || word === "weekends") {
        return [0, 6];
    }

    const days = word.split(",").map(dayOfWeek);

    return days.every((day) => day !== -1) ? [...new Set(days)].sort((a, b) => a - b) : undefined;
}

/** `30m`, `1.5h`, `2 hours`, … as whole minutes (one at least), taking one or two words; undefined for anything else. */
function duration(words: readonly string[]): { minutes: number; used: number } | undefined {
    const joined = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(words[0] ?? "");
    const [amount, unit, used] =
        joined !== null ? [joined[1], joined[2], 1] : [words[0], words[1], 2];
    const minutes = Math.round(Number(amount) * (UNITS[unit ?? ""] ?? Number.NaN));

    return Number.isFinite(minutes) && minutes >= 1 ? { minutes, used } : undefined;
}

export const WHEN_HELP =
    "Say when: in 30m, 7:00, 7pm, tomorrow 9:00, fri 17:30, or every 2h, every day 8:00, every weekday 8:00, every mon,thu 9:00, every 30m between 9:00 and 17:00 on weekdays.";

const WINDOW_HELP = "Say a window as: every 30m between 9:00 and 17:00, and maybe on weekdays.";
const SAME_ENDS = "A window must end at another time than it starts.";

/** `between 9:00 and 17:00`, maybe `on weekdays`, at the start of `words`: the window, and how many words it took. */
function windowOf(words: readonly string[]): { window: RepeatWindow; used: number } {
    const from = clockTime(words[1] ?? "");
    const to = clockTime(words[3] ?? "");

    if (from === undefined || words[2] !== "and" || to === undefined) {
        throw new Error(WINDOW_HELP);
    }

    if (from === to) {
        throw new Error(SAME_ENDS);
    }

    if (words[4] !== "on") {
        return { window: { from, to }, used: 4 };
    }

    const days = dayList(words[5] ?? "");

    if (days === undefined) {
        throw new Error("Say the window's days as weekdays, weekends, mon,wed, or day.");
    }

    return { window: days === "every" ? { from, to } : { from, to, days }, used: 6 };
}

/** A span of time for a message: `a year` for the default, else days. */
function aheadText(ms: number): string {
    if (ms === MAX_AHEAD_MS) {
        return "a year";
    }

    const days = Math.floor(ms / (24 * 60 * 60_000));

    return days === 1 ? "1 day" : `${days} days`;
}

/**
 * Read when a message goes out from the start of `text`, and what the rest says. Throws with a short explanation
 * when the start is not a time this understands.
 */
export function parseWhen(
    text: string,
    now: number,
    zone: string,
    limits: WhenLimits = {},
): When & { rest: string } {
    const repeatMinutes = limits.repeatMinutes ?? MIN_INTERVAL_MINUTES;
    const aheadMs = limits.aheadMs ?? MAX_AHEAD_MS;
    const words = text.trim().split(/\s+/);
    const lower = words.map((word) => word.toLowerCase());
    const rest = (used: number) => words.slice(used).join(" ");

    if (lower[0] === "every") {
        const interval = duration(lower.slice(1));

        if (interval !== undefined) {
            if (interval.minutes < repeatMinutes) {
                throw new Error(
                    `A schedule can repeat at most every ${repeatMinutes} ${repeatMinutes === 1 ? "minute" : "minutes"}.`,
                );
            }

            if (interval.minutes > MAX_INTERVAL_MINUTES) {
                throw new Error(TOO_LONG);
            }

            // "every 2 days 8:00" would repeat every two days from now, with "8:00" in the message.
            const next = lower[1 + interval.used] ?? "";

            if (next === "at" || clockTime(next) !== undefined) {
                throw new Error(
                    "Repeat after a time (every 2 days) or at a clock time (every day 8:00), not both.",
                );
            }

            const window =
                // `every 30m between us` is a message, as before windows.
                next === "between" && /^\d/.test(lower[2 + interval.used] ?? "")
                    ? windowOf(lower.slice(1 + interval.used))
                    : undefined;
            const every: Repeat =
                window === undefined
                    ? { minutes: interval.minutes }
                    : { minutes: interval.minutes, window: window.window };

            return {
                next: nextRepeat(every, now, zone),
                every,
                rest: rest(1 + interval.used + (window?.used ?? 0)),
            };
        }

        const days = dayList(lower[1] ?? "");
        const at = clockTime(lower[days === undefined ? 1 : 2] ?? "");

        if (at === undefined) {
            throw new Error(WHEN_HELP);
        }

        if (
            lower[days === undefined ? 2 : 3] === "between" &&
            /^\d/.test(lower[days === undefined ? 3 : 4] ?? "")
        ) {
            throw new Error(
                "Only a repeat every so many minutes has a window: every 30m between 9:00 and 17:00.",
            );
        }

        const every: Repeat = days === undefined || days === "every" ? { at } : { at, days };

        return {
            next: nextRepeat(every, now, zone),
            every,
            rest: rest(days === undefined ? 2 : 3),
        };
    }

    if (lower[0] === "in") {
        const delay = duration(lower.slice(1));

        if (delay === undefined) {
            throw new Error(WHEN_HELP);
        }

        const next = now + delay.minutes * 60_000;

        if (next - now > aheadMs) {
            throw new Error(`A message can be scheduled up to ${aheadText(aheadMs)} ahead.`);
        }

        return { next, rest: rest(1 + delay.used) };
    }

    if (lower[0] === "today" || lower[0] === "tomorrow") {
        const at = clockTime(lower[1] ?? "");

        if (at === undefined) {
            throw new Error(WHEN_HELP);
        }

        const clock = wallClock(now, zone);
        const [hour = 0, minute = 0] = at.split(":").map(Number);
        const next = zonedMoment(
            clock.year,
            clock.month,
            clock.day + (lower[0] === "tomorrow" ? 1 : 0),
            hour,
            minute,
            zone,
        );

        if (next <= now) {
            throw new Error(`${at} today has passed.`);
        }

        return { next, rest: rest(2) };
    }

    const day = dayList(lower[0] ?? "");

    if (Array.isArray(day) && day.length === 1) {
        const at = clockTime(lower[1] ?? "");

        if (at === undefined) {
            throw new Error(WHEN_HELP);
        }

        return { next: nextClockTime(now, at, day, zone), rest: rest(2) };
    }

    const at = clockTime(lower[0] ?? "");

    if (at === undefined) {
        throw new Error(WHEN_HELP);
    }

    return { next: nextClockTime(now, at, undefined, zone), rest: rest(1) };
}

/**
 * A repeat given as data (the Schedules sheet's editor), checked: whole minutes no shorter than the shortest repeat, or
 * a clock time (`HH:MM`) on some days of the week. Throws with a short explanation otherwise.
 */
export function checkRepeat(given: unknown, limits: WhenLimits = {}): Repeat {
    const repeatMinutes = limits.repeatMinutes ?? MIN_INTERVAL_MINUTES;
    const value = (typeof given === "object" && given !== null ? given : {}) as Record<
        string,
        unknown
    >;

    if ("minutes" in value) {
        const minutes = value.minutes;

        if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1) {
            throw new Error("A repeat needs a whole number of minutes.");
        }

        if (minutes < repeatMinutes) {
            throw new Error(
                `A schedule can repeat at most every ${repeatMinutes} ${repeatMinutes === 1 ? "minute" : "minutes"}.`,
            );
        }

        if (minutes > MAX_INTERVAL_MINUTES) {
            throw new Error(TOO_LONG);
        }

        return value.window === undefined || value.window === null
            ? { minutes }
            : { minutes, window: checkWindow(value.window) };
    }

    if (value.window !== undefined && value.window !== null) {
        throw new Error("Only a repeat every so many minutes has a window.");
    }

    const at = givenTime(value.at);

    if (at === undefined) {
        throw new Error("A repeat needs a time of day, such as 08:00.");
    }

    const days =
        value.days === undefined
            ? undefined
            : givenDays(value.days, "Pick at least one day for the repeat.");

    return days === undefined ? { at } : { at, days };
}

/** `HH:MM` given as data, as `HH:MM`; undefined for anything else. */
function givenTime(given: unknown): string | undefined {
    return typeof given === "string" && /^\d{1,2}:\d{2}$/.test(given)
        ? clockTime(given)
        : undefined;
}

/** Days of the week given as data: at least one, sorted, without repeats; undefined for all seven. */
function givenDays(days: unknown, problem: string): number[] | undefined {
    if (
        !Array.isArray(days) ||
        days.length === 0 ||
        !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    ) {
        throw new Error(problem);
    }

    const sorted = [...new Set(days as number[])].sort((a, b) => a - b);

    return sorted.length === 7 ? undefined : sorted;
}

/** A repeat's window given as data, checked: two different times of day, and maybe some days. */
function checkWindow(given: unknown): RepeatWindow {
    const value = (typeof given === "object" && given !== null ? given : {}) as Record<
        string,
        unknown
    >;
    const from = givenTime(value.from);
    const to = givenTime(value.to);

    if (from === undefined || to === undefined) {
        throw new Error("A window needs a start and an end time, such as 09:00 and 17:00.");
    }

    if (from === to) {
        throw new Error(SAME_ENDS);
    }

    const days =
        value.days === undefined ? undefined : givenDays(value.days, "Pick at least one day.");

    return days === undefined ? { from, to } : { from, to, days };
}

/** A one-time moment given as data, checked: in the future, and no further ahead than allowed. */
export function checkMoment(given: unknown, now: number, limits: WhenLimits = {}): number {
    const aheadMs = limits.aheadMs ?? MAX_AHEAD_MS;

    if (typeof given !== "number" || !Number.isFinite(given)) {
        throw new Error("Say when it goes out.");
    }

    if (given <= now) {
        throw new Error("That time has passed.");
    }

    if (given - now > aheadMs) {
        throw new Error(`A message can be scheduled up to ${aheadText(aheadMs)} ahead.`);
    }

    return Math.round(given);
}

/** Some days of the week in words: "weekdays", "weekends", "mon, thu". */
function daysText(days: readonly number[]): string {
    if (days.join() === WEEKDAYS.join()) {
        return "weekdays";
    }

    if (days.join() === "0,6") {
        return "weekends";
    }

    return days.map((day) => DAY_NAMES[day]).join(", ");
}

/** A repeat every so many minutes in words: "every 2 hours". */
function intervalText(minutes: number): string {
    if (minutes % 1440 === 0) {
        return minutes === 1440 ? "every day" : `every ${minutes / 1440} days`;
    }

    if (minutes % 60 === 0) {
        return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
    }

    return `every ${minutes} minutes`;
}

/**
 * A repeat in words, as the schedule list shows it: "every 2 hours", "every 30 minutes, 09:00 to 17:00 on weekdays",
 * "weekdays at 08:00".
 */
export function describeRepeat(repeat: Repeat): string {
    if ("minutes" in repeat) {
        const window = repeat.window;

        return window === undefined
            ? intervalText(repeat.minutes)
            : `${intervalText(repeat.minutes)}, ${window.from} to ${window.to}${window.days === undefined ? "" : ` on ${daysText(window.days)}`}`;
    }

    return repeat.days === undefined
        ? `every day at ${repeat.at}`
        : `${daysText(repeat.days)} at ${repeat.at}`;
}

/** A moment as people read it in `zone`: "Mon 07:00" within the week ahead, "Oct 12 07:00" after that. */
export function describeMoment(at: number, zone: string, now = Date.now()): string {
    const soon = at - now < 6 * 24 * 60 * 60_000;

    return new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
        ...(soon ? { weekday: "short" } : { month: "short", day: "numeric" }),
    })
        .format(new Date(at))
        .replace(",", "");
}
