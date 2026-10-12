// Scheduled messages of this session.
import { useState } from "preact/hooks";
import { t } from "../i18n.js";
import { actions, attempt, canSteer, closeSheet, store } from "../store.js";
import { formatWhen, html, Sheet } from "../ui.js";

/** Messages that go to Pi later or on repeat: set one up, see what is coming, cancel one. */
export function SchedulesSheet() {
    const { view, users, me } = store.state;
    const [when, setWhen] = useState("");
    const steer = canSteer();
    const setBy = (id) =>
        id === undefined
            ? t("Pi")
            : id === me?.id
              ? t("you")
              : (users.find((user) => user.id === id)?.name ?? t("someone"));
    const add = () =>
        attempt(async () => {
            await actions.schedule(when);
            setWhen("");
        });

    return html`<${Sheet} title=${t("Scheduled messages")} onClose=${closeSheet}>
        <p class="muted small">
            ${t("Pi gets these at their time, also when nobody is here, and the people in this session get a notification when it is done.")}
        </p>
        ${
            steer &&
            html`<div class="row">
                <input
                    placeholder=${t("in 2h check the deploy")}
                    value=${when}
                    onInput=${(event) => setWhen(event.currentTarget.value)}
                    onKeyDown=${(event) => event.key === "Enter" && add()}
                />
                <button class="button primary" disabled=${when.trim() === ""} onClick=${add}>
                    ${t("Add")}
                </button>
            </div>
            <p class="muted small">
                ${t("Start with when: in 30m, 7:00, tomorrow 9am, fri 17:30, every 2h, every weekday 8:00. Then what Pi gets.")}
            </p>`
        }
        ${view.schedules.length === 0 && html`<p class="muted">${t("Nothing is scheduled.")}</p>`}
        ${view.schedules.map(
            (schedule) => html`<div class="schedule" key=${schedule.id}>
                <div class="grow">
                    <div>${schedule.text}</div>
                    <div class="muted small">
                        ${schedule.repeat ? `${schedule.repeat} · ${t("next")} ${formatWhen(schedule.next)}` : formatWhen(schedule.next)} · ${t("set by")} ${setBy(schedule.by)}
                    </div>
                </div>
                ${
                    steer &&
                    html`<button
                        class="button small ghost"
                        onClick=${() => attempt(() => actions.cancelSchedule(schedule.id))}
                    >
                        ${t("Cancel")}
                    </button>`
                }
            </div>`,
        )}
    <//>`;
}
