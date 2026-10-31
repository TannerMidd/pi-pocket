// Running now: everything Pi is doing, across sessions.
import { useEffect, useState } from "preact/hooks";
import { folderColor } from "../avatar.js";
import { api, attempt, canSteer, closeSheet, navigate, notify, store } from "../store.js";
import { html, Loader, Sheet, Spinner } from "../ui.js";

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

    return html`<${Sheet} title="Running now" onClose=${closeSheet}>
        ${sessions === null && html`<${Loader} label="Looking" />`}
        ${sessions?.length === 0 && html`<p class="muted">Nothing is running.</p>`}
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
                            ${session.approvals} waiting for approval
                        </span>`
                    }
                    ${
                        steer &&
                        session.busy &&
                        html`<button
                            class="button small"
                            onClick=${() => attempt(() => api(`c/${session.id}/abort`, {}))}
                        >
                            Stop
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
                                Cancel
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
                                Stop
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
                                Stop
                            </button>`
                        }
                    </div>`,
                )}
            </div>`,
        )}
    <//>`;
}
