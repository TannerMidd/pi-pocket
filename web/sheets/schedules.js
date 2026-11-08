// Scheduled messages of this session: what is coming, and an editor to set one up or change it.
import { useEffect, useMemo, useState } from "preact/hooks";
import { actions, attempt, canSteer, closeSheet, openSheet, store } from "../store.js";
import { countdown, formatWhen, html, Icon, Sheet, useSecond } from "../ui.js";

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKENDS = [0, 6];
const UNITS = { minutes: 1, hours: 60, days: 1440 };
const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const pad = (number) => String(number).padStart(2, "0");

/** A moment as a date field's value, on this device's clock: `2026-11-08`. */
const dateValue = (ms) => {
    const at = new Date(ms);

    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

/** A moment as a time field's value, on this device's clock: `09:30`. */
const timeValue = (ms) => {
    const at = new Date(ms);

    return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

/** The moment a date and a time field show together, on this device's clock; NaN while either is empty. */
const fromFields = (date, time) =>
    date === "" || time === "" ? Number.NaN : new Date(`${date}T${time}`).getTime();

/** The next moment after `now` this device's clock shows `at` on one of `days`: the preview of a repeat. */
function nextClock(at, days, now) {
    const [hour, minute] = at.split(":").map(Number);

    for (let ahead = 0; ahead <= 8; ahead++) {
        const day = new Date(now);

        day.setDate(day.getDate() + ahead);
        day.setHours(hour, minute, 0, 0);

        if (day.getTime() > now && days.includes(day.getDay())) {
            return day.getTime();
        }
    }

    return Number.NaN;
}

/** A while from now, rounded up to the next five minutes: where a new one-time message starts. */
const soon = () => Math.ceil((Date.now() + 60 * 60_000) / 300_000) * 300_000;

/** Days of the week in words: "Weekdays", "Mon, Wed, Fri". */
function daysText(days) {
    const list = days.join();

    if (list === EVERY_DAY.join()) {
        return "Every day";
    }

    if (list === WEEKDAYS.join()) {
        return "Weekdays";
    }

    if (list === WEEKENDS.join()) {
        return "Weekends";
    }

    return days.map((day) => DAY_NAMES[day].slice(0, 3)).join(", ");
}

/** What the editor starts from: a schedule's own fields, or a new one-time message an hour from now. */
function draftOf(schedule) {
    const every = schedule?.every;
    const next = schedule?.next ?? soon();
    const minutes = every !== undefined && "minutes" in every ? every.minutes : 60;
    const unit = minutes % 1440 === 0 ? "days" : minutes % 60 === 0 ? "hours" : "minutes";

    return {
        kind: every === undefined ? "once" : "minutes" in every ? "interval" : "days",
        text: schedule?.text ?? "",
        date: dateValue(next),
        time: timeValue(next),
        amount: String(minutes / UNITS[unit]),
        unit,
        at: every?.at ?? timeValue(next),
        days: every?.days ?? (every?.at === undefined ? WEEKDAYS : EVERY_DAY),
    };
}

/** When a draft goes out next, as the server will work it out (on this device's clock), and its repeat as data. */
function timing(draft, schedule, now) {
    if (draft.kind === "once") {
        // Fields left as they were keep the exact time: "in 30m" set one to the second, the fields show the minute.
        const same =
            schedule !== undefined &&
            schedule.every === undefined &&
            dateValue(schedule.next) === draft.date &&
            timeValue(schedule.next) === draft.time;
        const next = same ? schedule.next : fromFields(draft.date, draft.time);

        return { next, send: { next } };
    }

    if (draft.kind === "interval") {
        const minutes = Math.round(Number(draft.amount) * UNITS[draft.unit]);
        const every = { minutes };
        const old = schedule?.every;
        // The same interval keeps its next time; a new one starts counting now.
        const keeps = old !== undefined && old.minutes === minutes && schedule.next > now;
        const next = keeps ? schedule.next : now + minutes * 60_000;

        return { next, send: keeps ? { every, next } : { every } };
    }

    const every =
        draft.days.length === 7 ? { at: draft.at } : { at: draft.at, days: [...draft.days] };

    return { next: nextClock(draft.at, draft.days, now), send: { every } };
}

/** What is wrong with a draft before it goes to the server, in a few words; undefined when nothing is. */
function problem(draft, next, now) {
    if (draft.text.trim() === "") {
        return "Say what Pi should get.";
    }

    if (draft.kind === "once" && !(next > now)) {
        return Number.isNaN(next) ? "Pick a date and a time." : "That time has passed.";
    }

    if (draft.kind === "interval" && !(Number(draft.amount) > 0)) {
        return "Say how often.";
    }

    if (draft.kind === "days" && (draft.at === "" || draft.days.length === 0)) {
        return draft.at === "" ? "Pick a time of day." : "Pick at least one day.";
    }

    return undefined;
}

/** One schedule set up, or changed: its message, and when it goes out, once or on repeat. */
function ScheduleEditor({ schedule, onDone }) {
    const [draft, setDraft] = useState(() => draftOf(schedule));
    const [saving, setSaving] = useState(false);
    const now = useSecond(true);
    const set = (change) => setDraft((old) => ({ ...old, ...change }));
    const { next, send } = timing(draft, schedule, now);
    const wrong = problem(draft, next, now);
    // An empty message only keeps Save off: the preview shows a warning for the time alone, not before anything is typed.
    const timeWrong = problem({ ...draft, text: "-" }, next, now);
    const otherZone = schedule !== undefined && schedule.zone !== deviceZone();

    const save = () =>
        attempt(async () => {
            setSaving(true);

            try {
                const body = { text: draft.text.trim(), ...send };

                await (schedule === undefined
                    ? actions.addSchedule(body)
                    : actions.updateSchedule(schedule.id, body));
                onDone();
            } finally {
                setSaving(false);
            }
        });
    const remove = () =>
        attempt(async () => {
            await actions.cancelSchedule(schedule.id);
            onDone();
        });
    const quick = (ms) => set({ kind: "once", date: dateValue(ms), time: timeValue(ms) });

    const tomorrowNine = () => {
        const at = new Date();

        at.setDate(at.getDate() + 1);
        at.setHours(9, 0, 0, 0);

        return at.getTime();
    };

    const toggleDay = (day) =>
        set({
            days: draft.days.includes(day)
                ? draft.days.filter((each) => each !== day)
                : [...draft.days, day].sort((a, b) => a - b),
        });

    return html`<div class="sched-editor" data-part="schedule-editor">
        <label class="field">
            <span class="label">Message to Pi</span>
            <textarea
                rows="3"
                placeholder="Check the deploy and tell me if anything failed"
                value=${draft.text}
                autofocus
                onInput=${(event) => set({ text: event.currentTarget.value })}
            ></textarea>
        </label>
        <div class="field">
            <span class="label">When</span>
            <div class="segmented sched-kinds" role="tablist">
                ${[
                    ["once", "Once"],
                    ["days", "On days"],
                    ["interval", "Every…"],
                ].map(
                    ([kind, label]) => html`<button
                        role="tab"
                        aria-selected=${draft.kind === kind}
                        class=${draft.kind === kind ? "on" : ""}
                        onClick=${() => set({ kind })}
                    >
                        ${label}
                    </button>`,
                )}
            </div>
        </div>
        ${
            draft.kind === "once" &&
            html`<div class="sched-row">
                    <input
                        type="date"
                        aria-label="Date"
                        value=${draft.date}
                        min=${dateValue(now)}
                        onInput=${(event) => set({ date: event.currentTarget.value })}
                    />
                    <input
                        type="time"
                        aria-label="Time"
                        value=${draft.time}
                        onInput=${(event) => set({ time: event.currentTarget.value })}
                    />
                </div>
                <div class="sched-chips">
                    <button class="chip" onClick=${() => quick(Date.now() + 30 * 60_000)}>
                        in 30m
                    </button>
                    <button class="chip" onClick=${() => quick(Date.now() + 2 * 60 * 60_000)}>
                        in 2h
                    </button>
                    <button class="chip" onClick=${() => quick(tomorrowNine())}>
                        tomorrow 9:00
                    </button>
                </div>`
        }
        ${
            draft.kind === "days" &&
            html`<div class="sched-row">
                    <input
                        type="time"
                        aria-label="Time of day"
                        value=${draft.at}
                        onInput=${(event) => set({ at: event.currentTarget.value })}
                    />
                </div>
                <div class="sched-days" role="group" aria-label="Days">
                    ${DAY_LETTERS.map(
                        (letter, day) => html`<button
                            class=${`sched-day ${draft.days.includes(day) ? "on" : ""}`}
                            aria-pressed=${draft.days.includes(day)}
                            aria-label=${DAY_NAMES[day]}
                            title=${DAY_NAMES[day]}
                            onClick=${() => toggleDay(day)}
                        >
                            ${letter}
                        </button>`,
                    )}
                </div>
                <div class="sched-chips">
                    ${[
                        ["Every day", EVERY_DAY],
                        ["Weekdays", WEEKDAYS],
                        ["Weekends", WEEKENDS],
                    ].map(
                        ([label, days]) => html`<button
                            class=${`chip toggle ${draft.days.join() === days.join() ? "on" : ""}`}
                            onClick=${() => set({ days })}
                        >
                            ${label}
                        </button>`,
                    )}
                </div>`
        }
        ${
            draft.kind === "interval" &&
            html`<div class="sched-row">
                <span class="sched-word">Every</span>
                <input
                    type="number"
                    inputmode="numeric"
                    min="1"
                    step="1"
                    aria-label="How often"
                    class="sched-amount"
                    value=${draft.amount}
                    onInput=${(event) => set({ amount: event.currentTarget.value })}
                />
                <select
                    aria-label="Unit"
                    value=${draft.unit}
                    onChange=${(event) => set({ unit: event.currentTarget.value })}
                >
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                </select>
            </div>`
        }
        <div class=${`sched-preview ${timeWrong ? "wrong" : ""}`} data-part="schedule-preview">
            ${
                timeWrong ??
                html`<${Icon} name="clock" size=${13} />
                    <span>
                        ${draft.kind === "days" ? `${daysText(draft.days)} at ${draft.at} · ` : ""}
                        Next ${formatWhen(next)}
                    </span>
                    <span class="sched-countdown">in ${countdown(next, now)}</span>`
            }
        </div>
        ${
            otherZone &&
            html`<p class="muted small">
                Set in ${schedule.zone}. Saving uses this device's time zone, ${deviceZone()}.
            </p>`
        }
        <div class="sched-actions">
            ${
                schedule !== undefined &&
                html`<button class="button ghost danger" onClick=${remove}>Delete</button>`
            }
            <span class="grow"></span>
            <button class="button ghost" onClick=${onDone}>Cancel</button>
            <button
                class="button primary"
                disabled=${wrong !== undefined || saving}
                onClick=${save}
            >
                ${schedule === undefined ? "Schedule" : "Save"}
            </button>
        </div>
    </div>`;
}

/** One scheduled message in the list: its message, when it goes out, and a countdown; a tap edits it. */
function ScheduleRow({ schedule, now, setBy, archived, steer, onEdit }) {
    const repeat = schedule.repeat !== undefined;
    const due = schedule.next <= now;

    return html`<button
        class="sched-card"
        data-part="schedule"
        disabled=${!steer}
        onClick=${onEdit}
        aria-label=${`${schedule.text}, ${repeat ? schedule.repeat : formatWhen(schedule.next)}${steer ? ". Edit" : ""}`}
    >
        <span class=${`sched-mark ${repeat ? "repeat" : ""}`} aria-hidden="true">
            <${Icon} name=${repeat ? "reload" : "clock"} size=${14} />
        </span>
        <span class="sched-main">
            <span class="sched-text">${schedule.text}</span>
            <span class="sched-meta">
                ${repeat ? `${schedule.repeat} · next ${formatWhen(schedule.next)}` : formatWhen(schedule.next)}
                ${` · set by ${setBy(schedule.by)}`}
                ${repeat && schedule.runs > 0 ? ` · sent ${schedule.runs}×` : ""}
                ${archived ? " · session archived" : ""}
            </span>
        </span>
        <span class="sched-side">
            <span class="sched-countdown">
                ${due ? "due now" : `in ${countdown(schedule.next, now)}`}
            </span>
            ${steer && html`<span class="sched-edit">Edit</span>`}
        </span>
    </button>`;
}

/** Messages that go to Pi later or on repeat: what is coming, an editor to set one up or change one, and quick add. */
export function SchedulesSheet() {
    const { view, users, me } = store.state;
    const schedules = view.schedules ?? [];
    const [quickText, setQuickText] = useState("");
    // The schedule open in the editor: its id, "new", or none.
    const [editing, setEditing] = useState(null);
    const now = useSecond(schedules.length > 0);
    const steer = canSteer();
    const archived = store.state.sessions.some(
        (session) => session.id === store.state.conversationId && session.archived,
    );
    const setBy = (id) =>
        id === undefined
            ? "Pi"
            : id === me?.id
              ? "you"
              : (users.find((user) => user.id === id)?.name ?? "someone");
    const open = useMemo(
        () => (editing === "new" ? undefined : schedules.find((each) => each.id === editing)),
        [editing, schedules],
    );
    const add = () =>
        attempt(async () => {
            await actions.schedule(quickText);
            setQuickText("");
        });
    const repeats = schedules.filter((each) => each.repeat !== undefined).length;
    const next = schedules[0];

    // One that went away while open (sent, or cancelled elsewhere) closes the editor.
    useEffect(() => {
        if (editing !== null && editing !== "new" && open === undefined) {
            setEditing(null);
        }
    }, [editing, open]);

    return html`<${Sheet} title="Schedules" onClose=${closeSheet} className="sched-sheet">
        <div class="sched-summary" data-part="schedules-summary">
            <div>
                <b>${schedules.length}</b>
                ${" scheduled"}
                ${repeats > 0 ? html`<span class="muted"> · ${repeats} repeating</span>` : ""}
            </div>
            ${
                next !== undefined &&
                html`<div class="sched-next">
                    <span class="muted">Next in</span>
                    <span class="sched-big">${countdown(next.next, now)}</span>
                </div>`
            }
        </div>
        ${
            editing === "new" &&
            html`<${ScheduleEditor} key="new" onDone=${() => setEditing(null)} />`
        }
        ${
            steer &&
            editing !== "new" &&
            html`<div class="sched-add">
                <button class="button primary" onClick=${() => setEditing("new")}>
                    <${Icon} name="plus" size=${14} />
                    New schedule
                </button>
                <input
                    class="sched-quick"
                    placeholder="or type: in 2h check the deploy"
                    aria-label="Quick add: when, then the message"
                    value=${quickText}
                    onInput=${(event) => setQuickText(event.currentTarget.value)}
                    onKeyDown=${(event) =>
                        event.key === "Enter" && quickText.trim() !== "" && add()}
                />
            </div>`
        }
        ${
            schedules.length === 0 &&
            editing !== "new" &&
            html`<div class="sched-empty">
                <${Icon} name="clock" size=${22} />
                <p>Nothing is scheduled.</p>
                <p class="muted small">
                    Pi gets a scheduled message at its time, also when nobody is here, and the people
                    in this session get a notification when it is done.
                </p>
            </div>`
        }
        ${
            schedules.length > 0 &&
            html`<div class="sched-list">
                ${schedules.map((schedule) =>
                    schedule.id === editing
                        ? html`<${ScheduleEditor}
                              key=${schedule.id}
                              schedule=${schedule}
                              onDone=${() => setEditing(null)}
                          />`
                        : html`<${ScheduleRow}
                              key=${schedule.id}
                              schedule=${schedule}
                              now=${now}
                              setBy=${setBy}
                              archived=${archived}
                              steer=${steer}
                              onEdit=${() => setEditing(schedule.id)}
                          />`,
                )}
            </div>`
        }
        <button class="sched-board" onClick=${() => openSheet({ type: "running" })}>
            See every session's schedules on Running now
            <${Icon} name="chevron" size=${14} />
        </button>
    <//>`;
}
