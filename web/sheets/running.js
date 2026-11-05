// Running now: everything Pi is doing, across sessions.
import { useEffect, useState } from "preact/hooks";
import { folderColor } from "../avatar.js";
import { api, attempt, canSteer, closeSheet, navigate, notify, store } from "../store.js";
import { html, Loader, Sheet, Spinner } from "../ui.js";
import { t } from "../ui-locale.js";

/** How often the Running now sheet asks again while it is open. */
const RUNNING_EVERY_MS = 2000;

/** Everything at work in the sessions you can see: open one, stop a run, or cancel a scheduled message. */
export function RunningSheet() {
    const [sessions, setSessions] = useState(null);

    useEffect(() => {
        let open = true;
        const load = () =>
            api("running").then(
                (list) => open && setSessions(list),
                (error) => open && notify("error", error.message),
            );

        load();
        const timer = setInterval(load, RUNNING_EVERY_MS);

        return () => {
            open = false;
            clearInterval(timer);
        };
    }, []);
    const steer = canSteer();

    const go = (id) => {
        closeSheet();
        navigate(id);
    };

    const stopCommand = (task) => {
        const path = {
            "pocket.shell": "shell",
            "pocket.background": "background",
            "pocket.extension-command": "extension-commands",
        }[task.kind];

        return attempt(() => api(`c/${task.conversationId}/${path}/${task.id}/stop`, {}));
    };

    return html`<${Sheet} title=${t(
        "web.sheets.running.running-sheet.title.running-now",
        "Running now",
    )} onClose=${closeSheet}>
        ${
            sessions === null &&
            html`<${Loader} label=${t("web.sheets.running.running-sheet.label.looking", "Looking")} />`
        }
        ${
            sessions?.length === 0 &&
            html`<p class="muted">${t(
                "web.sheets.running.running-sheet.p.nothing-is-running",
                "Nothing is running.",
            )}</p>`
        }
        ${sessions?.map(
            (session) => html`<div class="running" key=${session.id}>
                <div class="running-head">
                    <span
                        class="folder-mark"
                        style=${`--folder:${folderColor(store.state.sessions.find((entry) => entry.id === session.id)?.cwd)}`}
                        aria-hidden="true"
                    ></span>
                    <button class="link grow" onClick=${() => go(session.id)}>
                        ${session.title}
                    </button>
                    ${
                        session.approvals > 0 &&
                        html`<span class="warn small">
                            ${t(
                                "web.sheets.running.running-sheet.span.waiting-approval",
                                "{approvals} waiting for approval",
                                { approvals: session.approvals },
                            )}
                        </span>`
                    }
                    ${
                        steer &&
                        session.busy &&
                        html`<button
                            class="button small"
                            onClick=${() => attempt(() => api(`c/${session.id}/abort`, {}))}
                        >
                            ${t("web.sheets.running.running-sheet.button.stop", "Stop")}
                        </button>`
                    }
                </div>
                ${session.tasks.map(
                    (task) => html`<div class="running-task" key=${task.id}>
                        ${
                            task.status === "running"
                                ? html`<${Spinner} />`
                                : html`<span class="muted">·</span>`
                        }
                        <span class="grow">
                            ${task.subagent && html`<span class="mono">${task.subagent}</span>: `}
                            ${task.label}
                        </span>
                        <span class="muted small mono">${task.status}</span>
                        ${
                            steer &&
                            task.scheduleId &&
                            html`<button
                                class="link small"
                                onClick=${() => attempt(() => api(`c/${task.conversationId}/schedules/${encodeURIComponent(task.scheduleId)}/cancel`, {}))}
                            >
                                ${t("web.sheets.running.running-sheet.button.cancel", "Cancel")}
                            </button>`
                        }
                        ${
                            steer &&
                            task.subagent &&
                            task.kind === "pi.generation" &&
                            html`<button
                                class="link small"
                                onClick=${() => attempt(() => api(`c/${task.conversationId}/abort`, {}))}
                            >
                                ${t("web.sheets.running.running-sheet.button.stop", "Stop")}
                            </button>`
                        }
                        ${
                            steer &&
                            [
                                "pocket.shell",
                                "pocket.background",
                                "pocket.extension-command",
                            ].includes(task.kind) &&
                            html`<button
                                class="link small"
                                onClick=${() => stopCommand(task)}
                            >
                                ${t("web.sheets.running.running-sheet.button.stop", "Stop")}
                            </button>`
                        }
                    </div>`,
                )}
            </div>`,
        )}
    <//>`;
}
