// Scheduled messages of this session.
import { useState } from "preact/hooks";
import { actions, attempt, canSteer, closeSheet, store } from "../store.js";
import { formatWhen, html, Icon, Sheet } from "../ui.js";
import { t } from "../ui-locale.js";

/** Messages that go to Pi later or on repeat: set one up, see what is coming, cancel one. */
export function SchedulesSheet() {
    const { view, users, me } = store.state;
    const [when, setWhen] = useState("");
    const steer = canSteer();
    const archived = store.state.sessions.some(
        (session) => session.id === store.state.conversationId && session.archived,
    );
    const setBy = (id) =>
        id === undefined
            ? t("web.sheets.schedules.schedules-sheet.set-by.pi", "Pi")
            : id === me?.id
              ? t("web.sheets.schedules.schedules-sheet.set-by.content", "you")
              : (users.find((user) => user.id === id)?.name ??
                t("web.sheets.schedules.schedules-sheet.set-by.someone", "someone"));
    const add = () =>
        attempt(async () => {
            await actions.schedule(when);
            setWhen("");
        });

    return html`<${Sheet} title=${t(
        "web.sheets.schedules.schedules-sheet.title.scheduled-messages",
        "Scheduled messages",
    )} onClose=${closeSheet}>
        <p class="muted small">
            ${t("web.sheets.schedules.schedules-sheet.p.pi-gets-their-time", "Pi gets these at their time, also when nobody is here, and the people in this session get a notification when it is done.")}
        </p>
        ${
            steer &&
            html`<div class="row">
                <input
                    placeholder=${t(
                        "web.sheets.schedules.schedules-sheet.placeholder.h-check-deploy",
                        "in 2h check the deploy",
                    )}
                    value=${when}
                    onInput=${(event) => setWhen(event.currentTarget.value)}
                    onKeyDown=${(event) => event.key === "Enter" && add()}
                />
                <button class="button primary" disabled=${when.trim() === ""} onClick=${add}>
                    ${t("web.sheets.schedules.schedules-sheet.button.add", "Add")}
                </button>
            </div>
            <p class="muted small">
                ${t("web.sheets.schedules.schedules-sheet.p.start-m-tomorrow-am", "Start with when: in 30m, 7:00, tomorrow 9am, fri 17:30, every 2h, every weekday 8:00. Then what Pi gets.")}
            </p>`
        }
        ${
            view.schedules.length === 0 &&
            html`<p class="muted">${t(
                "web.sheets.schedules.schedules-sheet.p.nothing-is-scheduled",
                "Nothing is scheduled.",
            )}</p>`
        }
        ${
            view.schedules.length > 0 &&
            html`<div class="sheet-list">
                ${view.schedules.map(
                    (schedule) => html`<div class="schedule" key=${schedule.id}>
                        <${Icon} name="clock" size=${15} />
                        <div class="grow">
                            <div>${schedule.text}</div>
                            <div class="muted small">
                                ${t(
                                    "web.sheets.schedules.schedules-sheet.div.set-by",
                                    "{when} · set by {who}",
                                    { when: nextLine(schedule), who: setBy(schedule.by) },
                                )}${archived ? t("web.sheets.schedules.archived", " · session archived") : ""}
                            </div>
                        </div>
                        ${
                            steer &&
                            html`<button
                                class="button small ghost"
                                onClick=${() => attempt(() => actions.cancelSchedule(schedule.id))}
                            >
                                ${t("web.sheets.schedules.schedules-sheet.button.cancel", "Cancel")}
                            </button>`
                        }
                    </div>`,
                )}
            </div>`
        }
    <//>`;
}

/** When a scheduled message goes next: its repeat, then the time. */
function nextLine(schedule) {
    return schedule.repeat
        ? t("web.sheets.schedules.schedules-sheet.div.next-repeat-when", "{repeat} · next {when}", {
              repeat: schedule.repeat,
              when: formatWhen(schedule.next),
          })
        : formatWhen(schedule.next);
}
