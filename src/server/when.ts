/**
 * When a scheduled message goes out, in the words people type: `in 30m`, `7:00`, `tomorrow 9am`, `fri 17:30`,
 * `every 2h`, `every day 8:00`, `every weekday 8:00`, `every mon,thu 9:00`. Clock times are wall-clock times in a time
 * zone, so `every day 8:00` stays at 8:00 across daylight saving changes.
 */

/** How often a schedule may repeat, at most: a runaway loop of model calls costs money. */
const MIN_INTERVAL_MINUTES = 10;
/** How far ahead a one-time message may go. */
const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;

/** A repeat: every so many minutes, or at a clock time on some days of the week (0 Sunday … 6 Saturday; all when absent). */
export type Repeat = { minutes: number } | { at: string; days?: number[] };

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

/** The wall clock in `zone` at a moment: its date, time, and day of the week. */
function wallClock(at: number, zone: string) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        weekday: "short",
    }).formatToParts(new Date(at));
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

/** The next time a repeat goes out after `after`. */
export function nextRepeat(repeat: Repeat, after: number, zone: string): number {
    return "minutes" in repeat
        ? after + repeat.minutes * 60_000
        : nextClockTime(after, repeat.at, repeat.days, zone);
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
    "Say when: in 30m, 7:00, 7pm, tomorrow 9:00, fri 17:30, or every 2h, every day 8:00, every weekday 8:00, every mon,thu 9:00.";

/**
 * Read when a message goes out from the start of `text`, and what the rest says. Throws with a short explanation
 * when the start is not a time this understands.
 */
export function parseWhen(text: string, now: number, zone: string): When & { rest: string } {
    const words = text.trim().split(/\s+/);
    const lower = words.map((word) => word.toLowerCase());
    const rest = (used: number) => words.slice(used).join(" ");

    if (lower[0] === "every") {
        const interval = duration(lower.slice(1));

        if (interval !== undefined) {
            if (interval.minutes < MIN_INTERVAL_MINUTES) {
                throw new Error(
                    `A schedule can repeat at most every ${MIN_INTERVAL_MINUTES} minutes.`,
                );
            }

            // "every 2 days 8:00" would repeat every two days from now, with "8:00" in the message.
            const next = lower[1 + interval.used] ?? "";

            if (next === "at" || clockTime(next) !== undefined) {
                throw new Error(
                    "Repeat after a time (every 2 days) or at a clock time (every day 8:00), not both.",
                );
            }

            const every = { minutes: interval.minutes };

            return { next: nextRepeat(every, now, zone), every, rest: rest(1 + interval.used) };
        }

        const days = dayList(lower[1] ?? "");
        const at = clockTime(lower[days === undefined ? 1 : 2] ?? "");

        if (at === undefined) {
            throw new Error(WHEN_HELP);
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

        if (next - now > MAX_AHEAD_MS) {
            throw new Error("A message can be scheduled up to a year ahead.");
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

/** A repeat in words, as the schedule list shows it: "every 2 hours", "weekdays at 08:00". */
export function describeRepeat(repeat: Repeat): string {
    if ("minutes" in repeat) {
        const { minutes } = repeat;

        if (minutes % 1440 === 0) {
            return minutes === 1440 ? "every day" : `every ${minutes / 1440} days`;
        }

        if (minutes % 60 === 0) {
            return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
        }

        return `every ${minutes} minutes`;
    }

    const days = repeat.days;

    if (days === undefined) {
        return `every day at ${repeat.at}`;
    }

    if (days.join() === WEEKDAYS.join()) {
        return `weekdays at ${repeat.at}`;
    }

    if (days.join() === "0,6") {
        return `weekends at ${repeat.at}`;
    }

    return `${days.map((day) => DAY_NAMES[day]).join(", ")} at ${repeat.at}`;
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
