import { t } from "../ui-locale.js";
// Background: what the session's commands print as they run, one task at a time.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, attempt, canSteer, closeSheet, notify, store } from "../store.js";
import { html, Icon, Loader, Sheet, Spinner } from "../ui.js";

/** How often the sheet asks again what the session's tasks are, and what the open one printed. */
const LIST_EVERY_MS = 3000;
const OUTPUT_EVERY_MS = 1000;
/** How much of a task's output the sheet holds and asks for at most, in characters. */
const CHARS = 20_000;
/** How near the end of its log the sheet counts as following it, in pixels. */
const AT_END = 24;

const isLive = (task) => task?.status === "running" || task?.status === "starting";

/** How long a task ran, in words: while it runs, so far. */
function took(task) {
    const seconds = Math.max(0, Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000));

    return seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Translate exact UI status lines only; detailed failures and daemon warnings stay intact. */
function outcomeText(item) {
    switch (item.outcome) {
        case "starting":
            return t("web.sheets.background.release028.starting", "starting");
        case "running":
            return t("web.sheets.background.release028.running", "running");
        case "stopped":
            return t("web.sheets.background.release028.stopped", "stopped");
        case "has an unknown outcome: a restart cut its start off, and no process or exit code of it was found (it may have run and ended, or never started)":
            return t(
                "web.sheets.background.release028.unknown",
                "has an unknown outcome: a restart cut its start off, and no process or exit code of it was found (it may have run and ended, or never started)",
            );
        case "ended without an exit code (killed by a signal, or the machine restarted)":
            return t(
                "web.sheets.background.release028.lost",
                "ended without an exit code (killed by a signal, or the machine restarted)",
            );
        case `exited with code ${item.code ?? "?"}`:
            return t("web.sheets.background.release028.exited", "exited with code {code}", {
                code: item.code ?? "?",
            });
        default:
            return item.outcome;
    }
}

/** One command and what it prints, or a row to pick one of the session's commands. */
export function BackgroundSheet({ task: opened }) {
    const { view } = store.state;
    const conversationId = view.conversation?.id;
    const steer = canSteer();
    const [tasks, setTasks] = useState(null);
    const [selected, setSelected] = useState(opened ?? null);
    const [log, setLog] = useState({ text: "", skipped: 0, item: null });
    const [follow, setFollow] = useState(true);
    const box = useRef(null);
    const row = useRef(null);
    const from = useRef(undefined);

    useEffect(() => {
        let open = true;
        const load = () =>
            api(`c/${conversationId}/background`).then(
                (data) => {
                    if (!open) {
                        return;
                    }

                    setTasks(data.tasks);
                    setSelected((now) =>
                        now !== null && data.tasks.some((task) => task.id === now)
                            ? now
                            : (data.tasks[0]?.id ?? null),
                    );
                },
                (error) => open && notify("error", error.message),
            );

        load();
        const timer = setInterval(load, LIST_EVERY_MS);

        return () => {
            open = false;
            clearInterval(timer);
        };
    }, [conversationId]);

    // What the open task printed: what came since the last look, while it runs; once it ends, its end.
    useEffect(() => {
        if (selected === null) {
            return undefined;
        }

        let open = true;
        let ended = false;
        // One look at a time: a look still on its way has not moved `from` yet, so another would get the same part.
        let looking = false;

        from.current = undefined;
        setLog({ text: "", skipped: 0, item: null });

        const load = () => {
            if (ended || looking) {
                return;
            }

            const since = from.current === undefined ? "" : `&from=${from.current}`;

            looking = true;
            api(`c/${conversationId}/background/${selected}/output?chars=${CHARS}${since}`)
                .finally(() => {
                    looking = false;
                })
                .then(
                    (data) => {
                        if (!open) {
                            return;
                        }

                        ended = !isLive(data.item);
                        from.current = data.to;
                        setLog((was) => ({
                            text: (was.text + data.text).slice(-CHARS),
                            skipped: was.skipped + data.skipped,
                            item: data.item,
                        }));
                    },
                    (error) => open && notify("error", error.message),
                );
        };

        load();
        const timer = setInterval(load, OUTPUT_EVERY_MS);

        return () => {
            open = false;
            clearInterval(timer);
        };
    }, [conversationId, selected]);

    // The task the sheet shows is in sight, in a row of chips that scrolls when it is long.
    useEffect(() => {
        const strip = row.current;
        const chip = strip?.querySelector('[aria-selected="true"]');

        if (strip === null || strip === undefined || chip === null || chip === undefined) {
            return;
        }

        const stripAt = strip.getBoundingClientRect();
        const chipAt = chip.getBoundingClientRect();

        if (chipAt.right > stripAt.right) {
            strip.scrollLeft += chipAt.right - stripAt.right;
        } else if (chipAt.left < stripAt.left) {
            strip.scrollLeft -= stripAt.left - chipAt.left;
        }
    }, [selected]);

    // Its end stays in view while the sheet follows it.
    useEffect(() => {
        if (follow && box.current !== null) {
            box.current.scrollTop = box.current.scrollHeight;
        }
    }, [log.text, follow]);

    const task = tasks?.find((each) => each.id === selected) ?? null;
    const live = isLive(log.item ?? task ?? {});

    const onScroll = (event) => {
        const node = event.currentTarget;

        setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < AT_END);
    };

    const stop = () =>
        attempt(async () => {
            await api(`c/${conversationId}/background/${task.taskId}/stop`, {});
        });

    return html`<${Sheet}
        title=${t("web.sheets.background.release028.title", "Background")}
        wide=${true}
        onClose=${closeSheet}
        actions=${live && steer ? html`<button class="button small" onClick=${stop}>${t("web.sheets.background.release028.stop", "Stop")}</button>` : null}
    >
        ${tasks === null && html`<${Loader} label=${t("web.sheets.background.release028.looking", "Looking")} />`}
        ${
            tasks?.length === 0 &&
            html`<p class="muted">
                ${t("web.sheets.background.release028.empty", "No command has run in the background in this session. Pi starts one with its background tool.")}
            </p>`
        }
        ${
            (tasks?.length ?? 0) > 0 &&
            html`<div class="background-tasks" role="tablist" aria-label=${t("web.sheets.background.release028.commands", "Background commands")} ref=${row}>
                ${tasks.map(
                    (each) => html`<button
                        type="button"
                        role="tab"
                        key=${each.id}
                        class=${`background-task ${each.id === selected ? "on" : ""}`}
                        aria-selected=${each.id === selected}
                        onClick=${() => setSelected(each.id)}
                    >
                        ${
                            isLive(each)
                                ? html`<${Spinner} hidden=${true} />`
                                : html`<span class="mark" aria-hidden="true"></span>`
                        }
                        <span class="mono">${each.id}</span>
                        <span class="what">${each.command}</span>
                    </button>`,
                )}
            </div>`
        }
        ${
            task !== null &&
            html`<div class="background-view">
                <div class="background-head">
                    <${Icon} name="terminal" size=${14} />
                    <span class="mono grow">${task.command}</span>
                </div>
                <div class="muted small background-said">
                    ${outcomeText(log.item ?? task)} · ${took(log.item ?? task)}
                    ${live ? "" : t("web.sheets.background.release028.ends-here", " · it ends here")}
                </div>
                <div class="background-log" ref=${box} onScroll=${onScroll} tabindex="0">
                    ${
                        log.text === ""
                            ? html`<p class="muted small">${t("web.sheets.background.release028.nothing", "It printed nothing yet.")}</p>`
                            : html`<pre>${log.text}</pre>`
                    }
                </div>
                ${
                    log.skipped > 0 &&
                    html`<p class="muted small">
                        ${t("web.sheets.background.release028.skipped", "{bytes} bytes before this not shown: the log grew past what the sheet keeps, or its oldest part went.", { bytes: log.skipped })}
                    </p>`
                }
                ${
                    !follow &&
                    html`<button class="link small background-end" onClick=${() => setFollow(true)}>
                        ${t("web.sheets.background.release028.jump", "Jump to the end")}
                    </button>`
                }
            </div>`
        }
    <//>`;
}
