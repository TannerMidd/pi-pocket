// Scheduled messages of this session.
import { useState } from "preact/hooks";
import { actions, attempt, canSteer, closeSheet, store } from "../store.js";
import { formatWhen, html, Sheet } from "../ui.js";

/** Messages that go to Pi later or on repeat: set one up, see what is coming, cancel one. */
export function SchedulesSheet() {
    const { view, users, me } = store.state;
    const [when, setWhen] = useState("");
    const steer = canSteer();
    const setBy = (id) =>
        id === undefined
            ? "Pi"
            : id === me?.id
              ? "you"
              : (users.find((user) => user.id === id)?.name ?? "someone");
    const add = () =>
        attempt(async () => {
            await actions.schedule(when);
            setWhen("");
        });

    return html`<${Sheet} title="Scheduled messages" onClose=${closeSheet}>
        <p class="muted small">
            Pi gets these at their time, also when nobody is here, and the people in this session get a notification when it is done.
        </p>
        ${
            steer &&
            html`<div class="row">
                <input
                    placeholder="in 2h check the deploy"
                    value=${when}
                    onInput=${(event) => setWhen(event.currentTarget.value)}
                    onKeyDown=${(event) => event.key === "Enter" && add()}
                />
                <button class="button primary" disabled=${when.trim() === ""} onClick=${add}>
                    Add
                </button>
            </div>
            <p class="muted small">
                Start with when: in 30m, 7:00, tomorrow 9am, fri 17:30, every 2h, every weekday 8:00. Then what Pi gets.
            </p>`
        }
        ${view.schedules.length === 0 && html`<p class="muted">Nothing is scheduled.</p>`}
        ${view.schedules.map(
            (schedule) => html`<div class="schedule" key=${schedule.id}>
                <div class="grow">
                    <div>${schedule.text}</div>
                    <div class="muted small">
                        ${schedule.repeat ? `${schedule.repeat} · next ${formatWhen(schedule.next)}` : formatWhen(schedule.next)} · set by ${setBy(schedule.by)}
                    </div>
                </div>
                ${
                    steer &&
                    html`<button
                        class="button small ghost"
                        onClick=${() => attempt(() => actions.cancelSchedule(schedule.id))}
                    >
                        Cancel
                    </button>`
                }
            </div>`,
        )}
    <//>`;
}
