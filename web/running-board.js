// The Running now board: everything Pi is doing, and everything it will do, in the conversation's place, as the
// subagents board shows. A timeline at the top puts each session's scheduled messages on one lane, with how long it has
// been at work; under it, one row per session with what runs there now beside what is scheduled; and at the side, what
// needs you, what goes out next, and the schedule selected. Phones get one column, a timeline that pans, and a bar at
// the bottom for the schedule selected.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { folderColor } from "./avatar.js";
import { useBack } from "./back.js";
import { api, attempt, canSteer, navigate, notify, store } from "./store.js";
import { html, Icon, Spinner } from "./ui.js";

/** How often the board asks again while it shows. */
const EVERY_MS = 2000;
/** How long an ask may go unanswered before the board asks again anyway. */
const STALE_MS = 15_000;
/** How many times of a repeat the server lists at most (`UPCOMING` in `src/server/running.ts`). */
const LISTED = 24;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The timeline's ranges: how much it shows, the step between its ticks, and how wide an hour is at the least. */
const RANGES = {
    day: { label: "24h", span: DAY, step: 3 * HOUR, hourPx: 22 },
    three: { label: "3d", span: 3 * DAY, step: 6 * HOUR, hourPx: 8 },
    week: { label: "7d", span: 7 * DAY, step: DAY, hourPx: 4.2 },
};

/** How far into the past a run's bar takes the pointer: a run that just began has a bar a pin's width wide. */
const REACH = 24;

/** How much of the timeline is the past: where work started, and what just went out. */
const PAST = 0.14;

const PHONE = matchMedia("(max-width: 699px)");
/** Below this width the schedule picked shows under the matrix, not beside it (`style.css`). */
const SIDE_BELOW = matchMedia("(max-width: 1439px)");

/** A schedule's id is unique only in its own session: the board, which lists every session's, names one by both. */
const scheduleKey = (schedule) => `${schedule.session}:${schedule.id}`;

/** Close the board: back to the conversation, or the home screen, it took the place of. */
export const closeRunning = () => store.set({ board: false, boardAgents: null });

/** Task kinds a person stops from here, and the route that stops each. */
const STOPPABLE = {
    "pocket.shell": "shell",
    "pocket.background": "background",
    "pocket.extension-command": "extension-commands",
};

const pad = (n) => String(n).padStart(2, "0");

/**
 * A date formatter, made once for each locale and set of options: making one costs far more than using it, and the
 * board's timeline formats a time for each of its marks.
 */
const formatters = new Map();

/** This browser's time zone. */
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function formatter(locale, options) {
    const key = `${locale ?? ""} ${JSON.stringify(options)}`;
    let format = formatters.get(key);

    if (format === undefined) {
        format = new Intl.DateTimeFormat(locale, options);
        formatters.set(key, format);
    }

    return format;
}

/** "41s", "2m 14s", "1h 05m", "3d 4h". */
function elapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));

    if (s < 60) {
        return `${s}s`;
    }

    const m = Math.floor(s / 60);

    if (m < 60) {
        return `${m}m ${pad(s % 60)}s`;
    }

    const h = Math.floor(m / 60);

    return h < 24 ? `${h}h ${pad(m % 60)}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "45m", "1h 25m", "2d 16h". */
function span(ms) {
    const m = Math.round(Math.abs(ms) / MINUTE);

    if (m < 60) {
        return `${m}m`;
    }

    const h = Math.floor(m / 60);

    if (h < 24) {
        return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
    }

    return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

const relative = (at, now) => (at >= now ? `in ${span(at - now)}` : `${span(now - at)} ago`);

/** A moment in a schedule's own zone: "14:50", or with its day ("Mon 08:00", "12 Nov 09:00") when not today. */
function clock(at, zone, now, { day = "auto" } = {}) {
    const options = { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" };
    const sameDay =
        formatter("en-CA", { timeZone: zone, dateStyle: "short" }).format(at) ===
        formatter("en-CA", { timeZone: zone, dateStyle: "short" }).format(now);

    if (day === "never" || (day === "auto" && sameDay)) {
        return formatter("en-GB", options).format(at);
    }

    return formatter("en-GB", {
        ...options,
        ...(at - now < 6 * DAY ? { weekday: "short" } : { day: "numeric", month: "short" }),
    })
        .format(at)
        .replace(",", "");
}

/** The time zone's short name, when it is not this browser's: "UTC", "CET". */
function zoneName(zone, at) {
    if (zone === HERE) {
        return "";
    }

    return (
        formatter("en-US", { timeZone: zone, timeZoneName: "short" })
            .formatToParts(at)
            .find((part) => part.type === "timeZoneName")?.value ?? zone
    );
}

const dollars = (amount) => (amount >= 100 ? `$${amount.toFixed(0)}` : `$${amount.toFixed(2)}`);

const shortPath = (path) => path?.replace(/^\/home\/[^/]+/, "~").replace(/^\/root/, "~");

/** Who set a schedule up, as its sheet says: you, a person, or Pi (for someone). */
function setBy(schedule) {
    const { users, me } = store.state;
    const name = (id) =>
        id === me?.id ? "you" : (users.find((user) => user.id === id)?.name ?? "someone");

    if (schedule.by !== undefined) {
        return name(schedule.by);
    }

    return schedule.requestedBy === undefined ? "Pi" : `Pi, for ${name(schedule.requestedBy)}`;
}

function useMatches(query) {
    const [matches, setMatches] = useState(query.matches);

    useEffect(() => {
        const change = () => setMatches(query.matches);

        query.addEventListener("change", change);

        return () => query.removeEventListener("change", change);
    }, []);

    return matches;
}

/**
 * The last board this page got, and one asked for ahead: the board shows the last one at once while it asks again,
 * and a press on its button asks before the click lands.
 */
let lastBoard = null;
let ahead = null;
/**
 * Every ask for the board is numbered, and `lastBoard` keeps the answer to the newest one: a late answer to an older
 * one, from a board closed since or from the ask ahead, is dropped.
 */
let asks = 0;
let kept = 0;

function keep(ask, data) {
    if (ask > kept) {
        kept = ask;
        lastBoard = data;
    }
}

/** The timeline's width when it last showed: 0 until it has been measured once. */
let lastWidth = 0;

/** Ask for the board now, ahead of opening it (a pointer down on its button); the board takes this answer. */
export function prefetchRunning() {
    if (ahead === null) {
        const ask = ++asks;

        ahead = api("running/board")
            .then((data) => {
                keep(ask, data);

                return data;
            })
            .finally(() => setTimeout(() => (ahead = null), 1000));
    }

    return ahead;
}

// Asked once the page is idle after it loads and someone is signed in, so the first press shows a board at once, not
// "Looking". Until then it waits, and tries again.
const idle = globalThis.requestIdleCallback ?? ((run) => setTimeout(run, 1000));

function warm(tries = 0) {
    idle(
        () => {
            if (store.state.me) {
                prefetchRunning().catch(() => undefined);
            } else if (tries < 30) {
                setTimeout(() => warm(tries + 1), 1000);
            }
        },
        { timeout: 5000 },
    );
}

warm();

/** The board's data, asked for again every `EVERY_MS` while it shows; `reload` asks now, after an action. */
function useBoard() {
    const [board, setBoard] = useState(lastBoard);
    const [error, setError] = useState(null);
    const asked = useRef(0);
    // When the answer on its way was asked for: one that never comes stops holding the next after `STALE_MS`.
    const busy = useRef(0);
    const waiting = () => Date.now() - busy.current < STALE_MS;

    const load = (first = false) => {
        const n = ++asked.current;
        // The answer ahead keeps itself; an ask of its own is numbered here.
        const ask = first && ahead !== null ? undefined : ++asks;

        busy.current = Date.now();

        return (ask === undefined ? ahead : api("running/board"))
            .finally(() => {
                busy.current = 0;
            })
            .then(
                (data) => {
                    if (ask !== undefined) {
                        keep(ask, data);
                    }

                    // A late answer to an ask that a newer one of this board passed is not shown.
                    if (n === asked.current) {
                        setBoard(data);
                        setError(null);
                    }
                },
                (failure) => n === asked.current && setError(failure.message),
            );
    };

    useEffect(() => {
        load(true);
        // Not while the tab is hidden, and not over an answer still on its way.
        const timer = setInterval(() => {
            if (!document.hidden && !waiting()) {
                load();
            }
        }, EVERY_MS);
        const shown = () => !document.hidden && !waiting() && load();

        document.addEventListener("visibilitychange", shown);

        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", shown);
        };
    }, []);

    return { board, error, reload: load };
}

/** The filters, most general first: what each keeps of a session row. */
const FILTERS = [
    { key: "all", label: "All", keep: () => true },
    { key: "running", label: "Running", keep: (row) => row.run !== undefined },
    { key: "scheduled", label: "Scheduled", keep: (row) => row.schedules.length > 0 },
    { key: "approval", label: "Needs approval", keep: (row) => (row.run?.approvals ?? 0) > 0 },
    { key: "held", label: "Held", keep: (row) => row.schedules.some((each) => each.held) },
];

export function RunningBoard() {
    const { board, error, reload } = useBoard();
    const phone = useMatches(PHONE);
    const [filter, setFilter] = useState("all");
    const [query, setQuery] = useState("");
    const [range, setRange] = useState("day");
    const [selected, setSelected] = useState(null);
    const [row, setRow] = useState(null);
    const [, tick] = useState(0);
    const box = useRef(null);
    const steer = canSteer();
    const { sessions: listed } = store.state;

    useBack(true, closeRunning);

    // Elapsed times and countdowns tick between the board's own updates.
    useEffect(() => {
        const timer = setInterval(() => tick((n) => n + 1), 1000);

        return () => clearInterval(timer);
    }, []);

    // Esc closes the board, unless something over it, or the search, takes it first.
    useEffect(() => {
        const keys = (event) => {
            if (event.defaultPrevented || store.state.sheet || store.state.launcher) {
                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();

                if (selected !== null) {
                    setSelected(null);
                } else {
                    closeRunning();
                }
            }
        };

        addEventListener("keydown", keys);

        return () => removeEventListener("keydown", keys);
    }, [selected]);

    // The server's clock, moved on by how long ago it answered: what the timeline and countdowns count from.
    const offset = useRef(0);

    if (board) {
        offset.current = board.now - Date.now();
    }

    const now = Date.now() + offset.current;
    const cwds = useMemo(() => new Map(listed.map((each) => [each.id, each.cwd])), [listed]);

    const rows = useMemo(() => {
        if (!board) {
            return [];
        }

        const byId = new Map();

        const entry = (id, title) => {
            let each = byId.get(id);

            if (each === undefined) {
                each = { id, title, run: undefined, schedules: [] };
                byId.set(id, each);
            }

            return each;
        };

        for (const run of board.sessions) {
            // A scheduled message's task only sleeps until its time: the Schedule column shows it.
            const tasks = run.tasks.filter((task) => task.kind !== "pocket.schedule");

            if (tasks.length > 0 || run.busy || run.approvals > 0) {
                entry(run.id, run.title).run = { ...run, tasks };
            }
        }

        for (const schedule of board.schedules) {
            entry(schedule.session, schedule.sessionTitle).schedules.push(schedule);
        }

        for (const each of byId.values()) {
            each.cwd = cwds.get(each.id);
        }

        return [...byId.values()].sort(
            (a, b) =>
                (b.run?.approvals ?? 0) - (a.run?.approvals ?? 0) ||
                Number(b.run?.busy ?? false) - Number(a.run?.busy ?? false) ||
                (b.run?.tasks.length ?? 0) - (a.run?.tasks.length ?? 0) ||
                (a.schedules[0]?.next ?? Infinity) - (b.schedules[0]?.next ?? Infinity),
        );
    }, [board, cwds]);

    const needle = query.trim().toLowerCase();
    const matches = (each) =>
        needle === "" ||
        `${each.title} ${each.schedules.map((s) => s.text).join(" ")} ${(each.run?.tasks ?? []).map((t) => `${t.label} ${t.subagent ?? ""}`).join(" ")}`
            .toLowerCase()
            .includes(needle);
    const shown = rows.filter(FILTERS.find((each) => each.key === filter).keep).filter(matches);
    const schedules = board?.schedules ?? [];
    const chosen = schedules.find((each) => scheduleKey(each) === selected) ?? null;
    const colorOf = (id) =>
        folderColor(
            board?.sessions.find((s) => s.id === id)?.cwd ??
                schedules.find((s) => s.session === id && s.sessionCwd)?.sessionCwd ??
                cwds.get(id),
        );

    const open = (id) => {
        closeRunning();
        navigate(id);
    };

    const pick = (schedule) => {
        const next = selected === scheduleKey(schedule) ? null : scheduleKey(schedule);

        setSelected(next);
        setRow(next === null ? null : schedule.session);

        if (next !== null && !phone) {
            // Beside the matrix, the panel is in view and its row comes to it; under it, the panel comes into view.
            requestAnimationFrame(() =>
                box.current
                    ?.querySelector(
                        SIDE_BELOW.matches
                            ? '[data-part="running-schedule"]'
                            : `[data-row="${schedule.session}"]`,
                    )
                    ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
            );
        }
    };

    const cancel = (schedule) =>
        attempt(async () => {
            await api(
                `c/${schedule.session}/schedules/${encodeURIComponent(schedule.id)}/cancel`,
                {},
            );
            setSelected(null);
            notify("info", "Schedule cancelled.");
            await reload();
        });

    const stopTask = (task) =>
        attempt(async () => {
            if (STOPPABLE[task.kind]) {
                await api(`c/${task.conversationId}/${STOPPABLE[task.kind]}/${task.id}/stop`, {});
            } else {
                await api(`c/${task.conversationId}/abort`, {});
            }

            await reload();
        });

    const stopRun = (id) =>
        attempt(async () => {
            await api(`c/${id}/abort`, {});
            await reload();
        });

    const active = (board?.sessions ?? []).reduce(
        (sum, each) => sum + each.tasks.filter((task) => task.status === "running").length,
        0,
    );
    const next = schedules.find((each) => !each.held);
    const needs = [
        ...(board?.sessions ?? [])
            .filter((each) => each.approvals > 0)
            .map((each) => ({
                key: `a${each.id}`,
                session: each.id,
                title: each.title,
                what: each.approval
                    ? `${each.approval.tool}: ${each.approval.subject}`
                    : `${each.approvals} waiting for approval`,
                count: each.approvals,
            })),
        ...schedules
            .filter((each) => each.held)
            .map((each) => ({
                key: `h${scheduleKey(each)}`,
                schedule: each,
                session: each.session,
                title: each.sessionTitle,
                what: `Held: ${each.held}`,
            })),
    ];

    return html`<section
        class=${`board running-board ${phone ? "phone" : ""}`}
        data-part="running-board"
        ref=${box}
        aria-label="Running now in every session"
    >
        <header class="board-head">
            <div class="board-title">
                <h2>Running now</h2>
                <div class="board-sub">
                    ${
                        board
                            ? html`<b>${rows.filter((row) => row.run !== undefined).length}</b> at work · <b>${active}</b> running · <b>${schedules.length}</b> scheduled${next && html` · next <b>${span(next.next - now)}</b>`}`
                            : "Looking"
                    }
                </div>
            </div>
            ${!phone && html`<${Search} query=${query} setQuery=${setQuery} />`}
            <button
                class="icon-button"
                title="Back to the conversation (Esc)"
                aria-label="Close"
                onClick=${closeRunning}
            >
                <${Icon} name="close" />
            </button>
        </header>
        ${
            phone &&
            html`<div class="board-search-row">
                <${Search} query=${query} setQuery=${setQuery} />
            </div>`
        }
        <div class=${`rb-scroll ${chosen && phone ? "with-bar" : ""}`}>
            ${
                board === null
                    ? html`<div class="board-empty">
                          ${error ? html`<span class="err">${error}</span>` : html`<${Spinner} /> Looking…`}
                      </div>`
                    : html`
                      <${Timeline}
                          rows=${shown}
                          range=${range}
                          setRange=${setRange}
                          now=${now}
                          selected=${selected}
                          row=${row}
                          phone=${phone}
                          next=${next}
                          colorOf=${colorOf}
                          onPick=${pick}
                          onRow=${(id) => {
                              setRow(row === id ? null : id);
                              setSelected(null);
                          }}
                      />
                      <div class="board-legend rb-filters" role="group" aria-label="Show only">
                          ${FILTERS.map(
                              (each) => html`<button
                                  class=${`board-filter ${filter === each.key ? "on" : ""}`}
                                  aria-pressed=${filter === each.key}
                                  onClick=${() => setFilter(filter === each.key ? "all" : each.key)}
                              >
                                  ${each.key !== "all" && html`<span class=${`rb-mark rb-mark-${each.key}`}></span>`}
                                  ${each.label}
                                  <span class="board-filter-count">${rows.filter(each.keep).length}</span>
                              </button>`,
                          )}
                      </div>
                      <div class="rb-body">
                          <div class="rb-matrix" role="table" aria-label="Sessions">
                              <div class="rb-thead" role="row">
                                  <div role="columnheader">Session</div>
                                  <div role="columnheader">Now</div>
                                  <div role="columnheader">Schedule</div>
                              </div>
                              ${
                                  shown.length === 0
                                      ? html`<div class="board-empty rb-none">
                                            ${
                                                rows.length === 0
                                                    ? "Nothing runs, and nothing is scheduled."
                                                    : "Nothing matches."
                                            }
                                        </div>`
                                      : shown.map(
                                            (each) => html`<${Row}
                                                key=${each.id}
                                                row=${each}
                                                now=${now}
                                                steer=${steer}
                                                phone=${phone}
                                                color=${colorOf(each.id)}
                                                lit=${row === each.id}
                                                selected=${selected}
                                                onOpen=${open}
                                                onPick=${pick}
                                                onStopTask=${stopTask}
                                                onStopRun=${stopRun}
                                            />`,
                                        )
                              }
                          </div>
                          ${
                              !phone &&
                              html`<aside class="rb-side">
                                  ${
                                      chosen &&
                                      html`<div class="rb-panel" data-part="running-schedule">
                                          <${Detail}
                                              schedule=${chosen}
                                              now=${now}
                                              steer=${steer}
                                              color=${colorOf(chosen.session)}
                                              onClose=${() => setSelected(null)}
                                              onOpen=${open}
                                              onCancel=${cancel}
                                          />
                                      </div>`
                                  }
                                  <${Needs} needs=${needs} colorOf=${colorOf} onOpen=${open} onPick=${pick} />
                                  <${NextUp} schedules=${schedules} now=${now} colorOf=${colorOf} onPick=${pick} />
                              </aside>`
                          }
                      </div>
                      ${
                          phone &&
                          html`<div class="rb-phone-side">
                              <${Needs} needs=${needs} colorOf=${colorOf} onOpen=${open} onPick=${pick} />
                          </div>`
                      }
                  `
            }
        </div>
        ${
            phone &&
            chosen &&
            html`<div class="board-bar rb-bar" data-part="running-schedule">
                <${Detail}
                    schedule=${chosen}
                    now=${now}
                    steer=${steer}
                    color=${colorOf(chosen.session)}
                    onClose=${() => setSelected(null)}
                    onOpen=${open}
                    onCancel=${cancel}
                />
            </div>`
        }
    </section>`;
}

function Search({ query, setQuery }) {
    return html`<label class=${`board-search ${query ? "filled" : ""}`}>
        <${Icon} name="search" size=${14} />
        <input
            placeholder="Find a session, task, or schedule"
            value=${query}
            onInput=${(event) => setQuery(event.currentTarget.value)}
            onKeyDown=${(event) => {
                if (event.key === "Escape" && query !== "") {
                    event.preventDefault();
                    setQuery("");
                }
            }}
        />
    </label>`;
}

/**
 * One lane per session: its scheduled messages as pins at their times (a diamond for a repeat, a ring for one that
 * goes out once, amber while held), how long it has been at work as a bar up to now, and a line at now.
 */
function Timeline({
    rows,
    range,
    setRange,
    now,
    selected,
    row,
    phone,
    next,
    colorOf,
    onPick,
    onRow,
}) {
    const scroller = useRef(null);
    // The width it had when last shown: the first draw uses it rather than measuring, which would make the browser lay
    // the whole board out at once, then draw it again. The observer says when it differs, after the browser's layout.
    const [width, setWidth] = useState(lastWidth);
    const [tip, setTip] = useState(null);
    const r = RANGES[range];

    useEffect(() => {
        const box = scroller.current;

        if (!box) {
            return;
        }

        const watch = new ResizeObserver(([entry]) => {
            lastWidth = Math.round(entry.contentRect.width);
            setWidth(lastWidth);
        });

        watch.observe(box);

        return () => watch.disconnect();
    }, []);

    const full = Math.max(width, Math.round((r.span / HOUR) * r.hourPx * (phone ? 1.6 : 1)));
    const t0 = now - r.span * PAST;
    const t1 = t0 + r.span;
    const x = (t) => ((t - t0) / r.span) * full;

    // Scrolled so that now shows, a little in from the left, when the range changes or the board opens.
    useLayoutEffect(() => {
        const box = scroller.current;

        if (box && width > 0) {
            box.scrollLeft = Math.max(0, x(now) - width * PAST);
        }
    }, [range, width > 0]);

    const ticks = [];

    for (let t = Math.ceil(t0 / r.step) * r.step; t < t1; t += r.step) {
        const local = new Date(t);
        const midnight = local.getHours() === 0 && local.getMinutes() === 0;

        if (!midnight && Math.abs(x(t) - x(now)) < 46) {
            continue;
        }

        ticks.push({
            at: t,
            day: midnight,
            label:
                midnight || range === "week"
                    ? formatter(undefined, {
                          weekday: "short",
                          ...(range === "week" ? { day: "numeric" } : {}),
                      }).format(local)
                    : formatter("en-GB", {
                          hour: "2-digit",
                          minute: "2-digit",
                      }).format(local),
        });
    }

    const lanes = rows.map((each) => {
        const marks = [];
        const run = each.run;

        if (run && run.tasks.length > 0) {
            const prompt = run.prompt;
            // A busy session's run began with its last message: that time outlasts a server restart, which the tasks'
            // own first-seen times do not.
            const start = Math.min(
                ...run.tasks.map((task) => task.since ?? now),
                run.busy && prompt?.at ? prompt.at : now,
            );
            const from = Math.max(0, x(start));

            const show = (event) => {
                const box = event.currentTarget.getBoundingClientRect();
                const who = prompt?.from ? `${prompt.from} · ` : "";
                const sent = prompt?.at ? `sent ${relative(prompt.at, now)} · ` : "";

                setTip({
                    text: prompt?.text ?? "No message found",
                    when: `${who}${sent}at work for ${elapsed(now - start)}`,
                    x: Math.min(
                        box.right - 20,
                        Math.max(box.left, (event.clientX ?? box.left) - 20),
                    ),
                    y: box.bottom,
                    long: true,
                });
            };

            // The bar is thin; a lane-tall area over it takes the pointer, and a tap on a phone, where nothing hovers.
            marks.push(html`<button
                key="run"
                class="rb-runhit"
                style=${`left:${Math.max(0, from - REACH)}px;width:${x(now) - Math.max(0, from - REACH)}px;--bar-from:${from - Math.max(0, from - REACH)}px`}
                aria-label=${`At work for ${elapsed(now - start)}${prompt ? `. Last message: ${prompt.text}` : ""}`}
                onPointerEnter=${(event) => event.pointerType === "mouse" && show(event)}
                onPointerLeave=${(event) => event.pointerType === "mouse" && setTip(null)}
                onClick=${(event) => (tip?.long ? setTip(null) : show(event))}
            >
                <span
                    class=${`rb-runbar ${run.tasks.some((task) => task.status === "running") ? "busy" : ""} ${run.approvals > 0 ? "waiting" : ""}`}
                ></span>
            </button>`);
        }

        // A label for a lane's first pin, where there is room for it before the next.
        const all = each.schedules
            .flatMap((schedule) => schedule.upcoming.filter((t) => t <= t1).map(x))
            .sort((a, b) => a - b);
        const room = (at) => all.every((other) => other <= at || other - at > 48);
        let labelled = phone;

        for (const schedule of each.schedules) {
            // The server lists a repeat's next `LISTED` times at most: past the last one, a dashed line says it goes on.
            const last = schedule.upcoming[schedule.upcoming.length - 1];

            if (schedule.every && schedule.upcoming.length >= LISTED && last < t1) {
                marks.push(html`<span
                    key=${`${schedule.id}-tail`}
                    class=${`rb-pin-tail ${schedule.held ? "held" : ""}`}
                    style=${`left:${x(last)}px;width:${Math.max(0, full - x(last))}px`}
                    title=${`Goes on ${schedule.repeat ?? ""}`}
                ></span>`);
            }

            schedule.upcoming
                .filter((t) => t <= t1)
                .forEach((t, i) => {
                    const left = x(t);
                    const label = `${clock(t, schedule.zone, now)}${zoneName(schedule.zone, t) ? ` ${zoneName(schedule.zone, t)}` : ""}`;

                    marks.push(html`<button
                        key=${`${schedule.id}-${t}`}
                        class=${`rb-pin ${schedule.every ? "repeat" : ""} ${i > 0 ? "later" : ""} ${schedule.held ? "held" : ""} ${selected === scheduleKey(schedule) ? "on" : ""}`}
                        style=${`left:${left}px`}
                        aria-label=${`${schedule.text}, ${label}`}
                        tabIndex=${i > 0 ? -1 : 0}
                        onClick=${() => onPick(schedule)}
                        onPointerEnter=${(event) => {
                            const box = event.currentTarget.getBoundingClientRect();

                            setTip({
                                text: schedule.text,
                                when: `${label} · ${relative(t, now)}${schedule.held ? " · held" : ""}`,
                                x: box.left,
                                y: box.bottom,
                            });
                        }}
                        onPointerLeave=${() => setTip(null)}
                    ></button>`);

                    if (
                        !labelled &&
                        left < full - 60 &&
                        Math.abs(left - x(now)) > 24 &&
                        room(left)
                    ) {
                        marks.push(html`<span key=${`${schedule.id}-label`} class="rb-pin-label" style=${`left:${left}px`}>
                            ${clock(t, schedule.zone, now)}
                        </span>`);
                        labelled = true;
                    }
                });
        }

        return { id: each.id, title: each.title, marks };
    });

    return html`<section class="rb-timeline" data-part="running-timeline" aria-label="Schedule timeline">
        <div class="rb-tl-head">
            <h3>Coming up</h3>
            <span class="rb-tl-next" title=${next ? `Next: ${next.text}` : ""}>
                ${next ? next.text : "Nothing scheduled"}
            </span>
            ${
                !phone &&
                html`<span class="rb-legend" aria-hidden="true">
                    <span><i class="rb-pin once"></i>once</span>
                    <span><i class="rb-pin repeat"></i>repeats</span>
                    <span><i class="rb-pin held"></i>held</span>
                    <span><i class="rb-runbar busy"></i>at work</span>
                </span>`
            }
            <div class="segmented rb-range" role="group" aria-label="Range">
                ${Object.entries(RANGES).map(
                    ([key, each]) => html`<button
                        class=${range === key ? "on" : ""}
                        aria-pressed=${range === key}
                        onClick=${() => setRange(key)}
                    >
                        ${each.label}
                    </button>`,
                )}
            </div>
        </div>
        <div class="rb-tl-grid">
            <div class="rb-tl-labels">
                <div class="rb-axis"></div>
                ${lanes.map(
                    (lane) => html`<button
                        key=${lane.id}
                        class=${`rb-lane-label ${row === lane.id ? "on" : ""}`}
                        title=${lane.title}
                        onClick=${() => onRow(lane.id)}
                    >
                        <span class="folder-mark" style=${`--folder:${colorOf(lane.id)}`}></span>
                        <span class="rb-ellipsis">${lane.title}</span>
                    </button>`,
                )}
            </div>
            <div class="rb-tl-scroll" ref=${scroller} onScroll=${() => setTip(null)}>
                <div class="rb-tl-track" style=${`width:${full}px`}>
                    <div class="rb-axis">
                        ${ticks.map(
                            (each) => html`<span
                                key=${each.at}
                                class=${`rb-tick ${each.day ? "day" : ""}`}
                                style=${`left:${x(each.at)}px`}
                            >
                                ${each.label}
                            </span>`,
                        )}
                    </div>
                    ${ticks.map(
                        (each) => html`<span
                            key=${`g${each.at}`}
                            class=${`rb-gridline ${each.day ? "day" : ""}`}
                            style=${`left:${x(each.at)}px`}
                        ></span>`,
                    )}
                    <div class="rb-past" style=${`width:${x(now)}px`}></div>
                    ${lanes.map(
                        (
                            lane,
                        ) => html`<div key=${lane.id} class=${`rb-lane ${row === lane.id ? "on" : ""}`}>
                            ${phone && html`<span class="rb-lane-name">${lane.title}</span>`}
                            ${lane.marks}
                        </div>`,
                    )}
                    <div class="rb-now" style=${`left:${x(now)}px`}>
                        <span>${formatter("en-GB", { hour: "2-digit", minute: "2-digit" }).format(now)}</span>
                    </div>
                    ${lanes.length === 0 && html`<div class="rb-tl-empty">Nothing to show here.</div>`}
                </div>
            </div>
        </div>
        ${
            tip &&
            html`<div
                class=${`rb-tip ${tip.long ? "long" : ""}`}
                role="tooltip"
                style=${`left:${Math.min(innerWidth - (tip.long ? 370 : 270), Math.max(8, tip.x - 20))}px;top:${tip.y + 8}px`}
            >
                <b>${tip.text}</b>${tip.when}
            </div>`
        }
    </section>`;
}

/** How many of a session's tasks a phone's card shows before "more". */
const FOLDED = 5;

function Row({
    row,
    now,
    steer,
    phone,
    color,
    lit,
    selected,
    onOpen,
    onPick,
    onStopTask,
    onStopRun,
}) {
    const run = row.run;
    const [unfolded, setUnfolded] = useState(false);
    const tasks = run?.tasks ?? [];
    const shownTasks =
        phone && !unfolded && tasks.length > FOLDED + 1 ? tasks.slice(0, FOLDED) : tasks;
    const held = row.schedules.some((each) => each.held);
    // On a phone an empty side gives its room to the other: a card says only what is there.
    const working = (run?.tasks.length ?? 0) > 0;
    // Its folder from its run, or, idle, from its schedules or the session list.
    const cwd = run?.cwd ?? row.schedules.find((each) => each.sessionCwd)?.sessionCwd ?? row.cwd;
    const scheduled = row.schedules.length > 0;

    return html`<div class=${`rb-row ${lit ? "on" : ""}`} role="row" data-row=${row.id}>
        <div class="rb-who" role="cell">
            <button class="rb-who-title" onClick=${() => onOpen(row.id)} title="Open the session">
                <span class="folder-mark" style=${`--folder:${color}`}></span>
                <span class="rb-ellipsis">${row.title}</span>
            </button>
            <span class="rb-who-meta">
            ${cwd && html`<span class="rb-who-path" title=${cwd}>${shortPath(cwd)}</span>`}
            <span class="rb-badges">
                ${run?.busy && html`<span class="rb-badge ok"><i></i>Busy</span>`}
                ${
                    run?.approvals > 0 &&
                    html`<span class="rb-badge warn"><i></i>${run.approvals} to approve</span>`
                }
                ${held && html`<span class="rb-badge warn">Held</span>`}
                ${!run && html`<span class="rb-badge">Idle</span>`}
                ${
                    steer &&
                    run?.busy &&
                    html`<button
                        class="rb-stop"
                        title="Stop the run"
                        aria-label=${`Stop the run in ${row.title}`}
                        onClick=${() => onStopRun(row.id)}
                    >
                        <${Icon} name="stop" size=${10} />
                        <span>Stop</span>
                    </button>`
                }
            </span>
            </span>
        </div>
        <div class=${`rb-cell ${!working && scheduled ? "empty" : ""}`} role="cell">
            <span class="rb-cell-label">Now</span>
            ${
                run && run.tasks.length > 0
                    ? html`${shownTasks.map((task) => {
                          const waiting =
                              task.status === "waiting" &&
                              run.approvals > 0 &&
                              task.kind === "pi.tool";
                          const stoppable =
                              steer &&
                              (STOPPABLE[task.kind] !== undefined ||
                                  (task.subagent !== undefined && task.kind === "pi.generation"));

                          return html`<div class="rb-task" key=${task.id} title=${task.label}>
                              ${
                                  task.status === "running"
                                      ? html`<${Spinner} hidden=${true} />`
                                      : html`<span class="rb-dot" aria-hidden="true">·</span>`
                              }
                              <span class="rb-task-label">
                                  ${task.subagent && html`<span class="rb-agent">${task.subagent}</span> `}${task.label}
                              </span>
                              <span
                                  class=${`rb-status ${task.status === "running" ? "ok" : waiting ? "warn" : ""} ${task.status}`}
                              >
                                  ${task.status}
                              </span>
                              <span class="rb-elapsed">${task.since ? elapsed(now - task.since) : ""}</span>
                              ${
                                  stoppable
                                      ? html`<button
                                            class="rb-x"
                                            title="Stop"
                                            aria-label=${`Stop ${task.label}`}
                                            onClick=${() => onStopTask(task)}
                                        >
                                            <${Icon} name="stop" size=${12} />
                                        </button>`
                                      : html`<span class="rb-x-space"></span>`
                              }
                          </div>`;
                      })}
                      ${
                          shownTasks.length < tasks.length &&
                          html`<button class="rb-more" onClick=${() => setUnfolded(true)}>
                              +${tasks.length - shownTasks.length} more
                          </button>`
                      }
                      ${
                          (run.model || run.spent > 0) &&
                          html`<div class="rb-foot">
                              ${run.model && html`<span>${run.model}</span>`}
                              ${run.spent > 0 && html`<span>${dollars(run.spent)} spent</span>`}
                          </div>`
                      }`
                    : html`<div class="rb-idle">Nothing running</div>`
            }
        </div>
        <div class=${`rb-cell ${!scheduled && working ? "empty" : ""}`} role="cell">
            <span class="rb-cell-label">Schedule</span>
            ${
                row.schedules.length > 0
                    ? row.schedules.map(
                          (schedule) => html`<button
                              key=${schedule.id}
                              class=${`rb-sched ${schedule.held ? "held" : ""} ${selected === scheduleKey(schedule) ? "on" : ""}`}
                              onClick=${() => onPick(schedule)}
                          >
                              <span class="rb-sched-text">${schedule.text}</span>
                              <span class="rb-sched-time" title=${schedule.zone}>
                                  ${
                                      schedule.held
                                          ? "Held"
                                          : `${clock(schedule.next, schedule.zone, now)}${zoneName(schedule.zone, schedule.next) ? ` ${zoneName(schedule.zone, schedule.next)}` : ""}`
                                  }
                              </span>
                              <span class="rb-sched-rule rb-ellipsis">
                                  ${schedule.repeat ? `↻ ${schedule.repeat}` : "once"}
                              </span>
                              <span class="rb-sched-rel">
                                  ${relative(schedule.next, now)}${schedule.every ? ` · ${schedule.runs}×` : ""}
                              </span>
                          </button>`,
                      )
                    : html`<div class="rb-idle">No schedule</div>`
            }
        </div>
    </div>`;
}

function Detail({ schedule, now, steer, color, onClose, onOpen, onCancel }) {
    const zone = zoneName(schedule.zone, schedule.next);

    return html`<div class="rb-detail">
        <div class="rb-detail-head">
            <span class="folder-mark" style=${`--folder:${color}`}></span>
            <button class="rb-detail-title rb-ellipsis" onClick=${() => onOpen(schedule.session)}>
                ${schedule.sessionTitle}
            </button>
            <button class="icon-button" aria-label="Close details" onClick=${onClose}>
                <${Icon} name="close" size=${16} />
            </button>
        </div>
        ${schedule.held && html`<div class="rb-held">Held: ${schedule.held}. It goes out when that changes.</div>`}
        <pre class="rb-message">${schedule.text}</pre>
        <dl class="rb-facts">
            <dt>Repeats</dt>
            <dd>${schedule.repeat ?? "no, once"}</dd>
            <dt>Next</dt>
            <dd>${clock(schedule.next, schedule.zone, now, { day: "always" })}${zone && ` ${zone}`} · ${relative(schedule.next, now)}</dd>
            <dt>Zone</dt>
            <dd>${schedule.zone}</dd>
            <dt>Set by</dt>
            <dd>${setBy(schedule)}</dd>
            <dt>Set up</dt>
            <dd>${relative(schedule.createdAt, now)}</dd>
            ${schedule.every && html`<dt>Went out</dt><dd>${schedule.runs} ${schedule.runs === 1 ? "time" : "times"}</dd>`}
            <dt>Id</dt>
            <dd class="mono">${schedule.id}</dd>
        </dl>
        ${
            schedule.upcoming.length > 1 &&
            html`<div class="rb-sub">Coming up</div>
                <div class="rb-upcoming">
                    ${schedule.upcoming
                        .slice(0, 5)
                        .map(
                            (t) =>
                                html`<span key=${t}>${clock(t, schedule.zone, now, { day: "always" })}${zone && ` ${zone}`}</span>`,
                        )}
                </div>`
        }
        <div class="rb-actions">
            <button class="button" onClick=${() => onOpen(schedule.session)}>Open session</button>
            ${steer && html`<button class="button danger" onClick=${() => onCancel(schedule)}>Cancel</button>`}
        </div>
    </div>`;
}

function Needs({ needs, colorOf, onOpen, onPick }) {
    if (needs.length === 0) {
        return null;
    }

    return html`<div class="rb-panel board-needs" data-part="running-needs">
        <div class="label">Needs you <span class="board-needs-count">${needs.length}</span></div>
        ${needs.map(
            (each) => html`<button
                key=${each.key}
                class="board-need waiting"
                onClick=${() => (each.schedule ? onPick(each.schedule) : onOpen(each.session))}
            >
                <span class="folder-mark" style=${`--folder:${colorOf(each.session)}`}></span>
                <span class="board-need-main">
                    <span class="board-need-head"><b>${each.title}</b></span>
                    <span class="board-need-session board-need-what">${each.what}</span>
                </span>
            </button>`,
        )}
    </div>`;
}

function NextUp({ schedules, now, colorOf, onPick }) {
    const times = schedules
        .filter((each) => !each.held)
        .flatMap((each) => each.upcoming.slice(0, 4).map((at) => ({ at, schedule: each })))
        .sort((a, b) => a.at - b.at)
        .slice(0, 6);

    if (times.length === 0) {
        return null;
    }

    return html`<div class="rb-panel" data-part="running-next">
        <div class="label">Next up</div>
        ${times.map(
            ({
                at,
                schedule,
            }) => html`<button key=${`${scheduleKey(schedule)}-${at}`} class="rb-next" onClick=${() => onPick(schedule)}>
                <span class="rb-next-time">${clock(at, schedule.zone, now)}</span>
                <span class="folder-mark" style=${`--folder:${colorOf(schedule.session)}`}></span>
                <span class="rb-ellipsis grow">${schedule.text}</span>
                <span class="rb-next-rel">${relative(at, now)}</span>
            </button>`,
        )}
    </div>`;
}
